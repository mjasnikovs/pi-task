import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {runGatesForTask, type GateDeps, type GateParams} from './task-gates.js'
import {ACCEPT_LABEL, AUTOFIX_LABEL} from './verify-resolution.js'

/** A GateDeps whose runTask/commit always succeed; override per test. */
function makeDeps(over: Partial<GateDeps> = {}): GateDeps {
    return {
        runTask: () => Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true}),
        ...over
    }
}

const baseParams = (over: Partial<GateParams> = {}): GateParams => ({
    cwd: '/tmp/x',
    taskId: 'TASK_0006',
    title: 'A',
    tag: 'TASK_0006',
    ...over
})

test('runGatesForTask: no verify dep → onVerified, commits, enforce runs FLAG mode, done', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const commits: string[] = []
        const modes: Array<'edit' | 'flag'> = []
        let verified = false
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            enforce: (_c, _cwd, _t, mode) => {
                modes.push(mode)
                return Promise.resolve({ok: true})
            }
        })
        const r = await runGatesForTask(
            ctx,
            deps,
            baseParams({
                cwd: dir,
                onVerified: () => {
                    verified = true
                }
            })
        )
        expect(r.kind).toBe('done')
        expect(verified).toBe(true)
        // No verify signal ⇒ enforce may only flag, not edit.
        expect(modes).toEqual(['flag'])
        // Only the task commit (flag mode makes no edits ⇒ no ENFORCE commit).
        expect(commits).toEqual(['task: A (TASK_0006)'])
    })
})

test('runGatesForTask: clean verify ⇒ enforce EDIT mode; clean re-verify keeps the fix commit', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const commits: string[] = []
        const modes: Array<'edit' | 'flag'> = []
        let reverted = false
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: true}),
            enforce: (_c, _cwd, _t, mode) => {
                modes.push(mode)
                return Promise.resolve({ok: true})
            },
            revert: () => {
                reverted = true
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(modes).toEqual(['edit'])
        expect(reverted).toBe(false)
        expect(commits).toEqual(['task: A (TASK_0006)', 'ENFORCE GUIDELINES: A (TASK_0006)'])
    })
})

test('runGatesForTask: enforce edits that REGRESS verify are reverted', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        let reverted = false
        let verifyCalls = 0
        const deps = makeDeps({
            verify: () => {
                verifyCalls += 1
                return Promise.resolve(
                    verifyCalls === 1 ? {ok: true} : {ok: false, reason: 'tsc 3 errors'}
                )
            },
            enforce: () => Promise.resolve({ok: true}),
            revert: () => {
                reverted = true
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(verifyCalls).toBe(2)
        expect(reverted).toBe(true)
        expect(captured.notifies.some(n => /regressed verification/.test(n.msg))).toBe(true)
    })
})

test('runGatesForTask: verify FAIL + user dismisses → paused, no check-off, no commit', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const commits: string[] = []
        let verified = false
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'broken'})
        })
        // No queueSelect → the picker is dismissed (cancel).
        const r = await runGatesForTask(
            ctx,
            deps,
            baseParams({
                cwd: dir,
                onVerified: () => {
                    verified = true
                }
            })
        )
        expect(r.kind).toBe('paused')
        expect(verified).toBe(false)
        expect(commits).toEqual([])
    })
})

test('runGatesForTask: verify FAIL + ACCEPT → proceeds, commits, done', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        const commits: string[] = []
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: false, reason: 'over-strict check'}),
            recommend: () => Promise.resolve({recommend: 'accept', rationale: 'valid file'})
        })
        handle.queueSelect(ACCEPT_LABEL)
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(commits).toEqual(['task: A (TASK_0006)'])
        expect(captured.notifies.some(n => /accepted .* despite verify FAIL/.test(n.msg))).toBe(
            true
        )
    })
})

test('runGatesForTask: AUTOFIX loops back to the gate until the work verifies', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        const fixInstructions: Array<string | undefined> = []
        let verifyCalls = 0
        const deps = makeDeps({
            runTask: (_c, _cwd, _t, opts) => {
                fixInstructions.push(opts?.fixInstruction)
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            verify: () => {
                verifyCalls += 1
                return Promise.resolve(
                    verifyCalls <= 2 ? {ok: false, reason: 'build exited 1'} : {ok: true}
                )
            },
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'real defect'})
        })
        handle.queueSelect(AUTOFIX_LABEL)
        handle.queueSelect(AUTOFIX_LABEL)
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        // Two AUTOFIX re-runs, each carrying the failure as its fixInstruction.
        expect(fixInstructions).toHaveLength(2)
        expect(fixInstructions.every(f => f?.includes('build exited 1'))).toBe(true)
        expect(verifyCalls).toBe(3)
    })
})

test('runGatesForTask: AUTOFIX re-run that fails → failed result with reason', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        const deps = makeDeps({
            runTask: () =>
                Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: false,
                    sessionCancelled: false,
                    reason: 'model died'
                }),
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'defect'})
        })
        handle.queueSelect(AUTOFIX_LABEL)
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('failed')
        if (r.kind === 'failed') expect(r.reason).toBe('model died')
    })
})

test('runGatesForTask: AUTOFIX re-run interrupted / session-cancelled propagate', async () => {
    await withTmpTaskDir(async dir => {
        const interruptedHandle = makeFakeCtx(dir)
        interruptedHandle.queueSelect(AUTOFIX_LABEL)
        const interruptedDeps = makeDeps({
            runTask: () =>
                Promise.resolve({
                    taskId: 'TASK_0006',
                    ok: true,
                    sessionCancelled: false,
                    interrupted: true
                }),
            verify: () => Promise.resolve({ok: false, reason: 'x'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'y'})
        })
        const r1 = await runGatesForTask(
            interruptedHandle.ctx,
            interruptedDeps,
            baseParams({cwd: dir})
        )
        expect(r1.kind).toBe('interrupted')

        const cancelledHandle = makeFakeCtx(dir)
        cancelledHandle.queueSelect(AUTOFIX_LABEL)
        const cancelledDeps = makeDeps({
            runTask: () =>
                Promise.resolve({taskId: 'TASK_0006', ok: false, sessionCancelled: true}),
            verify: () => Promise.resolve({ok: false, reason: 'x'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'y'})
        })
        const r2 = await runGatesForTask(cancelledHandle.ctx, cancelledDeps, baseParams({cwd: dir}))
        expect(r2.kind).toBe('session-cancelled')
    })
})

test('runGatesForTask: an empty commit warns but still completes', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const deps = makeDeps({
            commit: () => Promise.resolve({committed: false, reason: 'auto-commit disabled'}),
            // enforce is gated on commit.committed, so it must NOT run here.
            enforce: () => Promise.reject(new Error('enforce should not run without a commit'))
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(captured.notifies.some(n => /not committed/.test(n.msg))).toBe(true)
    })
})
