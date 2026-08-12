/**
 * STEP 0 for the "empty-bodied `### docs:` block" lead — the BASE RATE of the
 * shipped raw-docs predicate emitting a heading with no body under it.
 *
 * THE LEAD. external-context.ts:243 decides whether the research path emits a
 * `### docs: <pkg>` block with
 *
 *     r.kind === 'ok' && r.chunks.length > 0
 *
 * — a test on chunk COUNT. If every retrieved chunk's `content` were empty the
 * block would still be emitted: prompt budget spent announcing documentation and
 * then carrying none. The focused path gates on a non-empty `answer` instead, so
 * only the raw path can have the hole. The suspected fix is to gate on the JOINED
 * body being non-empty.
 *
 * WHY MEASURE FIRST. The EXTERNAL CONTEXT block is prepended to worker prompts
 * whose behaviour is A/B-tested with verdicts recorded in VALIDATION-DEBT.md, and
 * external-context.ts documents the raw/focused difference as DELIBERATE. A
 * predicate change wired without a base rate cannot tell "removed the empty
 * headings" from "there were never any empty headings"
 * (memory/prompt2-typeonly-baserate.md).
 *
 * TWO POPULATIONS, because they fail differently:
 *
 *   A. CACHE AUDIT (static, read-only). Every chunk row in the machine's real
 *      docs cache — 220 MB, accumulated by real runs. Counts rows whose `content`
 *      is empty or whitespace-only. This catches rows written by an OLDER indexer
 *      than the one in the tree today; the live sweep can only see what today's
 *      indexer produces.
 *
 *   B. LIVE SWEEP (the shipped predicate). `docsRaw` is run for real (pkg, query)
 *      pairs and the shipped predicate is evaluated against the candidate one:
 *
 *        shipped  emits when  r.kind === 'ok' && r.chunks.length > 0
 *        candidate emits when the joined+truncated body is non-empty
 *
 *      A HIT is a lookup where shipped emits and candidate does not — an empty
 *      heading in a real prompt. Two arms:
 *
 *        PRODUCTION  the exact pairs the research phase would fan out: every real
 *                    TASK_*.md spec in the corpus trees, through the shipped
 *                    `extractEnrichTargets`, with the shipped query (the spec's
 *                    first non-empty line). This is the distribution that matters,
 *                    junk package names and all.
 *        VOLUME      every package installed in every corpus tree, queried with
 *                    real spec first-lines round-robin, so the `ok` population is
 *                    thousands rather than dozens. Plus a degenerate token-free
 *                    query per tree, which is the only way into `retrieveChunks`'s
 *                    fallback branch.
 *
 * SIDE-EFFECT FENCES. The sweep must not alter the machine or the recorded
 * numbers, so:
 *   - the cache is a COPY under the scratch dir; indexing writes land there.
 *   - `npmVersionLookup` is stubbed to null. It cannot touch the body, and the
 *     real one is ~2400 registry GETs.
 *   - `spawn` is rewritten to a guaranteed-fail command, so a not-installed
 *     package name (`users`, `q`, `true` — the production arm has plenty) can
 *     never fire a real `npm install`. Blocked installs are COUNTED and printed:
 *     they are lookups this run could not classify, not lookups that scored zero.
 *
 * Run: bun run scripts/docs-empty-body-baserate.ts
 */
