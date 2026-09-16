/**
 * One place that decides whether a `*-debug.log` line gets written, and what
 * reaches the file when it does. The files live in the run's state directory
 * (state-dir.ts), outside the repository.
 *
 * THE TRAIL IS WRITE-ONLY in production. Nothing under src/ reads these files
 * back: `task-io.ts` globs `TASK_NNNN.md` and skips everything else, and
 * auto-commit's `snapshotTrail` copies `.pi-tasks/` across a `reset --hard`
 * without ever parsing it. Every producer is a `logDebug?.(…)` / `log(…)` side
 * effect whose return value is discarded. So this gate cannot change what a run
 * DOES — only what it can explain afterwards. (Tests do read the trail back,
 * which is why `flushPlanDebug` exists.)
 *
 * TWO KINDS OF LINE, and the distinction is the whole point of having three levels
 * rather than a boolean:
 *
 *   'stream' — what the child model said, and what its tools returned. It is the
 *              bulk of the bytes by a wide margin, and it is REPRODUCIBLE: re-run
 *              the child and you get it again. Useful while actively debugging,
 *              worthless as a record.
 *
 *   'event'  — a decision or a guard action: which phase started, why a worker was
 *              retried or degraded, what the git-state guard restored, what a
 *              write-capable child changed on disk, why a gate returned FAIL. A
 *              handful of lines per task, and NOT reproducible — it is the only
 *              record that the guard fired at all. If a final-fix child deletes a
 *              source file, the `tree changes:` line is the only way anyone can
 *              tell.
 *
 * Hence the shipped default is `events`, not `off` (DEFAULT_DEBUG_LOGS in
 * config.ts): the quiet default users want costs the chatter, not the audit trail.
 * A machine-local `"debugLogs": "off"` still wins — this is a default, not a floor.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {getConfig, sanitizeDebugLogs, type DebugLogLevel} from '../config/config.js'

/**
 * Escape hatch for reproducing a user's bug without walking them through
 * /task-config. Follows the `PI_TASK_*` instrumentation convention this codebase
 * already uses in nine places, `PI_TASK_TYPEONLY_LOG` among them.
 *
 * An unrecognised value is IGNORED rather than treated as `off` — a typo in an env
 * var must not silently throw the trail away. Run: `full` and `off` both take
 * effect, surrounding whitespace is tolerated, and `verbose` falls through to the
 * saved config instead of resolving to anything.
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

/** Whether a line of this kind should be written at `level`. The whole matrix:
 *  `off` writes nothing, `full` writes both kinds, `events` writes events and
 *  drops stream. */
export function shouldLogDebug(kind: DebugLine, level: DebugLogLevel): boolean {
    if (level === 'off') return false
    if (level === 'full') return true
    return kind === 'event'
}

/**
 * Longest line the trail keeps. A tool result the child pasted whole, a minified
 * bundle, a base64 blob — one of them can be most of the file, and past a
 * paragraph or so nothing is being explained any more. The overflow is reported
 * rather than dropped silently, so a truncated line still says it was truncated.
 */
export const DEBUG_LINE_LIMIT = 4096

const CONTROL_CHARS = /\p{Cc}/gu

function capLine(line: string): string {
    const over = line.length - DEBUG_LINE_LIMIT
    return over > 0 ? `${line.slice(0, DEBUG_LINE_LIMIT)}…+${over} chars` : line
}

/**
 * What actually reaches the file: control characters stripped, every line capped.
 *
 * One NUL makes the whole file BINARY to grep, and the trail's only job is to be
 * grepped — a 1.7 MB `verify-debug.log` full of terminal control bytes needed
 * `grep -a` before it could be read at all. Newlines are the exception and stay:
 * a multi-line message stays multi-line, with the timestamp on its first line.
 */
export function sanitizeDebugLine(msg: string): string {
    return msg
        .split('\n')
        .map(line => capLine(line.replace(CONTROL_CHARS, '')))
        .join('\n')
}

const ensuredDirs = new Map<string, Promise<unknown>>()

/** A run's state directory does not exist until its first line — mkdir once per
 *  directory rather than once per line. */
function ensureDir(dir: string): Promise<unknown> {
    let made = ensuredDirs.get(dir)
    if (!made) {
        made = fsp.mkdir(dir, {recursive: true}).catch(() => {})
        ensuredDirs.set(dir, made)
    }
    return made
}

async function appendToTrail(p: string, data: string): Promise<void> {
    await ensureDir(path.dirname(p))
    await fsp.appendFile(p, data)
}

/**
 * Timestamp, sanitise and append one trail line, fire-and-forget. Errors are
 * swallowed — an unwritable trail must never fail the run it is describing.
 *
 * An injected `appendFile` owns its own directory: a fake has none, and mkdir-ing
 * a test's imaginary path would write to the real filesystem.
 */
export function appendDebugLine(
    logPath: string,
    msg: string,
    appendFile: (p: string, data: string) => Promise<unknown> = appendToTrail
): void {
    const line = `${new Date().toISOString()} ${sanitizeDebugLine(msg)}\n`
    void appendFile(logPath, line).catch(() => {})
}

/**
 * A timestamped fire-and-forget appender for one trail file, level-gated.
 *
 * `kind` defaults to `'event'` so a new call site is quiet-by-default in the
 * useful direction: forgetting to classify a marker keeps it in the audit trail,
 * whereas forgetting to classify chatter would only make the log bigger.
 */
export function makeDebugAppender(
    logPath: string,
    appendFile: (p: string, data: string) => Promise<unknown> = appendToTrail
): (msg: string, kind?: DebugLine) => void {
    return (msg: string, kind: DebugLine = 'event') => {
        if (!shouldLogDebug(kind, debugLogLevel())) return
        appendDebugLine(logPath, msg, appendFile)
    }
}

/**
 * Wrap a raw append in the level gate. Returns `undefined` when the level is
 * `off`, so callers that hold an OPTIONAL `logDebug` leave it unset and every
 * `logDebug?.(…)` in the pipeline short-circuits before it formats a string.
 *
 * Run: undefined at `off`, a function otherwise, and at `events` it writes an
 * event line while dropping a stream one.
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
