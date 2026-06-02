import {
    braveSearch as defaultBraveSearch,
    BraveSearchError,
    type BraveResult
} from './brave-search.js'

export interface SearchCoreInput {
    query: string
    count?: number
    signal?: AbortSignal
    getEnv?: (key: string) => string | undefined
    braveSearch?: typeof defaultBraveSearch
}

export type SearchCoreResult =
    | {kind: 'ok'; results: BraveResult[]}
    | {kind: 'no_key'; message: string}
    | {kind: 'error'; message: string}

function isLikeBraveSearchError(err: unknown): boolean {
    return (
        typeof err === 'object'
        && err !== null
        && (err as {name?: string}).name === 'BraveSearchError'
    )
}

export async function search(input: SearchCoreInput): Promise<SearchCoreResult> {
    const getEnv = input.getEnv ?? ((k: string) => process.env[k])
    const braveSearch = input.braveSearch ?? defaultBraveSearch
    const apiKey = getEnv('BRAVE_SEARCH_API_KEY') ?? getEnv('BRAVE_API_KEY')
    if (!apiKey) {
        return {
            kind: 'no_key',
            message:
                'Brave Search not configured. Set BRAVE_SEARCH_API_KEY env var. '
                + 'Get a key at https://api.search.brave.com/app/keys'
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
