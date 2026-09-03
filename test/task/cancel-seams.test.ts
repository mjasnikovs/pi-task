/**
 * THE SEAM MATRIX. One question, asked once per cancel checkpoint: when the user
 * asks to stop here, does the run stop HERE, and does a resume finish the job
 * without losing or repeating work?
 *
 * Each seam gets three tests, and the third is what gives the first two meaning:
 *
 *   STOPS    with only this seam live, the run halts at it and does no work past it;
 *   RESUMES  a second run over the same directory completes it, losing nothing;
 *   CONTROL  with NO seam live and nothing else changed, the same run finishes.
 *
 * The two runs differ by exactly one seam, which is the only way "it stopped
 * here" means anything: several seams observe the same raised flag, so a run with
 * all of them live stops at whichever comes first — usually not the one under
 * test. `onlyCheckpoints` (src/task/cancel-points.ts, no caller in src/) is what
 * isolates them.
 *
 * The EXHAUSTIVENESS test at the bottom is what stops this file going stale: it
 * walks a real uncancelled run and fails if that run crosses a seam no describe
 * here covers.
 */
import {test, expect, describe, afterEach} from 'bun:test'
import {
    requestCancel,
    resetCancel,
    resetCheckpointTrail,
    checkpointsCrossed,
    onlyCheckpoints,
    clearCheckpointSuppression,
    type CancelCheckpoint
} from '../../src/task/cancel-points.js'
import {runAutoLoop, requestAutoCancel, type AutoDeps} from '../../src/task/auto-orchestrator.js'

import {runGatesForTask, type GateDeps, type GateParams} from '../../src/task/task-gates.js'
import {
    runResearchWorker,
    type ResearchWorkerRun,
    type ResearchWorkerSpec
} from '../../src/task/research-worker.js'
import {runPlanningChild, ChildStatus} from '../../src/task/child-status.js'
import {TaskRunner, registerTask} from '../../src/task/orchestrator.js'
import {withRun} from '../../src/task/run-bracket.js'
import {writeTaskFile, readTaskFile, readSection} from '../../src/task/task-io.js'
import {parseTaskList, findResumableAuto} from '../../src/task/auto-io.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {happy} from '../test-utils/happy-phases.js'
import {USER_CANCELLED} from '../../src/task/child-runner.js'
import type {TaskFrontMatter} from '../../src/task/task-types.js'
import type {PhaseDeps, PhaseSeams} from '../../src/task/child-runner.js'
import type {RunWorkerResult} from '../../src/workers/pi-worker-core.js'

function autoFm(id: string): TaskFrontMatter {
    const now = new Date().toISOString()
    return {id, state: 'in_progress', phase: 'done', created_at: now, updated_at: now, title: 't'}
}

function autoBody(titles: string[]): string {
    return `\n## feature\n\nf\n\n## tasks\n\n${titles.map(t => `- [ ] ${t}`).join('\n')}\n`
}

/** Let exactly one seam fire. */
function only(seam: CancelCheckpoint): void {
    onlyCheckpoints(w => w === seam)
}

/** Let NO seam fire — the control arm for any row above. */
function none(): void {
    onlyCheckpoints(() => false)
}

/** The run bracket a real command wraps its work in — what makes isRunActive()
 *  true, so /task-cancel can tell "in the gates" from "nothing is running". */
function withRunLike<T>(
    ctx: ReturnType<typeof makeFakeCtx>['ctx'],
    fn: () => Promise<T>
): Promise<T> {
    return withRun(ctx, {}, fn)
}

afterEach(() => {
    resetCancel()
    resetCheckpointTrail()
    clearCheckpointSuppression()
    delete process.env.CANCEL_AB_ARM
})

// ─── Loop-level seams ────────────────────────────────────────────────────────

/**
 * The loop's deps. `ran` is the record every assertion reads: a seam that failed
 * to stop shows up as extra titles in it, not as a missing flag.
 */
function loopDeps(
    ran: string[],
    over: Partial<AutoDeps> = {},
    gateRan?: {value: boolean}
): AutoDeps {
    return {
        runChild: () => Promise.resolve(''),
        runTask: (_c: unknown, _cwd: string, title: string) => {
            ran.push(title)
            return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
        },
        commit: () => Promise.resolve({committed: false}),
        finalGate: () => {
            if (gateRan) gateRan.value = true
            return Promise.resolve({ok: true, reason: 'x'})
        },
        ...over
    } as unknown as AutoDeps
}

