/**
 * LIVE A/B — TREATMENT C for /task-auto's decompose coverage loop.
 *
 * WHY A SECOND HARNESS. live-coverage-saturation-ab.ts uses a paired REPLAY: it
 * records one baseline trace and evaluates arms over it. That is exact for arms
 * that only TRUNCATE the trace (A and B both stop early — the earlier model calls
 * are unchanged by the decision to stop). It is INVALID for an arm that rejects a
 * round and keeps going: rejection changes the `missing` list that seeds the next
 * reprompt, so the recorded round 2 is not the round 2 that arm would have seen.
 * C therefore needs genuinely divergent arms — two live loops per rep.
 *
 * WHAT THE REPLAY RUNS ESTABLISHED (mx5 fixture, 12 reps, precondition 12/12):
 *   BASELINE ships a plan inflated by a zero-gain retry ......... 6/12
 *   A (adopt, then break) ....................................... 6/12  FAIL
 *   B (refuse zero-gain, break) ................................. 0/12  but
 *       forfeited a coverage point in 1/12 — rep 7 was
 *       19t/24c → 38t/24c → 40t/25c: B breaks on round 1's tie and never
 *       reaches round 2, which WOULD have gained. "No gain this round" is
 *       not "no gain ever", so BREAKING is the wrong instrument.
 *
 * TREATMENT C. Same monotone guard, one added clause: a retry that buys no NEW
 * grounded coverage while growing the plan is REJECTED — the loop keeps the
 * smaller plan and reprompts again, exactly as it does for any other rejection.
 * This extends the existing "ship the best, not the last" rule with a tiebreak:
 * among plans of equal coverage, the smallest one wins.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-coverage-adoption-ab.ts [REPS]
 */
import {readFileSync, existsSync} from 'node:fs'
import path from 'node:path'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {AUTO_DECOMPOSE_PROMPT, DECOMPOSE_COVERAGE_PROMPT} from '../src/task/auto-prompts.js'
import {parseCoverageVerdict} from '../src/task/auto-io.js'
import {
    findSpecDanglingArtifacts,
    titlesCoverArtifact,
    danglingMissingText,
    type DanglingRef
} from '../src/task/artifact-closure.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    COVERAGE_MAP_PROMPT,
    parseCoverageMap,
    accountCoverage,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    isCrossCuttingRequirement,
    capRequirements,
    uncoveredPassages,
    extractionRetryHint,
    type RequirementEntry
} from '../src/task/requirements.js'
import {
    decideAdoption,
    droppedCoverage,
    groundedCoverage,
    type CoveragePlan
} from '../src/task/coverage-loop.js'
import {reportAb} from './ab-verdict.js'

const MAX_COVERAGE_ROUNDS = 2
// Generality fixture: a NON-web daemon spec (Rust/ETL, no UI, no HTTP surface
// beyond /health) with mx5-comparable breadth. The first CLI fixture was too
// SMALL to exercise the lever at all — 8 ownable requirements, and round 0 came
// back COMPLETE in 16/16 reps, so the coverage loop never retried and the run
// ABSTAINed. The pathology is scale-dependent: it needs a spec broad enough that
// the first plan leaves the judge INCOMPLETE.
const ETL_SPEC = readFileSync(
    new URL('./fixtures/etl-spec.md', import.meta.url).pathname,
    'utf8'
)

const USE_CLI = (process.argv[3] ?? 'mx5').toLowerCase() === 'etl'
const SPEC = USE_CLI ? ETL_SPEC : readFileSync('/home/edgars/hub/mx5/DESIGN/PROJECT.md', 'utf8')
const SPEC_ROOT = '/home/edgars/hub/mx5'

const deps: PhaseDeps = {cwd: process.cwd(), taskId: '', signal: new AbortController().signal}

function parseTitles(raw: string): string[] {
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*- \[[ xX]\]\s+(.+?)\s*$/.exec(line)
        if (m) out.push(m[1].trim())
    }
    return out
}

function coverageRepromptHint(missing: string[]): string {
    return (
        '[SYSTEM NOTE: Your previous task list was INCOMPLETE — no task covered: '
        + missing.join('; ')
        + '. Regenerate the FULL ordered checkbox list for the ENTIRE feature: every '
        + 'task your previous list already had (reworded freely) PLUS tasks covering '
        + 'the areas above. Output every task, one "- [ ] " line each, nothing else.]'
    )
}

/**
 * The PRE-C adoption rule, transcribed. C now ships inside decideAdoption, so the
 * baseline arm can no longer just call it — comparing the shipped rule against
 * itself would make any run trivially pass. This is the rule exactly as it stood
 * before the tiebreak: collapse floor, then drop-check, then adopt.
 */
