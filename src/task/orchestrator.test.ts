import {describe, expect, test} from 'bun:test'
import {TaskRunner, runSingleTask, type TaskRunnerOptions} from './orchestrator.js'
import {CONTINUE_AFTER_COMPACTION, MAX_COMPACTION_RESUMES} from './implementation-turn.js'
import {readTaskFile, readSection, writeTaskFile} from './task-io.js'
import {agentEndResponse, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import {makeFakeCtx, assistantEntry, compactionEntry} from '../test-utils/fake-ctx.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {_setSink, reset as resetSessionState} from '../remote/session-state.js'
import {broadcast as wsBroadcast} from '../remote/broadcast.js'
import type {PhaseDeps} from './child-runner.js'
import type {RunWorkerResult} from '../workers/pi-worker-core.js'
import {RUN_END_POLICY} from './run-end.js'

// ─── Phase children: routed by NAME through the `runChild` seam ───────────────

/** The names phases.ts / title-label.ts hand to runPhaseChild. */
type ChildName =
    | 'refine'
    | 'verify-tooling'
    | 'grill-gen'
    | 'grill-auto'
    | 'compose'
    | 'critique-triage'
    | 'critique'
    | 'compress-label'
type ChildScript = string | ((prompt: string) => string)

/**
 * A `PhaseDeps.runChild` that answers each phase child by NAME. An unscripted
 * child throws the way the Error-triage ladder does when a child says nothing, so
 * a test only scripts the children it is about and the rest fail as before.
 */
function scriptedChildren(
    scripts: Partial<Record<ChildName, ChildScript>>
): NonNullable<PhaseDeps['runChild']> {
    return (name, _tools, prompt) => {
        const v = scripts[name as ChildName]
        if (v === undefined) return Promise.reject(new Error(`${name} child produced no output`))
        // The real seam hands back the event sink's assistant text, which is
        // trimmed — a substitute must match that contract.
        return Promise.resolve((typeof v === 'function' ? v(prompt) : v).trim())
    }
}

// ─── Research workers: routed by LABEL through the `runWorker` seam ───────────
//
// These were the last prompt-matched fakes in this file: PHASES.research called
// `phaseResearch(d, p.refined)` and the seam sat on a third parameter no row
// could reach, so a worker had to be recognised by a marker SENTENCE lifted out
// of prompts.ts — prompt copy this codebase rewords and A/Bs for a living, as
// load-bearing test infrastructure. `runWorker` is a `PhaseDeps` field now, so a
// worker is named, and what a gate reads is stated rather than acted out through
// a fake process that emits JSON events.

type WorkerName = 'files' | 'apis' | 'context' | 'tooling'
/** What a scripted worker answers: its text, or the result fields directly. */
type WorkerScript = string | (() => string | Partial<RunWorkerResult>)

const WORKER_LABELS: Record<WorkerName, string> = {
    files: 'worker:files',
    apis: 'worker:apis',
    context: 'worker:context',
    tooling: 'worker:tooling'
}

function workerResult(over: Partial<RunWorkerResult> = {}): RunWorkerResult {
    return {
        text: '',
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
        // Non-zero so the APIS zero-retrieval gate stays out of the way unless a
        // test is about it.
        groundingRetrievalCount: 3,
        ...over
    }
}

/** A `PhaseDeps.runWorker` answering each research worker by name. */
function researchWorkers(
    scripts: Partial<Record<WorkerName, WorkerScript>>,
    fallback = ''
): NonNullable<PhaseDeps['runWorker']> {
    const byLabel = new Map<string, WorkerScript>(
        (Object.keys(WORKER_LABELS) as WorkerName[])
            .filter(k => scripts[k] !== undefined)
            .map(k => [WORKER_LABELS[k], scripts[k]!])
    )
    return label => {
        const v = byLabel.get(label)
        if (v === undefined) return Promise.resolve(workerResult({text: fallback}))
        const out = typeof v === 'function' ? v() : v
        return Promise.resolve(workerResult(typeof out === 'string' ? {text: out} : out))
    }
}

const REFINED_FIXTURE = `GOAL
Run the linter and report errors.

CONSTRAINTS
- Use bun.

KNOWN-UNKNOWNS
- (none)
`

const RESEARCH_FILES = 'package.json  build/lint scripts'
const RESEARCH_APIS = 'lint  bun run lint'
const RESEARCH_CONTEXT = '- TypeScript project using bun'
const RESEARCH_TOOLING = 'lint  bun run lint\ntest  bun test'

const VERIFY_TOOLING_OUT = `VERIFIED
  bun run lint  found in package.json scripts
  bun test  found in package.json scripts

REJECTED
`

/** grill-gen must return non-empty text even when there are no questions; this
 *  string parses to 0 questions (no numbered lines). */
const NO_QUESTIONS = '(no clarifying questions for this task)'

const COMPOSE_SPEC = `GOAL
Run lint.

CONSTRAINTS
- none

ACCEPTANCE
- exit 0

VERIFY:
\`\`\`sh
bun run lint
\`\`\`
`

function happyChildren(over: Partial<Record<ChildName, ChildScript>> = {}) {
    return scriptedChildren({
        refine: REFINED_FIXTURE,
        'verify-tooling': VERIFY_TOOLING_OUT,
        'grill-gen': NO_QUESTIONS,
        compose: COMPOSE_SPEC,
        critique: COMPOSE_SPEC,
        ...over
    })
}

function happyWorkers(
    over: Partial<Record<WorkerName, WorkerScript>> = {},
    fallback = ''
): NonNullable<PhaseDeps['runWorker']> {
    return researchWorkers(
        {
            files: RESEARCH_FILES,
            apis: RESEARCH_APIS,
            context: RESEARCH_CONTEXT,
            tooling: RESEARCH_TOOLING,
            ...over
        },
        fallback
    )
}

/** Both fakes for a full happy run, in the shape TaskRunner / runSingleTask take. */
function happy(): Pick<TaskRunnerOptions, 'runChild' | 'runWorker'> {
    return {runChild: happyChildren(), runWorker: happyWorkers()}
}

/** Drive one TaskRunner to completion over `fakes`; returns what the runner sent. */
async function runOnce(
    ctx: TaskRunnerOptions['ctx'],
    cwd: string,
    fakes: Partial<TaskRunnerOptions>
): Promise<{runner: TaskRunner; sent: string[]}> {
    const sent: string[] = []
    const runner = new TaskRunner({
        ctx,
        cwd,
        rawPrompt: 'run lint',
        sendSpec: async s => {
            sent.push(s)
        },
        ...fakes
    })
    await runner.run()
    return {runner, sent}
}

describe('TaskRunner — happy path', () => {
    test('refine fills title and refined section', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const {sent: sentSpecs} = await runOnce(ctx, cwd, happy())
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            expect(frontMatter.title).toContain('Run the linter')
            const refined = await readSection(cwd, 'TASK_0001', 'refined prompt')
            expect(refined).toContain('GOAL')
            expect(sentSpecs).toHaveLength(1)
            expect(sentSpecs[0]).toContain('VERIFY:')
        })
    })

    test('verify-tooling: research TOOLING is replaced with VERIFIED-TOOLING', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await runOnce(ctx, cwd, happy())
            const research = await readSection(cwd, 'TASK_0001', 'research')
            expect(research).toContain('VERIFIED-TOOLING')
            expect(research).toContain('bun run lint')
            expect(research).not.toMatch(/^TOOLING$/m)
            const verifiedTooling = await readSection(cwd, 'TASK_0001', 'verified tooling')
            expect(verifiedTooling).toContain('bun run lint')
        })
    })

    test('grill auto-answer: ui.input never called when ANSWER: is returned', async () => {
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            // grill-gen is re-called after every answer (open-ended interview);
            // the model signals "done" by emitting NONE. Emit one question per
            // call, then NONE — a constant non-NONE response would never let the
            // loop terminate.
            const grillQuestions = ['1. should we use bun?', '1. should we lint tests?']
            let genCall = 0
            await runOnce(handle.ctx, cwd, {
                runWorker: happyWorkers(),
                runChild: happyChildren({
                    'grill-gen': () => grillQuestions[genCall++] ?? 'NONE',
                    'grill-auto': 'ANSWER: yes'
                })
            })
            expect(handle.captured.inputs).toHaveLength(0)
            const qa = await readSection(cwd, 'TASK_0001', 'grill Q&A')
            expect(qa).toContain('(auto)')
        })
    })

    test('compose receives refined and research in its prompt', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let composePrompt = ''
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers(),
                runChild: happyChildren({
                    compose: prompt => {
                        composePrompt = prompt
                        return COMPOSE_SPEC
                    }
                })
            })
            expect(composePrompt).toContain('Run the linter')
            expect(composePrompt).toContain('package.json')
        })
    })

    test('critique receives the compose spec verbatim in its prompt', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let critiquePrompt = ''
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers(),
                runChild: happyChildren({
                    critique: prompt => {
                        critiquePrompt = prompt
                        return COMPOSE_SPEC
                    }
                })
            })
            expect(critiquePrompt).toContain(COMPOSE_SPEC.trim())
        })
    })

    test('phase timings section is written on success and lists every phase', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await runOnce(ctx, cwd, happy())
            const timings = await readSection(cwd, 'TASK_0001', 'phase timings')
            expect(timings).not.toBeNull()
            const body = timings ?? ''
            for (const phase of ['refine', 'research', 'grill', 'compose', 'critique', 'total']) {
                expect(body).toContain(phase)
            }
            // Research sub-steps should be present (workers + verify-tooling).
            expect(body).toContain('workers')
            expect(body).toContain('verify-tooling')
        })
    })

    test('phase timings are persisted even when the pipeline fails mid-flight', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            // refine succeeds, FILES research worker returns empty → research fails.
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers({files: ''}),
                runChild: scriptedChildren({refine: REFINED_FIXTURE})
            })
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            const timings = await readSection(cwd, 'TASK_0001', 'phase timings')
            expect(timings).not.toBeNull()
            // Refine completed before the failure, so it should appear; research
            // also gets a partial entry (its try/finally captures the time spent
            // before throwing).
            expect(timings ?? '').toContain('refine')
            expect(timings ?? '').toContain('research')
        })
    })

    test('handoff: completed state and sendSpec receives final spec', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const {sent} = await runOnce(ctx, cwd, happy())
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            expect(frontMatter.phase).toBe('done')
            expect(sent).toHaveLength(1)
            expect(sent[0]).toContain('VERIFY:')
            expect(await readSection(cwd, 'TASK_0001', 'handoff')).toMatch(/handoff_at:/)
        })
    })
})

