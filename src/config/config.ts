import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import {isSearchProvider, type SearchProvider} from '../workers/search-types.js'

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
    extensionWhitelist: []
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