function decideAdoptionBaseline(
    current: CoveragePlan,
    retry: CoveragePlan,
    hasRequirements: boolean
): {adopt: boolean; reason: string} {
    if (retry.titles.length === 0) return {adopt: false, reason: 'empty retry'}
    if (retry.titles.length * 2 < current.titles.length) {
        return {adopt: false, reason: 'collapse floor'}
    }
    if (hasRequirements) {
        const dropped = droppedCoverage(current.covered, retry.covered)
        if (dropped.length > 0) {
            return {adopt: false, reason: `would drop ${dropped.length} owned requirement(s)`}
        }
        return {adopt: true, reason: 'preserves owned coverage'}
    }
    if (retry.missing.length > current.missing.length) {
        return {adopt: false, reason: 'more uncovered areas'}
    }
    return {adopt: true, reason: 'count floor met'}
}

interface Scored {
    titles: string[]
    covered: Set<number>
    missing: string[]
}

function makeScorer(reqs: RequirementEntry[], dangling: DanglingRef[]) {
    const quotes = reqs.map(r => r.quote)
    return async (titles: string[]): Promise<Scored> => {
        const verdict = parseCoverageVerdict(
            await runPhaseChild(
                deps,
                'coverage-verdict',
                '',
                DECOMPOSE_COVERAGE_PROMPT(SPEC, '', titles)
            )
        )
        const missing: string[] = verdict?.kind === 'incomplete' ? [...verdict.missing] : []
        try {
            const acc = accountCoverage(
                reqs,
                parseCoverageMap(
                    await runPhaseChild(
                        deps,
                        'coverage-map',
                        '',
                        COVERAGE_MAP_PROMPT(reqs, titles)
                    ),
                    reqs.length,
                    titles.length
                )
            )
            for (const e of acc.unmapped) missing.push(`"${e.quote}"`)
        } catch {
            /* orchestrator degrades the same way */
        }
        for (const d of dangling)
            if (!titlesCoverArtifact(titles, d)) missing.push(danglingMissingText(d))
        return {
            titles,
            covered: groundedCoverage(quotes, titles, isCrossCuttingRequirement),
            missing
        }
    }
}

/**
 * Decompose, re-drawing a DEGENERATE (zero-title) generation up to `EMPTY_REDRAWS`
 * times. Run 4 rep 14 drew 0 titles twice in C's arm; decideAdoption rejects those
 * on its `empty retry` branch — which precedes the tiebreak, so C's rule never
 * fired — yet the rep still registered as "C lost coverage" and failed the run.
 * That is arm-luck in the sampler, not a property of the rule under test. Both arms
 * treat an empty generation identically in production, so re-drawing removes noise
 * without changing what is being measured. Persistent emptiness is counted and
 * reported rather than silently absorbed.
 */
const EMPTY_REDRAWS = 2
let degenerateDraws = 0

async function decomposeNonEmpty(prompt: string): Promise<string[]> {
    for (let attempt = 0; attempt <= EMPTY_REDRAWS; attempt++) {
        const titles = parseTitles(await runPhaseChild(deps, 'decompose', '', prompt))
        if (titles.length > 0) return titles
        degenerateDraws++
    }
    return []
}

