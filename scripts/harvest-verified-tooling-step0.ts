/**
 * STEP 0 for the "harvest the run's own `## verified tooling` instead of guessing from a
 * hardcoded ecosystem allowlist" lever (nexttask.txt TASK 1, priority 1).
 *
 * *** THE PREMISE IS REFUTED. THE LEVER WAS NOT BUILT. READ THIS BEFORE RE-PROPOSING IT. ***
 *
 * The lever's target is real and is NOT in dispute: final-gate.ts `discoverIntegrationCommands`
 * resolves integration commands from a fixed manifest allowlist (package.json `test`/`test:*`/
 * `build`, Makefile, Cargo.toml, go.mod, pyproject.toml) and nothing else, so a project it does
 * not recognise falls through `no integration command found (statics passed)` — IAR1 (C++/CMake,
 * no package.json) shipped exactly that verdict TWICE while carrying open verify-FAIL debt
 * (.pi-tasks/TASK_AUTO_0001.md:31, TASK_AUTO_0002.md:37), and godot-engine's only package.json
 * script is `verify`, which matches neither `test*` nor `build`. Both confirmed here.
 *
 * What is refuted is the proposed SOURCE for the fix. `## verified tooling` is written by a
 * model and, despite its name, is not verified: it records commands that were never run, that
 * are missing required arguments, that name files which do not exist, and that reference
 * package scripts the manifest does not expose. Feeding it into the gate — which FAILS the run
 * on a non-zero exit — injects fabricated failures.
 *
 * MEASURED 2026-07-27 by this script (scratch clones: IAR1@6126ca5, mx5@373e88d, godot-engine
 * copied — it is not a git repo). Every number below is a recorded exit code, not an inference.
 *
 *   STEP 0 KILL CONDITION (from the task): "fewer than 2 distinct runnable execution-shaped
 *   commands can be harvested per project" => refuted.
 *     IAR1          0 runnable execution-shaped  => KILL CONDITION FIRES
 *     godot-engine  3 runnable execution-shaped  => clears
 *     mx5           4 runnable execution-shaped  (all `docker compose up` variants + a bare
 *                                                `bun build src/index.ts`; none is a test suite)
 *
 *   IAR1's harvest is `ctest`, `ctest --output-on-failure`, `cmake …` — all ENOENT today. They
 *   were runnable DURING the run (build/CMakeCache.txt, mtime 2026-07-14 23:34, records
 *   CMAKE_COMMAND=/usr/local/bin/cmake and CMAKE_CTEST_COMMAND=/usr/local/bin/ctest, cmake
 *   3.30.5); /usr/local/bin now holds only `mkinitcpio`. So IAR1's 0 is this box losing a
 *   toolchain, not proof the harvest is empty — which is why the SECOND refutation below, not
 *   the kill condition, is the one that actually decides this.
 *
 *   THE DECIDING MEASUREMENT — what the lever would do to godot-engine, the one project that
 *   clears the kill condition. Of its 14 distinct harvested lines, 12 survive shell-metacharacter
 *   rejection. Running them under final-gate's own runGateCommand contract:
 *      PASS (exit 0)   3   godot --headless -s addons/gut/gut_cmdln.gd -gdir=res://test -gexit
 *                          godot --headless --import --quit
 *                          godot --headless --import
 *      SKIP            2   gdlint … (ENOENT), and `godot --headless --check-only`, which was
 *                          still running when this rig's 45s probe cap killed it — under the
 *                          gate's real timeoutMs (final-gate.ts:1002, 900_000) that is 15
 *                          minutes of hang followed by a skip, observing nothing
 *      FAIL (exit 1)   8   and SIX of them are fabricated, verified by reading their output:
 *                            godot --headless --script res://tools/verify_scene.gd
 *                            godot --headless --script res://tools/run_checks.gd
 *                              -> both: {"status":"error","message":"No scene path provided.
 *                                 Usage: … res://<scene_path>"}. The command was recorded
 *                                 WITHOUT its required argument.
 *                            godot --headless -s gut/scripts/gut_test_suite.gd
 *                              -> "Attempt to open script 'res://gut/scripts/gut_test_suite.gd'
 *                                 resulted in error 'File not found'." The path does not exist;
 *                                 the real one is addons/gut/gut_cmdln.gd.
 *                            bun test            -> "0 test files matching …" (the project's
 *                                                   tests are GDScript under test/, not bun)
 *                            npx gdlint scripts/ -> npx cannot resolve the package
 *                            npx gdparse scripts/-> npm error, no such package
 *                          (`bun run build` and `bun run dev` — "Script not found" — are omitted
 *                          from the 6 because a script-existence filter can catch them.)
 *
 *   So the lever, applied to the only project that passed STEP 0, converts a PASS into a FAIL
 *   citing "No scene path provided", and adds ~15 minutes of hang. That is strictly worse than
 *   the status quo it replaces.
 *
 * WHY NO FILTER RESCUES IT. Every failure above except the two "Script not found" cases is
 * indistinguishable, BEFORE execution, from a genuine one:
 *   `godot --headless -s addons/gut/gut_cmdln.gd …` (real) and
 *   `godot --headless -s gut/scripts/gut_test_suite.gd` (fabricated path)
 * are the same binary, same flag, same shape. The only way to tell them apart is to run them —
 * and running them is what produces the false FAIL. A filter that could separate them would
 * have to know which paths are real for which tool, i.e. it would be the tool allowlist the
 * task explicitly rejects.
 *
 * WHAT TO DO INSTEAD. The defect (a static-only PASS standing in for a check that never ran) is
 * closed by nexttask.txt TASK 2 — zero-discovery must record UNOBSERVED rather than PASS — which
 * needs no untrusted command source and cannot inject a fabricated failure. Task 2 is the fix;
 * this was the wrong instrument for it.
 *
 * IF ANYONE ATTACKS THIS AGAIN, the target is the AUTHORING of `## verified tooling` (make the
 * run actually execute what it records there, and record the cwd and exit code alongside it),
 * not the consumption of it. A harvest source is only as good as its provenance, and this one
 * currently has none.
 *
 * Re-run (no model time, ~4 min; probes spawn real children, so use scratch clones):
 *   bun run scripts/harvest-verified-tooling-step0.ts <projectDir> [<projectDir> …]
 *   PROBE_TIMEOUT_MS=45000 bun run scripts/harvest-verified-tooling-step0.ts ~/scratch/godot-engine
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {resolveRunner, runnerEnv} from '../src/task/runner-resolve.js'

/** A `## verified tooling` body line that means "nothing was verified". */
const NOTHING_RE = /^\(?\s*(none|none verified|verification inconclusive|n\/?a)\s*\)?\.?$/i