describe('TaskRunner — resume', () => {
    test('resume mid-pipeline skips completed phases', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 'Run lint'
                },
                `
## raw prompt

run lint

## refined prompt

${REFINED_FIXTURE.trim()}

## research

FILES
${RESEARCH_FILES}

APIS
${RESEARCH_APIS}

CONTEXT
${RESEARCH_CONTEXT}

VERIFIED-TOOLING
  bun run lint
  bun test
`
            )
            let refineCalled = false
            await new TaskRunner({
                ctx,
                cwd,
                rawPrompt: '',
                resumeId: 'TASK_0001',
                sendSpec: async () => {},
                runChild: scriptedChildren({
                    refine: () => {
                        refineCalled = true
                        return REFINED_FIXTURE
                    },
                    'grill-gen': NO_QUESTIONS,
                    compose: COMPOSE_SPEC,
                    critique: COMPOSE_SPEC
                })
            }).run()
            expect(refineCalled).toBe(false)
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
        })
    })

    // A resume past COMPOSE replays compose's `carry`. Without it, `p.refined` is
    // whatever `## refined prompt` holds — which is deliberately the text refine
    // wrote, refuted constraint and all — and CRITIQUE_PROMPT calls that GROUND
    // TRUTH whose CONSTRAINTS "MUST be preserved in spirit". The drop that closed
    // the mx5 run-19 defect was reachable only on the live path.
    test('resume at critique replays compose’s refutation drop', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const refinedWithRefuted = `GOAL
Scaffold the project.

CONSTRAINTS
- Use bun.
- Add only new entries the task requires (e.g., \`hono\`, \`argon2\`, \`sharp\`).

KNOWN-UNKNOWNS
- (none)
`
            const researchRefuting = `FILES
${RESEARCH_FILES}

APIS
${RESEARCH_APIS}

CONTEXT
- Password hashing uses \`Bun.password\` (built-in argon2id) — no external \`argon2\` dependency needed despite the task's mention of it.

VERIFIED-TOOLING
  bun run lint
`
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'critique',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 'Scaffold'
                },
                `
## raw prompt

scaffold

## refined prompt

${refinedWithRefuted.trim()}

## research

${researchRefuting.trim()}

## grill Q&A

(no questions produced)

## spec

${COMPOSE_SPEC.trim()}
`
            )
            let critiquePrompt = ''
            let composeCalled = false
            await new TaskRunner({
                ctx,
                cwd,
                rawPrompt: '',
                resumeId: 'TASK_0001',
                sendSpec: async () => {},
                runChild: scriptedChildren({
                    compose: () => {
                        composeCalled = true
                        return COMPOSE_SPEC
                    },
                    critique: prompt => {
                        critiquePrompt = prompt
                        return COMPOSE_SPEC
                    }
                })
            }).run()

            expect(composeCalled).toBe(false)
            expect(critiquePrompt).not.toBe('')
            // The refuted constraint is gone from what critique is handed…
            expect(critiquePrompt).not.toContain('`argon2`')
            // …and the rest of that same constraint line survived, so this is the
            // surgical drop, not a missing refined task.
            expect(critiquePrompt).toContain('`sharp`')
            expect(critiquePrompt).toContain('`hono`')
        })
    })

    // The live run already wrote the drop to `## gates`. A replay must not append
    // a second copy — which is why a carry returns its trail instead of writing it.
    test('the replayed carry does not duplicate the gates trail', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await writeTaskFile(
                cwd,
                {
                    id: 'TASK_0001',
                    state: 'in_progress',
                    phase: 'critique',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 'Scaffold'
                },
                `
## raw prompt

scaffold

## refined prompt

GOAL
Scaffold.

CONSTRAINTS
- Add \`argon2\`.

## research

CONTEXT
- Password hashing uses \`Bun.password\` (built-in argon2id) — no external \`argon2\` dependency needed despite the task's mention of it.

## grill Q&A

(no questions produced)

## spec

${COMPOSE_SPEC.trim()}
`
            )
            await new TaskRunner({
                ctx,
                cwd,
                rawPrompt: '',
                resumeId: 'TASK_0001',
                sendSpec: async () => {},
                runChild: scriptedChildren({critique: COMPOSE_SPEC})
            }).run()

            const gates = (await readSection(cwd, 'TASK_0001', 'gates')) ?? ''
            const drops = gates.match(/constraint refuted by research/g) ?? []
            expect(drops).toHaveLength(0)
        })
    })
})

