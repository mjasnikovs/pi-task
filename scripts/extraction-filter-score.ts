/**
 * STEP 0 (part 3) — score candidate PRECISION filters offline against the real
 * extraction pool. No model calls: reads extraction-pool.json produced by
 * extraction-precision-step0.ts.
 *
 * Established so far:
 *   - single-pass yield 23..123 on a fixed spec (sd ~36), 186 distinct quotes
 *     across 8 runs, only 5 present in all 8;
 *   - the tail is MIXED — genuine high-value obligations (the test-cadence line,
 *     the `non-/api GETs serve the built index.html` clause) sit alongside
 *     truncated expressions, dependency pins and schema rows.
 *
 * So k-of-n voting is disqualified: any threshold above 1 deletes requirements
 * whose loss has already cost a run. What is left is to raise PRECISION without
 * touching recall of genuine items — freeing the 40-slot budget for real
 * obligations instead of fragments.
 *
 * A filter is only admissible if it removes NONE of the CRITICAL quotes below.
 * That list is the FP suite: obligations whose loss is known, from this repo's
 * own history, to have shipped a broken run.
 *
 * Run: bun run scripts/extraction-filter-score.ts
 */
import {readFileSync} from 'node:fs'

const POOL =
    '/tmp/claude-1000/-home-edgars--pi-agent-extensions-pi-task/d98b4c23-de00-43f3-8c79-a6f4b3d7af57/scratchpad/extraction-pool.json'

interface Entry {
    freq: number
    quote: string
}

/**
 * FP SUITE — substrings of obligations that MUST survive any filter.
 * Each traces to a real failure or a spec obligation of record:
 *  - index.html serving: its loss shipped a permanently blank app (run 16)
 *  - test cadence: the §10 obligation with no carrier (run 11)
 *  - photo cap / ownership / ban: the admin+ownership contract
 *  - atomic invite consume: the concurrency obligation
 */
const CRITICAL = [
    // Added after adjudicating the first scoring run's dropped sample: these were
    // false positives of the un-gated dependency-pin and `;`-truncation rules.
    'one strict `tsconfig.json`',
    'printWidth 120',
    'no-explicit-any',
    'tsc --noEmit',
    'serve the built',
    'a test lands',
    'spec.tsx',
    'photo upload limit',
    'Consume is atomic',
    'Zod-validate every input',
    'never ship phone',
    'Ownership/role checks server-side',
    'rate-limit on login',
    'Argon2id',
    'parameterized queries',
    'banned'
]

// ── candidate filters ────────────────────────────────────────────────────────

