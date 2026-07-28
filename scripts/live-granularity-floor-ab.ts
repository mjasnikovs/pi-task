/**
 * LIVE A/B for the granularity floor (decompose-granularity.ts).
 *
 * BASELINE  = the shipped decompose call: old prompt ("Prefer a handful of
 *             substantial tasks over many trivial ones"), no floor, no retry.
 * TREATMENT = the same call with the GRANULARITY rule (belt) plus the one
 *             split-reprompt when the plan lands under the floor (braces).
 *
 * Both arms run the COARSE clarify transcript verbatim from mx5's collapsed run —
 * the exact input that produced the 11-task plan. The lever has to beat that
 * input, not a friendly one.
 *
 * Target shape = a plan UNDER the floor (the collapse). Invariants guard the two
 * ways a "more tasks" lever can cheat: losing coverage, and padding a small spec.
 * The NEGATIVE CONTROL re-runs both arms on a tiny CLI spec whose floor is small,
 * where the treatment must NOT inflate the plan.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-granularity-floor-ab.ts <specRepo> [REPS]
 */
import {runPhaseChild, prependHint, type PhaseDeps} from '../src/task/child-runner.js'
import {expandFeatureMentions} from '../src/task/auto-orchestrator.js'
import {AUTO_DECOMPOSE_PROMPT} from '../src/task/auto-prompts.js'
import {parseDecomposeList} from '../src/task/auto-io.js'
import {reconcileTitleSources} from '../src/task/decompose-fidelity.js'
import {
    granularityFloor,
    granularitySplitHint,
    isTooCoarse,
    PLAN_SHAPE_ANSWER
} from '../src/task/decompose-granularity.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    uncoveredPassages,
    extractionRetryHint,
    capRequirements,
    buildRequirementsLedger,
    isCrossCuttingRequirement,
    type RequirementEntry
} from '../src/task/requirements.js'
import {groundedCoverage} from '../src/task/coverage-loop.js'
import {mandatesTestsInSameChange, rewriteBatchTestPlan} from '../src/task/batch-test-task.js'
import {findPhantomImports, rewritePhantomSpecifiers} from '../src/workers/phantom-imports.js'
import {reportAb} from './ab-verdict.js'

const FEATURE = 'Implement @DESIGN/PROJECT.md'

/** The A1 the triage produced in the collapsed run, and the host's replacement. */
const COARSE_A1 =
    "follow the 12 milestones in §12 as-is, folding shared schema, Playwright CT setup, and other cross-cutting prerequisites into the first milestone they're needed by (e.g., shared zod schemas land in Milestone 2 with auth routes, Playwright CT config lands in Milestone 6 with the client shell), rather than extracting them into separate prerequisite tasks (auto-resolved — already settled by the spec)"
const HOST_A1 = `${PLAN_SHAPE_ANSWER} (host-set — plan granularity is not left to chance)`

/** mx5's collapsed run, verbatim — the clarify transcript that shipped 11 tasks. */
const COARSE_TRANSCRIPT = [
    'Q1: Should the task breakdown follow the 12 milestones in §12 as-is (one task per milestone), or should tasks be split more granularly — e.g. separating "shared schema module" and "Playwright CT setup" into their own prerequisite tasks before any route or component work begins? The spec\'s §10 mandates test-first cadence and §5 mandates shared zod schemas + RPC-only client types, both of which are cross-cutting prerequisites that don\'t neatly sit inside a single milestone.\n'
        + `A1: ${COARSE_A1}`,
    'Q2: Should the pg_trgm extension and its GIN index for text search be set up in the initial migration (Milestone 1), or deferred to Milestone 4 when listing search is implemented?\nA2: include pg_trgm extension and GIN index in the 0001_init.sql migration during Milestone 1, so the schema is fully ready before any route work begins (YOLO)',
    'Q3: Should the rate-limiting mechanism (mentioned in §11 for login, invite create, and invite redeem) be implemented as part of Milestone 2 (Auth) for login and Milestone 3 (Invites) for invite endpoints, or extracted into its own middleware task during Milestone 1 (Scaffold)?\nA3: fold rate-limiting into each route\'s milestone as needed — implement it inline during Milestone 2 for login and Milestone 3 for invite endpoints, since the spec calls it a "simple in-memory counter" (auto-resolved — already settled by the spec)',
    'Q4: Should the shadcn/ui component setup (base primitives like Button, Input, Card, Dialog, etc.) be handled as part of Milestone 6 (Client shell) or extracted into its own task before Milestone 6?\nA4: handle shadcn/ui setup as part of Milestone 6 (Client shell), since the design doc already groups "shadcn base" under that milestone (auto-resolved — already settled by the spec)',
    'Q5: Should Milestone 9 (Polish — empty/error/loading states, responsive design, final brand pass) remain a separate task, or be folded into the preceding client tasks?\nA5: fold Milestone 9 into Milestones 6–8 so each client milestone ships complete, polished pages with responsive layout, empty states, loading skeletons, and brand polish included in its own completion criteria (auto-resolved — already settled by the spec)',
    'Q6: Should the /join/:token signup page in Milestone 3 be implemented as a server-rendered HTML form, or deferred entirely to Milestone 7 when client pages land?\nA6: defer entirely to Milestone 7 — keep the invite flow API-only through M4–M6, with the `/join/:token` route handled by the SPA fallback (auto-resolved — already settled by the spec)'
].join('\n')

