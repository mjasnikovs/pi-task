import type {BraveResult} from '../workers/brave-search.js'

export function formatServiceBlock(
    name: string,
    fullQuery: string,
    results: BraveResult[]
): string {
    const header = `### service: ${name}\nQuery: ${fullQuery}`
    if (results.length === 0) return header
    const bullets = results.map(r => `- **${r.title}** — ${r.url}\n  ${r.description}`).join('\n')
    return `${header}\n${bullets}`
}

export function formatFreshnessSkippedBlock(names: string[]): string {
    return `### freshness-check skipped\nCould not verify external services (BRAVE_SEARCH_API_KEY not set):\n${names.map(n => `- ${n}`).join('\n')}`
}
