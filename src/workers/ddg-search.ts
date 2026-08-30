/**
 * Web search by scraping DuckDuckGo's HTML endpoint. No API key: search-types.ts
 * gives `ddg` an empty env-var list.
 *
 * `html.duckduckgo.com/html/?q=…` serves an ordinary result page that linkedom
 * parses. Its result links are wrapped in a `//duckduckgo.com/l/?uddg=<encoded>`
 * redirect, which `unwrapDdgRedirect` below decodes so callers get the
 * destination URL rather than the tracker.
 */

import {parseHTML} from 'linkedom'
import {httpRequest, HttpRequestError, type FetchLike} from './http-request.js'
import type {SearchResult} from './search-types.js'

const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/'
const DEFAULT_COUNT = 10
const MAX_COUNT = 20
const DEFAULT_TIMEOUT_MS = 15_000
// Required. Without a browser-ish UA the same request answers HTTP 202 with a
// different page — no `result__a` rows at all, and the words "anomaly" and
// "challenge" in the body — so the parser would return an empty list.
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

// A hand-written narrowing to the members the parser touches, so this file does
// not depend on linkedom's exported DOM types. html-clean.ts narrows the same way.
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
    const url = `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`

    try {
        return await httpRequest(
            url,
            {
                timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                ...(opts.signal === undefined ? {} : {signal: opts.signal}),
                ...(opts.fetchImpl === undefined ? {} : {fetchImpl: opts.fetchImpl}),
                method: 'GET',
                headers: {
                    'user-agent': USER_AGENT,
                    accept: 'text/html'
                }
            },
            async response => {
                // 429 and 403 both mean throttling here, so they share one `kind` and
                // one message rather than falling into the generic HTTP branch.
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
            }
        )
    } catch (err) {
        if (err instanceof HttpRequestError) {
            throw err.kind === 'aborted' ?
                    new DdgSearchError('Search aborted.', 'aborted')
                :   new DdgSearchError(`DuckDuckGo request failed: ${err.detail}`, 'network')
        }
        throw err
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
        // A row whose link never leaves duckduckgo.com is an ad or a module, not a
        // hit. This also drops an `l/?` href carrying no `uddg`, and one whose
        // `uddg` does not decode to a URL.
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
 * Result hrefs look like `//duckduckgo.com/l/?uddg=<encoded-destination>&rut=…`.
 * Returns the decoded destination, a non-DDG href unchanged, or null for a link
 * that stays on duckduckgo.com — no `uddg`, an undecodable one, or an unparseable
 * href.
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
