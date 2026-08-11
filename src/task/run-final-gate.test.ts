/**
 * run-final-gate — the RUN-LEVEL gate stage, driven DIRECTLY (no loop, no task file,
 * no spawns). /task-auto's own tests still drive the same stage through runAutoLoop
 * end to end; these pin the seam itself: the three-way result contract the caller
 * turns into state changes, the picker's card set and order, the autofix bound, the
 * stranded-fix commits, and what reaches the durable debt ledger.
 */
import {expect, test} from 'bun:test'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {makeFakeCtx} from '../test-utils/fake-ctx.js'
import {runFinalGateStage, type FinalGateStageDeps} from './run-final-gate.js'
import {readAcceptDebts} from './accept-debt.js'
import {writeOwnedRequirements} from './requirements.js'
import {
    FINAL_ACCEPT_LABEL,
    FINAL_AUTOFIX_LABEL,
    FINAL_LEAVE_LABEL,
    MAX_FINAL_GATE_AUTOFIX
} from './final-gate-fix.js'
import {getConfig} from '../config/config.js'

const RUN = 'TASK_AUTO_0001'

/** The stage's params, with the two run-shaped facts fixed for every test. */
const params = (cwd: string, taskCount = 3) => ({
    cwd,
    runId: RUN,
    planText: '- [x] A\n- [x] B\n- [x] C',
    taskCount
})

/** Deps that commit successfully and capture the trail; override per test. */
function stageDeps(
    trail: string[],
    commits: string[],
    over: Partial<FinalGateStageDeps> = {}
): FinalGateStageDeps {
    return {
        commit: (_cwd, message) => {
            commits.push(message)
            return Promise.resolve({committed: true})
        },
        record: (_cwd, _id, line) => {
            trail.push(line)
            return Promise.resolve()
        },
        ...over
    }
}

// ─── The result contract (what the caller turns into state) ──────────────────

test('no finalGate dep → completes without running anything, info level', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const trail: string[] = []
        const res = await runFinalGateStage(ctx, stageDeps(trail, []), params(dir))
        expect(res.kind).toBe('completed')
        expect(res).toMatchObject({level: 'info', message: `${RUN} complete — all 3 tasks done.`})
        expect(trail).toEqual([])
        // Nothing is announced from inside the stage — the caller owns that.
        expect(captured.notifies).toEqual([])
    })
})

test('gate PASS → completed at info level, PASS trailed with the commands that ran', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const res = await runFinalGateStage(
            ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: true, reason: 'statics + `bun test` passed'})
            }),
            params(dir, 7)
        )
        expect(res).toEqual({
            kind: 'completed',
            level: 'info',
            message: `${RUN} complete — all 7 tasks done.`
        })
        expect(trail).toEqual(['final-gate: PASS — statics + `bun test` passed'])
    })
})

test('gate UNOBSERVED → completed at WARNING level, never trailed as a PASS', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const trail: string[] = []
        const note = 'UNOBSERVED — no integration command was discoverable here'
        const res = await runFinalGateStage(
            ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: true, reason: note, unobserved: note})
            }),
            params(dir)
        )
        expect(res.kind).toBe('completed')
        expect(res).toMatchObject({level: 'warning'})
        expect(res.message).toContain('WARNING: the final integration gate was UNOBSERVED')
        expect(trail.some(l => l.startsWith('final-gate: UNOBSERVED — '))).toBe(true)
        expect(trail.some(l => l.startsWith('final-gate: PASS'))).toBe(false)
        expect(captured.notifies.some(n => n.level === 'warning')).toBe(true)
        // Durable, so the NEXT run's gate re-surfaces it.
        const debts = await readAcceptDebts(dir)
        expect(debts).toHaveLength(1)
        expect(debts[0]!.origin).toBe('final-gate')
        expect(debts[0]!.taskId).toBe(RUN)
    })
})

