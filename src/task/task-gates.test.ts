import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {runGatesForTask, MAX_AUTO_AUTOFIX, type GateDeps, type GateParams} from './task-gates.js'
import {ACCEPT_LABEL} from './verify-resolution.js'

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

test('runGatesForTask: frozen-path guard reverts an enforce edit to a spec-frozen path (edit mode)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const trail: string[] = []
        const revertCalls: string[][] = []
        const deps = makeDeps({
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () => Promise.resolve({ok: true}), // clean pass → EDIT mode
            enforce: () => Promise.resolve({ok: true}),
            dirty: () => Promise.resolve(false), // after the revert the tree is clean
            frozenPaths: () => Promise.resolve(['src/server/index.ts']),
            revertFrozenPaths: (_c, paths) => {
                revertCalls.push(paths)
                return Promise.resolve(['src/server/index.ts']) // the pass had touched it
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(revertCalls).toEqual([['src/server/index.ts']])
        // The deny is recorded and surfaced.
        expect(
            trail.some(
                l =>
                    l.startsWith('enforce: frozen-path write DENIED')
                    && l.includes('src/server/index.ts')
            )
        ).toBe(true)
        expect(captured.notifies.some(n => /spec-frozen path/.test(n.msg))).toBe(true)
    })
})

test('runGatesForTask: frozen-path guard is a no-op when the spec froze nothing', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        let revertCalled = false
        const deps = makeDeps({
            verify: () => Promise.resolve({ok: true}),
            enforce: () => Promise.resolve({ok: true}),
            frozenPaths: () => Promise.resolve([]), // nothing frozen
            revertFrozenPaths: (_c, paths) => {
                revertCalled = true
                return Promise.resolve(paths)
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        // No frozen paths ⇒ revert is never consulted.
        expect(revertCalled).toBe(false)
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
            // ACCEPT is the recommendation that surfaces the picker; dismissing it pauses.
            recommend: () => Promise.resolve({recommend: 'accept', rationale: 'broken'})
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

test('runGatesForTask: verify FAIL + ACCEPT records a durable ACCEPT-debt (run 8 TASK_0012)', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        const debts: Array<{taskId: string; reason: string}> = []
        const deps = makeDeps({
            verify: () => Promise.resolve({ok: false, reason: 'modified frozen path src/main.tsx'}),
            recommend: () => Promise.resolve({recommend: 'accept', rationale: 'user call'}),
            recordAcceptDebt: (_c, taskId, reason) => {
                debts.push({taskId, reason})
                return Promise.resolve()
            }
        })
        handle.queueSelect(ACCEPT_LABEL)
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        // The ACCEPT branch records the FAIL reason against the task for run-end re-check.
        expect(debts).toEqual([{taskId: 'TASK_0006', reason: 'modified frozen path src/main.tsx'}])
    })
})

test('runGatesForTask: ACCEPT with cross-task deletions records one debt per deletion (run 12 PROMPT 2)', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        const deletionDebts: Array<{taskId: string; path: string; owner: string}> = []
        const deps = makeDeps({
            verify: () =>
                Promise.resolve({
                    ok: false,
                    reason: 'work did not verify: deleted sibling deliverables',
                    crossTaskDeletions: [
                        {path: 'playwright-ct.config.ts', owner: 'TASK_0020'},
                        {path: 'playwright/index.ts', owner: 'TASK_0020'}
                    ]
                }),
            recommend: () => Promise.resolve({recommend: 'accept', rationale: 'user call'}),
            recordCrossTaskDeletionDebt: (_c, taskId, del) => {
                deletionDebts.push({taskId, ...del})
                return Promise.resolve()
            }
        })
        handle.queueSelect(ACCEPT_LABEL)
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(deletionDebts).toEqual([
            {taskId: 'TASK_0006', path: 'playwright-ct.config.ts', owner: 'TASK_0020'},
            {taskId: 'TASK_0006', path: 'playwright/index.ts', owner: 'TASK_0020'}
        ])
    })
})

test('runGatesForTask: an AUTOFIX that converges records NO accept-debt', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const debts: unknown[] = []
        let verifyCalls = 0
        const deps = makeDeps({
            verify: () => {
                verifyCalls += 1
                return Promise.resolve(verifyCalls === 1 ? {ok: false, reason: 'x'} : {ok: true})
            },
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'real bug'}),
            recordAcceptDebt: (_c, taskId, reason) => {
                debts.push({taskId, reason})
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(debts).toEqual([])
    })
})

