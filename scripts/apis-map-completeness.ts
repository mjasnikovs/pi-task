/**
 * OFFLINE — does worker:apis's ZERO-RETRIEVAL first pass correlate with a COMPLETE/large FILES
 * map handed to it? Measured on raw data already on disk. NO model time.
 *
 * This is the SAME distinct F-1 as the zero-retrieval gate ([[apis-zero-retrieval-gate-abstain]])
 * — NEVER folded into the STAGE 1-3 stopping-point metrics. The gate is committed but its A/B
 * ABSTAINED because the failure is too rare to power. Standing hypothesis for the intermittency:
 * a zero-retrieval first pass co-occurs with a COMPLETE FILES map (STAGE 1's output-format
 * completion mechanism — a rich map lets the worker fill the APIS output format from map+memory
 * and skip retrieval). This script MEASURES that correlation. It does NOT claim cause and it does
 * NOT build or A/B anything — the task ends at the offline measurement.
 *
 * TWO CLASSES, both scored on the identical FILES-map block extracted from the assembled
 * worker:apis prompt (the `PROJECT FILE MAP — already surveyed …` … `USE THE MAP:` block that
 * prompts.ts:159 interpolates):
 *   NEGATIVE (retrieved)      ~/tmp/apis-stopping-point/stopping-point.json — 40 reps, each with
 *                             `apisPrompt` (map verbatim inside); all 40 made grounding calls.
 *   POSITIVE (zero-retrieval) 4 reps whose worker:apis first pass made 0 grounding-retrieval
 *                             calls, from ~/tmp/apis-zero-retrieval-ab/{arm}/{fixture}/trial-N/
 *                             prompts.txt: treatment task27-hono r5/r6, treatment task28-wouter
 *                             r15 (gate fired), baseline task28-wouter r13 (shipped ungrounded).
 *                             The preserved 1/16 instance (task27-hono rep2) left only a fixture
 *                             snapshot, NO prompt capture — its map is LOST (noted, not counted).
 *
 * Completeness proxies per rep: map BYTES, non-empty LINES, path-ENTRIES, and map-as-FRACTION of
 * the whole apis prompt (controls total-prompt-size as a rival). Coverage of the emitted APIS
 * section's path/symbol references is reported too (SECONDARY — for the 3 gate-fired treatment
 * reps the emitted section is the RECOVERED one, not the zero-retrieval first pass; only the
 * baseline r13 section is the actual zero-retrieval output).
 *
 * Rivals tested so a spurious correlate is not sold as the cause: FIXTURE (positives are 2+2
 * balanced; also stratified percentile within each fixture), REP INDEX (Pearson r in negatives),
 * TOTAL PROMPT SIZE (map fraction).
 *
 * Power is stated honestly: n_positive = 4. Exact Mann-Whitney floor at n=4,m=40 is
 * 1/C(44,4) = 7.4e-6 one-sided, so a CLEAN separation CAN reach significance; a partial one cannot.
 *
 * Re-score (no model time):
 *   STOP_DIR=~/tmp/apis-stopping-point AB_DIR=~/tmp/apis-zero-retrieval-ab \
 *     bun run scripts/apis-map-completeness.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {parseApisEntries} from './apis-trajectory.js'

const STOP_DIR = path.resolve(
    process.env.STOP_DIR || path.join(os.homedir(), 'tmp', 'apis-stopping-point')
)
const AB_DIR = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'apis-zero-retrieval-ab')
)

/** The 4 zero-retrieval-first-pass reps and how they were identified (from ab.json). */
const POSITIVES: {arm: string; fixture: string; rep: number; how: string}[] = [
    {arm: 'treatment', fixture: 'task27-hono', rep: 5, how: 'gate fired, recovered gr=19'},
    {arm: 'treatment', fixture: 'task27-hono', rep: 6, how: 'gate fired, recovered gr=14'},
    {arm: 'treatment', fixture: 'task28-wouter', rep: 15, how: 'gate fired, recovered gr=6'},
    {arm: 'baseline', fixture: 'task28-wouter', rep: 13, how: 'shipped ungrounded, gr=0'}
]

interface NegRep {
    fixture: string
    rep: number
    apisSection: string
    apisPrompt: string
}
interface AbRep {
    fixture: string
    arm: string
    rep: number
    apisSection: string
    groundingCalls: number
}

interface Scored {
    label: string
    fixture: string
    rep: number
    cls: 'POS' | 'NEG'
    promptBytes: number
    mapBytes: number
    mapLines: number
    mapEntries: number
    mapFrac: number
    pathCovered: number
    pathTotal: number
    symCovered: number
    symTotal: number
}

