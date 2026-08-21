/**
 * Web search via Exa's public MCP endpoint — no API key required.
 *
 * Exa hosts https://mcp.exa.ai/mcp as an intentionally keyless entry point: a
 * single JSON-RPC `tools/call` of `web_search_exa` returns search results with
 * content snippets. The response is SSE-framed (`data:` lines) or plain JSON,
 * and the result payload is one text blob of `Title:`/`URL:`/`Text:` blocks
 * separated by `---`, which we parse back into structured results.
 */

import {httpRequest, HttpRequestError, type FetchLike} from './http-request.js'
import type {SearchResult} from './search-types.js'

const EXA_MCP_ENDPOINT = 'https://mcp.exa.ai/mcp'
const DEFAULT_COUNT = 10
const MAX_COUNT = 20
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_DESCRIPTION_CHARS = 400

// `FetchLike` is the request seam's (http-request.ts); re-exported because
// ddg-search and several tests import it from here.
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

/** The Exa-specific half: its argv, its status policy, its error type. */
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
 * The endpoint answers either as a text/event-stream (`data: {json}` lines) or
 * as a plain JSON body; accept both and take the first frame carrying a
 * JSON-RPC result or error.
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
 * (snippet mode); either becomes the description, whitespace-collapsed and
 * capped so a result line stays a snippet, not a page dump.
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