test('runGatesForTask: recommended AUTOFIX loops back UNATTENDED (no picker) until it verifies', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
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
        // No queueSelect: the picker must NOT be shown — AUTOFIX is auto-applied.
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        // Two AUTOFIX re-runs, each carrying the failure as its fixInstruction.
        expect(fixInstructions).toHaveLength(2)
        expect(fixInstructions.every(f => f?.includes('build exited 1'))).toBe(true)
        expect(verifyCalls).toBe(3)
        // The user was never prompted — the fixes ran unattended.
        expect(captured.selects).toHaveLength(0)
    })
})

test('runGatesForTask: UNOBSERVED verify FAIL forces the picker — never unattended AUTOFIX', async () => {
    // rule 5c (run-8 F2): a spec-required behavioral check could not run because its
    // tooling is absent. An unattended AUTOFIX cannot install a missing tool, so the
    // gate must (a) skip the recommendation research (moot), (b) NOT auto-fix, and
    // (c) show the human picker — even though the default tint is AUTOFIX, which for an
    // ordinary FAIL would auto-apply without a prompt.
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        let runTaskCalls = 0
        let recommendCalled = false
        const deps = makeDeps({
            runTask: () => {
                runTaskCalls += 1
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            verify: () =>
                Promise.resolve({
                    ok: false,
                    unobserved: true,
                    reason: 'work unobserved: browser smoke requires an absent runner'
                }),
            recommend: () => {
                recommendCalled = true
                return Promise.resolve({recommend: 'autofix', rationale: 'x'})
            }
        })
        // No queueSelect → the forced picker is dismissed (cancel) → paused.
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('paused')
        // The picker WAS shown exactly once, and no unattended re-run happened.
        expect(captured.selects).toHaveLength(1)
        expect(runTaskCalls).toBe(0)
        // The (moot) recommendation research was skipped.
        expect(recommendCalled).toBe(false)
    })
})

test('runGatesForTask: recommended AUTOFIX that keeps FAILing shows the picker after MAX_AUTO_AUTOFIX', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx, captured} = handle
        let runTaskCalls = 0
        const deps = makeDeps({
            runTask: (_c, _cwd, _t, _opts) => {
                runTaskCalls += 1
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            // Never converges, and the research keeps recommending AUTOFIX.
            verify: () => Promise.resolve({ok: false, reason: 'still broken'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'defect'})
        })
        // The cap-fallback picker is dismissed (no queueSelect) → paused.
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('paused')
        // Exactly MAX_AUTO_AUTOFIX unattended re-runs, THEN the picker is shown once.
        expect(runTaskCalls).toBe(MAX_AUTO_AUTOFIX)
        expect(captured.selects).toHaveLength(1)
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
        // Recommended AUTOFIX runs unattended; its impl failure propagates.
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('failed')
        if (r.kind === 'failed') expect(r.reason).toBe('model died')
    })
})

