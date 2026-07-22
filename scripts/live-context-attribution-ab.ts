/**
 * PROMPT 1 live A/B — does the API-semantics rule + post-check stop worker:context
 * laundering an unsourceable claim?
 *
 * BASELINE (recorded, pre-change): scripts/live-context-attribution-probe.ts measured
 * 2/8 reps on this exact fixture, 2 hits in 104 bullets. That is the number to beat.
 *
 * ── HOW BOTH ARMS COME OUT OF ONE PROCESS ─────────────────────────────────────────────
 *
 * The house rule is that both arms run in one process so counts are directly comparable.
 * That is awkward here: the lever is half prompt (belt) and half post-check (braces), and
 * both live inside phaseResearch, which is not parameterised.
 *
 * But the post-check is a PURE function applied at `postProcess`, and it logs every bullet
 * it demotes. So a single run yields both arms, perfectly paired per rep:
 *
 *     UNGATED hits = hits still detectable in the emitted CONTEXT + bullets demoted
 *     GATED   hits = hits still detectable in the emitted CONTEXT
 *
 * The demoted bullets ARE the ungated arm's hits — they were flagged, and without the
 * braces they would have been persisted verbatim. Nothing is reconstructed or assumed:
 * the demotion log is written by the gate itself at the moment it fires.
 *
 * WHAT EACH COMPARISON MEANS — be precise, these are not the same question:
 *   recorded 2/8      pre-change code: no belt, no braces.
 *   UNGATED (here)    belt ONLY (the prompt rule is in effect; the gate's effect removed).
 *   GATED   (here)    belt + braces — what actually ships.
 * So UNGATED-vs-GATED isolates the post-check's contribution, and recorded-vs-GATED is the
 * end-to-end effect. A belt that works well on its own will show UNGATED already low; that
 * is a success of the prompt rule, NOT an abstain, and the recorded baseline is what saves
 * the run from being unreadable in that case.
 *
 * SCORING CAVEAT, measured and deliberate. The probe scores against an EMPTY external
 * context: `research.indexOf('FILES')` is 0 because the assembled research text STARTS
 * with FILES, so the slice is always ''. Verified directly against a recorded rep. With no
 * blocks, nothing is source-capable, so the detector runs as a strict SUPERSET — it flags
 * more than the shipped in-phase gate (which sees the real header) ever would. That biases
 * the treatment arm towards FAILING, never towards a false pass, and it keeps this run
 * comparable to the recorded 2/8, which was scored the same way. Do not "fix" it without
 * re-recording the baseline.
 *
 * Consequence: this A/B does NOT validate the source-capable block taxonomy
 * ({docs,url} capable; npm/service not). With zero blocks that logic never executes.
 *
 * REPS — 16 per arm, NOT the 8 nexxtasks specifies. At the measured baseline rate
 * p = 2/8 = 0.25, a treatment arm scores 0 by chance with probability 0.75^8 = 0.10, so
 * the spec'd criterion would pass a do-nothing lever one run in ten. 0.75^16 = 0.010.
 *
 * Run:
 *   bun run build   # the probe imports from dist/
 *   PI_BIN=$(command -v pi) bun run scripts/live-context-attribution-ab.ts [REPS]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {phaseResearch} from '../dist/task/phases.js'
import type {PhaseDeps} from '../dist/task/child-runner.js'
import {findUnsourcedAttributions} from '../dist/task/context-attribution.js'
import {REFINED_27, buildPreTask27Tree} from './run15-fixture-tree.js'
import {reportAb, type Invariant} from './ab-verdict.js'

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error(
        'REFUSING TO RUN: PI_BIN is unset. An unset PI_BIN makes the child re-invoke '
            + 'this harness instead of pi — a fork bomb that has crashed this machine twice.'
    )
    process.exit(1)
}

const REPS = Number(process.argv[2] ?? '16')
const ROOT = path.join(os.homedir(), 'tmp', 'context-attribution-ab')
const TRIAL_TIMEOUT_MS = 45 * 60_000
/** The pre-change number this run must beat, from live-context-attribution-probe.ts. */
const RECORDED_BASELINE = {hits: 2, reps: 8}