/** Run the loop under a given adoption rule, starting from a SHARED round 0. */
async function runArm(
    round0: Scored,
    score: (t: string[]) => Promise<Scored>,
    decide: (c: CoveragePlan, r: CoveragePlan, h: boolean) => {adopt: boolean; reason: string},
    hasReqs: boolean,
    trail: string[]
): Promise<Scored> {
    const decomposePrompt = AUTO_DECOMPOSE_PROMPT(SPEC, '')
    let best = round0
    for (let round = 1; round <= MAX_COVERAGE_ROUNDS; round++) {
        if (best.missing.length === 0) break
        const cand = await score(
            await decomposeNonEmpty(`${coverageRepromptHint(best.missing)}\n\n${decomposePrompt}`)
        )
        const d = decide(best, cand, hasReqs)
        // Log the REASON, so an invariant break can be attributed to the tiebreak
        // or to a base-rule branch without argument.
        trail.push(
            `${cand.titles.length}t/${cand.covered.size}c ${d.adopt ? 'ADOPT' : `REJECT(${d.reason})`}`
        )
        if (d.adopt) best = cand
    }
    return best
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '10', 10)

    const passages = enumerateObligationPassages(SPEC)
    const extractOnce = async (hint: string | null): Promise<RequirementEntry[]> =>
        keepGroundedRequirements(
            parseRequirementLines(
                await runPhaseChild(
                    deps,
                    'requirement-extract',
                    '',
                    hint === null ?
                        REQUIREMENT_EXTRACT_PROMPT(SPEC, passages)
                    :   `${hint}\n\n${REQUIREMENT_EXTRACT_PROMPT(SPEC, passages)}`
                )
            ),
            SPEC
        )
    let reqs = await extractOnce(null)
    const uncovered = uncoveredPassages(passages, reqs)
    if (uncovered.length > 0) {
        reqs = keepGroundedRequirements(
            [...reqs, ...(await extractOnce(extractionRetryHint(uncovered)))],
            SPEC
        )
    }
    reqs = capRequirements(reqs, passages, SPEC)
    const dangling =
        USE_CLI ? [] : (
            findSpecDanglingArtifacts(SPEC, rel => existsSync(path.join(SPEC_ROOT, rel)))
        )
    const score = makeScorer(reqs, dangling)
    const ownable = reqs.filter(r => !isCrossCuttingRequirement(r.quote)).length
    console.log(
        `\n=== ${USE_CLI ? 'etl' : 'mx5'}: ${reqs.length} grounded requirement(s), ${ownable} ownable, `
            + `${dangling.length} dangling ===\n`
    )

    let baselineHits = 0
    let treatHits = 0
    let witnessed = 0
    let lostCoverage = 0
    let degenerateSurvived = 0
    const saved: number[] = []
    const titlesBase: number[] = []
    const titlesC: number[] = []
    const covBase: number[] = []
    const covC: number[] = []

    for (let rep = 1; rep <= reps; rep++) {
        // Shared round 0: identical prompt, no divergence possible yet.
        const round0 = await score(await decomposeNonEmpty(AUTO_DECOMPOSE_PROMPT(SPEC, '')))
        const baseTrail: string[] = []
        const cTrail: string[] = []
        const base = await runArm(round0, score, decideAdoptionBaseline, reqs.length > 0, baseTrail)
        const c = await runArm(round0, score, decideAdoption, reqs.length > 0, cTrail)

        if (round0.missing.length > 0) witnessed++
        if (base.titles.length === 0 || c.titles.length === 0 || round0.titles.length === 0)
            degenerateSurvived++
        // TARGET SHAPE: shipped plan is bigger than round 0 but bought no coverage.
        const bInf =
            base.titles.length > round0.titles.length && base.covered.size <= round0.covered.size
        const cInf = c.titles.length > round0.titles.length && c.covered.size <= round0.covered.size
        if (bInf) baselineHits++
        if (cInf) treatHits++
        if (c.covered.size < base.covered.size) lostCoverage++
        titlesBase.push(base.titles.length)
        titlesC.push(c.titles.length)
        covBase.push(base.covered.size)
        covC.push(c.covered.size)
        if (bInf) saved.push(base.titles.length - c.titles.length)

        console.log(
            `rep ${rep}: r0=${round0.titles.length}t/${round0.covered.size}c\n`
                + `        BASE [${baseTrail.join(' → ')}] ships ${base.titles.length}t/${base.covered.size}c (inf=${bInf})\n`
                + `        C    [${cTrail.join(' → ')}] ships ${c.titles.length}t/${c.covered.size}c (inf=${cInf})`
        )
    }

    const mean = (xs: number[]): string =>
        xs.length === 0 ? 'n/a' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)

    reportAb({
        name: 'coverage-loop adoption tiebreak — TREATMENT C (reject zero-gain growth, keep looping)',
        reps,
        targetShape: 'the shipped plan grew past round 0 while buying no grounded coverage',
        baselineHits,
        treatmentHits: treatHits,
        invariants: [
            // The ONLY per-rep invariant valid under divergent arms. Coverage is
            // scored against the same requirement set in both arms, so it compares
            // rep-by-rep. Title COUNT does not: the arms issue different decompose
            // calls, so a size difference is model variance, not the rule. A first
            // cut asserted "C never ships a larger plan" per rep and it broke 5/10
            // on reps where BOTH arms adopted a coverage-gaining retry and the model
            // simply emitted a longer list in C's arm. That was a harness bug.
            {
                label: 'C never ships less coverage than baseline (paired, per rep)',
                ok: lostCoverage === 0,
                detail: `${lostCoverage}/${reps} rep(s) lost coverage`
            },
            {
                label: 'no degenerate (zero-title) generation survived re-draw',
                ok: degenerateSurvived === 0,
                detail: `${degenerateSurvived}/${reps} rep(s); ${degenerateDraws} empty draw(s) re-drawn`
            },
            {
                label: 'lever precondition observed (round 0 was INCOMPLETE)',
                ok: witnessed > 0,
                detail: `${witnessed}/${reps} rep(s)`
            }
        ]
    })
    // Plan size is an EFFECT, reported distributionally, never as a per-rep invariant.
    const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0)
    const med = (xs: number[]): number => {
        const s = [...xs].sort((a, b) => a - b)
        return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
    }
    const smaller = titlesC.filter((t, i) => t < titlesBase[i]).length
    const larger = titlesC.filter((t, i) => t > titlesBase[i]).length
    console.log(
        `\n  PLAN SIZE (effect, not invariant)\n`
            + `    baseline: mean ${(sum(titlesBase) / reps).toFixed(1)}  median ${med(titlesBase)}\n`
            + `    C:        mean ${(sum(titlesC) / reps).toFixed(1)}  median ${med(titlesC)}\n`
            + `    sign test: C smaller in ${smaller}, larger in ${larger}, tied in ${reps - smaller - larger}\n`
            + `  COVERAGE  baseline mean ${(sum(covBase) / reps).toFixed(2)}  C mean ${(sum(covC) / reps).toFixed(2)}\n`
            + `  mean titles avoided on inflated reps: ${mean(saved)}\n`
    )
}

void main()
