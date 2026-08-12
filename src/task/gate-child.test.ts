import {test, expect, describe} from 'bun:test'
import {
    makeGateChild,
    GATE_CHILD_KINDS,
    type GateChildDeps,
    type GateChildKind
} from './gate-child.js'
import type {RunWorkerResult} from '../workers/pi-worker-core.js'
import type {ReconcileResult, GitStateSnapshot} from './git-state-guard.js'

/**
 * None of this was reachable before. The runner lived inside buildGateDeps'
 * ~700-line closure, which no test calls, so the git-state-guard wiring — the
 * mechanism that discards a verify verdict computed on a tree the child mutated
 * (mx5 run 6) — could only be observed indirectly through a fake `mutationCheck`
 * one layer up. `runWorker` and the git helpers are injected now.
 */

const workerResult = (over: Partial<RunWorkerResult> = {}): RunWorkerResult =>
    ({
        text: 'VERDICT: PASS',
        exitCode: 0,
        stderr: '',
        aborted: false,
        waitMs: 1,
        workMs: 1,
        attempts: 1,
        totalWallMs: 2,
        restarts: [],
        sawOutput: true,
        salvagedFromDiscardedAttempt: false,
        groundingRetrievalCount: 0,
        ...over
    }) as RunWorkerResult

const clean: ReconcileResult = {mutated: false, verdictTainted: false, actions: []}

function harness(over: Partial<GateChildDeps> = {}): {
    deps: GateChildDeps
    log: string[]
    notices: string[]
    order: string[]
} {
    const log: string[] = []
    const notices: string[] = []
    const order: string[] = []
    const deps: GateChildDeps = {
        ctx: {
            ui: {
                notify: (m: string) => {
                    notices.push(m)
                }
            }
        } as unknown as GateChildDeps['ctx'],
        cwd: '/repo',
        taskTitle: 'Add auth routes',
        kind: 'verify',
        logPath: '/repo/.pi-tasks/verify-debug.log',
        commandTimeoutMs: 900_000,
        streamInactivityMs: 120_000,
        parentContextWindow: 200_000,
        runWorker: () => {
            order.push('worker')
            return Promise.resolve(workerResult())
        },
        makeDebugAppender: () => line => log.push(line),
        startAutoLoader: () => () => order.push('loader-stopped'),
        captureGitState: () => {
            order.push('capture')
            return Promise.resolve({} as GitStateSnapshot)
        },
        reconcileGitState: () => {
            order.push('reconcile')
            return Promise.resolve(clean)
        },
        describeTreeChanges: () => Promise.resolve('2 files changed'),
        resolveContextUsage: s => s,
        truncateToolResult: t => t,
        widget: {},
        ...over
    }
    return {deps, log, notices, order}
}

describe('GATE_CHILD_KINDS', () => {
    test('only the READ-ONLY children are git-guarded', () => {
        // lint-fix, final-fix and enforce EDIT — guarding them would revert the
        // work they exist to do. They carry their own revert guards.
        expect(GATE_CHILD_KINDS.verify.guarded).toBe(true)
        expect(GATE_CHILD_KINDS.recommend.guarded).toBe(true)
        for (const k of ['lint-fix', 'final-fix', 'enforce'] as const) {
            expect(GATE_CHILD_KINDS[k].guarded).toBe(false)
        }
    })

    test('every kind decides all four questions', () => {
        for (const k of Object.keys(GATE_CHILD_KINDS) as GateChildKind[]) {
            const row = GATE_CHILD_KINDS[k]
            expect(typeof row.guarded).toBe('boolean')
            expect(typeof row.logToolResults).toBe('boolean')
            expect(row.step.length).toBeGreaterThan(0)
            expect(row.okMarker.length).toBeGreaterThan(0)
        }
    })
})

test('a clean run logs start and end and returns the child text', async () => {
    const {deps, log} = harness()
    expect(await makeGateChild(deps)('read', 'check it')).toBe('VERDICT: PASS')
    expect(log[0]).toBe('=== verify start: Add auth routes ===')
    expect(log.at(-1)).toBe('=== verify end: ok ===')
})

test('enforce writes its OWN end marker, and is not guarded', async () => {
    const {deps, log, order} = harness({kind: 'enforce', logPath: '/repo/.pi-tasks/enforce.log'})
    await makeGateChild(deps)('read,edit', 'enforce it')
    expect(log.some(l => l.includes('enforce end: verdict captured'))).toBe(true)
    // Editing is this pass's job, so the guard would revert its work.
    expect(order).not.toContain('capture')
})

test('enforce now logs its tree changes too — it is a WRITE-capable child', () => {
    // Deliberate consequence of the capability rule. The old inline enforce copy
    // had no tree-change block at all, so a read,edit child rewrote files with no
    // record of what it touched — the same invisibility the rule was written for
    // after the final-fix child's `rm` (mx5 run 11). Exempting enforce by KIND
    // would reintroduce exactly the per-phase exception the rule replaces.
    expect(GATE_CHILD_KINDS.enforce.guarded).toBe(false)
})

