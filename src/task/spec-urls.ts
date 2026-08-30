/**
 * The design document's own cited URLs, ranked as fetch candidates for the APIS
 * research worker.
 *
 * A design that names its references by URL has already chosen which pages
 * document the packages it uses. Nothing makes a research worker prefer them: it
 * searches, and lands wherever the search lands. This module extracts the cited
 * URLs, keeps the ones documenting a package THIS task touches, and renders them
 * as a ranked prompt block.
 *
 * RANKING, NOT REPLACING. The block says the cited pages outrank a page the model
 * would pick itself, and says in terms that they are not the only pages it may
 * fetch. A worker that can no longer follow a question off the design's reference
 * list has been narrowed, not improved.
 *
 * NOT WIRED. `buildSpecUrlBlock` has no production caller — phases.ts says so at
 * the site where it would go. The module is kept deterministic and unit-tested
 * against real design text so the experiment can be re-run cheaply, but nothing in
 * a run reads it today.
 */

/** Never candidates: a local dev URL is not documentation. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.local)$/i
const PLACEHOLDER_HOST = /^(example\.(com|org|net)|your-.*|<.*)$/i

/**
 * How many cited pages the block may name. A design's whole reference list, repeated in
 * every APIS prompt, is prefill spent on pages the task has no use for, and a list long
 * enough to skim past is a list the model ignores. The ranking already drops every URL
 * documenting nothing this task touches, so this only bounds a task that touches a lot.
 */
export const MAX_SPEC_URLS = 8

/** http(s) URLs in a text, deduped, with local and placeholder hosts dropped. */
export function extractSpecUrls(text: string): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of text.match(/https?:\/\/[^\s)>`"']+/g) ?? []) {
        // Trailing sentence punctuation is not part of the URL; a #fragment and a query are.
        const url = raw.replace(/[.,;:]+$/, '')
        if (seen.has(url)) continue
        let host: string
        try {
            host = new URL(url).hostname
        } catch {
            continue
        }
        if (LOCAL_HOST.test(host) || PLACEHOLDER_HOST.test(host)) continue
        seen.add(url)
        out.push(url)
    }
    return out
}

/**
 * Tokens of a package specifier that could plausibly appear in its documentation URL: the
 * root name plus every scope/path/hyphen segment. `hono/client` ⇒ {hono, client};
 * `@hono/zod-validator` ⇒ {hono, zod, validator, zod-validator}. Segments of TWO characters or
 * fewer are dropped — `pg` would match half the documentation web. Three is the floor rather
 * than four because `zod` is a real dependency with a real cited page (zod.dev), and a rule
 * that silently drops it is a rule that silently drops reach.
 */
export function packageTokens(pkg: string): string[] {
    const m = pkg.toLowerCase().trim()
    if (m === '.' || m.length === 0) return []
    const out = new Set<string>()
    for (const seg of m.split('/').filter(Boolean)) {
        const bare = seg.replace(/^@/, '')
        if (bare.length > 2) out.add(bare)
        for (const part of bare.split('-')) if (part.length > 2) out.add(part)
    }
    return [...out]
}

/**
 * Does this cited URL document this package? Host OR path, deliberately: wouter's page is
 * github.com/molefrog/wouter#readme and @hono/zod-validator's is
 * github.com/honojs/middleware/tree/main/packages/zod-validator — both real associations that
 * live in the path, and a host-only rule matches neither.
 */
export function urlDocumentsPackage(url: string, pkg: string): boolean {
    const toks = packageTokens(pkg)
    if (toks.length === 0) return false
    let scope: string
    try {
        const u = new URL(url)
        scope = `${u.hostname} ${u.pathname}`
    } catch {
        return false
    }
    const inUrl = new Set(
        scope
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
    )
    return toks.some(t => inUrl.has(t))
}

export interface RankedSpecUrl {
    url: string
    /** The packages this URL documents, in the order they were supplied. */
    packages: string[]
}

/**
 * Cited URLs that document a package this task touches, most relevant first.
 *
 * `packages` is ordered by relevance by the CALLER — the task's own named dependencies
 * before the rest of the manifest — and a URL inherits the rank of the earliest package it
 * documents. A URL documenting no supplied package is dropped entirely rather than ranked
 * last: the design cites pages for the whole project, and a task about the router has no use
 * for the image-processing reference.
 */
export function rankSpecUrls(urls: string[], packages: string[]): RankedSpecUrl[] {
    const ranked: Array<{r: RankedSpecUrl; rank: number}> = []
    for (const url of urls) {
        const matched = packages.filter(p => urlDocumentsPackage(url, p))
        if (matched.length === 0) continue
        ranked.push({r: {url, packages: matched}, rank: packages.indexOf(matched[0])})
    }
    ranked.sort((a, b) => a.rank - b.rank || a.r.url.localeCompare(b.r.url))
    return ranked.slice(0, MAX_SPEC_URLS).map(x => x.r)
}

/**
 * The prompt block, or '' when nothing is cited for anything this task uses.
 */
export function buildSpecUrlBlock(urls: string[], packages: string[]): string {
    const ranked = rankSpecUrls(urls, packages)
    if (ranked.length === 0) return ''
    // Grouped under the package rather than one package-name-per-URL: five consecutive lines
    // reading "hono" is the shape a reader — and a small model — skims past, and the grouping
    // is also what makes the ranking legible as a ranking.
    const byPackage = new Map<string, string[]>()
    for (const r of ranked) {
        const key = r.packages[0]
        byPackage.set(key, [...(byPackage.get(key) ?? []), r.url])
    }
    const rows = [...byPackage]
        .map(([pkg, us]) => `  ${pkg}\n${us.map(u => `      ${u}`).join('\n')}`)
        .join('\n')
    return (
        "SPEC-CITED DOCUMENTATION — this project's own design document names these pages, by "
        + "URL, for packages this task uses. They are the project's chosen references, so they "
        + 'OUTRANK any page you would pick from a search result.\n'
        + 'WHEN TO USE THEM: the moment a `pi-worker-docs` answer for one of these packages '
        + 'does not actually answer your question — including when it hands you a type '
        + 'signature instead of behaviour — call `pi-worker-fetch(<the URL below>)` and re-ask '
        + 'the same question. Do NOT search for a page first, and do NOT fill the gap from '
        + 'memory.\n'
        + `${rows}\n`
        + 'NOT AN ALLOW-LIST: these are ranked first, not exclusive. If your question is about '
        + 'something these pages do not cover, use pi-worker-search / pi-worker-fetch on '
        + 'whatever page does.\n\n'
    )
}

/**
 * The manifest dependencies this task's refined text actually names — the relevance signal
 * the ranking needs, and the reason the block does not simply list every cited URL.
 *
 * WHY NOT extractEnrichTargets (enrichment.ts). That parser is tuned for the
 * EXTERNAL-DEPENDENCIES section, so over an ordinary refined text it returns whatever
 * identifiers and config filenames the prose mentions rather than the packages the task is
 * about. The manifest is the authoritative list of what the project actually depends on;
 * matching it against the task text is deterministic and cannot be fooled by prose.
 *
 * Word-boundary matched, so `react` does not match inside `react-dom` or `@types/react`, and
 * a package genuinely named twice is still listed once.
 */
export function mentionedPackages(refined: string, manifest: string[]): string[] {
    const text = refined.toLowerCase()
    const out: string[] = []
    for (const dep of manifest) {
        const d = dep.toLowerCase()
        const esc = d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(^|[^a-z0-9@/._-])${esc}([^a-z0-9-]|$)`, 'i').test(text)) out.push(dep)
    }
    return out
}
