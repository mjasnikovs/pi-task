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
// Heavy docs/url fetches stay capped at ENRICH_CAP (each is a worker spawn +
// page fetch). A live npm VERSION lookup is just one cheap registry GET, so it
// can cover far more packages — every dependency a task explicitly names should
// get a grounded latest-version block, not just the first ENRICH_CAP of them. A
// a task naming several runtime deps leaves the later ones (e.g. tailwindcss)
// with NO live version, so a version question fell back to stale training data.
const ENRICH_VERSION_CAP = 12
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
    /** Packages that get a (heavy) docs fetch — capped at ENRICH_CAP. */
    packages: string[]
    /**
     * Every named package, up to ENRICH_VERSION_CAP, for a cheap live npm version
     * lookup. A superset of `packages`; the extras get a version block only (no
     * docs body). Order-preserving and deduped, same as `packages`.
     */
    versionPackages: string[]
    urls: string[]
    services: Array<{name: string; query: string}>
} {
    const pkgs: string[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(ENRICH_PKG_RE)) {
        const t = m[1]
        if (ENRICH_DENYLIST.has(t) || seen.has(t)) continue
        seen.add(t)
        pkgs.push(t)
        if (pkgs.length >= ENRICH_VERSION_CAP) break
    }
    const urls = new Set<string>()
    for (const m of text.matchAll(ENRICH_URL_RE)) {
        const u = m[0].replace(/[.,;:!?]+$/, '')
        urls.add(u)
        if (urls.size >= ENRICH_CAP) break
    }
    const services = parseServices(text)
    return {packages: pkgs.slice(0, ENRICH_CAP), versionPackages: pkgs, urls: [...urls], services}
}
