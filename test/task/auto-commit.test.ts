import {expect, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    gitCommitAll,
    gitUnmergedPaths,
    gitStashRef,
    gitDropLastCommit,
    untrackedArtifacts,
    stagePathspec
} from '../../src/task/auto-commit.js'
import {fakeSpawnByPrompt, type SpawnResponse} from '../test-utils/fake-spawn.js'

/**
 * Build a git fake that dispatches on the subcommand (args[0..]). Every git
 * call goes through `git <subcommand> …`; unspecified subcommands succeed with
 * empty output so a test only has to script the steps it cares about.
 */
function gitSpawn(routes: Partial<Record<'rev-parse' | 'add' | 'diff' | 'commit', SpawnResponse>>) {
    return fakeSpawnByPrompt(args => {
        const sub = args[0] as keyof typeof routes
        return routes[sub] ?? {stdout: '', exitCode: 0}
    })
}

const INSIDE = {stdout: 'true\n', exitCode: 0}
const STAGED = {stdout: '', exitCode: 1} // git diff --cached --quiet: 1 = changes exist

test('gitCommitAll: stages, detects changes, and commits', async () => {
    const seen: string[][] = []
    const spawn = fakeSpawnByPrompt(args => {
        seen.push([...args])
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'diff') return STAGED
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res).toEqual({committed: true})
    // The commit ran with our message, and we staged everything first.
    expect(seen.some(a => a[0] === 'add' && a[1] === '-A')).toBe(true)
    expect(seen.some(a => a[0] === 'commit' && a.includes('task: A (TASK_0006)'))).toBe(true)
})

