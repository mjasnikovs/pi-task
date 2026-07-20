/**
 * LIVE A/B for the batch-test ban (mx5 run 14, PROMPT item 6) against the real
 * local model (Qwen3.6-27B via pi @ 127.0.0.1:8080).
 *
 * Fixture: `mx5` — byte-identical to run 14's DESIGN/PROJECT.md, driven through
 * the REAL decompose child (ab-planning → runChild → pi --mode json) with run
 * 14's own CLARIFICATIONS, so the arms differ only in the mechanism under test.
 *
 *   BASELINE   the shipped-before prompt (no anti-batch rule), no host rewrite.
 *   TREATMENT  prompt rule + host rewriteBatchTestPlan.
 *
 * Reports, per rep: whether a whole-project batch test task survives each arm,
 * and whether treatment REDUCED grounded coverage (the run-12 guard — it must
 * never fire).
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/live-batch-test-ab.ts [REPS=3]
 */
import {extractRequirementsNew, loadPlanningFixture, runPlanningChild} from './ab-planning.js'
import {AUTO_DECOMPOSE_PROMPT} from '../src/task/auto-prompts.js'
import {parseDecomposeList} from '../src/task/auto-io.js'
import {reconcileTitleSources} from '../src/task/decompose-fidelity.js'
import {buildRequirementsLedger, isCrossCuttingRequirement} from '../src/task/requirements.js'
import {groundedCoverage} from '../src/task/coverage-loop.js'
import {
    findBatchTestTitles,
    mandatesTestsInSameChange,
    rewriteBatchTestPlan
} from '../src/task/batch-test-task.js'

/** run 14's settled clarifications, verbatim — the decisions carried onto TASK_0037. */
const CLARIFICATIONS = [
    '- a test lands *as fast as possible* — in the same change — as each new route or',
    '  React component/page. No route or component is considered done until its test',
    "  exists and passes. Don't batch testing to the end of a milestone.",
    '- Mock RPC calls at the network boundary so component tests stay deterministic',
    '  and DB-free.'
].join('\n')

async function main(): Promise<void> {
    const reps = process.argv[2] ? parseInt(process.argv[2], 10) : 3
    const fx = await loadPlanningFixture('mx5')
    console.log(`fixture mx5: ${fx.featureForModel.length} chars (run 14's PROJECT.md)`)

    if (!mandatesTestsInSameChange(CLARIFICATIONS, fx.featureForModel)) {
        throw new Error('detector did not fire on run 14 clarifications — fixture drift')
    }

    // Requirements once: the ledger is an input to BOTH arms, so re-rolling it per
    // rep would add variance that has nothing to do with the mechanism.
    const reqs = await extractRequirementsNew(fx)
    const quotes = reqs.map(e => e.quote)
    const ledger = buildRequirementsLedger(reqs)
    console.log(`requirements: ${reqs.length} grounded`)

    let baselineBatch = 0
    let treatmentBatch = 0
    let coverageReduced = 0
    let sweeps = 0
    let drops = 0

    for (let rep = 1; rep <= reps; rep++) {
        const plan = async (noBatchRule: boolean): Promise<string[]> =>
            reconcileTitleSources(
                parseDecomposeList(
                    await runPlanningChild(
                        fx.cwd,
                        'read',
                        AUTO_DECOMPOSE_PROMPT(
                            fx.featureForModel,
                            CLARIFICATIONS,
                            ledger,
                            noBatchRule
                        )
                    )
                ),
                fx.featureForModel
            ).titles

        // BASELINE arm — also the input the host rewrite must repair, so the
        // treatment is measured on the SAME plan the baseline shipped.
        const base = await plan(false)
        const baseBatch = findBatchTestTitles(base)
        if (baseBatch.length > 0) baselineBatch++

        const fixed = rewriteBatchTestPlan(
            base,
            CLARIFICATIONS,
            fx.featureForModel,
            quotes,
            isCrossCuttingRequirement
        )
        for (const a of fixed.actions) {
            if (a.kind === 'scoped') sweeps++
            else drops++
        }

        // Coverage must not fall (run 12's lesson).
        const before = groundedCoverage(quotes, base, isCrossCuttingRequirement)
        const after = groundedCoverage(quotes, fixed.titles, isCrossCuttingRequirement)
        const lost = [...before].filter(i => !after.has(i))
        if (lost.length > 0) coverageReduced++

        // Prompt-rule arm: does the model avoid emitting the shape at all?
        // BASELINE_ONLY=1 halves the cost when the question is only how often the
        // baseline emits the batch shape at all (it is intermittent — see below).
        const withRule = process.env.BASELINE_ONLY === '1' ? base : await plan(true)
        const ruleBatch = findBatchTestTitles(withRule)
        const ruleFixed = rewriteBatchTestPlan(
            withRule,
            CLARIFICATIONS,
            fx.featureForModel,
            quotes,
            isCrossCuttingRequirement
        )
        if (findBatchTestTitles(ruleFixed.titles).length > 0) treatmentBatch++

        console.log(
            `rep ${rep}/${reps}: baseline ${base.length} titles, batch=${baseBatch.length}`
                + `${baseBatch.map(i => ` ["${base[i]}"]`).join('')}`
                + ` → host rewrite: ${fixed.actions.map(a => a.kind).join(',') || 'none'}`
                + `, coverage ${before.size}→${after.size}${lost.length > 0 ? ' LOST!' : ''}`
                + ` | prompt-rule arm: ${withRule.length} titles, batch=${ruleBatch.length}`
        )
        for (const a of fixed.actions) {
            if (a.kind === 'scoped') console.log(`    sweep: ${a.replacement}`)
        }
        // Every title mentioning tests, both arms — so a MISSED batch shape (a
        // false negative in the detector) is visible in the log, not just absent.
        for (const [arm, titles] of [
            ['baseline', base],
            ['rule', withRule]
        ] as const) {
            for (const t of titles) {
                if (/\btests?\b|\btesting\b/i.test(t)) console.log(`    ${arm} test-title: ${t}`)
            }
        }
    }

    console.log(
        `\nBASELINE  batch test task shipped: ${baselineBatch}/${reps}`
            + `\nTREATMENT batch test task shipped: ${treatmentBatch}/${reps}`
            + `\nhost rewrite: ${sweeps} scoped sweep(s), ${drops} drop(s)`
            + `\ncoverage reduced: ${coverageReduced}/${reps} (must be 0)`
    )
}

main().catch(err => {
    console.error(err instanceof Error ? err.stack : String(err))
    process.exit(1)
})
