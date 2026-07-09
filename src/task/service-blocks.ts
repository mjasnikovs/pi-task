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

// Only the brave provider can be unconfigured (exa/ddg are keyless), so the
// skip reason names its missing key directly.
export function formatFreshnessSkippedBlock(names: string[]): string {
    return `### freshness-check skipped\nCould not verify external services (search provider is brave but BRAVE_SEARCH_API_KEY is not set):\n${names.map(n => `- ${n}`).join('\n')}`
}