test('gitCommitAll: not a git repository → reported, no commit attempted', async () => {
    let committed = false
    const spawn = fakeSpawnByPrompt(args => {
        if (args[0] === 'commit') committed = true
        if (args[0] === 'rev-parse') return {stdout: '', exitCode: 128, stderr: 'not a git repo'}
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/tmp', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toBe('not a git repository')
    expect(committed).toBe(false)
})

test('gitCommitAll: nothing staged → "nothing to commit", no commit attempted', async () => {
    let committed = false
    const spawn = fakeSpawnByPrompt(args => {
        if (args[0] === 'commit') committed = true
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'diff') return {stdout: '', exitCode: 0} // 0 = no staged changes
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toBe('nothing to commit')
    expect(committed).toBe(false)
})

test('gitCommitAll: git add failure surfaces its stderr', async () => {
    const spawn = gitSpawn({
        'rev-parse': INSIDE,
        add: {stdout: '', exitCode: 1, stderr: 'fatal: index locked\n'}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toMatch(/git add failed: fatal: index locked/)
})

test('gitCommitAll: non-identity commit failure is reported, not thrown', async () => {
    const spawn = gitSpawn({
        'rev-parse': INSIDE,
        diff: STAGED,
        commit: {
            stdout: '',
            exitCode: 128,
            stderr: 'fatal: unable to write new_index file\n'
        }
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toMatch(/git commit failed: fatal: unable to write new_index file/)
})

test('gitCommitAll: missing identity → retried with self-supplied fallback identity', async () => {
    // The failure: a headless container with no gitconfig failed ALL 10
    // per-task commits ("Author identity unknown"), silently disabling enforce and
    // every commit-based guard. The fallback keeps the snapshot.
    const seen: string[][] = []
    const spawn = fakeSpawnByPrompt(args => {
        seen.push([...args])
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'diff') return STAGED
        if (args[0] === 'commit') {
            return {
                stdout: '',
                exitCode: 128,
                stderr: 'Author identity unknown\n*** Please tell me who you are.\n'
            }
        }
        return {stdout: '', exitCode: 0} // the `-c …identity… commit` retry succeeds
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(true)
    expect(res.note).toMatch(/no git identity configured/)
    const retry = seen.find(a => a[0] === '-c')
    expect(retry).toBeDefined()
    expect(retry?.join(' ')).toContain('user.name=pi-task')
    expect(retry?.join(' ')).toContain('user.email=pi-task@local')
    expect(retry?.join(' ')).toContain('task: A (TASK_0006)')
})

test('gitCommitAll: identity fallback retry also failing → reported with retry stderr', async () => {
    const spawn = fakeSpawnByPrompt(args => {
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'diff') return STAGED
        if (args[0] === 'commit') {
            return {stdout: '', exitCode: 128, stderr: 'Author identity unknown\n'}
        }
        if (args[0] === '-c') {
            return {stdout: '', exitCode: 128, stderr: 'fatal: repository locked\n'}
        }
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toMatch(/git commit failed: fatal: repository locked/)
})

// ─── Unmerged-index guard + stash ref ────────────────────────────────────────

test('gitCommitAll: unmerged index → refused BEFORE add (add -A would mis-resolve it)', async () => {
    const seen: string[][] = []
    const spawn = fakeSpawnByPrompt(args => {
        seen.push([...args])
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'ls-files') {
            return {
                stdout:
                    '100644 aaaa 1\t.pi-tasks/TASK_AUTO_0001.md\n'
                    + '100644 bbbb 2\t.pi-tasks/TASK_AUTO_0001.md\n'
                    + '100644 cccc 3\t.pi-tasks/TASK_AUTO_0001.md\n'
                    + '100644 dddd 1\tsrc/server/routes/photos.ts\n'
                    + '100644 eeee 2\tsrc/server/routes/photos.ts\n',
                exitCode: 0
            }
        }
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toMatch(/^git commit blocked: unresolved merge conflict/)
    expect(res.reason).toContain('.pi-tasks/TASK_AUTO_0001.md')
    expect(res.reason).toContain('src/server/routes/photos.ts')
    // Neither add nor commit ever ran against the conflicted index.
    expect(seen.some(a => a[0] === 'add')).toBe(false)
    expect(seen.some(a => a[0] === 'commit')).toBe(false)
})

test('gitUnmergedPaths: dedupes the three stages per path; git error → empty (guard input)', async () => {
    const spawn = fakeSpawnByPrompt(args => {
        if (args[0] === 'ls-files') {
            return {
                stdout: '100644 aaaa 1\ta.ts\n100644 bbbb 2\ta.ts\n100644 cccc 3\ta.ts\n',
                exitCode: 0
            }
        }
        return {stdout: '', exitCode: 0}
    })
    expect(await gitUnmergedPaths('/repo', undefined, spawn)).toEqual(['a.ts'])
    const failing = fakeSpawnByPrompt(() => ({stdout: '', exitCode: 128, stderr: 'boom'}))
    expect(await gitUnmergedPaths('/repo', undefined, failing)).toEqual([])
})

test('gitStashRef: sha when a stash exists, null when not', async () => {
    const withStash = fakeSpawnByPrompt(() => ({stdout: 'abc123\n', exitCode: 0}))
    expect(await gitStashRef('/repo', undefined, withStash)).toBe('abc123')
    const noStash = fakeSpawnByPrompt(() => ({stdout: '', exitCode: 1}))
    expect(await gitStashRef('/repo', undefined, noStash)).toBeNull()
})

// item 8: the enforce-revert path (`git reset --hard HEAD~1`) erased the
// gate trail because .pi-tasks is TRACKED — several tasks lose their whole
// post-snapshot trail (the "commit:"/"enforce(edit)"/resolution lines), so a
// committed-then-reverted task looked as if it had never been committed. The revert
// must undo CODE and preserve the forensic trail. Real repo — the reset touches
// actual files, so a faked spawn would test nothing.
function realRepo(): {dir: string; g: (...a: string[]) => string} {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-autocommit-'))
    const g = (...a: string[]): string =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
            cwd: dir,
            encoding: 'utf8'
        }).trim()
    g('init', '-q', '-b', 'main')
    g('config', 'core.autocrlf', 'false')
    return {dir, g}
}

test('gitDropLastCommit reverts code but PRESERVES the .pi-tasks trail (run 9 item 8)', async () => {
    const {dir, g} = realRepo()
    fs.mkdirSync(path.join(dir, '.pi-tasks'))
    const trailPath = path.join(dir, '.pi-tasks', 'TASK_0001.md')
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 1\n')
    // Snapshot commit: as in task-gates, the "commit:" line is written AFTER this,
    // so the snapshot's TASK.md only has the pre-commit trail.
    fs.writeFileSync(trailPath, '## gates\n- verify: PASS\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'task: A (TASK_0001)')
    // Post-snapshot trail lines (the ones the bug erased) + the enforce pass's edit.
    fs.appendFileSync(trailPath, '- commit: task snapshot committed\n- enforce(edit): clean\n')
    fs.writeFileSync(path.join(dir, 'src.ts'), 'export const a = 1 // enforce reformatted\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'ENFORCE GUIDELINES')

    // Re-verify regressed → drop the enforce commit.
    await gitDropLastCommit(dir)

    // Code is reverted to the verified snapshot…
    expect(fs.readFileSync(path.join(dir, 'src.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(g('log', '--oneline', '-1')).toContain('task: A (TASK_0001)')
    // …but every post-snapshot trail line survives (the regression erased these).
    const trail = fs.readFileSync(trailPath, 'utf8')
    expect(trail).toContain('commit: task snapshot committed')
    expect(trail).toContain('enforce(edit): clean')
})

test('gitDropLastCommit preserves a nested .pi-tasks debug log across the reset', async () => {
    const {dir, g} = realRepo()
    fs.mkdirSync(path.join(dir, '.pi-tasks'))
    fs.writeFileSync(path.join(dir, 'code.ts'), 'v1\n')
    fs.writeFileSync(path.join(dir, '.pi-tasks', 'verify-debug.log'), 'run 1\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'task: B (TASK_0002)')
    fs.appendFileSync(path.join(dir, '.pi-tasks', 'verify-debug.log'), 'run 2 (post-snapshot)\n')
    fs.writeFileSync(path.join(dir, 'code.ts'), 'v2\n')
    g('add', '-A')
    g('commit', '-q', '-m', 'ENFORCE GUIDELINES')

    await gitDropLastCommit(dir)

    expect(fs.readFileSync(path.join(dir, 'code.ts'), 'utf8')).toBe('v1\n') // code reverted
    expect(fs.readFileSync(path.join(dir, '.pi-tasks', 'verify-debug.log'), 'utf8')).toContain(
        'run 2 (post-snapshot)'
    ) // log preserved
})

// ─────────────────────────────────────────────────────────────────────────────
// UNTRACKED TEST-RUNNER OUTPUT. a task's snapshot ran a bare
// `git add -A` over a tree the Playwright run had just littered with three
// `*-actual.png` FAILURE screenshots, committed them, and made them tracked
// deliverables — after which two whole final-gate fix attempts were rejected for
// deleting them.
// ─────────────────────────────────────────────────────────────────────────────

test('untrackedArtifacts: only untracked regenerable output, never build output', async () => {
    const spawn = fakeSpawnByPrompt(args => {
        if (args[0] === 'ls-files') {
            return {
                stdout:
                    [
                        'test-results/a-actual.png',
                        'test-results/.last-run.json',
                        'playwright-report/index.html',
                        'coverage/lcov.info',
                        '.nyc_output/out.json',
                        'tsconfig.tsbuildinfo',
                        'dist/app.css', // build output: NOT excluded
                        'src/new-feature.ts'
                    ].join('\0') + '\0',
                exitCode: 0
            }
        }
        return {stdout: '', exitCode: 0}
    })
    expect(await untrackedArtifacts('/repo', undefined, spawn)).toEqual([
        '.nyc_output/out.json',
        'coverage/lcov.info',
        'playwright-report/index.html',
        'test-results/.last-run.json',
        'test-results/a-actual.png',
        'tsconfig.tsbuildinfo'
    ])
})

test('untrackedArtifacts: a git failure yields an empty list (degrades to today `git add -A`)', async () => {
    const spawn = gitSpawn({})
    const boom = fakeSpawnByPrompt(args =>
        args[0] === 'ls-files' ? {stdout: '', exitCode: 128} : {stdout: '', exitCode: 0}
    )
    expect(await untrackedArtifacts('/repo', undefined, boom)).toEqual([])
    expect(await untrackedArtifacts('/repo', undefined, spawn)).toEqual([])
})

test('stagePathspec: empty stays byte-identical to a bare `git add -A`', () => {
    expect(stagePathspec([])).toEqual([])
    expect(stagePathspec(['test-results/a.png'])).toEqual([
        '--',
        '.',
        ':(exclude)test-results/a.png'
    ])
})

test('gitCommitAll: excludes untracked artifacts from the stage and REPORTS them', async () => {
    const seen: string[][] = []
    const spawn = fakeSpawnByPrompt(args => {
        seen.push([...args])
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'diff') return STAGED
        // `ls-files -u` (unmerged) must stay empty; `ls-files --others` is ours.
        if (args[0] === 'ls-files' && args.includes('--others')) {
            return {stdout: 'test-results/a-actual.png\0src/real.ts\0', exitCode: 0}
        }
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res).toEqual({committed: true, excluded: ['test-results/a-actual.png']})
    const add = seen.find(a => a[0] === 'add')
    expect(add).toEqual(['add', '-A', '--', '.', ':(exclude)test-results/a-actual.png'])
})

test('gitCommitAll: nothing to exclude → no `excluded` key and a bare `git add -A`', async () => {
    const seen: string[][] = []
    const spawn = fakeSpawnByPrompt(args => {
        seen.push([...args])
        if (args[0] === 'rev-parse') return INSIDE
        if (args[0] === 'diff') return STAGED
        if (args[0] === 'ls-files' && args.includes('--others')) {
            return {stdout: 'src/real.ts\0', exitCode: 0}
        }
        return {stdout: '', exitCode: 0}
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res).toEqual({committed: true})
    expect(seen.find(a => a[0] === 'add')).toEqual(['add', '-A'])
})
