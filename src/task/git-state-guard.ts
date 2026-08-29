/**
 * git-state-guard — deterministic repo-state snapshot/reconcile around the
 * read-only gate children (verify, recommend).
 *
 * Those children hold a `read,bash` contract whose "never modify the tree" clause
 * is PROMPT-LEVEL ONLY: `bash` can stash, check out, commit and rewrite files, and
 * nothing but the prompt says not to. A child that stashes the task's uncommitted
 * work and never pops it leaves the verify judging an empty tree AND leaves an
 * orphan stash that only detonates when something later pops it onto a moved HEAD.
 * So this is capability-shaped rather than prompt-shaped: snapshot the repo state
 * BEFORE the child runs, deterministically restore whatever it moved afterwards,
 * no model in the loop.
 *
 * What is captured and reconciled — each one run against a real repo:
 *   - HEAD (sha + symbolic branch ref). A child that checked out another commit,
 *     detached, is put back on its branch AND its sha. LIMIT: a child that COMMITS
 *     on the current branch is NOT undone — the restore checks out
 *     `before.branchRef`, and that branch now points at the child's commit, so the
 *     `checked HEAD back out to <branch>` line is honest about the ref and says
 *     nothing about the sha. The move is still classed verdict-tainting, so the
 *     verdict is discarded; the commit stays.
 *   - The WORKTREE CONTENT as a git tree object, built through a THROWAWAY index
 *     (`read-tree --empty` + `add -A` + `write-tree`, excluding `.pi-tasks` — the
 *     gate's own debug logs land there DURING the run). Measured on a repo with a
 *     staged file, an untracked file, a gitignored file and a `.pi-tasks/` log: the
 *     tree holds the tracked and untracked files and neither of the other two, and
 *     the REAL index still shows the same staged path afterwards. Restoration
 *     re-materialises every changed or deleted file and deletes what the child
 *     created.
 *   - The STASH ref: entries the child pushed are dropped AFTER the worktree is
 *     restored from the snapshot — the snapshot, not the stash, is the source of
 *     truth — so no orphan stash survives the reconcile.
 *
 * The real index's staging state is deliberately NOT restored: pre-commit gate
 * children run against a tree whose work is unstaged, and the auto-commit that
 * follows re-stages everything with `git add -A` (auto-commit.ts:192).
 *
 * Everything is best-effort: a repo where git fails disables the guard — capture
 * returns `ok: false` and reconcile no-ops. Measured: a fresh `git init` with no
 * commits answers non-zero to `rev-parse -q --verify HEAD`, which is the unborn-HEAD
 * case the capture bails on.
 */
import {readFileSync} from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type {SpawnFn} from '../shared/child-process.js'
import {makeGit, type GitRunner} from '../shared/git-runner.js'
import {isRegenerableArtifact} from './regenerable-artifacts.js'

/** Keep the gate machinery's own artifacts out of the snapshot and the restore. */
const EXCLUDE_TASKS_DIR = ':(exclude).pi-tasks'

export interface GitStateSnapshot {
    /** false → not a usable git worktree; the guard is disabled for this run. */
    ok: boolean
    headSha: string
    /** Symbolic ref ("refs/heads/main") when HEAD is on a branch, else null (detached). */
    branchRef: string | null
    /** Sha of refs/stash, or null when there is no stash. */
    stashSha: string | null
    /** Tree object capturing the worktree content (tracked + untracked, minus .pi-tasks). */
    treeSha: string | null
}

