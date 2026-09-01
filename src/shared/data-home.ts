import * as os from 'node:os'
import * as path from 'node:path'

/**
 * The XDG data-home base. Same env-or-homedir shape the docs cache uses
 * (workers/docs-core.ts), but rooted at data-home rather than cache-home: what
 * lives under here is not reconstructible by re-fetching.
 */
export function dataHome(): string {
    return process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share')
}

/** A file under this machine's pi-task state directory. */
export function stateFile(name: string): string {
    return path.join(dataHome(), 'pi-task', name)
}
