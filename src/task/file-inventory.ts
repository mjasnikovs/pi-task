/**
 * Project file inventory — runs `git ls-files` once per /task run so research
 * workers can skip their own discovery loops and jump straight to targeted
 * read/grep on known paths. Returns '' on failure (non-git repo, git missing,
 * timeout) so callers can fall back to the pre-inventory behavior.
 */

import {makeGit} from '../shared/git-runner.js'
import {TASKS_DIR_NAME} from './task-types.js'

const DEFAULT_MAX_LINES = 2000

/**
 * Drop the committed task directory from the inventory. `git ls-files` lists
 * tracked files regardless of `.ignore`, so once tasks are committed they would
 * otherwise be handed to every research worker (and feed orientation). The user
 * wants tasks committable but invisible to workers and the local model, so we
 * strip `.pi-tasks/` here — the inventory's single chokepoint. (`git ls-files`
 * always emits posix-style paths, so the forward-slash prefix is correct on all
 * platforms.)
 */
export function stripTasksDir(raw: string): string {
    const prefix = `${TASKS_DIR_NAME}/`
    return raw
        .split('\n')
        .filter(l => !l.startsWith(prefix))
        .join('\n')
}

/**
 * `git ls-files`, or '' on ANY failure — non-git tree, missing git, cancelled run.
 * The empty string is the caller's fall-back-to-pre-inventory signal, so every
 * unhappy path has to collapse to it.
 *
 * Runs on the shared GitRunner (`shared/git-runner.ts`), which brings the abort
 * discipline a hand-rolled version misses: the listener is detached when the child
 * settles normally, so a run-long orchestrator signal does not accumulate one
 * retained child per invocation (GitHub issue #9).
 *
 * The `signal.aborted` check is what preserves this function's OWN contract on
 * cancellation. A killed child closes with a null exit code, which the runner
 * reports as 0 — so without it a cancelled run would hand back a truncated
 * inventory as if it were complete, where the hand-rolled version returned ''.
 */
async function runGitLsFiles(cwd: string, signal?: AbortSignal): Promise<string> {
    const git = makeGit(cwd, signal)
    const r = await git(['ls-files'])
    if (r.exitCode !== 0 || signal?.aborted) return ''
    return r.stdout
}

/** Cap output to maxLines real (non-blank) paths; tag truncation when cut. */
export function capInventory(raw: string, maxLines: number = DEFAULT_MAX_LINES): string {
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    if (lines.length <= maxLines) return lines.join('\n')
    const shown = lines.slice(0, maxLines)
    return `${shown.join('\n')}\n(truncated: ${lines.length - maxLines} more files)`
}

export async function getFileInventory(
    cwd: string,
    signal?: AbortSignal,
    maxLines: number = DEFAULT_MAX_LINES
): Promise<string> {
    const raw = await runGitLsFiles(cwd, signal)
    if (!raw) return ''
    return capInventory(stripTasksDir(raw), maxLines)
}
