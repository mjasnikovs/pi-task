/**
 * final-gate tests — run against real throwaway directories with real `bun run`
 * script execution (the gate's value is its faithfulness to real exit codes; a
 * mocked spawn would test the mock). Scripts are trivial shell one-liners, so
 * each case is fast and hermetic.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {discoverIntegrationCommands, runFinalIntegrationGate} from './final-gate.js'

function makeDir(pkg?: object): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-final-gate-'))
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    return dir
}

describe('discoverIntegrationCommands', () => {
    test('package.json: test before build, only scripts that exist', () => {
        const dir = makeDir({scripts: {build: 'echo b', test: 'echo t', lint: 'echo l'}})
        const {ecosystem, cmds} = discoverIntegrationCommands(dir)
        expect(ecosystem).toBe('package.json')
        expect(cmds).toEqual([
            ['bun', ['run', 'test']],
            ['bun', ['run', 'build']]
        ])
    })

    test('no manifest → nothing to run', () => {
        const dir = makeDir()
        expect(discoverIntegrationCommands(dir)).toEqual({ecosystem: null, cmds: []})
    })

    test('Makefile targets are detected', () => {
        const dir = makeDir()
        fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\ttrue\n')
        expect(discoverIntegrationCommands(dir)).toEqual({
            ecosystem: 'Makefile',
            cmds: [['make', ['test']]]
        })
    })
})

describe('runFinalIntegrationGate', () => {
    test('no manifest at all → pass (nothing can regress)', () => {
        const out = runFinalIntegrationGate(makeDir())
        expect(out.ok).toBe(true)
    })

    test('passing test + build scripts → pass naming what ran', () => {
        const dir = makeDir({scripts: {test: 'exit 0', build: 'exit 0'}})
        const out = runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.reason).toContain('bun run test')
        expect(out.reason).toContain('bun run build')
    })

    test('failing test script → FAIL naming the command, exit code, and output tail', () => {
        const dir = makeDir({
            scripts: {test: 'echo "2 tests failed: photos upload limit" && exit 1'}
        })
        const out = runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('`bun run test` exited 1')
        expect(out.reason).toContain('photos upload limit')
    })

    test('build failure surfaces after a passing test', () => {
        const dir = makeDir({scripts: {test: 'exit 0', build: 'exit 2'}})
        const out = runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('`bun run build` exited 2')
    })

    test('command-not-found inside the script chain (127) is an env gap → skipped', () => {
        const dir = makeDir({scripts: {test: 'definitely-not-a-real-command-xyz'}})
        const out = runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
    })

    test('a static (lint) failure gates BEFORE integration commands run', () => {
        const dir = makeDir({scripts: {lint: 'exit 1', test: 'echo SHOULD-NOT-RUN && exit 1'}})
        const out = runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('static checks:')
        expect(out.reason).not.toContain('SHOULD-NOT-RUN')
    })
})
