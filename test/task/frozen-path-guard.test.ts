/**
 * frozen-path-guard tests. frozenPathsFromSpec and parseChangedFrozenFiles are
 * pure, so they are called directly. revertFrozenPaths is run twice: with a fake
 * git, asserting the exact argv it issues, and against a real throwaway repo,
 * asserting what is left on disk afterwards.
 */
import {describe, expect, test} from 'bun:test'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    frozenPathsFromSpec,
    parseChangedFrozenFiles,
    revertFrozenPaths,
    type FrozenGit
} from '../../src/task/frozen-path-guard.js'

describe('frozenPathsFromSpec', () => {
    test('null / empty spec → no frozen paths', () => {
        expect(frozenPathsFromSpec(null)).toEqual([])
        expect(frozenPathsFromSpec(undefined)).toEqual([])
        expect(frozenPathsFromSpec('')).toEqual([])
    })

    test('extracts and normalizes the paths a modification-ban line names', () => {
        const spec = [
            'CONSTRAINTS:',
            '- **Do NOT modify** `src/server/index.ts` or `./config/schema.ts`.',
            '- Never touch `src/server/` — it is frozen.'
        ].join('\n')
        // Leading `./` stripped, trailing `/` stripped, de-duplicated across lines.
        expect(frozenPathsFromSpec(spec).sort()).toEqual([
            'config/schema.ts',
            'src/server',
            'src/server/index.ts'
        ])
    })

    test('a prose-only ban naming no path freezes nothing (prompt rule covers it)', () => {
        expect(frozenPathsFromSpec('Do not modify any server-side code.')).toEqual([])
    })
})

describe('parseChangedFrozenFiles', () => {
    test('empty / whitespace porcelain → no files', () => {
        expect(parseChangedFrozenFiles('')).toEqual([])
        expect(parseChangedFrozenFiles('\n\n')).toEqual([])
    })

    test('parses modified, deleted, untracked, and renamed entries', () => {
        const porcelain = [
            ' M src/server/index.ts',
            'D  config/schema.ts',
            '?? src/server/new.ts',
            'R  old/a.ts -> src/server/b.ts'
        ].join('\n')
        expect(parseChangedFrozenFiles(porcelain)).toEqual([
            'src/server/index.ts',
            'config/schema.ts',
            'src/server/new.ts',
            'src/server/b.ts' // rename → the NEW (written) side
        ])
    })

    test('de-duplicates and unquotes paths with unusual chars', () => {
        const porcelain = [' M "src/a b.ts"', ' M "src/a b.ts"'].join('\n')
        expect(parseChangedFrozenFiles(porcelain)).toEqual(['src/a b.ts'])
    })
})

describe('revertFrozenPaths (fake git)', () => {
    test('no frozen paths → no git calls, nothing reverted', async () => {
        const calls: string[][] = []
        const git: FrozenGit = async args => {
            calls.push(args)
            return {stdout: '', exitCode: 0}
        }
        expect(await revertFrozenPaths([], git)).toEqual([])
        expect(calls).toEqual([])
    })

    test('clean status → checked but not reverted', async () => {
        const calls: string[][] = []
        const git: FrozenGit = async args => {
            calls.push(args)
            return {stdout: '', exitCode: 0}
        }
        expect(await revertFrozenPaths(['src/server/index.ts'], git)).toEqual([])
        // Only the status probe ran: revertFrozenPaths returns before it reaches
        // checkout/clean when status names no changed file.
        expect(calls).toEqual([['status', '--porcelain', '--', 'src/server/index.ts']])
    })

    test('changed frozen path → checkout HEAD + clean, returns the file list', async () => {
        const calls: string[][] = []
        const git: FrozenGit = async args => {
            calls.push(args)
            if (args[0] === 'status') return {stdout: ' M src/server/index.ts\n', exitCode: 0}
            return {stdout: '', exitCode: 0}
        }
        const reverted = await revertFrozenPaths(['src/server/index.ts'], git)
        expect(reverted).toEqual(['src/server/index.ts'])
        expect(calls).toEqual([
            ['status', '--porcelain', '--', 'src/server/index.ts'],
            ['checkout', '-f', 'HEAD', '--', 'src/server/index.ts'],
            ['clean', '-fdq', '--', 'src/server/index.ts']
        ])
    })

    test('git status failure → no-op (guard never breaks the gate)', async () => {
        const git: FrozenGit = async () => ({stdout: '', exitCode: 128})
        expect(await revertFrozenPaths(['src/server/index.ts'], git)).toEqual([])
    })
})

