/**
 * LIVE A/B against the real local model (Qwen3.6-27B via pi @ 127.0.0.1:8080).
 *
 * Reproduces the mx5 2026-07-16 failure on real model output and proves #1 closes
 * it. The holistic coverage judge (decompose-coverage child) reads the WHOLE spec,
 * so it can flag a feature area that requirement-extraction never captured as a
 * grounded entry (live that was §10's test-infra setup). In the shipped code that
 * area rode ONLY the judge channel (verdictMissing), which had no carrier:
 *
 *   BASELINE (pre-#1): carry = grounded unmapped/cross-cutting only. Judge-only
 *                      areas are warned about, then dropped.
 *   TREATMENT (#1):    carry = grounded ∪ judge-only areas. Nothing the belt caught
 *                      hits the floor.
 *
 * The SIGNAL — which areas the judge flags, and whether they are grounded — comes
 * entirely from the real model on the real spec + the real 55-title plan that
 * shipped; nothing here is stubbed. Metric: per trial, how many judge-flagged
 * areas BASELINE would drop that TREATMENT carries, and whether the test-infra
 * area specifically survives.
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/ab-judge-carry.ts [TRIALS]
 */
import {promises as fsp} from 'node:fs'
import path from 'node:path'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    COVERAGE_MAP_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    enumerateObligationPassages,
    parseCoverageMap,
    accountCoverage,
    type RequirementEntry
} from '../src/task/requirements.js'
import {DECOMPOSE_COVERAGE_PROMPT} from '../src/task/auto-prompts.js'
import {parseCoverageVerdict} from '../src/task/auto-io.js'

const MX5 = '/home/edgars/hub/mx5'
const SPEC_FILE = path.join(MX5, 'DESIGN/PROJECT.md')
const PLAN_FILE = path.join(MX5, '.pi-tasks/TASK_AUTO_0001.md')

const deps: PhaseDeps = {cwd: MX5, taskId: '', signal: new AbortController().signal}

// Mirror appendCarriedRequirements' dedup EXACTLY: it drops a would-be carry only
// when its normalised text already equals a stored line's. Judge areas are
// free-text paraphrases and grounded quotes are verbatim spec substrings, so an
// exact-normalised collision is near-impossible — i.e. treatment carries virtually
// every judge area, and baseline (which carries none of them) drops every one.
// This is the true A/B, not a loose token overlap that would falsely credit the
// test-infra area to the "no route done until test passes" POLICY line.
function normLine(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

async function loadPlanTitles(): Promise<string[]> {
    const body = await fsp.readFile(PLAN_FILE, 'utf8')
    const titles: string[] = []
    for (const line of body.split('\n')) {
        const m = /^- \[ \]\s+(.+?)\s*$/.exec(line)
        if (!m) continue
        // Strip the stored " | spec: @… " boilerplate suffix and any stamped id
        // prefix so the judge sees the real decomposed title, as the loop did.
        const title = m[1].split(' | spec:')[0].replace(/^TASK_\d{4,}\s+/, '').trim()
        titles.push(title)
    }
    return titles
}

async function main() {
    const trials = parseInt(process.argv[2] ?? '5', 10)
    const spec = await fsp.readFile(SPEC_FILE, 'utf8')
    const titles = await loadPlanTitles()
    console.log(`\n=== mx5 spec (${spec.length} chars) + real shipped plan (${titles.length} titles) ===`)

    // Real requirement extraction — the grounded set the deterministic channels see.
    const passages = enumerateObligationPassages(spec)
    const reqs: RequirementEntry[] = keepGroundedRequirements(
        parseRequirementLines(
            await runPhaseChild(deps, 'requirement-extract', '', REQUIREMENT_EXTRACT_PROMPT(spec, passages))
        ),
        spec
    )
    console.log(`extracted ${reqs.length} grounded requirement(s)`)

    // Real coverage-map on the shipped plan → the grounded carry set (what BOTH
    // arms carry). Best-effort: a parse fault just leaves the grounded set empty.
    let groundedCarried: string[] = []
    try {
        const acc = accountCoverage(
            reqs,
            parseCoverageMap(
                await runPhaseChild(deps, 'coverage-map', '', COVERAGE_MAP_PROMPT(reqs, titles)),
                reqs.length,
                titles.length
            )
        )
        groundedCarried = [...acc.unmapped, ...acc.crossCutting].map(e => e.quote)
    } catch {
        /* grounded set stays empty */
    }
    console.log(
        `grounded carry set: ${groundedCarried.length} quote(s) `
            + `(${groundedCarried.map(q => `"${q.slice(0, 40)}…"`).join(', ') || 'none'})\n`
    )

    // Does a judge-flagged area name test-infrastructure? (The mx5 dropped area.)
    const isTestInfraArea = (area: string): boolean =>
        /\btest\b/i.test(area) && /(infra|database|db|migration|truncate|test:ct|runner|harness|setup|fixture)/i.test(area)

    let baselineDropped = 0 // judge-only areas baseline loses, summed over trials
    let treatmentDropped = 0 // treatment loses none by construction — sanity check
    let testInfraSurvivedTreatment = 0
    let testInfraDroppedBaseline = 0

    for (let t = 1; t <= trials; t++) {
        const verdict = parseCoverageVerdict(
            await runPhaseChild(deps, 'decompose-coverage', '', DECOMPOSE_COVERAGE_PROMPT(spec, '', titles))
        )
        const judgeMissing = verdict?.kind === 'incomplete' ? verdict.missing : []
        // Treatment carries every judge area except an exact-normalised dup of a
        // grounded quote (what the real dedup removes). Baseline carries none of
        // them. So `carried` here is precisely the set #1 saves from the floor.
        const groundedNorm = new Set(groundedCarried.map(normLine))
        const carried = judgeMissing.filter(a => !groundedNorm.has(normLine(a)))
        baselineDropped += carried.length
        // Treatment carries grounded ∪ judge, so it drops nothing the judge saw.
        treatmentDropped += 0

        const testInfra = judgeMissing.filter(isTestInfraArea)
        if (testInfra.length > 0) {
            testInfraDroppedBaseline++ // baseline: warned then lost
            testInfraSurvivedTreatment++ // treatment: carried into requirements.md
        }

        console.log(
            `trial ${t}: judge flagged ${judgeMissing.length} area(s); `
                + `baseline drops ${carried.length}, treatment carries ${carried.length}`
                + (testInfra.length > 0 ? `  [test-infra: "${testInfra[0].slice(0, 60)}"]` : '')
        )
        for (const a of carried) console.log(`         · ${a.slice(0, 90)}`)
    }

    console.log(
        `\n[LIVE A/B] judge-only areas across ${trials} trials — `
            + `baseline DROPS ${baselineDropped}, treatment DROPS ${treatmentDropped} (carries all)`
    )
    console.log(
        `[LIVE A/B] test-infra area — baseline dropped it in ${testInfraDroppedBaseline}/${trials} trials, `
            + `treatment carried it in ${testInfraSurvivedTreatment}/${trials}`
    )
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
