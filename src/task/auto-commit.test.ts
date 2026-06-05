import {expect, test} from 'bun:test'
import {gitCommitAll} from './auto-commit.js'
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

test('gitCommitAll: commit failure (e.g. missing identity) is reported, not thrown', async () => {
    const spawn = gitSpawn({
        'rev-parse': INSIDE,
        diff: STAGED,
        commit: {
            stdout: '',
            exitCode: 128,
            stderr: 'Author identity unknown\n*** Please tell me who you are.\n'
        }
    })
    const res = await gitCommitAll('/repo', 'task: A (TASK_0006)', undefined, spawn)
    expect(res.committed).toBe(false)
    expect(res.reason).toMatch(/git commit failed: Author identity unknown/)
})
