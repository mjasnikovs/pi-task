/**
 * tree-hash — the worktree's content identity, against real throwaway repos.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {makeGit} from '../../src/shared/git-runner.js'
import {treeHasGitlink, worktreeTreeHash} from '../../src/task/tree-hash.js'
import {tmpDir} from '../test-utils/tmp-dir.js'

const sh = (dir: string, ...args: string[]): string => {
    const r = Bun.spawnSync(['git', ...args], {cwd: dir})
    if (r.exitCode !== 0) throw new Error(`git ${args[0]}: ${r.stderr.toString()}`)
    return r.stdout.toString().trim()
}

function write(dir: string, files: Record<string, string>): void {
    for (const [rel, body] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
        fs.writeFileSync(path.join(dir, rel), body)
    }
}

function repo(): string {
    const dir = tmpDir('tree-hash-')
    sh(dir, 'init', '-q')
    sh(dir, 'config', 'user.email', 't@t')
    sh(dir, 'config', 'user.name', 't')
    sh(dir, 'config', 'core.autocrlf', 'false')
    write(dir, {
        '.gitignore': 'dist/\n.env\n',
        'a.ts': 'a1\n',
        'dist/app.js': 'v1\n',
        '.pi-tasks/TASK_0001.md': 'committed trail\n'
    })
    sh(dir, 'add', '-A')
    sh(dir, 'add', '-f', 'dist/app.js')
    sh(dir, 'commit', '-qm', 'init')
    return dir
}

describe('worktreeTreeHash', () => {
    test('an edit to a tracked file under an ignored pattern moves the hash', async () => {
        const dir = repo()
        const git = makeGit(dir)
        const before = await worktreeTreeHash(git)
        write(dir, {'dist/app.js': 'v2\n'})
        expect(await worktreeTreeHash(git)).not.toBe(before)
    })

    test('the trail, ignored files and the staged index do not move it', async () => {
        const dir = repo()
        const git = makeGit(dir)
        const before = await worktreeTreeHash(git)
        write(dir, {'.pi-tasks/TASK_0001.md': 'more trail\n', '.pi-tasks/TASK_0002.md': 'new\n'})
        write(dir, {'.env': 'SECRET=1\n'})
        sh(dir, 'add', '-f', '.env')
        expect(await worktreeTreeHash(git)).toBe(before)
        expect(sh(dir, 'diff', '--cached', '--name-only')).toBe('.env')
    })

    test('a plain repo hashes as its content: equal to the commit, minus the trail', async () => {
        const dir = tmpDir('tree-hash-plain-')
        sh(dir, 'init', '-q')
        sh(dir, 'config', 'user.email', 't@t')
        sh(dir, 'config', 'user.name', 't')
        write(dir, {'a.ts': 'a\n', 'src/b.ts': 'b\n'})
        sh(dir, 'add', '-A')
        sh(dir, 'commit', '-qm', 'init')
        expect(await worktreeTreeHash(makeGit(dir))).toBe(sh(dir, 'rev-parse', 'HEAD^{tree}'))
    })

    test('deletes and untracked files count; an unborn HEAD still hashes', async () => {
        const dir = repo()
        const git = makeGit(dir)
        const before = await worktreeTreeHash(git)
        fs.rmSync(path.join(dir, 'a.ts'))
        const deleted = await worktreeTreeHash(git)
        expect(deleted).not.toBe(before)
        write(dir, {'new.ts': 'n\n'})
        expect(await worktreeTreeHash(git)).not.toBe(deleted)

        const fresh = tmpDir('tree-hash-unborn-')
        sh(fresh, 'init', '-q')
        write(fresh, {'x.ts': 'x\n'})
        expect(await worktreeTreeHash(makeGit(fresh))).toMatch(/^[0-9a-f]{40}$/)
    })
})

test('a HEAD git cannot read is null, not an empty-index hash under other rules', async () => {
    const dir = repo()
    const tree = sh(dir, 'rev-parse', 'HEAD^{tree}')
    fs.rmSync(path.join(dir, '.git/objects', tree.slice(0, 2), tree.slice(2)))
    expect(await worktreeTreeHash(makeGit(dir))).toBeNull()
})

test('treeHasGitlink sees a nested repo, and only then', async () => {
    const dir = repo()
    const git = makeGit(dir)
    expect(await treeHasGitlink(git, (await worktreeTreeHash(git))!)).toBe(false)
    const nested = path.join(dir, 'packages/api')
    fs.mkdirSync(nested, {recursive: true})
    sh(nested, 'init', '-q')
    write(nested, {'x.ts': 'x\n'})
    sh(nested, 'add', '-A')
    sh(nested, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'n')
    expect(await treeHasGitlink(git, (await worktreeTreeHash(git))!)).toBe(true)
})
