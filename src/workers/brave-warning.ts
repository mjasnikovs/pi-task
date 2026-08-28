/**
 * One-line startup hint shown when Brave is the selected search provider but
 * no key is configured (Brave is the only provider that needs one — exa and
 * ddg are keyless, so no hint renders for them). It never blocks work and
 * clears itself on the first interaction (any keystroke).
 */

import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {registerSessionHint} from './session-hint.js'

const WIDGET_KEY = 'pi-task-brave-warning'

const WARNING =
    '⚠ pi-task: search provider is Brave but BRAVE_SEARCH_API_KEY is not set — web search '
    + 'is disabled. Get a free key at https://api.search.brave.com/app/keys or switch '
    + 'provider in /task-config'

/** Mirrors the lookup in search-core so the hint matches what the worker reads. */
function hasBraveKey(): boolean {
    return Boolean(process.env.BRAVE_SEARCH_API_KEY ?? process.env.BRAVE_API_KEY)
}

export function registerBraveKeyWarning(pi: ExtensionAPI): void {
    // Only the brave provider can be misconfigured; say nothing whenever another
    // provider is selected or a key is already present.
    registerSessionHint(pi, WIDGET_KEY, () =>
        getConfig().searchProvider !== 'brave' || hasBraveKey() ? null : {text: WARNING}
    )
}
