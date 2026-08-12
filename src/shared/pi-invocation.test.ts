/**
 * How a child pi is invoked. Getting this wrong does not fail loudly — it
 * spawns the WRONG binary, or re-invokes the test file as if it were pi (the
 * measured `bun test` failure the PI_BIN override exists for), so every branch
 * is pinned here.
 */

import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {getPiInvocation} from './pi-invocation.js'

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
        process.argv[1] = 'package.json' // any real file; only existence is checked
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
        // Upper-cased and .exe forms too: the check lowercases and allows .exe
        // so a windows runtime is recognised as generic, not as a pi binary.
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
        const prompt = 'x'.repeat(300_000) // too big for argv — that is the point
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
