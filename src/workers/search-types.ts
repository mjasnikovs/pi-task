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

/**
 * Human-readable engine names for the config UI. The short ids stay the stored
 * value (config-file compat); only the display layer uses these.
 */
export const SEARCH_PROVIDER_LABELS: Record<SearchProvider, string> = {
    exa: 'Exa',
    ddg: 'DuckDuckGo',
    brave: 'Brave'
}

export function providerForLabel(label: string): SearchProvider | undefined {
    return SEARCH_PROVIDERS.find(p => SEARCH_PROVIDER_LABELS[p] === label)
}

export function isSearchProvider(value: unknown): value is SearchProvider {
    return typeof value === 'string' && (SEARCH_PROVIDERS as readonly string[]).includes(value)
}
