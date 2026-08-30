/**
 * One-line startup hint shown when Brave is the selected search provider but no
 * key is configured. Brave is the only provider that needs one:
 * `SEARCH_PROVIDER_KEY_ENV` in search-types.ts gives exa and ddg an empty var
 * list, so no hint can render for them.
 *
 * It never blocks work. registerSessionHint renders it only in TUI mode and
 * clears it on the first raw keystroke.
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {registerSessionHint} from './session-hint.js'

const WIDGET_KEY = 'pi-task-brave-warning'

const WARNING =
    '⚠ pi-task: search provider is Brave but BRAVE_SEARCH_API_KEY is not set — web search '
    + 'is disabled. Get a free key at https://api.search.brave.com/app/keys or switch '
    + 'provider in /task-config'

/**
 * The same two env vars, in the same order, that `SEARCH_PROVIDER_KEY_ENV` lists
 * for brave — a second copy, because this runs at session_start with no provider
 * in hand.
 *
 * The two are not byte-equivalent. `??` skips only null/undefined, while
 * `searchProviderKey` skips any falsy value, so `BRAVE_SEARCH_API_KEY=""` with
 * `BRAVE_API_KEY` set makes search work while this still warns. Erring toward
 * showing the hint is the harmless direction.
 */
function hasBraveKey(): boolean {
    return Boolean(process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY)
}

export function registerBraveKeyWarning(pi: ExtensionAPI): void {
    // Only the brave provider can be misconfigured, so returning null — say
    // nothing — is the answer for every other provider and for a key already set.
    registerSessionHint(pi, WIDGET_KEY, () =>
        getConfig().searchProvider !== 'brave' || hasBraveKey() ? null : {text: WARNING}
    )
}
