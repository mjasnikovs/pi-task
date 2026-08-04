import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {isSearchProvider, type SearchProvider} from '../workers/search-types.js'
import {DEFAULT_STREAM_INACTIVITY_MS} from '../shared/stream-watchdog.js'

export interface PiTaskConfig {
    remote: boolean
    compressReasoning: boolean
    autoCommit: boolean
    orientation: boolean
    enforceGuidelines: boolean
    verifyWork: boolean
    /**
     * Run the four research workers concurrently instead of one at a time.
     * DEFAULT OFF: serial was A/B-proven faster on a single-GPU local backend
     * (concurrent streams split the GPU and slow each other ~4×, see
     * phases.ts). Turn on only for a parallel-capable backend.
     */
    parallelResearchWorkers: boolean
    /**
     * Cache docs/search/fetch worker RESULTS for the duration of one /task-auto run
     * so sibling tasks re-asking the same (package/url, query) reuse the first
     * pipeline's digest instead of re-fetching (mx5 run-8 F10: the research phase
     * burned 75 of 363 min largely re-fetching the same external docs across ~20
     * siblings). Per-run isolated, external-only (project-source `.` lookups excluded),
     * success-only. DEFAULT ON — the F10 live A/B showed no answer-quality regression
     * (a cache hit serves byte-identical text to the first fetch; distinct queries never
     * collide).
     */
    researchCache: boolean
    /**
     * Which engine backs web search (pi-worker-search + freshness/enrichment).
     * `exa` and `ddg` need no API key; `brave` needs BRAVE_SEARCH_API_KEY.
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
     * watchdog steps in. Local models routinely run a command that never returns
     * (e.g. `godot --headless` with no timeout, a dev server, a hung test) and
     * the run wedges until the user manually aborts. pi's bash tool has an
     * OPTIONAL timeout with NO default (bash.js), so a command the model didn't
     * bound runs forever; this is the missing default.
     *
     * ONE knob, TWO surfaces (shared/command-watchdog.ts): in the MAIN session
     * the overrun call is cancelled via ctx.abort() (kills the tool's whole
     * process tree) plus an auto-reminder turn; in the verify/fix GATE children
     * (gate-deps.ts) the child is killed and re-spawned with a hint, the ceiling
     * halving on repeat hangs. 0 = off — which unguards BOTH surfaces, gates
     * included. Tool-agnostic: it arms on any tool execution, though in practice
     * only bash runs long enough to trip it.
     * DEFAULT 15 min: long enough for a real build/test suite, short enough that
     * a true hang doesn't cost half an hour of dead time.
     */
    requestTimeoutMs: number
    /**
     * Extension tools that own a stronger, domain-specific timeout and
     * cancellation contract. The generic command watchdog must not abort these
     * tools mid-transaction; bash and every other tool remain guarded.
     *
     * This is intentionally an advanced config-file setting rather than a
     * blanket switch in /task-config. Tool names are matched exactly.
     */
    commandTimeoutExemptTools: string[]
    /**
     * Inactivity ceiling (ms) on the MODEL STREAM before the stream watchdog
     * aborts the request (shared/stream-watchdog.ts). A hung or silently-dropped
     * stream throws nothing, so neither the connection-error retry (needs a
     * reported error) nor the command watchdog (covers tool calls only) nor the
     * child stall guard (a reachable endpoint is proof of life) can see it — mx5
     * run 14 lost ~2.9h to three such hangs while the model server stayed healthy.
     *
     * Measured as time since the LAST stream event of any kind, so a slow model
     * emitting one token every 30s is never touched; only total silence counts.
     * Suspended while a tool executes — that window is the command watchdog's.
     *
     * ONE knob, TWO surfaces: the MAIN session aborts the turn through the same
     * plumbing the command watchdog uses and posts a resume reminder; a CHILD is
     * killed and its result routed into the EXISTING connection-error retry.
     * 0 = off, on both surfaces.
     * DEFAULT 10 min: local prompt processing on a 32k context legitimately emits
     * nothing for minutes, so a 60-120s ceiling would kill healthy long prompts.
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
     * (task/debug-log.ts). NOTHING in pi-task ever reads these files back —
     * `task-io.ts` only globs `TASK_NNNN.md`, and auto-commit's trail snapshot
     * copies bytes without parsing them — so this knob is behaviour-neutral by
     * construction. It trades disk and repo noise against the ability to explain
     * a run after it has finished.
     *
     * `full` is every line the child model emitted plus every tool result;
     * `events` keeps only decisions and guard actions; `off` writes nothing.
     *
     * DEFAULT `events`, not `off`, because the two levels are not the same kind
     * of record. Measured on a real 247 KB `verify-debug.log` (IAR1, 1315 lines):
     * the child's own output and the `↳` tool dumps are 85% of the bytes, while
     * the `=== … ===` markers are 15% — and that 15% is the ONLY record of what
     * the guards did (`GIT-STATE GUARD — child mutated graded state`, the
     * write-capable child's `tree changes`, the FAIL reason). mx5 run 11's
     * final-fix child deleted a source file; the tree-changes line is why that
     * was findable at all. Silencing the chatter costs nothing; silencing the
     * guard record makes the next incident unreconstructible, and a debug log
     * cannot be recovered after the fact.
     */
    debugLogs: DebugLogLevel
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
 * The command-watchdog timeout choices offered by /task-config, newest-first in
 * the cycle order the picker shows. The stored config value is the ms number;
 * the label is display-only (mirrors the searchProvider label/value split).
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
 * option is minutes, not seconds: the failure this guards costs hours, and the
 * legitimate silence it must tolerate (local prompt processing) is minutes.
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

const DEFAULTS: PiTaskConfig = {
    remote: true,
    compressReasoning: true,
    autoCommit: true,
    orientation: true,
    enforceGuidelines: true,
    verifyWork: true,
    parallelResearchWorkers: false,
    // ON: the F10 live A/B showed no answer-quality regression (fidelity 3/3, quality
    // 3/3, 0 collisions; ~14.5s of repeated docs lookups collapse to 0ms on a hit).
    researchCache: true,
    searchProvider: 'exa',
    extensionWhitelist: [],
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    commandTimeoutExemptTools: [],
    streamInactivityMs: DEFAULT_STREAM_INACTIVITY_MS,
    // OFF: auto-answering is for unattended throwaway runs only.
    yoloMode: false,
    // EVENTS: the model chatter is 85% of the bytes and nobody reads it; the
    // guard/verdict markers are the 15% that explains a failed run.
    debugLogs: DEFAULT_DEBUG_LOGS
}

/**
 * A hand-edited config can hold anything; keep only string entries so a stray
 * object/number can't reach the child argv as `-e [object Object]`.
 */
export function sanitizeExtensionWhitelist(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    return value.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'pi-task', 'config.json')

type ConfigGlobal = {config: PiTaskConfig; loaded: boolean}
const _g = globalThis as unknown as Record<string, ConfigGlobal | undefined>
if (!_g.__piTaskConfig) {
    _g.__piTaskConfig = {config: {...DEFAULTS}, loaded: false}
}
const G = _g.__piTaskConfig!

// Load synchronously on module evaluation so getConfig() is always ready
// before any session_start handler fires.
if (!G.loaded) {
    try {
        const raw = fs.readFileSync(CONFIG_PATH, 'utf8')
        const parsed = JSON.parse(raw) as Partial<PiTaskConfig>
        // A hand-edited or stale enum value must not leak an unknown provider
        // into the dispatch switch — fall back to the default.
        if (!isSearchProvider(parsed.searchProvider)) delete parsed.searchProvider
        parsed.extensionWhitelist = sanitizeExtensionWhitelist(parsed.extensionWhitelist)
        parsed.requestTimeoutMs = sanitizeRequestTimeoutMs(parsed.requestTimeoutMs)
        parsed.commandTimeoutExemptTools = sanitizeCommandTimeoutExemptTools(
            parsed.commandTimeoutExemptTools
        )
        parsed.streamInactivityMs = sanitizeStreamInactivityMs(parsed.streamInactivityMs)
        // A hand-edited `"yoloMode": "false"` is a truthy string — it must not
        // silently switch a watched run into unattended auto-pick. Only a real
        // boolean counts; anything else falls back to the OFF default.
        if (typeof parsed.yoloMode !== 'boolean') delete parsed.yoloMode
        parsed.debugLogs = sanitizeDebugLogs(parsed.debugLogs)
        G.config = {...DEFAULTS, ...parsed}
    } catch {
        G.config = {...DEFAULTS}
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
