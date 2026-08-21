/**
 * run-end — how a single /task run ENDED, named once.
 *
 * `TaskRunner.run` returned `void` and never threw, so `runSingleTask` learned
 * what it had just done by RE-READING the task file's front matter, narrowing
 * that to `ok: boolean`, and smuggling the rest out of the `withSession` closure
 * through three mutable captures. Both commands then re-derived a cause the
 * runner already had: `classifyFailure` names the ending exactly, and
 * `handleFailure` threw the name away.
 *
 * The live consequence was a wrong report. `/task-cancel` during a gated run
 * writes `cancelled` to the file; `ok` is `state === 'completed'`, so it is
 * false; `!res.ok` calls `markResumable`, which overwrites `cancelled` with
 * `failed`, and announces a red *"stopped — fix and run /task-resume"*.
 * `/task-auto` hits the same arm for the same input, because its cancel branch
 * only consults a module global that `/task-cancel` never sets.
 *
 * The file is still written — it is what a RESUME reads. What changed is that it
 * is no longer the channel this process uses to talk to itself.
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
 * `resumable` and `announce` are the two facts the two hand-written ladders
 * disagreed about, and the disagreement is where the cancel bug lived: a
 * `cancelled` run was falling into the `failed` arm and being marked resumable.
 * The WORDING stays per-command — `/task` says "resume with /task-resume" where
 * `/task-auto` says "/task-auto-resume" — so only the policy is shared.
 */
export interface RunEndPolicy {
    /** Mark the task resumable (overwrites its state with `failed`). */
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

/** Did the run deliver a spec? The single question the old `ok` boolean answered. */
export function runSucceeded(end: RunEnd): boolean {
    return end.kind === 'completed'
}
