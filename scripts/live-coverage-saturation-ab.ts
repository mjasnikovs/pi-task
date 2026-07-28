/**
 * LIVE A/B against the real local model (Qwen3.6-27B via pi @ 127.0.0.1:8080).
 *
 * LEVER UNDER TEST — the SATURATION BREAK for /task-auto's decompose coverage loop.
 *
 * The defect (mx5 2026-07-28, .pi-tasks/plan-debug.log): the loop burned both its
 * retry rounds, grew the plan 26 → 32 → 60 titles, and the deterministic owned-set
 * stayed at 27 requirements in ALL THREE rounds. Both retries were adopted with
 * `reason: 'preserves owned coverage'`.
 *
 * Why the guard cannot object (proved deterministically before this harness):
 *   - decideAdoption's only test on the hasRequirements path is droppedCoverage(),
 *     i.e. "did the retry LOSE anything". Ties adopt by design.
 *   - groundedCoverage is monotone non-decreasing in the title set: `titleTokens`
 *     is a union over titles, and df/maxDF depend only on the quotes. Adding a
 *     title can never remove a token, so it can never drop coverage.
 *   - coverageRepromptHint literally asks for "every task your previous list
 *     already had ... PLUS tasks covering the areas above" — a superset.
 *   ⇒ dropped is structurally empty whenever the model obeys the hint, so the
 *     guard adopts unconditionally and the plan inflates for free.
 *
 * The loop keeps going because its CONTINUE condition reads a different signal
 * than its ADOPT condition: continue is the stochastic judge's free-text
 * `missing`, adopt is the deterministic `covered`. Nothing forces a retry to
 * address what the judge flagged, and the judge re-generates its list each round.
 *
 * TREATMENT: after an adoption, if `covered` did not GROW, the round produced no
 * coverage — break instead of spending the rest of the budget inflating the plan.
 *
 * PAIRED DESIGN. Each rep drives the real loop to full baseline depth ONCE and
 * records the trace (titles / covered / missing per round). Both arms are then
 * replayed over that identical trace, so arm assignment contributes zero variance
 * and the comparison is exact. Requirement extraction runs once for the whole run
 * (it is upstream of the lever) and is shared by every rep.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-coverage-saturation-ab.ts [REPS] [SPEC]
 *   SPEC: 'mx5' (default, the real 20KB failing spec) | 'cli' (generality check)
 */
import {readFileSync} from 'node:fs'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {AUTO_DECOMPOSE_PROMPT, DECOMPOSE_COVERAGE_PROMPT} from '../src/task/auto-prompts.js'
import {parseCoverageVerdict} from '../src/task/auto-io.js'
import {existsSync} from 'node:fs'
import path from 'node:path'
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
import {decideAdoption, groundedCoverage} from '../src/task/coverage-loop.js'
import {reportAb, judge} from './ab-verdict.js'

// Mirrors auto-orchestrator.ts (MAX_COVERAGE_ROUNDS = 2).
const MAX_COVERAGE_ROUNDS = 2

// ── fixtures ─────────────────────────────────────────────────────────────────
const MX5_SPEC = readFileSync('/home/edgars/hub/mx5/DESIGN/PROJECT.md', 'utf8')

// Generality check: a non-web CLI spec, so a pass is not an mx5/web artifact.
const CLI_SPEC = [
    'Build a log-shipping CLI called `hauler`.',
    '',
    'Requirements:',
    '- tail one or more log files and forward new lines to an HTTP collector',
    '- a `--batch` flag groups lines into batches before sending',
    '- on collector failure, spool to a local disk buffer and retry with backoff',
    '- a `--dry-run` flag prints what would be sent without sending it',
    '- rotate detection: reopen a file when its inode changes',
    '- a `hauler status` subcommand reports spool depth and last successful send',
    '',
    'Hard constraints:',
    '- never drop a line that was accepted into the spool',
    '- must not buffer more than 512MB on disk; oldest batches are shed first',
    '- all output must be line-delimited JSON when `--json` is passed'
].join('\n')

const deps: PhaseDeps = {cwd: process.cwd(), taskId: '', signal: new AbortController().signal}

function parseTitles(raw: string): string[] {
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*- \[[ xX]\]\s+(.+?)\s*$/.exec(line)
        if (m) out.push(m[1].trim())
    }
    return out
}

/** Verbatim from auto-orchestrator.ts — the hint that makes retries supersets. */
function coverageRepromptHint(missing: string[]): string {
    return (
        '[SYSTEM NOTE: Your previous task list was INCOMPLETE — no task covered: '
        + missing.join('; ')
        + '. Regenerate the FULL ordered checkbox list for the ENTIRE feature: every '
        + 'task your previous list already had (reworded freely) PLUS tasks covering '
        + 'the areas above. Output every task, one "- [ ] " line each, nothing else.]'
    )
}

interface Round {
    titles: string[]
    covered: Set<number>
    missing: string[]
    /** Adoption verdict that brought this round's plan in (absent for round 0). */
    adopted?: boolean
    reason?: string
}

