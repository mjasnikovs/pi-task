import {getConfig} from '../config/config.js'
import {braveSearch as defaultBraveSearch} from './brave-search.js'
import {ddgSearch as defaultDdgSearch} from './ddg-search.js'
import {exaSearch as defaultExaSearch} from './exa-search.js'
import {
    searchProviderKey,
    SEARCH_PROVIDER_LABELS,
    type SearchProvider,
    type SearchResult
} from './search-types.js'

export interface SearchCoreInput {
    query: string
    count?: number
    signal?: AbortSignal
    getEnv?: (key: string) => string | undefined
    /** Engine override; defaults to the configured `searchProvider` (exa). */
    provider?: SearchProvider
    braveSearch?: typeof defaultBraveSearch
    exaSearch?: typeof defaultExaSearch
    ddgSearch?: typeof defaultDdgSearch
}

export type SearchCoreResult =
    | {kind: 'ok'; results: SearchResult[]}
    | {kind: 'no_key'; message: string}
    | {kind: 'error'; message: string}

/**
 * One engine, as an adapter: what to call, and what it needs.
 *
 * `SearchProvider` used to be a union with nothing behind it, so every consumer
 * branched on it by hand — `search()` had a brave special case plus a two-arm
 * ternary, the three engine functions arrived as three separate seams on
 * `SearchCoreInput`, the three error classes were reconciled by matching
 * `err.name` as a STRING, and brave's key requirement was stated a second time in
 * phases.ts. Adding an engine meant finding all of that.
 *
 * The rows below are the whole of it. `key` is `''` for a keyless engine and the
 * resolved key for brave — read from {@link searchProviderKey}, so the env pair is
 * declared once, beside the ids.
 */
interface SearchAdapter {
    /** Run the engine. `key` is `''` when the engine is keyless. */
    run(
        input: SearchCoreInput,
        key: string,
        opts: {count?: number; signal?: AbortSignal}
    ): Promise<SearchResult[]>
    /** What to tell the user when the engine needs a key and none is set. */
    missingKeyMessage?: string
    /**
     * The engine's own error class name. A throw carrying it already has a finished
     * user-facing message; anything else is wrapped by {@link wrapUnknownError}.
     * Absent → every throw's message is used verbatim.
     */
    errorName?: string
    wrapUnknownError?: (message: string) => string
}

const SEARCH_ADAPTERS: Record<SearchProvider, SearchAdapter> = {
    exa: {
        run: (input, _key, opts) => (input.exaSearch ?? defaultExaSearch)(input.query, opts)
    },
    ddg: {
        run: (input, _key, opts) => (input.ddgSearch ?? defaultDdgSearch)(input.query, opts)
    },
    brave: {
        run: (input, key, opts) =>
            (input.braveSearch ?? defaultBraveSearch)(input.query, {...opts, apiKey: key}),
        missingKeyMessage:
            'Brave Search not configured. Set BRAVE_SEARCH_API_KEY env var '
            + '(get a key at https://api.search.brave.com/app/keys) or switch '
            + 'the search provider in /task-config.',
        errorName: 'BraveSearchError',
        wrapUnknownError: m => `Brave Search request failed: ${m}`
    }
}

/**
 * Provider selection is STRICT: the configured (or overridden) engine is the
 * only one tried — a failure reports as an error rather than silently switching
 * engines, so results always come from where the user thinks they do.
 */
export async function search(input: SearchCoreInput): Promise<SearchCoreResult> {
    const provider = input.provider ?? getConfig().searchProvider
    const adapter = SEARCH_ADAPTERS[provider]
    const getEnv = input.getEnv ?? ((k: string) => process.env[k])

    const key = searchProviderKey(provider, getEnv)
    if (key === null) {
        return {
            kind: 'no_key',
            message:
                adapter.missingKeyMessage
                ?? `${SEARCH_PROVIDER_LABELS[provider]} search is not configured.`
        }
    }

    try {
        const results = await adapter.run(input, key, {
            ...(input.count === undefined ? {} : {count: input.count}),
            ...(input.signal === undefined ? {} : {signal: input.signal})
        })
        return {kind: 'ok', results}
    } catch (err) {
        // Which throws already carry a finished user-facing message is the engine's
        // own fact, so it is a row. This used to be an `err.name ===
        // 'BraveSearchError'` STRING match in a brave-only branch — the check
        // existed only because brave was reached down a different path from the
        // other two, and it is the reason a subclass rename would have gone
        // unnoticed.
        const message = err instanceof Error ? err.message : String(err)
        const known =
            adapter.errorName === undefined
            || (err instanceof Error && err.name === adapter.errorName)
        return {
            kind: 'error',
            message: known ? message : (adapter.wrapUnknownError?.(message) ?? message)
        }
    }
}