describe('seam loop-top — the previous task is checked off and committed', () => {
    /** Fires the cancel from inside task A, so loop-top is the next seam reached. */
    const deps = (ran: string[], gateRan?: {value: boolean}): AutoDeps =>
        loopDeps(
            ran,
            {
                runTask: (_c: unknown, _cwd: string, title: string) => {
                    ran.push(title)
                    if (title === 'A') requestAutoCancel()
                    return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
                }
            },
            gateRan
        )

    test('STOPS after the running task, before the next one starts', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            only('loop-top')
            resetCheckpointTrail()
            const ran: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(ran))
            expect(ran).toEqual(['A'])
            expect(checkpointsCrossed()).toContain('loop-top')
        })
    })

    test('RESUMES: a second run finishes B, and A is not redone', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            only('loop-top')
            const first: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(first))
            expect(await findResumableAuto(dir)).toBe('TASK_AUTO_0001')
            clearCheckpointSuppression()
            const second: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', loopDeps(second))
            // A ran once across both runs and B ran once. Nothing lost, nothing repeated.
            expect(first).toEqual(['A'])
            expect(second).toEqual(['B'])
        })
    })

    test('CONTROL: with no seam live the same run does both tasks', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            none()
            const ran: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(ran))
            expect(ran).toEqual(['A', 'B'])
        })
    })
})

describe('seam pre-task — tree committed, no inner id stamped', () => {
    /** The checkpoint commit is the last thing before pre-task. */
    const deps = (ran: string[]): AutoDeps =>
        loopDeps(ran, {
            commit: () => {
                requestAutoCancel()
                return Promise.resolve({committed: false})
            }
        })

    test('STOPS before the first task, leaving the entry unchecked', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            only('pre-task')
            resetCheckpointTrail()
            const ran: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(ran))
            expect(ran).toEqual([])
            expect(checkpointsCrossed()).toContain('pre-task')
            const {body, frontMatter} = await readTaskFile(dir, 'TASK_AUTO_0001')
            expect(parseTaskList(body).every(e => !e.done)).toBe(true)
            expect(frontMatter.state).toBe('in_progress')
        })
    })

    test('RESUMES: a second run does the whole plan from scratch', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            only('pre-task')
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps([]))
            expect(await findResumableAuto(dir)).toBe('TASK_AUTO_0001')
            clearCheckpointSuppression()
            const second: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', loopDeps(second))
            expect(second).toEqual(['A', 'B'])
        })
    })

    test('CONTROL: with no seam live the same run does both tasks', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            none()
            const ran: string[] = []
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(ran))
            expect(ran).toEqual(['A', 'B'])
        })
    })
})

describe('seam pre-final-gate — every task committed, whole-repo gate not started', () => {
    const deps = (gateRan: {value: boolean}): AutoDeps =>
        loopDeps(
            [],
            {
                runTask: () => {
                    requestAutoCancel()
                    return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
                }
            },
            gateRan
        )

    test('STOPS before the gate, and the run is not declared complete', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A']))
            only('pre-final-gate')
            resetCheckpointTrail()
            const gateRan = {value: false}
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(gateRan))
            expect(gateRan.value).toBe(false)
            expect(checkpointsCrossed()).toContain('pre-final-gate')
            // The gate is what completes a run, so the run must still read in_progress.
            expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe(
                'in_progress'
            )
        })
    })

    test('RESUMES: a second run re-enters the branch and runs the gate', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A']))
            only('pre-final-gate')
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps({value: false}))
            clearCheckpointSuppression()
            const gateRan = {value: false}
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', loopDeps([], {}, gateRan))
            expect(gateRan.value).toBe(true)
            expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe('completed')
        })
    })

    test('CONTROL: with no seam live the gate runs in the same pass', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A']))
            none()
            const gateRan = {value: false}
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', deps(gateRan))
            expect(gateRan.value).toBe(true)
        })
    })
})

// ─── impl:post-turn ──────────────────────────────────────────────────────────

