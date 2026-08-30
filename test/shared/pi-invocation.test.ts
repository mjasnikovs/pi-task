/**
 * How a child pi is invoked. Getting this wrong does not fail loudly: it spawns
 * the WRONG binary, so every branch is pinned here.
 *
 * The sharpest case is the test runner itself. Under `bun test`,
 * `process.argv[1]` is the `.test.ts` file and it exists on disk, so the
 * re-invoke-current-script branch would hand back `bun <that test file>` as the
 * command — the runner re-running a test file, not pi. `PI_BIN` exists to
 * short-circuit that, which is why it is checked first.
 */

import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {getPiInvocation} from '../../src/shared/pi-invocation.js'

const ARGS = ['--print', '--no-extensions']

let savedPiBin: string | undefined
let savedArgv1: string
let savedExecPath: string

beforeEach(() => {
    savedPiBin = process.env.PI_BIN
    savedArgv1 = process.argv[1]
    savedExecPath = process.execPath
    delete process.env.PI_BIN
})
afterEach(() => {
    if (savedPiBin === undefined) delete process.env.PI_BIN
    else process.env.PI_BIN = savedPiBin
    process.argv[1] = savedArgv1
    process.execPath = savedExecPath
})

describe('getPiInvocation', () => {
    test('PI_BIN wins outright — no re-invoke heuristic', () => {
        process.env.PI_BIN = '/opt/pi/bin/pi'
        process.argv[1] = savedArgv1
        expect(getPiInvocation(ARGS)).toEqual({
            command: '/opt/pi/bin/pi',
            args: ARGS,
            stdin: undefined
        })
    })

    test('re-invokes the current script under the current runtime when it exists', () => {
        process.argv[1] = 'package.json' // any real file: the branch calls existsSync
        expect(getPiInvocation(ARGS)).toEqual({
            command: process.execPath,
            args: ['package.json', ...ARGS],
            stdin: undefined
        })
    })

    test('ignores a Bun single-file-executable virtual script path', () => {
        process.argv[1] = '/$bunfs/root/pi'
        process.execPath = '/usr/local/bin/bun'
        expect(getPiInvocation(ARGS).command).toBe('pi')
    })

    test('runs the runtime directly when it is a pi binary, not node/bun', () => {
        process.argv[1] = '/nope/does-not-exist.js'
        process.execPath = '/usr/local/bin/pi'
        expect(getPiInvocation(ARGS)).toEqual({
            command: '/usr/local/bin/pi',
            args: ARGS,
            stdin: undefined
        })
    })

    test('falls back to the pi shim on PATH under a generic runtime', () => {
        process.argv[1] = '/nope/does-not-exist.js'
        // Upper-cased and .exe forms too. The check is
        // `/^(node|bun)(\.exe)?$/` over a lowercased basename, so BUN.EXE and
        // Node.exe are generic runtimes; only a basename that is neither is
        // treated as a pi binary to run directly.
        for (const runtime of ['/usr/bin/node', '/usr/bin/bun', '/w/BUN.EXE', '/w/Node.exe']) {
            process.execPath = runtime
            expect(getPiInvocation(ARGS).command).toBe('pi')
        }
    })

    test('falls back to the pi shim when there is no current script at all', () => {
        process.argv.length = 1
        process.execPath = '/usr/bin/node'
        try {
            expect(getPiInvocation(ARGS).command).toBe('pi')
        } finally {
            process.argv[1] = savedArgv1
        }
    })

    test('threads the stdin prompt through unchanged on every branch', () => {
        // Too big for argv — that is the point. A single argv element over
        // ~128 KiB fails the spawn outright with E2BIG (measured here: 131071
        // bytes spawns, 131072 does not), so a large prompt has to go over stdin.
        const prompt = 'x'.repeat(300_000)
        process.env.PI_BIN = '/opt/pi/bin/pi'
        expect(getPiInvocation(ARGS, prompt).stdin).toBe(prompt)

        delete process.env.PI_BIN
        process.argv[1] = 'package.json'
        expect(getPiInvocation(ARGS, prompt).stdin).toBe(prompt)

        process.argv[1] = '/nope/does-not-exist.js'
        process.execPath = '/usr/local/bin/pi'
        expect(getPiInvocation(ARGS, prompt).stdin).toBe(prompt)

        process.execPath = '/usr/bin/node'
        expect(getPiInvocation(ARGS, prompt).stdin).toBe(prompt)
    })
})
