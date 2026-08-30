/**
 * run-end — how a single /task run ENDED, named once.
 *
 * `TaskRunner.run` returns this, so a caller never has to re-derive the ending by
 * re-reading the task file's front matter and narrowing it to a boolean. Reading
 * the file back cannot tell a user cancel from a fault: `/task-cancel` writes
 * `cancelled`, and anything that only asks "is the state completed?" then treats
 * that stop as a failure and overwrites it.
 *
 * The file is still written — it is what a RESUME reads. It is just not the
 * channel this process uses to talk to itself.
 */

/** Why a run stopped. Exactly one of these is true of any finished run. */
export type RunEnd =
    /** Every phase ran and the spec was delivered. */
    | {kind: 'completed'}
    /** The user cancelled — via /task-cancel, ESC, or an aborted signal. */
    | {kind: 'cancelled'}
    /** A phase threw. `reason` is `FailureClass.reason`, already trimmed. */
    | {kind: 'failed'; reason?: string}
    /** The implementation turn was interrupted and left resumable. */
    | {kind: 'interrupted'}
    /** No fresh session could be started, so nothing ran at all. */
    | {kind: 'no-session'}

export type RunEndKind = RunEnd['kind']

/**
 * What a command does about each ending.
 *
 * The POLICY is shared by /task's loop (orchestrator.ts) and /task-auto's
 * (auto-orchestrator.ts). The WORDING stays per-command — /task says "resume with
 * /task-resume" where /task-auto says "/task-auto-resume".
 */
export interface RunEndPolicy {
    /** Mark the task resumable — `markResumable` writes `state: failed`. */
    resumable: boolean
    /**
     * Does this ending FAIL the plan that contains the task?
     *
     * Strictly narrower than `resumable`, and the distinction is load-bearing: a
     * declined-steer interrupt leaves the inner task resumable but the PLAN in
     * progress, so `/task-auto-resume` re-delivers that task's spec. A fault fails
     * the plan too. Only `/task-auto` reads this — a bare `/task` has no plan.
     */
    failsRun: boolean
    /** The notify level for this ending. */
    level: 'info' | 'warning' | 'error'
}

/**
 * The one table. A run that the USER stopped is not resumable-as-failed: its
 * file already says `cancelled`, and rewriting that to `failed` both lies in the
 * ledger and turns a deliberate stop into a red error the user has to read as a
 * fault.
 */
export const RUN_END_POLICY: Record<RunEndKind, RunEndPolicy> = {
    completed: {resumable: false, failsRun: false, level: 'info'},
    cancelled: {resumable: false, failsRun: false, level: 'warning'},
    interrupted: {resumable: true, failsRun: false, level: 'warning'},
    failed: {resumable: true, failsRun: true, level: 'error'},
    'no-session': {resumable: false, failsRun: false, level: 'warning'}
}

/** Did the run deliver a spec? True for `completed` and nothing else. */
export function runSucceeded(end: RunEnd): boolean {
    return end.kind === 'completed'
}
