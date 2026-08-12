/**
 * STEP 0 — MEASURE THE ZERO-RETRIEVAL BASE RATE of worker:apis, offline, from the
 * stopping-point raw data. No model time.
 *
 * This is the DISTINCT failure the STAGE 1-3 stopping-point thread excludes by construction:
 * live-apis-stopping-point.ts scores only reps with `docsSteps > 0`, because a rep that never
 * retrieved "did not accept an answer and stop — it wrote the section from memory". This scorer
 * looks at exactly those excluded reps.
 *
 * TWO POPULATIONS, reported separately because they answer different questions:
 *   ZERO-ANY-TOOL       reps that made no tool call at all (no docs/read/grep/find/ls/search/
 *                       fetch). This is the failure as originally named ("3 of ~18 reps").
 *   ZERO-GROUNDING      reps that made no GROUNDING-retrieval call — the committed
 *                       isGroundingRetrieval set (docs/read/grep/search/fetch; ls/find EXCLUDED,
 *                       because they return names and APIS owns symbols not paths). This is what
 *                       the gate fires on, so it is the number the gate's population is sized to.
 *                       It is a superset of ZERO-ANY-TOOL: an `ls`-only rep is grounded in
 *                       nothing an APIS signature can cite, and the gate catches it while the
 *                       literal definition would not.
 *
 * For every zero-retrieval rep it records what the rep PRODUCED (entry count; whether the
 * section is non-empty and plausible = the dangerous case, vs empty/degenerate) and whether the
 * reps CLUSTER (one fixture? early reps, i.e. a cold-cache proxy? — the research cache is off in
 * this harness, so clustering on rep-1 would still not be a cache artifact). Name-grounding is
 * reported too, to make the central point: a zero-retrieval section's entry NAMES are almost
 * all in the prompt already (the FILES map surveyed them), so a name-substring test scores it
 * "grounded" — yet its SIGNATURES were never verified. Zero retrieval ⇒ ungrounded by
 * construction is the only sound reading, which is why the gate keys on the call count, not on
 * symbol grounding (the handle STAGE 3 lacked).
 *
 * Re-score the shipped raw data (no model time):
 *   STOP_DIR=~/tmp/apis-stopping-point bun run scripts/apis-zero-retrieval-baserate.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {isGroundingRetrieval} from '../src/workers/pi-worker-core.js'
import {parseApisEntries, type Step} from './apis-trajectory.js'
import {wilson} from './ab-stats.js'

const ROOT = path.resolve(
    process.env.STOP_DIR || path.join(os.homedir(), 'tmp', 'apis-stopping-point')
)

interface Rep {
    fixture: string
    rep: number
    steps: Step[]
    apisSection: string
    apisPrompt: string
    minutes: number
    error?: string
}

/** Wilson score interval for a binomial proportion — honest at small n and near 0. */


const pct = (x: number): string => `${(100 * x).toFixed(1)}%`

/** A tool call with an argument — the turn markers ("writing answer…") carry none. */
const realCalls = (r: Rep): Step[] => r.steps.filter(s => s.arg.length > 0)
const groundingCalls = (r: Rep): Step[] => realCalls(r).filter(s => isGroundingRetrieval(s.tool))

function main(): void {
    const saved = path.join(ROOT, 'stopping-point.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: ${saved} does not exist. Set STOP_DIR or run the base-rate batch.`)
        process.exit(1)
    }
    const reps = (JSON.parse(fs.readFileSync(saved, 'utf8')) as Rep[]).filter(r => !r.error)
    const fixtures = [...new Set(reps.map(r => r.fixture))]

    console.log(`apis-zero-retrieval-baserate — RE-SCORING ${saved} (no model time)`)
    console.log(`  ${reps.length} non-errored reps over ${fixtures.length} fixture(s): ${fixtures.join(', ')}\n`)

    const zeroAny = reps.filter(r => realCalls(r).length === 0)
    const zeroGrounding = reps.filter(r => groundingCalls(r).length === 0)

    for (const [label, pop] of [
        ['ZERO-ANY-TOOL   (no tool call at all)', zeroAny],
        ['ZERO-GROUNDING  (no docs/read/grep/search/fetch; ls/find excluded)', zeroGrounding]
    ] as const) {
        const [lo, hi] = wilson(pop.length, reps.length)
        console.log(`=== ${label} ===`)
        console.log(
            `  ${pop.length}/${reps.length} = ${pct(pop.length / reps.length)}`
                + `   Wilson95 [${pct(lo)}, ${pct(hi)}]`
        )
        // Clustering: by fixture and by rep index (early reps = cold-cache proxy).
        for (const f of fixtures) {
            const inF = pop.filter(r => r.fixture === f)
            const nF = reps.filter(r => r.fixture === f).length
            console.log(`    ${f.padEnd(16)} ${inF.length}/${nF}`)
        }
        const early = pop.filter(r => r.rep <= 3).length
        console.log(
            `    rep<=3 (cold-cache proxy) ${early}/${pop.length}`
                + `   [cache is OFF in this harness, so this is only an ordering signal]`
        )
        console.log()
    }

    // What the zero-grounding reps PRODUCE. Non-empty & plausible = the dangerous case.
    console.log(`=== what each ZERO-GROUNDING rep produced ===`)
    if (zeroGrounding.length === 0) {
        console.log('  none in this dataset.')
    }
    for (const r of zeroGrounding) {
        const entries = parseApisEntries(r.apisSection)
        const nonEmpty = entries.length > 0
        // Name-grounding: are the entry-name symbols already in the prompt the worker was
        // handed? (They almost always are — that is the point: names grounded, signatures not.)
        const syms = entries.flatMap(e => e.symbols)
        const inPrompt = syms.filter(s => r.apisPrompt.includes(s)).length
        const calls = realCalls(r)
        const nonGrounding = calls.filter(s => !isGroundingRetrieval(s.tool))
        console.log(
            `  ${r.fixture} rep${r.rep}: ${nonEmpty ? 'NON-EMPTY (dangerous)' : 'empty/degenerate'}`
                + ` — ${entries.length} entries, ${calls.length} tool calls`
                + (nonGrounding.length > 0 ? ` (${nonGrounding.map(s => s.tool).join(',')} only)` : ' (zero calls)')
                + ` — entry-name symbols in prompt ${inPrompt}/${syms.length} = ${syms.length ? pct(inPrompt / syms.length) : 'n/a'}`
                + `  [${r.minutes.toFixed(1)}m]`
        )
        // First two entries, so the "plausible signature from memory" claim is auditable.
        for (const e of entries.slice(0, 2)) {
            console.log(`      ${e.name}  —  ${e.rest.slice(0, 100)}`)
        }
    }

    console.log(
        `\n  READING: a NON-EMPTY zero-grounding section is the maximal F-1 case — a complete,`
            + `\n  plausible APIS section in which nothing was verified. Its entry NAMES score`
            + `\n  grounded (they were in the prompt), so a name-substring gate cannot catch it;`
            + `\n  the call count can. That is the gate's handle.`
    )
}

main()
