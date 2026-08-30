/**
 * The ROSTER of ways a worker child can die, and what each one implies.
 *
 * WHY IT EXISTS. Without it, one kill cause is named in six unlinked places: a
 * `RunWorkerInput` guard option, a `RunWorkerResult` field, the
 * `WorkerRestartReason` union, a `RESTART_RULES` row, the carry-forward set, and a
 * `FAILURE_RULES` row. Adding a cause is six coordinated edits, and most of them
 * still compile if one is skipped — so the new cause simply does not exist on
 * whichever path was missed. `worker-failure.ts` closes the READER side of that;
 * this closes the AUTHOR side.
 *
 * WHAT IS AND IS NOT UNIFIED. The roster is one table. The two ORDERINGS stay
 * two, because they genuinely disagree and each says so in its own prose: the
 * restart ladder puts `loop` first (its hint is the most specific thing to tell a
 * re-spawn), and the failure ladder puts `stalled` first (the diagnosis most easily
 * lost behind the `aborted` every kill path sets). Folding two precedences into one
 * row type would need an escape hatch per row. What the orderings gain here is that
 * neither can name a cause with no row, nor silently omit one.
 *
 * Not every cause appears in both ladders, and that asymmetry is real. Six of the
 * nine are `restartable` and those six are exactly RESTART_ORDER; eight are
 * `reported` and those eight are exactly FAILURE_ORDER. `connection-error` is the
 * one that restarts without ever being reported as a kill — it reaches the caller
 * as a `modelError`. `stalled`, `aborted` and `exit` end an attempt outright, and
 * no hint would help.
 */

/** Every way a worker attempt can end other than by answering. */
export type WorkerKillId =
    | 'stalled'
    | 'command-timeout'
    | 'stream-stall'
    | 'worker-timeout'
    | 'connection-error'
    | 'loop'
    | 'leaked-tool-call'
    | 'aborted'
    | 'exit'

export interface WorkerKill {
    id: WorkerKillId
    /**
     * The `RunWorkerResult` field that reports this cause on the FINAL attempt,
     * or null when the cause never reaches the result under its own name
     * (`connection-error` arrives as `modelError`; `aborted` and `exit` are the
     * generic fields every kill path also sets).
     *
     * Null for three rows: `connection-error`, `aborted` and `exit`. A string rather
     * than `keyof RunWorkerResult` so this module stays out of pi-worker-core's
     * import graph; worker-kill.test.ts checks every non-null one against a real
     * result object.
     */
    resultField: string | null
    /**
     * Is a killed attempt's partial output worth carrying into the next one?
     *
     * True for exactly four: a clock kill, a hung tool, an idle stream and a dropped
     * socket all discard work the model genuinely did. A loop kill and a leaked tool
     * call do not — the first is by definition the same call repeated, the second is
     * malformed protocol text, and replaying either would feed the failure back to
     * itself.
     */
    carryForward: boolean
    /** Does the restart ladder have a rule for this cause? */
    restartable: boolean
    /** Does this cause reach a consumer as a `WorkerFailure`? */
    reported: boolean
}

export const WORKER_KILLS: readonly WorkerKill[] = [
    {
        id: 'stalled',
        resultField: 'stalled',
        carryForward: false,
        restartable: false,
        reported: true
    },
    {
        id: 'command-timeout',
        resultField: 'commandTimedOut',
        carryForward: true,
        restartable: true,
        reported: true
    },
    {
        id: 'stream-stall',
        resultField: 'streamStalled',
        carryForward: true,
        restartable: true,
        reported: true
    },
    {
        id: 'worker-timeout',
        resultField: 'timedOut',
        carryForward: true,
        restartable: true,
        reported: true
    },
    {
        id: 'connection-error',
        resultField: null,
        carryForward: true,
        restartable: true,
        reported: false
    },
    {id: 'loop', resultField: 'loopHit', carryForward: false, restartable: true, reported: true},
    {
        id: 'leaked-tool-call',
        resultField: 'leakedToolCall',
        carryForward: false,
        restartable: true,
        reported: true
    },
    {id: 'aborted', resultField: null, carryForward: false, restartable: false, reported: true},
    {id: 'exit', resultField: null, carryForward: false, restartable: false, reported: true}
]

/** Look one cause up. `undefined` only for an id with no row, which the suite forbids. */
export function workerKill(id: WorkerKillId): WorkerKill | undefined {
    return WORKER_KILLS.find(k => k.id === id)
}

/**
 * The restart ladder's precedence, as ids. `RESTART_RULES` must be exactly this,
 * in this order.
 *
 * `loop` leads: its hint names the offending call, which is the most useful thing
 * to tell a re-spawn. The two watchdogs come before the wall clock because each
 * is the narrower diagnosis, and they cannot be confused with it — a watchdog
 * kill leaves the worker's own timeout flag false.
 */
export const RESTART_ORDER = [
    'loop',
    'command-timeout',
    'stream-stall',
    'worker-timeout',
    'connection-error',
    'leaked-tool-call'
    // `as const satisfies`, not an annotation: `WorkerRestartReason` is
    // `(typeof RESTART_ORDER)[number]`, and a `readonly WorkerKillId[]`
    // annotation collapses that to the whole `WorkerKillId` union — which would
    // let `noteRestart('aborted')` compile for a cause the restart ladder has no
    // rule for. `satisfies` keeps the membership check without the widening.
] as const satisfies readonly WorkerKillId[]

/**
 * The failure ladder's precedence, as ids. `FAILURE_RULES` must be exactly this,
 * in this order.
 *
 * DIFFERENT from `RESTART_ORDER`, deliberately. Every kill path also sets
 * `aborted` and a non-zero exit, so the specific causes must all be matched
 * before the two generic ones or a dead backend is reported as "you cancelled".
 * `stalled` leads because it is both the most specific diagnosis and the one most
 * easily lost.
 */
export const FAILURE_ORDER = [
    'stalled',
    'command-timeout',
    'stream-stall',
    'worker-timeout',
    'loop',
    'leaked-tool-call',
    'aborted',
    'exit'
] as const satisfies readonly WorkerKillId[]

/** The causes whose partial output is worth keeping. Derived, never hand-kept. */
export const CARRY_FORWARD_IDS: ReadonlySet<WorkerKillId> = new Set(
    WORKER_KILLS.filter(k => k.carryForward).map(k => k.id)
)
