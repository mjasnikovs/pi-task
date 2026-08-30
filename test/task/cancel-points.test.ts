import {test, expect, describe, afterEach} from 'bun:test'
import {
    requestCancel,
    resetCancel,
    resetCheckpointTrail,
    isCancelRequested,
    cancelCheckpoint,
    checkpointsCrossed
} from '../../src/task/cancel-points.js'
import {runAutoLoop, requestAutoCancel, type AutoDeps} from '../../src/task/auto-orchestrator.js'
import {writeTaskFile, readTaskFile} from '../../src/task/task-io.js'
import {parseTaskList, findResumableAuto} from '../../src/task/auto-io.js'
import {armCancelListener, disarmCancelListener} from '../../src/task/cancel-input.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import type {TaskFrontMatter} from '../../src/task/task-types.js'

function autoFm(id: string): TaskFrontMatter {
    const now = new Date().toISOString()
    return {id, state: 'in_progress', phase: 'done', created_at: now, updated_at: now, title: 't'}
}

function autoBody(titles: string[]): string {
    return `\n## feature\n\nf\n\n## tasks\n\n${titles.map(t => `- [ ] ${t}`).join('\n')}\n`
}

afterEach(() => {
    resetCancel()
    resetCheckpointTrail()
    delete process.env.CANCEL_AB_ARM
})

describe('cancel-points', () => {
    test('a checkpoint reports the request and records the visit either way', () => {
        resetCancel()
        resetCheckpointTrail()
        expect(cancelCheckpoint('pre-task')).toBe(false)
        requestCancel()
        expect(isCancelRequested()).toBe(true)
        expect(cancelCheckpoint('loop-top')).toBe(true)
        // Both visits are on the trail — a checkpoint that never runs must be
        // distinguishable from one that ran and did not fire.
        expect(checkpointsCrossed()).toEqual(['pre-task', 'loop-top'])
    })

    test('resetCancel clears the request but keeps the trail readable', () => {
        resetCheckpointTrail()
        requestCancel()
        cancelCheckpoint('pre-final-gate')
        resetCancel()
        expect(isCancelRequested()).toBe(false)
        // The run's `finally` calls resetCancel, which clears only the requested
        // flag — the trail has its own clearCheckpoints. A caller inspecting
        // where the run stopped reads the trail after that, so it must survive.
        expect(checkpointsCrossed()).toEqual(['pre-final-gate'])
    })

    test('the A/B baseline arm suppresses every checkpoint except loop-top', () => {
        resetCheckpointTrail()
        process.env.CANCEL_AB_ARM = 'baseline'
        requestCancel()
        expect(cancelCheckpoint('pre-task')).toBe(false)
        expect(cancelCheckpoint('phase:research')).toBe(false)
        expect(cancelCheckpoint('pre-final-gate')).toBe(false)
        expect(cancelCheckpoint('loop-top')).toBe(true)
    })
})

