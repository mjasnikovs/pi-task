/**
 * A/B: does `pi-worker-docs(".", …)` RETRIEVAL actually surface the file the query names?
 *
 * WHY THIS EXISTS. mx5 run 13 issued 141 project-source (`module: "."`) lookups across 16
 * task logs. They cluster hard by target file — src/server/db.ts asked 22 different ways,
 * src/server/auth.ts 19, src/server/routes/listings.ts 17. The obvious read is "cache the
 * answers". Two measurements say otherwise:
 *
 *   - Keyed on query TEXT within a phase window, only 1 of 141 calls is an exact repeat
 *     (0.7%), and that is an UPPER bound: the debug log truncates queries at
 *     RENDER_QUERY_MAX=100, which can only MERGE distinct queries, never split equal ones.
 *     So a query-text cache is worth ~nothing here. (pi-worker-docs.ts:337 already declines
 *     to cache `.` at all, for a sound reason: the tree mutates as tasks implement.)
 *   - Keyed on the target FILE SET, 104 of 141 (74%) collapse.
 *
 * Before caching per file, the root cause has to be settled, because the two hypotheses
 * demand opposite fixes:
 *
 *   H-cache      retrieval is FINE; the model re-asks because nothing remembers the answer.
 *                => fix is a per-file digest cache keyed on (path, mtime).
 *   H-retrieval  retrieval is BAD; the model re-asks because it keeps getting chunks from
 *                the wrong files. => a per-file cache would just memoise 22 bad answers,
 *                and the real fix is in retrieval. ("prefer root fix over point fix")
 *
 * WHAT DISTINGUISHES THEM, mechanically and with no model in the loop: for a query that
 * NAMES a file, does that file appear in the chunks BM25 returns, and how much of the
 * content budget does it get? A query saying "src/server/db.ts exports — query, queryOne"
 * that retrieves no db.ts chunk is a retrieval failure, full stop. No prose, no judge.
 *
 * SEAM. Real src/workers/docs-cache.ts + docs-project.ts + docs-retrieve.ts, real SQLite
 * FTS5 index over the real mx5 working tree. Only the child model is absent — this probe
 * measures the RETRIEVAL stage that runs before it, which is exactly the stage in dispute.
 *
 * ROOT CAUSE the first run of this probe exposed. docs-retrieve.ts tokenize() splits the
 * query on WHITESPACE, then strips non-alphanumerics INSIDE each token. So the single most
 * informative term a `.` query carries — the path — is destroyed:
 *
 *   "src/server/routes/auth.ts — the router variable"
 *     => ["srcserverroutesauthts", "the", "router", "variable"]
 *
 * `srcserverroutesauthts` occurs in no file, so the path contributes NOTHING to the BM25
 * MATCH and ranking is decided by "the router variable" alone. That is why 22 of 122
 * file-naming queries retrieve none of the file they name, and why the model re-asks the
 * same file up to 22 different ways: each rephrasing is scored without the filename.
 *
 * ARMS
 *   baseline   projectDocsRaw(query) as shipped.
 *   tokenizer  identical, except tokenize() splits on any non-alphanumeric run, so a path
 *              contributes its segments ("src","server","routes","auth","ts").
 *   +scoped    tokenizer fix PLUS file-scoped retrieval: when the query names a path in
 *              the index, that file's chunks are placed first, then topped up from the
 *              global ranking to the same content budget.
 *
 * METRIC — unfakeable, read off the returned chunks, never self-reported:
 *   targetPresent   did any retrieved chunk come from the named file
 *   targetRank      0-based position of its first chunk (lower is better)
 *   targetShare     fraction of retrieved content BYTES belonging to the named file
 *
 * FIXTURE. Real queries scraped from ~/hub/mx5/.pi-tasks/*-debug.log. They are truncated
 * at 100 chars by the logger; the file name sits at the FRONT of nearly every one, so the
 * retrieval signal under test survives truncation. Queries whose named file no longer
 * exists in the tree are reported separately, not scored — the tree has moved on since the
 * run, and scoring a query against a deleted file would measure the clock, not retrieval.
 *
 * Run:
 *   bun run scripts/live-project-docs-retrieval-ab.ts [--repo <path>] [--verbose]
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {openCache} from '../src/workers/docs-cache.js'
import {projectDocsRaw} from '../src/workers/docs-project.js'
import {retrieveChunks, type RetrievedChunk} from '../src/workers/docs-retrieve.js'

const args = process.argv.slice(2)
const repo =
    args.includes('--repo') ?
        path.resolve(args[args.indexOf('--repo') + 1]!)
    :   path.join(os.homedir(), 'hub', 'mx5')
const verbose = args.includes('--verbose')

const logDir = path.join(repo, '.pi-tasks')
if (!fs.existsSync(logDir)) {
    console.error(`No .pi-tasks in ${repo}`)
    process.exit(1)
}

// ── Fixture: real `.` queries from the real logs ────────────────────────────────
interface Fixture {
    query: string
    named: string[]
    log: string
}
const fixtures: Fixture[] = []
for (const f of fs.readdirSync(logDir).filter(n => n.endsWith('-debug.log')).sort()) {
    const text = fs.readFileSync(path.join(logDir, f), 'utf8')
    for (const line of text.split('\n')) {
        const m = /pi-worker-docs: \. "(.*)$/.exec(line)
        if (!m) continue
        // strip the logger's trailing ellipsis/quote so it is not a BM25 token
        const query = m[1]!.replace(/…?"?\s*$/, '').trim()
        if (!query) continue
        const named = [...new Set(query.match(/[\w/.-]+\.tsx?/g) ?? [])]
        fixtures.push({query, named, log: f})
    }
}
console.log(`fixture: ${fixtures.length} real "." queries from ${logDir}`)

const withFile = fixtures.filter(f => f.named.length > 0)
console.log(`  naming >=1 file: ${withFile.length}   no-file: ${fixtures.length - withFile.length}`)

// ── Index the real tree once, then reuse the handle ─────────────────────────────
const cache = openCache(path.join(os.tmpdir(), `docs-ab-${process.pid}.sqlite`))
const warm = projectDocsRaw(cache, repo, 'warm the index')
if (warm.kind !== 'ok') {
    console.error(`indexing failed: ${JSON.stringify(warm)}`)
    process.exit(1)
}
const {cacheKey, version} = warm
const indexedPaths = new Set(
    (
        cache.db
            .prepare('SELECT DISTINCT file_path FROM chunks WHERE name = ? AND version = ?')
            .all(cacheKey, version) as {file_path: string}[]
    ).map(r => r.file_path)
)
console.log(`indexed: ${indexedPaths.size} files\n`)

/** Resolve a name from a query to an indexed path (queries often drop the dir prefix). */
function resolveNamed(named: string[]): string | null {
    for (const n of named) {
        if (indexedPaths.has(n)) return n
        const hit = [...indexedPaths].filter(p => p === n || p.endsWith(`/${n}`))
        if (hit.length === 1) return hit[0]!
    }
    return null
}