test('FAIL + dismissed picker → failed, with the resume-shaped message', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        const res = await runFinalGateStage(
            ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: false, reason: '`bun test` exited 1'})
            }),
            params(dir)
        )
        expect(res.kind).toBe('failed')
        expect(res.message).toContain('finished all tasks but FAILED the final integration gate')
        expect(res.message).toContain('`bun test` exited 1')
        expect(trail).toContain('final-gate: left failed (user)')
    })
})

test('FAIL + ACCEPT → completed, the accept is trailed', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        handle.queueSelect(FINAL_ACCEPT_LABEL)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'})
            }),
            params(dir)
        )
        expect(res.kind).toBe('completed')
        expect(res).toMatchObject({level: 'info'})
        expect(trail).toContain('final-gate: FAIL accepted by user')
    })
})

// ─── The picker ──────────────────────────────────────────────────────────────

test('picker cards: Leave / Autofix / Accept, in that order, only while the bound allows', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        handle.queueSelect(FINAL_ACCEPT_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps([], [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () => Promise.resolve({ok: true, reason: 'fixed'})
            }),
            params(dir)
        )
        expect(handle.captured.selects[0]!.options.slice(0, 3)).toEqual([
            FINAL_LEAVE_LABEL,
            FINAL_AUTOFIX_LABEL,
            FINAL_ACCEPT_LABEL
        ])
    })
})

test('no finalGateFix dep → the autofix card is never offered', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        handle.queueSelect(FINAL_ACCEPT_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps([], [], {finalGate: () => Promise.resolve({ok: false, reason: 'boom'})}),
            params(dir)
        )
        expect(handle.captured.selects[0]!.options).not.toContain(FINAL_AUTOFIX_LABEL)
        expect(handle.captured.selects[0]!.options.slice(0, 2)).toEqual([
            FINAL_LEAVE_LABEL,
            FINAL_ACCEPT_LABEL
        ])
    })
})

test('aggregated FAIL: every ranked entry is trailed, not just the first', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const trail: string[] = []
        await runFinalGateStage(
            ctx,
            stageDeps(trail, [], {
                finalGate: () =>
                    Promise.resolve({
                        ok: false,
                        reason: 'ranked',
                        failures: ['boot: dead', '`bun test` exited 1', 'lint: 3 errors']
                    })
            }),
            params(dir)
        )
        expect(trail).toContain('final-gate: FAIL — 3 failures (ranked, most load-bearing first)')
        expect(trail).toContain('final-gate FAIL 1/3: boot: dead')
        expect(trail).toContain('final-gate FAIL 3/3: lint: 3 errors')
    })
})

// ─── The bounded autofix ─────────────────────────────────────────────────────

test('AUTOFIX converges → the fix is committed and the run completes', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        const commits: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, commits, {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () => Promise.resolve({ok: true, reason: 'gate green'})
            }),
            params(dir)
        )
        expect(res.kind).toBe('completed')
        expect(res).toMatchObject({level: 'info'})
        expect(commits).toEqual([`FINAL GATE AUTOFIX (${RUN})`])
        expect(trail).toContain(
            `final-gate: user chose AUTOFIX (attempt 1/${MAX_FINAL_GATE_AUTOFIX})`
        )
        expect(trail).toContain('final-gate: autofix converged — gate green')
    })
})

test('a converged autofix that observed nothing is UNOBSERVED, never a PASS', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () =>
                    Promise.resolve({
                        ok: true,
                        reason: 'green',
                        unobserved: 'UNOBSERVED — nothing dynamic ran'
                    })
            }),
            params(dir)
        )
        expect(res).toMatchObject({kind: 'completed', level: 'warning'})
        expect(trail.some(l => l.startsWith('final-gate: autofix ended UNOBSERVED'))).toBe(true)
        expect((await readAcceptDebts(dir))[0]!.origin).toBe('final-gate')
    })
})