// ─── Against a real throwaway git repo ──────────────────────────────────────

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'] as const
function gitCli(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...IDENTITY, ...args], {cwd, encoding: 'utf8'}).trim()
}
function realGit(cwd: string): FrozenGit {
    // Raw stdout, NOT trimmed, matching the real git helper: its runChild text
    // mode preserves both the leading space and the trailing newline. Porcelain
    // uses fixed status columns, so trimming shifts every line by one and the
    // parse silently yields wrong paths — ` M mod.ts` trimmed parses as `od.ts`.
    return async args => {
        try {
            const stdout = execFileSync('git', [...IDENTITY, ...args], {cwd, encoding: 'utf8'})
            return {stdout, exitCode: 0}
        } catch (err) {
            const e = err as {status?: number; stdout?: Buffer | string}
            return {stdout: e.stdout?.toString() ?? '', exitCode: e.status ?? 1}
        }
    }
}

/** A repo whose committed HEAD stands in for the finished task: a frozen file, a
 *  frozen directory, and an ordinary file the edit pass is free to change. */
function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-frozen-test-'))
    gitCli(dir, 'init', '-q', '-b', 'main')
    // Repo-level, so the product's own revert git calls honor it too.
    gitCli(dir, 'config', 'core.autocrlf', 'false')
    fs.writeFileSync(path.join(dir, 'schema.ts'), 'export const price = positive\n')
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'src', 'server.ts'), 'export const boot = 1\n')
    fs.writeFileSync(path.join(dir, 'app.ts'), 'export const app = 1\n')
    gitCli(dir, 'add', '-A')
    gitCli(dir, 'commit', '-q', '-m', 'verified task')
    return dir
}

describe('revertFrozenPaths (real git — live repro)', () => {
    test('undoes a gate pass edit to a frozen file, keeps its edit to a free file', async () => {
        const dir = makeRepo()
        // The edit pass writes to the frozen file AND to an ordinary one.
        fs.writeFileSync(path.join(dir, 'schema.ts'), 'export const price = nonnegative\n')
        fs.writeFileSync(path.join(dir, 'app.ts'), 'export const app = 2 // enforce fix\n')

        const reverted = await revertFrozenPaths(['schema.ts'], realGit(dir))

        expect(reverted).toEqual(['schema.ts'])
        expect(fs.readFileSync(path.join(dir, 'schema.ts'), 'utf8')).toBe(
            'export const price = positive\n'
        )
        expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toBe(
            'export const app = 2 // enforce fix\n'
        )
    })

    test('a frozen DIRECTORY covers files created and modified under it', async () => {
        const dir = makeRepo()
        // One tracked file modified, one untracked file created: `checkout -f HEAD`
        // covers the first, `clean -fdq` the second.
        fs.writeFileSync(path.join(dir, 'src', 'server.ts'), 'export const boot = 999\n')
        fs.writeFileSync(path.join(dir, 'src', 'sneaky.ts'), 'export const x = 1\n')

        const reverted = await revertFrozenPaths(['src'], realGit(dir))

        expect(reverted.sort()).toEqual(['src/server.ts', 'src/sneaky.ts'])
        expect(fs.readFileSync(path.join(dir, 'src', 'server.ts'), 'utf8')).toBe(
            'export const boot = 1\n'
        )
        expect(fs.existsSync(path.join(dir, 'src', 'sneaky.ts'))).toBe(false)
    })

    test('a pass that respected the frozen paths → nothing reverted', async () => {
        const dir = makeRepo()
        fs.writeFileSync(path.join(dir, 'app.ts'), 'export const app = 2\n')
        expect(await revertFrozenPaths(['schema.ts', 'src'], realGit(dir))).toEqual([])
        expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toBe('export const app = 2\n')
    })
})
