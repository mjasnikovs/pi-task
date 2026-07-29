/**
 * STEP 0 (part 4) — does the precision filter actually get more CRITICAL
 * obligations into the shipped 40, or does it merely tidy the pool?
 *
 * Removing 27% junk from a 208-quote pool is not the same result as landing more
 * real requirements in the 40 that `requirements.md` actually carries. Only the
 * latter justifies changing production code. This replays each recorded run
 * through the REAL cap (capRequirements, marked-priority + sectionFairFill) with
 * and without the filter, and scores how many critical obligations survive to the
 * shipped list.
 *
 * No model calls — reads the per-run sets from extraction-pool.json.
 *
 * Run: bun run scripts/extraction-filter-endtoend.ts
 */
import {readFileSync} from 'node:fs'
import {
    capRequirements,
    enumerateObligationPassages,
    isCrossCuttingRequirement,
    type RequirementEntry
} from '../src/task/requirements.js'
import {granularityFloor} from '../src/task/decompose-granularity.js'

const SPEC = readFileSync('/home/edgars/hub/mx5/DESIGN/PROJECT.md', 'utf8')
/** Defaults to the design pool; pass a path to score a CONFIRMATION pool. */
const POOL = process.argv[2] ?? '.measure/extraction-pool.json'

const CRITICAL = [
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

// ── the candidate filter (as scored in part 3) ───────────────────────────────
const MAX_PIN_LENGTH = 80

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
    return /[,:([{]\s*$/.test(q.trim())
}
function isDependencyPin(q: string): boolean {
    const t = q.trim().replace(/^\*\*|\*\*$/g, '')
    if (t.length > MAX_PIN_LENGTH) return false
    return /^\**[`*]?[\w@/-]+[`*]?\**\s*[`']?\d+\.\d+/.test(t)
}
function isSchemaRow(q: string): boolean {
    return /^\s*[\w_]+\s+(?:uuid|text|int|integer|bigint|boolean|timestamptz|bytea|jsonb|numeric|smallint)\b/i.test(
        q
    )
}
function isFragment(q: string): boolean {
    const t = q.trim()
    return t.length < 25 || t.split(/\s+/).length < 4
}
const isJunk = (q: string): boolean =>
    isTruncated(q) || isDependencyPin(q) || isSchemaRow(q) || isFragment(q)

/** Mirrors MAX_REQUIREMENTS in src/task/requirements.ts (not exported). */
const CAP = 40

/**
 * BUDGETED filtering. The filter's entire justification is that junk consumes
 * slots real obligations need; below the cap there are no contested slots, so
 * dropping anything there is destruction with no compensating benefit. So filter
 * only down to the cap, restoring the dropped entries in doc order if the clean
 * list undershoots.
 *
 * This is not a patch fitted to an observed loss — it follows from what the
 * filter is FOR — but it was written after seeing one, so the run that motivated
 * it cannot also confirm it. See the run report.
 */
function budgetedFilter(raw: string[]): string[] {
    const keep = raw.filter(q => !isJunk(q))
    if (keep.length >= CAP) return keep
    // Restore in SOURCE-DOC order, not extraction order. Which entries come back
    // only matters when more were dropped than there are free slots, and doc order
    // is the neutral choice — picking a rule that favours the one quote whose loss
    // was observed would be fitting the tie-break to this pool. It is also the
    // order sectionFairFill already treats as canonical.
    const dropped = raw
        .filter(q => isJunk(q))
        .map(q => ({q, at: SPEC.indexOf(q.trim()) < 0 ? Number.MAX_SAFE_INTEGER : SPEC.indexOf(q.trim())}))
        .sort((x, y) => x.at - y.at)
        .map(x => x.q)
    return [...keep, ...dropped.slice(0, CAP - keep.length)]
}

function criticalHits(quotes: string[]): string[] {
    return CRITICAL.filter(n => quotes.some(q => q.toLowerCase().includes(n.toLowerCase())))
}

/**
 * TAIL-SECTION COVERAGE — the constraint any selection change must not break.
 * sectionFairFill exists because a plain first-N cap cut all 138 entries past the
 * cap in run 16, every one from the design's tail, including the clause whose
 * loss shipped a blank app. So "more critical obligations" is not sufficient: a
 * ranking that buys them by starving the tail has re-created the run-16 defect.
 * Measured as: of the doc's last third of sections, how many still have at least
 * one quote in the shipped list.
 */
const SECTION_STARTS = (() => {
    const out: {name: string; at: number}[] = []
    const re = /^#{1,6}\s+(\S.*)$/gm
    for (const m of SPEC.matchAll(re)) out.push({name: m[1].trim(), at: m.index ?? 0})
    return out
})()
const TAIL_SECTIONS = SECTION_STARTS.slice(Math.ceil((SECTION_STARTS.length * 2) / 3))

function tailSectionsHit(quotes: string[]): number {
    const positions = quotes
        .map(q => SPEC.indexOf(q.trim()))
        .filter(i => i >= 0)
    return TAIL_SECTIONS.filter((s, i) => {
        const end = i + 1 < TAIL_SECTIONS.length ? TAIL_SECTIONS[i + 1].at : SPEC.length
        return positions.some(p => p >= s.at && p < end)
    }).length
}

function main() {
    const pool = JSON.parse(readFileSync(POOL, 'utf8')) as {reps: number; runs: string[][]}
    if (!pool.runs) {
        console.error('pool JSON has no per-run sets — re-run extraction-precision-step0.ts')
        process.exitCode = 2
        return
    }
    const passages = enumerateObligationPassages(SPEC)
    const asEntries = (qs: string[]): RequirementEntry[] =>
        qs.map(q => ({quote: q, anchor: 'prose'}) as RequirementEntry)

    let baseTotal = 0
    let filtTotal = 0
    let budgTotal = 0
    let baseOwnable = 0
    let filtOwnable = 0
    let budgOwnable = 0
    const perRun: string[] = []
    // Sign-test tallies, the actual decision statistic. Pooled FP-suite survival
    // is NOT sufficient: a critical obligation can survive somewhere in the pool
    // while the only quote carrying it in a GIVEN run is filtered away.
    let hardGain = 0
    let hardLoss = 0
    let budgGain = 0
    let budgLoss = 0
    let baseTail = 0
    let filtTail = 0
    let budgTail = 0
    let budgTailRegress = 0

    console.log(`\n=== FILTER → CAP, end to end, ${pool.runs.length} recorded runs ===`)
    console.log(`    metric: how many of ${CRITICAL.length} critical obligations reach the shipped 40\n`)

    for (let i = 0; i < pool.runs.length; i++) {
        const raw = pool.runs[i]
        const filtered = raw.filter(q => !isJunk(q))
        const budgeted = budgetedFilter(raw)

        // baseline = the PRE-BUDGET rule via the A/B seam; budgeted = the SHIPPED
        // rule called normally, so this score can never drift from production.
        // `hard` stays a local transcription — it is the rejected variant and has
        // no production counterpart to drift from.
        const baseKept = capRequirements(asEntries(raw), passages, SPEC, false).map(e => e.quote)
        const filtKept = capRequirements(asEntries(filtered), passages, SPEC, false).map(e => e.quote)
        const budgKept = capRequirements(asEntries(raw), passages, SPEC).map(e => e.quote)

        const bHits = criticalHits(baseKept)
        const fHits = criticalHits(filtKept)
        const gHits = criticalHits(budgKept)
        const bOwn = baseKept.filter(q => !isCrossCuttingRequirement(q)).length
        const fOwn = filtKept.filter(q => !isCrossCuttingRequirement(q)).length
        const gOwn = budgKept.filter(q => !isCrossCuttingRequirement(q)).length

        baseTail += tailSectionsHit(baseKept)
        filtTail += tailSectionsHit(filtKept)
        budgTail += tailSectionsHit(budgKept)
        if (tailSectionsHit(budgKept) < tailSectionsHit(baseKept)) budgTailRegress++

        baseTotal += bHits.length
        filtTotal += fHits.length
        budgTotal += gHits.length
        baseOwnable += bOwn
        filtOwnable += fOwn
        budgOwnable += gOwn

        const gained = fHits.filter(h => !bHits.includes(h))
        const lost = bHits.filter(h => !fHits.includes(h))
        const bGained = gHits.filter(h => !bHits.includes(h))
        const bLost = bHits.filter(h => !gHits.includes(h))
        if (fHits.length > bHits.length) hardGain++
        if (fHits.length < bHits.length) hardLoss++
        if (gHits.length > bHits.length) budgGain++
        if (gHits.length < bHits.length) budgLoss++
        perRun.push(
            `  run ${String(i + 1).padStart(2)}: yield ${String(raw.length).padStart(3)} → `
                + `hard ${String(filtered.length).padStart(3)} / budgeted ${String(budgeted.length).padStart(3)} | `
                + `critical ${bHits.length} → hard ${fHits.length} / budgeted ${gHits.length}`
                + `${gained.length > 0 ? `  hard+[${gained.join(', ')}]` : ''}`
                + `${lost.length > 0 ? `  hard LOST[${lost.join(', ')}]` : ''}`
                + `${bLost.length > 0 ? `  BUDGETED LOST[${bLost.join(', ')}]` : ''}`
                + `${bGained.length !== gained.length ? `  (budgeted+[${bGained.join(', ')}])` : ''}`
        )
    }
    for (const l of perRun) console.log(l)

    const n = pool.runs.length
    console.log(`\n  critical obligations in shipped list — mean per run:`)
    console.log(`    baseline       ${(baseTotal / n).toFixed(2)} / ${CRITICAL.length}`)
    console.log(
        `    hard filter    ${(filtTotal / n).toFixed(2)}  (${((filtTotal - baseTotal) / n >= 0 ? '+' : '')}${((filtTotal - baseTotal) / n).toFixed(2)})`
    )
    console.log(
        `    budgeted       ${(budgTotal / n).toFixed(2)}  (${((budgTotal - baseTotal) / n >= 0 ? '+' : '')}${((budgTotal - baseTotal) / n).toFixed(2)})`
    )
    // Two-sided exact sign test over the discordant runs.
    const signP = (g: number, l: number): string => {
        const m = g + l
        if (m === 0) return 'n/a (no discordant runs)'
        const c = (a: number, b: number): number => {
            let r = 1
            for (let k = 0; k < b; k++) r = (r * (a - k)) / (k + 1)
            return r
        }
        const lo = Math.min(g, l)
        let tail = 0
        for (let k = 0; k <= lo; k++) tail += c(m, k)
        return `p=${Math.min(1, (2 * tail) / 2 ** m).toFixed(4)}`
    }
    console.log(`\n  sign test over runs (gain / loss / tie):`)
    console.log(
        `    hard filter    ${hardGain} / ${hardLoss} / ${n - hardGain - hardLoss}   ${signP(hardGain, hardLoss)}`
    )
    console.log(
        `    budgeted       ${budgGain} / ${budgLoss} / ${n - budgGain - budgLoss}   ${signP(budgGain, budgLoss)}`
    )
    console.log(
        `\n  TAIL-SECTION COVERAGE — of the doc's last ${TAIL_SECTIONS.length} sections, how many`
            + ` still have a quote in the shipped list (mean per run):`
    )
    console.log(`    baseline    ${(baseTail / n).toFixed(2)} / ${TAIL_SECTIONS.length}`)
    console.log(`    hard filter ${(filtTail / n).toFixed(2)}`)
    console.log(
        `    budgeted    ${(budgTail / n).toFixed(2)}   regressed in ${budgTailRegress}/${n} run(s)`
    )
    console.log(`\n  ownable requirements shipped — mean per run:`)
    console.log(`    baseline    ${(baseOwnable / n).toFixed(1)}  (floor ${granularityFloor(Math.round(baseOwnable / n))})`)
    console.log(`    hard filter ${(filtOwnable / n).toFixed(1)}  (floor ${granularityFloor(Math.round(filtOwnable / n))})`)
    console.log(`    budgeted    ${(budgOwnable / n).toFixed(1)}  (floor ${granularityFloor(Math.round(budgOwnable / n))})`)
    console.log('')
}

main()