test('the autofix card is WITHDRAWN after MAX_FINAL_GATE_AUTOFIX failed attempts', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        let attempts = 0
        // Always pick autofix while it is offered; the last picker must not offer it.
        for (let i = 0; i < MAX_FINAL_GATE_AUTOFIX + 2; i++) handle.queueSelect(FINAL_AUTOFIX_LABEL)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps([], [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'fail-0'}),
                finalGateFix: () => {
                    attempts += 1
                    return Promise.resolve({
                        ok: false,
                        reason: `attempt ${attempts}`,
                        gateReason: `fail-${attempts}`
                    })
                }
            }),
            params(dir)
        )
        expect(attempts).toBe(MAX_FINAL_GATE_AUTOFIX)
        const offers = handle.captured.selects.map(s => s.options.includes(FINAL_AUTOFIX_LABEL))
        expect(offers).toEqual([true, true, true, false])
        expect(res.kind).toBe('failed')
    })
})

test('free text typed at the picker rides into the fix seed as guidance', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        handle.queueSelect('✎ Type a different answer…')
        handle.queueInput('the port is already bound')
        let seed = ''
        await runFinalGateStage(
            handle.ctx,
            stageDeps([], [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'EADDRINUSE'}),
                finalGateFix: (_c, _d, failReason) => {
                    seed = failReason
                    return Promise.resolve({ok: true, reason: 'fixed'})
                }
            }),
            params(dir)
        )
        expect(seed).toBe('EADDRINUSE\n\nUser guidance: the port is already bound')
    })
})

// ─── Stranded sub-fixes ──────────────────────────────────────────────────────

test('LEAVE commits the sub-fixes a non-converging attempt stranded, and names them', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        const commits: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        handle.queueSelect(undefined)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, commits, {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () => Promise.resolve({ok: false, reason: 'no', gateReason: 'boom2'}),
                pendingChanges: () => Promise.resolve(['src/a.ts', 'src/b.ts'])
            }),
            params(dir)
        )
        expect(commits).toHaveLength(1)
        expect(commits[0]).toContain(RUN)
        expect(res.kind).toBe('failed')
        expect(res.message).toContain('2 fix-pass change(s) were committed separately')
        expect(
            trail.some(l => l.startsWith('final-gate: committed 2 stranded fix-pass change(s)'))
        ).toBe(true)
    })
})

test('a guard-REJECTED attempt whose edits survived is never committed', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        const commits: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        handle.queueSelect(FINAL_ACCEPT_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, commits, {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () =>
                    Promise.resolve({
                        ok: false,
                        reason: 'guard tripped',
                        gateReason: 'boom2',
                        guardTripped: true,
                        editsDiscarded: false
                    }),
                pendingChanges: () => Promise.resolve(['src/cheat.ts'])
            }),
            params(dir)
        )
        expect(commits).toEqual([])
        expect(trail.some(l => l.includes('NOT committing 1 working-tree change(s)'))).toBe(true)
    })
})

test('a commit that did not land is reported as UNCOMMITTED, never as a commit', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        handle.queueSelect(undefined)
        await runFinalGateStage(
            handle.ctx,
            {
                commit: () => Promise.resolve({committed: false, reason: 'unmerged index'}),
                record: (_c, _i, line) => {
                    trail.push(line)
                    return Promise.resolve()
                },
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () => Promise.resolve({ok: false, reason: 'no', gateReason: 'boom2'}),
                pendingChanges: () => Promise.resolve(['src/a.ts'])
            },
            params(dir)
        )
        expect(
            trail.some(
                l =>
                    l.includes('could NOT commit 1 stranded fix-pass change(s) (unmerged index)')
                    && l.includes('they remain UNCOMMITTED')
            )
        ).toBe(true)
        expect(trail.some(l => l.includes('[object Object]'))).toBe(false)
    })
})

test('a pendingChanges fault is inconclusive — nothing is claimed or committed', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const commits: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        handle.queueSelect(undefined)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps([], commits, {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () => Promise.resolve({ok: false, reason: 'no', gateReason: 'boom2'}),
                pendingChanges: () => Promise.reject(new Error('git unavailable'))
            }),
            params(dir)
        )
        expect(commits).toEqual([])
        expect(res.message).not.toContain('committed separately')
    })
})

// ─── The debt ledger, reached from one place ─────────────────────────────────

