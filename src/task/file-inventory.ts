/**
 * Project file inventory — `git ls-files`, capped, with the task directory
 * stripped. `phaseResearch` computes it once and puts it in the header every
 * research worker gets; `refineExistingFilesBlock` also uses it to pick the
 * paths orientation pre-reads.
 *
 * Returns '' on failure: a non-git tree exits 128, and a missing binary reaches
 * `runChildDefault`'s `error` handler as exit 1. Both callers treat '' as "no
 * inventory" and carry on.
 */

import {makeGit} from '../shared/git-runner.js'
import {TASKS_DIR_NAME} from './task-types.js'

const DEFAULT_MAX_LINES = 2000

/**
 * Drop the committed task directory from the inventory. `git ls-files` lists a
 * TRACKED file even when `.gitignore` matches it — confirmed against a real
 * repo where `.pi-tasks/` is both ignored and committed — so once tasks are
 * committed they reach every research worker and feed orientation unless they
 * are stripped here. This is the only filter on the inventory path.
 *
 * `git ls-files` prints forward slashes, so the prefix matches as written.
 */
export function stripTasksDir(raw: string): string {
    const prefix = `${TASKS_DIR_NAME}/`
    return raw
        .split('\n')
        .filter(l => !l.startsWith(prefix))
        .join('\n')
}

/**
 * `git ls-files`, or '' on ANY failure — non-git tree, missing git, cancelled
 * run. '' is the signal both callers branch on, so every unhappy path has to
 * collapse to it.
 *
 * Runs on the shared GitRunner, whose child detaches its abort listener when it
 * settles: one AbortController is shared across a whole run, so a listener left
 * attached per call would retain each finished child.
 *
 * The `signal.aborted` check is what holds the contract on cancellation. A
 * killed child closes with a null exit code and `runChild` reports `code ?? 0`,
 * so without the check a cancelled run would return partial stdout as if the
 * listing were complete.
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
