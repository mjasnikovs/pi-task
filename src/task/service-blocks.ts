import type {SearchResult} from '../workers/search-types.js'

export function formatServiceBlock(
    name: string,
    fullQuery: string,
    results: SearchResult[]
): string {
    const header = `### service: ${name}\nQuery: ${fullQuery}`
    if (results.length === 0) return header
    const bullets = results.map(r => `- **${r.title}** — ${r.url}\n  ${r.description}`).join('\n')
    return `${header}\n${bullets}`
}

// Only brave can be unconfigured: `SEARCH_PROVIDER_KEY_ENV` (search-types.ts)
// lists no env var for exa or ddg, so `searchProviderKey` answers '' for them and
// the `no_key` result this block reports is unreachable. The reason therefore
// names brave's key outright rather than describing a generic misconfiguration.
export function formatFreshnessSkippedBlock(names: string[]): string {
    return `### freshness-check skipped\nCould not verify external services (search provider is brave but BRAVE_SEARCH_API_KEY is not set):\n${names.map(n => `- ${n}`).join('\n')}`
}
