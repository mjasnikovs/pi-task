/**
 * Per-task git commit for /task-auto.
 *
 * After each decomposed task passes, the loop snapshots the working tree into a
 * single commit, so a run produces one commit per task. Best-effort throughout,
 * and confirmed by calling it: outside a git repo it answers
 * `{committed: false, reason: 'not a git repository'}`, on a clean tree
 * `{committed: false, reason: 'nothing to commit'}`. Nothing throws — the task
 * already succeeded, and a failed snapshot must not undo that.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {runChildDefault, type SpawnFn} from '../shared/child-process.js'
import {revParsePrefix} from '../shared/git-runner.js'
import {isDeletionExemptArtifact} from './regenerable-artifacts.js'

/** The gate machinery's own state/forensic dir — the trail, debug logs, and per-run
 *  ledgers. Preserved verbatim across a revert (see gitDropLastCommit). */
const TRAIL_DIR = '.pi-tasks'

export interface CommitResult {
    committed: boolean
    /** Short, human-readable reason when committed === false. */
    reason?: string
    /** Set when the commit needed a fallback (e.g. self-supplied identity). */
    note?: string
    /** UNTRACKED regenerable test-runner output this commit deliberately left out
     *  of the index (see `stagePathspec`). Empty/absent when nothing was excluded.
     *  Present so the caller can TRAIL it: a silent exclusion is the same failure
     *  class as a silent write to an ignored path. */
    excluded?: string[]
}

/**
 * Does this git stderr describe a missing author identity?
 *
 * The failure it catches is total rather than partial: with no usable gitconfig
 * every per-task commit fails, which silently disables enforce and every
 * commit-based differential guard for the rest of the run. Reproduced with real
 * git — committing with `HOME` unset and both config files pointed at
 * `/dev/null` prints "Author identity unknown" plus the `user.email` /
 * `user.name` advice, and this predicate matches that text while rejecting an
 * unrelated `fatal: not a git repository`.
 */
export function isIdentityFailure(stderr: string): boolean {
    return /identity unknown|unable to auto-detect email|user\.(name|email)/i.test(stderr)
}

/** Fallback identity for environments with no git config. Confirmed against real
 *  git: the same commit that fails with no identity succeeds with these args. */
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
 * The UNTRACKED files a per-task snapshot must not sweep into the index: Playwright
 * `test-results/`, `playwright-report/`, `coverage/`, `.nyc_output/`,
 * `.last-run.json`, `*.tsbuildinfo`.
 *
 * The failure this closes: a bare `git add -A` sweeps up whatever the test run
 * just littered the tree with — a failure screenshot, a coverage dir — and commits
 * it, making regenerable output a TRACKED deliverable. A later task that cleans it
 * up then reads as deleting someone's work.
 *
 * ONLY UNTRACKED PATHS ARE EXCLUDED, and that is load-bearing rather than tidy.
 * Both halves measured with real git in a repo with a gitignored `coverage/` and
 * an untracked `test-results/`:
 *   • `ls-files --others --exclude-standard` returned the untracked file alone;
 *     dropping the flag brought the gitignored one back too.
 *   • a TRACKED file never appears, even while modified.
 * So a project that deliberately commits, say, a `coverage/` badge keeps having
 * its edits to it committed. Excluding by directory pathspec instead
 * (`:(exclude)coverage/`) would silently stop committing those.
 *
 * Best-effort: any git failure yields an empty list, so nothing is excluded.
 */
export async function untrackedArtifacts(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string[]> {
    const r = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], signal, spawnFn)
    if (r.aborted || r.exitCode !== 0) return []
    return r.stdout
        .split('\0')
        .map(p => p.trim())
        .filter(p => p.length > 0 && isDeletionExemptArtifact(p))
        .sort()
}

/**
 * Would `gitCommitAll` commit anything right now? The trail dir and the untracked
 * output `untrackedArtifacts` names never reach a commit, so neither is an edit.
 * Untracked files are listed one by one: a collapsed `?? test-results/` entry
 * would hide a real file sitting next to the runner output.
 */