test('runGatesForTask: AUTOFIX re-run interrupted / session-cancelled propagate', async () => {
    await withTmpTaskDir(async dir => {
        const interruptedHandle = makeFakeCtx(dir)
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

// ─── Gate trail (deps.record) ────────────────────────────────────────────────
// The durable per-task record of every gate outcome. Motivated by the mx5 audit:
// verdict text and enforce mode lived only in terminal notifies, so gate behavior
// was unauditable from artifacts.

test('record: clean pass path writes verify PASS, commit, enforce(edit) trail in order', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const deps = makeDeps({
            record: (_cwd, _id, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () => Promise.resolve({ok: true}),
            enforce: () => Promise.resolve({ok: true})
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(trail).toEqual([
            'verify: PASS',
            'commit: task snapshot committed',
            'enforce(edit): clean',
            // the fake commit always "commits"; the differential guard's re-verify
            // outcome is folded into the enforce line, not a second verify line
            'enforce: fixes committed — re-verify PASS, kept'
        ])
    })
})

test('record: FAIL → ACCEPT path records verdict, recommendation, acceptance, flag mode', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        const deps = makeDeps({
            record: (_cwd, _id, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () => Promise.resolve({ok: false, reason: 'build exited 1'}),
            recommend: () => Promise.resolve({recommend: 'accept', rationale: 'over-strict'}),
            enforce: () => Promise.resolve({ok: true})
        })
        handle.queueSelect(ACCEPT_LABEL)
        const r = await runGatesForTask(handle.ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(trail).toEqual([
            'verify: FAIL — build exited 1',
            'resolution: recommended ACCEPT',
            'resolution: user ACCEPTED the work despite verify FAIL',
            'commit: task snapshot committed',
            // accept-override is not a clean signal ⇒ flag mode, no enforce commit
            'enforce(flag): clean'
        ])
    })
})

test('record: enforce regression is recorded as re-verify FAILED → REVERTED', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        let verifyCalls = 0
        const deps = makeDeps({
            record: (_cwd, _id, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () => {
                verifyCalls += 1
                // First verify (gate) passes; re-verify after enforce regresses.
                return Promise.resolve(
                    verifyCalls === 1 ? {ok: true} : {ok: false, reason: 'onClick handler gone'}
                )
            },
            enforce: () => Promise.resolve({ok: true}),
            revert: () => Promise.resolve()
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(trail).toContain(
            'enforce: fixes committed but re-verify FAILED (onClick handler gone) — REVERTED'
        )
    })
})

// mx5 run 10 item 3: the re-verify FAIL diagnosis must ALSO be persisted as a durable
// defect (not only the per-task trail line that the final gate never re-reads), using
// the verbatim run 10 TASK_0004 text as fixture.
test('record: enforce-revert FAIL is persisted as a durable defect for the final gate', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const reverted: string[] = []
        const debts: Array<{taskId: string; reason: string}> = []
        let verifyCalls = 0
        const diagnosis =
            'work did not verify: Missing server entry point (src/server/index.ts) and dev script '
            + 'in package.json — the Hono server cannot be started'
        const deps = makeDeps({
            record: () => Promise.resolve(),
            verify: () => {
                verifyCalls += 1
                return Promise.resolve(
                    verifyCalls === 1 ? {ok: true} : {ok: false, reason: diagnosis}
                )
            },
            enforce: () => Promise.resolve({ok: true}),
            revert: c => {
                reverted.push(c)
                return Promise.resolve()
            },
            recordEnforceRevertDebt: (_c, taskId, reason) => {
                debts.push({taskId, reason})
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir, taskId: 'TASK_0004'}))
        expect(r.kind).toBe('done')
        expect(reverted).toHaveLength(1)
        expect(debts).toHaveLength(1)
        expect(debts[0].taskId).toBe('TASK_0004')
        expect(debts[0].reason).toContain('Missing server entry point')
    })
})

test('record: a throwing record dep never breaks the gate sequence', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const deps = makeDeps({
            record: () => Promise.reject(new Error('disk full')),
            verify: () => Promise.resolve({ok: true})
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
    })
})

test('record: enforce skip (nothing committed) is recorded', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const deps = makeDeps({
            record: (_cwd, _id, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            commit: () => Promise.resolve({committed: false, reason: 'auto-commit disabled'}),
            enforce: () => Promise.reject(new Error('must not run'))
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(trail).toEqual([
            'commit: skipped (auto-commit disabled)',
            'enforce: skipped (nothing committed this round)'
        ])
    })
})

// ─── Bounded lint-fix (graduated resolution for repo-health FAILs) ───────────

test('lint-fix: repo-health FAIL → one bounded fix, re-verify PASS, no picker', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        let fixCalls = 0
        let verifyCalls = 0
        const deps = makeDeps({
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () => {
                verifyCalls++
                return Promise.resolve(
                    verifyCalls === 1 ?
                        {ok: false, reason: 'repo health: `bun run lint` exited 1'}
                    :   {ok: true}
                )
            },
            lintFix: () => {
                fixCalls++
                return Promise.resolve({ok: true})
            },
            // The picker must never open: recommend would be its first step.
            recommend: () => Promise.reject(new Error('picker path must not run'))
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(fixCalls).toBe(1)
        expect(verifyCalls).toBe(2)
        expect(trail).toContain('lint-fix: applied — re-verifying')
    })
})

test('lint-fix: not applied → falls through to the picker; attempted only once', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        let fixCalls = 0
        const deps = makeDeps({
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () =>
                Promise.resolve({ok: false, reason: 'repo health: `bun run lint` exited 1'}),
            lintFix: () => {
                fixCalls++
                return Promise.resolve({ok: false, reason: 'revert-guard: fix pass discarded work'})
            },
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'static findings'})
        })
        // No queueSelect → picker dismissed → paused. lintFix must not retry.
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('paused')
        expect(fixCalls).toBe(1)
        expect(trail).toContain('lint-fix: not applied (revert-guard: fix pass discarded work)')
    })
})

