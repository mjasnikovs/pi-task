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
import * as path from 'node:path'

/**
 * A pinned copy of the caches, preferred over the live ones when present.
 *
 * Written because the corpus is NOT stable: ~/hub/gofer-pixel/.pi-tasks was emptied by
 * something outside this work at 15:38 on 2026-08-06, mid-task, taking 18 entries (12
 * fetches, 2 searches) with it. Numbers measured before that moment could no longer be
 * reproduced from the live trees, which makes every result on this corpus unauditable.
 * Rebuild with `bun run scripts/research-cache-corpus.ts --snapshot`.
 */
export const SNAPSHOT = path.join(import.meta.dir, 'fixtures', 'research-cache-corpus.json')

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

/** project -> the cache's `entries` map, as snapshotted. */
type Snapshot = {snapshotAt: string; projects: Record<string, Record<string, RawEntry>>}

function readSources(paths: Array<{project: string; path: string}>): Snapshot {
    const projects: Record<string, Record<string, RawEntry>> = {}
    for (const {project, path: p} of paths) {
        let raw: string
        try {
            raw = fs.readFileSync(p, 'utf8')
        } catch {
            continue
        }
        projects[project] = (JSON.parse(raw) as {entries?: Record<string, RawEntry>}).entries ?? {}
    }
    return {snapshotAt: new Date().toISOString(), projects}
}

export function writeSnapshot(paths = CORPUS_PATHS): Snapshot {
    const snap = readSources(paths)
    fs.mkdirSync(path.dirname(SNAPSHOT), {recursive: true})
    fs.writeFileSync(SNAPSHOT, JSON.stringify(snap), 'utf8')
    return snap
}

export function loadCorpus(paths = CORPUS_PATHS): Lookup[] {
    const out: Lookup[] = []
    const snap: Snapshot =
        fs.existsSync(SNAPSHOT) ?
            (JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) as Snapshot)
        :   readSources(paths)
    for (const [project, entries] of Object.entries(snap.projects)) {
        for (const [key, entry] of Object.entries(entries)) {
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
        `corpus: ${byProject.size} project(s), one dominant (${parts}). A cache HIT writes no entry, `
        + `so every count below is a LOWER BOUND on the lookups the runs issued. `
        + `gofer-pixel (18 entries) was in this corpus until its tree was emptied at 15:38 on `
        + `2026-08-06, outside this work; numbers taken before then covered 3 projects.`
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

if (import.meta.main && process.argv.includes('--snapshot')) {
    const snap = writeSnapshot()
    const n = Object.values(snap.projects).reduce((a, e) => a + Object.keys(e).length, 0)
    console.log(`wrote ${SNAPSHOT}`)
    for (const [p, e] of Object.entries(snap.projects)) console.log(`  ${p}: ${Object.keys(e).length}`)
    console.log(`  ${n} entries total, at ${snap.snapshotAt}`)
}

/** A fetch that produced no usable answer: the coverage channel, the unclear channel, or nothing. */
export function isNonAnswer(d: FetchDetails): boolean {
    const a = (d.answer ?? '').trim().toLowerCase()
    if (a.length === 0) return true
    if (d.coverageMiss === true) return true
    return a.startsWith('not covered by this page') || a.startsWith('unclear from this page')
}