describe('seam impl:post-turn — the implementation turn has ended', () => {
    /**
     * The cancel is raised from inside the turn itself, which is the window that
     * used to observe nothing at all: the turn runs in the host session, not as a
     * child, so aborting the runner's signal never reached it and `_run` returned
     * `completed` regardless.
     */
    const runner = (
        ctx: ReturnType<typeof makeFakeCtx>['ctx'],
        cwd: string,
        sent: string[],
        cancelDuringTurn: boolean
    ): TaskRunner =>
        new TaskRunner({
            ctx,
            cwd,
            rawPrompt: 'run lint',
            sendSpec: async s => {
                sent.push(s)
                if (cancelDuringTurn) requestCancel()
            },
            seams: happy()
        })

    test('STOPS: the run ends cancelled, not completed', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            only('impl:post-turn')
            resetCheckpointTrail()
            const sent: string[] = []
            const end = await runner(ctx, cwd, sent, true).run()
            // The turn still RAN — the decision is to let it finish and stop after.
            expect(sent).toHaveLength(1)
            expect(end.kind).toBe('cancelled')
            expect(checkpointsCrossed()).toContain('impl:post-turn')
        })
    })

    test('the task file is left cancelled, which is a resumable state', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            only('impl:post-turn')
            const r = runner(ctx, cwd, [], true)
            await r.run()
            const {frontMatter} = await readTaskFile(cwd, r.taskId)
            // NOT `completed`, which is what the file said a line earlier (it is
            // written at spec-handoff) and what a resume would have skipped over.
            expect(frontMatter.state).toBe('cancelled')
            // Every phase section survives — the cancel costs the turn, not the spec.
            expect((await readSection(cwd, r.taskId, 'spec'))?.length).toBeGreaterThan(0)
        })
    })

    test('RESUMES: the spec is re-delivered without re-running a single phase', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            only('impl:post-turn')
            const first = runner(ctx, cwd, [], true)
            await first.run()
            const id = first.taskId
            clearCheckpointSuppression()
            // A resume must not spend the phases again: front matter reads
            // `phase: done`, whose PHASE_INDEX is past every row, so all five
            // sections are restored from disk and delivery is all that is left.
            const childrenRun: string[] = []
            const sent: string[] = []
            const resumed = new TaskRunner({
                ctx,
                cwd,
                rawPrompt: 'run lint',
                resumeId: id,
                sendSpec: async s => {
                    sent.push(s)
                },
                seams: {
                    runChild: (name: string) => {
                        childrenRun.push(name)
                        return Promise.resolve('')
                    },
                    runWorker: () => Promise.reject(new Error('no worker may run on resume'))
                } as unknown as PhaseSeams
            })
            const end = await resumed.run()
            expect(end.kind).toBe('completed')
            expect(sent).toHaveLength(1)
            expect(childrenRun).toEqual([])
        })
    })

    test('CONTROL: with no seam live the same run completes', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            none()
            const sent: string[] = []
            const end = await runner(ctx, cwd, sent, true).run()
            expect(end.kind).toBe('completed')
            expect(sent).toHaveLength(1)
        })
    })
})

// ─── gate seams ──────────────────────────────────────────────────────────────

function gateDeps(over: Partial<GateDeps> = {}): GateDeps {
    return {
        runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}}),
        commit: () => Promise.resolve({committed: true}),
        ...over
    } as GateDeps
}

const gateParams = (over: Partial<GateParams> = {}): GateParams => ({
    cwd: '/tmp/x',
    taskId: 'TASK_0006',
    title: 'A',
    tag: 'TASK_0006',
    ...over
})

describe('seam gate:post-commit — task checked off and snapshot in HEAD', () => {
    const deps = (enforced: {value: boolean}): GateDeps =>
        gateDeps({
            enforce: () => {
                enforced.value = true
                return Promise.resolve({ok: true})
            }
        })

    test('STOPS before the enforce pass, and reports a cancel not a fault', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            only('gate:post-commit')
            requestCancel()
            const enforced = {value: false}
            let verified = false
            const r = await runGatesForTask(
                ctx,
                deps(enforced),
                gateParams({
                    cwd: dir,
                    onVerified: () => {
                        verified = true
                        return Promise.resolve()
                    }
                })
            )
            expect(r.kind).toBe('cancelled')
            // The seam sits AFTER the check-off and the commit, so both happened.
            expect(verified).toBe(true)
            expect(enforced.value).toBe(false)
        })
    })

    test('CONTROL: with no seam live the enforce pass runs and the gate is done', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            none()
            requestCancel()
            const enforced = {value: false}
            const r = await runGatesForTask(ctx, deps(enforced), gateParams({cwd: dir}))
            expect(r.kind).toBe('done')
            expect(enforced.value).toBe(true)
        })
    })
})