describe('the git-state guard', () => {
    test('captures BEFORE the worker and reconciles AFTER it', async () => {
        const {deps, order} = harness()
        await makeGateChild(deps)('read', 'check it')
        expect(order.slice(0, 3)).toEqual(['capture', 'worker', 'reconcile'])
    })

    test('a THROWING child still reconciles — a crash must not skip the restore', async () => {
        const {deps, order} = harness({
            runWorker: () => {
                order.push('worker')
                return Promise.reject(new Error('spawn exploded'))
            }
        })
        await expect(makeGateChild(deps)('read', 'check it')).rejects.toThrow('spawn exploded')
        expect(order).toEqual(['capture', 'worker', 'reconcile', 'loader-stopped'])
    })

    test('the restore runs BEFORE the failure verdict is acted on', async () => {
        const {deps, order} = harness({
            runWorker: () => {
                order.push('worker')
                return Promise.resolve(workerResult({exitCode: 2}))
            }
        })
        await expect(makeGateChild(deps)('read', 'x')).rejects.toThrow('exited 2')
        expect(order.indexOf('reconcile')).toBeLessThan(order.indexOf('loader-stopped'))
    })

    test('a TAINTING mutation is trailed and notified', async () => {
        const {deps, log, notices} = harness({
            reconcileGitState: () =>
                Promise.resolve({
                    mutated: true,
                    verdictTainted: true,
                    actions: ['popped a stash the child pushed']
                })
        })
        await makeGateChild(deps)('read', 'x')
        expect(log.some(l => l.includes('mutated graded state (verdict discarded)'))).toBe(true)
        expect(notices.some(n => n.includes('mutated repo state'))).toBe(true)
    })

    test('BENIGN cleanup is trailed but never notified — the verdict stands', async () => {
        // mx5 run 9: 7 of 9 guard firings were pure test-results churn. Notifying
        // on those trains the user to ignore the warning that matters.
        const {deps, log, notices} = harness({
            reconcileGitState: () =>
                Promise.resolve({
                    mutated: true,
                    verdictTainted: false,
                    actions: ['removed test-results/']
                })
        })
        await makeGateChild(deps)('read', 'x')
        expect(
            log.some(l => l.includes('cleaned child test-runner artifacts (verdict kept)'))
        ).toBe(true)
        expect(notices).toEqual([])
    })

    test('the reconcile is handed back so the caller can discard the verdict', async () => {
        const seen: ReconcileResult[] = []
        const tainted: ReconcileResult = {mutated: true, verdictTainted: true, actions: ['a']}
        const {deps} = harness({
            reconcileGitState: () => Promise.resolve(tainted),
            onReconcile: r => seen.push(r)
        })
        await makeGateChild(deps)('read', 'x')
        expect(seen).toEqual([tainted])
    })
})

describe('tree-change capture keys on TOOLS, not on kind', () => {
    // mx5 run 11: the final-fix child's `rm` ran invisibly. Deciding by capability
    // rather than by phase is what stops a future write-capable kind repeating it.
    for (const tools of ['read,edit', 'read,bash', 'read,write']) {
        test(`${tools} logs its tree changes`, async () => {
            const {deps, log} = harness()
            await makeGateChild(deps)(tools, 'x')
            expect(log.some(l => l.includes('tree changes: 2 files changed'))).toBe(true)
        })
    }

    test('a read-only child logs none', async () => {
        const {deps, log} = harness()
        await makeGateChild(deps)('read,grep', 'x')
        expect(log.some(l => l.includes('tree changes'))).toBe(false)
    })
})

test('a surviving loop WARNS but never blocks — the verdict gate alone decides', async () => {
    const {deps, log, notices} = harness({
        runWorker: () =>
            Promise.resolve(
                workerResult({
                    loopHit: {call: {name: 'read', args: {}}, count: 3, windowSize: 5}
                } as Partial<RunWorkerResult>)
            )
    })
    expect(await makeGateChild(deps)('read', 'x')).toBe('VERDICT: PASS')
    expect(log.some(l => l.includes('LOOP WARNING'))).toBe(true)
    expect(notices.some(n => n.includes('looped past the nudges'))).toBe(true)
})

test('the loader is suppressed when the caller already renders one', async () => {
    // Two loaders on one widget key only fight each other; the verify gate spans
    // its child with its own.
    const {deps, order} = harness({
        loader: false,
        startAutoLoader: () => () => order.push('loader-stopped')
    })
    await makeGateChild(deps)('read', 'x')
    expect(order).not.toContain('loader-stopped')
})

test('tool results are logged for verify and withheld for enforce', async () => {
    const withResult = (kind: GateChildKind) => {
        const {deps, log} = harness({
            kind,
            runWorker: input => {
                input.onToolResult?.({name: 'bash', isError: false, text: 'ok', toolCallId: '1'})
                return Promise.resolve(workerResult())
            }
        })
        return makeGateChild(deps)('read', 'x').then(() => log)
    }
    expect((await withResult('verify')).some(l => l.startsWith('↳ bash'))).toBe(true)
    expect((await withResult('enforce')).some(l => l.startsWith('↳ bash'))).toBe(false)
})
