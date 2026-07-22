/**
 * STEP 0 item 3 — the LIVE baseline for F-1, the defect that killed mx5 run 15.
 *
 * WHAT F-1 IS. worker:context is given tools `read,grep` ONLY (phases.ts:623): it cannot
 * call pi-worker-docs, pi-worker-fetch or pi-worker-search, so it cannot consult any
 * documentation. Nothing stops it writing an external-API claim anyway, and nothing checks
 * that a "per ... LIVE data" attribution corresponds to a real EXTERNAL CONTEXT block. In
 * run 15 it emitted, verbatim:
 *
 *   - The `hono` dependency is pinned at `^4.12.31` in package.json, and the external
 *     context confirms `hc<AppType>` pattern with base URL `/api` for same-origin
 *     relative paths works correctly (per Hono RPC docs LIVE data).
 *
 * The pinned version is genuinely from EXTERNAL CONTEXT. The base-URL semantics are from
 * model memory. Fusing them in one sentence under one attribution let the true half
 * launder the false half (F-1e). TASK_0027's spec promoted it to a hard requirement in
 * both CONSTRAINTS and ACCEPTANCE, the implementation obeyed it exactly, and every request
 * went to `/api/api/...` ⇒ 404 ⇒ 100% of the product's API surface dead.
 *
 * WHAT THIS PROBE MEASURES. How often the SHIPPED worker:context reproduces that shape,
 * live, on the real model. It is the baseline PROMPT 1's A/B must beat; PROMPT 1 may not
 * be committed on an ABSTAIN, because an ABSTAIN means F-1's mechanism was never
 * exercised and has to be re-derived.
 *
 * SEAM — the real phaseResearch, not a reconstruction. RESEARCH_CONTEXT_PROMPT and
 * gatherExternalContext are module-private, so rebuilding the prompt inside scripts/ would
 * hold a copy that silently drifts from what ships. phaseResearch IS exported, so the
 * probe runs it whole and parses the CONTEXT section out. The cost is that all four
 * research workers run, not just the one under test; the benefit is that the prompt, the
 * EXTERNAL CONTEXT and the tool restriction are all exactly what production uses.
 *
 * FIXTURE — the run's own tree at the moment TASK_0027's research ran. mx5 commit
 * 4b9827d is literally `chore: checkpoint before "Client API module — typed hono/client
 * hc<AppType> with fetch hooks"`, i.e. the pre-TASK_0027 state, extracted with
 * `git archive` into a writable copy. mx5 itself is evidence and is never written to.
 * Using HEAD instead would be wrong: src/client/api.ts would already exist and one of the
 * bullets the worker emits is precisely that it does not.
 *
 * METRIC — mechanical and deterministic, never the model's self-report:
 * findUnsourcedAttributions (src/task/context-attribution.ts, unit-tested against the real
 * run-15 bullets including three legitimate ones that must not flag) run over the emitted
 * CONTEXT text against the EXTERNAL CONTEXT that worker actually received. A bullet is a
 * HIT iff it carries an attribution cue AND asserts API usage semantics AND no `### url:`
 * or `### docs:` block exists for a package it names. An `### npm:` block cannot source
 * a semantics claim — that asymmetry IS the laundering mechanism.
 *
 * KNOWN LIMITATION OF THE RECORDED BASELINE (2/8, 2026-07-22). The `external` string this
 * probe passes to the detector is computed as `research.slice(0, research.indexOf('FILES'))`
 * below — and the assembled research text STARTS with "FILES", so that slice is always the
 * empty string. Every recorded rep therefore scored against ZERO blocks, i.e. the detector
 * in its most aggressive mode. The number is still a valid baseline (block kinds cannot
 * change a verdict when there are no blocks) and it is still comparable to a treatment arm
 * scored the same way, but it is NOT a measurement of the shipped in-phase post-check,
 * which is handed the real EXTERNAL CONTEXT. Recovering the real header requires
 * phaseResearch to return or persist it; it does neither today.
 *
 * Run (PI_BIN mandatory — an unset PI_BIN self-spawns a fork bomb):
 *   PI_BIN=$(command -v pi) bun run scripts/live-context-attribution-probe.ts [REPS]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// IMPORTED FROM dist/, NOT src/ — deliberate, and required.
//
// phaseResearch hands its APIS worker DOCS_EXTENSION_PATH, computed as
// `new URL('../workers/docs-extension.js', import.meta.url)` (phases.ts:326). Imported
// from src/ under `bun run`, that resolves to src/workers/docs-extension.js — which does
// not exist, since only the .ts does — and every rep dies with "Extension path does not
// exist". Imported from dist/ it resolves to dist/workers/docs-extension.js, which is
// exactly what pi loads in production. So this is the more faithful seam, not a
// workaround. Run `bun run build` first; a stale dist measures stale code.
import {phaseResearch} from '../dist/task/phases.js'
import type {PhaseDeps} from '../dist/task/child-runner.js'
// Promoted into src/ by PROMPT 1 (it is now a shipped gate, not just a probe metric), so
// it is imported from dist/ like phaseResearch above — same build, same code as ships.
import {findUnsourcedAttributions} from '../dist/task/context-attribution.js'
import {REFINED_27, PRE_TASK_0027, buildPreTask27Tree} from './run15-fixture-tree.js'
import {reportArm, type Invariant} from './ab-verdict.js'

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error(
        'REFUSING TO RUN: PI_BIN is unset. An unset PI_BIN makes the child re-invoke '
            + 'this harness instead of pi — a fork bomb that has crashed this machine twice.\n'
            + 'Run as: PI_BIN=$(command -v pi) bun run scripts/live-context-attribution-probe.ts'
    )
    process.exit(1)
}

const REPS = Number(process.argv[2] ?? '8')
const ROOT = path.join(os.homedir(), 'tmp', 'context-attribution-probe')
const TRIAL_TIMEOUT_MS = 45 * 60_000

/** The dependency names a bullet may name, read from the fixture's own manifest. */
function packagesOf(dir: string): string[] {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }
        return [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {})
        ]
    } catch {
        return []
    }
}

