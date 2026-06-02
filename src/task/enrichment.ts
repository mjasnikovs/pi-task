/**
 * Research enrichment — extract package names and URLs from text so the
 * orchestrator can fan out docs/URL lookups before the research phase.
 */

const ENRICH_PKG_RE = /`((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)`/g
const ENRICH_URL_RE = /https?:\/\/[^\s)`>]+/g
const ENRICH_DENYLIST = new Set([
    'bun',
    'node',
    'npm',
    'pnpm',
    'yarn',
    'git',
    'sh',
    'bash',
    'cd',
    'ls',
    'cat',
    'grep',
    'find',
    'rm'
])
const ENRICH_CAP = 3
const ENRICH_SERVICE_HEADER = 'EXTERNAL-DEPENDENCIES'
const ENRICH_HEADER_LINE_RE = /^[A-Z][A-Z0-9 -]+$/
const ENRICH_SERVICE_BULLET_RE = /^\s*-\s+(.+?)\s{2,}(.+?)\s*$/

function parseServices(text: string): Array<{name: string; query: string}> {
    const lines = text.split('\n')
    const startIdx = lines.findIndex(l => l.trim() === ENRICH_SERVICE_HEADER)
    if (startIdx === -1) return []
    const out: Array<{name: string; query: string}> = []
    const seen = new Set<string>()
    for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i]
        const trimmed = line.trim()
        if (trimmed === '') break
        // The refine model sometimes emits the section header twice in a row.
        // A repeated EXTERNAL-DEPENDENCIES line is not a section terminator —
        // skip it and keep reading bullets. Any *other* all-caps header still
        // ends the section.
        if (trimmed === ENRICH_SERVICE_HEADER) continue
        if (ENRICH_HEADER_LINE_RE.test(trimmed)) break
        const m = line.match(ENRICH_SERVICE_BULLET_RE)
        if (!m) continue
        const name = m[1].trim()
        // Dedupe by name (case-insensitive); the model also duplicates bullets.
        // Keep the first occurrence's query and count uniques against the cap.
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({name, query: m[2].trim()})
        if (out.length >= ENRICH_CAP) break
    }
    return out
}

export function extractEnrichTargets(text: string): {
    packages: string[]
    urls: string[]
    services: Array<{name: string; query: string}>
} {
    const pkgs = new Set<string>()
    for (const m of text.matchAll(ENRICH_PKG_RE)) {
        const t = m[1]
        if (ENRICH_DENYLIST.has(t)) continue
        pkgs.add(t)
        if (pkgs.size >= ENRICH_CAP) break
    }
    const urls = new Set<string>()
    for (const m of text.matchAll(ENRICH_URL_RE)) {
        const u = m[0].replace(/[.,;:!?]+$/, '')
        urls.add(u)
        if (urls.size >= ENRICH_CAP) break
    }
    const services = parseServices(text)
    return {packages: [...pkgs], urls: [...urls], services}
}
