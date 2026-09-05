/**
 * Research enrichment — extract package names, URLs and named external services
 * from text so the orchestrator can fan out lookups before the research phase.
 *
 * Everything here is order-preserving and deduped. Run on a mixed input: the
 * denylisted shell names are dropped, a URL's trailing sentence punctuation is
 * stripped, docs targets stop at ENRICH_CAP while version targets continue to
 * ENRICH_VERSION_CAP, and the version list is a strict superset of the docs list.
 *
 * Package extraction is additionally gated on the caller's declared dependencies;
 * see the `declared` parameter on {@link extractEnrichTargets}.
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
// Two different caps because the two lookups cost very different things. A docs
// or URL fetch is a worker spawn plus a page fetch, so those stay at ENRICH_CAP.
// A live npm VERSION lookup is one cheap registry GET, so it can cover far more:
// every dependency a task explicitly names should get a grounded latest-version
// block, not just the first ENRICH_CAP of them.
//
// With a single cap, a task naming several runtime deps leaves the later ones with
// no live version at all, and a question about one of them falls back to whatever
// the model remembers.
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
        // A repeated EXTERNAL-DEPENDENCIES line is not a section terminator: the
        // model sometimes emits the header twice in a row, and treating the second
        // one as the end would drop every bullet under it. Skip it and keep
        // reading. Any OTHER all-caps header still ends the section, and so does a
        // blank line — both confirmed.
        if (trimmed === ENRICH_SERVICE_HEADER) continue
        if (ENRICH_HEADER_LINE_RE.test(trimmed)) break
        const m = line.match(ENRICH_SERVICE_BULLET_RE)
        if (!m) continue
        const name = m[1].trim()
        // Dedupe by name, case-insensitively, because the model duplicates bullets
        // as well as headers. The FIRST occurrence's query is kept, and only
        // uniques count against the cap — so a duplicate cannot crowd out a real
        // service. Confirmed: `Stripe` and a later `stripe` collapse to one entry
        // carrying the first query.
        const key = name.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push({name, query: m[2].trim()})
        if (out.length >= ENRICH_CAP) break
    }
    return out
}

export function extractEnrichTargets(
    text: string,
    /**
     * The project's declared dependencies. A backticked name outside this set is
     * not enriched: the model backticks filenames (`config.ts`, `tsconfig.json`)
     * and field names (`name`, `port`) far more often than package names, and each
     * of those is also a real, unrelated package on the public registry — so the
     * permissive read fetched and indexed a stranger's code under the project's
     * own filename. Omit when the manifest is unreadable, which is not the same
     * fact as "declares nothing".
     */
    declared?: ReadonlySet<string>
): {
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
        if (declared && !declared.has(t)) continue
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