/** Drive the REAL loop to full baseline depth, recording every round. */
async function traceLoop(
    spec: string,
    reqs: RequirementEntry[],
    dangling: DanglingRef[]
): Promise<Round[]> {
    const quotes = reqs.map(r => r.quote)
    const cov = (titles: string[]): Set<number> =>
        groundedCoverage(quotes, titles, isCrossCuttingRequirement)
    const decomposePrompt = AUTO_DECOMPOSE_PROMPT(spec, '')

    // `missing` is a THREE-channel union in auto-orchestrator.ts:1067-1081, not just
    // the judge verdict. A first cut used only the verdict and the loop retried in
    // 2/8 reps — production retried every round. The unmapped-requirement channel is
    // what actually keeps the verdict INCOMPLETE.
    const score = async (titles: string[]): Promise<Round> => {
        const verdict = parseCoverageVerdict(
            await runPhaseChild(
                deps,
                'coverage-verdict',
                '',
                DECOMPOSE_COVERAGE_PROMPT(spec, '', titles)
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
            // mapping fault — orchestrator degrades the same way
        }
        for (const d of dangling)
            if (!titlesCoverArtifact(titles, d)) missing.push(danglingMissingText(d))
        return {titles, covered: cov(titles), missing}
    }

    const rounds: Round[] = [
        await score(parseTitles(await runPhaseChild(deps, 'decompose', '', decomposePrompt)))
    ]
    let best = rounds[0]
    for (let round = 1; round <= MAX_COVERAGE_ROUNDS; round++) {
        if (best.missing.length === 0) break
        const retryRaw = await runPhaseChild(
            deps,
            'decompose',
            '',
            `${coverageRepromptHint(best.missing)}\n\n${decomposePrompt}`
        )
        const cand = await score(parseTitles(retryRaw))
        const d = decideAdoption(best, cand, reqs.length > 0)
        cand.adopted = d.adopt
        cand.reason = d.reason
        rounds.push(cand)
        if (d.adopt) best = cand
    }
    return rounds
}

// ── arms, replayed over the identical trace ──────────────────────────────────

/** BASELINE — shipping behaviour: adopt on non-drop, run the budget out. */
function shipBaseline(rounds: Round[]): Round {
    let best = rounds[0]
    for (const r of rounds.slice(1)) if (r.adopted) best = r
    return best
}

/**
 * TREATMENT A — adopt the round, THEN break on saturation. Conservative: it still
 * ships the zero-gain round's titles, it just stops spending the rest of the budget.
 */
function shipTreatmentA(rounds: Round[]): Round {
    let best = rounds[0]
    for (const r of rounds.slice(1)) {
        if (!r.adopted) continue
        const grew = r.covered.size > best.covered.size
        best = r
        if (!grew) break
    }
    return best
}

/**
 * TREATMENT B — REFUSE a zero-gain retry and break. Strictly stronger: growth must
 * pay for itself. Risk: groundedCoverage under-counts (a reworded title sharing no
 * distinctive noun reads as uncovered), so B can refuse a retry that improved
 * something the metric cannot see. That is what the invariants below watch.
 */
function shipTreatmentB(rounds: Round[]): Round {
    let best = rounds[0]
    for (const r of rounds.slice(1)) {
        if (!r.adopted) continue
        if (r.covered.size <= best.covered.size) break // no gain ⇒ do not replace
        best = r
    }
    return best
}

/** Last round that actually INCREASED grounded coverage — the plan that earned its size. */
function lastProductive(rounds: Round[]): Round {
    let best = rounds[0]
    for (const r of rounds.slice(1)) {
        if (r.adopted && r.covered.size > best.covered.size) best = r
    }
    return best
}

async function main() {
    const reps = parseInt(process.argv[2] ?? '8', 10)
    const which = (process.argv[3] ?? 'mx5').toLowerCase()
    const spec = which === 'cli' ? CLI_SPEC : MX5_SPEC

    // Mirror auto-orchestrator.ts:658-683 EXACTLY. A first cut of this harness
    // called the extract prompt once and skipped capRequirements, so it planned
    // over 113 requirements — a state production cannot reach (MAX_REQUIREMENTS =
    // 40) — and the loop had so much coverage headroom that every retry gained.
    // That run ABSTAINed on a fixture bug, not on the hypothesis.
    const passages = enumerateObligationPassages(spec)
    const extractOnce = async (hint: string | null): Promise<RequirementEntry[]> =>
        keepGroundedRequirements(
            parseRequirementLines(
                await runPhaseChild(
                    deps,
                    'requirement-extract',
                    '',
                    hint === null ?
                        REQUIREMENT_EXTRACT_PROMPT(spec, passages)
                    :   `${hint}\n\n${REQUIREMENT_EXTRACT_PROMPT(spec, passages)}`
                )
            ),
            spec
        )
    let reqs = await extractOnce(null)
    const uncovered = uncoveredPassages(passages, reqs)
    if (uncovered.length > 0) {
        reqs = keepGroundedRequirements(
            [...reqs, ...(await extractOnce(extractionRetryHint(uncovered)))],
            spec
        )
    }
    reqs = capRequirements(reqs, passages, spec)
    // mx5's real run carried one dangling artifact (index.html) that no title ever
    // claimed — a permanent `missing` entry that kept every round INCOMPLETE.
    const specRoot = '/home/edgars/hub/mx5'
    const dangling = findSpecDanglingArtifacts(spec, rel => existsSync(path.join(specRoot, rel)))
    const ownable = reqs.filter(r => !isCrossCuttingRequirement(r.quote)).length
    console.log(
        `\n=== fixture=${which} (${spec.length} chars): ${reqs.length} grounded requirement(s), `
            + `${ownable} ownable ===\n`
    )

    let baselineHits = 0
    let hitsA = 0
    let hitsB = 0
    let witnessed = 0
    let lostA = 0
    let lostB = 0
    let grewA = 0
    let grewB = 0
    const savedA: number[] = []
    const savedB: number[] = []

    // The target shape is defined against the TRACE, never against an arm — an arm
    // compared only to itself can always be made to look like a winner.
    // `ref` is the last round that actually bought coverage; any title beyond it
    // that came with no coverage gain is inflation.
    const inflated = (shipped: Round, ref: Round): boolean =>
        shipped.titles.length > ref.titles.length && shipped.covered.size === ref.covered.size

    for (let rep = 1; rep <= reps; rep++) {
        const rounds = await traceLoop(spec, reqs, dangling)
        const ref = lastProductive(rounds)
        const base = shipBaseline(rounds)
        const tA = shipTreatmentA(rounds)
        const tB = shipTreatmentB(rounds)

        // Precondition for the lever: the loop actually retried and adopted at
        // least once. Without an adopted retry there is nothing to break out of.
        const adoptedAny = rounds.slice(1).some(r => r.adopted)
        if (adoptedAny) witnessed++

        const bInf = inflated(base, ref)
        const aInf = inflated(tA, ref)
        const bbInf = inflated(tB, ref)
        if (bInf) baselineHits++
        if (aInf) hitsA++
        if (bbInf) hitsB++
        if (tA.covered.size < base.covered.size) lostA++
        if (tB.covered.size < base.covered.size) lostB++
        if (tA.titles.length > base.titles.length) grewA++
        if (tB.titles.length > base.titles.length) grewB++
        if (bInf) {
            savedA.push(base.titles.length - tA.titles.length)
            savedB.push(base.titles.length - tB.titles.length)
        }

        console.log(
            `rep ${rep}: rounds=[${rounds.map(r => `${r.titles.length}t/${r.covered.size}c`).join(' → ')}]`
                + `${rounds
                    .slice(1)
                    .map(r => ` (${r.adopted ? 'ADOPT' : 'REJECT'}: ${r.reason})`)
                    .join('')}`
        )
        console.log(
            `        ref=${ref.titles.length}t/${ref.covered.size}c  `
                + `BASE ${base.titles.length}t/${base.covered.size}c(inf=${bInf})  `
                + `A ${tA.titles.length}t/${tA.covered.size}c(inf=${aInf})  `
                + `B ${tB.titles.length}t/${tB.covered.size}c(inf=${bbInf})`
        )
    }

    const mean = (xs: number[]): string =>
        xs.length === 0 ? 'n/a' : (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)

    const invariants = (lost: number, grew: number) => [
        {
            label: 'treatment never ships less coverage than baseline',
            ok: lost === 0,
            detail: `${lost}/${reps} rep(s) lost coverage`
        },
        {
            label: 'treatment never ships a LARGER plan than baseline',
            ok: grew === 0,
            detail: `${grew}/${reps} rep(s) grew`
        },
        {
            label: 'lever precondition observed (a retry was adopted)',
            ok: witnessed > 0,
            detail: `${witnessed}/${reps} rep(s)`
        }
    ]

    const shape =
        'the shipped plan carries titles from a retry round that bought NO grounded '
        + 'coverage (inflation for free)'

    // Arm A reported for information; arm B is the primary lever and sets the exit code.
    const a = judge({
        name: 'saturation break — TREATMENT A (adopt, then break)',
        reps,
        targetShape: shape,
        baselineHits,
        treatmentHits: hitsA,
        invariants: invariants(lostA, grewA)
    })
    for (const l of a.lines) console.log(l)
    console.log(`  mean titles avoided vs baseline: ${mean(savedA)}`)

    reportAb({
        name: 'saturation break — TREATMENT B (refuse a zero-gain retry)',
        reps,
        targetShape: shape,
        baselineHits,
        treatmentHits: hitsB,
        invariants: invariants(lostB, grewB)
    })
    console.log(`  mean titles avoided vs baseline: ${mean(savedB)}\n`)
}

void main()