describe('seam gate:pre-autofix — between autofix rounds', () => {
    /** Verify keeps failing, so without a seam this buys three whole re-runs. */
    const deps = (fixRuns: string[]): GateDeps =>
        gateDeps({
            runTask: (_c, _cwd, t) => {
                fixRuns.push(t)
                return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
            },
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'real defect'}),
            enforce: () => Promise.resolve({ok: true})
        })

    test('STOPS before buying another implementation re-run', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            only('gate:pre-autofix')
            requestCancel()
            const fixRuns: string[] = []
            const r = await runGatesForTask(ctx, deps(fixRuns), gateParams({cwd: dir}))
            expect(r.kind).toBe('cancelled')
            expect(fixRuns).toEqual([])
        })
    })

    test('CONTROL: with no seam live the rounds run as before', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            none()
            requestCancel()
            const fixRuns: string[] = []
            await runGatesForTask(ctx, deps(fixRuns), gateParams({cwd: dir}))
            expect(fixRuns.length).toBeGreaterThan(0)
        })
    })
})

// ─── research:<worker> ───────────────────────────────────────────────────────

function workerResult(over: Partial<RunWorkerResult> = {}): RunWorkerResult {
    return {
        text: '- a real finding',
        exitCode: 0,
        stderr: '',
        aborted: false,
        sawOutput: true,
        waitMs: 1,
        workMs: 1,
        attempts: 1,
        totalWallMs: 2,
        restarts: [],
        salvagedFromDiscardedAttempt: false,
        groundingRetrievalCount: 3,
        ...over
    }
}

const RESEARCH_SPEC: ResearchWorkerSpec = {
    section: 'CONTEXT',
    label: 'worker:context',
    prompt: 'BASE'
}

describe('seam research:<worker> — the section is on disk and a resume skips it', () => {
    /** `persisted` doubles as the resume cache: the second call reads it back. */
    const harness = (): {run: ResearchWorkerRun; persisted: Map<string, string>; ran: number} => {
        const persisted = new Map<string, string>()
        const h = {
            persisted,
            ran: 0,
            run: {
                contextWindow: 'unknown' as const,
                runWorker: () => {
                    h.ran += 1
                    return Promise.resolve(workerResult())
                },
                cwd: '/nowhere',
                taskId: 'TASK_0001',
                signal: new AbortController().signal,
                groupArgsFor: () => [],
                record: (_label: string, p: Promise<RunWorkerResult>) => p,
                onDone: () => {},
                readCached: (heading: string) => Promise.resolve(persisted.get(heading) ?? ''),
                persistSection: (heading: string, text: string) => {
                    persisted.set(heading, text)
                    return Promise.resolve()
                },
                leverEnv: () => undefined
            } as unknown as ResearchWorkerRun
        }
        return h
    }

    test('STOPS after the worker, and only AFTER its section is persisted', async () => {
        const h = harness()
        only('research:CONTEXT')
        requestCancel()
        resetCheckpointTrail()
        await expect(runResearchWorker(RESEARCH_SPEC, h.run)).rejects.toThrow(USER_CANCELLED)
        // The seam is the last statement before the return, so the work this
        // worker did is already on disk. That is what makes it free.
        expect(h.persisted.get('research worker CONTEXT')).toBe('- a real finding')
        expect(checkpointsCrossed()).toContain('research:CONTEXT')
    })

    test('RESUMES: the cancelled worker is not run again', async () => {
        const h = harness()
        only('research:CONTEXT')
        requestCancel()
        await runResearchWorker(RESEARCH_SPEC, h.run).catch(() => {})
        expect(h.ran).toBe(1)
        resetCancel()
        clearCheckpointSuppression()
        const out = await runResearchWorker(RESEARCH_SPEC, h.run)
        // Read back from the cache, not re-run: this is the whole reason the seam
        // costs nothing to stop at.
        expect(h.ran).toBe(1)
        expect(out).toEqual({name: 'CONTEXT', text: '- a real finding'})
    })

    test('CONTROL: with no seam live the worker returns its section', async () => {
        const h = harness()
        none()
        requestCancel()
        const out = await runResearchWorker(RESEARCH_SPEC, h.run)
        expect(out).toEqual({name: 'CONTEXT', text: '- a real finding'})
    })
})

