/**
 * Where a run's logs and gate evidence live: OUTSIDE the repository.
 *
 * `.pi-tasks/` is committed with every task and rewound by the gates'
 * `reset --hard`, and `snapshotTrail` copies every file under it across that
 * rewind. A trail that grows with model chatter therefore costs a re-read, a
 * re-commit and a full-file copy per task — a real run reached 1.7 MB. None of it
 * is an artifact of the project, so it belongs in the user's state home,
 * partitioned per repository and per run so whole generations can be dropped.
 *
 * The task FILES stay where they are: those are the deliverable.
 */
import * as crypto from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {newRunToken} from '../workers/research-cache.js'

/**
 * The run this process is serving. An env var rather than a module variable for
 * the same reason the research cache uses one (`research-cache.ts`): a run spans
 * several sessions and module registries, and one id has to reach all of them.
 */
export const RUN_ID_ENV = 'PI_TASK_RUN_ID'

/** How many of a repository's runs keep their logs. */
export const RUN_LOG_KEEP = 20

/** The XDG state-home base. Siblings: `dataHome` (shared/data-home.ts). */
export function stateHome(): string {
    const xdg = process.env.XDG_STATE_HOME?.trim()
    // XDG says a relative value is to be IGNORED, not resolved against the cwd —
    // resolving one would scatter log dirs through the user's projects.
    return xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.local', 'state')
}

/** Stable directory name for a repository: its absolute path, hashed so one flat
 *  level holds every repo and no tree layout leaks into a shared directory. */
export function repoHash(cwd: string): string {
    return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)
}

/** Every run's directory for this repository — the unit `pruneRunLogs` walks. */
export function repoStateDir(cwd: string): string {
    return path.join(stateHome(), 'pi-task', repoHash(cwd))
}

/** One run's directory: logs, and (WS9) its gate evidence. */
export function stateDir(cwd: string, runId: string): string {
    return path.join(repoStateDir(cwd), runId)
}

/**
 * Mint a fresh id for the run starting now. Every command that opens a run calls
 * it, so one run's logs land in one directory however many tasks it spans.
 */
export function beginRun(): string {
    const id = newRunToken()
    process.env[RUN_ID_ENV] = id
    return id
}

/** This run's id, minting one for a line written outside any run. */
export function currentRunId(): string {
    const id = process.env[RUN_ID_ENV]?.trim()
    return id && id.length > 0 ? id : beginRun()
}

/** A log file in the current run's directory. */
export function runLogPath(cwd: string, file: string): string {
    return path.join(stateDir(cwd, currentRunId()), file)
}

/**
 * Drop all but the `keep` most recent runs of this repository, returning the ids
 * removed. Called once when a run completes: retention that needs a timer would
 * outlive the session that owns it, and a repo nobody runs keeps what it had.
 *
 * Best-effort throughout — a state dir that cannot be read or removed must not
 * fail the run that just succeeded.
 */
export async function pruneRunLogs(cwd: string, keep: number = RUN_LOG_KEEP): Promise<string[]> {
    const dir = repoStateDir(cwd)
    const kept = Math.max(0, keep)
    const entries = await fsp.readdir(dir, {withFileTypes: true}).catch(() => [])
    const runs = entries.filter(e => e.isDirectory()).map(e => e.name)
    if (runs.length <= kept) return []
    const dated = await Promise.all(
        runs.map(async name => ({
            name,
            at: await fsp.stat(path.join(dir, name)).then(
                s => s.mtimeMs,
                () => 0
            )
        }))
    )
    // The name breaks an mtime tie: a run token opens with its own base-36
    // minting time, so it already orders the way the clock does.
    dated.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name))
    const drop = dated.slice(kept).map(d => d.name)
    await Promise.all(
        drop.map(name =>
            fsp.rm(path.join(dir, name), {recursive: true, force: true}).catch(() => {})
        )
    )
    return drop
}
