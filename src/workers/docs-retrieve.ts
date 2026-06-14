import type {CacheHandle} from './docs-cache.js'

export interface RetrievedChunk {
    filePath: string
    kind: 'dts' | 'readme'
    content: string
    rank: number
}

export interface RetrieveOptions {
    name: string
    version: string
    query: string
    limit?: number
    contentBudget?: number
}

const DEFAULT_LIMIT = 50
const DEFAULT_BUDGET = 24_000
const MIN_TOKEN_LEN = 2
const FALLBACK_DTS_CHARS = 12_000
const FALLBACK_README_CHARS = 4_000

interface ChunkRow {
    file_path: string
    kind: 'dts' | 'readme'
    content: string
    rank: number
}

function tokenize(query: string): string[] {
    return query
        .split(/\s+/)
        .map(t => t.replace(/[^a-zA-Z0-9_]/g, ''))
        .filter(t => t.length >= MIN_TOKEN_LEN)
}

function buildFtsQuery(tokens: string[]): string {
    return tokens.map(t => `"${t}"`).join(' OR ')
}

function fallbackChunks(cache: CacheHandle, name: string, version: string): RetrievedChunk[] {
    const dts = cache.db
        .prepare(
            "SELECT file_path, kind, content, 0 AS rank FROM chunks WHERE name = ? AND version = ? AND kind = 'dts' ORDER BY file_path, id LIMIT 1"
        )
        .all(name, version) as ChunkRow[]
    const readme = cache.db
        .prepare(
            "SELECT file_path, kind, content, 0 AS rank FROM chunks WHERE name = ? AND version = ? AND kind = 'readme' ORDER BY id LIMIT 1"
        )
        .all(name, version) as ChunkRow[]
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
        return enforceBudget(fallbackChunks(cache, opts.name, opts.version), budget)
    }

    const ftsQuery = buildFtsQuery(tokens)
    let rows: ChunkRow[]
    try {
        rows = cache.db
            .prepare(
                `SELECT c.file_path, c.kind, c.content, bm25(chunks_fts) AS rank
                 FROM chunks_fts
                 JOIN chunks c ON c.id = chunks_fts.rowid
                 WHERE c.name = ?1 AND c.version = ?2 AND chunks_fts MATCH ?3
                 ORDER BY rank
                 LIMIT ?4`
            )
            .all(opts.name, opts.version, ftsQuery, limit) as ChunkRow[]
    } catch {
        return enforceBudget(fallbackChunks(cache, opts.name, opts.version), budget)
    }

    if (rows.length === 0) {
        return enforceBudget(fallbackChunks(cache, opts.name, opts.version), budget)
    }

    const mapped: RetrievedChunk[] = rows.map(r => ({
        filePath: r.file_path,
        kind: r.kind,
        content: r.content,
        rank: r.rank
    }))
    return enforceBudget(mapped, budget)
}
