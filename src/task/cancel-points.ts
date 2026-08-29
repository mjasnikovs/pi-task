/**
 * /task-auto-cancel — the cancel request and the SAFE CHECKPOINTS that observe it.
 *
 * A cancel is a *request*, never a kill. It is honoured only where the on-disk
 * state is durable and /task-auto-resume provably continues from it. Killing a
 * child mid-phase would also stop the run (the abort signal already reaches
 * every child's process group) but throws away that phase's work and can leave
 * a half-written tree — so the flag is polled at boundaries instead.
 *
 * The checkpoint set, and why each one is safe:
 *
 *   loop-top       the previous task is checked off + committed and the next one
 *                  has not started. The original (and until now the ONLY) point.
 *   pre-task       after the pre-task checkpoint commit, before the runner is
 *                  constructed: tree committed, no inner id stamped yet, so the
 *                  entry is simply still unchecked and a resume restarts it.
 *   phase:<name>   inside the runner's phase loop, after setTaskSection +
 *                  postCommitPhase have persisted the phase output and
 *                  front-matter `phase` names the NEXT phase. This is exactly
 *                  the state /task-resume already resumes from (PHASE_INDEX
 *                  skip-forward), so a cancel here costs nothing.
 *   pre-final-gate every task is checked off and committed; the whole-repo gate
 *                  has not started. A resume re-enters the same branch.
 *
 * DELIBERATELY NOT checkpoints — stopping here is not safe:
 *   - mid implementation turn: uncommitted, half-applied edits. The user's ESC
 *     (declined steer) path already covers "stop now, I accept a partial tree".
 *   - between the implementation turn and the gates, or inside the gates: the
 *     work is written but unverified and uncommitted; the gates are what make it
 *     durable. Cancel is observed on the far side, at loop-top.
 */

/** Every place the cancel flag is polled. Kept as a closed union so the tests
 *  enumerate the same set the loop does. */
export type CancelCheckpoint = 'loop-top' | 'pre-task' | 'pre-final-gate' | `phase:${string}`

let requested = false

/** Checkpoints actually reached since the last reset, in order. Instrumentation
 *  for the tests — never read by the loop itself. */
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
    // CANCEL_AB_ARM=baseline reproduces the behaviour before these checkpoints
    // existed: the flag is observed at the loop top and nowhere else. Set only by
    // a measuring harness, so the two arms differ in exactly one thing.
    if (process.env.CANCEL_AB_ARM === 'baseline' && where !== 'loop-top') return false
    return requested
}

/** Checkpoints crossed since the last reset. */
export function checkpointsCrossed(): readonly CancelCheckpoint[] {
    return crossed
}
