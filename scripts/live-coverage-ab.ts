/**
 * LIVE A/B against the real local model (Qwen3.6-27B via pi @ 127.0.0.1:8080).
 *
 * Drives the ACTUAL planning children — requirement-extract and coverage-map —
 * exactly as the orchestrator does (runPhaseChild → runChild → pi --mode json),
 * then runs BASELINE (old accountCoverage: every NONE → unmapped → missing;
 * last-wins size-floor adoption) vs TREATMENT (shipping accountCoverage with the
 * cross-cutting classifier + decideAdoption monotonic guard) over the model's real
 * outputs. Reports how often each keeps the dropped area.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-coverage-ab.ts [TRIALS]
 */
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    COVERAGE_MAP_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    parseCoverageMap,
    accountCoverage,
    ownedRequirementIndices,
    isCrossCuttingRequirement,
    type RequirementEntry,
    type ReqMapping
} from '../src/task/requirements.js'
import {decideAdoption, groundedCoverage} from '../src/task/coverage-loop.js'
import {reportAb} from './ab-verdict.js'

// A real, NON-web spec (a CLI) with genuine NEGATIVE requirements — the un-ownable
// class that drove mx5 run 12. The good plan owns the --json area; the dropping
// regeneration owns a report area instead and loses --json.
const SPEC = [
    'Build a file-deduplication CLI tool called `dedupe`.',
    '',
    'Requirements:',
    '- the CLI scans a directory tree and finds groups of duplicate files by content hash',
    '- a `--json` flag makes it emit machine-readable output instead of the human table',
    '- a summary report prints total reclaimed space at the end of a run',
    '- it reads a `.dedupeignore` file to skip paths',
    '',
    'Hard constraints:',
    '- the tool must never delete a file unless the user passes an explicit `--apply` flag',
    '- it must not follow symlinks out of the scanned root',
    '- all user-facing output must be plain ASCII, no colour codes'
].join('\n')

const GOOD_PLAN = [
    'Scaffold the dedupe CLI entrypoint and argument parser',
    'Implement content-hash scanning to group duplicate files',
    'Add the --json machine-readable output mode',
    'Read and apply .dedupeignore path filters'
]
const DROP_PLAN = [
    'Scaffold the dedupe CLI entrypoint and argument parser',
    'Implement content-hash scanning to group duplicate files',
    'Print a summary report of total reclaimed space',
    'Read and apply .dedupeignore path filters'
]
// The area the good plan owns and the dropping regeneration loses.
const DROPPED_MARK = '--json'

const deps: PhaseDeps = {cwd: process.cwd(), taskId: '', signal: new AbortController().signal}

async function extractRequirements(): Promise<RequirementEntry[]> {
    const passages = enumerateObligationPassages(SPEC)
    const raw = await runPhaseChild(deps, 'requirement-extract', '', REQUIREMENT_EXTRACT_PROMPT(SPEC, passages))
    return keepGroundedRequirements(parseRequirementLines(raw), SPEC)
}

async function coverageMap(reqs: RequirementEntry[], titles: string[]): Promise<ReqMapping[]> {
    const raw = await runPhaseChild(deps, 'coverage-map', '', COVERAGE_MAP_PROMPT(reqs, titles))
    return parseCoverageMap(raw, reqs.length, titles.length)
}

// BASELINE accountCoverage: the OLD behaviour — every NONE is unmapped (no
// cross-cutting classifier). Transcribed here so we compare against real outputs.
function baselineMissing(reqs: RequirementEntry[], m: ReqMapping[]): string[] {
    return m.flatMap((x, i) => (x.kind === 'none' ? [`"${reqs[i].quote}"`] : []))
}

