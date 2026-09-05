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
    /**
     * The keywords that introduce a named type, for the definition hop. Passed by
     * the caller rather than read off `EcosystemProfile` here: docs-ecosystems
     * imports docs-core, which imports this module, and reaching back for the
     * profile closes that cycle at run time.
     */
    typeKeywords?: readonly string[]
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
/**
 * How many alias definitions one retrieval will chase. Three covers the observed
 * case — hono's `get`/`json` pair plus one — without letting a chunk full of
 * aliased members spend the whole budget on hops.
 */
const MAX_ALIAS_HOPS = 3
/**
 * How many smallest-first candidates the value hop reads before giving up.
 *
 * A whole-word check cannot be pushed into SQL, so it runs over the shortest few.
 * Only a name whose every shorter occurrence is a substring of a longer identifier
 * needs more than a handful, and that name is not the one the query asked about.
 */
const VALUE_CHUNK_CANDIDATES = 8
/** Backstop for a caller that names no ecosystem; every real one passes its own. */
const DEFAULT_TYPE_KEYWORDS = ['interface', 'type', 'class', 'enum'] as const
/** A member declared as a bare capitalised type: `get: HandlerInterface<…>`. */
const MEMBER_TYPE_RE =
    /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([A-Z][A-Za-z0-9_]*)\s*[<;,)|&]/gm
/**
 * A token that is a symbol rather than English: capitalised, or carrying an
 * underscore or an internal capital.
 *
 * `/^[A-Z]/` alone was the whole rule, and it reached none of the 17 declarations
 * the 2026-09-06 run named and never retrieved — `safeParse`, `from_str`,
 * `into_make_service`, `parseJSON`. Widening to every token instead would hop on
 * `signature` and `return`, spending a slot on whichever prose chunk is shortest.
 */
const IDENTIFIER_SHAPED =
    /^(?:[A-Z][A-Za-z0-9_]{2,}|[a-z][A-Za-z0-9]*(?:_[A-Za-z0-9_]+|[A-Z][A-Za-z0-9_]*)[A-Za-z0-9_]*)$/
const TYPE_DECL_RE =
    /\b(?:interface|type|class|data|newtype|struct|trait|enum)\s+([A-Z][A-Za-z0-9_]*)/g
/** The `<E extends Env, BasePath extends string>` a declaration introduces itself. */
const TYPE_PARAMS_RE = /<([^<>]*)>/g
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

/**
 * The type names the retrieved text declares MEMBERS as, whose own definitions
 * are not in hand and which the query itself names — by the member or by the
 * type.
 *
 * This is the alias hop. A package that types its public surface through
 * interface aliases puts every real signature one declaration away from the name
 * a query matches: hono writes `get: HandlerInterface<…>` in hono-base.d.ts and
 * keeps the call signatures in `HandlerInterface`, in types.d.ts. BM25 ranks
 * chunks independently, so retrieval lands on the alias and the extraction child
 * sees a name where a signature should be. Measured on hono 4.13.5: three real
 * lookups, three abstentions, and the definition in one chunk of 708.
 *
 * Ranking hops by frequency does not work — `Response` and the English word
 * `The` both outrank `HandlerInterface` in the same text. What the query names
 * is the signal.
 */
function hopNames(text: string, tokens: string[]): string[] {
    const declared = new Set([...text.matchAll(TYPE_DECL_RE)].map(m => m[1]))
    const typeParams = new Set<string>()
    for (const m of text.matchAll(TYPE_PARAMS_RE)) {
        for (const part of m[1].split(',')) {
            const name = /^\s*([A-Z][A-Za-z0-9_]*)\s*(?:extends|=|$)/.exec(part)
            if (name) typeParams.add(name[1])
        }
    }
    const asked = new Set(tokens.map(t => t.toLowerCase()))
    const out: string[] = []
    // A name the QUERY itself asks about. scotty's seven failures were all of this
    // shape: `type ActionM = ActionT IO` sits in one chunk of 312 while 67 chunks
    // USE the name, and a chunk carrying BOTH query terms
    // (`get :: RoutePattern -> ActionM () -> ScottyM ()`) outranks the definition
    // every time. Reading the ranked output, all eight slots went to uses.
    // Not capped. MAX_ALIAS_HOPS bounds hops DERIVED from a chunk, where one chunk
    // full of aliased members could generate them without end; a query names the
    // handful of symbols it names, and that is the bound. Capping these at 3 as well
    // cost 4 of the 6 recoveries this hop exists for — measured on the 2026-09-06
    // run's own 35 named declarations: 17 missed uncapped-baseline, 15 at a cap of
    // 3, 11 at a cap of 8. The content budget is what stops it running long.
    for (const t of tokens) {
        if (!IDENTIFIER_SHAPED.test(t) || declared.has(t) || out.includes(t)) continue
        out.push(t)
    }
    for (const m of text.matchAll(MEMBER_TYPE_RE)) {
        const [, member, typeName] = m
        if (declared.has(typeName) || typeParams.has(typeName)) continue
        if (!asked.has(member.toLowerCase()) && !asked.has(typeName.toLowerCase())) continue
        if (out.includes(typeName)) continue
        out.push(typeName)
        if (out.length >= MAX_ALIAS_HOPS) break
    }
    return out
}

