/**
 * Raw-terminal delivery for input typed while a run owns the main loop.
 *
 * THE PROBLEM. While a /task-auto run is in flight, the host's interactive main
 * loop is parked at `await session.prompt("/task-auto …")` and never loops back
 * to read input. pi's editor submit handler — `modes/interactive/interactive-mode.js`
 * — has two paths, and both are verbatim in the installed package:
 *
 *   - streaming    → `session.prompt(text, {streamingBehavior: "steer"})`. pi's own
 *                    comment on that branch says it "handles extension commands
 *                    (execute immediately)".
 *   - not streaming → `pendingUserInputs.push(text)`, reached only when no
 *                    `onInputCallback` is registered — i.e. exactly when the main
 *                    loop is parked. `getUserInput()` is the sole drain.
 *
 * The host session is NOT streaming for most of a run: the spec phases and every
 * gate are child `pi` processes, not host turns. So a /task-auto-cancel typed
 * during them was pushed onto that queue and executed only after the run had
 * already finished — by which point `autoRunning` is false and it answers "No
 * /task-auto loop is running." The command was, for most of a run, inert.
 *
 * THE FIX. `ctx.ui.onTerminalInput` (→ `TUI.addInputListener`) is a raw stdin
 * listener, and the ordering it depends on is real: `handleTerminalInput` runs
 * every registered input listener FIRST, returning immediately on the first one
 * that answers `{consume: true}`, before any focused-component dispatch below it.
 * That happens independently of the parked main loop.
 *
 * So we watch for the submit key, read what the editor is holding, and if it is
 * the cancel command we raise the request ourselves and `consume` the keystroke —
 * otherwise the line sits in the queue and replays after the run as the confusing
 * "No /task-auto loop is running." auto-orchestrator emits when nothing is in
 * flight.
 *
 * WHAT ELSE IT NOW CARRIES. The same interception makes the terminal behave like
 * the browser for everything else typed mid-run, instead of feeding pi's queue:
 *
 *   - a bridge slash command (/task-list, /task-auto-cancel, …) runs immediately,
 *     exactly as dispatchRemoteLine runs it for a browser;
 *   - a plain line is HELD (src/task/mid-run-input.ts) and steered into the next
 *     task turn, rather than starting a competing turn or being replayed after
 *     the run.
 *
 * Three things are deliberately NOT intercepted, and each would be a regression
 * (the key test: ESC against a full editor is not a submission, and neither is any
 * ordinary character):
 *   - a keystroke that is not a submit, so typing and history are untouched;
 *   - anything typed while a prompt/dialog is open (the raw listener sees keys
 *     BEFORE the focused component, so swallowing here would eat the user's
 *     answer to a clarify question or the ESC-steer input);
 *   - a submit while the agent is streaming — pi's own submit path already
 *     steers the live turn, which is the behaviour we want.
 *
 * Deliberately no bare-key shortcut — ESC already means "interrupt the turn"
 * during the implementation turn, and hijacking it would break steerUntilDone.
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {holdInput, isRunActive} from './mid-run-input.js'
import {getBridge} from '../remote/bridge.js'
import {getState} from '../remote/session-state.js'

/** The command this listener delivers. Anchored at both ends and requiring the
 *  leading slash, so bare "task-auto-cancel", "/task-auto-cancel now" and
 *  "please run /task-auto-cancel" all fail to match — prose about the command must
 *  never fire it. Surrounding whitespace is tolerated. */
const CANCEL_RE = /^\/task-auto-cancel\s*$/

/** Enter, in the encodings a terminal actually sends. A bare "\n" is what many
 *  terminals emit in raw mode; "\r" is the usual CR; "\r\n" covers the pair. All
 *  three submit; nothing else does, ESC included. */
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

