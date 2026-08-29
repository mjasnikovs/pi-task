import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {isSearchProvider, type SearchProvider} from '../workers/search-types.js'
import {
    DEFAULT_REASONING_TABLE,
    sanitizeReasoningLevels,
    sanitizeReasoningMode,
    type GroupSetting,
    type ReasoningGroup,
    type ReasoningMode
} from './reasoning.js'
import {DEFAULT_STREAM_INACTIVITY_MS} from '../shared/stream-watchdog.js'

export interface PiTaskConfig {
    remote: boolean
    autoCommit: boolean
    orientation: boolean
    enforceGuidelines: boolean
    verifyWork: boolean
    /**
     * Run the four research workers concurrently instead of one at a time
     * (task/phases.ts). DEFAULT OFF. Serial is also what lets a worker read the
     * sections finished before it — APIS builds on the FILES map, and gets
     * nothing under the parallel branch. Measure your own backend before
     * turning this on.
     */
    parallelResearchWorkers: boolean
    /**
     * Cache docs/search/fetch worker RESULTS for the duration of one /task-auto
     * run, so sibling tasks re-asking the same (package/url, query) reuse the
     * first pipeline's digest instead of re-fetching it. Per-run isolated,
     * external-only (project-source `.` lookups are excluded), success-only.
     *
     * DEFAULT ON. A hit replays the stored text byte for byte. The key is the
     * tool name plus the whole query — normalised for case and whitespace, so
     * two spellings of one question share a digest, and nothing else does.
     */
    researchCache: boolean
    /**
     * Which engine backs web search (pi-worker-search + freshness/enrichment).
     * `exa` and `ddg` need no API key; `brave` needs one (see
     * SEARCH_PROVIDER_KEY_ENV in workers/search-types.ts).
     * DEFAULT `exa` so search works out of the box with zero configuration.
     */
    searchProvider: SearchProvider
    /**
     * Absolute entry-point paths of host pi extensions to load into every child
     * pi session via explicit `-e` flags (GitHub issue #4: a provider registered
     * by an extension — e.g. pi-lmstudio — otherwise doesn't exist in children,
     * which then can't resolve the default model and demand OAuth/API keys).
     * Children keep `--no-extensions`, so discovery stays off and ONLY these
     * load — the whitelist is strictly additive. Entries whose file no longer
     * exists (extension uninstalled) are skipped at spawn time, never fatal.
     * DEFAULT empty: child isolation is unchanged until the user opts in via
     * /task-config, which enumerates the currently installed extensions.
     */
    extensionWhitelist: string[]
    /**
     * Wall-clock ceiling (ms) on a SINGLE tool execution before the command
     * watchdog steps in. pi's bash tool declares its `timeout` parameter as
     * "Timeout in seconds (optional, no default timeout)" and returns undefined
     * when it is absent, so a command the model didn't bound runs forever. This
     * is the missing default.
     *
     * ONE knob, TWO surfaces (shared/command-watchdog.ts): in the MAIN session
     * the overrun fires ctx.abort(), which ends the whole agent operation — pi's
     * bash tool answers that signal by killing the command's entire process
     * tree — followed by an auto-reminder turn; in the verify/fix GATE children
     * (gate-deps.ts) the child is killed and re-spawned with a hint, the ceiling
     * halving per prior hang. 0 = off — which unguards BOTH surfaces, gates
     * included. Tool-agnostic: it arms on any tool execution.
     *
     * The default is a compromise: it has to outlast a real build or test suite
     * on the slowest machine you run this on, and still end a true hang.
     */
    requestTimeoutMs: number
    /**
     * Tools the generic command watchdog must NOT arm on, by exact name — for
     * tools that own a stronger, domain-specific timeout and cancellation
     * contract of their own and would otherwise be aborted mid-transaction at
     * the generic ceiling. `bash` and every unlisted tool stay guarded.
     *
     * Stored as the EXEMPTIONS, not the guarded set, so the default (`[]`) and
     * every tool pi-task has never seen are guarded — a new or renamed tool can
     * never silently lose its watchdog.
     *
     * Populated from `/task-config`'s `watch:` rows, which are discovered from
     * the live session via `pi.getAllTools()` (see config/tool-list.ts), so the
     * names here are pi's own and never hand-typed. A stale entry left behind by
     * an uninstalled tool matches nothing and is harmless.
     */
    commandTimeoutExemptTools: string[]
    /**
     * Inactivity ceiling (ms) on the MODEL STREAM before the stream watchdog
     * aborts the request (shared/stream-watchdog.ts). A hung or silently-dropped
     * stream throws nothing, so neither the connection-error retry (needs a
     * reported error) nor the command watchdog (covers tool calls only) nor the
     * child stall guard (a reachable endpoint is proof of life) can see it. The
     * server stays healthy the whole time; only the stream is gone.
     *
     * Measured as time since the LAST stream event of any kind, so a model that
     * is merely slow is never touched however slow it is; only total silence
     * counts. Suspended between `tool_execution_start` and the last call
     * settling — that window belongs to the command watchdog.
     *
     * ONE knob, TWO surfaces: the MAIN session aborts the turn through the same
     * plumbing the command watchdog uses and posts a resume reminder; a CHILD is
     * killed and its result routed into the EXISTING connection-error retry.
     * 0 = off, on both surfaces.
     *
     * The default is generous on purpose: a local backend can sit in prompt
     * processing emitting nothing at all, and that silence is healthy.
     */
    streamInactivityMs: number
    /**
     * UNATTENDED AUTO-PICK (see task/yolo.ts): wherever pi-task would stop and ask,
     * take the option it already marks RECOMMENDED, stamp the artifact `(YOLO)` so
     * an audit can tell a machine decided, and never notify. Lets a local model run
     * a throwaway/test project end to end with nobody watching.
     *
     * Decided PER SITE, before the prompt is built — so the lone prompt notification
     * (SessionUI.ask) is suppressed structurally, and the existing unattended budgets
     * (MAX_AUTO_AUTOFIX, MAX_FINAL_GATE_AUTOFIX) still bound the loops they were
     * written to bound. An auto-pick may cost time, never work: a question with no
     * recommendation, or one the anti-synthesis guard demoted, is SKIPPED, not
     * invented.
     * DEFAULT OFF — this is never the behaviour of a normal, watched run.
     */
    yoloMode: boolean
    /**
     * How much the run writes to its `.pi-tasks/*-debug.log` forensic trail
     * (task/debug-log.ts). Nothing in `src/` reads these files back —
     * `task-io.ts` only matches `TASK_NNNN.md`, and auto-commit's trail snapshot
     * reads every `.pi-tasks/` file as bytes and writes them back unparsed — so
     * this knob is behaviour-neutral by construction. It trades disk and repo
     * noise against the ability to explain a run after it has finished. The
     * TESTS do read the trail back, which is why the test preload pins the
     * config path away from the developer's own file.
     *
     * `full` is every line the child model emitted plus every tool result;
     * `events` keeps only decisions and guard actions; `off` writes nothing.
     *
     * DEFAULT `events`, not `off`, because the two levels are not the same kind
     * of record. The child's own output and the `↳` tool dumps are bulk. The
     * `=== … ===` markers are the only record of what the guards did — the
     * git-state guard firing, a write-capable child's tree changes, a FAIL
     * reason. Silencing the chatter costs nothing. Silencing the guard record
     * makes the next incident unreconstructible, and a debug log cannot be
     * recovered after the fact.
     */
    debugLogs: DebugLogLevel
    /**
     * Which reasoning profile is in force. See config/reasoning.ts for the four
     * modes and the group vocabulary.
     *
     * DEFAULT `default`, which uses the shipped per-group table. `off` and `on`
     * override every group at once; `custom` reads the user's own table.
     */
    reasoningMode: ReasoningMode
    /**
     * The per-group thinking levels, consulted ONLY when
     * `reasoningMode === 'custom'`.
     *
     * Kept populated in every mode so switching to `custom` and back does not
     * lose the user's table — the same reason `commandTimeoutExemptTools`
     * survives the watchdog being turned off. Its sanitizer always returns a
     * complete record, so no consumer needs a per-key fallback.
     */
    reasoningLevels: Record<ReasoningGroup, GroupSetting>
}