/** The smallest chunk that DECLARES `name`, or null. */
function definitionChunk(
    cache: CacheHandle,
    opts: RetrieveOptions,
    name: string
): RetrievedChunk | null {
    const keywords = opts.typeKeywords ?? DEFAULT_TYPE_KEYWORDS
    // Smallest first: the DEFINITION of a name is a short declaration, while the
    // long chunks holding it are the ones that merely use it.
    const where = keywords.map((_, i) => `content GLOB ?${i + 4}`).join(' OR ')
    const row = cache.db
        .prepare(
            `SELECT file_path, kind, content, 0 AS rank FROM chunks
             WHERE ecosystem = ?1 AND name = ?2 AND version = ?3
               AND (${where})
             ORDER BY length(content) LIMIT 1`
        )
        .get(
            opts.ecosystem,
            opts.name,
            opts.version,
            ...keywords.map(k => `*${k} ${name}[ <={(=]*`)
        ) as ChunkRow | undefined
    if (row) {
        return {
            filePath: row.file_path,
            kind: row.kind,
            content: row.content,
            rank: row.rank
        }
    }
    return valueChunk(cache, opts, name)
}

/**
 * The smallest chunk declaring `name` where `name` is a VALUE, not a type.
 *
 * The keyword GLOB above finds `type ActionM` and `struct Config`; nothing it can
 * spell finds `pub fn from_str<'a, T>` or `decodeValue :: String -> …`, and those
 * were 17 of the 35 declarations the 2026-09-06 run named and never retrieved.
 *
 * Smallest-first is the same reasoning as the type path, and it is what makes this
 * safe without a per-language declaration grammar: the surface extractor emits one
 * declaration per chunk, so the short chunk carrying the name IS its declaration and
 * the long ones are the prose that merely mentions it.
 */
function valueChunk(
    cache: CacheHandle,
    opts: RetrieveOptions,
    name: string
): RetrievedChunk | null {
    const rows = cache.db
        .prepare(
            `SELECT file_path, kind, content, 0 AS rank FROM chunks
             WHERE ecosystem = ?1 AND name = ?2 AND version = ?3 AND content LIKE ?4
             ORDER BY length(content) LIMIT ?5`
        )
        .all(
            opts.ecosystem,
            opts.name,
            opts.version,
            `%${name}%`,
            VALUE_CHUNK_CANDIDATES
        ) as ChunkRow[]
    // LIKE has no word boundary, so `decodeFile` matches `decodeFileStrict` — the
    // wrong declaration, and the exact confusion these runs keep producing.
    const whole = new RegExp(`(?<![A-Za-z0-9_])${escapeRe(name)}(?![A-Za-z0-9_])`)
    const row = rows.find(r => whole.test(r.content))
    if (!row) return null
    return {filePath: row.file_path, kind: row.kind, content: row.content, rank: row.rank}
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    const kept = enforceBudget(mapped, budget)
    const key = (c: RetrievedChunk): string => `${c.filePath}\u0000${c.content.length}`
    const have = new Set(kept.map(key))
    const hops: RetrievedChunk[] = []
    for (const name of hopNames(kept.map(c => c.content).join('\n'), tokens)) {
        const def = definitionChunk(cache, opts, name)
        if (!def || have.has(key(def))) continue
        hops.push(def)
    }
    if (hops.length === 0) return kept
    // Hops sit directly behind the top-ranked chunk, so re-budgeting drops the
    // WEAKEST original rather than the definition that explains the strongest.
    // The budget itself does not move.
    return enforceBudget([kept[0], ...hops, ...kept.slice(1)], budget)
}