/** NEGATIVE CONTROL — a small spec. Its floor is low, so the lever must be a
 *  near no-op here: a granularity floor that pads small work is not a fix. */
const SMALL_SPEC = [
    'Add a `--json` output mode to the existing `dedupe` CLI.',
    '',
    'Requirements:',
    '- a `--json` flag makes the tool emit machine-readable JSON instead of the human table',
    '- the JSON shape is `{ groups: [{ hash, files: [path], bytes }], reclaimable }`',
    '- the human table stays the default when the flag is absent',
    '- `--json` and `--quiet` together is an error the CLI reports and exits 2 on'
].join('\n')
const SMALL_CLARIFICATIONS = 'Q1: Reuse the existing output layer?\nA1: yes, add a formatter alongside the table renderer (auto-resolved)'

async function main() {
    const repoArg = process.argv[2]
    if (repoArg === undefined) {
        console.error('usage: live-granularity-floor-ab.ts <specRepo> [REPS]')
        process.exit(2)
    }
    const reps = parseInt(process.argv[3] ?? '8', 10)
    const deps: PhaseDeps = {cwd: repoArg, taskId: '', signal: new AbortController().signal}

    const raw = await expandFeatureMentions(repoArg, FEATURE)
    const phantoms = findPhantomImports(raw, repoArg)
    const featureForModel = phantoms.length === 0 ? raw : rewritePhantomSpecifiers(raw, phantoms)

    /** planAuto's requirement channel, run once per spec and shared by both arms. */
    const extract = async (spec: string): Promise<RequirementEntry[]> => {
        const passages = enumerateObligationPassages(spec)
        const once = async (hint: string | null): Promise<RequirementEntry[]> =>
            keepGroundedRequirements(
                parseRequirementLines(
                    await runPhaseChild(
                        deps,
                        'requirement-extract',
                        '',
                        prependHint(hint, REQUIREMENT_EXTRACT_PROMPT(spec, passages))
                    )
                ),
                spec
            )
        let entries = await once(null)
        const uncovered = uncoveredPassages(passages, entries)
        if (uncovered.length > 0) {
            entries = keepGroundedRequirements(
                [...entries, ...(await once(extractionRetryHint(uncovered)))],
                spec
            )
        }
        return capRequirements(entries, passages, spec)
    }

    /**
     * One arm's decompose, faithful to planAuto's post-parse pipeline.
     *
     * The TREATMENT swaps the plan-shape Q/A the triage produced for the host's
     * fixed one — the exact substitution `isPlanShapeQuestion` performs in the
     * clarify loop — and adds the silent floor's split reprompt. Everything else,
     * including the decompose RULES block, is identical between arms.
     */
    const runArm = async (
        spec: string,
        clarificationsIn: string,
        entries: RequirementEntry[],
        treatment: boolean
    ): Promise<{titles: string[]; retried: boolean}> => {
        const ownable = entries.filter(e => !isCrossCuttingRequirement(e.quote)).length
        const clarifications =
            treatment ? clarificationsIn.replace(COARSE_A1, HOST_A1) : clarificationsIn
        const prompt = AUTO_DECOMPOSE_PROMPT(
            spec,
            clarifications,
            buildRequirementsLedger(entries),
            mandatesTestsInSameChange(clarifications, spec)
        )
        const parse = (out: string): string[] =>
            rewriteBatchTestPlan(
                reconcileTitleSources(parseDecomposeList(out), spec).titles,
                clarifications,
                spec,
                entries.map(e => e.quote),
                isCrossCuttingRequirement
            ).titles
        let titles = parse(await runPhaseChild(deps, 'auto-decompose', 'read', prompt))
        let retried = false
        if (treatment && isTooCoarse(titles.length, granularityFloor(ownable))) {
            retried = true
            const split = parse(
                await runPhaseChild(
                    deps,
                    'auto-decompose',
                    'read',
                    prependHint(granularitySplitHint(titles.length, ownable), prompt)
                )
            )
            if (split.length > titles.length) titles = split
        }
        return {titles, retried}
    }

    // ─── primary: mx5, the collapsed transcript ──────────────────────────────
    const entries = await extract(featureForModel)
    const quotes = entries.map(e => e.quote)
    const ownable = entries.filter(e => !isCrossCuttingRequirement(e.quote)).length
    const floor = granularityFloor(ownable)
    console.log(
        `\nmx5: ${entries.length} grounded requirement(s), ${ownable} ownable ⇒ floor ${floor} task(s)\n`
    )

    const sizes = {baseline: [] as number[], treatment: [] as number[]}
    const cover = {baseline: [] as number[], treatment: [] as number[]}
    let baselineCollapsed = 0
    let treatmentCollapsed = 0
    let retries = 0

    // A decompose child that dies (context overflow, model error) is a REAL cost of
    // a lever that pushes for more output — counted per arm, never allowed to abort
    // the harness and hide the rest of the reps.
    const crashes = {baseline: 0, treatment: 0}

    for (let r = 1; r <= reps; r++) {
        for (const arm of ['baseline', 'treatment'] as const) {
            const t0 = Date.now()
            let titles: string[]
            let retried: boolean
            try {
                ;({titles, retried} = await runArm(
                    featureForModel,
                    COARSE_TRANSCRIPT,
                    entries,
                    arm === 'treatment'
                ))
            } catch (e) {
                crashes[arm]++
                console.log(`  rep ${r} ${arm.padEnd(9)}: CHILD FAILED — ${String(e).slice(0, 140)}`)
                continue
            }
            const covered = groundedCoverage(quotes, titles, isCrossCuttingRequirement).size
            sizes[arm].push(titles.length)
            cover[arm].push(covered)
            const collapsed = isTooCoarse(titles.length, floor)
            if (collapsed) {
                if (arm === 'baseline') baselineCollapsed++
                else treatmentCollapsed++
            }
            if (retried) retries++
            console.log(
                `  rep ${r} ${arm.padEnd(9)}: ${String(titles.length).padStart(2)} title(s)`
                    + `  grounded-coverage ${covered}/${ownable}`
                    + `${collapsed ? '  UNDER FLOOR' : ''}${retried ? '  (split-retried)' : ''}`
                    + `  [${Math.round((Date.now() - t0) / 1000)}s]`
            )
        }
    }

    // ─── negative control: a small spec must not be padded ───────────────────
    console.log('\n--- negative control (small CLI spec) ---')
    const smallEntries = await extract(SMALL_SPEC)
    const smallOwnable = smallEntries.filter(e => !isCrossCuttingRequirement(e.quote)).length
    console.log(
        `small spec: ${smallEntries.length} requirement(s), ${smallOwnable} ownable ⇒ floor `
            + `${granularityFloor(smallOwnable)}`
    )
    const smallSizes = {baseline: [] as number[], treatment: [] as number[]}
    const controlReps = Math.max(3, Math.floor(reps / 2))
    for (let r = 1; r <= controlReps; r++) {
        for (const arm of ['baseline', 'treatment'] as const) {
            const {titles} = await runArm(
                SMALL_SPEC,
                SMALL_CLARIFICATIONS,
                smallEntries,
                arm === 'treatment'
            )
            smallSizes[arm].push(titles.length)
            console.log(`  rep ${r} ${arm.padEnd(9)}: ${titles.length} title(s)`)
        }
    }

    const mean = (xs: number[]): number =>
        xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
    console.log('\n=== plan size (mx5, collapsed transcript) ===')
    console.log(`BASELINE  mean=${mean(sizes.baseline).toFixed(1)}  raw=[${sizes.baseline.join(', ')}]`)
    console.log(`TREATMENT mean=${mean(sizes.treatment).toFixed(1)}  raw=[${sizes.treatment.join(', ')}]`)
    console.log(`split-retry fired ${retries}/${reps} treatment reps`)
    console.log('\n=== negative control plan size ===')
    console.log(`BASELINE  mean=${mean(smallSizes.baseline).toFixed(1)}  raw=[${smallSizes.baseline.join(', ')}]`)
    console.log(`TREATMENT mean=${mean(smallSizes.treatment).toFixed(1)}  raw=[${smallSizes.treatment.join(', ')}]`)

    const smallInflation = mean(smallSizes.treatment) - mean(smallSizes.baseline)
    reportAb({
        name: 'granularity floor — decompose collapses under an auto-resolved "one task per milestone"',
        reps,
        targetShape: `a plan under the granularity floor (< ${floor} titles for ${ownable} ownable requirements)`,
        baselineHits: baselineCollapsed,
        treatmentHits: treatmentCollapsed,
        requireTreatmentZero: false,
        invariants: [
            {
                label: 'grounded coverage never falls',
                ok: mean(cover.treatment) >= mean(cover.baseline),
                detail: `baseline ${mean(cover.baseline).toFixed(1)} → treatment ${mean(cover.treatment).toFixed(1)} of ${ownable}`
            },
            {
                label: 'no degenerate plan in the treatment arm',
                ok: sizes.treatment.every(n => n >= 3),
                detail: `min ${Math.min(...sizes.treatment)} titles`
            },
            {
                label: 'small spec is not padded (negative control)',
                ok: smallInflation <= 2,
                detail: `treatment − baseline = ${smallInflation.toFixed(1)} titles`
            },
            {
                label: 'the lever adds no child failures',
                ok: crashes.treatment <= crashes.baseline,
                detail: `baseline ${crashes.baseline}, treatment ${crashes.treatment} dead decompose child(ren)`
            },
            {
                label: 'no runaway plan (≤ 2× the floor)',
                ok: sizes.treatment.every(n => n <= floor * 2),
                detail: `max ${sizes.treatment.length > 0 ? Math.max(...sizes.treatment) : 0} titles vs floor ${floor}`
            }
        ]
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
