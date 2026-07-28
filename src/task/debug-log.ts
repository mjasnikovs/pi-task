/**
 * One place that decides whether a `.pi-tasks/*-debug.log` line gets written.
 *
 * THE TRAIL IS WRITE-ONLY. Nothing in pi-task reads these files back: `task-io.ts`
 * globs `TASK_NNNN.md` and skips everything else, and auto-commit's `snapshotTrail`
 * copies the bytes across a `reset --hard` without ever parsing them. Every producer
 * is a `logDebug?.(…)` / `log(…)` side effect whose return value is discarded. So
 * this gate cannot change what a run DOES — only what it can explain afterwards.
 *
 * TWO KINDS OF LINE, and the distinction is the whole point of having three levels
 * rather than a boolean:
 *
 *   'stream' — what the child model said, and what its tools returned. Reproducible
 *              by re-running, useful while you are actively debugging, and 85% of the
 *              bytes (measured: a 247 KB IAR1 `verify-debug.log` is 1315 lines, of
 *              which 521 are `↳` tool dumps and most of the rest is raw model text).
 *
 *   'event'  — a decision or a guard action: which phase started, why a worker was
 *              retried or degraded, what the git-state guard restored, what a
 *              write-capable child changed on disk, why a gate returned FAIL. Ten-ish
 *              lines per task, and NOT reproducible — it is the only record that the
 *              guard fired at all. mx5 run 11's final-fix child deleted a source file
 *              and the `tree changes:` line is the reason anyone could tell.
 *
 * Hence the default is `events`, not `off`: the quiet default users want costs the
 * chatter, not the audit trail.
 */
import * as fsp from 'node:fs/promises'
import {getConfig, sanitizeDebugLogs, type DebugLogLevel} from '../config/config.js'

/**
 * Escape hatch for reproducing a user's bug without walking them through
 * /task-config. Follows the existing `PI_TASK_*` instrumentation convention
 * (`PI_TASK_TYPEONLY_LOG`, `PI_REMOTE_PUSH_DEBUG`). An unrecognised value is
 * ignored rather than treated as `off` — a typo in an env var must not silently
 * throw the trail away.
 */
export const DEBUG_LOG_ENV = 'PI_TASK_DEBUG_LOG'

/** A trail line's kind — see the module note. Producers default to `'event'`. */
export type DebugLine = 'event' | 'stream'

/**
 * The level in force: env override first, then the saved config. Read per call
 * rather than cached, so flipping the setting mid-run takes effect on the next
 * line instead of at the next restart.
 */
export function debugLogLevel(
    getEnv: (k: string) => string | undefined = k => process.env[k]
): DebugLogLevel {
    const raw = getEnv(DEBUG_LOG_ENV)?.trim()
    // sanitizeDebugLogs falls back to the DEFAULT for anything unrecognised, so
    // an unset/typo'd var must be filtered out here rather than handed to it —
    // otherwise `PI_TASK_DEBUG_LOG=verbose` would quietly override a saved `off`.
    if (raw && sanitizeDebugLogs(raw) === raw) return raw as DebugLogLevel
    return getConfig().debugLogs
}

/** Whether a line of this kind should be written at `level`. */
export function shouldLogDebug(kind: DebugLine, level: DebugLogLevel): boolean {
    if (level === 'off') return false
    if (level === 'full') return true
    return kind === 'event'
}

/**
 * A timestamped fire-and-forget appender for one trail file, level-gated.
 *
 * `kind` defaults to `'event'` so a new call site is quiet-by-default in the
 * useful direction: forgetting to classify a marker keeps it in the audit trail,
 * whereas forgetting to classify chatter would only make the log bigger. Errors
 * are swallowed — an unwritable trail must never fail the run it is describing.
 */
export function makeDebugAppender(
    logPath: string,
    appendFile: (p: string, data: string) => Promise<unknown> = (p, data) => fsp.appendFile(p, data)
): (msg: string, kind?: DebugLine) => void {
    return (msg: string, kind: DebugLine = 'event') => {
        if (!shouldLogDebug(kind, debugLogLevel())) return
        void appendFile(logPath, `${new Date().toISOString()} ${msg}\n`).catch(() => {})
    }
}

/**
 * Wrap a raw append in the level gate. Returns `undefined` when the level is
 * `off`, so callers that hold an OPTIONAL `logDebug` leave it unset and every
 * `logDebug?.(…)` in the pipeline short-circuits before it formats a string.
 */
export function gateDebugWriter(
    write: (msg: string) => void,
    getEnv?: (k: string) => string | undefined
): ((msg: string, kind?: DebugLine) => void) | undefined {
    if (debugLogLevel(getEnv) === 'off') return undefined
    return (msg: string, kind: DebugLine = 'event') => {
        if (shouldLogDebug(kind, debugLogLevel(getEnv))) write(msg)
    }
}