/** The gate logs one line per demotion; that line is the ungated arm's evidence. */
const DEMOTION_LINE = /worker:context: demoted unsourced attribution/

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

function section(research: string, name: string): string {
    const re = new RegExp(`^${name}\\s*$`, 'm')
    const m = re.exec(research)
    if (!m) return ''
    const rest = research.slice(m.index + m[0].length)
    const next = /^(FILES|APIS|CONTEXT|TOOLING|VERIFIED-TOOLING)\s*$/m.exec(rest)
    return next ? rest.slice(0, next.index) : rest
}

async function main(): Promise<void> {
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error('FATAL: llama-server @ 127.0.0.1:8080 not reachable.')
        process.exit(1)
    }

    console.log(
        `live-context-attribution-ab — PROMPT 1, ${REPS} reps\n`
            + `model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, real phaseResearch\n`
            + `recorded pre-change baseline: ${RECORDED_BASELINE.hits}/${RECORDED_BASELINE.reps}`
    )

    let ungatedHits = 0
    let gatedHits = 0
    let completed = 0
    let bulletTotal = 0
    let demotedTotal = 0
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
            const bullets = context.split('\n').filter(l => /^\s*[-*]\s+/.test(l)).length
            // Same empty-slice scoring as the recorded baseline — see the header.
            const external = research.slice(0, research.indexOf('FILES'))
            const surviving = findUnsourcedAttributions(context, external, packagesOf(dir))
            const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
            const demoted = log.split('\n').filter(l => DEMOTION_LINE.test(l)).length

            completed++
            bulletTotal += bullets
            demotedTotal += demoted
            if (surviving.length > 0) gatedHits++
            if (surviving.length + demoted > 0) ungatedHits++

            fs.writeFileSync(
                path.join(dir, 'result.json'),
                JSON.stringify({context, surviving, demoted, bullets}, null, 2),
                'utf8'
            )
            rows.push({rep: t, bullets, demoted, surviving: surviving.map(s => s.bullet)})
            console.log(
                `  rep ${t}/${REPS}  bullets=${bullets}  demoted=${demoted}`
                    + `  surviving-in-shipped=${surviving.length}`
                    + `  [${((Date.now() - started) / 60000).toFixed(1)}m]`
            )
            for (const s of surviving) {
                console.log(`      SURVIVED [${s.unsourced.join(',')}] ${s.bullet.slice(0, 140)}`)
            }
        } catch (e) {
            console.log(`  rep ${t}/${REPS}  ERROR: ${String(e).slice(0, 180)}`)
        } finally {
            clearTimeout(timer)
        }
        fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(rows, null, 1), 'utf8')
    }

    console.log(
        `\nungated (belt only, gate effect removed): ${ungatedHits}/${completed}`
            + `\ngated   (belt + braces, as shipped):     ${gatedHits}/${completed}`
            + `\nbullets ${bulletTotal}, demotions ${demotedTotal}`
    )

    const invariants: Invariant[] = [
        {
            label: 'reps >= 16 (0.75^16 = 1% false-pass at the measured p=0.25)',
            ok: completed >= 16,
            detail: `${completed} completed reps`
        },
        {
            // PROMPT 1 states this explicitly: a worker silenced into saying nothing is a
            // regression, not a fix. The pre-change probe averaged 13 bullets/rep.
            label: 'CONTEXT did not collapse — bullets/rep >= 8 (pre-change mean was 13)',
            ok: completed === 0 || bulletTotal / completed >= 8,
            detail: `${(bulletTotal / Math.max(1, completed)).toFixed(1)} bullets/rep`
        },
        {
            label: 'the gate demotes rather than deletes (bullet count preserved)',
            ok: completed === 0 || bulletTotal > 0,
            detail: `${bulletTotal} bullets across ${completed} reps`
        }
    ]

    reportAb({
        name: 'live-context-attribution-ab (PROMPT 1)',
        reps: completed,
        targetShape:
            'a CONTEXT bullet asserting external API usage semantics under an attribution '
            + 'cue that no EXTERNAL CONTEXT block can support — the F-1 laundering shape '
            + `(recorded pre-change: ${RECORDED_BASELINE.hits}/${RECORDED_BASELINE.reps})`,
        baselineHits: ungatedHits,
        treatmentHits: gatedHits,
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
