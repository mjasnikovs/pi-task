/**
 * Raw-terminal delivery for /task-auto-cancel.
 *
 * THE PROBLEM. While a /task-auto run is in flight, the host's interactive main
 * loop is parked at `await session.prompt("/task-auto …")` and never loops back
 * to read input. pi's editor submit handler (interactive-mode.js) has two paths:
 *
 *   - streaming    → session.prompt(text, {streamingBehavior:"steer"}), and
 *                    agent-session.prompt() runs extension commands immediately.
 *   - not streaming → pendingUserInputs.push(text) — a queue only the parked
 *                    main loop drains.
 *
 * The host session is NOT streaming for most of a run: the spec phases and every
 * gate are child `pi` processes, not host turns. So a /task-auto-cancel typed
 * during them was pushed onto that queue and executed only after the run had
 * already finished — by which point `autoRunning` is false and it answers "No
 * /task-auto loop is running." The command was, for most of a run, inert.
 *
 * THE FIX. `ctx.ui.onTerminalInput` (→ TUI.addInputListener) is a raw stdin
 * listener that the TUI dispatches BEFORE the focused component sees the bytes,
 * independently of the parked main loop. We watch for the submit key, read what
 * the editor is holding, and if it is the cancel command we raise the request
 * ourselves and `consume` the keystroke so the line is never queued for a
 * post-run replay of the confusing "no loop is running" message.
 *
 * Nothing else is intercepted: every other keystroke is passed straight through,
 * so typing, history, and the ESC/steer path are untouched. Deliberately no
 * bare-key shortcut — ESC already means "interrupt the turn" during the
 * implementation turn, and hijacking it would break steerUntilDone.
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

/** The command this listener delivers. Accepts a leading slash only — matching
 *  bare "task-auto-cancel" would fire on prose about the command. */
const CANCEL_RE = /^\/task-auto-cancel\s*$/

/** Enter, in the encodings a terminal actually sends. A bare "\n" is what many
 *  terminals emit in raw mode; "\r" is the usual CR. */
function isSubmitKey(data: string): boolean {
    return data === '\r' || data === '\n' || data === '\r\n'
}

/**
 * Would this keystroke, against this editor content, submit /task-auto-cancel?
 * Pure so the decision is testable without a TUI.
 */
export function isCancelSubmission(data: string, editorText: string): boolean {
    return isSubmitKey(data) && CANCEL_RE.test(editorText.trim())
}

/**
 * Watch raw terminal input for a submitted /task-auto-cancel and call `onCancel`
 * the moment it is typed, however deep in a run we are.
 *
 * Returns an unsubscribe function. A host without the raw input hook or the
 * editor accessor (the shimmed remote ctx — which does not need this, since
 * dispatchRemoteLine calls handlers directly) gets a no-op.
 *
 * Prefer the arm/rearm/disarm trio below over calling this directly: the
 * listener does not survive a session replacement.
 */
export function installCancelListener(
    ctx: ExtensionCommandContext,
    onCancel: (live: ExtensionCommandContext) => void
): () => void {
    const ui = ctx.ui as Partial<ExtensionCommandContext['ui']>
    if (typeof ui.onTerminalInput !== 'function' || typeof ui.getEditorText !== 'function') {
        return () => {}
    }
    const getText = ui.getEditorText.bind(ui)
    const setText = typeof ui.setEditorText === 'function' ? ui.setEditorText.bind(ui) : undefined
    let unsubscribe: () => void = () => {}
    try {
        unsubscribe = ui.onTerminalInput(data => {
            let text: string
            try {
                text = getText()
            } catch {
                // A torn-down editor (session replacement mid-run) must never
                // take the run down with it — fall through to normal handling.
                return undefined
            }
            if (!isCancelSubmission(data, text)) return undefined
            // Clear what we swallowed, so the editor does not sit there holding a
            // command the user believes they submitted.
            try {
                setText?.('')
            } catch {
                /* cosmetic only */
            }
            // Hand back the ctx this listener is installed on: after a session
            // replacement the original is stale and using it throws.
            onCancel(ctx)
            return {consume: true}
        })
    } catch {
        return () => {}
    }
    return () => {
        try {
            unsubscribe()
        } catch {
            /* best-effort */
        }
    }
}

// ─── Armed listener (survives session replacement) ────────────────────────────

/**
 * The listener does NOT survive `ctx.newSession()`. pi's InteractiveMode
 * registers `setBeforeSessionInvalidate(() => this.resetExtensionUI())`, and
 * `resetExtensionUI` calls `clearExtensionTerminalInputListeners()` — so every
 * per-task session replacement silently drops it. That replacement happens at
 * the START of each task, which is exactly the window this listener exists to
 * cover, so the run must re-arm against the fresh ctx as soon as one appears
 * (runSingleTask, where the new ctx is also handed to the remote bridge).
 *
 * Module-level rather than threaded through the deps: the re-arm point is deep
 * inside the runner, which must not learn about /task-auto's cancel plumbing.
 */
let armed: {dispose: () => void; onCancel: (live: ExtensionCommandContext) => void} | null = null

/** Begin listening for a typed /task-auto-cancel. Replaces any previous arm. */
export function armCancelListener(
    ctx: ExtensionCommandContext,
    onCancel: (live: ExtensionCommandContext) => void
): void {
    disarmCancelListener()
    armed = {dispose: installCancelListener(ctx, onCancel), onCancel}
}

/**
 * Re-point the armed listener at a replacement ctx. A no-op when nothing is
 * armed, so the runner can call it unconditionally on every session swap
 * (including for a plain /task, which has no cancel listener of its own).
 */
export function rearmCancelListener(ctx: ExtensionCommandContext): void {
    if (!armed) return
    armed.dispose()
    armed = {dispose: installCancelListener(ctx, armed.onCancel), onCancel: armed.onCancel}
}

/** Stop listening, so a cancel typed after the run goes back through the
 *  ordinary command path (which then reports there is no loop running). */
export function disarmCancelListener(): void {
    armed?.dispose()
    armed = null
}

/** Whether a listener is currently armed (tests). */
export function isCancelListenerArmed(): boolean {
    return armed !== null
}
