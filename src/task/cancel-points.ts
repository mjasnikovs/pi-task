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
 *   plan:<child>   (child-status, runPlanningChild — the one funnel BOTH
 *                  /task-auto's planning and /task-plan go through) DURABLE BY
 *                  DISCARD, and the one seam here that is not durable by writing.
 *                  Nothing planning produces reaches disk until planAuto's final
 *                  writeTaskFile, so there is no partial plan to resume and no
 *                  half-state to repair — stopping abandons the whole plan. That
 *                  is the point: the alternative measured at 13+ minutes of
 *                  running after the user asked to stop.
 *   research:<w>   (research-worker) after persistSection. The four workers run
 *                  serially by default and each one's section is read back by
 *                  readCached, so a resume skips every worker already on disk.
 *                  Costs nothing and repeats nothing — the only seam here that is
 *                  free in both directions.
 *   impl:post-turn (orchestrator) the implementation turn has ENDED and the spec
 *                  sections are all on disk. The turn's edits are uncommitted, so
 *                  a resume re-delivers the spec onto the partly-edited tree —
 *                  identical to the shipped ESC-then-decline-steer ending.
 *   gate:post-commit  (task-gates) the task is checked off and its snapshot is in
 *                  HEAD. Only the enforce pass is skipped, and enforce is
 *                  re-runnable.
 *   gate:pre-autofix  (task-gates) between autofix rounds. The previous round's
 *                  tree is whatever it is and the next round has not started.
 *
 * DELIBERATELY NOT a checkpoint — stopping here is not safe:
 *   - mid implementation turn. The turn is a host-session turn, not a child, so
 *     stopping it means abandoning a half-applied edit set with no commit behind
 *     it. `impl:post-turn` waits for the turn to end instead. The user's ESC
 *     (declined steer) path already covers "stop now, I accept a partial tree".
 */

/** Every place the cancel flag is polled. A closed union so the tests enumerate
 *  the same set the loop does — and they do: cancel-points.test.ts asserts on the
 *  recorded trail rather than on the loop's own bookkeeping. */
export type CancelCheckpoint =
    | 'loop-top'
    | 'pre-task'
    | 'pre-final-gate'
    | 'impl:post-turn'
    | 'gate:post-commit'
    | 'gate:pre-autofix'
    | `phase:${string}`
    | `plan:${string}`
    | `research:${string}`

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
    if (isSuppressed(where)) return false
    return requested
}

// ─── Suppression (negative controls) ─────────────────────────────────────────

/**
 * Which seams may fire. `null` is production: all of them.
 *
 * This is what makes the seam matrix falsifiable, and a predicate rather than a
 * name list because three of the seams are open-ended (`phase:`, `plan:`,
 * `research:`) and a list could not name them all.
 *
 * The matrix asks one seam at a time — `onlyCheckpoints(w => w === 'pre-task')`
 * for the assertion, `onlyCheckpoints(() => false)` for its control — so the two
 * runs differ by exactly that seam and nothing else. Without the control, "the
 * run stopped here" also passes against a loop that stops everywhere, or one that
 * stopped for an unrelated reason: several seams see the same raised flag, and
 * whichever comes first is the one that stops the run.
 */
let allowed: ((where: CancelCheckpoint) => boolean) | null = null

function isSuppressed(where: CancelCheckpoint): boolean {
    // CANCEL_AB_ARM=baseline collapses the set back to loop-top alone — the
    // original two-arm control, kept because it is the coarse "does the extra
    // checkpoint set do anything at all" question, which no per-seam control asks.
    if (process.env.CANCEL_AB_ARM === 'baseline' && where !== 'loop-top') return true
    return allowed !== null && !allowed(where)
}

/** Let only the seams this answers true for fire. Tests only. */
export function onlyCheckpoints(predicate: (where: CancelCheckpoint) => boolean): void {
    allowed = predicate
}

/** Back to production: every seam fires. */
export function clearCheckpointSuppression(): void {
    allowed = null
}

/** Checkpoints crossed since the last reset. */
export function checkpointsCrossed(): readonly CancelCheckpoint[] {
    return crossed
}
