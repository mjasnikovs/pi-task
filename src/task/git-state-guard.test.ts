/**
 * git-state-guard tests — run against REAL throwaway git repos (temp dirs), since
 * the module's whole job is faithful git plumbing; a mocked spawn would test the
 * mock. Each scenario replays a mutation class actually observed from a live gate
 * child (mx5 runs 4/6): stash-and-abandon, checkout-and-stay, `--fix`-style file
 * rewrites, junk file creation, and untracked-file deletion.
 */
import {describe, expect, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {captureGitState, reconcileGitState, withGitStateGuard} from './git-state-guard.js'

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'] as const

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...IDENTITY, ...args], {cwd, encoding: 'utf8'}).trim()
}

/** A fresh repo with one committed file, one tracked-and-modified file, and one
 *  untracked file — the shape of a task's uncommitted work at verify time. */
function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-test-'))
    git(dir, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(dir, 'committed.txt'), 'committed v1\n')
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 1\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'base')
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 2 // work in progress\n')
    fs.writeFileSync(path.join(dir, 'new-work.ts'), 'export const fresh = true\n')
    return dir
}

describe('captureGitState', () => {
    test('non-git directory disables the guard', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-nogit-'))
        const snap = await captureGitState(dir)
        expect(snap.ok).toBe(false)
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(false)
        expect(rec.actions).toEqual([])
    })

    test('captures HEAD, branch, and a worktree tree including untracked files', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        expect(snap.ok).toBe(true)
        expect(snap.headSha).toMatch(/^[0-9a-f]{40}$/)
        expect(snap.branchRef).toBe('refs/heads/main')
        expect(snap.stashSha).toBeNull()
        expect(snap.treeSha).toMatch(/^[0-9a-f]{40}$/)
    })
})

describe('reconcileGitState', () => {
    test('untouched repo → no mutation reported', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(false)
        expect(rec.actions).toEqual([])
    })

    test('stash-and-abandon (mx5 run 6): work restored, landmine stash dropped', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        // The observed child behavior: stash everything, poke around, never pop.
        git(dir, 'stash', '-q', '--include-untracked')
        expect(fs.existsSync(path.join(dir, 'new-work.ts'))).toBe(false)
        expect(fs.readFileSync(path.join(dir, 'src.ts'), 'utf8')).toBe('export const a = 1\n')

        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(true)
        // The uncommitted work is back, from the snapshot tree…
        expect(fs.readFileSync(path.join(dir, 'src.ts'), 'utf8')).toBe(
            'export const a = 2 // work in progress\n'
        )
        expect(fs.readFileSync(path.join(dir, 'new-work.ts'), 'utf8')).toBe(
            'export const fresh = true\n'
        )
        // …and the orphan stash no longer exists to detonate later.
        expect(() => git(dir, 'rev-parse', '-q', '--verify', 'refs/stash')).toThrow()
    })

    test('checkout-and-stay: HEAD returned to the original branch', async () => {
        const dir = makeRepo()
        // Need a second commit so HEAD~1 exists; keep the tree clean for checkout.
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'second')
        const snap = await captureGitState(dir)
        git(dir, 'checkout', '-q', 'HEAD~1')

        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(true)
        expect(git(dir, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main')
        expect(git(dir, 'rev-parse', 'HEAD')).toBe(snap.headSha)
    })

    test('file rewrite (eslint --fix class) is restored from the snapshot', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 2;\n') // "fixed"
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(true)
        expect(fs.readFileSync(path.join(dir, 'src.ts'), 'utf8')).toBe(
            'export const a = 2 // work in progress\n'
        )
    })

    test('child-created junk file is deleted; child-deleted untracked file returns', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'probe-junk.mjs'), 'console.log(1)\n')
        fs.rmSync(path.join(dir, 'new-work.ts'))
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(true)
        expect(fs.existsSync(path.join(dir, 'probe-junk.mjs'))).toBe(false)
        expect(fs.readFileSync(path.join(dir, 'new-work.ts'), 'utf8')).toBe(
            'export const fresh = true\n'
        )
    })

    test('.pi-tasks writes during the child (gate debug logs) are NOT a mutation', async () => {
        const dir = makeRepo()
        fs.mkdirSync(path.join(dir, '.pi-tasks'))
        fs.writeFileSync(path.join(dir, '.pi-tasks', 'verify-debug.log'), 'start\n')
        const snap = await captureGitState(dir)
        fs.appendFileSync(path.join(dir, '.pi-tasks', 'verify-debug.log'), 'line from child\n')
        fs.writeFileSync(path.join(dir, '.pi-tasks', 'TASK_0001.md'), 'gate trail\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(false)
        // And the log the child appended is untouched.
        expect(fs.readFileSync(path.join(dir, '.pi-tasks', 'verify-debug.log'), 'utf8')).toBe(
            'start\nline from child\n'
        )
    })

    test('pre-existing stash the child did not touch stays put', async () => {
        const dir = makeRepo()
        git(dir, 'stash', '-q') // user's own stash, before the gate
        fs.writeFileSync(path.join(dir, 'other.ts'), 'work\n')
        const snap = await captureGitState(dir)
        expect(snap.stashSha).toMatch(/^[0-9a-f]{40}$/)
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(false)
        expect(git(dir, 'rev-parse', 'refs/stash')).toBe(snap.stashSha as string)
    })
})

describe('withGitStateGuard', () => {
    test('returns the child result and the reconcile outcome', async () => {
        const dir = makeRepo()
        const {result, reconcile} = await withGitStateGuard(dir, async () => {
            git(dir, 'stash', '-q', '--include-untracked')
            return 'verdict text'
        })
        expect(result).toBe('verdict text')
        expect(reconcile.mutated).toBe(true)
        expect(fs.existsSync(path.join(dir, 'new-work.ts'))).toBe(true)
    })

    test('reconciles even when the child throws, then rethrows', async () => {
        const dir = makeRepo()
        await expect(
            withGitStateGuard(dir, async () => {
                fs.writeFileSync(path.join(dir, 'src.ts'), 'trashed\n')
                throw new Error('child crashed')
            })
        ).rejects.toThrow('child crashed')
        expect(fs.readFileSync(path.join(dir, 'src.ts'), 'utf8')).toBe(
            'export const a = 2 // work in progress\n'
        )
    })
})