test('lint-fix: NOT attempted for a non-health verify FAIL', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        let fixCalls = 0
        const deps = makeDeps({
            verify: () => Promise.resolve({ok: false, reason: 'work did not verify: route 500s'}),
            lintFix: () => {
                fixCalls++
                return Promise.resolve({ok: true})
            },
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'broken'})
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('paused')
        expect(fixCalls).toBe(0)
    })
})

// ─── Enforce pre-commit repo-health gate ─────────────────────────────────────

test('enforce edits that REGRESS repo health (clean before → fail after) are discarded BEFORE commit', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const commits: string[] = []
        let discarded = 0
        let reverted = 0
        let healthCall = 0
        const deps = makeDeps({
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: true}), // clean pass → EDIT mode
            enforce: () => Promise.resolve({ok: true}),
            dirty: () => Promise.resolve(true),
            // Baseline (call 1) CLEAN; after enforce edits (call 2) FAILS → regression.
            repoHealth: () => {
                healthCall += 1
                return Promise.resolve(
                    healthCall === 1 ?
                        {ok: true, reason: 'static checks passed', output: ''}
                    :   {
                            ok: false,
                            reason: '`bun run lint` exited 1',
                            output: 'src/a.ts:3:1  error  Parsing error'
                        }
                )
            },
            discardEdits: () => {
                discarded++
                return Promise.resolve()
            },
            revert: () => {
                reverted++
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(discarded).toBe(1)
        expect(reverted).toBe(0) // the commit+differential+revert cycle never ran
        // Only the task snapshot committed — never an ENFORCE GUIDELINES commit.
        expect(commits).toEqual(['task: A (TASK_0006)'])
        // Trail names the REGRESSION and embeds the failing output (F8: was unexplainable
        // because only the exit code was recorded).
        const discardLine = trail.find(l => l.startsWith('enforce: edits discarded pre-commit'))
        expect(discardLine).toBeDefined()
        expect(discardLine).toContain('REGRESSED repo health')
        expect(discardLine).toContain('`bun run lint` exited 1')
        expect(discardLine).toContain('src/a.ts:3:1  error  Parsing error')
        // P1b: verdict line no longer claims a bare "clean" when edits exist.
        expect(trail).toContain('enforce(edit): clean — edits in tree')
    })
})

test('enforce edits are KEPT when repo was ALREADY failing before the pass (run-8 F8)', async () => {
    // F8: five enforce passes were discarded on `bun run lint` exited 2 — the linter was
    // already CRASHING before enforce touched anything, so the absolute guard threw away
    // good work for a fault it did not cause. The differential guard keeps such edits.
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const commits: string[] = []
        let discarded = 0
        const deps = makeDeps({
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            // Gate verify PASS (edit mode); differential re-verify after enforce PASS.
            verify: () => Promise.resolve({ok: true}),
            enforce: () => Promise.resolve({ok: true}),
            dirty: () => Promise.resolve(true),
            // FAILING both before (baseline) and after → not a regression, not enforce's fault.
            repoHealth: () =>
                Promise.resolve({
                    ok: false,
                    reason: '`bun run lint` exited 2',
                    output: 'Error: Cannot find module eslint-config\n    at require (...)'
                }),
            discardEdits: () => {
                discarded++
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(discarded).toBe(0) // NOT discarded — the failure pre-dates the pass
        // The edits are kept and committed as their own ENFORCE GUIDELINES snapshot.
        expect(commits).toEqual(['task: A (TASK_0006)', 'ENFORCE GUIDELINES: A (TASK_0006)'])
        const keptLine = trail.find(l => l.includes('ALREADY failing before'))
        expect(keptLine).toBeDefined()
        expect(keptLine).toContain('pre-existing, edits kept')
        expect(keptLine).toContain('`bun run lint` exited 2')
        // The captured crash output rides into the trail so F8 is explainable.
        expect(keptLine).toContain('Cannot find module eslint-config')
    })
})

test('enforce edits passing repo health commit + differential-guard as before', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const commits: string[] = []
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => Promise.resolve({ok: true}),
            enforce: () => Promise.resolve({ok: true}),
            dirty: () => Promise.resolve(true),
            repoHealth: () => Promise.resolve({ok: true, reason: 'static checks passed'})
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(commits).toEqual(['task: A (TASK_0006)', 'ENFORCE GUIDELINES: A (TASK_0006)'])
    })
})

