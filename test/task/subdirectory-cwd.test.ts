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
import {gitCommitAll, gitDropLastCommit} from '../../src/task/auto-commit.js'
import {revertFrozenPaths} from '../../src/task/frozen-path-guard.js'

// Real git subprocesses, several per test.
setDefaultTimeout(30_000)

function repo(pkg = 'app'): {dir: string; app: string; g: (...a: string[]) => string} {
    const dir = tmpDir('pi-subdir-')
    const g = (...a: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
            cwd: dir,
            encoding: 'utf8'
        }).trim()
    g('init', '-q', '-b', 'main')
    g('config', 'core.autocrlf', 'false')
    const app = path.join(dir, pkg)
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

// Porcelain octal-escapes a non-ASCII path, and the raw prefix never matched it.
test('statusFromCwd names a path in a non-ASCII package from cwd', async () => {
    const {app} = repo('pkg-ü')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    const r = await statusFromCwd(makeGit(app), ['--', '.'])
    expect(r.stdout.trim()).toBe('M a.ts')
})

// A pathspec can reach outside cwd. Its root name read from cwd is another file.
test('statusFromCwd names a path outside cwd as one cwd can open', async () => {
    const {dir, app} = repo()
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    const r = await statusFromCwd(makeGit(app), ['--', '../sibling.ts'])
    expect(r.stdout.trim()).toBe('M ../sibling.ts')
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

// `git add -- .` scoped the staging, but the commit took the whole index.
test("a task's commit leaves out a sibling's staged edit", async () => {
    const {dir, app, g} = repo()
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    g('add', 'sibling.ts')
    expect((await gitCommitAll(app, 'task')).reason).toBe('nothing to commit')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-only', '--format=', 'HEAD')).toBe('app/a.ts')
    expect(g('diff', '--cached', '--name-only')).toBe('sibling.ts')
})

test("a task's commit records a file it deleted", async () => {
    const {app, g} = repo()
    fs.rmSync(path.join(app, 'a.ts'))
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('show', '--name-status', '--format=', 'HEAD')).toBe('D\tapp/a.ts')
})

// The task commit no longer holds a sibling's edit, so a repo-wide reset of the
// enforce commit threw it away.
test("dropping the enforce commit keeps a sibling's uncommitted edit", async () => {
    const {dir, app, g} = repo()
    fs.writeFileSync(path.join(dir, 'sibling.ts'), 'export const s = 2\n')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    await gitCommitAll(app, 'task')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    fs.writeFileSync(path.join(app, 'added.ts'), 'x\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    await gitDropLastCommit(app)
    expect(g('log', '-1', '--format=%s')).toBe('task')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 2\n')
    expect(fs.existsSync(path.join(app, 'added.ts'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'sibling.ts'), 'utf8')).toBe('export const s = 2\n')
    expect(g('status', '--porcelain')).toBe('M sibling.ts')
})

test('a frozen-path revert names the files it reverted from cwd', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await revertFrozenPaths(['a.ts'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

// A file name is a glob to a pathspec: `[pkg]/a.ts` also names `p/a.ts`.
test('dropping the enforce commit keeps a sibling whose name its files match as a glob', async () => {
    const {dir, app, g} = repo('[pkg]')
    fs.mkdirSync(path.join(dir, 'p'))
    fs.writeFileSync(path.join(dir, 'p', 'a.ts'), 'export const p = 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'task')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    fs.writeFileSync(path.join(dir, 'p', 'a.ts'), 'export const p = 2\n')
    const dropped = await gitDropLastCommit(app)
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.readFileSync(path.join(dir, 'p', 'a.ts'), 'utf8')).toBe('export const p = 2\n')
    expect(dropped).toBe(true)
})

test('dropping the enforce commit works under a diff.relative config', async () => {
    const {app, g} = repo()
    g('config', 'diff.relative', 'true')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    const dropped = await gitDropLastCommit(app)
    expect(g('log', '-1', '--format=%s')).toBe('base')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(dropped).toBe(true)
})

// The re-verify's build can rewrite a tracked file after the enforce commit.
test('dropping the enforce commit discards what the re-verify wrote in cwd', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 3\n')
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 4\n')
    fs.writeFileSync(path.join(app, '.gitignore'), 'built\n')
    const dropped = await gitDropLastCommit(app)
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.readFileSync(path.join(app, '.gitignore'), 'utf8')).toBe('.env\n')
    expect(g('status', '--porcelain')).toBe('')
    expect(dropped).toBe(true)
})

test('a drop that cannot happen says so', async () => {
    const {app} = repo()
    expect(await gitDropLastCommit(app)).toBe(false)
})

test('a drop that cannot happen leaves cwd as it was', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await gitDropLastCommit(app)).toBe(false)
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 2\n')
})

// The enforce commit deleted a file, and the re-verify's build wrote it back untracked.
test('dropping the enforce commit restores a deleted file the re-verify wrote back', async () => {
    const {app, g} = repo()
    fs.rmSync(path.join(app, 'a.ts'))
    await gitCommitAll(app, 'ENFORCE GUIDELINES')
    fs.writeFileSync(path.join(app, 'a.ts'), 'built\n')
    const dropped = await gitDropLastCommit(app)
    expect(dropped).toBe(true)
    expect(g('log', '-1', '--format=%s')).toBe('base')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

// git refuses a commit with a pathspec while a merge is in progress.
test("a task's commit concludes a merge in progress", async () => {
    const {app, g} = repo()
    g('checkout', '-q', '-b', 'other')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 5\n')
    g('commit', '-qam', 'other')
    g('checkout', '-q', 'main')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 6\n')
    g('commit', '-qam', 'main')
    try {
        g('merge', '-q', 'other')
    } catch {
        // the conflict is the point
    }
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 7\n')
    g('add', 'app/a.ts')
    expect((await gitCommitAll(app, 'task')).committed).toBe(true)
    expect(g('rev-list', '--parents', '-1', 'HEAD').split(' ')).toHaveLength(3)
})

// rev-parse prints the prefix as it is, and a directory name can begin with a space.
test('the tree changes name a file in a package whose name starts with a space', async () => {
    const {app} = repo(' app')
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect((await collectTreeChanges(app)).modified).toEqual(['a.ts'])
})

// Status names a non-ASCII path as it is; the committed fallback must match it.
test('the committed fallback names a non-ASCII file as status does', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'ü.ts'), 'x\n')
    expect((await collectTreeChanges(app)).added).toEqual(['ü.ts'])
    g('add', '-A')
    g('commit', '-q', '-m', 'work')
    expect((await collectTaskTreeChanges(app)).added).toEqual(['ü.ts'])
})