describe('runSingleTask', () => {
    test('runSingleTask: default delivers spec without an extra idle wait (parity with /task)', async () => {
        await withTmpTaskDir(async cwd => {
            // The spec is delivered through the *replacement* session, so assert
            // on the shared call log rather than patching the (soon-stale) ctx.
            const {ctx, captured} = makeFakeCtx(cwd)
            const {end, taskId} = await runSingleTask(ctx, cwd, 'run lint', {
                ...happy()
            })
            expect(end).toEqual({kind: 'completed'})
            expect(taskId).toBe('TASK_0001')
            expect(captured.calls).toEqual(['send'])
        })
    })

    test('runSingleTask: fixInstruction prepends a RE-ATTEMPT banner to the delivered spec', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured} = makeFakeCtx(cwd)
            const {end} = await runSingleTask(ctx, cwd, 'run lint', {
                ...happy(),
                fixInstruction: 'work did not verify: bun run build exited 1'
            })
            expect(end).toEqual({kind: 'completed'})
            const delivered = captured.sentMessages.at(-1)?.spec ?? ''
            // The implementer is told this is a re-attempt and given the failure,
            // ahead of the composed spec it still receives in full.
            expect(delivered).toContain('RE-ATTEMPT')
            expect(delivered).toContain('bun run build exited 1')
            expect(delivered).toContain(COMPOSE_SPEC.trim())
        })
    })

    test('runSingleTask: waitForImplementation awaits idle after delivering the spec', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured} = makeFakeCtx(cwd)
            const {end} = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(end).toEqual({kind: 'completed'})
            expect(captured.calls).toEqual(['send', 'idle'])
        })
    })

    // Live repro (pi 0.82.1, local model, issue #8): a chat message sent from the
    // browser during a child phase starts a host turn, and if it is still
    // streaming when the pipeline delivers its spec, the delivery throws and the
    // run dies — "TASK_0001 failed: Agent is already processing." Delivery must
    // queue itself instead, whatever else happens to be on the session.
    test('runSingleTask: a foreign streaming turn does not kill spec delivery', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured, setForeignTurnStreaming} = makeFakeCtx(cwd)
            setForeignTurnStreaming(true)
            const {end, taskId} = await runSingleTask(ctx, cwd, 'run lint', {
                ...happy()
            })
            expect(end).toEqual({kind: 'completed'})
            expect(taskId).toBe('TASK_0001')
            expect(captured.sentMessages).toHaveLength(1)
            expect((captured.sentMessages[0]?.opts as {deliverAs?: string}).deliverAs).toBe(
                'followUp'
            )
        })
    })

    test('runSingleTask: ESC then steering text continues the same task, not interrupted', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, setStopReason, captured} = makeFakeCtx(cwd)
            // The implementation turn ends aborted (user pressed ESC).
            setStopReason('aborted')
            let asks = 0
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy(),
                // The user steers once; that turn then completes naturally.
                promptSteer: () => {
                    asks++
                    setStopReason('stop')
                    return Promise.resolve('use the other API')
                }
            })
            // Steered exactly once, then the next turn finished uninterrupted.
            expect(asks).toBe(1)
            expect(res.end.kind).not.toBe('interrupted')
            // The steering text was delivered back as another turn.
            expect(captured.sentMessages.some(m => m.spec === 'use the other API')).toBe(true)
        })
    })

    test('runSingleTask: ESC then an empty steer prompt pauses (interrupted)', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, setStopReason} = makeFakeCtx(cwd)
            setStopReason('aborted')
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy(),
                // The user declines to steer — pause the run.
                promptSteer: () => Promise.resolve(undefined)
            })
            expect(res.end.kind).toBe('interrupted')
        })
    })

    test('runSingleTask: the default steer prompt is bridged to remote viewers', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, setStopReason, captured} = makeFakeCtx(cwd)
            setStopReason('aborted')
            // Capture what the bridge broadcasts: a remote Stop must surface the
            // same steer/pause prompt as a terminal ESC, not leave the browser
            // staring at a silently paused run.
            const sent: Array<{type: string}> = []
            _setSink(msg => sent.push(msg as never))
            try {
                const res = await runSingleTask(ctx, cwd, 'run lint', {
                    waitForImplementation: true,
                    ...happy()
                    // no promptSteer → the production default (SessionUI.ask) runs
                })
                // Local half: the TUI input with the steer title and placeholder.
                const input = captured.inputs.find(i => i.title.includes('steer the model'))
                expect(input).toBeDefined()
                expect(input!.default).toContain('leave empty to pause')
                // Remote half: a prompt card with Skip (=pause) and no recommended
                // answer (the placeholder must not render as an acceptable one).
                const prompt = sent.find(m => m.type === 'prompt') as {
                    allowSkip?: boolean
                    recommended?: string
                    question?: string
                }
                expect(prompt).toBeDefined()
                expect(prompt.allowSkip).toBe(true)
                expect(prompt.recommended).toBeUndefined()
                expect(prompt.question).toContain('Skip to pause')
                // No queued local answer → undefined → the run pauses.
                expect(res.end.kind).toBe('interrupted')
            } finally {
                _setSink(wsBroadcast)
                resetSessionState()
            }
        })
    })

    test('runSingleTask: a natural completion never prompts to steer', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, setStopReason} = makeFakeCtx(cwd)
            setStopReason('stop')
            let asks = 0
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy(),
                promptSteer: () => {
                    asks++
                    return Promise.resolve(undefined)
                }
            })
            expect(asks).toBe(0)
            expect(res.end.kind).not.toBe('interrupted')
        })
    })

    test('runSingleTask: implementation turn ending in stopReason "error" is not ok', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, setStopReason} = makeFakeCtx(cwd)
            // The spec composes fine (file → state "completed" at handoff), but the
            // implementation turn then dies — e.g. a context-overflow 400.
            setStopReason('error', '400 request (124789 tokens) exceeds the available context size')
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            // Must NOT read as ok despite the file saying "completed" — otherwise
            // /task-auto would check the task off and commit a dead turn.
            expect(res.end.kind).not.toBe('completed')
            expect(res.end.kind).not.toBe('interrupted')
            expect(res.end.kind === 'failed' ? res.end.reason : undefined).toContain(
                'exceeds the available context size'
            )
        })
    })

    test('runSingleTask: a clean implementation turn ("stop") stays ok with no reason', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, setStopReason} = makeFakeCtx(cwd)
            setStopReason('stop')
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(res.end).toEqual({kind: 'completed'})
            expect(res.end.kind === 'failed' ? res.end.reason : undefined).toBeUndefined()
        })
    })

    test('runSingleTask: returns the fresh replacement ctx; the original is stale', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                ...happy()
            })
            // The run replaced the session, so the handed-back ctx is a new, live
            // object — not the original, which now throws on use.
            expect(res.ctx).toBeDefined()
            expect(res.ctx).not.toBe(ctx)
            expect(() => ctx.ui.notify('x', 'info')).toThrow(/stale/)
            // The replacement ctx is live.
            expect(() => res.ctx!.ui.notify('ok', 'info')).not.toThrow()
        })
    })
})

