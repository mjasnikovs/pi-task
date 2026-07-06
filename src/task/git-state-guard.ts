/**
 * git-state-guard — deterministic repo-state snapshot/reconcile around the
 * read-only gate children (verify, recommend).
 *
 * The failure this closes (proven twice on mx5): those children hold a `read,bash`
 * contract whose "never modify the tree" clause is prompt-level only, and the live
 * local model breaks it. Run 6's verify child ran `git stash; git checkout HEAD~1;
 * tsc; git checkout HEAD` with NO pop — the task's whole uncommitted implementation
 * vanished into a stash, the verify judged an empty tree (a full re-implementation
 * was burned), and the orphaned stash detonated two days later when a later impl
 * turn popped it onto a 14-commits-newer HEAD (unresolvable UU conflict, the
 * /task-auto checklist reverted to a stale state). The same child has been observed
 * running `eslint --fix .` mid-verification and ad-hoc DDL against the test DB.
 *
 * Prompt rules are evidence-insufficient for this class (FROZEN-CONTRACT framing
 * A/B'd 0–1/5 compliance), so this is a capability-shaped fix: snapshot the repo
 * state BEFORE the child runs, and afterwards deterministically restore anything
 * it moved — no model in the loop.
 *
 * What is captured / reconciled:
 *   - HEAD (sha + symbolic branch ref): a child that checked out another commit
 *     and never came back is checked back out.
 *   - The WORKTREE CONTENT as a git tree object, built through a temporary index
 *     (`read-tree --empty` + `add -A` + `write-tree`, excluding .pi-tasks — the
 *     gate's own debug logs land there DURING the run). This snapshots tracked
 *     *and* untracked (non-ignored) files without touching the real index or the
 *     stash. Restoration re-materialises every changed/deleted file from the
 *     snapshot tree and deletes files the child created.
 *   - The STASH ref: entries the child pushed are dropped AFTER the worktree is
 *     restored from the snapshot (the snapshot, not the stash, is the source of
 *     truth), so no landmine stash survives the reconcile.
 *
 * The real index's staging state is deliberately NOT restored: pre-commit gate
 * children run against a tree whose work is unstaged, and the auto-commit that
 * follows re-stages everything with `add -A` anyway.
 *
 * Everything is best-effort: a repo where git itself fails (not a work tree, git
 * missing) disables the guard (capture returns ok:false and reconcile no-ops) —
 * the gate must keep working in non-git projects exactly as before.
 */
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {runChildDefault, type SpawnFn} from '../shared/child-process.js'

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
    /** true → the child moved repo state; every detected move was restored. */
    mutated: boolean
    /** Human-readable restore actions, for the debug log / notify / gate trail. */
    actions: string[]
}

interface GitRunner {
    (
        args: string[],
        env?: Record<string, string>
    ): Promise<{
        stdout: string
        exitCode: number
    }>
}

function makeGit(cwd: string, signal?: AbortSignal, spawnFn?: SpawnFn): GitRunner {
    return async (args, env) => {
        const r = await runChildDefault(
            {command: 'git', args, ...(env ? {env: {...process.env, ...env}} : {})},
            cwd,
            signal,
            {mode: 'text'},
            spawnFn
        )
        return {stdout: r.stdout, exitCode: r.exitCode}
    }
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

/**
 * Restore every file recorded in `beforeTree` (content + deletions) and remove
 * files that exist in `afterTree` but not in `beforeTree` (files the child
 * created). Uses a throwaway index seeded from the snapshot tree; `checkout-index
 * -a -f` re-materialises the snapshot verbatim.
 */
async function restoreWorktree(
    cwd: string,
    git: GitRunner,
    beforeTree: string,
    afterTree: string,
    actions: string[]
): Promise<void> {
    const tmpIndex = path.join(
        os.tmpdir(),
        `pi-task-guard-restore-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    )
    const env = {GIT_INDEX_FILE: tmpIndex}
    try {
        // Files present only in afterTree were created by the child — delete them
        // BEFORE checkout so a restore failure cannot leave both halves stale.
        const added = await git([
            'diff-tree',
            '-r',
            '--diff-filter=A',
            '--name-only',
            beforeTree,
            afterTree
        ])
        if (added.exitCode === 0) {
            for (const rel of added.stdout.split('\n')) {
                const name = rel.trim()
                if (name.length === 0) continue
                await fsp.rm(path.join(cwd, name), {force: true}).catch(() => {})
                actions.push(`removed child-created file ${name}`)
            }
        }
        const read = await git(['read-tree', beforeTree], env)
        if (read.exitCode !== 0) {
            actions.push('worktree restore FAILED (read-tree)')
            return
        }
        const co = await git(['checkout-index', '-a', '-f'], env)
        actions.push(
            co.exitCode === 0 ?
                'restored worktree files from pre-run snapshot'
            :   'worktree restore FAILED (checkout-index)'
        )
    } finally {
        await fsp.rm(tmpIndex, {force: true}).catch(() => {})
    }
}

/**
 * Compare the repo state against a pre-run snapshot and deterministically undo
 * whatever a gate child moved. Ordering matters:
 *
 *   1. HEAD first — a child parked on another commit must be back on the original
 *      ref before the worktree comparison/restore makes sense.
 *   2. Worktree content from the snapshot TREE (not from any stash the child may
 *      have pushed — the snapshot is the authoritative "as the child found it").
 *   3. Child-pushed stash entries are dropped LAST, once the work they swallowed
 *      is already restored — this is exactly the orphan that detonated mx5 run 6.
 *
 * Never throws; failures degrade to actions[] lines so the caller can log them.
 */
export async function reconcileGitState(
    cwd: string,
    before: GitStateSnapshot,
    signal?: AbortSignal,
    spawnFn?: SpawnFn
): Promise<ReconcileResult> {
    if (!before.ok) return {mutated: false, actions: []}
    const git = makeGit(cwd, signal, spawnFn)
    const actions: string[] = []

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
    }

    // 2. Worktree content.
    if (before.treeSha) {
        const afterTree = await captureWorktreeTree(git)
        if (afterTree && afterTree !== before.treeSha) {
            await restoreWorktree(cwd, git, before.treeSha, afterTree, actions)
        }
    }

    // 3. Stash entries the child pushed. Drop stash@{0} until the ref matches the
    //    snapshot again (bounded — a child pushes at most a handful; 10 is beyond
    //    anything observed). A stash the child POPPED (ref gone/behind) cannot be
    //    reconstructed — report it instead of guessing.
    const stashNow = async (): Promise<string | null> => {
        const s = await git(['rev-parse', '-q', '--verify', 'refs/stash'])
        return s.exitCode === 0 ? s.stdout.trim() : null
    }
    let stash = await stashNow()
    if (stash !== before.stashSha) {
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

    return {mutated: actions.length > 0, actions}
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
