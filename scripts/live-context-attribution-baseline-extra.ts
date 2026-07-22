/**
 * PROMPT 1 — EXTRA PRE-CHANGE BASELINE REPS, to give the A/B enough statistical power.
 *
 * WHY THIS EXISTS. The recorded pre-change baseline is 2/8 reps. Two hits is too few to
 * prove a reduction, however clean the treatment arm looks. Fisher's exact, one-tailed:
 *
 *     baseline 2/8  vs treatment 0/16   ->  p = 0.101   NOT significant
 *     baseline 2/8  vs treatment 0/32   ->  p = 0.036
 *     baseline 6/24 vs treatment 0/24   ->  p = 0.011
 *     baseline 8/32 vs treatment 0/32   ->  p = 0.002
 *
 * Extending the TREATMENT arm is the inefficient axis; enlarging the BASELINE is what buys
 * power, because the baseline's hit count is what the test is starved of. At the measured
 * p = 0.25, 16 more reps should add ~4 hits, taking the baseline to ~6/24.
 *
 * This is also exactly what nexxtasks' own PASS criterion misses: "baseline >= 1 hit AND
 * treatment 0" at 8 reps is satisfied by a do-nothing lever 10% of the time — the same
 * 0.101 above. This harness exists so PROMPT 1 can be judged at p < 0.05 instead.
 *
 * HOW THE PRE-CHANGE CODE IS OBTAINED. A git worktree pinned at the pre-change commit
 * (`git worktree add /tmp/pre-change HEAD`, verified to contain neither the API-semantics
 * prompt rule nor the post-check), built to its own dist/. phaseResearch is imported from
 * THAT dist, so the code under test is genuinely the old behaviour — not the new code with
 * a flag flipped, which is a different and weaker claim.
 *
 * SCORING IS IDENTICAL to the recorded baseline and to the treatment arm: the same
 * findUnsourcedAttributions, against the same empty external-context slice (see
 * live-context-attribution-ab.ts's header for why that slice is empty and why it biases
 * toward FAIL, never toward a false pass). Only the code under test differs.
 *
 * Run AFTER the treatment A/B finishes — one GPU slot, PARALLEL=1:
 *   PI_BIN=$(command -v pi) bun run scripts/live-context-attribution-baseline-extra.ts [REPS]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// The PRE-CHANGE build, from the pinned worktree. Not this repo's dist/.
import {phaseResearch} from '/tmp/pre-change/dist/task/phases.js'
import type {PhaseDeps} from '../dist/task/child-runner.js'
// Scoring comes from the CURRENT tree so both arms are scored by identical code.
import {findUnsourcedAttributions} from '../dist/task/context-attribution.js'
import {REFINED_27, buildPreTask27Tree} from './run15-fixture-tree.js'
import {reportArm, type Invariant} from './ab-verdict.js'

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error('REFUSING TO RUN: PI_BIN is unset (fork-bomb guard).')
    process.exit(1)
}

const REPS = Number(process.argv[2] ?? '16')
const ROOT = path.join(os.homedir(), 'tmp', 'context-attribution-baseline-extra')
const TRIAL_TIMEOUT_MS = 45 * 60_000

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
    // Guard: if the worktree ever drifts forward, this harness silently stops being a
    // baseline. Assert the code under test really lacks the lever.
    const preChangePhases = fs.readFileSync('/tmp/pre-change/dist/task/phases.js', 'utf8')
    if (preChangePhases.includes('demoteUnsourcedAttributions')) {
        console.error(
            'REFUSING TO RUN: /tmp/pre-change/dist contains the post-check — it is NOT the '
                + 'pre-change build, so it cannot serve as a baseline.'
        )
        process.exit(1)
    }

    console.log(
        `live-context-attribution-baseline-extra — PRE-CHANGE code, ${REPS} reps\n`
            + `phaseResearch from /tmp/pre-change/dist (no belt, no braces), scored by current detector`
    )

    let hits = 0
    let completed = 0
    let bulletTotal = 0
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
            const external = research.slice(0, research.indexOf('FILES'))
            const found = findUnsourcedAttributions(context, external, packagesOf(dir))
            completed++
            bulletTotal += bullets
            if (found.length > 0) hits++
            rows.push({rep: t, bullets, hits: found.map(f => f.bullet)})
            console.log(
                `  rep ${t}/${REPS}  bullets=${bullets}  unsourced=${found.length}`
                    + `  [${((Date.now() - started) / 60000).toFixed(1)}m]`
            )
            for (const f of found) console.log(`      HIT ${f.bullet.slice(0, 140)}`)
        } catch (e) {
            console.log(`  rep ${t}/${REPS}  ERROR: ${String(e).slice(0, 160)}`)
        } finally {
            clearTimeout(timer)
        }
        fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(rows, null, 1), 'utf8')
    }

    console.log(`\nPRE-CHANGE baseline: ${hits}/${completed} reps exhibited the F-1 shape`)
    console.log(`COMBINED with the recorded 2/8: ${hits + 2}/${completed + 8}`)

    const invariants: Invariant[] = [
        {
            label: 'code under test is genuinely pre-change (asserted, not assumed)',
            ok: !preChangePhases.includes('demoteUnsourcedAttributions'),
            detail: 'no post-check in /tmp/pre-change/dist'
        },
        {
            // The baseline must be drawn from a worker behaving normally. If CONTEXT
            // collapsed here, the low hit rate would be an artefact of a broken fixture
            // rather than a property of the pre-change code.
            label: 'CONTEXT did not collapse — bullets/rep >= 8 (recorded pre-change mean 13)',
            ok: completed === 0 || bulletTotal / completed >= 8,
            detail: `${(bulletTotal / Math.max(1, completed)).toFixed(1)} bullets/rep`
        }
    ]

    reportArm({
        name: 'live-context-attribution-baseline-extra',
        arm: 'baseline/pre-change',
        reps: completed,
        targetShape: 'the F-1 laundering shape in an emitted CONTEXT bullet (pre-change code)',
        hits,
        witnessed: completed,
        expect: 'some',
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
