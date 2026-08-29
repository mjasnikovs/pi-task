/**
 * /task-auto-cancel — the cancel request and the SAFE CHECKPOINTS that observe it.
 *
 * A cancel is a *request*, never a kill. It is honoured only where the on-disk
 * state is durable and /task-auto-resume provably continues from it. Killing a
 * child mid-phase would also stop the run — the abort signal reaches every
 * child's process group — but it throws away that phase's work and can leave a
 * half-written tree, so the flag is polled at boundaries instead.
 *
 * The checkpoint set is exactly these four, one call site each:
 *
 *   loop-top       (auto-orchestrator) the previous task is checked off and
 *                  committed and the next one has not started.
 *   pre-task       (auto-orchestrator) after the pre-task checkpoint commit,
 *                  before the runner is constructed: tree committed, no inner id
 *                  stamped yet, so the entry is simply still unchecked and a
 *                  resume restarts it.
 *   phase:<name>   (orchestrator, inside the phase loop) after setTaskSection and
 *                  postCommitPhase have persisted this phase's output. Front-matter
 *                  `phase` still names the phase that JUST FINISHED, not the next
 *                  one: `advance()` writes it at the TOP of each iteration and
 *                  nothing moves it afterwards — postCommitPhase writes only
 *                  `title` and `label`. Since the resume skip rule is
 *                  `idx < resumeIdx`, a resume therefore RE-ENTERS this phase and
 *                  runs it again. Nothing is lost, because its section is already
 *                  on disk; the cost is repeating one phase, not zero.
 *   pre-final-gate (run-final-gate) every task is checked off and committed; the
 *                  whole-repo gate has not started. A resume re-enters the same
 *                  branch.
 *
 * DELIBERATELY NOT checkpoints — stopping here is not safe:
 *   - mid implementation turn: uncommitted, half-applied edits. The user's ESC
 *     (declined steer) path already covers "stop now, I accept a partial tree".
 *   - between the implementation turn and the gates, or inside the gates: the
 *     work is written but unverified and uncommitted; the gates are what make it
 *     durable. Cancel is observed on the far side, at loop-top.
 */

/** Every place the cancel flag is polled. A closed union so the tests enumerate
 *  the same set the loop does — and they do: cancel-points.test.ts asserts on the
 *  recorded trail rather than on the loop's own bookkeeping. */
export type CancelCheckpoint = 'loop-top' | 'pre-task' | 'pre-final-gate' | `phase:${string}`

let requested = false

/** Checkpoints actually reached since the last reset, in order. Instrumentation
 *  only: `checkpointsCrossed` and `resetCheckpointTrail` have no caller anywhere
 *  in src/ — every consumer is a test. */
const crossed: CancelCheckpoint[] = []

export function requestCancel(): void {
    requested = true
}

export function isCancelRequested(): boolean {
    return requested
}

/**
 * Clear the request so the next run does not inherit it. Called when a run
 * starts and in its `finally`.
 *
 * The checkpoint trail is deliberately NOT cleared here: the run's `finally`
 * calls this, and a harness or test that inspects where the run stopped has to
 * read the trail AFTER the loop returns. Use `resetCheckpointTrail` at the start
 * of a trial to get a clean slate.
 */
export function resetCancel(): void {
    requested = false
}

/** Drop the recorded checkpoint trail. */
export function resetCheckpointTrail(): void {
    crossed.length = 0
}

/**
 * Poll the cancel flag at a safe checkpoint. Records the visit either way, so a
 * test can prove a checkpoint is reached at all (a checkpoint that never runs is
 * indistinguishable from one that never fires).
 *
 * @returns true when the caller must stop here.
 */
export function cancelCheckpoint(where: CancelCheckpoint): boolean {
    crossed.push(where)
    // CANCEL_AB_ARM=baseline collapses the checkpoint set back to loop-top alone,
    // so the two arms differ in exactly one thing. Nothing in src/ ever sets it;
    // the only writer in the tree is cancel-points.test.ts, which uses it to pin
    // that the extra checkpoints — and only they — are what the flag gates.
    if (process.env.CANCEL_AB_ARM === 'baseline' && where !== 'loop-top') return false
    return requested
}

/** Checkpoints crossed since the last reset. */
export function checkpointsCrossed(): readonly CancelCheckpoint[] {
    return crossed
}
