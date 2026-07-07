import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

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
}

const DEFAULTS: PiTaskConfig = {
    remote: true,
    compressReasoning: true,
    autoCommit: true,
    orientation: true,
    enforceGuidelines: true,
    verifyWork: true,
    parallelResearchWorkers: false
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
