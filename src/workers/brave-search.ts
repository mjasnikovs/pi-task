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
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const url = `${BRAVE_ENDPOINT}?q=${encodeURIComponent(query)}&count=${count}`

    const internalController = new AbortController()
    let userAborted = false
    const timeoutHandle = setTimeout(() => internalController.abort(), timeoutMs)
    const onUserAbort = () => {
        userAborted = true
        internalController.abort()
    }
    if (opts.signal) {
        if (opts.signal.aborted) onUserAbort()
        else opts.signal.addEventListener('abort', onUserAbort, {once: true})
    }

    try {
        let response: Response
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {
                    accept: 'application/json',
                    'x-subscription-token': opts.apiKey
                },
                signal: internalController.signal
            })
        } catch (err) {
            if (userAborted) {
                throw new BraveSearchError('Search aborted.', 'aborted')
            }
            throw new BraveSearchError(
                `Brave Search request failed: ${describeError(err)}`,
                'network'
            )
        }

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
    } finally {
        clearTimeout(timeoutHandle)
        if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort)
    }
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
