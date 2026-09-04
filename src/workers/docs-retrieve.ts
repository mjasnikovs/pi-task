import type {CacheHandle} from './docs-cache.js'

export interface RetrievedChunk {
    filePath: string
    kind: 'dts' | 'readme'
    content: string
    rank: number
}

export interface RetrieveOptions {
    /** Registry scope of the rows to search, or the project-source scope. */
    ecosystem: string
    name: string
    version: string
    query: string
    limit?: number
    contentBudget?: number
}

/**
 * How many chunks a retrieval returns, per corpus. An npm package gets 8 and
 * project source gets 50.
 *
 * Nothing in this repo records WHY they differ. They are stated here, together,
 * so the divergence is at least visible — and changing either is a
 * retrieval-policy change, not a tidy-up.
 */
export const PACKAGE_RETRIEVE_LIMIT = 8
export const PROJECT_RETRIEVE_LIMIT = 50

/** Character budget for the assembled chunk text. The same for both corpora. */
export const RETRIEVE_CONTENT_BUDGET = 24_000

// Both callers pass `limit` and `contentBudget` explicitly — docs-core with the
// package pair, docs-project with the project pair — so these defaults are only a
// backstop for a third caller that does not.
const DEFAULT_LIMIT = PROJECT_RETRIEVE_LIMIT
const DEFAULT_BUDGET = RETRIEVE_CONTENT_BUDGET
const MIN_TOKEN_LEN = 2
const FALLBACK_DTS_CHARS = 12_000
const FALLBACK_README_CHARS = 4_000

interface ChunkRow {
    file_path: string
    kind: 'dts' | 'readme'
    content: string
    rank: number
}

/**
 * Split on any run of non-identifier characters — NOT on whitespace alone.
 *
 * Splitting on /\s+/ and then stripping punctuation INSIDE each token silently welds
 * multi-part identifiers into one string that occurs nowhere in the corpus:
 *   "src/server/routes/auth.ts"  ->  "srcserverroutesauthts"
 *   "Bun.password.hash"          ->  "Bunpasswordhash"
 * Because buildFtsQuery ORs the tokens, a welded token contributes no MATCH at all.
 * The single most informative term in the query — the path, or the dotted API
 * symbol — is then dropped, and when it was the only term the retrieval falls all
 * the way through to `fallbackChunks`: the alphabetically-first `.d.ts` and the
 * first README, exactly what an empty query returns.
 */
function tokenize(query: string): string[] {
    return query.split(/[^a-zA-Z0-9_]+/).filter(t => t.length >= MIN_TOKEN_LEN)
}

function buildFtsQuery(tokens: string[]): string {
    return tokens.map(t => `"${t}"`).join(' OR ')
}

function fallbackChunks(
    cache: CacheHandle,
    ecosystem: string,
    name: string,
    version: string
): RetrievedChunk[] {
    const dts = cache.db
        .prepare(
            "SELECT file_path, kind, content, 0 AS rank FROM chunks WHERE ecosystem = ? AND name = ? AND version = ? AND kind = 'dts' ORDER BY file_path, id LIMIT 1"
        )
        .all(ecosystem, name, version) as ChunkRow[]
    const readme = cache.db
        .prepare(
            "SELECT file_path, kind, content, 0 AS rank FROM chunks WHERE ecosystem = ? AND name = ? AND version = ? AND kind = 'readme' ORDER BY id LIMIT 1"
        )
        .all(ecosystem, name, version) as ChunkRow[]
    const out: RetrievedChunk[] = []
    for (const r of dts) {
        out.push({
            filePath: r.file_path,
            kind: r.kind,
            content: r.content.slice(0, FALLBACK_DTS_CHARS),
            rank: 0
        })
    }
    for (const r of readme) {
        out.push({
            filePath: r.file_path,
            kind: r.kind,
            content: r.content.slice(0, FALLBACK_README_CHARS),
            rank: 0
        })
    }
    return out
}

/**
 * Trim the chunk list to the character budget, in retrieval order. The FIRST
 * chunk is always kept, whatever its size — a top-ranked chunk larger than the
 * whole budget would otherwise return nothing at all.
 */
function enforceBudget(chunks: RetrievedChunk[], budget: number): RetrievedChunk[] {
    if (!chunks.length) return chunks
    const out: RetrievedChunk[] = []
    let total = 0
    for (const c of chunks) {
        if (out.length === 0) {
            out.push(c)
            total += c.content.length
            continue
        }
        if (total + c.content.length > budget) break
        out.push(c)
        total += c.content.length
    }
    return out
}

export function retrieveChunks(cache: CacheHandle, opts: RetrieveOptions): RetrievedChunk[] {
    const limit = opts.limit ?? DEFAULT_LIMIT
    const budget = opts.contentBudget ?? DEFAULT_BUDGET
    const tokens = tokenize(opts.query)

    if (tokens.length === 0) {
        return enforceBudget(fallbackChunks(cache, opts.ecosystem, opts.name, opts.version), budget)
    }

    const ftsQuery = buildFtsQuery(tokens)
    let rows: ChunkRow[]
    try {
        rows = cache.db
            .prepare(
                `SELECT c.file_path, c.kind, c.content, bm25(chunks_fts) AS rank
                 FROM chunks_fts
                 JOIN chunks c ON c.id = chunks_fts.rowid
                 WHERE c.ecosystem = ?1 AND c.name = ?2 AND c.version = ?3 AND chunks_fts MATCH ?4
                 ORDER BY rank
                 LIMIT ?5`
            )
            .all(opts.ecosystem, opts.name, opts.version, ftsQuery, limit) as ChunkRow[]
    } catch {
        return enforceBudget(fallbackChunks(cache, opts.ecosystem, opts.name, opts.version), budget)
    }

    if (rows.length === 0) {
        return enforceBudget(fallbackChunks(cache, opts.ecosystem, opts.name, opts.version), budget)
    }

    const mapped: RetrievedChunk[] = rows.map(r => ({
        filePath: r.file_path,
        kind: r.kind,
        content: r.content,
        rank: r.rank
    }))
    return enforceBudget(mapped, budget)
}