/** How verbose the `.pi-tasks/*-debug.log` trail is. See {@link PiTaskConfig.debugLogs}. */
export type DebugLogLevel = 'off' | 'events' | 'full'

/**
 * The debug-log choices offered by /task-config, in cycle order (quietest →
 * loudest, so the cycle reads as a volume dial). Unlike the timeout options the
 * stored value IS the label — the level is already a word.
 */
export const DEBUG_LOG_OPTIONS: readonly DebugLogLevel[] = ['off', 'events', 'full'] as const

const DEFAULT_DEBUG_LOGS: DebugLogLevel = 'events'

/**
 * Same pinning as the timeout sanitizers: a hand-edited `"debugLogs": true` or a
 * level from a future version must not reach the writer as an unknown string —
 * it falls back to the default rather than silently disabling the trail.
 */
export function sanitizeDebugLogs(value: unknown): DebugLogLevel {
    return DEBUG_LOG_OPTIONS.includes(value as DebugLogLevel) ?
            (value as DebugLogLevel)
        :   DEFAULT_DEBUG_LOGS
}

/**
 * The command-watchdog timeout choices offered by /task-config, in the cycle
 * order the picker shows: ascending, with `off` last. The stored config value is
 * the ms number; the label is display-only (mirrors the searchProvider
 * label/value split).
 */
