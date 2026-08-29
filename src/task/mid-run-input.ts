/**
 * What a typed message DOES while a task run owns the session.
 *
 * Both surfaces — the terminal Enter listener and the remote browser — need ONE
 * rule, because for most of a run the HOST session is idle: the spec phases and
 * every gate are child `pi` processes, not host turns. Left to itself each surface
 * has its own failure on an idle session:
 *
 *   - browser  → `sendUserMessage` with no delivery mode. pi's own API docs call it
 *                "Always triggers a turn", so it opens a SECOND turn beside the run,
 *                with the write tool in hand. If that turn is still streaming when
 *                the pipeline delivers its spec, the spec's own send hits pi's
 *                guard: "Agent is already processing. Specify streamingBehavior
 *                ('steer' or 'followUp') to queue the message."
 *   - terminal → pi's `pendingUserInputs` queue, which only `getUserInput()` drains
 *                — and that is the main loop our own command handler is parked
 *                inside. The line sits there silently, then fires against a
 *                finished run.
 *
 * The shared rule both surfaces follow:
 *
 *   agent streaming → steer the live turn
 *   agent idle, run active → HOLD it here, show it as pending, and deliver it as
 *                            a steer when the next task turn starts
 *   no run active → ordinary message
 *
 * Holding is what makes the two surfaces agree AND keeps the run safe: a held
 * line never becomes a competing turn, and it is never silently replayed after
 * the run has finished.
 */

/** Held lines, oldest first. Delivered as one steer at the next turn start. */
let held: string[] = []

/** Depth, not a boolean: /task-auto brackets its whole loop and each task inside
 *  it brackets its own run, so a plain flag would clear on the first inner end
 *  and leave the rest of the loop looking idle. */
let runDepth = 0

/** Fired whenever the held list changes, so the surfaces can re-render. */
let onChange: (() => void) | null = null

export function setHeldInputListener(fn: (() => void) | null): void {
    onChange = fn
}

/** Mark a task run as owning the session (refcounted; call from a finally). */
export function beginRun(): void {
    runDepth++
    if (runDepth === 1) onChange?.() // surfaces switch to "held" mode
}

/**
 * End a run. Returns anything still held, which the caller MUST report: that
 * text missed its delivery window, and replaying it into a finished run is the
 * exact surprise this module exists to remove — but dropping it silently would
 * be the same trap the terminal queue was.
 */
export function endRun(): string[] {
    runDepth = Math.max(0, runDepth - 1)
    if (runDepth > 0) return []
    const dropped = held
    held = []
    onChange?.()
    return dropped
}

export function isRunActive(): boolean {
    return runDepth > 0
}

/** For tests: forget all state. */
export function resetMidRunInput(): void {
    held = []
    runDepth = 0
    onChange = null
}

/** Hold a line for the next task turn. Blank lines are ignored. */
export function holdInput(text: string): void {
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    held.push(trimmed)
    onChange?.()
}

/** The lines currently waiting (a copy — mutating it must not affect state). */
export function heldInput(): string[] {
    return [...held]
}

export function clearHeldInput(): void {
    if (held.length === 0) return
    held = []
    onChange?.()
}

/**
 * Take everything held, as one steer payload, and clear it. Returns null when
 * nothing is waiting. Clearing BEFORE delivery is deliberate: a delivery that
 * throws must not leave the same text queued to be delivered again on the next
 * turn.
 */
export function takeHeldInput(): string | null {
    if (held.length === 0) return null
    const payload = held.join('\n\n')
    held = []
    onChange?.()
    return payload
}