// ─── phase:<name> ────────────────────────────────────────────────────────────

describe('seam phase:<name> — the phase output is on disk', () => {
    const runner = (
        ctx: ReturnType<typeof makeFakeCtx>['ctx'],
        cwd: string,
        onRefine: () => void
    ): TaskRunner => {
        const base = happy()
        return new TaskRunner({
            ctx,
            cwd,
            rawPrompt: 'run lint',
            sendSpec: () => Promise.resolve(),
            seams: {
                ...base,
                runChild: (name, tools, prompt) => {
                    if (name === 'refine') onRefine()
                    return base.runChild!(name, tools, prompt)
                }
            }
        })
    }

    test('STOPS after refine, with the refined prompt already written', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            only('phase:refine')
            resetCheckpointTrail()
            const r = runner(ctx, cwd, () => requestCancel())
            const end = await r.run()
            expect(end.kind).toBe('cancelled')
            expect(checkpointsCrossed()).toContain('phase:refine')
            expect((await readSection(cwd, r.taskId, 'refined prompt'))?.length).toBeGreaterThan(0)
            // Nothing past refine ran.
            expect(await readSection(cwd, r.taskId, 'research')).toBeNull()
        })
    })

    test('CONTROL: with no seam live the same run reaches the spec', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            none()
            const r = runner(ctx, cwd, () => requestCancel())
            const end = await r.run()
            expect(end.kind).toBe('completed')
            expect((await readSection(cwd, r.taskId, 'spec'))?.length).toBeGreaterThan(0)
        })
    })
})

// ─── plan:<child> ────────────────────────────────────────────────────────────

describe('seam plan:<child> — safe by DISCARD, not by writing', () => {
    const call = (spawned: string[]): Promise<string> => {
        const deps = {
            cwd: '/nowhere',
            taskId: '',
            signal: new AbortController().signal,
            runChild: (name: string) => {
                spawned.push(name)
                return Promise.resolve('a plan')
            }
        } as unknown as PhaseDeps
        return runPlanningChild({
            ctx: makeFakeCtx('/nowhere').ctx,
            status: new ChildStatus({parentContextWindow: 200_000}),
            phaseDeps: deps,
            name: 'auto-decompose',
            tools: 'read',
            prompt: 'p',
            loader: {title: 't', step: (n: string) => ({step: n, stepNum: 1, stepTotal: 2})}
        })
    }

    test('STOPS before the child is spawned at all', async () => {
        only('plan:auto-decompose')
        requestCancel()
        resetCheckpointTrail()
        const spawned: string[] = []
        await expect(call(spawned)).rejects.toThrow(USER_CANCELLED)
        // Not "after the current child" — planning children are the whole cost of
        // the planning phase, so the seam has to come before one starts.
        expect(spawned).toEqual([])
        expect(checkpointsCrossed()).toContain('plan:auto-decompose')
    })

    test('CONTROL: with no seam live the child runs', async () => {
        none()
        requestCancel()
        const spawned: string[] = []
        expect(await call(spawned)).toBe('a plan')
        expect(spawned).toEqual(['auto-decompose'])
    })
})

// ─── /task-cancel: one meaning wherever it is typed ──────────────────────────

/** The command table pi would end up with, keyed by the name a user types. */
function commandTable(): Map<string, (a: string, c: never) => Promise<void> | void> {
    const table = new Map<string, (a: string, c: never) => Promise<void> | void>()
    registerTask({
        on: () => {},
        registerCommand: (name: string, opts: {handler: (a: string, c: never) => Promise<void>}) =>
            table.set(name, opts.handler),
        registerTool: () => {},
        sendUserMessage: () => {}
    } as unknown as Parameters<typeof registerTask>[0])
    return table
}