interface Score {
    present: boolean
    rank: number
    share: number
}
function score(chunks: RetrievedChunk[], target: string): Score {
    const total = chunks.reduce((n, c) => n + c.content.length, 0) || 1
    const own = chunks.filter(c => c.filePath === target)
    const rank = chunks.findIndex(c => c.filePath === target)
    return {
        present: own.length > 0,
        rank,
        share: own.reduce((n, c) => n + c.content.length, 0) / total
    }
}

const DEFAULT_LIMIT = 50
const DEFAULT_BUDGET = 24_000

/**
 * ARM 2 — the tokenizer fix, exercised through the REAL retrieveChunks.
 * tokenize() splits on /\s+/ then strips punctuation inside each token, so feeding it a
 * query already split on punctuation yields exactly the tokens the fix would produce.
 * No reimplemented SQL: the index, the MATCH and the bm25() ranking are the shipped ones.
 */
function preTokenize(query: string): string {
    return query.split(/[^a-zA-Z0-9_]+/).filter(Boolean).join(' ')
}

function retrieveWith(query: string): RetrievedChunk[] {
    return retrieveChunks(cache, {
        name: cacheKey,
        version,
        query,
        limit: DEFAULT_LIMIT,
        contentBudget: DEFAULT_BUDGET
    })
}

