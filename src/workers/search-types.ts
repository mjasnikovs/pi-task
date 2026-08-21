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
 * The API-key env vars an engine needs, in lookup order. Empty = keyless.
 *
 * Declared beside the engine ids rather than inside `search()`, because two
 * places ask the question: the search itself, and `searchConfigured` in
 * phases.ts, which decides whether the APIS research worker is even given the
 * search tool. That second copy was a hand-written re-statement of brave's env
 * pair with a comment saying it "mirrors search-core's lookup" — the shape a
 * table exists to make impossible.
 */
export const SEARCH_PROVIDER_KEY_ENV: Record<SearchProvider, readonly string[]> = {
    exa: [],
    ddg: [],
    brave: ['BRAVE_SEARCH_API_KEY', 'BRAVE_API_KEY']
}

/** The engine's key, or `null` when it needs one and none is set. `''` = keyless. */
export function searchProviderKey(
    provider: SearchProvider,
    getEnv: (k: string) => string | undefined
): string | null {
    const vars = SEARCH_PROVIDER_KEY_ENV[provider]
    if (vars.length === 0) return ''
    for (const v of vars) {
        const value = getEnv(v)
        if (value) return value
    }
    return null
}

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
