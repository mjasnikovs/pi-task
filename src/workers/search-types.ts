/** One web-search hit, in the shape every provider normalises to. */
export interface SearchResult {
    title: string
    url: string
    description: string
}

/**
 * Which engine backs pi-worker-search and the freshness/enrichment lookups.
 * - `exa`   — Exa's public MCP endpoint; no key needed (default).
 * - `ddg`   — DuckDuckGo's HTML endpoint; no key needed.
 * - `brave` — Brave Search API; needs BRAVE_SEARCH_API_KEY.
 */
export type SearchProvider = 'exa' | 'ddg' | 'brave'

export const SEARCH_PROVIDERS: readonly SearchProvider[] = ['exa', 'ddg', 'brave']

export function isSearchProvider(value: unknown): value is SearchProvider {
    return typeof value === 'string' && (SEARCH_PROVIDERS as readonly string[]).includes(value)
}