// One untracked name in a checkout's pathspec fails the whole checkout.
test('a frozen-path revert of an edit and a new file undoes both', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(app, 'new.ts'), 'x\n')
    expect((await revertFrozenPaths(['a.ts', 'new.ts'], makeGit(app))).sort()).toEqual([
        'a.ts',
        'new.ts'
    ])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.existsSync(path.join(app, 'new.ts'))).toBe(false)
})

test('a frozen-path revert undoes an edit beside a frozen path that does not exist', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    expect(await revertFrozenPaths(['a.ts', 'never.md'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

test('a frozen-path revert undoes an edit beside a wholly new frozen directory', async () => {
    const {app} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.mkdirSync(path.join(app, 'fresh'))
    fs.writeFileSync(path.join(app, 'fresh', 'f.ts'), 'x\n')
    expect((await revertFrozenPaths(['a.ts', 'fresh'], makeGit(app))).sort()).toEqual([
        'a.ts',
        'fresh/'
    ])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(fs.existsSync(path.join(app, 'fresh'))).toBe(false)
})

test('a frozen-path revert undoes an edit beside an intent-to-add file', async () => {
    const {app, g} = repo()
    fs.writeFileSync(path.join(app, 'a.ts'), 'export const a = 2\n')
    fs.writeFileSync(path.join(app, 'x.ts'), 'x\n')
    g('add', '-N', 'app/x.ts')
    expect(await revertFrozenPaths(['a.ts', 'x.ts'], makeGit(app))).toContain('a.ts')
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
})

test('a frozen-path revert brings back a file removed from the index only', async () => {
    const {app, g} = repo()
    g('rm', '-q', '--cached', 'app/a.ts')
    expect(await revertFrozenPaths(['a.ts'], makeGit(app))).toEqual(['a.ts'])
    expect(fs.readFileSync(path.join(app, 'a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(g('status', '--porcelain')).toBe('')
})
