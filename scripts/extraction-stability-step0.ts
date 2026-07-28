/**
 * STEP 0 — how stable is requirement extraction on a FIXED spec?
 *
 * Everything downstream of extraction is sized by its output: the granularity
 * floor is ceil(ownable / 2), the coverage loop's owned-set indexes into it, and
 * `requirements.md` / `requirements-owned.md` carry it into every task. Scavenged
 * logs from 2026-07-28 suggested the same 20KB mx5 spec yields ownable counts
 * anywhere from 22 to 31 — a floor swinging 11..16 for a byte-identical input —
 * but those came from different harness versions, so they are a hint, not a
 * measurement. This is the measurement.
 *
 * The COUNT is the shallow question. The deep one is whether the same
 * REQUIREMENTS survive: a stable count over a churning set would mean which
 * obligations get carried into the plan is decided by a coin flip nobody sees.
 * So this reports both — count spread, and set overlap across runs (how many
 * quotes appear in EVERY run, how many in exactly one, mean pairwise Jaccard).
 *
 * Mirrors auto-orchestrator.ts:658-683 exactly, cap included.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/extraction-stability-step0.ts [REPS]
 */
import {readFileSync} from 'node:fs'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    isCrossCuttingRequirement,
    capRequirements,
    uncoveredPassages,
    extractionRetryHint,
    type RequirementEntry
} from '../src/task/requirements.js'
import {granularityFloor} from '../src/task/decompose-granularity.js'

const SPEC = readFileSync('/home/edgars/hub/mx5/DESIGN/PROJECT.md', 'utf8')
const deps: PhaseDeps = {cwd: process.cwd(), taskId: '', signal: new AbortController().signal}

/** Normalised quote key, so trivial whitespace differences do not read as churn. */
function key(q: string): string {
    return q.toLowerCase().replace(/\s+/g, ' ').trim()
}

async function extractOnce(hint: string | null, passages: string[]): Promise<RequirementEntry[]> {
    return keepGroundedRequirements(
        parseRequirementLines(
            await runPhaseChild(
                deps,
                'requirement-extract',
                '',
                hint === null ? REQUIREMENT_EXTRACT_PROMPT(SPEC, passages) : (
                    `${hint}\n\n${REQUIREMENT_EXTRACT_PROMPT(SPEC, passages)}`
                )
            )
        ),
        SPEC
    )
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '8', 10)
    const passages = enumerateObligationPassages(SPEC)
    // PRE-cap and POST-cap sets are tracked separately: a stable pre-cap set with a
    // churning post-cap set localises the defect in capRequirements' selection
    // (marked-priority + sectionFairFill), not in the model's extraction.
    const runs: {
        total: number
        ownable: number
        floor: number
        keys: Set<string>
        preKeys: Set<string>
    }[] = []

    for (let rep = 1; rep <= reps; rep++) {
        let reqs = await extractOnce(null, passages)
        const uncovered = uncoveredPassages(passages, reqs)
        if (uncovered.length > 0) {
            reqs = keepGroundedRequirements(
                [...reqs, ...(await extractOnce(extractionRetryHint(uncovered), passages))],
                SPEC
            )
        }
        const preCap = new Set(reqs.map(r => key(r.quote)))
        reqs = capRequirements(reqs, passages, SPEC)
        const ownable = reqs.filter(r => !isCrossCuttingRequirement(r.quote)).length
        const floor = granularityFloor(ownable)
        runs.push({
            total: reqs.length,
            ownable,
            floor,
            keys: new Set(reqs.map(r => key(r.quote))),
            preKeys: preCap
        })
        console.log(
            `rep ${rep}: preCap=${preCap.size} kept=${reqs.length} ownable=${ownable} floor=${floor}`
        )
    }

    const nums = (f: (r: (typeof runs)[0]) => number): number[] => runs.map(f)
    const stat = (xs: number[]): string => {
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length)
        return `min ${Math.min(...xs)}  max ${Math.max(...xs)}  mean ${mean.toFixed(1)}  sd ${sd.toFixed(2)}`
    }

    // Set churn across runs.
    const counts = new Map<string, number>()
    for (const r of runs) for (const k of r.keys) counts.set(k, (counts.get(k) ?? 0) + 1)
    const universe = counts.size
    const inAll = [...counts.values()].filter(c => c === reps).length
    const inOne = [...counts.values()].filter(c => c === 1).length
    let jSum = 0
    let jN = 0
    for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
            const a = runs[i].keys
            const b = runs[j].keys
            const inter = [...a].filter(x => b.has(x)).length
            jSum += inter / (a.size + b.size - inter)
            jN++
        }
    }

    console.log(`\n=== EXTRACTION STABILITY on a fixed ${SPEC.length}-char spec, ${reps} runs ===`)
    console.log(`  kept    ${stat(nums(r => r.total))}`)
    console.log(`  ownable ${stat(nums(r => r.ownable))}`)
    console.log(`  floor   ${stat(nums(r => r.floor))}`)
    console.log(`\n  SET CHURN`)
    console.log(`    distinct requirements seen across all runs: ${universe}`)
    console.log(`    present in EVERY run: ${inAll} (${((100 * inAll) / universe).toFixed(0)}%)`)
    console.log(`    present in exactly ONE run: ${inOne} (${((100 * inOne) / universe).toFixed(0)}%)`)
    console.log(`    mean pairwise Jaccard: ${(jSum / jN).toFixed(3)}`)
    // Same churn stats over the PRE-cap sets, to localise the defect.
    const preCounts = new Map<string, number>()
    for (const r of runs) for (const k of r.preKeys) preCounts.set(k, (preCounts.get(k) ?? 0) + 1)
    let pj = 0
    let pn = 0
    for (let i = 0; i < runs.length; i++) {
        for (let j = i + 1; j < runs.length; j++) {
            const a = runs[i].preKeys
            const b = runs[j].preKeys
            const inter = [...a].filter(x => b.has(x)).length
            pj += inter / (a.size + b.size - inter)
            pn++
        }
    }
    const preAll = [...preCounts.values()].filter(c => c === reps).length
    console.log(`\n  PRE-CAP CHURN (is the lottery extraction, or the cap's selection?)`)
    console.log(`    pre-cap yield ${stat(nums(r => r.preKeys.size))}`)
    console.log(`    distinct pre-cap requirements: ${preCounts.size}`)
    console.log(
        `    present in EVERY run: ${preAll} (${((100 * preAll) / preCounts.size).toFixed(0)}%)`
    )
    console.log(`    mean pairwise Jaccard: ${(pj / pn).toFixed(3)}`)
    console.log(
        `\n  A run keeps ~${(nums(r => r.total).reduce((a, b) => a + b, 0) / reps).toFixed(0)} of `
            + `${universe} requirements the extractor is capable of producing for this spec.\n`
    )
}

void main()