describe('runAutoLoop cancel checkpoints', () => {
    test('pre-task: a cancel raised during planning stops before the first task runs', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, captured} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            const ran: string[] = []
            const d: AutoDeps = {
                runChild: () => Promise.resolve(''),
                runTask: (_c: unknown, _cwd: string, title: string) => {
                    ran.push(title)
                    return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
                },
                // The pre-task checkpoint sits immediately after this commit, so
                // firing here is the loop's last chance to stop for free.
                commit: () => {
                    requestAutoCancel()
                    return Promise.resolve({committed: false})
                }
            } as unknown as AutoDeps
            resetCheckpointTrail()
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
            // Nothing ran, nothing was checked off, and the run is still resumable.
            expect(ran).toEqual([])
            expect(checkpointsCrossed()).toContain('pre-task')
            const {body, frontMatter} = await readTaskFile(dir, 'TASK_AUTO_0001')
            expect(parseTaskList(body).every(e => !e.done)).toBe(true)
            expect(frontMatter.state).toBe('in_progress')
            expect(await findResumableAuto(dir)).toBe('TASK_AUTO_0001')
            expect(captured.notifies.some(n => /cancelled before "A"/.test(n.msg))).toBe(true)
        })
    })

    test('pre-final-gate: a cancel after the last task stops before the whole-repo gate', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, captured} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A']))
            let gateRan = false
            const d: AutoDeps = {
                runChild: () => Promise.resolve(''),
                runTask: () => {
                    // Ask to stop while the only task is running; the loop must
                    // honour it at loop-top and never enter the final gate.
                    requestAutoCancel()
                    return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
                },
                commit: () => Promise.resolve({committed: false}),
                finalGate: () => {
                    gateRan = true
                    return Promise.resolve({ok: true, reason: 'x'})
                }
            } as unknown as AutoDeps
            resetCheckpointTrail()
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
            expect(gateRan).toBe(false)
            // The run must NOT be declared complete — the gate is what completes it.
            const {frontMatter} = await readTaskFile(dir, 'TASK_AUTO_0001')
            expect(frontMatter.state).toBe('in_progress')
            expect(await findResumableAuto(dir)).toBe('TASK_AUTO_0001')
            expect(captured.notifies.some(n => /cancel/i.test(n.msg))).toBe(true)
        })
    })

    test('a cancelled task is announced as cancelled, not as a red failure', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, captured} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            const d: AutoDeps = {
                runChild: () => Promise.resolve(''),
                // A phase-boundary cancel reaches the loop exactly like this:
                // the runner catches its own USER_CANCELLED, writes state
                // 'cancelled' to the inner file, and NAMES the ending.
                //
                // Note what is NOT here: `requestAutoCancel()`. Its only callers
                // are the two /task-auto-cancel paths, so a /task-cancel never
                // sets that module global. A loop that told a user stop from a
                // fault by consulting `isCancelRequested()` alone would therefore
                // read this as a fault — announcing it in red as "stopped … fix
                // and run", and letting `markResumable` overwrite the inner
                // file's 'cancelled' with 'failed'. The ending has to be read
                // from what the runner NAMED.
                runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'cancelled'}}),
                commit: () => Promise.resolve({committed: false})
            } as unknown as AutoDeps
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
            const cancelNote = captured.notifies.find(n => /cancelled during "A"/.test(n.msg))
            expect(cancelNote).toBeDefined()
            expect(cancelNote?.level).toBe('warning')
            // Never the failure wording — a user-requested stop is not a defect.
            expect(captured.notifies.some(n => /fix and run/.test(n.msg))).toBe(false)
            // Parent stays resumable, matching the loop-top cancel.
            expect((await readTaskFile(dir, 'TASK_AUTO_0001')).frontMatter.state).toBe(
                'in_progress'
            )
        })
    })

    test('the cancelled inner task file is NOT rewritten to `failed`', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            // The inner file as the runner left it: cancelled, and resumable.
            await writeTaskFile(
                dir,
                {
                    id: 'TASK_0006',
                    state: 'cancelled',
                    phase: 'grill',
                    created_at: '2026-01-01T00:00:00Z',
                    updated_at: '2026-01-01T00:00:00Z',
                    title: 'A'
                },
                '\n'
            )
            const d: AutoDeps = {
                runChild: () => Promise.resolve(''),
                runTask: () => Promise.resolve({taskId: 'TASK_0006', end: {kind: 'cancelled'}}),
                commit: () => Promise.resolve({committed: false})
            } as unknown as AutoDeps
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
            // `markResumable` writes `state: 'failed'` (orchestrator.ts:739). A
            // cancel is not resumable-as-failed: the user stopped it, and the
            // ledger must not say otherwise.
            expect((await readTaskFile(dir, 'TASK_0006')).frontMatter.state).toBe('cancelled')
        })
    })
})

describe('end-to-end: a typed /task-auto-cancel reaches a run that owns the main loop', () => {
    test('mid-run keystroke is delivered, consumed, and stops at the next checkpoint', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, captured, typeLine} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            const ran: string[] = []
            let consumed = false
            const d: AutoDeps = {
                runChild: () => Promise.resolve(''),
                runTask: (_c: unknown, _cwd: string, title: string) => {
                    ran.push(title)
                    return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
                },
                commit: () => {
                    // The user types the command while the run owns the main
                    // loop and the host session is NOT streaming — the exact
                    // window in which pi would queue the line until after the
                    // run, leaving the command inert.
                    if (ran.length === 0 && !consumed) consumed = typeLine('/task-auto-cancel')
                    return Promise.resolve({committed: false})
                }
            } as unknown as AutoDeps

            // Arm delivery the way the command handlers do.
            armCancelListener(ctx, () => requestAutoCancel())
            try {
                resetCheckpointTrail()
                await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
            } finally {
                disarmCancelListener()
            }

            // Delivered: the keystroke was consumed by our listener, not queued.
            expect(consumed).toBe(true)
            // Observed: the run stopped at the pre-task checkpoint, before any
            // task ran — not after finishing one.
            expect(ran).toEqual([])
            expect(checkpointsCrossed()).toContain('pre-task')
            expect(captured.notifies.some(n => /cancelled before "A"/.test(n.msg))).toBe(true)
            // And it is resumable, with nothing checked off.
            const {body} = await readTaskFile(dir, 'TASK_AUTO_0001')
            expect(parseTaskList(body).every(e => !e.done)).toBe(true)
            expect(await findResumableAuto(dir)).toBe('TASK_AUTO_0001')
        })
    })

    test('without an armed listener the same keystroke is NOT delivered (the old behaviour)', async () => {
        await withTmpTaskDir(async dir => {
            const {ctx, typeLine} = makeFakeCtx(dir)
            await writeTaskFile(dir, autoFm('TASK_AUTO_0001'), autoBody(['A', 'B']))
            const ran: string[] = []
            let consumed = true
            const d: AutoDeps = {
                runChild: () => Promise.resolve(''),
                runTask: (_c: unknown, _cwd: string, title: string) => {
                    ran.push(title)
                    return Promise.resolve({taskId: 'TASK_0006', end: {kind: 'completed'}})
                },
                commit: () => {
                    if (ran.length === 0) consumed = typeLine('/task-auto-cancel')
                    return Promise.resolve({committed: false})
                }
            } as unknown as AutoDeps
            await runAutoLoop(ctx, dir, 'TASK_AUTO_0001', d)
            // Nobody was listening, so the line went nowhere and the run kept
            // going through every task — the defect this fix removes.
            expect(consumed).toBe(false)
            expect(ran).toEqual(['A', 'B'])
        })
    })
})
