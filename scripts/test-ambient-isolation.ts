/**
 * Cuts `bun test` off from the developer's own machine state, as a preload.
 *
 * WHY: two ambient channels reach production code at import time, and both make
 * a green CI run and a red local run mean nothing.
 *
 *   1. `src/config/config.ts` reads `~/.config/pi-task/config.json` on module
 *      eval. CI has no such file, so CI always saw DEFAULT_CONFIG. A developer
 *      with `"debugLogs": "off"` saved from /task-config failed 12 tests in
 *      auto-orchestrator.test.ts — the plan phase stopped writing the
 *      `plan-debug.log` those tests read back, so they died on ENOENT with no
 *      hint that a config file, not the code, was the cause.
 *   2. Every `PI_TASK_*` var is an instrumentation override that beats the
 *      saved config (see DEBUG_LOG_ENV, PROJECT_DOCS_BUDGET_ENV, and the rest).
 *      One left exported in a shell — the usual way to reproduce a user's bug —
 *      silently re-skews the next suite run in that terminal.
 *
 * Both are cleared here rather than per-file: any test that imports a module
 * that reads config or env is exposed, and that set only grows. A test that
 * WANTS a non-default value still sets it itself — the preload runs first, so a
 * deliberate `process.env.X = ...` inside a test file still wins.
 *
 * The config path is pointed at a name under the tmp dir that is never created,
 * so the load throws ENOENT and falls back to DEFAULT_CONFIG. Nothing is
 * written there unless a test calls saveConfig(), which then also stays out of
 * the developer's real config.
 */
import * as os from 'node:os'
import * as path from 'node:path'

for (const key of Object.keys(process.env)) {
    if (key.startsWith('PI_TASK_')) delete process.env[key]
}

process.env.PI_TASK_CONFIG_PATH = path.join(os.tmpdir(), 'pi-task-test-config-absent.json')