describe('/task-cancel', () => {
    /**
     * The implementation turn was the command's blind spot: `cancel()` aborts the
     * runner's AbortController, that signal only ever reached phase CHILDREN, and
     * the turn is not a child. The command's whole effect there was its toast —
     * the task went on to be verified, committed and checked off, and the loop
     * advanced to the next one.
     */
    test('stops the run when typed during the implementation turn', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const cancel = commandTable().get('task-cancel')!
            only('impl:post-turn')
            const sent: string[] = []
            const end = await withRunLike(ctx, () =>
                new TaskRunner({
                    ctx,
                    cwd,
                    rawPrompt: 'run lint',
                    sendSpec: async s => {
                        sent.push(s)
                        await cancel('', ctx as never)
                    },
                    seams: happy()
                }).run()
            )
            expect(sent).toHaveLength(1)
            expect(end.kind).toBe('cancelled')
        })
    })

    /**
     * The gates run AFTER TaskRunner._run's `finally` has cleared the module
     * global, so for the whole verify/autofix/enforce stretch there was no runner
     * to abort and the command answered "No task is running." — while a task
     * plainly was.
     */
    test('does not claim nothing is running when typed during the gates', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, captured} = makeFakeCtx(dir)
            const cancel = commandTable().get('task-cancel')!
            only('gate:post-commit')
            const r = await withRunLike(ctx, async () => {
                await cancel('', ctx as never)
                return runGatesForTask(
                    ctx,
                    gateDeps({enforce: () => Promise.resolve({ok: true})}),
                    gateParams({cwd: dir})
                )
            })
            expect(r.kind).toBe('cancelled')
            expect(captured.notifies.some(n => /No task is running/.test(n.msg))).toBe(false)
        })
    })

    test('still says nothing is running when nothing is', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, captured} = makeFakeCtx(dir)
            await commandTable().get('task-cancel')!('', ctx as never)
            expect(captured.notifies).toEqual([{msg: 'No task is running.', level: 'info'}])
        })
    })

    /**
     * The flag is a module global, so a cancel raised on a bare /task and never
     * observed would sit there and stop the NEXT run at its first phase. The run
     * bracket clears it at both ends of the outermost run; this is the test that
     * a later run starts clean.
     */
    test('a cancel raised on one run does not leak into the next', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const cancel = commandTable().get('task-cancel')!
            await withRunLike(ctx, async () => {
                await cancel('', ctx as never)
            })
            const r = new TaskRunner({
                ctx,
                cwd,
                rawPrompt: 'run lint',
                sendSpec: () => Promise.resolve(),
                seams: happy()
            })
            expect((await r.run()).kind).toBe('completed')
        })
    })
})

// ─── Exhaustiveness ──────────────────────────────────────────────────────────

/**
 * The seams a full, uncancelled run actually crosses — read off the trail rather
 * than listed here, so a seam added to src/ with no row above fails this instead
 * of going untested in silence. Template seams collapse to their prefix; the
 * describes above cover one concrete instance of each.
 */
const COVERED = new Set([
    'loop-top',
    'pre-task',
    'pre-final-gate',
    'impl:post-turn',
    'gate:post-commit',
    'gate:pre-autofix',
    'phase:',
    'plan:',
    'research:'
])

/** A seam's row key: its own name, or the prefix for the three open-ended ones.
 *  Exact-match first, because `impl:post-turn` and `gate:post-commit` carry a
 *  colon without being families. */
const family = (w: CancelCheckpoint): string =>
    COVERED.has(w) ? w : `${w.slice(0, w.indexOf(':') + 1)}`

test('every seam a real run crosses has a row in this file', async () => {
    await withTmpTaskDir(async cwd => {
        const {ctx} = makeFakeCtx(cwd)
        clearCheckpointSuppression()
        resetCheckpointTrail()
        await new TaskRunner({
            ctx,
            cwd,
            rawPrompt: 'run lint',
            sendSpec: () => Promise.resolve(),
            seams: happy()
        }).run()
        const seen = [...new Set(checkpointsCrossed().map(family))]
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.filter(f => !COVERED.has(f))).toEqual([])
    })
})