// ─── extractors ──────────────────────────────────────────────────────────────

/** worker:apis assembled prompt out of a multi-worker prompts.txt dump. */
function apisPromptFromDump(dump: string): string {
    const start = dump.indexOf('===== worker:apis =====')
    if (start < 0) return ''
    const bodyStart = dump.indexOf('\n', start) + 1
    const end = dump.indexOf('===== worker:', bodyStart)
    return (end < 0 ? dump.slice(bodyStart) : dump.slice(bodyStart, end)).trim()
}

/**
 * The FILES-map block: between the `PROJECT FILE MAP …` header and the `USE THE MAP:` line
 * (prompts.ts:159-166). Empty string if the prompt carried no map (should never happen here —
 * every rep is post-FILES).
 */
function filesMapOf(apisPrompt: string): string {
    const h = apisPrompt.indexOf('PROJECT FILE MAP')
    if (h < 0) return ''
    const bodyStart = apisPrompt.indexOf('\n', h) + 1
    const end = apisPrompt.indexOf('USE THE MAP:', bodyStart)
    return (end < 0 ? apisPrompt.slice(bodyStart) : apisPrompt.slice(bodyStart, end)).trim()
}

/** Path-shaped tokens: contain a slash, or a bare `name.ext`. The unit the map is supposed to own. */
function pathTokens(text: string): string[] {
    const m = text.match(/[A-Za-z0-9_@.\-/]*\/[A-Za-z0-9_.\-/]+|[A-Za-z0-9_-]+\.[A-Za-z]{2,4}\b/g)
    return [...new Set((m ?? []).map(t => t.replace(/[.,;:]+$/, '')).filter(t => t.length >= 3))]
}

/** Lines whose first token is path-shaped — the map's actual FILES entries (vs prose/blank). */
function mapEntryCount(map: string): number {
    let n = 0
    for (const raw of map.split('\n')) {
        const line = raw.trim()
        if (line.length === 0) continue
        const head = line.split(/\s{2,}|\s/)[0]
        if (head.includes('/') || /\.[A-Za-z]{2,4}$/.test(head)) n++
    }
    return n
}

function score(
    label: string,
    fixture: string,
    rep: number,
    cls: 'POS' | 'NEG',
    apisPrompt: string,
    apisSection: string
): Scored {
    const map = filesMapOf(apisPrompt)
    const promptBytes = Buffer.byteLength(apisPrompt, 'utf8')
    const mapBytes = Buffer.byteLength(map, 'utf8')
    const mapLines = map.split('\n').filter(l => l.trim().length > 0).length
    // Coverage of what the emitted section references, against the map text.
    const paths = pathTokens(apisSection)
    const pathCovered = paths.filter(p => map.includes(p)).length
    const syms = [...new Set(parseApisEntries(apisSection).flatMap(e => e.symbols))]
    const symCovered = syms.filter(s => map.includes(s)).length
    return {
        label,
        fixture,
        rep,
        cls,
        promptBytes,
        mapBytes,
        mapLines,
        mapEntries: mapEntryCount(map),
        mapFrac: promptBytes > 0 ? mapBytes / promptBytes : 0,
        pathCovered,
        pathTotal: paths.length,
        symCovered,
        symTotal: syms.length
    }
}

// ─── stats ───────────────────────────────────────────────────────────────────

