/**
 * One-line startup hint shown when no Brave Search key is configured.
 *
 * pi-task's web-search worker needs BRAVE_SEARCH_API_KEY (or BRAVE_API_KEY).
 * When neither is set we surface a single, unobtrusive widget line on session
 * start so the user knows search is disabled — it never blocks work and clears
 * itself on the first interaction (any keystroke).
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'

const WIDGET_KEY = 'pi-task-brave-warning'

const WARNING =
    '⚠ pi-task: BRAVE_SEARCH_API_KEY not set — web search is disabled. '
    + 'Get a free key at https://api.search.brave.com/app/keys'

/** Mirrors the lookup in search-core so the hint matches what the worker reads. */
function hasBraveKey(): boolean {
    return Boolean(process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY)
}

export function registerBraveKeyWarning(pi: ExtensionAPI): void {
    pi.on('session_start', (_event, ctx) => {
        // Terminal-only hint: needs an interactive TUI to render and to catch the
        // keystroke that dismisses it. Skip when a key is already present.
        if (ctx.mode !== 'tui' || hasBraveKey()) return

        let unsubscribe: (() => void) | null = null
        const clear = (): void => {
            try {
                ctx.ui.setWidget(WIDGET_KEY, undefined)
            } catch {
                /* stale ctx after a session switch — nothing to clear */
            }
            unsubscribe?.()
            unsubscribe = null
        }

        try {
            ctx.ui.setWidget(WIDGET_KEY, [ctx.ui.theme.fg('warning', WARNING)])
        } catch {
            return
        }

        // Disappear on any interaction — the first raw keystroke clears it.
        // Returning undefined leaves the input untouched (we only observe it).
        unsubscribe = ctx.ui.onTerminalInput(() => {
            clear()
            return undefined
        })
    })
}