export const COMMAND_TIMEOUT_OPTIONS: ReadonlyArray<{label: string; ms: number}> = [
    {label: '5 min', ms: 5 * 60_000},
    {label: '10 min', ms: 10 * 60_000},
    {label: '15 min', ms: 15 * 60_000},
    {label: '30 min', ms: 30 * 60_000},
    {label: 'off', ms: 0}
] as const

const DEFAULT_REQUEST_TIMEOUT_MS = 15 * 60_000

/**
 * A hand-edited or stale config could carry any number (or a string); pin it to
 * one of the offered choices so the watchdog never arms on a nonsense value.
 */
export function sanitizeRequestTimeoutMs(value: unknown): number {
    return COMMAND_TIMEOUT_OPTIONS.some(o => o.ms === value) ?
            (value as number)
        :   DEFAULT_REQUEST_TIMEOUT_MS
}

/** Keep only exact, unique Pi tool names from an advanced config override. */
export function sanitizeCommandTimeoutExemptTools(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const result: string[] = []
    const seen = new Set<string>()
    for (const item of value) {
        if (typeof item !== 'string') continue
        const name = item.trim()
        if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(name) || seen.has(name)) continue
        seen.add(name)
        result.push(name)
    }
    return result
}

/**
 * The stream-watchdog choices offered by /task-config, in cycle order. Every
 * option is minutes, not seconds: the silence this must tolerate — a local
 * backend in prompt processing — is itself measured in minutes.
 */
export const STREAM_INACTIVITY_OPTIONS: ReadonlyArray<{label: string; ms: number}> = [
    {label: '5 min', ms: 5 * 60_000},
    {label: '10 min', ms: DEFAULT_STREAM_INACTIVITY_MS},
    {label: '20 min', ms: 20 * 60_000},
    {label: '30 min', ms: 30 * 60_000},
    {label: 'off', ms: 0}
] as const

/** Same pinning as {@link sanitizeRequestTimeoutMs}: a hand-edited value that is
 *  not one of the offered choices falls back to the default. */
export function sanitizeStreamInactivityMs(value: unknown): number {
    return STREAM_INACTIVITY_OPTIONS.some(o => o.ms === value) ?
            (value as number)
        :   DEFAULT_STREAM_INACTIVITY_MS
}

/**
 * The shipped defaults. Exported so tests can start from a KNOWN config instead
 * of `getConfig()`, which reads whatever this machine happens to have on disk —
 * a test that passes or fails depending on the developer's own settings is not
 * testing the code.
 */
export const DEFAULT_CONFIG: PiTaskConfig = {
    remote: true,
    autoCommit: true,
    orientation: true,
    enforceGuidelines: true,
    verifyWork: true,
    parallelResearchWorkers: false,
    researchCache: true,
    searchProvider: 'exa',
    extensionWhitelist: [],
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    commandTimeoutExemptTools: [],
    streamInactivityMs: DEFAULT_STREAM_INACTIVITY_MS,
    // OFF: auto-answering is for unattended throwaway runs only.
    yoloMode: false,
    // EVENTS: the model chatter is bulk nobody reads; the guard and verdict
    // markers are what explains a failed run.
    debugLogs: DEFAULT_DEBUG_LOGS,
    // DEFAULT: the shipped per-group table. A cell left at `inherit` emits no
    // --thinking flag, so that child keeps the host's own level.
    reasoningMode: 'default',
    reasoningLevels: {...DEFAULT_REASONING_TABLE}
}

/**
 * A hand-edited config can hold anything; keep only string entries so a stray
 * object/number can't reach the child argv as `-e [object Object]`.
 */
export function sanitizeExtensionWhitelist(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
}

/** The keys whose stored value is a boolean — derived, so a retype is a compile error. */
type BooleanConfigKey = {
    [K in keyof PiTaskConfig]: PiTaskConfig[K] extends boolean ? K : never
}[keyof PiTaskConfig]

/**
 * A boolean setting's loader. Only a REAL boolean counts; anything else falls
 * back to the shipped default — a hand-edited `"verifyWork": "off"` is a truthy
 * string and a `"autoCommit": 0` is a falsy number, and neither may decide a
 * setting.
 */