const median = (xs: number[]): number => {
    if (xs.length === 0) return NaN
    const s = [...xs].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

/** Fraction of `pool` strictly below `x`, plus half the ties — the value's percentile in the pool. */
function percentile(x: number, pool: number[]): number {
    if (pool.length === 0) return NaN
    const below = pool.filter(v => v < x).length
    const eq = pool.filter(v => v === x).length
    return (below + eq / 2) / pool.length
}

/**
 * Exact Mann-Whitney null distribution via the interleaving DP (Gaussian-binomial coefficients):
 * dp[i][j] over U = #{(A after B) pairs}. U_obs > null ⇒ positives larger. Ties in U_obs are
 * counted at 0.5 and the greater-tail p is taken at floor(U_obs) (conservative — larger p).
 * Returns the one-sided p that positives are LARGER, and the exact minimum achievable p.
 */
function mwuGreater(pos: number[], neg: number[]): {U: number; ties: number; p: number; pFloor: number} {
    const m = pos.length
    const n = neg.length
    let U = 0
    let ties = 0
    for (const a of pos)
        for (const b of neg) {
            if (a > b) U += 1
            else if (a === b) {
                U += 0.5
                ties++
            }
        }
    // dp[j] = polynomial over U for a sequence of i A's and j B's; appending an A adds j
    // inversions (j B's already before it), appending a B adds 0. Start at i=0: U=0 for every j.
    let dp: Float64Array[] = Array.from({length: n + 1}, () => Float64Array.of(1))
    for (let i = 1; i <= m; i++) {
        const next: Float64Array[] = []
        next[0] = Float64Array.of(1) // i A's, 0 B's ⇒ U=0 (no B before any A)
        for (let j = 1; j <= n; j++) {
            const shifted = shift(dp[j], j) // append an A to the i-1,j sequence
            const same = next[j - 1] // append a B to the i,j-1 sequence
            const acc = new Float64Array(Math.max(shifted.length, same.length))
            for (let u = 0; u < shifted.length; u++) acc[u] += shifted[u]
            for (let u = 0; u < same.length; u++) acc[u] += same[u]
            next[j] = acc
        }
        dp = next
    }
    const dist = dp[n]
    const total = dist.reduce((a, b) => a + b, 0)
    const uFloor = Math.floor(U)
    let ge = 0
    for (let u = uFloor; u < dist.length; u++) ge += dist[u]
    return {U, ties, p: ge / total, pFloor: 1 / total}
}

function shift(poly: Float64Array, by: number): Float64Array {
    const out = new Float64Array(poly.length + by)
    for (let u = 0; u < poly.length; u++) out[u + by] = poly[u]
    return out
}

/** Pearson correlation — for the rep-index rival within negatives. */
function pearson(xs: number[], ys: number[]): number {
    const n = xs.length
    if (n < 3) return NaN
    const mx = mean(xs)
    const my = mean(ys)
    let sxy = 0
    let sxx = 0
    let syy = 0
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my)
        sxx += (xs[i] - mx) ** 2
        syy += (ys[i] - my) ** 2
    }
    return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy)
}

const f0 = (x: number): string => (Number.isFinite(x) ? x.toFixed(0) : 'n/a')
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : 'n/a')
const pct = (x: number): string => (Number.isFinite(x) ? `${(100 * x).toFixed(0)}%` : 'n/a')

// ─── load ────────────────────────────────────────────────────────────────────

function loadNegatives(): Scored[] {
    const p = path.join(STOP_DIR, 'stopping-point.json')
    if (!fs.existsSync(p)) throw new Error(`missing ${p} — set STOP_DIR`)
    const reps = (JSON.parse(fs.readFileSync(p, 'utf8')) as (NegRep & {error?: string})[]).filter(
        r => !r.error
    )
    return reps.map(r =>
        score(`NEG ${r.fixture} r${r.rep}`, r.fixture, r.rep, 'NEG', r.apisPrompt, r.apisSection)
    )
}

function loadPositives(): Scored[] {
    const abJson = path.join(AB_DIR, 'ab.json')
    const ab: AbRep[] = fs.existsSync(abJson) ? JSON.parse(fs.readFileSync(abJson, 'utf8')) : []
    const out: Scored[] = []
    for (const pos of POSITIVES) {
        const dumpPath = path.join(AB_DIR, pos.arm, pos.fixture, `trial-${pos.rep}`, 'prompts.txt')
        if (!fs.existsSync(dumpPath)) {
            console.error(`WARN: positive ${pos.arm}/${pos.fixture} r${pos.rep} — no ${dumpPath}, SKIPPED`)
            continue
        }
        const apisPrompt = apisPromptFromDump(fs.readFileSync(dumpPath, 'utf8'))
        const abRep = ab.find(a => a.arm === pos.arm && a.fixture === pos.fixture && a.rep === pos.rep)
        const section = abRep?.apisSection ?? ''
        if (abRep && abRep.groundingCalls !== 0 && pos.arm === 'baseline')
            console.error(`WARN: ${pos.fixture} r${pos.rep} baseline groundingCalls=${abRep.groundingCalls} ≠ 0`)
        out.push(
            score(
                `POS ${pos.arm} ${pos.fixture} r${pos.rep}`,
                pos.fixture,
                pos.rep,
                'POS',
                apisPrompt,
                section
            )
        )
    }
    return out
}

// ─── report ──────────────────────────────────────────────────────────────────

