import {httpRequest, HttpRequestError, type FetchLike} from './http-request.js'
import type {SearchResult} from './search-types.js'

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'
const DEFAULT_COUNT = 10
const MAX_COUNT = 20
const DEFAULT_TIMEOUT_MS = 10_000

export type BraveResult = SearchResult

export interface BraveSearchOpts {
    apiKey: string
    count?: number
    timeoutMs?: number
    signal?: AbortSignal
    /**
     * Injectable fetch. All three providers take one, and brave needs it most:
     * its status ladder is the widest of the three, so without this seam the
     * ladder is the only one no test can drive at the request level.
     */
    fetchImpl?: FetchLike
}

export class BraveSearchError extends Error {
    constructor(
        message: string,
        public readonly kind: 'auth' | 'rate-limit' | 'http' | 'network' | 'aborted',
        public readonly status?: number
    ) {
        super(message)
        this.name = 'BraveSearchError'
    }
}

interface BraveRawResult {
    title?: unknown
    url?: unknown
    description?: unknown
}

export async function braveSearch(query: string, opts: BraveSearchOpts): Promise<BraveResult[]> {
    const count = Math.max(1, Math.min(MAX_COUNT, opts.count ?? DEFAULT_COUNT))
    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`

    try {
        return await httpRequest(
            url,
            {
                timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                ...(opts.signal === undefined ? {} : {signal: opts.signal}),
                ...(opts.fetchImpl === undefined ? {} : {fetchImpl: opts.fetchImpl}),
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    'x-subscription-token': opts.apiKey
                }
            },
            async response => {
                // Brave's own status policy: a rejected key and a rate limit are
                // different problems for the user, and neither is a plain HTTP fault.
                if (response.status === 401 || response.status === 403) {
                    throw new BraveSearchError(
                        `Brave Search rejected the key (HTTP ${response.status}). Check BRAVE_SEARCH_API_KEY.`,
                        'auth',
                        response.status
                    )
                }
                if (response.status === 429) {
                    throw new BraveSearchError(
                        'Brave Search rate limit hit (HTTP 429). Try again in a moment.',
                        'rate-limit',
                        429
                    )
                }
                if (!response.ok) {
                    throw new BraveSearchError(
                        `Brave Search HTTP ${response.status} ${response.statusText}`,
                        'http',
                        response.status
                    )
                }

                const body = (await response.json()) as {web?: {results?: BraveRawResult[]}}
                const rawResults = body.web?.results ?? []
                return rawResults
                    .filter(
                        (r): r is {title: string; url: string; description: string} =>
                            typeof r.title === 'string'
                            && typeof r.url === 'string'
                            && typeof r.description === 'string'
                    )
                    .map(r => ({title: r.title, url: r.url, description: r.description}))
            }
        )
    } catch (err) {
        if (err instanceof HttpRequestError) {
            throw err.kind === 'aborted' ?
                    new BraveSearchError('Search aborted.', 'aborted')
                :   new BraveSearchError(`Brave Search request failed: ${err.detail}`, 'network')
        }
        throw err
    }
}
