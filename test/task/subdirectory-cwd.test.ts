/**
 * A task run from a package inside a repo. `git status --porcelain` and the diff
 * family name paths from the repo root; `ls-files`, pathspecs and `path.join(cwd, …)`
 * read them from cwd. Every site below mixed the two, so from `app/` it read the
 * wrong file, missed an artifact, or failed open.
 */
import {expect, setDefaultTimeout, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {makeGit, statusFromCwd} from '../../src/shared/git-runner.js'
import {
    collectChangedFiles,
    collectIgnoredSnapshot,
    collectTaskTreeChanges,
    collectTreeChanges
} from '../../src/task/gate-deps.js'
import {captureCommitDiff} from '../../src/task/enforce-guidelines.js'
import {captureGitState, reconcileGitState} from '../../src/task/git-state-guard.js'
import {lazyHealthBaseline} from '../../src/task/health-baseline.js'
import {gitCommitAll} from '../../src/task/auto-commit.js'

// Real git subprocesses, several per test.
setDefaultTimeout(30_000)

function repo(): {dir: string; app: string; g: (...a: string[]) => string} {
    const dir = tmpDir('pi-subdir-')
    const g = (...a: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
            cwd: dir,
            encoding: 'utf8'
        }).trim()
    g('init', '-q', '-b', 'main')
    g('config', 'core.autocrlf', 'false')
    const app = path.join(dir, 'app')
    fs.mkdirSync(app)
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 1\n')
    fs.writeFileSync(path.join(app, '.gitignore'), '.env\n')
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'base')
    return {dir, app, g}
}

test('statusFromCwd names every path from cwd', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(app, 'my new.ts'), 'x\n')
    const r = await statusFromCwd(makeGit(app), ['--', '.'])
    expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual([' M a.ts', '?? "my new.ts"'])
})

test('the tree changes name the edited file from cwd', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await collectTreeChanges(app)).modified).toEqual(['a.ts'])
})

test('the committed fallback names the file from cwd', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    g('commit', '-qam', 'work')
    expect((await collectTaskTreeChanges(app)).modified).toEqual(['a.ts'])
})

test('the changed-file probe reads the file it names', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await collectChangedFiles(app)).map(f => f.path)).toEqual(['a.ts'])
})

test('a write to an ignored .env is in the snapshot', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, '.env'), 'A=1\n')
    expect(Object.keys(await collectIgnoredSnapshot(app))).toEqual(['.env'])
})

test('the enforce child is told files it can open', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    g('commit', '-qam', 'work')
    const text = await captureCommitDiff(app)
    expect(text).toContain('\n- a.ts')
    expect(text).not.toContain('app/a.ts')
})

// The guard's tracked set comes from `ls-tree`, which names from cwd. Matching it
// against root names read a tracked artifact as untracked: benign, not graded.
test('a rewrite of a TRACKED test-results file still taints', async () => {
    const {app, g} = repo()
    fs.mkdirSync(path.join(app, 'test-results'))
    fs.writeFileSync(path.join(app, 'test-results', 'r.json'), '{}\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'tracked artifact')
    const snap = await captureGitState(app)
    fs.writeFileSync(path.join(app, 'test-results', 'r.json'), '{"x":1}\n')
    expect((await reconcileGitState(app, snap)).verdictTainted).toBe(true)
})

test('the lazy baseline runs in the same package of its worktree', async () => {
    const {app} = repo()
    let ran = ''
    await lazyHealthBaseline({
        git: makeGit(app),
        runHealthIn: d => {
            ran = d
            return Promise.resolve({
                ok: true,
                reason: 'passed',
                ecosystem: 'none',
                output: '',
                commands: []
            })
        }
    })
    expect(path.basename(ran)).toBe('app')
})

test("a task's commit leaves a sibling package's edit alone", async () => {
    const {dir, app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe('app/a.ts')
})
