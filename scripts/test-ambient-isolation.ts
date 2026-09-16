/**
 * Cuts `bun test` off from the developer's own machine state, as a preload.
 *
 * WHY: two ambient channels reach production code at import time, and both make
 * a green CI run and a red local run mean nothing.
 *
 *   1. `src/config/config.ts` reads `~/.config/pi-task/config.json` on module
 *      eval. A machine with `"debugLogs": "off"` saved from /task-config turns
 *      the plan phase's `plan-debug.log` off, and the tests in
 *      auto-orchestrator.test.ts that read that file back die on ENOENT — with
 *      no hint that a config file, not the code, was the cause.
 *   2. A `PI_TASK_*` var is an instrumentation override; `PI_TASK_DEBUG_LOG` is
 *      read before the saved config, so it decides the level outright. One left
 *      exported in a shell — the usual way to reproduce a user's bug — silently
 *      re-skews the next suite run in that terminal.
 *
 * Both are cleared here rather than per-file: any test that imports a module
 * which reads config or env is exposed. A test that WANTS a non-default value
 * still sets it itself — the preload runs first, so a deliberate
 * `process.env.X = ...` inside a test file still wins.
 *
 * The config path is pointed at a name under the tmp dir that is never created,
 * so the load throws ENOENT and falls back to DEFAULT_CONFIG. Nothing is
 * written there unless a test calls saveConfig(), which then also stays out of
 * the developer's real config.
 *
 * The third channel writes rather than reads: `task/state-dir.ts` puts a run's
 * debug logs under `$XDG_STATE_HOME`, so an unredirected suite would litter — and
 * `pruneRunLogs` would DELETE — the developer's own `~/.local/state/pi-task`.
 * Redirected per process rather than per file so concurrent suite runs cannot
 * prune each other, and swept on exit so it does not become the next `/tmp`
 * inode leak (see test-utils/tmp-dir.ts).
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

for (const key of Object.keys(process.env)) {
    if (key.startsWith('PI_TASK_')) delete process.env[key]
}

process.env.PI_TASK_CONFIG_PATH = path.join(os.tmpdir(), 'pi-task-test-config-absent.json')

const stateHome = path.join(os.tmpdir(), `pi-task-test-state-${process.pid}`)
process.env.XDG_STATE_HOME = stateHome
// `--isolate` re-evaluates this preload for every test file; the sweep and the
// exit hook belong to the process, not to the file that happened to load first.
const g = globalThis as {__piTaskTestStateSwept?: boolean}
if (!g.__piTaskTestStateSwept) {
    g.__piTaskTestStateSwept = true
    fs.rmSync(stateHome, {recursive: true, force: true})
    process.once('exit', () => {
        try {
            fs.rmSync(stateHome, {recursive: true, force: true})
        } catch {
            // A state dir still held open must never fail a green run.
        }
    })
}