test('enforce with no code edits skips the enforce commit AND the differential re-verify', async () => {
    // mx5 run 5 regression: enforce had nothing to do (no guideline files), yet the
    // "enforce commit" was never empty — the .pi-tasks gate-trail lines made it real —
    // so every task burned a full model re-verify of an UNCHANGED tree, and the 10
    // genuine defect reports those re-verifies produced were "reverted" into the void
    // (the revert dropped a bookkeeping-only commit) while the tasks stayed PASS.
    // A KNOWN-clean tree (dirty ran and said false) must skip commit, re-verify, revert.
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const commits: string[] = []
        let verifyCalls = 0
        let reverted = 0
        const deps = makeDeps({
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => {
                verifyCalls += 1
                // If the differential re-verify DID run it would FAIL (a deeper pass
                // finding a pre-existing bug) — the skip must keep that verdict from
                // ever being produced and discarded.
                return Promise.resolve(
                    verifyCalls === 1 ?
                        {ok: true}
                    :   {ok: false, reason: 'pre-existing bug found on the second look'}
                )
            },
            enforce: () => Promise.resolve({ok: true, reason: 'no guideline files'}),
            dirty: () => Promise.resolve(false),
            revert: () => {
                reverted++
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(verifyCalls).toBe(1) // gate verify only — no differential re-verify
        expect(reverted).toBe(0)
        expect(commits).toEqual(['task: A (TASK_0006)']) // no ENFORCE GUIDELINES commit
        expect(trail).toContain(
            'enforce(edit): no code edits — enforce commit and re-verify skipped'
        )
    })
})

test('enforce with real code edits still commits + differential-guards as before', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const commits: string[] = []
        let verifyCalls = 0
        let reverted = 0
        const deps = makeDeps({
            commit: (_c, m) => {
                commits.push(m)
                return Promise.resolve({committed: true})
            },
            verify: () => {
                verifyCalls += 1
                return Promise.resolve({ok: true})
            },
            enforce: () => Promise.resolve({ok: true}),
            dirty: () => Promise.resolve(true),
            repoHealth: () => Promise.resolve({ok: true, reason: 'static checks passed'}),
            revert: () => {
                reverted++
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(verifyCalls).toBe(2) // gate verify + differential re-verify
        expect(reverted).toBe(0)
        expect(commits).toEqual(['task: A (TASK_0006)', 'ENFORCE GUIDELINES: A (TASK_0006)'])
    })
})

test('enforce with a clean tree (no edits) runs only the baseline, not the after-check', async () => {
    // The differential guard captures ONE baseline health snapshot before the edit
    // pass; when the pass makes no edits (dirty === false) the after-check is skipped,
    // so repoHealth runs exactly once (the baseline), never twice.
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        let healthCalls = 0
        const deps = makeDeps({
            verify: () => Promise.resolve({ok: true}),
            enforce: () => Promise.resolve({ok: true}),
            dirty: () => Promise.resolve(false),
            repoHealth: () => {
                healthCalls++
                return Promise.resolve({ok: true, reason: '', output: ''})
            },
            commit: (_c, m) =>
                Promise.resolve(
                    m.startsWith('ENFORCE') ?
                        {committed: false, reason: 'nothing to commit'}
                    :   {committed: true}
                )
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(healthCalls).toBe(1) // baseline only; no after-check on a clean tree
    })
})

test("runGatesForTask: the recommend child's diagnosis rides into the AUTOFIX fixInstruction", async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
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
                    verifyCalls === 1 ? {ok: false, reason: 'suite fails'} : {ok: true}
                )
            },
            recommend: () =>
                Promise.resolve({
                    recommend: 'autofix',
                    rationale:
                        'listings.ts filters on users.is_banned but the JOIN aliases the table as u'
                })
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(fixInstructions).toHaveLength(1)
        // The re-run gets the FAIL reason AND the located cause.
        expect(fixInstructions[0]).toContain('suite fails')
        expect(fixInstructions[0]).toContain('DIAGNOSIS')
        expect(fixInstructions[0]).toContain('aliases the table as u')
    })
})