import {spawn as nodeSpawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {openCache} from '../src/workers/docs-cache.js'
import {docsRaw, type DocsRawResult} from '../src/workers/docs-core.js'
import {extractEnrichTargets} from '../src/task/enrichment.js'
import type {SpawnFn} from '../src/shared/child-process.js'
import {CORPUS, listInstalled, treeStatus} from './docs-redirect-baserate.js'

/** Mirrors RAW_BODY_LIMIT in src/task/external-context.ts — the shipped truncation. */
const RAW_BODY_LIMIT = 4000

/** A body this short is a heading that carries a filename and little else. */
const TINY_BODY = 80

const CACHE_SRC =
    process.env.XDG_CACHE_HOME?.trim() ?
        path.join(process.env.XDG_CACHE_HOME.trim(), 'pi-worker', 'docs.sqlite')
    :   path.join(os.homedir(), '.cache', 'pi-worker', 'docs.sqlite')

/** Never spawn anything: `npm install` here would reach the registry for a name a
 *  model invented. Exit 1 makes runAutoInstall report failure, which docsRaw
 *  already handles as `kind: 'error'`. */
let blockedSpawns = 0
const blockingSpawn: SpawnFn = ((_command, _args, options) => {
    blockedSpawns++
    return nodeSpawn('false', [], options)
}) as SpawnFn

interface Lookup {
    arm: 'PRODUCTION' | 'VOLUME'
    pkg: string
    cwd: string
    query: string
}

interface Scored {
    lookup: Lookup
    kind: DocsRawResult['kind']
    chunks: number
    /** Joined chunk contents, truncated exactly as external-context.ts does. */
    bodyLen: number
    trimmedLen: number
    shippedEmits: boolean
    candidateEmits: boolean
}

/** Every real task spec in the corpus, with the query the research phase would use. */
function realSpecs(): Array<{tree: string; file: string; text: string; query: string}> {
    const out: Array<{tree: string; file: string; text: string; query: string}> = []
    for (const tree of CORPUS) {
        const dir = path.join(tree, '.pi-tasks')
        let files: string[]
        try {
            files = fs.readdirSync(dir)
        } catch {
            continue
        }
        for (const file of files.sort()) {
            if (!/^TASK_\d+\.md$/.test(file)) continue
            let text: string
            try {
                text = fs.readFileSync(path.join(dir, file), 'utf8')
            } catch {
                continue
            }
            // gatherExternalContext: the docs query is the refined spec's first
            // non-empty line.
            const query = text.split('\n').find(l => l.trim()) ?? text
            out.push({tree, file, text, query})
        }
    }
    return out
}

function buildLookups(): Lookup[] {
    const specs = realSpecs()
    const lookups: Lookup[] = []

    for (const spec of specs) {
        for (const pkg of extractEnrichTargets(spec.text).packages) {
            lookups.push({arm: 'PRODUCTION', pkg, cwd: spec.tree, query: spec.query})
        }
    }

    // Round-robin over real queries so retrieval ranking varies the way it does
    // across runs, instead of every package answering the same one question.
    const queries = specs.map(s => s.query)
    for (const tree of CORPUS) {
        if (treeStatus(tree).kind !== 'ok') continue
        const installed = listInstalled(tree)
        installed.forEach((pkg, i) => {
            const query = queries.length ? queries[i % queries.length] : pkg
            lookups.push({arm: 'VOLUME', pkg, cwd: tree, query})
        })
        // Token-free query: tokenize() returns [], so retrieval takes the
        // fallbackChunks branch. Nothing else in the sweep reaches it.
        for (const pkg of installed.slice(0, 25)) {
            lookups.push({arm: 'VOLUME', pkg, cwd: tree, query: '--- +++ ...'})
        }
    }
    return lookups
}

async function score(lookup: Lookup, cachePath: string): Promise<Scored> {
    const r = await docsRaw({
        pkg: lookup.pkg,
        query: lookup.query,
        cwd: lookup.cwd,
        openCache: () => openCache(cachePath),
        npmVersionLookup: async () => null,
        spawn: blockingSpawn
    })
    const chunks = r.kind === 'ok' ? r.chunks.length : 0
    const body =
        r.kind === 'ok' ?
            r.chunks
                .map(c => c.content)
                .join('\n\n')
                .slice(0, RAW_BODY_LIMIT)
        :   ''
    // The two predicates, verbatim.
    const shippedEmits = r.kind === 'ok' && r.chunks.length > 0
    const candidateEmits = shippedEmits && body.trim().length > 0
    return {
        lookup,
        kind: r.kind,
        chunks,
        bodyLen: body.length,
        trimmedLen: body.trim().length,
        shippedEmits,
        candidateEmits
    }
}

function auditCache(cachePath: string): {rows: number; empty: number; whitespace: number} {
    const cache = openCache(cachePath)
    try {
        const one = (sql: string): number =>
            (cache.db.prepare(sql).get() as {c: number} | null)?.c ?? 0
        return {
            rows: one('SELECT count(*) AS c FROM chunks'),
            empty: one("SELECT count(*) AS c FROM chunks WHERE content = ''"),
            whitespace: one("SELECT count(*) AS c FROM chunks WHERE trim(content) = ''")
        }
    } finally {
        cache.close()
    }
}

function pct(n: number, d: number): string {
    return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(2)}%`
}

async function main(): Promise<void> {
    const scratch =
        process.env.SCRATCH_DIR?.trim() || fs.mkdtempSync(path.join(os.tmpdir(), 'docs-empty-'))
    fs.mkdirSync(scratch, {recursive: true})
    const cachePath = path.join(scratch, 'docs-copy.sqlite')

    console.log('=== SETUP')
    if (fs.existsSync(CACHE_SRC)) {
        fs.copyFileSync(CACHE_SRC, cachePath)
        console.log(
            `  cache copied  ${(fs.statSync(cachePath).size / 1e6).toFixed(0)} MB  ${CACHE_SRC}`
        )
    } else {
        console.log(`  no machine cache at ${CACHE_SRC} — the sweep will index from scratch`)
    }

    console.log('\n=== A. CACHE AUDIT (every chunk ever indexed on this machine)')
    const audit = auditCache(cachePath)
    console.log(`  chunk rows            ${audit.rows}`)
    console.log(`  content = ''          ${audit.empty}   ${pct(audit.empty, audit.rows)}`)
    console.log(
        `  trim(content) = ''    ${audit.whitespace}   ${pct(audit.whitespace, audit.rows)}`
    )

    const lookups = buildLookups()
    const byArm = {
        PRODUCTION: lookups.filter(l => l.arm === 'PRODUCTION').length,
        VOLUME: lookups.filter(l => l.arm === 'VOLUME').length
    }
    console.log('\n=== B. LIVE SWEEP')
    console.log(
        `  lookups: ${lookups.length}  (PRODUCTION ${byArm.PRODUCTION}, VOLUME ${byArm.VOLUME})`
    )

    const scored: Scored[] = []
    const t0 = Date.now()
    for (let i = 0; i < lookups.length; i++) {
        scored.push(await score(lookups[i], cachePath))
        if ((i + 1) % 200 === 0) {
            const emitted = scored.filter(s => s.shippedEmits).length
            console.log(
                `  ${i + 1}/${lookups.length}  emitted ${emitted}  `
                    + `hits ${scored.filter(s => s.shippedEmits && !s.candidateEmits).length}  `
                    + `${((Date.now() - t0) / 1000).toFixed(0)}s`
            )
        }
    }

    for (const arm of ['PRODUCTION', 'VOLUME'] as const) {
        const rows = scored.filter(s => s.lookup.arm === arm)
        const emitted = rows.filter(s => s.shippedEmits)
        const hits = emitted.filter(s => !s.candidateEmits)
        const tiny = emitted.filter(s => s.trimmedLen > 0 && s.trimmedLen < TINY_BODY)
        console.log(`\n=== ${arm}  (${rows.length} lookups)`)
        const kinds = new Map<string, number>()
        for (const r of rows) kinds.set(r.kind, (kinds.get(r.kind) ?? 0) + 1)
        for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
            console.log(`  kind ${k.padEnd(14)} ${String(n).padStart(5)}`)
        }
        console.log(`  shipped emits a block  ${emitted.length}`)
        console.log(
            `  EMPTY-BODIED BLOCKS    ${hits.length}   ${pct(hits.length, emitted.length)} of emitted`
        )
        console.log(
            `  body < ${TINY_BODY} chars       ${tiny.length}   ${pct(tiny.length, emitted.length)} of emitted`
        )
        for (const t of tiny.slice(0, 10)) {
            console.log(`    ${t.lookup.pkg} — ${t.trimmedLen} chars, ${t.chunks} chunk(s)`)
        }
        for (const h of hits.slice(0, 20)) {
            console.log(`    HIT ${h.lookup.pkg}  chunks=${h.chunks}  cwd=${h.lookup.cwd}`)
        }
    }

    const allEmitted = scored.filter(s => s.shippedEmits)
    const allHits = allEmitted.filter(s => !s.candidateEmits)
    console.log('\n=== VERDICT INPUT')
    console.log(`  blocked npm installs   ${blockedSpawns}  (lookups this run could not classify)`)
    console.log(`  emitted blocks         ${allEmitted.length}`)
    console.log(
        `  empty-bodied           ${allHits.length}   ${pct(allHits.length, allEmitted.length)}`
    )
    console.log(
        allHits.length === 0 ?
            '  BASE RATE ZERO — the predicate difference is unobservable on this corpus.'
        :   '  NON-ZERO — the lead has a population; take it to an A/B.'
    )
    console.log(`\n  scratch: ${scratch}`)
}

if (import.meta.main) main()