export interface ReconcileResult {
    /** true → the child moved repo state; every detected move was restored. This
     *  covers benign moves too (test-runner output), so it drives logging/notify —
     *  NOT the verdict decision. Use `verdictTainted` for that. */
    mutated: boolean
    /** true → the child changed *graded* state: a tracked-in-HEAD file was
     *  modified/deleted, HEAD/branch was moved, a stash was pushed, or an untracked
     *  non-artifact (source-shaped) file was modified/deleted. This is the real
     *  mutate-to-pass class; a verdict computed on such a tree is discarded.
     *
     *  Deliberately false for child-CREATED files and for modified or deleted
     *  untracked *test-runner artifacts* (test-results/, playwright-report/,
     *  coverage output, `*.tsbuildinfo`, `.last-run.json` …): a child that merely
     *  ran the suite and left its report behind judged a tree whose only difference
     *  from pre-run is regenerable output, and discarding the whole verify over
     *  that costs a re-run for nothing.
     *
     *  Measured against a real repo: rewriting a tracked source file taints;
     *  creating `test-results/r.json` does not; rewriting a tracked
     *  `*-snapshots/*.png` baseline DOES taint. */
    verdictTainted: boolean
    /** Human-readable restore actions, for the debug log / notify / gate trail. */
    actions: string[]
}

/**
 * Untracked paths that are regenerable test/build OUTPUT, not graded source. A gate
 * child creating or rewriting one of these has not mutated the work under
 * judgement, so its verdict stands. Gitignored files never reach the snapshot at
 * all — measured, `add -A` skips them — so this list is for the ones a typical
 * project leaves UNIGNORED, `test-results/` and `playwright-report/` above all.
 * Kept deliberately narrow: anything NOT matched here that a child modifies or
 * deletes is graded state, and taints the verdict.
 *
 * The list lives in `regenerable-artifacts.ts` because three call sites need the
 * same knowledge — this guard, the write-guard's deletion check, and the per-task
 * commit — and three private copies would drift.
 */
const isBenignArtifact = isRegenerableArtifact

/**
 * Regenerable machine state that is benign EVEN WHEN TRACKED, so a project that
 * commits it does not have a child's incidental rewrite discard the verdict. Two
 * classes: the component-test build cache under `ctCacheDir`, which a component
 * test run rewrites every time, and the test runner's `.last-run.json` run-state
 * file.
 *
 * DELIBERATELY narrow. Snapshot BASELINE images (`*-snapshots/*.png`) are NOT here:
 * a child that rewrites a baseline to make a screenshot test pass is the real
 * mutate-to-pass catch. Measured on a real repo — a tracked file under a custom
 * `ctCacheDir` and a tracked `.last-run.json` both restore WITHOUT tainting, while
 * a tracked `tests/a-snapshots/x.png` taints.
 */
const ALWAYS_REGENERABLE_PATTERNS: readonly RegExp[] = [/(?:^|\/)\.last-run\.json$/]

/** Playwright config files that may declare a custom `ctCacheDir`. */
const CT_CONFIG_FILES = [
    'playwright-ct.config.ts',
    'playwright-ct.config.js',
    'playwright.config.ts',
    'playwright.config.js'
] as const

/** The ctCacheDir values assumed when no config declares one. Playwright is not a
 *  dependency here, so these are not verifiable against an installed package —
 *  what IS verified is that a config declaring `ctCacheDir: './custom-cache/'` is
 *  parsed and its directory treated as regenerable. */
const DEFAULT_CT_CACHE_DIRS = ['.playwright-cache', 'playwright/.cache']

/**
 * The component-test cache dir(s) for this project: the `ctCacheDir` any Playwright
 * config declares, plus the known defaults. Read once per reconcile (best-effort — a
 * missing/odd config just leaves the defaults). Normalised to a repo-relative prefix.
 */
