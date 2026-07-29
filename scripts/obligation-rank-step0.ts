/**
 * STEP 0 for the proposed OBLIGATION-RANKING key (nexttask TASK 1, "what to try
 * next"): before scoring a ranking change end to end, ask whether the proposed
 * key DISCRIMINATES at all.
 *
 * The proposal is to promote OBLIGATION_RE — the measurement proxy in
 * extraction-precision-step0.ts — to a ranking key inside sectionFairFill's
 * in-bucket order. A ranking key is only useful if it splits the pool: a
 * predicate that fires on 95% of quotes reorders nothing, and a predicate that
 * fires on the junk as often as on the obligations reorders the wrong way.
 *
 * Three numbers decide whether the end-to-end A/B is worth running:
 *   1. FIRING RATE over each pool's distinct quotes (near 1.0 ⇒ inert key).
 *   2. Firing rate on the CRITICAL-obligation carriers vs everything else — the
 *      key must be MORE likely to fire on a carrier than on a non-carrier, or it
 *      ranks the wrong things up.
 *   3. IN-BUCKET rate: the ranking happens inside one section's bucket, so what
 *      matters is not the global rate but whether a typical bucket contains both
 *      firing and non-firing entries. A bucket that is all-fire or all-quiet is
 *      reordered by exactly nothing.
 *
 * No model calls — reads the recorded pools.
 *
 * Run: bun run scripts/obligation-rank-step0.ts
 */
import {readFileSync} from 'node:fs'
import {normalise} from '../src/task/contracts.js'

const SPEC = readFileSync('/home/edgars/hub/mx5/DESIGN/PROJECT.md', 'utf8')
const POOLS = ['.measure/extraction-pool.json', '.measure/extraction-pool-confirm.json']

/** VERBATIM from extraction-precision-step0.ts — the candidate key, unmodified.
 *  Copying it is deliberate: this script asks whether THAT regex discriminates,
 *  so it must not silently track a later edit of a different one. */
const OBLIGATION_RE =
    /\b(?:must|shall|should|required?|requires|needs? to|has to|have to|never|not|no|only|always|every|each|at least|at most|max|min|cannot|can'?t|don'?t|do not|ensure|enforce|validate|reject|forbid|prohibit)\b/i

/** VERBATIM from extraction-filter-endtoend.ts — the metric's critical list. */
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

const isCarrier = (q: string): boolean =>
    CRITICAL.some(n => q.toLowerCase().includes(n.toLowerCase()))

/** Mirrors normalisedSections() in src/task/requirements.ts (not exported). */
function normalisedSections(doc: string): string[] {
    const out: string[] = []
    let current: string[] = []
    for (const line of doc.replace(/\r\n?/g, '\n').split('\n')) {
        if (/^#{1,6}\s+\S/.test(line)) {
            if (current.length > 0) out.push(normalise(current.join('\n')))
            current = [line]
            continue
        }
        current.push(line)
    }
    if (current.length > 0) out.push(normalise(current.join('\n')))
    return out.filter(s => s.length > 0)
}

const SECTIONS = normalisedSections(SPEC)

function bucketOf(quote: string): number {
    const q = normalise(quote)
    const b = SECTIONS.findIndex(s => s.includes(q))
    return b < 0 ? SECTIONS.length : b
}

function pct(a: number, b: number): string {
    return b === 0 ? '   n/a' : `${((100 * a) / b).toFixed(1)}%`
}

function main() {
    for (const path of POOLS) {
        const pool = JSON.parse(readFileSync(path, 'utf8')) as {runs: string[][]}
        const distinct = [...new Set(pool.runs.flat())]

        const fires = distinct.filter(q => OBLIGATION_RE.test(q))
        const carriers = distinct.filter(isCarrier)
        const nonCarriers = distinct.filter(q => !isCarrier(q))
        const carrierFires = carriers.filter(q => OBLIGATION_RE.test(q))
        const nonCarrierFires = nonCarriers.filter(q => OBLIGATION_RE.test(q))

        console.log(`\n=== ${path} — ${pool.runs.length} runs, ${distinct.length} distinct quotes ===`)
        console.log(`  1. FIRING RATE            ${fires.length}/${distinct.length}  ${pct(fires.length, distinct.length)}`)
        console.log(`  2. on CRITICAL carriers   ${carrierFires.length}/${carriers.length}  ${pct(carrierFires.length, carriers.length)}`)
        console.log(`     on everything else     ${nonCarrierFires.length}/${nonCarriers.length}  ${pct(nonCarrierFires.length, nonCarriers.length)}`)
        console.log(
            `     lift                   ${(
                carriers.length === 0 || nonCarriers.length === 0 ?
                    NaN
                :   carrierFires.length / carriers.length / (nonCarrierFires.length / nonCarriers.length)
            ).toFixed(2)}x`
        )

        // 3. IN-BUCKET SPLIT, measured PER RUN — the cap runs per run, and a
        //    bucket only gets reordered when it holds a mix.
        let mixedBuckets = 0
        let allFire = 0
        let allQuiet = 0
        let singleton = 0
        let reorderableEntries = 0
        let totalEntries = 0
        for (const run of pool.runs) {
            const buckets = new Map<number, string[]>()
            for (const q of run) {
                const b = bucketOf(q)
                buckets.set(b, [...(buckets.get(b) ?? []), q])
            }
            for (const list of buckets.values()) {
                totalEntries += list.length
                if (list.length === 1) {
                    singleton++
                    continue
                }
                const f = list.filter(q => OBLIGATION_RE.test(q)).length
                if (f === 0) allQuiet++
                else if (f === list.length) allFire++
                else {
                    mixedBuckets++
                    reorderableEntries += list.length
                }
            }
        }
        const buckets = mixedBuckets + allFire + allQuiet + singleton
        console.log(`  3. buckets across all runs ${buckets}`)
        console.log(`     mixed (reorderable)    ${mixedBuckets}  ${pct(mixedBuckets, buckets)}`)
        console.log(`     all-fire               ${allFire}  ${pct(allFire, buckets)}`)
        console.log(`     all-quiet              ${allQuiet}  ${pct(allQuiet, buckets)}`)
        console.log(`     singleton              ${singleton}  ${pct(singleton, buckets)}`)
        console.log(
            `     entries in mixed buckets ${reorderableEntries}/${totalEntries}  ${pct(reorderableEntries, totalEntries)}`
        )
    }
    console.log('')
}

main()
