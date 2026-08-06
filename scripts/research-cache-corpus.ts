/**
 * The three research caches on this box, parsed into typed lookups.
 *
 * A cache entry is keyed `<tool>\0<toolCacheKey>` (see makeWorkerTool). The three tools
 * build their own key shape:
 *   pi-worker-fetch   `${url}::${normalizeQuery(query)}`
 *   pi-worker-search  `${provider}::${normalizeQuery(query)}::${count ?? ''}`
 *   pi-worker-docs    `${pkg}::${normalizeQuery(query)}`
 *
 * ── WHAT A COUNT FROM HERE DOES AND DOES NOT MEAN ────────────────────────────────────────
 * Three projects, and mx5 is dominant (190 of 269 entries). Any rate computed over this
 * corpus is a rate over ONE project plus two small ones, and must be reported that way.
 * A cache HIT writes no entry, so every count here is a LOWER BOUND on the lookups the
 * runs actually issued — never report one as "the number of fetches".
 *
 * Reading is deliberately tolerant: entries written by older versions carry fewer
 * `details` fields (IAR1 predates `coverageMiss`), and a field that was never written is
 * `undefined`, never `false`.
 */
import * as fs from 'node:fs'

export const CORPUS_PATHS: Array<{project: string; path: string}> = [
    {project: 'mx5', path: `${process.env.HOME}/hub/mx5/.pi-tasks/research-cache.json`},
    {project: 'IAR1', path: `${process.env.HOME}/hub/IAR1/.pi-tasks/research-cache.json`},
    {project: 'gofer-pixel', path: `${process.env.HOME}/hub/gofer-pixel/.pi-tasks/research-cache.json`}
]

export interface FetchDetails {
    childExitCode?: number
    answer?: string
    excerpt?: string
    excerptVerified?: boolean
    /** Absent in entries written before the coverage-miss channel existed. */
    coverageMiss?: boolean
    anchoredSection?: string
}

export type LookupKind = 'fetch' | 'search' | 'docs'

export interface Lookup {
    project: string
    kind: LookupKind
    /** Epoch ms the entry was written. */
    at: number
    /** fetch: the URL. search: the provider. docs: the package. */
    subject: string
    /** The normalised query the tool was asked. */
    query: string
    /** The tool's returned text — for search, the numbered result list. */
    text: string
    details: FetchDetails & Record<string, unknown>
}

interface RawEntry {
    text?: string
    details?: Record<string, unknown>
    at?: number
    pkg?: string
}

/** Split `<subject>::<query>` — the query itself may contain `::`, the subject may not. */
function splitOnce(s: string): [string, string] {
    const i = s.indexOf('::')
    return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 2)]
}

export function loadCorpus(paths = CORPUS_PATHS): Lookup[] {
    const out: Lookup[] = []
    for (const {project, path: p} of paths) {
        let raw: string
        try {
            raw = fs.readFileSync(p, 'utf8')
        } catch {
            continue
        }
        const parsed = JSON.parse(raw) as {entries?: Record<string, RawEntry>}
        for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
            const nul = key.indexOf('\0')
            if (nul === -1) continue
            const tool = key.slice(0, nul)
            const rest = key.slice(nul + 1)
            const kind: LookupKind | undefined =
                tool === 'pi-worker-fetch' ? 'fetch'
                : tool === 'pi-worker-search' ? 'search'
                : tool === 'pi-worker-docs' ? 'docs'
                : undefined
            if (!kind) continue
            const [subject, tail] = splitOnce(rest)
            // search appends `::${count ?? ''}`; strip that trailing field, not the query.
            const query = kind === 'search' ? tail.replace(/::[^:]*$/, '') : tail
            out.push({
                project,
                kind,
                at: entry.at ?? 0,
                subject,
                query,
                text: entry.text ?? '',
                details: (entry.details ?? {}) as FetchDetails & Record<string, unknown>
            })
        }
    }
    return out.sort((a, b) => a.at - b.at)
}

/** One line stating the corpus shape. Print it beside every rate, per the lead's NEVER list. */
export function corpusCaveat(lookups: Lookup[]): string {
    const byProject = new Map<string, number>()
    for (const l of lookups) byProject.set(l.project, (byProject.get(l.project) ?? 0) + 1)
    const parts = [...byProject.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${p} ${n}`)
        .join(', ')
    return (
        `corpus: 3 projects, one dominant (${parts}). A cache HIT writes no entry, so every `
        + `count below is a LOWER BOUND on the lookups the runs issued.`
    )
}

// ── Search-result parsing ────────────────────────────────────────────────────────────────

export interface SearchResult {
    rank: number
    title: string
    url: string
    snippet: string
}

const RESULT_RE = /^(\d+)\.\s+\[([^\]]*)\]\(([^)]+)\)(?:\s+—\s+([\s\S]*))?$/

/** The numbered `N. [title](url) — snippet` list pi-worker-search returns as TEXT. */
export function parseSearchResults(text: string): SearchResult[] {
    const out: SearchResult[] = []
    for (const line of text.split('\n')) {
        const m = RESULT_RE.exec(line.trim())
        if (!m) continue
        out.push({rank: Number(m[1]), title: m[2], url: m[3], snippet: (m[4] ?? '').trim()})
    }
    return out
}

/** A fetch that produced no usable answer: the coverage channel, the unclear channel, or nothing. */
export function isNonAnswer(d: FetchDetails): boolean {
    const a = (d.answer ?? '').trim().toLowerCase()
    if (a.length === 0) return true
    if (d.coverageMiss === true) return true
    return a.startsWith('not covered by this page') || a.startsWith('unclear from this page')
}