test('every debt this stage writes lands on the RUN id under origin final-gate', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps([], [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () =>
                    Promise.resolve({
                        ok: true,
                        reason: 'green',
                        // Two findings on one attempt: a dependent ignored write and a
                        // converged-but-unobserved gate.
                        ignoredWrites: ['.env'],
                        ignoredDependent: true,
                        unobserved: 'UNOBSERVED — rests on an ignored file'
                    })
            }),
            params(dir)
        )
        const debts = await readAcceptDebts(dir)
        expect(debts).toHaveLength(2)
        expect(debts.every(d => d.origin === 'final-gate')).toBe(true)
        expect(debts.every(d => d.taskId === RUN)).toBe(true)
    })
})

test('an INDEPENDENT ignored write is trailed and opens no debt', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                finalGateFix: () =>
                    Promise.resolve({
                        ok: true,
                        reason: 'green',
                        ignoredWrites: ['scratch.log'],
                        ignoredDependent: false
                    })
            }),
            params(dir)
        )
        expect(trail.some(l => l.includes('scratch.log'))).toBe(true)
        expect(await readAcceptDebts(dir)).toEqual([])
    })
})

// ─── Open-debt surfacing and re-derivation ───────────────────────────────────

test('open debts are surfaced on a PASS too — a run never completes silently', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const trail: string[] = []
        await runFinalGateStage(
            ctx,
            stageDeps(trail, [], {
                finalGate: () =>
                    Promise.resolve({
                        ok: true,
                        reason: 'ok',
                        openDebts: [
                            {taskId: 'TASK_0002', reason: 'flaky suite', origin: 'accepted'}
                        ]
                    })
            }),
            params(dir)
        )
        expect(trail.some(l => l.startsWith('defect STILL OPEN — TASK_0002'))).toBe(true)
        expect(
            captured.notifies.some(n => /1 recorded verify-FAIL defect\(s\) are STILL/.test(n.msg))
        ).toBe(true)
    })
})

test('a converged autofix RE-DERIVES the ledger against the FINAL tree, with proof', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        const staticOkSeen: boolean[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, [], {
                finalGate: () =>
                    Promise.resolve({
                        ok: false,
                        reason: 'boom',
                        openDebts: [{taskId: 'TASK_0002', reason: 'lint dirty', origin: 'accepted'}]
                    }),
                finalGateFix: () => Promise.resolve({ok: true, reason: 'green'}),
                recheckOpenDebts: (_cwd, staticOk) => {
                    staticOkSeen.push(staticOk)
                    return Promise.resolve({
                        openDebts: [],
                        trail: ['re-ran `bun run lint` → clean']
                    })
                }
            }),
            params(dir)
        )
        // The gate itself just passed the statics, so the proof is true here.
        expect(staticOkSeen).toEqual([true])
        expect(trail).toContain('defect re-check: re-ran `bun run lint` → clean')
        expect(trail.some(l => l.startsWith('defect RESOLVED — TASK_0002'))).toBe(true)
    })
})

test('a recheck fault is inconclusive — the pre-autofix report stands untouched', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        handle.queueSelect(FINAL_AUTOFIX_LABEL)
        await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, [], {
                finalGate: () =>
                    Promise.resolve({
                        ok: false,
                        reason: 'boom',
                        openDebts: [{taskId: 'TASK_0002', reason: 'lint dirty', origin: 'accepted'}]
                    }),
                finalGateFix: () => Promise.resolve({ok: true, reason: 'green'}),
                recheckOpenDebts: () => Promise.reject(new Error('ledger unreadable'))
            }),
            params(dir)
        )
        expect(trail.some(l => l.startsWith('defect STILL OPEN — TASK_0002'))).toBe(true)
        expect(trail.some(l => l.startsWith('defect RESOLVED'))).toBe(false)
        expect(trail.some(l => l.startsWith('defect re-check'))).toBe(false)
    })
})

// ─── Unfalsifiable checks, unclaimed obligations, YOLO ───────────────────────

