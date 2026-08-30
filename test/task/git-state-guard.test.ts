/**
 * git-state-guard tests — run against REAL throwaway git repos in temp dirs. The
 * module is git plumbing, so a mocked spawn would only test the mock. One scenario
 * per mutation class the guard must undo: stash-and-abandon, checkout-and-stay,
 * a `--fix`-style file rewrite, junk-file creation, and untracked-file deletion.
 */
import {describe, expect, setDefaultTimeout, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    captureGitState,
    reconcileGitState,
    withGitStateGuard
} from '../../src/task/git-state-guard.js'

// makeRepo alone spawns four real git subprocesses (init, config, add, commit) and
// several tests add more. A machine that scans that file I/O can blow bun's default
// per-test timeout inside makeRepo, which surfaces as `git commit` taking a SIGTERM
// with empty output rather than as an assertion. The classification under test has
// no time budget of its own, so the subprocesses get room.
setDefaultTimeout(30_000)

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'] as const

function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...IDENTITY, ...args], {cwd, encoding: 'utf8'}).trim()
}

/** A fresh repo with one committed file, one tracked-and-modified file, and one
 *  untracked file — the shape of a task's uncommitted work at verify time. */
function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-guard-test-'))
    git(dir, 'init', '-q', '-b', 'main')
    // Repo-level, not on this file's git() helper alone, so the product's own git
    // calls during reconcile round-trip the LF fixtures byte-for-byte too.
    git(dir, 'config', 'core.autocrlf', 'false')
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

    test('stash-and-abandon: work restored, landmine stash dropped', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        // The child stashes everything, looks around, and never pops.
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

// A gate child that only left test-runner output behind judged an equivalent tree,
// so its verdict must stand and only the artifacts are cleaned. Every restored path
// is itemised, so the trail says WHICH files moved rather than that some did.
describe('verdict-taint classification', () => {
    test('created untracked test-results file → cleaned, verdict NOT tainted, itemised', async () => {
        const dir = makeRepo()
        const snap = await captureGitState(dir)
        // Fresh Playwright failure artifact — untracked, not gitignored.
        fs.mkdirSync(path.join(dir, 'test-results', 'foo-chromium'), {recursive: true})
        fs.writeFileSync(
            path.join(dir, 'test-results', 'foo-chromium', 'error-context.md'),
            'ctx\n'
        )
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(true)
        expect(rec.verdictTainted).toBe(false)
        expect(
            fs.existsSync(path.join(dir, 'test-results', 'foo-chromium', 'error-context.md'))
        ).toBe(false)
        expect(
            rec.actions.some(a => a.startsWith('removed child-created file test-results/'))
        ).toBe(true)
    })

    test('modified pre-existing untracked artifact (.last-run.json rerun) → not tainted, itemised', async () => {
        const dir = makeRepo()
        // Playwright left this from an earlier turn; it is untracked and pre-exists.
        fs.mkdirSync(path.join(dir, 'test-results'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'test-results', '.last-run.json'), 'old\n')
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'test-results', '.last-run.json'), 'new-run\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.mutated).toBe(true)
        expect(rec.verdictTainted).toBe(false)
        // Content restored, and the trail names the exact artifact.
        expect(fs.readFileSync(path.join(dir, 'test-results', '.last-run.json'), 'utf8')).toBe(
            'old\n'
        )
        expect(rec.actions).toContain('restored test-runner artifact test-results/.last-run.json')
    })

    test('modified TRACKED source file → verdict tainted, path itemised (not a generic string)', async () => {
        const dir = makeRepo()
        // Commit src.ts so it is tracked-in-HEAD (graded).
        git(dir, 'add', 'src.ts')
        git(dir, 'commit', '-q', '-m', 'track src')
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 999 // hacked\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(true)
        expect(rec.actions).toContain('restored modified file src.ts')
        expect(fs.readFileSync(path.join(dir, 'src.ts'), 'utf8')).toBe(
            'export const a = 2 // work in progress\n'
        )
    })

    test('modified UNTRACKED non-artifact (impl new source) → tainted (closes the hole)', async () => {
        const dir = makeRepo() // new-work.ts is untracked, source-shaped
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'new-work.ts'), 'export const fresh = false // to pass\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(true)
        expect(rec.actions).toContain('restored modified file new-work.ts')
    })

    test('artifact-pattern path that is TRACKED is graded, not benign', async () => {
        const dir = makeRepo()
        // A project that commits its dist/ — editing it IS graded work.
        fs.mkdirSync(path.join(dir, 'dist'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'v1\n')
        git(dir, 'add', 'dist/bundle.js')
        git(dir, 'commit', '-q', '-m', 'track dist')
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'dist', 'bundle.js'), 'v2\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(true)
        expect(rec.actions).toContain('restored modified file dist/bundle.js')
    })

    // A project can COMMIT its ctCacheDir build cache and the runner's
    // `.last-run.json`. Both are regenerable machine state, so the tracked→graded
    // rule must not apply to them, while snapshot baseline PNGs stay tainting.
    test('tracked ctCacheDir + .last-run.json rewrites are NOT verdict-tainting', async () => {
        const dir = makeRepo()
        fs.mkdirSync(path.join(dir, '.playwright-cache', 'assets'), {recursive: true})
        fs.writeFileSync(
            path.join(dir, '.playwright-cache', 'assets', 'AdminPage-CR5IyFZM.js'),
            'v1\n'
        )
        fs.writeFileSync(path.join(dir, '.playwright-cache', 'index.html'), '<html>v1</html>\n')
        fs.mkdirSync(path.join(dir, 'test-results'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'test-results', '.last-run.json'), '{"status":"passed"}\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'commit ct cache + last-run')
        const snap = await captureGitState(dir)
        // The gate child runs `test:ct`, which rewrites the cache + run state.
        fs.writeFileSync(
            path.join(dir, '.playwright-cache', 'assets', 'AdminPage-CR5IyFZM.js'),
            'v2\n'
        )
        fs.writeFileSync(path.join(dir, '.playwright-cache', 'index.html'), '<html>v2</html>\n')
        fs.writeFileSync(path.join(dir, 'test-results', '.last-run.json'), '{"status":"failed"}\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(false)
        expect(rec.mutated).toBe(true) // still restored + itemised, just not tainting
        expect(rec.actions.some(a => a.includes('.playwright-cache/'))).toBe(true)
    })

    test('a tracked snapshot BASELINE png rewrite STAYS verdict-tainting (the real catch)', async () => {
        const dir = makeRepo()
        const snapDir = path.join(dir, 'tests', 'components', 'Select.ct.tsx-snapshots')
        fs.mkdirSync(snapDir, {recursive: true})
        const png = path.join(snapDir, 'Select-renders-select-with-options-1-chromium-linux.png')
        fs.writeFileSync(png, 'baseline-v1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'commit snapshot baselines')
        const snap = await captureGitState(dir)
        // A child that rewrites a baseline to make a screenshot test pass — mutate-to-pass.
        fs.writeFileSync(png, 'baseline-mutated-to-pass\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(true)
    })

    test('combined: ct-cache churn is benign but a co-occurring baseline rewrite taints', async () => {
        const dir = makeRepo()
        fs.mkdirSync(path.join(dir, '.playwright-cache', 'assets'), {recursive: true})
        fs.writeFileSync(path.join(dir, '.playwright-cache', 'assets', 'Badge-CqnzweoZ.js'), 'v1\n')
        const snapDir = path.join(dir, 'tests', 'components', 'LoginPage.ct.tsx-snapshots')
        fs.mkdirSync(snapDir, {recursive: true})
        const png = path.join(snapDir, 'LoginPage-renders-1-chromium-linux.png')
        fs.writeFileSync(png, 'baseline-v1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'commit cache + baseline')
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, '.playwright-cache', 'assets', 'Badge-CqnzweoZ.js'), 'v2\n')
        fs.writeFileSync(png, 'mutated\n')
        const rec = await reconcileGitState(dir, snap)
        // The PNG is the real mutate-to-pass — verdict must be discarded despite the
        // benign cache churn alongside it.
        expect(rec.verdictTainted).toBe(true)
    })

    test('a custom ctCacheDir declared in playwright-ct.config.ts is honoured', async () => {
        const dir = makeRepo()
        fs.writeFileSync(
            path.join(dir, 'playwright-ct.config.ts'),
            'export default defineConfig({ use: { ctCacheDir: "./build/ct-cache" } })\n'
        )
        fs.mkdirSync(path.join(dir, 'build', 'ct-cache'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'build', 'ct-cache', 'bundle.js'), 'v1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'commit custom ct cache')
        const snap = await captureGitState(dir)
        fs.writeFileSync(path.join(dir, 'build', 'ct-cache', 'bundle.js'), 'v2\n')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(false)
    })

    test('HEAD move and stash push are verdict-tainting', async () => {
        const dir = makeRepo()
        git(dir, 'add', '-A')
        git(dir, 'commit', '-q', '-m', 'second')
        const snap = await captureGitState(dir)
        git(dir, 'checkout', '-q', 'HEAD~1')
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(true)
    })

    test('many changed artifact files are itemised but capped at 20 + "…and N more"', async () => {
        const dir = makeRepo()
        fs.mkdirSync(path.join(dir, 'test-results'), {recursive: true})
        for (let i = 0; i < 25; i++) {
            fs.writeFileSync(path.join(dir, 'test-results', `r${i}.txt`), `v${i}\n`)
        }
        const snap = await captureGitState(dir)
        for (let i = 0; i < 25; i++) {
            fs.writeFileSync(path.join(dir, 'test-results', `r${i}.txt`), `changed${i}\n`)
        }
        const rec = await reconcileGitState(dir, snap)
        expect(rec.verdictTainted).toBe(false)
        const itemised = rec.actions.filter(a => a.startsWith('restored test-runner artifact '))
        // ITEMIZE_CAP concrete paths, then one "…and N more" line for the rest.
        expect(itemised.length).toBe(21)
        expect(itemised.some(a => a === 'restored test-runner artifact …and 5 more')).toBe(true)
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