/** ARM 3: tokenizer fix + file-scoped ordering, topped up from the global ranking. */
function fileScoped(query: string, target: string): RetrievedChunk[] {
    const all = retrieveChunks(cache, {
        name: cacheKey,
        version,
        query: preTokenize(query),
        limit: 400,
        contentBudget: Number.MAX_SAFE_INTEGER
    })
    const own = all.filter(c => c.filePath === target)
    const rest = all.filter(c => c.filePath !== target)
    const out: RetrievedChunk[] = []
    let used = 0
    for (const c of [...own, ...rest]) {
        if (out.length >= DEFAULT_LIMIT) break
        if (out.length && used + c.content.length > DEFAULT_BUDGET) continue
        out.push(c)
        used += c.content.length
    }
    return out
}

const rows: {q: string; target: string; base: Score; tok: Score; treat: Score}[] = []
let unresolved = 0
for (const f of withFile) {
    const target = resolveNamed(f.named)
    if (!target) {
        unresolved++
        continue
    }
    const b = projectDocsRaw(cache, repo, f.query)
    if (b.kind !== 'ok') continue
    rows.push({
        q: f.query,
        target,
        base: score(b.chunks, target),
        tok: score(retrieveWith(preTokenize(f.query)), target),
        treat: score(fileScoped(f.query, target), target)
    })
}

function pct(n: number, d: number): string {
    return d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a'
}
const n = rows.length
const arms = [
    ['BASELINE', (r: (typeof rows)[0]) => r.base],
    ['TOKENIZER', (r: (typeof rows)[0]) => r.tok],
    ['+SCOPED', (r: (typeof rows)[0]) => r.treat]
] as const

console.log(`scored: ${n}   unresolved-file (moved/deleted since the run): ${unresolved}\n`)
console.log(`arm         named-file-retrieved   mean-content-share   mean-rank-when-present`)
for (const [label, pick] of arms) {
    const hit = rows.filter(r => pick(r).present).length
    const share = rows.reduce((s, r) => s + pick(r).share, 0) / (n || 1)
    const rank = rows.filter(r => pick(r).present).reduce((s, r) => s + pick(r).rank, 0) / (hit || 1)
    console.log(
        `${label.padEnd(11)} ${`${pct(hit, n)} (${hit}/${n})`.padEnd(22)} `
            + `${`${(100 * share).toFixed(1)}%`.padEnd(20)} ${rank.toFixed(2)}`
    )
}

const misses = rows.filter(r => !r.base.present)
if (misses.length) {
    console.log(`\nBASELINE MISSES — query names the file, retrieval returns none of it (${misses.length}):`)
    for (const m of misses.slice(0, verbose ? misses.length : 15)) {
        console.log(`  [${m.target}]  ${m.q.slice(0, 88)}`)
    }
}
if (verbose) {
    const starved = rows
        .filter(r => r.base.present && r.base.share < 0.15)
        .sort((a, b) => a.base.share - b.base.share)
    console.log(`\nSTARVED — file present but <15% of budget (${starved.length}):`)
    for (const s of starved.slice(0, 20)) {
        console.log(`  ${(100 * s.base.share).toFixed(1)}%  [${s.target}]  ${s.q.slice(0, 70)}`)
    }
}
cache.close()
