import {getConfig} from '../config/config.js'
import {braveSearch as defaultBraveSearch, BraveSearchError} from './brave-search.js'
import {ddgSearch as defaultDdgSearch} from './ddg-search.js'
import {exaSearch as defaultExaSearch} from './exa-search.js'
import type {SearchProvider, SearchResult} from './search-types.js'

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

function isLikeBraveSearchError(err: unknown): boolean {
    return (
        typeof err === 'object'
        && err !== null
        && (err as {name?: string}).name === 'BraveSearchError'
    )
}

/**
 * Provider selection is STRICT: the configured (or overridden) engine is the
 * only one tried — a failure reports as an error rather than silently switching
 * engines, so results always come from where the user thinks they do.
 */
export async function search(input: SearchCoreInput): Promise<SearchCoreResult> {
    const provider = input.provider ?? getConfig().searchProvider

    if (provider === 'brave') return braveSearchCore(input)

    const run =
        provider === 'exa' ?
            () =>
                (input.exaSearch ?? defaultExaSearch)(input.query, {
                    count: input.count,
                    signal: input.signal
                })
        :   () =>
                (input.ddgSearch ?? defaultDdgSearch)(input.query, {
                    count: input.count,
                    signal: input.signal
                })
    try {
        return {kind: 'ok', results: await run()}
    } catch (err) {
        return {
            kind: 'error',
            message: err instanceof Error ? err.message : String(err)
        }
    }
}

async function braveSearchCore(input: SearchCoreInput): Promise<SearchCoreResult> {
    const getEnv = input.getEnv ?? ((k: string) => process.env[k])
    const braveSearch = input.braveSearch ?? defaultBraveSearch
    const apiKey = getEnv('BRAVE_SEARCH_API_KEY') ?? getEnv('BRAVE_API_KEY')
    if (!apiKey) {
        return {
            kind: 'no_key',
            message:
                'Brave Search not configured. Set BRAVE_SEARCH_API_KEY env var '
                + '(get a key at https://api.search.brave.com/app/keys) or switch '
                + 'the search provider in /task-config.'
        }
    }
    try {
        const results = await braveSearch(input.query, {
            apiKey,
            count: input.count,
            signal: input.signal
        })
        return {kind: 'ok', results}
    } catch (err) {
        if (err instanceof BraveSearchError || isLikeBraveSearchError(err)) {
            return {kind: 'error', message: (err as Error).message}
        }
        return {
            kind: 'error',
            message: `Brave Search request failed: ${err instanceof Error ? err.message : String(err)}`
        }
    }
}
