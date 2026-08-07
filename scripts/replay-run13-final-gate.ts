/**
 * Run-13 replay for the final-gate AGGREGATION fix (nexttask PROMPT 1) —
 * deterministic, NO model involved (the seam is the gate's own control flow).
 *
 * Reproduces the mx5 run of 2026-07-16→17 (gates trail 08:24:22 → 08:40:58):
 * `bun run test` failed first (bun's glob ingested playwright .spec files), the
 * gate early-returned, and the boot + render probe — which would have shown the
 * app 404ing on every non-API GET (no index.html producer anywhere) — never
 * executed in ANY attempt. The user accepted the FAIL having seen only 1 failing
 * CT test.
 *
 * Fixture (fresh dir per arm): package.json with a hono dep (detectsServedApp),
 * a test script that fails with the playwright-glob wording, a start script that
 * stays alive; injected BootDeps fake the listener + a render probe that 404s —
 * exactly the unit-test seam, so both arms exercise identical inputs.
 *
 * Arms:
 *   baseline  — final-gate.ts as of the commit BEFORE the aggregation landed
 *               (f905a5a^, resolved by baselineRef — NOT `HEAD`; see below),
 *               imported from a
 *               throwaway worktree: expect FAIL showing ONLY the test failure.
 *   treatment — the working tree's final-gate.ts: expect FAIL with BOTH
 *               failures, the boot/render failure ranked FIRST.
 *
 * Ground truth is the returned outcome object (reason text + failures list) —
 * an artifact of real script exit codes, never self-report.
 *
 * Run: bun run scripts/replay-run13-final-gate.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TMP_ROOT = '/home/edgars/tmp'
const REPO = path.resolve(import.meta.dir, '..')

function makeFixture(): string {
    const dir = fs.mkdtempSync(path.join(TMP_ROOT, 'run13-replay-'))
    fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify(
            {
                name: 'run13-fixture',
                dependencies: {hono: '^4'},
                scripts: {
                    test: 'echo "error: playwright .spec files picked up by bun test — 63 errors" && exit 1',
                    start: 'node -e "setTimeout(()=>{},600000)"'
                }
            },
            null,
            2
        )
    )
    return dir
}

const bootDeps = {
    groupHasListener: () => true,
    groupListeningPort: () => 3000,
    renderProbe: () => ({
        outcome: 'fail' as const,
        detail: 'GET / responded 404 — no index.html is served (the SPA fallback file does not exist)'
    })
}

interface Outcome {
    ok: boolean
    reason: string
    failures?: string[]
}

async function runArm(label: string, modulePath: string): Promise<Outcome> {
    const mod = (await import(modulePath)) as {
        runFinalIntegrationGate: (
            cwd: string,
            timeoutMs?: number,
            bootGraceMs?: number,
            deps?: object
        ) => Promise<Outcome>
    }
    const dir = makeFixture()
    try {
        const out = await mod.runFinalIntegrationGate(dir, 120_000, 5_000, bootDeps)
        console.log(`\n=== ${label} ===`)
        console.log(`ok: ${out.ok}`)
        console.log(`failures field: ${out.failures ? JSON.stringify(out.failures, null, 2) : '(absent)'}`)
        console.log(`reason:\n${out.reason}`)
        return out
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

/**
 * The commit BEFORE the aggregation landed, located by when `failures?: string[]`
 * was added to FinalGateOutcome — so the ref stays correct as history grows.
 */
function baselineRef(): string {
    const out = execFileSync(
        'git',
        ['log', '--format=%H', '-S', 'failures?: string[]', '--', 'src/task/final-gate.ts'],
        {cwd: REPO, encoding: 'utf8'}
    )
    const sha = out.trim().split('\n').filter(Boolean).pop()
    if (!sha) throw new Error('cannot locate the commit that added the aggregated failures field')
    return `${sha}^`
}

async function main(): Promise<void> {
    fs.mkdirSync(TMP_ROOT, {recursive: true})
    // Baseline: the PRE-AGGREGATION final-gate in a throwaway worktree (relative
    // imports resolve inside it, so the whole pre-change module graph is
    // exercised).
    //
    // NOT `HEAD`. This script originally checked out HEAD, which was correct only
    // while the aggregation fix was uncommitted: the moment it landed, HEAD became
    // the fix, the baseline arm started reporting BOTH failures, and
    // "baseline shadows the boot/render failure" has been false ever since —
    // verified by running this script unchanged at 5a01246, before nexttask 15
    // touched anything. A baseline ref that moves with the fix is not a baseline.
    const ref = baselineRef()
    const wt = fs.mkdtempSync(path.join(TMP_ROOT, 'run13-baseline-wt-'))
    execFileSync('git', ['worktree', 'add', '--detach', wt, ref], {cwd: REPO, stdio: 'pipe'})
    try {
        const base = await runArm(`BASELINE (${ref})`, path.join(wt, 'src/task/final-gate.ts'))
        const treat = await runArm('TREATMENT (working tree)', path.join(REPO, 'src/task/final-gate.ts'))

        const baseShowsBoot = /boot check/.test(base.reason)
        const treatTexts = treat.failures ?? []
        const bothPresent =
            treatTexts.some(t => /boot check/.test(t) && /404/.test(t))
            && treatTexts.some(t => /`bun run test` exited 1/.test(t))
        const bootFirst = /boot check/.test(treatTexts[0] ?? '')

        console.log('\n=== VERDICT ===')
        console.log(`baseline FAILs: ${!base.ok} (expected true)`)
        console.log(`baseline shadows the boot/render failure: ${!baseShowsBoot} (expected true)`)
        console.log(`treatment carries BOTH failures: ${bothPresent} (expected true)`)
        console.log(`treatment ranks the render failure FIRST: ${bootFirst} (expected true)`)
        const pass = !base.ok && !baseShowsBoot && !treat.ok && bothPresent && bootFirst
        console.log(pass ? '\nREPLAY: PASS' : '\nREPLAY: FAIL')
        process.exitCode = pass ? 0 : 1
    } finally {
        execFileSync('git', ['worktree', 'remove', '--force', wt], {cwd: REPO, stdio: 'pipe'})
    }
}

void main()
