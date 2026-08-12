/**
 * PHASE 1 live A/B — does the silent-retry gate lower worker:context's silent rate without
 * buying back fabricated context?
 *
 * STEP 0 (context-silence-classify.ts) established the target: worker:context is silent
 * (zero bullets) in ~10% of live reps (5/48), and EVERY silent rep was a genuine loss — a
 * loop-degrade banner or a hallucinated non-bullet fragment — never a legitimate empty
 * answer. The gate (phases.ts, retryIfSilent on the CONTEXT spec) retries a silent section
 * ONCE with a forced-emit preamble and keeps the retry only if it produces bullets.
 *
 * ── BOTH ARMS FROM ONE PAIRED RUN ─────────────────────────────────────────────────────
 * The gate lives inside phaseResearch and logs every firing, so — exactly like the
 * attribution A/B — one run yields both arms, paired per rep:
 *     baseline  silent iff the gate FIRED (first attempt was silent: `silent-retry first-silent`)
 *     treatment silent iff it fired AND the retry did not recover (`silent-retry still-silent`)
 * A rep where the gate never fired is productive in both arms. Nothing is reconstructed: the
 * lines are written by the gate itself at the moment it fires. This costs one extra worker
 * run only on the ~10% of reps that are silent, so N reps ≈ N+0.1N generations for both arms.
 *
 * HARM — the sourced-bullet invariant must not loosen. A retry that recovers a section by
 * FABRICATING an unsourced API-semantics claim is not a fix. Every recovered section is
 * scored with findUnsourcedAttributions (the shipped F-1 detector); recovered bullets exist
 * only in the treatment arm, so any unsourced attribution among them is a NEW fabrication the
 * baseline (silent) arm did not have. The harm test requires that count to be zero-or-not-risen
 * and that bullets/rep did not collapse.
 *
 * Run:
 *   bun run build   # the harness imports the shipped gate from dist/
 *   PI_BIN=$(command -v pi) bun run scripts/context-silent-retry-ab.ts [REPS]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {phaseResearch} from '../dist/task/phases.js'
import type {PhaseDeps} from '../dist/task/child-runner.js'
import {findUnsourcedAttributions} from '../dist/task/context-attribution.js'
import {classifyContextSilence, countBullets, wilsonInterval} from '../dist/task/context-silence.js'
import {REFINED_27, PRE_TASK_0027, buildPreTask27Tree} from './run15-fixture-tree.js'
import {reportAb, type Invariant} from './ab-verdict.js'
import {requirePreconditions} from './ab-preflight.js'
import {readSection} from './ab-corpus.js'

await requirePreconditions('context-silent-retry-ab', {model: {}, piBin: true, cacheOff: true})

const REPS = Number(process.argv[2] ?? '48')
const ROOT = path.join(os.homedir(), 'tmp', 'context-silent-retry-ab')
const TRIAL_TIMEOUT_MS = 45 * 60_000
/** Pre-registered min number of live silent reps the gate must FLIP to pass (not abstain). */
const MIN_FLIPS = 3

const FIRED = /silent-retry first-silent cause=(\S+)/
const RECOVERED = /silent-retry recovered bullets=(\d+)/
const STILL_SILENT = /silent-retry still-silent/

function packagesOf(dir: string): string[] {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }
        return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    } catch {
        return []
    }
}

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

