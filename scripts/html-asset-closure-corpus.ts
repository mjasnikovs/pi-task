/**
 * Shared corpus for nexttask 3 — HTML asset references inside generated HTML.
 *
 * WHY SNAPSHOTS AND NOT THE LIVE TREE. The evidence for this task lives at three
 * specific mx5 commits (the base before any build.ts, the pre-autofix run-13
 * state, and the post-autofix state that shipped a page pointing at `/app.css`).
 * `~/hub/mx5` is evidence and is READ-ONLY: nothing here checks it out, adds a
 * worktree, or touches its index. Each commit is exported with `git archive`
 * into a cache dir and scanned there.
 *
 * The export is also the more faithful condition. `dist/` is gitignored in mx5,
 * so a fresh clone has NO build outputs — exactly the state the final gate sees
 * before it runs `bun run build`, and exactly why the "count what's in
 * dist/index.html on disk" alternative was rejected (nexttask 3, GRAY AREAS).
 *
 * The non-mx5 trees are scanned live and read-only (the extractor only reads).
 */
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, rmSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const HUB = path.join(os.homedir(), 'hub')
export const REPO = path.resolve(import.meta.dir, '..')
export const MX5 = path.join(HUB, 'mx5')

const CACHE = path.join(os.homedir(), '.cache', 'pi-task-html-closure')

/** mx5 commits this task's evidence is pinned to. */
export const MX5_COMMITS = {
    /** 'base' — before any build.ts exists at all. */
    base: '407e542',
    /** The commit the run-13 true positive was measured on (pre-autofix). */
    preAutofix: '4880e79',
    /** FINAL GATE AUTOFIX — build.ts now emits index.html referencing /app.css. */
    postAutofix: 'a9c6145'
} as const

/**
 * Export one mx5 commit into a throwaway tree and return its path (null when the
 * evidence repo is unavailable — callers ABSTAIN). Cached per commit; `git
 * archive` reads the object store only.
 */
export function mx5Snapshot(commit: string): string | null {
    if (!existsSync(path.join(MX5, '.git'))) return null
    const dest = path.join(CACHE, commit)
    if (existsSync(path.join(dest, 'package.json'))) return dest
    rmSync(dest, {recursive: true, force: true})
    mkdirSync(dest, {recursive: true})
    const ar = spawnSync('sh', ['-c', `git archive --format=tar ${commit} | tar -x -C '${dest}'`], {
        cwd: MX5,
        encoding: 'utf8'
    })
    if (ar.status !== 0) {
        rmSync(dest, {recursive: true, force: true})
        return null
    }
    return dest
}

export interface CorpusTree {
    label: string
    /** Absolute path, or null when unavailable on this box. */
    dir: string | null
    /** What nexttask 3 pre-registers for this tree, for the report banner. */
    expectation: string
}

/** The scan corpus: three pinned mx5 states plus every real tree the FP suite uses. */
export function buildCorpus(): CorpusTree[] {
    return [
        {
            label: `mx5 @ ${MX5_COMMITS.postAutofix} (post-autofix)`,
            dir: mx5Snapshot(MX5_COMMITS.postAutofix),
            expectation: '2 refs: /main.js (produced), /app.css (dev-only producer) — 1 dangling'
        },
        {
            label: `mx5 @ ${MX5_COMMITS.preAutofix} (pre-autofix, run-13 TP)`,
            dir: mx5Snapshot(MX5_COMMITS.preAutofix),
            expectation: '0 generated-HTML refs (build.ts emits no HTML yet)'
        },
        {
            label: `mx5 @ ${MX5_COMMITS.base} (base)`,
            dir: mx5Snapshot(MX5_COMMITS.base),
            expectation: '0 (no build.ts)'
        },
        {label: 'aiz-client', dir: liveTree(path.join(HUB, 'aiz-client')), expectation: 'record'},
        {label: 'aiz-server', dir: liveTree(path.join(HUB, 'aiz-server')), expectation: '0'},
        {label: 'gofer', dir: liveTree(path.join(HUB, 'gofer')), expectation: '0'},
        {label: 'pi-task (self)', dir: liveTree(REPO), expectation: '0'}
    ]
}

function liveTree(dir: string): string | null {
    return existsSync(dir) ? dir : null
}