function asBoolean(key: BooleanConfigKey): (raw: unknown) => boolean {
    return raw => (typeof raw === 'boolean' ? raw : DEFAULT_CONFIG[key])
}

/**
 * How each setting's STORED value becomes a safe in-memory value — one loader per
 * key, keyed on the config's own type.
 *
 * The mapped type is the point: a new field on `PiTaskConfig` is a compile error
 * until it declares how a hostile value becomes a safe one. Adding a field and
 * nothing else fails tsc twice — once on DEFAULT_CONFIG, once here.
 */
export const CONFIG_LOADERS: {
    [K in keyof PiTaskConfig]: (raw: unknown) => PiTaskConfig[K]
} = {
    remote: asBoolean('remote'),
    autoCommit: asBoolean('autoCommit'),
    orientation: asBoolean('orientation'),
    enforceGuidelines: asBoolean('enforceGuidelines'),
    verifyWork: asBoolean('verifyWork'),
    parallelResearchWorkers: asBoolean('parallelResearchWorkers'),
    researchCache: asBoolean('researchCache'),
    yoloMode: asBoolean('yoloMode'),
    // A hand-edited or stale enum value must not leak an unknown provider into
    // the dispatch switch — fall back to the default.
    searchProvider: raw => (isSearchProvider(raw) ? raw : DEFAULT_CONFIG.searchProvider),
    extensionWhitelist: sanitizeExtensionWhitelist,
    requestTimeoutMs: sanitizeRequestTimeoutMs,
    commandTimeoutExemptTools: sanitizeCommandTimeoutExemptTools,
    streamInactivityMs: sanitizeStreamInactivityMs,
    debugLogs: sanitizeDebugLogs,
    reasoningMode: sanitizeReasoningMode,
    reasoningLevels: sanitizeReasoningLevels
}

/**
 * Turn parsed config JSON into a `PiTaskConfig`. Pure, so every hostile-value
 * case is reachable from a test without going through `getConfig()`, which reads
 * whatever this machine has on disk.
 *
 * A non-object `raw` yields the defaults. Spreading a string instead would
 * produce numeric index keys: `{...DEFAULT_CONFIG, ...'ab'}` gains `0` and `1`.
 * Keys absent from the sanitizer table are dropped rather than carried into the
 * config object.
 */
export function loadConfig(raw: unknown): PiTaskConfig {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {...DEFAULT_CONFIG}
    }
    const stored = raw as Record<string, unknown>
    const out = {...DEFAULT_CONFIG}
    for (const key of Object.keys(CONFIG_LOADERS) as Array<keyof PiTaskConfig>) {
        // `undefined` reaches the loader like any other hostile value: every
        // loader answers a missing key with its own default, which is what the
        // old `delete parsed.X` + spread did.
        ;(out as Record<string, unknown>)[key] = CONFIG_LOADERS[key](stored[key])
    }
    return out
}

/**
 * Where the saved config lives. `PI_TASK_CONFIG_PATH` overrides it.
 *
 * The override exists because this module loads the real file at import time,
 * which makes every test that reads a config value depend on the developer's own
 * `~/.config/pi-task/config.json` — a machine-local `"debugLogs": "off"` is
 * enough to fail the tests that read `plan-debug.log` back. The test preload
 * points this at a path under the tmp dir that never exists, so tests always see
 * DEFAULT_CONFIG. Read once at module eval: the preload runs before any import.
 */
export const CONFIG_PATH_ENV = 'PI_TASK_CONFIG_PATH'
const CONFIG_PATH =
    process.env[CONFIG_PATH_ENV]?.trim()
    || path.join(os.homedir(), '.config', 'pi-task', 'config.json')

type ConfigGlobal = {config: PiTaskConfig; loaded: boolean}
const _g = globalThis as unknown as Record<string, ConfigGlobal | undefined>
if (!_g.__piTaskConfig) {
    _g.__piTaskConfig = {config: {...DEFAULT_CONFIG}, loaded: false}
}
const G = _g.__piTaskConfig!

// Load synchronously on module evaluation so getConfig() is always ready
// before any session_start handler fires.
if (!G.loaded) {
    try {
        G.config = loadConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')))
    } catch {
        G.config = {...DEFAULT_CONFIG}
    }
    G.loaded = true
}

export function getConfig(): PiTaskConfig {
    return G.config
}

export async function saveConfig(config: PiTaskConfig): Promise<void> {
    const dir = path.dirname(CONFIG_PATH)
    await fsp.mkdir(dir, {recursive: true})
    await fsp.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8')
    G.config = {...config}
}