function readCtCacheDirs(cwd: string): string[] {
    const dirs = new Set<string>(DEFAULT_CT_CACHE_DIRS)
    for (const f of CT_CONFIG_FILES) {
        try {
            const text = readFileSync(path.join(cwd, f), 'utf8')
            const m = /ctCacheDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(text)
            if (m) dirs.add(m[1].replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
        } catch {
            // no such config, or unreadable — defaults stand
        }
    }
    return [...dirs].filter(d => d.length > 0)
}

/** Is this path regenerable machine state that is benign even when tracked-in-HEAD? */
function isAlwaysRegenerable(relPath: string, ctCacheDirs: readonly string[]): boolean {
    const p = relPath.replace(/\\/g, '/')
    if (ALWAYS_REGENERABLE_PATTERNS.some(re => re.test(p))) return true
    return ctCacheDirs.some(d => p === d || p.startsWith(d + '/'))
}

/**
 * Snapshot the worktree content into a tree object via a THROWAWAY index file, so
 * neither the real index nor the stash is touched. Returns null when git cannot
 * build the tree (odd states — the guard then skips tree reconciliation).
 */
async function captureWorktreeTree(git: GitRunner): Promise<string | null> {
    const tmpIndex = path.join(
        os.tmpdir(),
        `pi-task-guard-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
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

/** Capture the repo state a gate child must leave untouched. */
export async function captureGitState(
    cwd: string,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<GitStateSnapshot> {
    const git = makeGit(cwd, signal, spawnFn)
    const disabled: GitStateSnapshot = {
        ok: false,
        headSha: '',
        branchRef: null,
        stashSha: null,
        treeSha: null
    }
    const inside = await git(['rev-parse', '--is-inside-work-tree'])
    if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') return disabled
    const head = await git(['rev-parse', '-q', '--verify', 'HEAD'])
    // An unborn HEAD (fresh init, no commits) has nothing to restore to — disable.
    if (head.exitCode !== 0) return disabled
    const branch = await git(['symbolic-ref', '-q', 'HEAD'])
    const stash = await git(['rev-parse', '-q', '--verify', 'refs/stash'])
    return {
        ok: true,
        headSha: head.stdout.trim(),
        branchRef: branch.exitCode === 0 ? branch.stdout.trim() : null,
        stashSha: stash.exitCode === 0 ? stash.stdout.trim() : null,
        treeSha: await captureWorktreeTree(git)
    }
}

/** Paths tracked in the commit `headSha` points at — the "graded" codebase a gate
 *  child must not rewrite. Empty on any git error (the caller then treats every
 *  modified/deleted path as tracked, i.e. verdict-tainting — fail safe). */
async function trackedPathsAt(git: GitRunner, headSha: string): Promise<Set<string>> {
    const r = await git(['ls-tree', '-r', '--name-only', headSha])
    if (r.exitCode !== 0) return new Set()
    return new Set(
        r.stdout
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.length > 0)
    )
}

/** Cap on itemised path lines per class, so a suite that rewrites hundreds of report
 *  files cannot flood the gate trail. Beyond it, a single "…and N more" line. */
const ITEMIZE_CAP = 20

function pushCapped(actions: string[], verb: string, paths: string[]): void {
    const shown = paths.slice(0, ITEMIZE_CAP)
    for (const p of shown) actions.push(`${verb} ${p}`)
    const extra = paths.length - shown.length
    if (extra > 0) actions.push(`${verb} …and ${extra} more`)
}

/**
 * Restore every file recorded in `beforeTree` (content + deletions) and remove
 * files that exist in `afterTree` but not in `beforeTree` — the ones the child
 * created. Uses a throwaway index seeded from the snapshot tree; `checkout-index
 * -a -f` re-materialises the snapshot verbatim.
 *
 * Returns whether any restored change was *verdict-tainting*: a modified or
 * deleted path that is tracked-in-HEAD, or an untracked non-artifact (see
 * isBenignArtifact). Creations and test-runner-artifact churn restore identically
 * but do NOT taint. Each changed path is itemised, capped, so the gate trail says
 * WHICH files moved.
 */
async function restoreWorktree(
    cwd: string,
    git: GitRunner,
    beforeTree: string,
    afterTree: string,
    tracked: Set<string>,
    ctCacheDirs: readonly string[],
    actions: string[]
): Promise<{tainted: boolean}> {
    const tmpIndex = path.join(
        os.tmpdir(),
        `pi-task-guard-restore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const env = {GIT_INDEX_FILE: tmpIndex}
    let tainted = false
    try {
        // Classify every path the child changed BEFORE touching the tree, so the
        // itemised trail and the taint decision are computed from one diff.
        const created: string[] = []
        const artifactChanges: string[] = []
        const gradedModified: string[] = []
        const gradedDeleted: string[] = []
        const status = await git(['diff-tree', '-r', '--name-status', beforeTree, afterTree])
        if (status.exitCode === 0) {
            for (const line of status.stdout.split('\n')) {
                const trimmed = line.trim()
                if (trimmed.length === 0) continue
                // "M\tpath", "A\tpath", "D\tpath", "T\tpath" — no -M, so a rename
                // shows as a D + an A pair and each half is classified on its own
                // merits. Measured: renaming a tracked `a.txt` to `b.txt` yields
                // "removed child-created file b.txt" plus "restored deleted file
                // a.txt", and taints.
                const tab = trimmed.indexOf('\t')
                if (tab < 0) continue
                const code = trimmed[0]
                const name = trimmed.slice(tab + 1).trim()
                if (name.length === 0) continue
                if (code === 'A') {
                    created.push(name)
                } else if (
                    isAlwaysRegenerable(name, ctCacheDirs)
                    || (isBenignArtifact(name) && !tracked.has(name))
                ) {
                    // Regenerable test/build output — not graded work. Either an
                    // always-regenerable class (ct cache / run-state, benign even when
                    // tracked) or untracked test-runner output.
                    artifactChanges.push(name)
                } else if (code === 'D') {
                    gradedDeleted.push(name)
                    tainted = true
                } else {
                    // M, T, and anything else touching a graded (tracked or
                    // source-shaped untracked) path is the mutate-to-pass class.
                    gradedModified.push(name)
                    tainted = true
                }
            }
        }
        // Files the child created — delete them BEFORE checkout so a restore failure
        // cannot leave both halves stale.
        for (const name of created) {
            await fsp.rm(path.join(cwd, name), {force: true}).catch(() => {})
        }
        pushCapped(actions, 'removed child-created file', created)
        pushCapped(actions, 'restored modified file', gradedModified)
        pushCapped(actions, 'restored deleted file', gradedDeleted)
        pushCapped(actions, 'restored test-runner artifact', artifactChanges)

        const read = await git(['read-tree', beforeTree], env)
        if (read.exitCode !== 0) {
            actions.push('worktree restore FAILED (read-tree)')
            return {tainted}
        }
        const co = await git(['checkout-index', '-a', '-f'], env)
        if (co.exitCode !== 0) actions.push('worktree restore FAILED (checkout-index)')
        return {tainted}
    } finally {
        await fsp.rm(tmpIndex, {force: true}).catch(() => {})
    }
}

/**
 * Compare the repo state against a pre-run snapshot and deterministically undo
 * whatever a gate child moved. Ordering matters:
 *
 *   1. HEAD first — a child parked on another commit must be back on the original
 *      ref before the worktree comparison and restore make sense.
 *   2. Worktree content from the snapshot TREE, never from a stash the child may
 *      have pushed: the snapshot is the authoritative "as the child found it".
 *   3. Child-pushed stash entries are dropped LAST, once the work they swallowed is
 *      already restored — dropping first would destroy the only other copy.
 *
 * Never throws; failures degrade to actions[] lines so the caller can log them.
 */
export async function reconcileGitState(
    cwd: string,
    before: GitStateSnapshot,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<ReconcileResult> {
    if (!before.ok) return {mutated: false, verdictTainted: false, actions: []}
    const git = makeGit(cwd, signal, spawnFn)
    const actions: string[] = []
    // A child that moved HEAD/branch or pushed a stash swallowed graded work — that
    // is unambiguously verdict-tainting. Worktree classification adds to this.
    let tainted = false

    // 1. HEAD / branch.
    const head = await git(['rev-parse', '-q', '--verify', 'HEAD'])
    const branch = await git(['symbolic-ref', '-q', 'HEAD'])
    const headSha = head.exitCode === 0 ? head.stdout.trim() : ''
    const branchRef = branch.exitCode === 0 ? branch.stdout.trim() : null
    if (headSha !== before.headSha || branchRef !== before.branchRef) {
        const target =
            before.branchRef ? before.branchRef.replace(/^refs\/heads\//, '') : before.headSha
        const co = await git(['checkout', '-f', target])
        actions.push(
            co.exitCode === 0 ?
                `checked HEAD back out to ${target}`
            :   `HEAD restore FAILED (checkout ${target})`
        )
        tainted = true
    }

    // 2. Worktree content.
    if (before.treeSha) {
        const afterTree = await captureWorktreeTree(git)
        if (afterTree && afterTree !== before.treeSha) {
            const tracked = await trackedPathsAt(git, before.headSha)
            const ctCacheDirs = readCtCacheDirs(cwd)
            const {tainted: worktreeTainted} = await restoreWorktree(
                cwd,
                git,
                before.treeSha,
                afterTree,
                tracked,
                ctCacheDirs,
                actions
            )
            tainted = tainted || worktreeTainted
        }
    }

    // 3. Stash entries the child pushed. Drop stash@{0} until the ref matches the
    //    snapshot again, bounded at 10 so a runaway cannot loop here. A stash the
    //    child POPPED — the ref is gone or no longer contains the snapshot's tip —
    //    cannot be reconstructed, so report it instead of guessing.
    const stashNow = async (): Promise<string | null> => {
        const s = await git(['rev-parse', '-q', '--verify', 'refs/stash'])
        return s.exitCode === 0 ? s.stdout.trim() : null
    }
    let stash = await stashNow()
    if (stash !== before.stashSha) {
        // A child that pushed/popped a stash moved graded work in or out of the tree
        // (a stash-and-abandon) — always verdict-tainting.
        tainted = true
        if (before.stashSha === null || (await stashContains(git, stash, before.stashSha))) {
            let dropped = 0
            while (stash !== before.stashSha && stash !== null && dropped < 10) {
                const drop = await git(['stash', 'drop', 'stash@{0}'])
                if (drop.exitCode !== 0) break
                dropped++
                stash = await stashNow()
            }
            actions.push(
                stash === before.stashSha ?
                    `dropped ${dropped} stash entr${dropped === 1 ? 'y' : 'ies'} the child pushed`
                :   'stash restore INCOMPLETE (drop failed)'
            )
        } else {
            actions.push('stash ref changed in a way that cannot be undone (entry popped/dropped)')
        }
    }

    return {mutated: actions.length > 0, verdictTainted: tainted, actions}
}

/** Is `ancestorStash` still reachable in the stash reflog chain at `tipSha`? Used to
 *  tell "child pushed on top" (droppable) from "child popped/dropped ours" (not). */
async function stashContains(
    git: GitRunner,
    tipSha: string | null,
    wantedSha: string
): Promise<boolean> {
    if (tipSha === null) return false
    const log = await git(['rev-list', '-g', 'refs/stash'])
    if (log.exitCode !== 0) return false
    return log.stdout
        .split('\n')
        .map(l => l.trim())
        .includes(wantedSha)
}

/**
 * Convenience wrapper for gate call-sites: run `fn` between a capture and a
 * reconcile, and hand back both the result and what (if anything) had to be
 * restored. `fn` errors propagate AFTER the reconcile runs — a crashed child must
 * not skip the restore.
 */
export async function withGitStateGuard<T>(
    cwd: string,
    fn: () => Promise<T>,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<{result: T; reconcile: ReconcileResult}> {
    const before = await captureGitState(cwd, signal, spawnFn)
    try {
        const result = await fn()
        return {result, reconcile: await reconcileGitState(cwd, before, signal, spawnFn)}
    } catch (err) {
        await reconcileGitState(cwd, before, signal, spawnFn).catch(() => {})
        throw err
    }
}