/**
 * Pull the `## verified tooling` body out of one composed task spec. Section runs to the next
 * `## ` heading or EOF, matching how setTaskSection/parseVerifyBlock slice the same files.
 */
export function parseVerifiedTooling(spec: string): string[] {
    const m = spec.match(/^##[ \t]*verified tooling[ \t]*$([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/im)
    if (!m) return []
    const out: string[] = []
    for (const raw of m[1].split('\n')) {
        const line = raw
            .trim()
            .replace(/^[-*]\s+/, '')
            .replace(/^`+|`+$/g, '')
            .trim()
        if (!line || NOTHING_RE.test(line)) continue
        out.push(line)
    }
    return out
}

/** Harvest every task spec in a `.pi-tasks` dir → command line → how many tasks recorded it. */
export function harvestFromTasksDir(dir: string): Map<string, number> {
    const counts = new Map<string, number>()
    if (!existsSync(dir)) return counts
    const files = readdirSync(dir)
        .filter(f => /^TASK_(\d+|AUTO_\d+)\.md$/.test(f))
        .sort()
    for (const f of files) {
        for (const cmd of parseVerifiedTooling(readFileSync(path.join(dir, f), 'utf8'))) {
            counts.set(cmd, (counts.get(cmd) ?? 0) + 1)
        }
    }
    return counts
}

/**
 * Harvested lines are UNTRUSTED MODEL OUTPUT and must never reach a shell. Anything carrying a
 * shell metacharacter (`&&`, pipes, redirects, globs, quotes, substitution, `<placeholder>`) is
 * rejected outright rather than parsed — a rejected line is one the lever could not have run
 * anyway, and rejecting is the only safe reading of `cmake --preset <preset> && …`.
 */
export const SHELL_META_RE = /[;&|<>$`(){}[\]*?!\\'"~\n]/

/** Split a safe line into the [bin, args] shape final-gate's HealthCommand uses. */
export function tokenize(line: string): {bin: string; args: string[]} | null {
    if (SHELL_META_RE.test(line)) return null
    // `AGENT=1 bun test` needs an env channel runGateCommand does not have — reject, don't guess.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) return null
    const parts = line.split(/\s+/).filter(Boolean)
    if (parts.length === 0) return null
    return {bin: parts[0]!, args: parts.slice(1)}
}

/**
 * static-shaped (lint/format/parse-check only) vs execution-shaped (runs or builds the product).
 * Deliberately crude: STEP 0 only needs the execution-shaped count, and a crude rule that
 * over-counts execution-shaped is conservative against the kill condition.
 */
export function classifyShape(line: string): 'static' | 'execution' {
    return (
            /\b(lint|gdlint|gdformat|eslint|prettier|tsc|clang-format|gersemi|gdparse)\b|--check-only\b|--noEmit\b/i.test(
                line
            )
        ) ?
            'static'
        :   'execution'
}

/**
 * Mirrors final-gate.ts runGateCommand's outcome contract (spawn error / null status / 127 →
 * skip; other non-zero → fail; 0 → pass). Mirrored rather than imported because runGateCommand
 * is module-private; the ENV_GAP_OUTPUT_RE branch is omitted, which can only UNDER-count skips,
 * i.e. it cannot inflate the failure count this script reports.
 */
function probe(
    cwd: string,
    bin: string,
    args: string[],
    timeoutMs: number
): {outcome: 'skip' | 'pass' | 'fail'; status: number | null; ms: number; tail: string} {
    const runner = resolveRunner(bin)
    const started = Date.now()
    const r = spawnSync(runner.bin, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: runnerEnv(runner)
    })
    const ms = Date.now() - started
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
        .slice(-1)[0]
    if (r.error) return {outcome: 'skip', status: null, ms, tail: `spawn ${String(r.error)}`}
    if (r.status === null || r.status === 127) {
        return {outcome: 'skip', status: r.status, ms, tail: tail ?? ''}
    }
    if (r.status !== 0) return {outcome: 'fail', status: r.status, ms, tail: tail ?? ''}
    return {outcome: 'pass', status: 0, ms, tail: tail ?? ''}
}

function main(): void {
    const dirs = process.argv.slice(2)
    if (dirs.length === 0) {
        console.error(
            'usage: bun run scripts/harvest-verified-tooling-step0.ts <projectDir> [<projectDir> …]'
        )
        process.exit(2)
    }
    const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 45_000)
    for (const dir of dirs) {
        const counts = harvestFromTasksDir(path.join(dir, '.pi-tasks'))
        console.log(`\n########## ${dir} — ${counts.size} distinct harvested lines`)
        let runnableExecution = 0
        let fails = 0
        let hangs = 0
        for (const [line, n] of [...counts].sort((a, b) => b[1] - a[1])) {
            const shape = classifyShape(line)
            const tok = tokenize(line)
            if (!tok) {
                console.log(`  ${shape.padEnd(9)} ${String(n).padStart(2)}x  REJECTED-META   ${line}`)
                continue
            }
            const r = probe(dir, tok.bin, tok.args, timeoutMs)
            if (r.outcome === 'pass' && shape === 'execution') runnableExecution += 1
            if (r.outcome === 'fail') fails += 1
            if (r.outcome === 'skip' && r.status === null && r.ms >= timeoutMs) hangs += 1
            console.log(
                `  ${shape.padEnd(9)} ${String(n).padStart(2)}x  ${r.outcome.toUpperCase().padEnd(5)} ` +
                    `exit=${String(r.status).padEnd(5)} ${String(r.ms).padStart(6)}ms  ${line}` +
                    `${r.tail ? `   | ${r.tail.slice(0, 90)}` : ''}`
            )
        }
        console.log(
            `  >>> runnable execution-shaped = ${runnableExecution} ` +
                `(KILL CONDITION: < 2 ⇒ premise refuted for this project)`
        )
        console.log(
            `  >>> the gate would report ${fails} FAILURE(S) and hang on ${hangs} command(s) ` +
                `if these were fed to runGateCommand`
        )
    }
}

// Run only when invoked directly — importing this from the unit tests must not spawn anything.
// fileURLToPath, not URL.pathname: the latter yields `/C:/…` on Windows.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main()
