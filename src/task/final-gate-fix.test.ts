/**
 * final-gate-fix tests — the bounded fix pass for a final-integration-gate FAIL.
 * The runner is exercised with injected fakes (child/gate/discovery), so every
 * contract outcome — converge, non-converge, self-blocked, child crash, the
 * command-shrink cheat guard, and cancel propagation — is deterministic.
 */
import {describe, expect, test} from 'bun:test'
import {
    FINAL_FIX_TOOLS,
    FINAL_ACCEPT_LABEL,
    FINAL_AUTOFIX_LABEL,
    FINAL_LEAVE_LABEL,
    buildFinalFixPrompt,
    classifyFinalGateAnswer,
    extractFailingCommand,
    parseFinalFixMarker,
    runFinalGateAutofix,
    type FinalFixDeps
} from './final-gate-fix.js'

describe('classifyFinalGateAnswer', () => {
    test('dismissal and empty stay "leave" (the pre-autofix default)', () => {
        expect(classifyFinalGateAnswer(undefined)).toEqual({action: 'leave'})
        expect(classifyFinalGateAnswer('   ')).toEqual({action: 'leave'})
    })

    test('value tokens and labels map to their actions', () => {
        expect(classifyFinalGateAnswer('fail')).toEqual({action: 'leave'})
        expect(classifyFinalGateAnswer(FINAL_LEAVE_LABEL)).toEqual({action: 'leave'})
        expect(classifyFinalGateAnswer('accept')).toEqual({action: 'accept'})
        expect(classifyFinalGateAnswer(FINAL_ACCEPT_LABEL)).toEqual({action: 'accept'})
        expect(classifyFinalGateAnswer('autofix')).toEqual({action: 'autofix'})
        expect(classifyFinalGateAnswer(FINAL_AUTOFIX_LABEL)).toEqual({action: 'autofix'})
    })

    test('free text becomes autofix guidance', () => {
        expect(classifyFinalGateAnswer('the glob picks up the e2e spec')).toEqual({
            action: 'autofix',
            guidance: 'the glob picks up the e2e spec'
        })
    })
})

describe('extractFailingCommand', () => {
    test('integration-command reason', () => {
        expect(extractFailingCommand('`bun run test` exited 1 — 2 fail')).toBe('bun run test')
    })

    test('static-check reason', () => {
        expect(extractFailingCommand('static checks: `make lint` exited 2')).toBe('make lint')
    })

    test('unparseable reason → null', () => {
        expect(extractFailingCommand('something went wrong')).toBeNull()
    })
})

describe('buildFinalFixPrompt', () => {
    test('seeds the exact failure and states the hard constraints', () => {
        const p = buildFinalFixPrompt('`bun run test` exited 1 — spec.ts: describe error')
        expect(p).toContain('`bun run test` exited 1 — spec.ts: describe error')
        expect(p).toContain('Do NOT delete, skip, disable, or weaken tests')
        expect(p).toContain('Do NOT remove or rename')
        expect(p).toContain('Do NOT run git commands that mutate state')
        expect(p).toContain('FINAL-GATE-FIX: DONE')
        expect(p).toContain('FINAL-GATE-FIX: BLOCKED')
    })
})

describe('parseFinalFixMarker', () => {
    test('DONE and BLOCKED are parsed, last marker wins', () => {
        expect(parseFinalFixMarker('… FINAL-GATE-FIX: DONE')).toEqual({
            blocked: false,
            note: undefined
        })
        expect(parseFinalFixMarker('FINAL-GATE-FIX: BLOCKED cannot reach the db')).toEqual({
            blocked: true,
            note: 'cannot reach the db'
        })
        expect(
            parseFinalFixMarker('FINAL-GATE-FIX: BLOCKED early\n…retry…\nFINAL-GATE-FIX: DONE')
                .blocked
        ).toBe(false)
    })

    test('no marker → not blocked (the gate re-run is the arbiter anyway)', () => {
        expect(parseFinalFixMarker('I edited some files.').blocked).toBe(false)
    })

    test('BLOCKED with no note gets a placeholder', () => {
        expect(parseFinalFixMarker('FINAL-GATE-FIX: BLOCKED').note).toBe('no reason given')
    })
})

