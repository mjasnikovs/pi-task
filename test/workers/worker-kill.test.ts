/**
 * THE GUARD THAT MAKES THE KILL ROSTER TRUE.
 *
 * worker-kill.ts's own header lists the unlinked places one kill cause would
 * otherwise be named. Two of those links are types — `WorkerRestartReason` is
 * `(typeof RESTART_ORDER)[number]`, and every `WorkerFailureKind` must be a
 * `WorkerKillId` — so the compiler holds them. The rest are held here: that both
 * ladders cover exactly their declared order, that every id has a row, and that
 * each row's `resultField` names a real `RunWorkerResult` field.
 *
 * A missing link fails silently: the consumer that lacks an arm for a cause falls
 * through to `if (aborted)` and reports a kill as a user cancel.
 */
import {describe, expect, test} from 'bun:test'
import {
    CARRY_FORWARD_IDS,
    FAILURE_ORDER,
    RESTART_ORDER,
    WORKER_KILLS,
    workerKill,
    type WorkerKillId
} from '../../src/workers/worker-kill.js'
import {FAILURE_RULES, classifyWorkerFailure} from '../../src/workers/worker-failure.js'
import {RESTART_RULES, type RunWorkerResult} from '../../src/workers/pi-worker-core.js'

describe('the roster', () => {
    test('every id has exactly one row', () => {
        const ids = WORKER_KILLS.map(k => k.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test('every id either restarts or is reported — a row that does neither is dead', () => {
        for (const k of WORKER_KILLS) {
            expect(k.restartable || k.reported, k.id).toBe(true)
        }
    })

    test('a carried-forward cause is one whose partial output is real work', () => {
        // The rule, as a set: a cause whose partial output is real work. A loop kill
        // is the same call repeated and a leaked call is malformed protocol text, so
        // replaying either feeds the failure back to itself.
        expect([...CARRY_FORWARD_IDS].sort()).toEqual([
            'command-timeout',
            'connection-error',
            'stream-stall',
            'worker-timeout'
        ])
    })

    test("each row's resultField names a real RunWorkerResult field", () => {
        // pi-worker-core.ts imports worker-kill.ts, so the roster cannot import
        // `RunWorkerResult` back without a cycle. The link is checked here instead.
        const probe: RunWorkerResult = {
            text: '',
            exitCode: 0,
            stderr: '',
            aborted: false,
            sawOutput: false,
            waitMs: 0,
            workMs: 0,
            attempts: 1,
            totalWallMs: 0,
            restarts: [],
            salvagedFromDiscardedAttempt: false,
            groundingRetrievalCount: 0,
            leakedToolCall: undefined,
            loopHit: undefined,
            timedOut: undefined,
            stalled: undefined,
            commandTimedOut: undefined,
            streamStalled: undefined
        }
        for (const k of WORKER_KILLS) {
            if (k.resultField === null) continue
            expect(Object.hasOwn(probe, k.resultField), `${k.id} -> ${k.resultField}`).toBe(true)
        }
    })
})

describe('the two ladders, against the one roster', () => {
    test('the failure ladder is exactly FAILURE_ORDER, in order', () => {
        expect(FAILURE_RULES.map(r => r.id)).toEqual([...FAILURE_ORDER])
    })

    test('the restart ladder is exactly RESTART_ORDER, in order', () => {
        // A rule added out of order, or a roster id with no rule, silently changes
        // which hint a re-spawn is given.
        expect(RESTART_RULES.map(r => r.reason)).toEqual([...RESTART_ORDER])
    })

    test('every ordered id has a row, in both ladders', () => {
        for (const id of [...RESTART_ORDER, ...FAILURE_ORDER]) {
            expect(workerKill(id), id).toBeDefined()
        }
    })

    test('RESTART_ORDER names exactly the restartable causes', () => {
        expect([...RESTART_ORDER].sort()).toEqual(
            WORKER_KILLS.filter(k => k.restartable)
                .map(k => k.id)
                .sort() as never
        )
    })

    test('FAILURE_ORDER names exactly the reported causes', () => {
        expect([...FAILURE_ORDER].sort()).toEqual(
            WORKER_KILLS.filter(k => k.reported)
                .map(k => k.id)
                .sort() as never
        )
    })

    test('RESTART_ORDER keeps its LITERAL type — the widening this module exists to stop', () => {
        // `WorkerRestartReason` is `(typeof RESTART_ORDER)[number]`. Annotating the
        // array `readonly WorkerKillId[]` collapses that to the whole union, so
        // `noteRestart('aborted')` would compile for a cause the restart ladder has
        // no rule for. A compile-time property, written as a runtime one.
        type Restartable = (typeof RESTART_ORDER)[number]
        type NotRestartable = Exclude<WorkerKillId, Restartable>
        const notRestartable: NotRestartable[] = ['stalled', 'aborted', 'exit']
        expect(notRestartable.every(id => !RESTART_ORDER.includes(id as never))).toBe(true)
    })

    test('the two orders genuinely differ — this is not one ladder wearing two hats', () => {
        // Restart leads with `loop` (its hint names the offending call); failure
        // leads with `stalled` (the diagnosis most easily lost behind `aborted`).
        expect(RESTART_ORDER[0]).toBe('loop')
        expect(FAILURE_ORDER[0]).toBe('stalled')
    })
})

describe('the bug the roster exists to prevent', () => {
    /**
     * The property the whole roster exists for: a specific cause must never be
     * reported as the generic `aborted` that every kill path also sets.
     */
    const killed = (over: Record<string, unknown>): WorkerKillId | undefined =>
        classifyWorkerFailure({exitCode: 143, aborted: true, ...over})?.kind

    test('every specific cause outranks the aborted every kill path sets', () => {
        expect(killed({stalled: true})).toBe('stalled')
        expect(killed({commandTimedOut: {toolName: 'bash', timeoutMs: 1}})).toBe('command-timeout')
        expect(killed({streamStalled: {idleMs: 1}})).toBe('stream-stall')
        expect(killed({timedOut: true})).toBe('worker-timeout')
        expect(killed({loopHit: {call: {name: 'read'}, count: 5}})).toBe('loop')
        expect(killed({leakedToolCall: 'read(...)'})).toBe('leaked-tool-call')
    })

    test('a bare abort with no specific cause really is a cancel', () => {
        expect(killed({})).toBe('aborted')
    })
})