export async function hasCommittableChanges(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<boolean> {
    const r = await git(
        cwd,
        [
            'status',
            '--porcelain',
            '-z',
            '--untracked-files=all',
            '--',
            '.',
            `:(exclude)${TRAIL_DIR}`
        ],
        signal,
        spawnFn
    )
    if (r.aborted || r.exitCode !== 0) return false
    let prefix: string | undefined
    for (const entry of r.stdout.split('\0')) {
        if (entry.length < 4) continue
        if (entry.slice(0, 2) !== '??') return true
        // Status names paths from the repo root; the artifact rule reads them from cwd.
        prefix ??= revParsePrefix(
            (await git(cwd, ['rev-parse', '--show-prefix'], signal, spawnFn)).stdout
        )
        const file = entry.slice(3)
        if (isDeletionExemptArtifact(file.startsWith(prefix) ? file.slice(prefix.length) : file))
            continue
        return true
    }
    return false
}

/** The pathspec for `git add -A`: cwd, never the whole repo, so a task run from a
 *  package does not commit its siblings' edits. */
export function stagePathspec(excluded: readonly string[]): string[] {
    return ['--', '.', ...excluded.map(p => `:(exclude)${p}`)]
}

/**
 * Paths with unmerged index entries (an in-progress merge conflict), deduped.
 * Empty outside a git repo or on any git error — this is a GUARD input, and a
 * guard that cannot conclude must not block.
 *
 * Why it exists: with an unmerged index every later commit is doomed, verify runs
 * against a conflicted tree, and — worst — a blind `git add -A` SILENTLY resolves
 * the conflict with whatever is on disk. Reproduced on a real conflict: `git
 * status` showed `UU c.txt`, then a bare `git add -A` turned it into `M  c.txt`
 * and left `ls-files -u` empty. The conflict markers become staged content and
 * nothing says so.
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
 *  exact landmine that detonates days after it is pushed. */
export async function gitStashRef(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<string | null> {
    const r = await git(cwd, ['rev-parse', '-q', '--verify', 'refs/stash'], signal, spawnFn)
    return r.exitCode === 0 ? r.stdout.trim() : null
}

/**
 * Stage and commit everything under cwd with `message`. A sibling package's edits,
 * staged or not, stay out, except while a merge or cherry-pick is concluded: git
 * commits its whole index then. Honors .gitignore via git itself. Never throws —
 * failures surface as `{committed: false, reason}` so the caller can warn and keep
 * going.
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

    // 3. Stage all working-tree changes (new, modified, deleted) EXCEPT untracked
    //    regenerable test-runner output — see stagePathspec.
    const excluded = await untrackedArtifacts(cwd, signal, spawnFn)
    const add = await git(cwd, ['add', '-A', ...stagePathspec(excluded)], signal, spawnFn)
    if (add.aborted) return {committed: false, reason: 'cancelled'}
    if (add.exitCode !== 0) {
        return {committed: false, reason: `git add failed: ${firstLine(add.stderr)}`}
    }

    // 4. Anything staged? `git diff --cached --quiet` exits 0 when the index
    //    matches HEAD (nothing to commit), 1 when there are staged changes.
    const diff = await git(cwd, ['diff', '--cached', '--quiet', '--', '.'], signal, spawnFn)
    if (diff.aborted) return {committed: false, reason: 'cancelled'}
    if (diff.exitCode === 0) return {committed: false, reason: 'nothing to commit'}

    // 5. Commit. A failure here is usually missing user.name/user.email config —
    //    retry once with a self-supplied identity rather than losing the snapshot
    //    (and with it enforce + every differential guard) for the whole run.
    const only = (await concludingMerge(cwd, signal, spawnFn)) ? [] : ['--', '.']
    const commit = await git(cwd, ['commit', '-m', message, ...only], signal, spawnFn)
    if (commit.aborted) return {committed: false, reason: 'cancelled'}
    if (commit.exitCode !== 0) {
        if (isIdentityFailure(commit.stderr || commit.stdout)) {
            const retry = await git(
                cwd,
                [...FALLBACK_IDENTITY_ARGS, 'commit', '-m', message, ...only],
                signal,
                spawnFn
            )
            if (retry.aborted) return {committed: false, reason: 'cancelled'}
            if (retry.exitCode === 0) {
                return {
                    committed: true,
                    note: 'no git identity configured — used pi-task fallback',
                    ...(excluded.length > 0 ? {excluded} : {})
                }
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
    return {committed: true, ...(excluded.length > 0 ? {excluded} : {})}
}

/** A merge or cherry-pick in progress: git refuses a commit limited to cwd then,
 *  and concluding it takes the whole index anyway. */
async function concludingMerge(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<boolean> {
    for (const head of ['MERGE_HEAD', 'CHERRY_PICK_HEAD']) {
        const exact = await git(cwd, ['show-ref', '-q', '--exists', head], signal, spawnFn)
        if (exact.exitCode === 0) return true
        if (exact.exitCode === 2) continue
        // Git before 2.43 has no `--exists`. rev-parse also resolves a branch of that name.
        const loose = await git(cwd, ['rev-parse', '-q', '--verify', head], signal, spawnFn)
        if (loose.exitCode === 0) return true
    }
    return false
}

/**
 * Drop the last commit, restoring the files it changed to its parent — the
 * differential guard's "revert" when an `'edit'` enforcement pass regressed the
 * verified task commit. The enforcement fixes are committed first (as `ENFORCE
 * GUIDELINES`); when re-running verification against that commit reports a
 * regression, this throws the enforce commit away and brings back the verified
 * task commit underneath it.
 *
 * Only cwd moves. An enforce commit holds only cwd, so a sibling package's
 * uncommitted edits are still in the worktree here, and a repo-wide `reset --hard
 * HEAD~1` destroyed them. cwd is restored to the parent, which also discards what
 * the re-verify wrote there, and then HEAD alone steps back. A commit that
 * concluded a merge is refused: its first parent is not the tree before it.
 *
 * It must NOT rewind the forensic gate trail either. `.pi-tasks/` is frequently
 * TRACKED here — unlike the accept-debt ledger's writers, the per-task snapshot
 * stages it with no exclusion — so restoring it with the source ERASES every trail
 * line written after the snapshot. It is snapshotted first and written back after.
 *
 * Never throws. Answers whether the commit was dropped, so the caller does not
 * trail a revert that did not happen.
 */
export async function gitDropLastCommit(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<boolean> {
    const parents = await git(cwd, ['rev-list', '--parents', '-n', '1', 'HEAD'], signal, spawnFn)
    if (parents.exitCode !== 0 || parents.stdout.trim().split(' ').length !== 2) return false
    const trail = await snapshotTrail(cwd)
    const restored = await git(
        cwd,
        ['restore', '--source=HEAD~1', '--staged', '--worktree', '--', '.'],
        signal,
        spawnFn
    )
    const dropped =
        !restored.aborted
        && restored.exitCode === 0
        && (await git(cwd, ['reset', '-q', '--soft', 'HEAD~1'], signal, spawnFn)).exitCode === 0
    await restoreTrail(cwd, trail)
    return dropped
}

/** Read every file under `.pi-tasks/` into memory (relative path → bytes). Best-effort:
 *  a missing dir or unreadable file is skipped, so this never blocks the revert. */
async function snapshotTrail(cwd: string): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>()
    const root = path.join(cwd, TRAIL_DIR)
    const walk = async (dir: string): Promise<void> => {
        let entries
        try {
            entries = await fsp.readdir(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) await walk(full)
            else if (e.isFile()) {
                try {
                    out.set(path.relative(cwd, full), await fsp.readFile(full))
                } catch {
                    // unreadable — skip
                }
            }
        }
    }
    await walk(root)
    return out
}

/** Re-materialise the snapshotted trail files, overwriting whatever the reset left. */
async function restoreTrail(cwd: string, trail: Map<string, Buffer>): Promise<void> {
    for (const [rel, buf] of trail) {
        const full = path.join(cwd, rel)
        try {
            await fsp.mkdir(path.dirname(full), {recursive: true})
            await fsp.writeFile(full, buf)
        } catch {
            // best-effort restore
        }
    }
}