describe('runFinalGateAutofix', () => {
    const baseDeps = (over: Partial<FinalFixDeps>): FinalFixDeps => ({
        cwd: '/tmp/x',
        failReason: '`bun run test` exited 1',
        runChild: () => Promise.resolve('FINAL-GATE-FIX: DONE'),
        gate: () => Promise.resolve({ok: true, reason: 'statics + `bun run test` passed'}),
        discoverLabels: () => ['bun run lint', 'bun run test'],
        ...over
    })

    test('child fixes, gate re-runs green → ok with the gate reason', async () => {
        let childTools = ''
        let gateRuns = 0
        const r = await runFinalGateAutofix(
            baseDeps({
                runChild: tools => {
                    childTools = tools
                    return Promise.resolve('done. FINAL-GATE-FIX: DONE')
                },
                gate: () => {
                    gateRuns++
                    return Promise.resolve({ok: true, reason: 'statics + `bun run test` passed'})
                }
            })
        )
        expect(r.ok).toBe(true)
        expect(r.reason).toContain('passed')
        expect(childTools).toBe(FINAL_FIX_TOOLS)
        expect(gateRuns).toBe(1)
    })

    test('gate still fails → not ok, fresh gate reason carried for the next round', async () => {
        const r = await runFinalGateAutofix(
            baseDeps({
                gate: () => Promise.resolve({ok: false, reason: '`bun run test` exited 1 — still'})
            })
        )
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('did not converge')
        expect(r.gateReason).toBe('`bun run test` exited 1 — still')
    })

    test('SHRINK GUARD: a discovered command vanishing → edits discarded, gate never re-run', async () => {
        let discarded = false
        let gateRuns = 0
        const labels = [['bun run lint', 'bun run test'], ['bun run lint']]
        const r = await runFinalGateAutofix(
            baseDeps({
                discoverLabels: () => labels.shift() ?? [],
                discard: () => {
                    discarded = true
                    return Promise.resolve()
                },
                gate: () => {
                    gateRuns++
                    return Promise.resolve({ok: true, reason: 'vacuously green'})
                }
            })
        )
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('bun run test')
        expect(r.reason).toContain('discarded')
        expect(discarded).toBe(true)
        expect(gateRuns).toBe(0)
    })

    test('shrink guard without a discard dep still rejects, says edits were left', async () => {
        const labels = [['bun run test'], []]
        const r = await runFinalGateAutofix(baseDeps({discoverLabels: () => labels.shift() ?? []}))
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('left in the tree')
    })

    test('a NEW command appearing does not trip the guard', async () => {
        const labels = [['bun run test'], ['bun run test', 'bun run build']]
        const r = await runFinalGateAutofix(baseDeps({discoverLabels: () => labels.shift() ?? []}))
        expect(r.ok).toBe(true)
    })

    test('self-declared BLOCKED skips the gate re-run', async () => {
        let gateRuns = 0
        const r = await runFinalGateAutofix(
            baseDeps({
                runChild: () => Promise.resolve('FINAL-GATE-FIX: BLOCKED db unreachable'),
                gate: () => {
                    gateRuns++
                    return Promise.resolve({ok: true, reason: ''})
                }
            })
        )
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('db unreachable')
        expect(gateRuns).toBe(0)
    })

    test('child crash → not ok with the cause; a user cancel propagates', async () => {
        const r = await runFinalGateAutofix(
            baseDeps({runChild: () => Promise.reject(new Error('model server unreachable'))})
        )
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('model server unreachable')

        await expect(
            runFinalGateAutofix(
                baseDeps({runChild: () => Promise.reject(new Error('__user_cancelled__'))})
            )
        ).rejects.toThrow('__user_cancelled__')
    })
})

// ─── Write-guard stack (mx5 run 11: the unguarded final-fix child) ───────────