/** Unbalanced code fence / bracket ⇒ the quote was cut mid-expression. */
function isTruncated(q: string): boolean {
    const ticks = (q.match(/`/g) ?? []).length
    if (ticks % 2 === 1) return true
    for (const [open, close] of [
        ['(', ')'],
        ['[', ']'],
        ['{', '}']
    ]) {
        const o = (q.match(new RegExp(`\\${open}`, 'g')) ?? []).length
        const c = (q.match(new RegExp(`\\${close}`, 'g')) ?? []).length
        if (o > c) return true
    }
    // NOT `;` — a complete clause legitimately ends with one. Dropping on `;`
    // discarded `lint` = `prettier --write … && eslint --fix . && tsc --noEmit`;
    // which is a runnable obligation, not a truncation.
    return /[,:([{]\s*$/.test(q.trim())
}

/**
 * A dependency pin or version row: `name` `x.y.z` — data, not an obligation.
 *
 * LENGTH-GATED. A bare pin (``hono`` `4.12.27` — HTTP framework, RPC) is data,
 * but several spec lines OPEN with a pin and then carry real obligations:
 *   TypeScript `6.0.3` — one strict `tsconfig.json`: `strict`,
 *   `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, …
 *   Prettier `3.9.4` — `printWidth 120`, no semicolons, single quotes, …
 *   ESLint `10.6.0` … `no-explicit-any: error`, `no-shadow: error` …
 * A first cut dropped all three. Real pins in this corpus run 32..48 chars;
 * the obligation-bearing ones run 130..260. The gate keeps the long ones.
 */
const MAX_PIN_LENGTH = 80

function isDependencyPin(q: string): boolean {
    const t = q.trim().replace(/^\*\*|\*\*$/g, '')
    if (t.length > MAX_PIN_LENGTH) return false
    return /^\**[`*]?[\w@/-]+[`*]?\**\s*[`']?\d+\.\d+/.test(t)
}

/** A DDL/schema row: `col type ... not null`, `id uuid pk`, index definitions. */
function isSchemaRow(q: string): boolean {
    return /^\s*[\w_]+\s+(?:uuid|text|int|integer|bigint|boolean|timestamptz|bytea|jsonb|numeric|smallint)\b/i.test(
        q
    )
}

/** Too short to state an obligation. MIN_QUOTE_LENGTH is 6 today — "Contact
 *  seller" (14 chars) passes it. A clause needs a subject and a predicate. */
function isFragment(q: string): boolean {
    const t = q.trim()
    return t.length < 25 || t.split(/\s+/).length < 4
}

const FILTERS: {name: string; f: (q: string) => boolean}[] = [
    {name: 'truncated mid-expression', f: isTruncated},
    {name: 'dependency pin', f: isDependencyPin},
    {name: 'schema/DDL row', f: isSchemaRow},
    {name: 'fragment (<25 chars or <4 words)', f: isFragment}
]

function main() {
    const pool = JSON.parse(readFileSync(POOL, 'utf8')) as {
        reps: number
        yields: number[]
        quotes: Entry[]
    }
    const all = pool.quotes
    console.log(`\n=== FILTER SCORING over ${all.length} distinct quotes (${pool.reps} runs) ===`)
    console.log(`    single-pass yields: ${pool.yields.join(', ')}\n`)

    const removedBy = new Map<string, Entry[]>()
    const survives = (q: string): boolean => !FILTERS.some(x => x.f(q))

    for (const {name, f} of FILTERS) {
        const hit = all.filter(e => f(e.quote))
        removedBy.set(name, hit)
        const inTail = hit.filter(e => e.freq === 1).length
        console.log(
            `  ${name.padEnd(34)} removes ${String(hit.length).padStart(3)} `
                + `(${((100 * hit.length) / all.length).toFixed(0)}%)  of which freq-1: ${inTail}`
        )
    }

    const kept = all.filter(e => survives(e.quote))
    const dropped = all.filter(e => !survives(e.quote))
    console.log(
        `\n  COMBINED: keeps ${kept.length}/${all.length} `
            + `(${((100 * kept.length) / all.length).toFixed(0)}%), drops ${dropped.length}`
    )

    // ── FP suite: every critical obligation must survive ──────────────────────
    console.log(`\n  FP SUITE — critical obligations that must survive:`)
    let broken = 0
    for (const needle of CRITICAL) {
        const matches = all.filter(e => e.quote.toLowerCase().includes(needle.toLowerCase()))
        if (matches.length === 0) {
            console.log(`    ??  "${needle}" — NOT IN POOL (extractor never produced it this run)`)
            continue
        }
        const survivors = matches.filter(e => survives(e.quote))
        if (survivors.length === 0) {
            broken++
            console.log(`    FP  "${needle}" — ALL ${matches.length} match(es) removed:`)
            for (const m of matches.slice(0, 2)) {
                const why = FILTERS.filter(x => x.f(m.quote)).map(x => x.name)
                console.log(`          [${why.join(', ')}] ${m.quote.slice(0, 120)}`)
            }
        } else {
            console.log(
                `    ok  "${needle}" — ${survivors.length}/${matches.length} survive `
                    + `(max freq ${Math.max(...survivors.map(s => s.freq))}/${pool.reps})`
            )
        }
    }

    console.log(`\n  ${broken === 0 ? 'ADMISSIBLE — no critical obligation removed' : `INADMISSIBLE — ${broken} critical obligation(s) removed`}`)

    console.log(`\n  SAMPLE OF DROPPED (adjudicate for false positives):`)
    for (const e of dropped.slice(0, 20)) {
        const why = FILTERS.filter(x => x.f(e.quote)).map(x => x.name)
        console.log(`    freq ${e.freq}  [${why.join(', ')}]  ${e.quote.slice(0, 110)}`)
    }
    console.log('')
}

main()
