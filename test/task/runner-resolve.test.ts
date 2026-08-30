/**
 * runner-resolve tests — resolution order (bare name → known locations → not
 * spawnable), the PATH prefix contract for script chains, and caching. The probe
 * is injected so every case is hermetic; one real smoke run proves the default
 * probe against the box's actual bun (the suite itself runs under bun, so it is
 * guaranteed present).
 */
import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    clearRunnerCache,
    isCommandNotFound,
    resolveRunner,
    runnerEnv
} from '../../src/task/runner-resolve.js'

afterEach(() => clearRunnerCache())

describe('resolveRunner', () => {
    test('bare name spawnable → returned as-is, no PATH prefix', () => {
        const r = resolveRunner('bun', {probe: () => true})
        expect(r).toEqual({bin: 'bun', pathPrefix: null, ok: true})
    })

    test('bare name dead, known location exists and runs → absolute path + prefix (the run-16 shape)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'))
        const binDir = path.join(home, '.bun', 'bin')
        fs.mkdirSync(binDir, {recursive: true})
        const exe = process.platform === 'win32' ? 'bun.exe' : 'bun'
        const abs = path.join(binDir, exe)
        fs.writeFileSync(abs, '#!/bin/sh\n')
        const probed: string[] = []
        const r = resolveRunner('bun', {
            probe: b => {
                probed.push(b)
                return b === abs
            },
            env: {HOME: home, USERPROFILE: home}
        })
        expect(r.ok).toBe(true)
        expect(r.bin).toBe(abs)
        expect(r.pathPrefix).toBe(binDir)
        // Bare name was tried first — resolution never shadows a working PATH.
        expect(probed[0]).toBe('bun')
        fs.rmSync(home, {recursive: true, force: true})
    })

    test('BUN_INSTALL outranks ~/.bun', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'))
        const exe = process.platform === 'win32' ? 'bun.exe' : 'bun'
        const installBin = path.join(root, 'custom', 'bin')
        const homeBin = path.join(root, '.bun', 'bin')
        for (const d of [installBin, homeBin]) {
            fs.mkdirSync(d, {recursive: true})
            fs.writeFileSync(path.join(d, exe), '#!/bin/sh\n')
        }
        const r = resolveRunner('bun', {
            probe: b => b !== 'bun',
            env: {HOME: root, USERPROFILE: root, BUN_INSTALL: path.join(root, 'custom')}
        })
        expect(r.bin).toBe(path.join(installBin, exe))
        fs.rmSync(root, {recursive: true, force: true})
    })

    test('a location that exists but does not RUN is not resolved (broken binary)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'))
        const binDir = path.join(home, '.bun', 'bin')
        fs.mkdirSync(binDir, {recursive: true})
        fs.writeFileSync(path.join(binDir, process.platform === 'win32' ? 'bun.exe' : 'bun'), '')
        const r = resolveRunner('bun', {probe: () => false, env: {HOME: home, USERPROFILE: home}})
        expect(r).toEqual({bin: 'bun', pathPrefix: null, ok: false})
        fs.rmSync(home, {recursive: true, force: true})
    })

    test('nowhere spawnable → ok false, bare name unchanged (callers keep the env-gap contract)', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-'))
        const r = resolveRunner('definitely-not-a-runner', {
            probe: () => false,
            env: {HOME: home, USERPROFILE: home}
        })
        expect(r).toEqual({bin: 'definitely-not-a-runner', pathPrefix: null, ok: false})
        fs.rmSync(home, {recursive: true, force: true})
    })

    test('resolution is cached per bin until cleared', () => {
        let calls = 0
        const probe = () => {
            calls += 1
            return true
        }
        resolveRunner('bun', {probe})
        resolveRunner('bun', {probe})
        expect(calls).toBe(1)
        clearRunnerCache()
        resolveRunner('bun', {probe})
        expect(calls).toBe(2)
    })

    test('real smoke: the box that runs this suite can resolve bun', () => {
        const r = resolveRunner('bun')
        expect(r.ok).toBe(true)
    })
})

describe('runnerEnv', () => {
    test('no prefix → base env copied unchanged', () => {
        const env = runnerEnv({bin: 'bun', pathPrefix: null, ok: true}, {PATH: '/usr/bin', X: '1'})
        expect(env.PATH).toBe('/usr/bin')
        expect(env.X).toBe('1')
    })

    test('prefix prepended so the script chain can re-invoke the runner', () => {
        const env = runnerEnv(
            {bin: '/opt/bun/bin/bun', pathPrefix: '/opt/bun/bin', ok: true},
            {PATH: '/usr/bin'}
        )
        expect(env.PATH).toBe(`/opt/bun/bin${path.delimiter}/usr/bin`)
    })
})

describe('isCommandNotFound — the env-gap contract survives a shell that is not posix', () => {
    test('exit codes that say it outright', () => {
        // What a POSIX shell returns when the command is not on PATH.
        expect(isCommandNotFound(127, '')).toBe(true)
        // cmd.exe's equivalent.
        expect(isCommandNotFound(9009, '')).toBe(true)
        // A timeout/signal is a different gap, and a success is not one at all —
        // both are the caller's to classify, not this predicate's.
        expect(isCommandNotFound(null, 'bun: command not found: x')).toBe(false)
        expect(isCommandNotFound(0, '')).toBe(false)
    })

    test('a runner that resolves the command itself: exit 1 plus its own wording', () => {
        // When the runner resolves the command rather than handing the script to a
        // shell, it reports the miss and still exits 1 — a status indistinguishable
        // from a real code fault. COMMAND_NOT_FOUND_OUTPUT_RE is what separates them.
        const bunWin =
            '$ pi-task-no-such-bin\nbun: command not found: pi-task-no-such-bin\n'
            + 'error: script "dev" exited with code 1'
        expect(isCommandNotFound(1, bunWin)).toBe(true)
        expect(
            isCommandNotFound(1, "'foo' is not recognized as an internal or external command")
        ).toBe(true)
        expect(
            isCommandNotFound(1, "The term 'foo' is not recognized as the name of a cmdlet")
        ).toBe(true)
    })

    test('narrow by design: a real failure that merely MENTIONS it stays a failure', () => {
        // The regex requires a runner name before "command not found", so a suite
        // asserting on that phrase, or a build printing it in a diagnostic, still
        // FAILs. The genuine POSIX shape arrives as 127 and needs no text match.
        expect(isCommandNotFound(1, 'expected "command not found" but got ""')).toBe(false)
        expect(isCommandNotFound(1, '2 tests failed')).toBe(false)
    })
})
