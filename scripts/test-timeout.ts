/**
 * Per-test timeout for `bun test`, as a preload.
 *
 * WHY: bun's default is 5000ms, and that is a Windows-CI tripwire, not a real
 * budget. Two Windows jobs died on it in two days, in different files, and
 * neither on an assertion:
 *
 *   0.38.15  git-state-guard.test.ts   — 3 tests, SIGTERM inside `git commit`
 *   0.38.16  extension-list.test.ts    — 1 test at 8553ms, in `npm root -g`
 *
 * Both are the same class. The test spawns a real subprocess, the Windows
 * runner pays cmd.exe + node startup + a Defender scan for it, and the cost
 * lands on the wrong side of 5s. Measured here: pi's DefaultPackageManager
 * runs `npm root -g` SYNCHRONOUSLY whenever a configured package's install dir
 * is missing (confirmed with a PATH shim — one invocation, `npm root -g`), and
 * 22 test files in this repo spawn subprocesses. Patching them one at a time as
 * each one crosses the line is whack-a-mole.
 *
 * 30s is not a licence to be slow: the whole suite runs in ~30s locally and
 * ~3min on Windows CI, and a genuine hang is still caught by the Test step's
 * 10-minute timeout, which is what preserves the log for the survivor probes.
 * This only stops a runner's cold-start tax from reading as a test failure.
 */
import {setDefaultTimeout} from 'bun:test'

setDefaultTimeout(30_000)