async function main() {
    const trials = parseInt(process.argv[2] ?? '5', 10)
    const reqs = await extractRequirements()
    console.log(`\n=== extracted ${reqs.length} grounded requirement(s) from the live model ===`)
    for (const r of reqs) {
        console.log(`  ${isCrossCuttingRequirement(r.quote) ? 'CROSS' : 'own  '} | "${r.quote}"`)
    }
    const negatives = reqs.filter(r => isCrossCuttingRequirement(r.quote))
    console.log(`  → classifier flags ${negatives.length} as un-ownable (cross-cutting)\n`)

    let baselineKept = 0
    let treatmentKept = 0
    let negLeakBaseline = 0 // negatives the model left NONE that leak into baseline's missing

    for (let t = 1; t <= trials; t++) {
        // Two independent live model calls: map the GOOD plan and the DROP plan.
        const goodMap = await coverageMap(reqs, GOOD_PLAN)
        const dropMap = await coverageMap(reqs, DROP_PLAN)

        const quotes = reqs.map(r => r.quote)
        const good = {
            titles: GOOD_PLAN,
            // BASELINE used the model's owned-set; TREATMENT grounds it in the titles.
            coveredBase: ownedRequirementIndices(goodMap),
            covered: groundedCoverage(quotes, GOOD_PLAN, isCrossCuttingRequirement),
            missingBase: baselineMissing(reqs, goodMap),
            missingTreat: accountCoverage(reqs, goodMap).unmapped.map(e => `"${e.quote}"`)
        }
        const drop = {
            titles: DROP_PLAN,
            coveredBase: ownedRequirementIndices(dropMap),
            covered: groundedCoverage(quotes, DROP_PLAN, isCrossCuttingRequirement),
            missingBase: baselineMissing(reqs, dropMap),
            missingTreat: accountCoverage(reqs, dropMap).unmapped.map(e => `"${e.quote}"`)
        }

        // BASELINE loop: good plan is INCOMPLETE (missing report + negatives), regen
        // → drop plan, last-wins overwrite on the size floor (equal length passes).
        let baselineShip = good.titles
        if (good.missingBase.length > 0 && DROP_PLAN.length * 2 >= GOOD_PLAN.length) {
            baselineShip = drop.titles // overwrites WITHOUT a coverage check — the bug
        }

        // TREATMENT loop: score both, adopt only if monotone (no owned drop).
        let treatShip = good.titles
        const decision = decideAdoption(
            {titles: good.titles, covered: good.covered, missing: good.missingTreat},
            {titles: drop.titles, covered: drop.covered, missing: drop.missingTreat},
            reqs.length > 0
        )
        if (decision.adopt) treatShip = drop.titles

        const baselineHasArea = baselineShip.some(x => x.includes(DROPPED_MARK))
        const treatHasArea = treatShip.some(x => x.includes(DROPPED_MARK))
        if (baselineHasArea) baselineKept++
        if (treatHasArea) treatmentKept++

        // How the un-ownable negatives actually landed this trial.
        const negIdx = reqs.map((r, i) => (isCrossCuttingRequirement(r.quote) ? i : -1)).filter(i => i >= 0)
        const goodNoneNegs = negIdx.filter(i => goodMap[i].kind === 'none')
        negLeakBaseline += goodNoneNegs.length // baseline: these force regen

        console.log(
            `trial ${t}: good.owned={${[...good.covered].join(',')}} drop.owned={${[...drop.covered].join(',')}}`
                + ` | adopt=${decision.adopt} (${decision.reason})`
                + ` | baseline keeps ${DROPPED_MARK}=${baselineHasArea} treatment=${treatHasArea}`
        )
    }

    console.log(
        `\n[LIVE A/B] --json area retained across ${trials} trials — `
            + `baseline ${baselineKept}/${trials} → treatment ${treatmentKept}/${trials}`
    )
    console.log(
        `[LIVE A/B] un-ownable negatives that mapped NONE on the good plan: `
            + `${negLeakBaseline} (baseline: forced regen; treatment: carried cross-cutting)`
    )

    // The measured shape is the LOSS of the area, so the counts invert here: a
    // trial in which the arm kept it is a trial in which the defect did not occur.
    reportAb({
        name: 'live-coverage-ab',
        reps: trials,
        targetShape:
            `the --json area DROPPED from the adopted plan (marker "${DROPPED_MARK}" absent) `
            + 'after a regeneration that owns a report area instead',
        baselineHits: trials - baselineKept,
        treatmentHits: trials - treatmentKept,
        invariants: [
            {
                label: 'the un-ownable negatives were actually present in the model output',
                ok: negLeakBaseline > 0,
                detail: `${negLeakBaseline} negative(s) mapped NONE on the good plan`
            }
        ]
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
