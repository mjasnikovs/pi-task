/**
 * Per-test timeout for `bun test`, as a preload.
 *
 * WHY: bun's default is 5000ms, which is a process-start budget, not a test
 * budget. A test that spawns a real subprocess pays the runner's cold-start
 * cost — shell, node, whatever scanner sits in front of them — and that cost
 * can land on the wrong side of 5s while nothing about the test is wrong.
 *
 * pi is one such spawner. `DefaultPackageManager.getNpmInstallPath` falls back
 * to `getGlobalNpmRoot()` when a user-scope package's managed install dir does
 * not exist, and that runs `npm root -g` through spawnSync — synchronously,
 * inside whatever test touched it. Many test files here spawn subprocesses, so
 * patching them one at a time as each crosses the line is whack-a-mole.
 *
 * 30s is not a licence to be slow: a genuine hang is still caught by the CI
 * Test step's own timeout, which is what keeps the log alive for the workflow's
 * survivor-diagnosis steps. This only stops a runner's cold-start tax from
 * reading as a test failure.
 */
import {setDefaultTimeout} from 'bun:test'

setDefaultTimeout(30_000)