test('runGatesForTask: no recommend dep → fixInstruction stays the bare failure (no duplicate)', async () => {
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
                    verifyCalls === 1 ? {ok: false, reason: 'build exited 1'} : {ok: true}
                )
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        expect(fixInstructions).toHaveLength(1)
        expect(fixInstructions[0]).toBe('build exited 1')
    })
})

// ─── Frozen-blocked routing (mx5 run 12 / PROMPT 1 layer B) ──────────────────

test('frozen-blocked: lint-fix frozen-path rejection → no unattended AUTOFIX, no recommend research, durable debt, picker forced', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const {ctx} = handle
        const trail: string[] = []
        const debts: Array<{taskId: string; reason: string}> = []
        let runTaskCalls = 0
        let acceptDebts = 0
        const deps = makeDeps({
            runTask: () => {
                runTaskCalls++
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            record: (_c, _i, line) => {
                trail.push(line)
                return Promise.resolve()
            },
            verify: () =>
                Promise.resolve({ok: false, reason: 'repo health: `bun run lint` exited 1'}),
            lintFix: () =>
                Promise.resolve({
                    ok: false,
                    reason: "frozen-path: fix child modified spec-frozen path(s) (tsconfig.json) — reverted; the static findings need a fix that respects the spec's constraints"
                }),
            // The deterministic rejection already proved the contradiction — the
            // recommendation research must be skipped entirely.
            recommend: () => Promise.reject(new Error('recommend must not run')),
            recordFrozenBlockedDebt: (_c, taskId, reason) => {
                debts.push({taskId, reason})
                return Promise.resolve()
            },
            recordAcceptDebt: () => {
                acceptDebts++
                return Promise.resolve()
            }
        })
        handle.queueSelect(ACCEPT_LABEL)
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        // No unattended impl re-run: it is under the same freeze and cannot converge.
        expect(runTaskCalls).toBe(0)
        // One durable debt, static-class (repo health: prefix) with the contradiction named.
        expect(debts).toHaveLength(1)
        expect(debts[0].taskId).toBe('TASK_0006')
        expect(debts[0].reason).toMatch(/^repo health:/)
        expect(debts[0].reason).toContain('frozen-path:')
        // The ACCEPT branch must not double-enter the already-recorded defect.
        expect(acceptDebts).toBe(0)
        expect(
            trail.some(l => l.includes('cross-task') && l.includes('unattended AUTOFIX skipped'))
        ).toBe(true)
    })
})

test('frozen-blocked: picker dismissed → paused, debt still recorded (the contradiction is real regardless)', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const debts: string[] = []
        const deps = makeDeps({
            verify: () =>
                Promise.resolve({ok: false, reason: 'repo health: `bun run lint` exited 1'}),
            lintFix: () =>
                Promise.resolve({
                    ok: false,
                    reason: "frozen-path: static findings implicate spec-frozen path(s) (tsconfig.json) — did not converge (`bun run lint` exited 1); a fix under this task's constraints cannot converge"
                }),
            recommend: () => Promise.reject(new Error('recommend must not run')),
            recordFrozenBlockedDebt: (_c, _t, reason) => {
                debts.push(reason)
                return Promise.resolve()
            }
        })
        // No queueSelect → picker dismissed → paused.
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('paused')
        expect(debts).toHaveLength(1)
    })
})

test('frozen-blocked: an ordinary (non-frozen) lint-fix rejection still auto-AUTOFIXes as before', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        let runTaskCalls = 0
        let verifyCalls = 0
        let frozenDebts = 0
        const deps = makeDeps({
            runTask: () => {
                runTaskCalls++
                return Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false})
            },
            verify: () => {
                verifyCalls++
                return Promise.resolve(
                    verifyCalls <= 1 ?
                        {ok: false, reason: 'repo health: `bun run lint` exited 1'}
                    :   {ok: true}
                )
            },
            lintFix: () =>
                Promise.resolve({ok: false, reason: 'did not converge: `bun run lint` exited 1'}),
            recommend: () => Promise.resolve({recommend: 'autofix', rationale: 'fixable statics'}),
            recordFrozenBlockedDebt: () => {
                frozenDebts++
                return Promise.resolve()
            }
        })
        const r = await runGatesForTask(ctx, deps, baseParams({cwd: dir}))
        expect(r.kind).toBe('done')
        // The unattended AUTOFIX path stays intact for reasons without the prefix.
        expect(runTaskCalls).toBe(1)
        expect(frozenDebts).toBe(0)
    })
})