describe('runFinalGateAutofix — write-guard stack', () => {
    const clean = {modified: [], deleted: [], added: []}
    const baseDeps = (over: Partial<FinalFixDeps>): FinalFixDeps => ({
        cwd: '/tmp/x',
        failReason: '`bun run test` exited 1',
        runChild: () => Promise.resolve('FINAL-GATE-FIX: DONE'),
        gate: () => Promise.resolve({ok: true, reason: 'gate green'}),
        discoverLabels: () => ['bun run test'],
        ...over
    })

    test('run-11 shape: a tracked-file deletion rejects the attempt and discards', async () => {
        let discarded = false
        let gateRuns = 0
        const r = await runFinalGateAutofix(
            baseDeps({
                treeChanges: () =>
                    Promise.resolve({
                        modified: ['src/client/main.tsx'],
                        deleted: ['src/client/pages/admin.tsx'],
                        added: []
                    }),
                discard: () => {
                    discarded = true
                    return Promise.resolve()
                },
                gate: () => {
                    gateRuns++
                    return Promise.resolve({ok: true, reason: 'never'})
                }
            })
        )
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('DELETED tracked file(s) (src/client/pages/admin.tsx)')
        expect(r.reason).toContain('discarded')
        expect(discarded).toBe(true)
        expect(gateRuns).toBe(0) // rejected before the (expensive) gate re-run
    })

    test('a relocation (delete + same-name add) passes the deletion guard', async () => {
        const r = await runFinalGateAutofix(
            baseDeps({
                treeChanges: () =>
                    Promise.resolve({
                        modified: [],
                        deleted: ['src/app.spec.ts'],
                        added: ['e2e/app.spec.ts']
                    })
            })
        )
        expect(r.ok).toBe(true)
    })

    test('frozen-path revert runs BEFORE the deletion guard (a restored frozen delete does not reject)', async () => {
        const calls: string[] = []
        let post = false
        const r = await runFinalGateAutofix(
            baseDeps({
                frozenPaths: () => {
                    calls.push('frozenPaths')
                    return Promise.resolve(['src/server/index.ts'])
                },
                revertFrozen: paths => {
                    calls.push(`revert:${paths.join(',')}`)
                    post = true // the revert restores the frozen file
                    return Promise.resolve(['src/server/index.ts'])
                },
                treeChanges: () => {
                    calls.push('treeChanges')
                    return Promise.resolve(
                        post ? clean : {modified: [], deleted: ['src/server/index.ts'], added: []}
                    )
                },
                log: msg => calls.push(`log:${msg.slice(0, 30)}`)
            })
        )
        expect(r.ok).toBe(true)
        expect(calls.filter(c => c.startsWith('revert:'))).toEqual(['revert:src/server/index.ts'])
        expect(calls.some(c => c.startsWith('log:final-fix FROZEN-PATH GUARD'))).toBe(true)
    })

    test('a probe-gaming finding in the added lines rejects the attempt and discards', async () => {
        let discarded = false
        const r = await runFinalGateAutofix(
            baseDeps({
                treeChanges: () => Promise.resolve(clean),
                probeScan: () =>
                    Promise.resolve([
                        'src/routes.ts: // Return 401 so the verification test passes'
                    ]),
                discard: () => {
                    discarded = true
                    return Promise.resolve()
                }
            })
        )
        expect(r.ok).toBe(false)
        expect(r.reason).toContain('CHECK-GAMING')
        expect(r.reason).toContain('Return 401 so the verification test passes')
        expect(discarded).toBe(true)
    })

    test('clean pass: no guard fires, gate arbitrates as before', async () => {
        let gateRuns = 0
        const r = await runFinalGateAutofix(
            baseDeps({
                treeChanges: () => Promise.resolve(clean),
                frozenPaths: () => Promise.resolve([]),
                revertFrozen: () => Promise.resolve([]),
                probeScan: () => Promise.resolve([]),
                gate: () => {
                    gateRuns++
                    return Promise.resolve({ok: true, reason: 'gate green'})
                }
            })
        )
        expect(r.ok).toBe(true)
        expect(gateRuns).toBe(1)
    })

    test('guards absent (older wiring / tests) → previous behavior unchanged', async () => {
        const r = await runFinalGateAutofix(baseDeps({}))
        expect(r.ok).toBe(true)
    })

    test('the prompt carries the deletion hard constraint (belt on the mechanical guard)', () => {
        const p = buildFinalFixPrompt('`bun run test` exited 1')
        expect(p).toContain('Do NOT delete tracked files')
        expect(p).toContain('legitimate relocation keeps the file')
    })
})