test('an identical failure across tree-changing attempts is DEMOTED and carried as debt', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const trail: string[] = []
        for (let i = 0; i < MAX_FINAL_GATE_AUTOFIX; i++) handle.queueSelect(FINAL_AUTOFIX_LABEL)
        const res = await runFinalGateStage(
            handle.ctx,
            stageDeps(trail, [], {
                finalGate: () => Promise.resolve({ok: false, reason: 'boot probe: no listener'}),
                finalGateFix: () =>
                    Promise.resolve({
                        ok: false,
                        reason: 'no',
                        gateReason: 'boot probe: no listener',
                        gateFailures: ['boot probe: no listener']
                    }),
                pendingChanges: () => Promise.resolve(['src/a.ts'])
            }),
            params(dir)
        )
        expect(trail.some(l => l.startsWith('final-gate: check DEMOTED to UNOBSERVED'))).toBe(true)
        // Nothing falsifiable left ⇒ the run converges carrying the demotion as debt.
        // `unobservedNote` is NOT set on this door (it tracks a gate that observed
        // nothing AT ALL, not one check demoted out of several), so the completion
        // announcement stays at info — the warning about the demotion was already
        // notified inside the loop.
        expect(res).toMatchObject({kind: 'completed', level: 'info'})
        expect(trail.some(l => l.startsWith('final-gate: converged on all remaining checks'))).toBe(
            true
        )
        const debts = await readAcceptDebts(dir)
        expect(debts).toHaveLength(1)
        expect(debts[0]!.origin).toBe('final-gate')
    })
})

test('an owned requirement no task claimed is named at run end', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx, captured} = makeFakeCtx(dir)
        const trail: string[] = []
        await writeOwnedRequirements(dir, [
            {
                quote: 'Every protected route must 401 without a session',
                title: 'Wire auth middleware',
                pending: ['TASK_0004'],
                status: 'pending'
            }
        ] as never)
        await runFinalGateStage(
            ctx,
            stageDeps(trail, [], {finalGate: () => Promise.resolve({ok: true, reason: 'ok'})}),
            params(dir)
        )
        expect(trail.some(l => l.startsWith('owned requirement UNCLAIMED — '))).toBe(true)
        expect(
            captured.notifies.some(n =>
                /authoritative design requirement\(s\) ended the run/.test(n.msg)
            )
        ).toBe(true)
    })
})

test('YOLO autofixes while the card is offered, then LEAVES — never accepts', async () => {
    await withTmpTaskDir(async dir => {
        const handle = makeFakeCtx(dir)
        const cfg = getConfig()
        const prev = cfg.yoloMode
        cfg.yoloMode = true
        const trail: string[] = []
        let attempts = 0
        try {
            const res = await runFinalGateStage(
                handle.ctx,
                stageDeps(trail, [], {
                    finalGate: () => Promise.resolve({ok: false, reason: 'boom'}),
                    finalGateFix: () => {
                        attempts += 1
                        return Promise.resolve({
                            ok: false,
                            reason: 'no',
                            gateReason: `boom-${attempts}`
                        })
                    }
                }),
                params(dir)
            )
            expect(res.kind).toBe('failed')
            expect(attempts).toBe(MAX_FINAL_GATE_AUTOFIX)
            // Nobody was ever asked.
            expect(handle.captured.selects).toEqual([])
            expect(
                trail.some(l =>
                    l.startsWith('final-gate: left failed — autofix budget spent, nobody to ask')
                )
            ).toBe(true)
        } finally {
            cfg.yoloMode = prev
        }
    })
})

// ─── Best-effort recording ───────────────────────────────────────────────────

test('a record() fault never breaks the gate', async () => {
    await withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const res = await runFinalGateStage(
            ctx,
            {
                commit: () => Promise.resolve({committed: true}),
                record: () => Promise.reject(new Error('disk full')),
                finalGate: () => Promise.resolve({ok: true, reason: 'ok'})
            },
            params(dir)
        )
        expect(res.kind).toBe('completed')
    })
})
