/**
 * Web search via Exa's public MCP endpoint. No API key: search-types.ts gives
 * `exa` an empty env-var list, and the endpoint answers an unauthenticated POST.
 *
 * One JSON-RPC `tools/call` of `web_search_exa` against https://mcp.exa.ai/mcp
 * returns the results. The response comes back `text/event-stream` — an
 * `event: message` line and one `data:` frame — and `parseRpcBody` also accepts a
 * plain JSON body. Inside the RPC result is a single text blob of blocks
 * separated by `---`, each carrying `Title:`, `URL:`, and then either a `Text:`
 * label or a `Highlights:` line. `parseResultBlocks` turns that back into
 * structured results.
 */

import {httpRequest, HttpRequestError, type FetchLike} from './http-request.js'
import type {SearchResult} from './search-types.js'

const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp'
const DEFAULT_COUNT = 10
const MAX_COUNT = 20
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_DESCRIPTION_CHARS = 400

// `FetchLike` belongs to the request seam (http-request.ts). Re-exported because
// ddg-search.test.ts and exa-search.test.ts import the type from here; the
// ddg-search MODULE takes it straight from http-request.
export type {FetchLike}

export interface ExaSearchOpts {
    count?: number
    timeoutMs?: number
    signal?: AbortSignal
    fetchImpl?: FetchLike
}

export class ExaSearchError extends Error {
    constructor(
        message: string,
        public readonly kind: 'http' | 'network' | 'aborted' | 'protocol',
        public readonly status?: number
    ) {
        super(message)
        this.name = 'ExaSearchError'
    }
}

interface ExaMcpRpcResponse {
    result?: {
        content?: Array<{type?: string; text?: string}>
        isError?: boolean
    }
    error?: {code?: number; message?: string}
}

export async function exaSearch(query: string, opts: ExaSearchOpts = {}): Promise<SearchResult[]> {
    const count = Math.max(1, Math.min(MAX_COUNT, opts.count ?? DEFAULT_COUNT))

    return await request(
        {
            timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ...(opts.signal === undefined ? {} : {signal: opts.signal}),
            ...(opts.fetchImpl === undefined ? {} : {fetchImpl: opts.fetchImpl})
        },
        count,
        query
    )
}

/** The Exa-specific half: the JSON-RPC body it posts, its status policy, and its
 *  error type. Every failure leaves here as an ExaSearchError — `http` for a
 *  non-2xx, `protocol` for an RPC error / an `isError` result / no text content /
 *  an unparseable body, and `network` or `aborted` for a transport fault. */
async function request(
    bounds: {timeoutMs: number; signal?: AbortSignal; fetchImpl?: FetchLike},
    count: number,
    query: string
): Promise<SearchResult[]> {
    try {
        return await httpRequest(
            EXA_MCP_ENDPOINT,
            {
                ...bounds,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream'
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'web_search_exa',
                        arguments: {
                            query,
                            numResults: count,
                            type: 'auto',
                            livecrawl: 'fallback',
                            contextMaxCharacters: 3000
                        }
                    }
                })
            },
            async response => {
                if (!response.ok) {
                    throw new ExaSearchError(
                        `Exa search HTTP ${response.status} ${response.statusText}`,
                        'http',
                        response.status
                    )
                }

                const rpc = parseRpcBody(await response.text())
                if (rpc.error) {
                    throw new ExaSearchError(
                        `Exa MCP error${rpc.error.code !== undefined ? ` ${rpc.error.code}` : ''}: ${rpc.error.message ?? 'unknown error'}`,
                        'protocol'
                    )
                }
                const text = rpc.result?.content?.find(
                    c => c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0
                )?.text
                if (rpc.result?.isError) {
                    throw new ExaSearchError(
                        text?.trim() || 'Exa MCP returned an error result.',
                        'protocol'
                    )
                }
                if (!text) throw new ExaSearchError('Exa MCP returned no text content.', 'protocol')

                return parseResultBlocks(text).slice(0, count)
            }
        )
    } catch (err) {
        if (err instanceof HttpRequestError) {
            throw err.kind === 'aborted' ?
                    new ExaSearchError('Search aborted.', 'aborted')
                :   new ExaSearchError(`Exa search request failed: ${err.detail}`, 'network')
        }
        throw err
    }
}

/**
 * The endpoint answers as a text/event-stream (`data: {json}` lines) in practice,
 * but a plain JSON body parses too. Take the FIRST `data:` frame that carries a
 * JSON-RPC `result` or `error` — frames without either (a bare
 * `{"jsonrpc":"2.0"}`) are skipped, not treated as the answer.
 */
function parseRpcBody(body: string): ExaMcpRpcResponse {
    for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload) continue
        try {
            const candidate = JSON.parse(payload) as ExaMcpRpcResponse
            if (candidate.result || candidate.error) return candidate
        } catch {
            /* not this frame */
        }
    }
    try {
        const candidate = JSON.parse(body) as ExaMcpRpcResponse
        if (candidate.result || candidate.error) return candidate
    } catch {
        /* fall through */
    }
    throw new ExaSearchError('Exa MCP returned an unparseable response.', 'protocol')
}

/**
 * Split the tool's text payload into `Title:`/`URL:` blocks. The per-result
 * content lives after a `Text:` label (full text) or a `Highlights:` line
 * (snippet mode); either becomes the description, whitespace-collapsed, its
 * trailing `---` removed, and capped at MAX_DESCRIPTION_CHARS so a result line
 * stays a snippet, not a page dump.
 *
 * A block with no `URL:` is dropped entirely. A block with an empty `Title:`
 * keeps the URL as its title, so a result is never nameless.
 */
function parseResultBlocks(text: string): SearchResult[] {
    const blocks = text.split(/(?=^Title: )/m).filter(b => b.trim().length > 0)
    const results: SearchResult[] = []
    for (const block of blocks) {
        const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? ''
        const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? ''
        if (!url) continue

        let content = ''
        const textStart = block.indexOf('\nText: ')
        if (textStart >= 0) {
            content = block.slice(textStart + '\nText: '.length)
        } else {
            const highlights = block.match(/\nHighlights:[ \t]*\n/)
            if (highlights?.index !== undefined) {
                content = block.slice(highlights.index + highlights[0].length)
            }
        }
        const description = content
            .replace(/\n---\s*$/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, MAX_DESCRIPTION_CHARS)

        results.push({title: title || url, url, description})
    }
    return results
}
