/**
 * Regenerates the run-15 research fixtures from the mx5 evidence directory.
 *
 * Run once, checked in; kept so the extraction is auditable rather than a pile of
 * pasted JSON. The evidence (~/hub/mx5/.pi-tasks) is READ-ONLY here.
 *
 *   bun run scripts/fixtures/build-run15-fixtures.ts
 *
 * FIDELITY CAVEAT, recorded because it bounds what a replay can claim: the cache KEY
 * is `normalizeQuery`d (whitespace-collapsed AND lowercased — research-cache.ts:156),
 * and the original query string is stored nowhere else. The task debug logs clip the
 * query at 60 chars. So the replay corpus carries the LOWERCASED question the cache
 * recorded (`hc<apptype>`, not `hc<AppType>`), which is the same question semantically
 * but not byte-verbatim. Do not describe this corpus as "verbatim" without that rider.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// The cache namespaces keys as `<tool>\0<target>::<query>`. Built from a char code on
// purpose: a literal NUL in a source file makes grep treat the whole file as binary and
// silently report zero matches in it.
const SEP = String.fromCharCode(0)
const EVIDENCE = path.join(os.homedir(), 'hub', 'mx5', '.pi-tasks', 'research-cache.json')
const OUT = path.dirname(new URL(import.meta.url).pathname)

interface Entry {
    text: string
    details: Record<string, unknown>
    at: number
}

const cache = JSON.parse(fs.readFileSync(EVIDENCE, 'utf8')) as {
    runId: string
    entries: Record<string, Entry>
}
const entries = cache.entries
const keys = Object.keys(entries)

const UNCLEAR = /unclear from this (package|page)/i
const CAVEAT = /\[VERSION — verify\]/

/** The three outcome classes the STEP 0 baseline counts, scored off the tool-layer record. */
function classify(e: Entry): {unclear: boolean; hallucWarn: boolean; caveated: boolean} {
    return {
        unclear: UNCLEAR.test(e.text),
        hallucWarn: e.details.excerptVerified === false,
        caveated: CAVEAT.test(e.text)
    }
}

// ─── item 1 corpus: the 210 cached package questions ─────────────────────────
const docs = keys
    .filter(k => k.startsWith('pi-worker-docs' + SEP))
    .map(k => {
        const rest = k.slice(('pi-worker-docs' + SEP).length)
        const i = rest.indexOf('::')
        const e = entries[k]
        return {
            pkg: rest.slice(0, i),
            query: rest.slice(i + 2),
            at: e.at,
            recorded: classify(e)
        }
    })
    .sort((a, b) => a.at - b.at)
    .map(({pkg, query, recorded}) => ({pkg, query, recorded}))

// ─── item 4 fixture: the 10 failing fetch (url, query) pairs ─────────────────
const fetchAll = keys
    .filter(k => k.startsWith('pi-worker-fetch' + SEP))
    .map(k => {
        const rest = k.slice(('pi-worker-fetch' + SEP).length)
        const i = rest.indexOf('::')
        const e = entries[k]
        return {
            url: rest.slice(0, i),
            query: rest.slice(i + 2),
            at: e.at,
            recorded: classify(e),
            excerpt: typeof e.details.excerpt === 'string' ? e.details.excerpt : undefined,
            answer: typeof e.details.answer === 'string' ? e.details.answer : undefined
        }
    })
    .sort((a, b) => a.at - b.at)

const failing = fetchAll.filter(f => f.recorded.unclear || f.recorded.hallucWarn)
const passing = fetchAll.filter(f => !(f.recorded.unclear || f.recorded.hallucWarn))

const write = (name: string, data: unknown): void => {
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(data, null, 2) + '\n', 'utf8')
    console.log(`  ${name}  ${Array.isArray(data) ? data.length : '?'} entries`)
}

console.log(`run ${cache.runId} — ${keys.length} cached results`)
write('run15-docs-corpus.json', docs.map(({pkg, query, recorded}) => ({pkg, query, recorded})))
write(
    'run15-fetch-failures.json',
    failing.map(({url, query, recorded, excerpt, answer}) => ({
        url,
        query,
        recorded,
        excerpt,
        answer
    }))
)
write(
    'run15-fetch-regression.json',
    passing.map(({url, query, recorded}) => ({url, query, recorded}))
)

const n = (p: (d: (typeof docs)[number]) => boolean): number => docs.filter(p).length
console.log(
    `\ndocs corpus: ${docs.length} questions — `
        + `unclear ${n(d => d.recorded.unclear)}, `
        + `halluc-warn ${n(d => d.recorded.hallucWarn)}, `
        + `caveated ${n(d => d.recorded.caveated)}`
)
console.log(`fetch: ${failing.length} failing + ${passing.length} regression = ${fetchAll.length}`)
