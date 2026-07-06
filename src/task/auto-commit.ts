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
    /** Set when the commit needed a fallback (e.g. self-supplied identity). */
    note?: string
}

/**
 * Does this git stderr describe a missing author identity? Seen live (mx5 run 4):
 * the headless docker container has no HOME gitconfig, so EVERY per-task commit
 * failed "Author identity unknown" — which silently disabled enforce and every
 * commit-based differential guard for the whole run.
 */
export function isIdentityFailure(stderr: string): boolean {
    return /identity unknown|unable to auto-detect email|user\.(name|email)/i.test(stderr)
}

/** Fallback identity for environments with no git config (headless containers). */
export const FALLBACK_IDENTITY_ARGS = [
    '-c',
    'user.name=pi-task',
    '-c',
    'user.email=pi-task@local'
] as const

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
 * Paths with unmerged index entries (an in-progress merge conflict), deduped.
 * Empty outside a git repo or on any git error — this is a GUARD input, and a
 * guard that cannot conclude must not block.
 *
 * Why it exists (mx5 run 6): a stale `git stash pop` mid-task left two paths UU;
 * every later commit was doomed, three verify passes ran against a conflicted
 * tree, and — worse — a blind `git add -A` on that index would have silently
 * "resolved" the conflict with whatever happened to be on disk.
 */
export async function gitUnmergedPaths(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string[]> {
    const r = await git(cwd, ['ls-files', '-u'], signal, spawnFn)
    if (r.exitCode !== 0) return []
    const out: string[] = []
    for (const line of r.stdout.split('\n')) {
        // `<mode> <sha> <stage>\t<path>`
        const tab = line.indexOf('\t')
        if (tab === -1) continue
        const p = line.slice(tab + 1).trim()
        if (p.length > 0 && !out.includes(p)) out.push(p)
    }
    return out
}

/** Sha of `refs/stash`, or null when there is no stash (or not a git repo). Used
 *  to detect a stash created (or consumed) during a task and left behind — the
 *  exact landmine that detonated mx5 run 6 two days after it was pushed. */
export async function gitStashRef(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string | null> {
    const r = await git(cwd, ['rev-parse', '-q', '--verify', 'refs/stash'], signal, spawnFn)
    return r.exitCode === 0 ? r.stdout.trim() : null
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

    // 2. REFUSE on an unmerged index: `git add -A` would silently "resolve" the
    //    conflict by staging whatever is on disk, and the commit that followed
    //    would bless a half-merged tree. Surface it instead — this state needs a
    //    human (or the loop's own loud stop), not a snapshot.
    const unmerged = await gitUnmergedPaths(cwd, signal, spawnFn)
    if (unmerged.length > 0) {
        return {
            committed: false,
            reason: `git commit blocked: unresolved merge conflict (${unmerged.slice(0, 3).join(', ')}${
                unmerged.length > 3 ? `, +${unmerged.length - 3} more` : ''
            })`
        }
    }

    // 3. Stage all working-tree changes (new, modified, deleted).
    const add = await git(cwd, ['add', '-A'], signal, spawnFn)
    if (add.aborted) return {committed: false, reason: 'cancelled'}
    if (add.exitCode !== 0) {
        return {committed: false, reason: `git add failed: ${firstLine(add.stderr)}`}
    }

    // 4. Anything staged? `git diff --cached --quiet` exits 0 when the index
    //    matches HEAD (nothing to commit), 1 when there are staged changes.
    const diff = await git(cwd, ['diff', '--cached', '--quiet'], signal, spawnFn)
    if (diff.aborted) return {committed: false, reason: 'cancelled'}
    if (diff.exitCode === 0) return {committed: false, reason: 'nothing to commit'}

    // 5. Commit. A failure here is usually missing user.name/user.email config —
    //    retry once with a self-supplied identity rather than losing the snapshot
    //    (and with it enforce + every differential guard) for the whole run.
    const commit = await git(cwd, ['commit', '-m', message], signal, spawnFn)
    if (commit.aborted) return {committed: false, reason: 'cancelled'}
    if (commit.exitCode !== 0) {
        if (isIdentityFailure(commit.stderr || commit.stdout)) {
            const retry = await git(
                cwd,
                [...FALLBACK_IDENTITY_ARGS, 'commit', '-m', message],
                signal,
                spawnFn
            )
            if (retry.aborted) return {committed: false, reason: 'cancelled'}
            if (retry.exitCode === 0) {
                return {committed: true, note: 'no git identity configured — used pi-task fallback'}
            }
            return {
                committed: false,
                reason: `git commit failed: ${firstLine(retry.stderr || retry.stdout)}`
            }
        }
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
