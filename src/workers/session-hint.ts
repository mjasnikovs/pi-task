/**
 * A one-line startup hint in the TUI, and the whole widget lifetime around it.
 *
 * WHY IT IS ONE MODULE. Two hints exist (brave-warning, reasoning-warning) and
 * both had written the same ritual out: the `session_start` subscription, the
 * TUI gate, the `setWidget` in a try/catch, the `onTerminalInput` that clears on
 * the first keystroke, the unsubscribe, and the swallow for a stale ctx — down
 * to a byte-identical comment. Two adapters is a real seam, so the ritual lives
 * here once and each hint supplies only its `compose`.
 *
 * The REFINE half is why this is not just deduplication. A hint may learn
 * something after it has painted (the reasoning hint probes the model's server),
 * and the rule that a refinement must never repaint a widget the user already
 * dismissed lived in one closure variable in one of the two files. It is now a
 * property of this module, asserted once.
 */

import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'

export interface SessionHint {
    /** The line to paint now. */
    text: string
    /**
     * A later refinement of that line, if this hint has one. Resolving to null —
     * or rejecting — leaves the first line standing, so a refinement can never
     * remove a warning it was only meant to sharpen. It is fire-and-forget: it
     * cannot delay or prevent the first paint, and it is dropped if the user has
     * already cleared the hint.
     */
    refine?: Promise<string | null>
}

/**
 * Register one startup hint.
 *
 * `compose` is the seam: it runs at `session_start` inside the TUI gate and
 * returns the hint, or null to say nothing at all. Everything it returns is
 * text; nothing about widgets, keystrokes or teardown reaches it.
 */
export function registerSessionHint(
    pi: ExtensionAPI,
    key: string,
    compose: (ctx: ExtensionContext) => SessionHint | null
): void {
    pi.on('session_start', (_event, ctx) => {
        // Terminal-only hint: needs an interactive TUI to render and to catch the
        // keystroke that dismisses it.
        if (ctx.mode !== 'tui') return

        const hint = compose(ctx)
        if (hint === null) return

        let unsubscribe: (() => void) | null = null
        let cleared = false
        let painted = false
        const clear = (): void => {
            cleared = true
            try {
                ctx.ui.setWidget(key, undefined)
            } catch {
                /* stale ctx after a session switch — nothing to clear */
            }
            unsubscribe?.()
            unsubscribe = null
        }
        const render = (text: string): boolean => {
            try {
                ctx.ui.setWidget(key, [ctx.ui.theme.fg('warning', text)])
                return true
            } catch {
                return false
            }
        }

        // Handled BEFORE the paint can bail. `compose` builds this promise
        // eagerly — the reasoning hint kicks its probe off inside it — so a
        // rejection with the handler attached later is an unhandled rejection on
        // exactly the path the try/catch around `setWidget` exists for: a stale
        // ctx after a session switch. `refine`'s contract says a rejection leaves
        // the first line standing, and that has to hold when there is no first
        // line either.
        if (hint.refine !== undefined) {
            void hint.refine
                .then(text => {
                    if (cleared || !painted || text === null) return
                    render(text)
                })
                .catch(() => {})
        }

        painted = render(hint.text)
        if (!painted) return

        // Disappear on any interaction — the first raw keystroke clears it.
        // Returning undefined leaves the input untouched (we only observe it).
        unsubscribe = ctx.ui.onTerminalInput(() => {
            clear()
            return undefined
        })
    })
}