async function main(): Promise<void> {

    console.log(
        `context-silent-retry-ab — PHASE 1, ${REPS} reps\n`
            + `model @ 127.0.0.1:8080, real phaseResearch, fixture mx5@${PRE_TASK_0027}\n`
            + `baseline = gate fired (first attempt silent); treatment = still silent after retry`
    )

    let completed = 0
    let baselineSilent = 0 // gate fired
    let treatmentSilent = 0 // fired AND retry failed
    let flips = 0 // fired AND retry recovered
    let bulletTotal = 0
    // Fabrication harm, per arm. Baseline-silent reps have zero bullets → zero attributions;
    // the recovered bullets are treatment-only, so their unsourced attributions are the cost.
    let treatmentUnsourced = 0
    const rows: Array<Record<string, unknown>> = []

    for (let t = 1; t <= REPS; t++) {
        const dir = buildPreTask27Tree(ROOT, t)
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
        const logPath = path.join(dir, 'trial.log')
        const deps: PhaseDeps = {
            cwd: dir,
            taskId: 'TASK_0027',
            signal: abort.signal,
            onChildOutput: l => fs.appendFileSync(logPath, l + '\n'),
            logDebug: m => fs.appendFileSync(logPath, `[debug] ${m}\n`)
        }
        const started = Date.now()
        try {
            const research = await phaseResearch(deps, REFINED_27)
            const context = section(research, 'CONTEXT')
            const bullets = countBullets(context)
            const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''

            const firedM = FIRED.exec(log)
            const fired = firedM !== null
            const recovered = RECOVERED.test(log)
            const stillSilent = STILL_SILENT.test(log)
            // Final section silence, independent of the log, as a cross-check.
            const finalVerdict = classifyContextSilence(context)

            const external = research.slice(0, research.indexOf('FILES'))
            const unsourced = findUnsourcedAttributions(context, external, packagesOf(dir))

            completed++
            bulletTotal += bullets
            if (fired) baselineSilent++
            if (fired && stillSilent) treatmentSilent++
            if (fired && recovered) {
                flips++
                treatmentUnsourced += unsourced.length // the recovered section's fabrication cost
            }

            fs.writeFileSync(
                path.join(dir, 'result.json'),
                JSON.stringify({context, bullets, fired, recovered, stillSilent, unsourced}, null, 2),
                'utf8'
            )
            rows.push({
                rep: t,
                bullets,
                fired,
                cause: firedM?.[1] ?? null,
                recovered,
                stillSilent,
                finalSilent: finalVerdict.silent,
                unsourced: unsourced.length
            })
            console.log(
                `  rep ${t}/${REPS}  bullets=${bullets}  fired=${fired}`
                    + `${fired ? ` cause=${firedM?.[1]}` : ''}`
                    + `${fired ? (recovered ? ' → RECOVERED' : ' → still-silent') : ''}`
                    + `  unsourced=${unsourced.length}  [${((Date.now() - started) / 60000).toFixed(1)}m]`
            )
        } catch (e) {
            console.log(`  rep ${t}/${REPS}  ERROR: ${String(e).slice(0, 180)}`)
        } finally {
            clearTimeout(timer)
        }
        fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(rows, null, 1), 'utf8')
    }

    const bCI = wilsonInterval(baselineSilent, completed)
    const tCI = wilsonInterval(treatmentSilent, completed)
    console.log(
        `\nbaseline  silent: ${baselineSilent}/${completed}`
            + ` [Wilson95 ${(bCI.lo * 100).toFixed(1)}%, ${(bCI.hi * 100).toFixed(1)}%]`
            + `\ntreatment silent: ${treatmentSilent}/${completed}`
            + ` [Wilson95 ${(tCI.lo * 100).toFixed(1)}%, ${(tCI.hi * 100).toFixed(1)}%]`
            + `\nflips (silent → recovered): ${flips}`
            + `\nbullets total ${bulletTotal}, recovered-section unsourced attributions ${treatmentUnsourced}`
    )

    const invariants: Invariant[] = [
        {
            label: `flipped >= ${MIN_FLIPS} live silent reps (else the lever is unexercised → abstain)`,
            ok: flips >= MIN_FLIPS,
            detail: `${flips} flips`
        },
        {
            // HARM: recovering silence must not buy back fabricated context.
            label: 'no unsourced API-semantics attribution in any recovered section',
            ok: treatmentUnsourced === 0,
            detail: `${treatmentUnsourced} unsourced attributions across ${flips} recovered sections`
        },
        {
            // HARM: the retry must not collapse the healthy reps' bullet yield.
            label: 'CONTEXT did not collapse — bullets/rep >= 8 (pre-change mean was ~14)',
            ok: completed === 0 || bulletTotal / completed >= 8,
            detail: `${(bulletTotal / Math.max(1, completed)).toFixed(1)} bullets/rep`
        }
    ]

    reportAb({
        name: 'context-silent-retry-ab (PHASE 1)',
        reps: completed,
        targetShape:
            'a SILENT worker:context section — zero bullets from a loop-degrade or a hallucinated '
            + 'non-bullet fragment (STEP 0: 5/48 live, all genuine loss)',
        baselineHits: baselineSilent,
        treatmentHits: treatmentSilent,
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