/** Best-effort toast; a failed notification must never break interception. */
function notify(ctx: ExtensionCommandContext, message: string): void {
    try {
        ctx.ui.notify(message, 'info')
    } catch {
        /* cosmetic only */
    }
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
    onCancel?: (live: ExtensionCommandContext) => void
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
            if (!isSubmitKey(data)) return undefined
            let text: string
            try {
                text = getText()
            } catch {
                // A torn-down editor (session replacement mid-run) must never
                // take the run down with it — fall through to normal handling.
                return undefined
            }
            const trimmed = text.trim()
            if (trimmed.length === 0) return undefined
            const swallow = (): {consume: true} => {
                // Clear what we swallowed, so the editor does not sit there
                // holding a line the user believes they submitted.
                try {
                    setText?.('')
                } catch {
                    /* cosmetic only */
                }
                return {consume: true}
            }
            if (CANCEL_RE.test(trimmed) && onCancel) {
                const r = swallow()
                // Hand back the ctx this listener is installed on: after a session
                // replacement the original is stale and using it throws.
                onCancel(ctx)
                return r
            }
            // A dialog owns the keyboard — this Enter is the user's ANSWER.
            if (getState().prompt !== null) return undefined
            // Outside a run, pi's own handling is correct and unblocked.
            if (!isRunActive()) return undefined
            // Streaming: pi's submit path already steers the live turn.
            try {
                if (!ctx.isIdle()) return undefined
            } catch {
                return undefined
            }
            if (trimmed.startsWith('/')) {
                const space = trimmed.indexOf(' ')
                const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).trim()
                const args = space === -1 ? '' : trimmed.slice(space + 1).trim()
                const handler = getBridge().commands.get(name)
                // Unknown to the bridge (a pi builtin like /model): leave it to pi.
                if (!handler) return undefined
                const r = swallow()
                try {
                    const result = handler(args, ctx) as unknown
                    if (result instanceof Promise) {
                        result.catch((err: unknown) =>
                            notify(ctx, `/${name} failed: ${String(err)}`)
                        )
                    }
                } catch (err) {
                    notify(ctx, `/${name} failed: ${String(err)}`)
                }
                return r
            }
            const r = swallow()
            holdInput(trimmed)
            notify(ctx, 'Held for the running task — it lands on the next task turn.')
            return r
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
 * The listener does NOT survive `ctx.newSession()`, and the chain is all three
 * links, each present in the installed package: `InteractiveMode` registers
 * `setBeforeSessionInvalidate(() => this.resetExtensionUI())`, `resetExtensionUI`
 * calls `clearExtensionTerminalInputListeners()`, and that clears the very set
 * this listener lives in — so every per-task session replacement silently drops
 * it. That replacement happens at
 * the START of each task, which is exactly the window this listener exists to
 * cover, so the run must re-arm against the fresh ctx as soon as one appears
 * (runSingleTask, where the new ctx is also handed to the remote bridge).
 *
 * Module-level rather than threaded through the deps: the re-arm point is deep
 * inside the runner, which must not learn about /task-auto's cancel plumbing.
 */
let armed: {
    dispose: () => void
    onCancel: ((live: ExtensionCommandContext) => void) | undefined
    depth: number
} | null = null

/**
 * Begin intercepting mid-run terminal input. Refcounted, because runs nest:
 * /task-auto arms for its loop and every task inside it arms again, so a plain
 * "replace" would let the first inner run's end silently un-arm the rest of the
 * loop. Run: three nested arms produce ONE install and take three disarms to
 * release.
 *
 * The first `onCancel` wins — /task-auto passes one so a typed /task-auto-cancel
 * can post its acknowledgement through the live ctx; a plain /task passes none
 * and lets the generic bridge dispatch handle that command like any other. An arm
 * that adds a callback where there was none upgrades in place, reinstalling
 * against the same refcount rather than starting a second one.
 */
export function armCancelListener(
    ctx: ExtensionCommandContext,
    onCancel?: (live: ExtensionCommandContext) => void
): void {
    if (armed) {
        armed.depth++
        if (!armed.onCancel && onCancel) {
            // Upgrade in place: keep the same install, gain the ack callback.
            armed.dispose()
            armed.dispose = installCancelListener(ctx, onCancel)
            armed.onCancel = onCancel
        }
        return
    }
    armed = {dispose: installCancelListener(ctx, onCancel), onCancel, depth: 1}
}

/**
 * Re-point the armed listener at a replacement ctx. A no-op when nothing is
 * armed, so the runner can call it unconditionally on every session swap.
 */
export function rearmCancelListener(ctx: ExtensionCommandContext): void {
    if (!armed) return
    armed.dispose()
    armed.dispose = installCancelListener(ctx, armed.onCancel)
}

/** Stop listening once the outermost run ends, so input typed after the run goes
 *  back through pi's ordinary path. */
export function disarmCancelListener(): void {
    if (!armed) return
    armed.depth--
    if (armed.depth > 0) return
    armed.dispose()
    armed = null
}

/** Force-disarm regardless of depth (tests, and hard teardown). */
export function forceDisarmCancelListener(): void {
    armed?.dispose()
    armed = null
}

/** Whether a listener is currently armed (tests). */
export function isCancelListenerArmed(): boolean {
    return armed !== null
}
