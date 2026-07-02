/**
 * Per-task git commit for /task-auto.
 *
 * After each decomposed task passes, runAutoLoop snapshots the working tree into
 * a single commit so the run produces one commit per task. This is best-effort:
 * outside a git repo, with nothing staged, or on any git error we report the
 * reason and let the loop continue (the task already succeeded).
 */
import {runChildDefault, type SpawnFn} from '../shared/child-process.js'

export interface CommitResult {
    committed: boolean
    /** Short, human-readable reason when committed === false. */
    reason?: string
}

function firstLine(s: string): string {
    const line = s.split('\n').find(l => l.trim().length > 0)
    return (line ?? s).trim()
}

export async function git(
    cwd: string,
    args: string[],
    signal: AbortSignal | undefined,
    spawnFn?: SpawnFn
): Promise<{stdout: string; stderr: string; exitCode: number; aborted: boolean}> {
    const r = await runChildDefault({command: 'git', args}, cwd, signal, {mode: 'text'}, spawnFn)
    return {stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, aborted: r.aborted}
}

/**
 * Stage everything (`git add -A`) and commit it with `message`. Honors
 * .gitignore via git itself. Never throws — failures surface as
 * `{committed: false, reason}` so the caller can warn and keep going.
 */
export async function gitCommitAll(
    cwd: string,
    message: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<CommitResult> {
    // 1. Is this a git work tree at all?
    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'], signal, spawnFn)
    if (inside.aborted) return {committed: false, reason: 'cancelled'}
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
        return {committed: false, reason: 'not a git repository'}
    }

    // 2. Stage all working-tree changes (new, modified, deleted).
    const add = await git(cwd, ['add', '-A'], signal, spawnFn)
    if (add.aborted) return {committed: false, reason: 'cancelled'}
    if (add.exitCode !== 0) {
        return {committed: false, reason: `git add failed: ${firstLine(add.stderr)}`}
    }

    // 3. Anything staged? `git diff --cached --quiet` exits 0 when the index
    //    matches HEAD (nothing to commit), 1 when there are staged changes.
    const diff = await git(cwd, ['diff', '--cached', '--quiet'], signal, spawnFn)
    if (diff.aborted) return {committed: false, reason: 'cancelled'}
    if (diff.exitCode === 0) return {committed: false, reason: 'nothing to commit'}

    // 4. Commit. A failure here is usually missing user.name/user.email config.
    const commit = await git(cwd, ['commit', '-m', message], signal, spawnFn)
    if (commit.aborted) return {committed: false, reason: 'cancelled'}
    if (commit.exitCode !== 0) {
        return {
            committed: false,
            reason: `git commit failed: ${firstLine(commit.stderr || commit.stdout)}`
        }
    }
    return {committed: true}
}

/**
 * Drop the last commit, restoring the tree to its parent — the differential
 * guard's "revert" when an `'edit'` enforcement pass regressed the verified task
 * commit. The enforcement fixes are committed first (as `ENFORCE GUIDELINES`);
 * when re-running verification against that commit reports a regression, this
 * `git reset --hard HEAD~1` throws the enforce commit away and brings back the
 * verified task commit underneath it.
 *
 * `reset --hard` is safe here precisely because it runs right after the enforce
 * commit: the working tree is clean (everything was just committed), so there is
 * no unrelated uncommitted work for it to destroy. HEAD~1 is the verified task
 * commit. The enforcement child runs `read,edit` with no `write`, so the dropped
 * commit contains only its in-place source edits — nothing else to preserve.
 *
 * Best-effort and never throws: a git failure is swallowed (the caller has
 * already decided to keep the verified work; a failed reset only leaves the
 * enforce commit in place, which is surfaced as a warning).
 */
export async function gitDropLastCommit(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<void> {
    await git(cwd, ['reset', '--hard', 'HEAD~1'], signal, spawnFn)
}