describe('compaction-aware implementation wait', () => {
    // Count the compaction-resume nudges sent during a run.
    const continueCount = (sent: Array<{spec: string}>): number =>
        sent.filter(m => m.spec === CONTINUE_AFTER_COMPACTION).length

    // ── A/B: same harness, the ONLY difference is whether the turn parks at a
    // compaction boundary. Pre-fix, both jumped straight past the wait; the control
    // proves no regression, the compaction case proves the resume now fires.

    test('A (control): a clean turn does NOT send any continue and waits once', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured, setIdleEntries} = makeFakeCtx(cwd)
            setIdleEntries([[assistantEntry('stop')]])
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(res.end).toEqual({kind: 'completed'})
            expect(res.end.kind).not.toBe('interrupted')
            expect(continueCount(captured.sentMessages)).toBe(0)
            // exactly one implementation-wait idle, no resume waits
            expect(captured.calls.filter(c => c === 'idle')).toHaveLength(1)
        })
    })

    test('B (fix): a turn parked at a compaction resumes instead of jumping to verify', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured, setIdleEntries} = makeFakeCtx(cwd)
            // First idle: compaction boundary (the runtime parked here without
            // auto-continuing). After one continue: a real assistant "stop".
            setIdleEntries([[compactionEntry()], [assistantEntry('stop')]])
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(res.end).toEqual({kind: 'completed'})
            expect(res.end.kind).not.toBe('interrupted')
            // exactly one resume continue, and a second wait for it to settle
            expect(continueCount(captured.sentMessages)).toBe(1)
            expect(captured.calls.filter(c => c === 'idle')).toHaveLength(2)
        })
    })

    test('B (fix): resumes across SUCCESSIVE compactions until the work is done', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured, setIdleEntries} = makeFakeCtx(cwd)
            setIdleEntries([[compactionEntry()], [compactionEntry()], [assistantEntry('stop')]])
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(res.end).toEqual({kind: 'completed'})
            expect(continueCount(captured.sentMessages)).toBe(2)
            expect(captured.calls.filter(c => c === 'idle')).toHaveLength(3)
        })
    })

    test('ESC takes priority: an aborted turn at a compaction tail steers, never resumes', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured, setIdleEntries, queueInput} = makeFakeCtx(cwd)
            // Artificial tail: the last assistant message is aborted (user ESC) and a
            // compaction entry follows. wasInterrupted must win over the boundary.
            setIdleEntries([[assistantEntry('aborted'), compactionEntry()]])
            queueInput(undefined) // decline to steer → pause
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(res.end.kind).toBe('interrupted')
            expect(continueCount(captured.sentMessages)).toBe(0)
        })
    })

    test('safety cap bounds a pathological compaction loop at MAX_COMPACTION_RESUMES', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx, captured, setIdleEntries} = makeFakeCtx(cwd)
            // Every idle reports a compaction boundary (snapshot clamps to the last);
            // without a cap this would resume forever.
            setIdleEntries([[compactionEntry()]])
            const res = await runSingleTask(ctx, cwd, 'run lint', {
                waitForImplementation: true,
                ...happy()
            })
            expect(res).toBeDefined()
            expect(continueCount(captured.sentMessages)).toBe(MAX_COMPACTION_RESUMES)
        })
    })
})

