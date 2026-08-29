/**
 * frozen-path-guard tests. The pure functions (spec → frozen paths, porcelain
 * parsing) are unit-tested directly; revertFrozenPaths is exercised BOTH with a
 * fake git (deterministic call-shape assertions) and against a REAL throwaway git
 * repo (the live repro: a write-capable pass edits a spec-frozen file and the
 * guard undoes it before it could be committed), since the module's job is faithful
 * git plumbing.
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
        // ./ stripped, trailing / stripped, de-duplicated across lines.
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
        // Only the status probe ran; no checkout/clean when nothing changed.
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

// ─── Live repro on a real throwaway git repo ────────────────────────────────

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@t'] as const
function gitCli(cwd: string, ...args: string[]): string {
    return execFileSync('git', [...IDENTITY, ...args], {cwd, encoding: 'utf8'}).trim()
}
function realGit(cwd: string): FrozenGit {
    // Raw stdout, NOT trimmed: git porcelain uses fixed status columns, so the
    // leading space of a ` M path` line is significant — exactly what the real
    // auto-commit git helper returns (runChild text mode does not trim).
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

/** A repo whose committed HEAD is the "verified task": a frozen contract file, a
 *  frozen directory, and an ordinary file the enforce pass is free to edit. */
function makeRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-frozen-test-'))
    gitCli(dir, 'init', '-q', '-b', 'main')
    // Pin line endings so LF fixtures round-trip byte-for-byte through git on
    // Windows CI (which defaults to core.autocrlf=true). Repo-level so the
    // product's revert git calls honor it too.
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
        // Simulate the enforce EDIT pass: it mutates the frozen contract AND an
        // ordinary file (mx5 run 6 / contract-framing shape).
        fs.writeFileSync(path.join(dir, 'schema.ts'), 'export const price = nonnegative\n')
        fs.writeFileSync(path.join(dir, 'app.ts'), 'export const app = 2 // enforce fix\n')

        const reverted = await revertFrozenPaths(['schema.ts'], realGit(dir))

        expect(reverted).toEqual(['schema.ts'])
        // Frozen file restored to the committed state; the write did not land.
        expect(fs.readFileSync(path.join(dir, 'schema.ts'), 'utf8')).toBe(
            'export const price = positive\n'
        )
        // The pass's legitimate edit to the free file is untouched.
        expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toBe(
            'export const app = 2 // enforce fix\n'
        )
    })

    test('a frozen DIRECTORY covers files created and modified under it', async () => {
        const dir = makeRepo()
        // Modify a tracked file under the frozen dir and create a new one in it.
        fs.writeFileSync(path.join(dir, 'src', 'server.ts'), 'export const boot = 999\n')
        fs.writeFileSync(path.join(dir, 'src', 'sneaky.ts'), 'export const x = 1\n')

        const reverted = await revertFrozenPaths(['src'], realGit(dir))

        expect(reverted.sort()).toEqual(['src/server.ts', 'src/sneaky.ts'])
        expect(fs.readFileSync(path.join(dir, 'src', 'server.ts'), 'utf8')).toBe(
            'export const boot = 1\n'
        )
        // The untracked file the pass created under the frozen dir is gone.
        expect(fs.existsSync(path.join(dir, 'src', 'sneaky.ts'))).toBe(false)
    })

    test('a pass that respected the frozen paths → nothing reverted', async () => {
        const dir = makeRepo()
        fs.writeFileSync(path.join(dir, 'app.ts'), 'export const app = 2\n')
        expect(await revertFrozenPaths(['schema.ts', 'src'], realGit(dir))).toEqual([])
        // The free-file edit survives.
        expect(fs.readFileSync(path.join(dir, 'app.ts'), 'utf8')).toBe('export const app = 2\n')
    })
})
