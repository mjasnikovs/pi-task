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
const POOL =
    '/tmp/claude-1000/-home-edgars--pi-agent-extensions-pi-task/d98b4c23-de00-43f3-8c79-a6f4b3d7af57/scratchpad/extraction-pool.json'

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

function criticalHits(quotes: string[]): string[] {
    return CRITICAL.filter(n => quotes.some(q => q.toLowerCase().includes(n.toLowerCase())))
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
    let baseOwnable = 0
    let filtOwnable = 0
    const perRun: string[] = []

    console.log(`\n=== FILTER → CAP, end to end, ${pool.runs.length} recorded runs ===`)
    console.log(`    metric: how many of ${CRITICAL.length} critical obligations reach the shipped 40\n`)

    for (let i = 0; i < pool.runs.length; i++) {
        const raw = pool.runs[i]
        const filtered = raw.filter(q => !isJunk(q))

        const baseKept = capRequirements(asEntries(raw), passages, SPEC).map(e => e.quote)
        const filtKept = capRequirements(asEntries(filtered), passages, SPEC).map(e => e.quote)

        const bHits = criticalHits(baseKept)
        const fHits = criticalHits(filtKept)
        const bOwn = baseKept.filter(q => !isCrossCuttingRequirement(q)).length
        const fOwn = filtKept.filter(q => !isCrossCuttingRequirement(q)).length

        baseTotal += bHits.length
        filtTotal += fHits.length
        baseOwnable += bOwn
        filtOwnable += fOwn

        const gained = fHits.filter(h => !bHits.includes(h))
        const lost = bHits.filter(h => !fHits.includes(h))
        perRun.push(
            `  run ${String(i + 1).padStart(2)}: yield ${String(raw.length).padStart(3)} → `
                + `filtered ${String(filtered.length).padStart(3)} | shipped ${baseKept.length}→${filtKept.length} | `
                + `critical ${bHits.length}→${fHits.length}`
                + `${gained.length > 0 ? `  +[${gained.join(', ')}]` : ''}`
                + `${lost.length > 0 ? `  LOST[${lost.join(', ')}]` : ''}`
        )
    }
    for (const l of perRun) console.log(l)

    const n = pool.runs.length
    console.log(`\n  critical obligations in shipped list — mean per run:`)
    console.log(`    baseline ${(baseTotal / n).toFixed(2)} / ${CRITICAL.length}`)
    console.log(`    filtered ${(filtTotal / n).toFixed(2)} / ${CRITICAL.length}`)
    const delta = (filtTotal - baseTotal) / n
    console.log(`    delta    ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} per run`)
    console.log(`\n  ownable requirements shipped — mean per run:`)
    console.log(`    baseline ${(baseOwnable / n).toFixed(1)}  (floor ${granularityFloor(Math.round(baseOwnable / n))})`)
    console.log(`    filtered ${(filtOwnable / n).toFixed(1)}  (floor ${granularityFloor(Math.round(filtOwnable / n))})`)
    console.log('')
}

main()