describe('TaskRunner — failure modes', () => {
    test('empty refine output → state failed, reason mentions refine (TASK_0004 regression)', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            // Through `spawn`, not `runChild`: the ladder's empty-completion rung is
            // the subject here, and only a real (fake) process exercises it.
            await runOnce(ctx, cwd, {spawnFn: fakeSpawnByPrompt(() => agentEndResponse(''))})
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.phase).toBe('refine')
            expect(frontMatter.reason).toMatch(/refine child produced no output/)
        })
    })

    // ISSUE #10. An empty research section used to fail the whole task, which is exactly
    // what an extremely simple task provokes — nothing on disk to survey, no external
    // symbol in play, so silence is the correct answer. It is now retried once and then
    // recorded as an explicitly empty section. What stays fatal is silence with a
    // provider-reported cause (the masked disconnect the old branch was written for).
    test('empty FILES worker, retry answers → the retry becomes the section', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let filesAttempts = 0
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers({
                    files: () => (++filesAttempts === 1 ? '' : RESEARCH_FILES)
                }),
                runChild: happyChildren()
            })
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            expect(filesAttempts).toBe(2)
            expect(await readSection(cwd, 'TASK_0001', 'research')).toContain(RESEARCH_FILES)
        })
    })

    test('FILES worker empty twice → section recorded as (none), task still completes', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers({files: ''}),
                runChild: happyChildren()
            })
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            const research = (await readSection(cwd, 'TASK_0001', 'research')) ?? ''
            // The marker must say the worker RAN and found nothing — not merely be
            // blank, which reads the same as a worker that never answered.
            expect(research).toMatch(/FILES\n\(none — the FILES worker ran and reported no/)
            // The other three workers are untouched by the gate.
            expect(research).toContain(RESEARCH_APIS)
        })
    })

    // The empty/failed distinction has to survive the case the two look identical in:
    // a child that writes nothing at all. A worker that never emitted a byte died
    // before it could answer, so it cannot have answered "nothing".
    test('MUTE FILES worker (no stdout at all) → state failed, never recorded as empty', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers({
                    // Never wrote a byte, dead on arrival — the shape of a child
                    // that could not resolve a provider and exited at startup.
                    files: () => ({text: '', sawOutput: false, stderr: 'no model configured'})
                }),
                runChild: scriptedChildren({refine: REFINED_FIXTURE})
            })
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.reason).toMatch(/never wrote a single byte/)
            expect(await readSection(cwd, 'TASK_0001', 'research')).toBeNull()
        })
    })

    test('empty FILES worker WITH a model error → state failed, reason names the cause', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers({
                    files: () => ({text: '', modelError: 'fetch failed: socket hang up'})
                }),
                runChild: scriptedChildren({refine: REFINED_FIXTURE})
            })
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.reason).toMatch(/Research FILES worker: model error/)
            expect(frontMatter.reason).toMatch(/socket hang up/)
        })
    })

    test('compose retry with emphasis: first attempt fenced, second valid', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            let composeAttempts = 0
            const composePrompts: string[] = []
            await runOnce(ctx, cwd, {
                runWorker: happyWorkers(),
                runChild: happyChildren({
                    compose: prompt => {
                        composePrompts.push(prompt)
                        composeAttempts++
                        return composeAttempts === 1 ? '```sh\nGOAL\n…\n```' : COMPOSE_SPEC
                    }
                })
            })
            expect(composeAttempts).toBe(2)
            expect(composePrompts[1]).toContain('PREVIOUS ATTEMPT VIOLATED')
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
        })
    })

    test('critique missing VERIFY twice → fallback to compose draft, task completed', async () => {
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            const BAD_CRITIQUE = `GOAL
x
CONSTRAINTS
- y
ACCEPTANCE
- w
`
            const {sent} = await runOnce(handle.ctx, cwd, {
                runWorker: happyWorkers(),
                runChild: happyChildren({critique: BAD_CRITIQUE})
            })
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('completed')
            const fallbackNotify = handle.captured.notifies.find(
                n => n.level === 'warning' && n.msg.includes('Critique couldn')
            )
            expect(fallbackNotify).toBeDefined()
            expect(sent[0]).toContain('VERIFY:')
        })
    })

    test('loop exhaustion in refine → state failed with loop_detected reason', async () => {
        await withTmpTaskDir(async cwd => {
            const {ctx} = makeFakeCtx(cwd)
            const loopRefine = {
                events: Array.from({length: 5}, () => ({
                    type: 'tool_execution_start',
                    toolName: 'Read',
                    args: {path: '/foo'}
                }))
            }
            // Through `spawn`: the loop detector only runs around a real (fake)
            // process, and refine is the first child, so every spawn IS refine.
            await runOnce(ctx, cwd, {spawnFn: fakeSpawnByPrompt(() => loopRefine)})
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('failed')
            expect(frontMatter.reason).toMatch(/loop detected 3× in refine/)
            const events = await readSection(cwd, 'TASK_0001', 'loop events')
            expect(events).not.toBeNull()
            expect((events ?? '').split('\n').length).toBeGreaterThanOrEqual(3)
        })
    })

    test('user cancel during research → state cancelled, warning notify', async () => {
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            const runnerHolder: {runner?: TaskRunner} = {}
            let cancelTriggered = false
            runnerHolder.runner = new TaskRunner({
                ctx: handle.ctx,
                cwd,
                rawPrompt: 'run lint',
                sendSpec: async () => {},
                runWorker: happyWorkers(
                    {
                        files: () => {
                            if (!cancelTriggered) {
                                cancelTriggered = true
                                queueMicrotask(() => runnerHolder.runner?.cancel())
                            }
                            return RESEARCH_FILES
                        }
                    },
                    'noop'
                ),
                runChild: scriptedChildren({refine: REFINED_FIXTURE})
            })
            const end = await runnerHolder.runner.run()
            const {frontMatter} = await readTaskFile(cwd, 'TASK_0001')
            expect(frontMatter.state).toBe('cancelled')
            // The runner NAMES the ending. It used to return void, so the caller
            // re-read this file, narrowed `state` to `ok: boolean`, and reported a
            // user's own cancel as a failure — see run-end.ts.
            expect(end).toEqual({kind: 'cancelled'})
            const warn = handle.captured.notifies.find(n => n.level === 'warning')
            expect(warn).toBeDefined()
        })
    })

    test('a cancel is reported as CANCELLED, and its file is not rewritten to failed', async () => {
        // The end-to-end shape of the /task-cancel defect: `state` is `cancelled`,
        // which is not `completed`, so `ok` was false, so `!res.ok` ran
        // `markResumable` (which writes `failed`) and announced a red
        // "stopped — fix and run /task-resume" for a stop the user asked for.
        await withTmpTaskDir(async cwd => {
            const handle = makeFakeCtx(cwd)
            const runnerHolder: {runner?: TaskRunner} = {}
            runnerHolder.runner = new TaskRunner({
                ctx: handle.ctx,
                cwd,
                rawPrompt: 'run lint',
                sendSpec: async () => {},
                runChild: (name, _tools, _prompt) => {
                    if (name === 'refine') queueMicrotask(() => runnerHolder.runner?.cancel())
                    return Promise.resolve(REFINED_FIXTURE)
                },
                runWorker: happyWorkers()
            })
            const end = await runnerHolder.runner.run()
            expect(end.kind).toBe('cancelled')
            expect(RUN_END_POLICY[end.kind].resumable).toBe(false)
            // The ledger keeps the truth: the user stopped it.
            expect((await readTaskFile(cwd, 'TASK_0001')).frontMatter.state).toBe('cancelled')
            // …and nobody was told to go fix something.
            expect(handle.captured.notifies.some(n => /fix and run/.test(n.msg))).toBe(false)
            expect(handle.captured.notifies.some(n => n.level === 'error')).toBe(false)
        })
    })
})
