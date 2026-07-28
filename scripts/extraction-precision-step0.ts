/**
 * STEP 0 (part 2) — is the extractor SAMPLING a stable set of real obligations,
 * or GENERATING spurious ones from ordinary prose?
 *
 * Part 1 (extraction-stability-step0.ts) established the churn: on a fixed 20KB
 * spec, pre-cap Jaccard 0.485, 204 distinct "requirements" across 8 runs, only
 * 15% present in every run. That says the set is unstable. It does NOT say why,
 * and the two causes need opposite fixes:
 *
 *   SAMPLING  — a stable pool of genuine obligations, each drawn with p<1.
 *               Fix: k-of-n voting or union across passes. Costs model calls.
 *   GENERATING — the model manufactures "requirements" out of prose that
 *               obligates nothing. Fix: a precision filter. Voting would make it
 *               WORSE by stabilising junk that happens to recur.
 *
 * `keepGroundedRequirements` cannot separate them: it only checks the quote is a
 * verbatim substring of the doc, so any sentence at all passes. Precision rests
 * entirely on the model.
 *
 * Method: N single-pass extractions (NO forced re-extraction — that unions two
 * passes and confounds yield, which is why part 1's 47..153 range is overstated).
 * Bucket every quote by how many runs it appeared in, then report per bucket:
 *   - how many carry an explicit obligation marker (modal / prohibition), the
 *     mechanical proxy for "this sentence obligates something";
 *   - a sample, dumped to a file, for eyeball adjudication.
 *
 * If the CORE (present in every run) is obligation-dense and the TAIL (present
 * once) is not, the defect is precision. If both look alike, it is sampling.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/extraction-precision-step0.ts [REPS]
 */
import {readFileSync, writeFileSync} from 'node:fs'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    isCrossCuttingRequirement
} from '../src/task/requirements.js'

const SPEC = readFileSync('/home/edgars/hub/mx5/DESIGN/PROJECT.md', 'utf8')
const SCRATCH =
    '/tmp/claude-1000/-home-edgars--pi-agent-extensions-pi-task/d98b4c23-de00-43f3-8c79-a6f4b3d7af57/scratchpad'
const OUT = `${SCRATCH}/extraction-buckets.txt`
/** Full pool as data, so filter candidates can be designed and scored offline
 *  (no model calls) against the exact quotes the extractor really produced. */
const POOL = `${SCRATCH}/extraction-pool.json`
const deps: PhaseDeps = {cwd: process.cwd(), taskId: '', signal: new AbortController().signal}

/** Mechanical "does this sentence obligate anything" proxy. Deliberately GENEROUS —
 *  it counts a quote as obligating on any modal, prohibition, or requirement noun,
 *  so a low score is strong evidence of junk rather than a strict-filter artifact. */
const OBLIGATION_RE =
    /\b(?:must|shall|should|required?|requires|needs? to|has to|have to|never|not|no|only|always|every|each|at least|at most|max|min|cannot|can'?t|don'?t|do not|ensure|enforce|validate|reject|forbid|prohibit)\b/i

/** Structural spec lines that are data, not obligations: schema rows, dep pins. */
const LOOKS_STRUCTURAL_RE = /^[`\w.@/-]+\s+[`\d]/

function key(q: string): string {
    return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '8', 10)
    const passages = enumerateObligationPassages(SPEC)
    const runs: Set<string>[] = []
    const text = new Map<string, string>()

    for (let rep = 1; rep <= reps; rep++) {
        // SINGLE pass only — no re-extraction union.
        const reqs = keepGroundedRequirements(
            parseRequirementLines(
                await runPhaseChild(
                    deps,
                    'requirement-extract',
                    '',
                    REQUIREMENT_EXTRACT_PROMPT(SPEC, passages)
                )
            ),
            SPEC
        )
        const ks = new Set<string>()
        for (const r of reqs) {
            const k = key(r.quote)
            ks.add(k)
            if (!text.has(k)) text.set(k, r.quote)
        }
        runs.push(ks)
        console.log(`rep ${rep}: single-pass yield ${reqs.length}`)
    }

    const freq = new Map<string, number>()
    for (const s of runs) for (const k of s) freq.set(k, (freq.get(k) ?? 0) + 1)

    const yields = runs.map(s => s.size)
    const mean = yields.reduce((a, b) => a + b, 0) / reps
    const sd = Math.sqrt(yields.reduce((a, b) => a + (b - mean) ** 2, 0) / reps)
    console.log(`\n=== SINGLE-PASS yield: min ${Math.min(...yields)} max ${Math.max(...yields)} mean ${mean.toFixed(1)} sd ${sd.toFixed(2)} ===`)
    console.log(`    distinct quotes across ${reps} runs: ${freq.size}`)

    const lines: string[] = []
    console.log(`\n  freq  n     obligating   structural   cross-cutting`)
    for (let f = reps; f >= 1; f--) {
        const bucket = [...freq.entries()].filter(([, c]) => c === f).map(([k]) => text.get(k) as string)
        if (bucket.length === 0) continue
        const ob = bucket.filter(q => OBLIGATION_RE.test(q)).length
        const st = bucket.filter(q => LOOKS_STRUCTURAL_RE.test(q.trim())).length
        const cc = bucket.filter(q => isCrossCuttingRequirement(q)).length
        console.log(
            `  ${String(f).padStart(4)}  ${String(bucket.length).padStart(4)}  `
                + `${String(ob).padStart(6)} (${((100 * ob) / bucket.length).toFixed(0)}%)  `
                + `${String(st).padStart(6)} (${((100 * st) / bucket.length).toFixed(0)}%)  `
                + `${String(cc).padStart(6)} (${((100 * cc) / bucket.length).toFixed(0)}%)`
        )
        lines.push(`\n########## seen in ${f}/${reps} runs — ${bucket.length} quote(s) ##########`)
        for (const q of bucket.slice(0, 25)) lines.push(`  ${q.slice(0, 200)}`)
    }
    writeFileSync(OUT, lines.join('\n'))
    writeFileSync(
        POOL,
        JSON.stringify(
            {
                reps,
                yields,
                quotes: [...freq.entries()].map(([k, c]) => ({freq: c, quote: text.get(k) as string})),
                // PER-RUN sets: needed to simulate filter→cap end to end, i.e.
                // whether filtering actually gets more critical obligations into
                // the shipped 40 rather than merely removing junk from the pool.
                runs: runs.map(s2 => [...s2].map(k => text.get(k) as string))
            },
            null,
            2
        )
    )
    console.log(`\n  buckets dumped for adjudication: ${OUT}\n`)
}

void main()