function reportMetric(name: string, get: (s: Scored) => number, pos: Scored[], neg: Scored[]): void {
    const nv = neg.map(get)
    const pv = pos.map(get)
    console.log(`\n=== ${name} ===`)
    console.log(
        `  NEG n=${nv.length}: min ${f0(Math.min(...nv))}  median ${f0(median(nv))}`
            + `  mean ${f2(mean(nv))}  max ${f0(Math.max(...nv))}`
    )
    for (const s of pos) {
        const v = get(s)
        console.log(
            `  POS ${s.label.replace('POS ', '').padEnd(26)} ${f2(v).padStart(9)}`
                + `   percentile-in-NEG ${pct(percentile(v, nv))}`
                + `   (vs same-fixture-NEG ${pct(
                    percentile(
                        v,
                        neg.filter(x => x.fixture === s.fixture).map(get)
                    )
                )})`
        )
    }
    const {U, ties, p, pFloor} = mwuGreater(pv, nv)
    console.log(
        `  Mann-Whitney (POS > NEG): U=${U}  ties=${ties}  one-sided p=${p.toFixed(4)}`
            + `   [exact floor at this n = ${pFloor.toExponential(1)}]`
    )
}

function main(): void {
    const neg = loadNegatives()
    const pos = loadPositives()
    console.log(`apis-map-completeness — OFFLINE, no model time`)
    console.log(`  NEG (retrieved)      ${neg.length} reps  ${STOP_DIR}/stopping-point.json`)
    console.log(`  POS (zero-retrieval) ${pos.length} reps  ${AB_DIR}/{arm}/{fixture}/trial-N/prompts.txt`)
    console.log(`  preserved 1/16 task27-hono rep2: NO prompt capture on disk — map LOST, not counted`)

    // Sanity: every rep actually carried a FILES map.
    const noMap = [...neg, ...pos].filter(s => s.mapBytes === 0)
    if (noMap.length) console.log(`  WARN: ${noMap.length} rep(s) had an EMPTY map: ${noMap.map(s => s.label).join(', ')}`)

    reportMetric('MAP BYTES', s => s.mapBytes, pos, neg)
    reportMetric('MAP LINES (non-empty)', s => s.mapLines, pos, neg)
    reportMetric('MAP ENTRIES (path-headed lines)', s => s.mapEntries, pos, neg)
    reportMetric('MAP FRACTION of apis prompt (rival: total prompt size)', s => s.mapFrac, pos, neg)

    // Coverage — SECONDARY (recovered section for the 3 treatment reps).
    console.log(`\n=== COVERAGE of emitted APIS section by the map (SECONDARY) ===`)
    console.log(`  NEG mean path-cov ${pct(mean(neg.map(s => (s.pathTotal ? s.pathCovered / s.pathTotal : 0))))}`
        + `  sym-cov ${pct(mean(neg.map(s => (s.symTotal ? s.symCovered / s.symTotal : 0))))}`)
    for (const s of pos)
        console.log(
            `  POS ${s.label.replace('POS ', '').padEnd(26)} path ${s.pathCovered}/${s.pathTotal}`
                + ` = ${pct(s.pathTotal ? s.pathCovered / s.pathTotal : 0)}`
                + `   sym ${s.symCovered}/${s.symTotal} = ${pct(s.symTotal ? s.symCovered / s.symTotal : 0)}`
                + (s.rep === 13 && s.fixture === 'task28-wouter' ? '  [actual zero-retrieval section]' : '  [recovered section]')
        )

    // Rivals.
    console.log(`\n=== RIVALS ===`)
    for (const f of [...new Set(neg.map(s => s.fixture))]) {
        const fn = neg.filter(s => s.fixture === f)
        console.log(`  fixture ${f.padEnd(15)} NEG map-bytes median ${f0(median(fn.map(s => s.mapBytes)))}  (n=${fn.length})`)
    }
    console.log(
        `  rep-index vs map-bytes in NEG: Pearson r = ${f2(pearson(neg.map(s => s.rep), neg.map(s => s.mapBytes)))}`
            + `   [rival: is map size just an ordering artefact?]`
    )
    console.log(`  POS reps sit at rep {${pos.map(s => s.rep).sort((a, b) => a - b).join(', ')}} — not systematically early/late`)

    console.log(
        `\nREADING: positives LARGER than negatives on map size ⇒ SIGNAL (map completeness separates`
            + `\n  the classes — worth a live manipulation next). Positives inside the negative bulk ⇒ NO`
            + `\n  SIGNAL (intermittency is variance; gate stays a committed safety net, no further lever).`
            + `\n  Correlation only — this script does NOT claim the map CAUSES zero retrieval.`
    )
}

main()