/** Pull one section's body out of the assembled research text. */
function section(research: string, name: string): string {
    const re = new RegExp(`^${name}\\s*$`, 'm')
    const m = re.exec(research)
    if (!m) return ''
    const start = m.index + m[0].length
    const rest = research.slice(start)
    const next = /^(FILES|APIS|CONTEXT|TOOLING|VERIFIED-TOOLING)\s*$/m.exec(rest)
    return next ? rest.slice(0, next.index) : rest
}

async function main(): Promise<void> {
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error(
            'FATAL: llama-server @ 127.0.0.1:8080 not reachable. '
                + 'Start it with ~/hub/qwen/run-Q3.6-27B.sh.'
        )
        process.exit(1)
    }

    console.log(
        `live-context-attribution-probe — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
            + `fixture mx5@${PRE_TASK_0027} (pre-TASK_0027 tree), ${REPS} reps, real phaseResearch`
    )

    let hits = 0
    let completed = 0
    let bulletTotal = 0
    let sourcedTotal = 0
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
            // The EXTERNAL CONTEXT this worker received is the head of the assembled
            // research prompt; phaseResearch does not return it, so it is recovered from
            // the persisted task file where the run records what it gathered.
            const external = research.slice(0, research.indexOf('FILES'))
            const pkgs = packagesOf(dir)
            const findings = findUnsourcedAttributions(context, external, pkgs)

            completed++
            bulletTotal += bullets
            sourcedTotal += bullets - findings.length
            if (findings.length > 0) hits++

            fs.writeFileSync(
                path.join(dir, 'result.json'),
                JSON.stringify({research, context, external, findings}, null, 2),
                'utf8'
            )
            rows.push({trial: t, bullets, findings: findings.map(f => f.bullet)})
            console.log(
                `  trial ${t}/${REPS}  bullets=${bullets}  unsourced-attributions=${findings.length}`
                    + `  [${((Date.now() - started) / 60000).toFixed(1)}m]`
            )
            for (const f of findings) {
                console.log(`      HIT [${f.unsourced.join(',')}] ${f.bullet.slice(0, 150)}`)
            }
        } catch (e) {
            console.log(`  trial ${t}/${REPS}  ERROR: ${String(e).slice(0, 200)}`)
        } finally {
            clearTimeout(timer)
        }
        fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(rows, null, 1), 'utf8')
    }

    const invariants: Invariant[] = [
        {
            label: 'reps >= 8 — the floor for a model-variable seam',
            ok: REPS >= 8,
            detail: `${REPS} reps`
        },
        {
            // A worker silenced into emitting nothing is a regression, not a baseline.
            label: 'CONTEXT is non-empty — a silent worker measures nothing',
            ok: completed === 0 || bulletTotal > 0,
            detail: `${bulletTotal} bullets across ${completed} completed rep(s)`
        },
        {
            label: 'legitimately-sourced bullets dominate (detector is not flagging everything)',
            ok: bulletTotal === 0 || sourcedTotal > bulletTotal * 0.5,
            detail: `${sourcedTotal}/${bulletTotal} bullets unflagged`
        }
    ]

    reportArm({
        name: 'live-context-attribution-probe',
        arm: 'baseline/worker:context',
        reps: REPS,
        targetShape:
            'a CONTEXT bullet asserting external API usage semantics under an attribution '
            + 'cue ("per ... LIVE data", "the external context confirms") that no EXTERNAL '
            + 'CONTEXT url/service block can support — the F-1 laundering shape',
        hits,
        // Precondition: research completed and produced a CONTEXT section to judge.
        witnessed: completed,
        expect: 'some',
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
