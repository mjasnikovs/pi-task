/**
 * Web search via DuckDuckGo's HTML endpoint — no API key required.
 *
 * DDG has no official web-results API; html.duckduckgo.com/html serves plain
 * HTML result pages that parse cleanly with linkedom. Result links are wrapped
 * in a `duckduckgo.com/l/?uddg=<encoded>` redirect that we unwrap so callers
 * get the destination URL. Ad rows redirect through duckduckgo.com itself and
 * are dropped.
 */

import {parseHTML} from 'linkedom'
import type {FetchLike} from './exa-search.js'
import type {SearchResult} from './search-types.js'

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const DEFAULT_COUNT = 10
const MAX_COUNT = 20
const DEFAULT_TIMEOUT_MS = 15_000
// DDG serves a bot-challenge page to clients without a browser-ish UA.
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'

export interface DdgSearchOpts {
    count?: number
    timeoutMs?: number
    signal?: AbortSignal
    fetchImpl?: FetchLike
}

export class DdgSearchError extends Error {
    constructor(
        message: string,
        public readonly kind: 'http' | 'network' | 'aborted' | 'rate-limit',
        public readonly status?: number
    ) {
        super(message)
        this.name = 'DdgSearchError'
    }
}

// linkedom's DOM types don't resolve under this tsconfig (see html-clean.ts);
// narrow to the members the parser touches.
interface ParsedElement {
    getAttribute(name: string): string | null
    querySelector(selector: string): ParsedElement | null
    textContent: string | null
    closest(selector: string): ParsedElement | null
}
interface ParsedDocument {
    querySelectorAll(selector: string): Iterable<ParsedElement>
}

export async function ddgSearch(query: string, opts: DdgSearchOpts = {}): Promise<SearchResult[]> {
    const count = Math.max(1, Math.min(MAX_COUNT, opts.count ?? DEFAULT_COUNT))
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const fetchImpl = opts.fetchImpl ?? fetch

    const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`

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
            response = await fetchImpl(url, {
                method: 'GET',
                headers: {
                    'user-agent': USER_AGENT,
                    accept: 'text/html'
                },
                signal: internalController.signal
            })
        } catch (err) {
            if (userAborted) throw new DdgSearchError('Search aborted.', 'aborted')
            throw new DdgSearchError(`DuckDuckGo request failed: ${describeError(err)}`, 'network')
        }

        if (response.status === 429 || response.status === 403) {
            throw new DdgSearchError(
                `DuckDuckGo is rate-limiting this client (HTTP ${response.status}). Try again in a moment.`,
                'rate-limit',
                response.status
            )
        }
        if (!response.ok) {
            throw new DdgSearchError(
                `DuckDuckGo HTTP ${response.status} ${response.statusText}`,
                'http',
                response.status
            )
        }

        return parseDdgHtml(await response.text()).slice(0, count)
    } finally {
        clearTimeout(timeoutHandle)
        if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort)
    }
}

export function parseDdgHtml(html: string): SearchResult[] {
    const {document} = parseHTML(html)
    const doc = document as unknown as ParsedDocument

    const results: SearchResult[] = []
    for (const anchor of doc.querySelectorAll('a.result__a')) {
        if (anchor.closest('.result--ad')) continue

        const href = anchor.getAttribute('href')
        const targetUrl = href === null ? null : unwrapDdgRedirect(href)
        // A row whose link never leaves duckduckgo.com is an ad/module, not a hit.
        if (targetUrl === null) continue

        const title = collapse(anchor.textContent ?? '')
        if (!title) continue

        const row = anchor.closest('.result')
        const snippet = row?.querySelector('.result__snippet')?.textContent ?? ''
        results.push({title, url: targetUrl, description: collapse(snippet)})
    }
    return results
}

/**
 * Result hrefs look like `//duckduckgo.com/l/?uddg=<encoded-destination>&rut=…`;
 * return the decoded destination, a non-DDG href unchanged, or null for links
 * that stay on duckduckgo.com (ad click-trackers).
 */
function unwrapDdgRedirect(href: string): string | null {
    let parsed: URL
    try {
        parsed = new URL(href, 'https://duckduckgo.com')
    } catch {
        return null
    }
    if (parsed.hostname.endsWith('duckduckgo.com')) {
        const uddg = parsed.searchParams.get('uddg')
        if (!uddg) return null
        try {
            return new URL(uddg).toString()
        } catch {
            return null
        }
    }
    return parsed.toString()
}

function collapse(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

function describeError(err: unknown): string {
    if (err instanceof Error) return err.message
    return String(err)
}
