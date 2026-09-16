/**
 * tree-hash — the content identity of the working tree, computed without touching
 * the real index or the working tree.
 *
 * `git add -A` against a THROWAWAY `GIT_INDEX_FILE` is the whole technique: the
 * staged state a user (or a half-finished gate) left in the real index survives,
 * nothing is stashed, and no file moves. Every consumer that asks "is this the
 * same tree as before?" — the git-state guard's reconcile, the health baseline,
 * and the evidence cache when it lands — must ask it the same way, or two answers
 * disagree about the same tree.
 *
 * `.pi-tasks` is excluded because the gate machinery writes its own trail there
 * DURING the work being hashed; including it would make every hash differ from
 * every other one for reasons that have nothing to do with the code.
 *
 * Null means "git could not tell us", never "empty tree": a caller that treats an
 * unreadable tree as a match would call two different trees identical.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type {GitRunner} from '../shared/git-runner.js'

/** Keep the gate machinery's own artifacts out of the hash. */
const EXCLUDE_TASKS_DIR = ':(exclude).pi-tasks'

function throwawayIndexPath(): string {
    return path.join(
        os.tmpdir(),
        `pi-task-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
}

/**
 * Snapshot the worktree content into a tree object. Returns null when git cannot
 * build the tree (an unborn HEAD, a non-repo cwd, a missing binary).
 */
export async function worktreeTreeHash(git: GitRunner): Promise<string | null> {
    const tmpIndex = throwawayIndexPath()
    const env = {GIT_INDEX_FILE: tmpIndex}
    try {
        const empty = await git(['read-tree', '--empty'], env)
        if (empty.exitCode !== 0) return null
        const add = await git(['add', '-A', '--', '.', EXCLUDE_TASKS_DIR], env)
        if (add.exitCode !== 0) return null
        const tree = await git(['write-tree'], env)
        return tree.exitCode === 0 ? tree.stdout.trim() : null
    } finally {
        await fsp.rm(tmpIndex, {force: true}).catch(() => {})
    }
}

/** The tree object a commit-ish points at — the committed twin of the above. */
export async function commitTreeHash(git: GitRunner, revision: string): Promise<string | null> {
    const r = await git(['rev-parse', `${revision}^{tree}`])
    if (r.exitCode !== 0) return null
    const sha = r.stdout.trim()
    return sha.length > 0 ? sha : null
}
