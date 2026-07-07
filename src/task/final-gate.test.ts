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
import {
    discoverIntegrationCommands,
    discoverGateCommandLabels,
    discoverLockfileChecks,
    runFinalIntegrationGate
} from './final-gate.js'

function makeDir(pkg?: object): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-final-gate-'))
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    return dir
}

/** Shadow a real binary with a stub script for the duration of `fn`. */
function withFakeBin(name: string, script: string, fn: () => void): void {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fake-bin-'))
    const file = path.join(bin, name)
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`)
    fs.chmodSync(file, 0o755)
    const old = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${old ?? ''}`
    try {
        fn()
    } finally {
        process.env.PATH = old
    }
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

describe('discoverLockfileChecks', () => {
    test('manifest without a lockfile → nothing to verify', () => {
        expect(discoverLockfileChecks(makeDir({name: 'x'}))).toEqual([])
    })

    test('lockfile without its manifest → nothing to verify', () => {
        const dir = makeDir()
        fs.writeFileSync(path.join(dir, 'Cargo.lock'), '')
        expect(discoverLockfileChecks(dir)).toEqual([])
    })

    test('bun.lock and bun.lockb map to one frozen-install check', () => {
        const dir = makeDir({name: 'x'})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        expect(discoverLockfileChecks(dir)).toEqual([
            ['bun', ['install', '--frozen-lockfile', '--dry-run']]
        ])
        fs.writeFileSync(path.join(dir, 'bun.lockb'), '')
        expect(discoverLockfileChecks(dir)).toHaveLength(1)
    })

    test('each ecosystem pairs its own manifest and lockfile', () => {
        const dir = makeDir({name: 'x'})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        fs.writeFileSync(path.join(dir, 'Cargo.toml'), '')
        fs.writeFileSync(path.join(dir, 'Cargo.lock'), '')
        fs.writeFileSync(path.join(dir, 'go.mod'), '')
        fs.writeFileSync(path.join(dir, 'go.sum'), '')
        fs.writeFileSync(path.join(dir, 'pyproject.toml'), '')
        fs.writeFileSync(path.join(dir, 'uv.lock'), '')
        fs.writeFileSync(path.join(dir, 'poetry.lock'), '')
        expect(discoverLockfileChecks(dir)).toEqual([
            ['npm', ['ci', '--dry-run']],
            ['cargo', ['metadata', '--locked', '--format-version', '1']],
            ['go', ['mod', 'verify']],
            ['uv', ['lock', '--check']],
            ['poetry', ['check', '--lock']]
        ])
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

    test('a lockfile desync FAILS the gate before any integration command runs', () => {
        const dir = makeDir({scripts: {test: 'echo SHOULD-NOT-RUN && exit 1'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        withFakeBin('npm', 'echo "lock and manifest are out of sync" >&2; exit 1', () => {
            const out = runFinalIntegrationGate(dir)
            expect(out.ok).toBe(false)
            expect(out.reason).toContain('lockfile check: `npm ci --dry-run` exited 1')
            expect(out.reason).toContain('lock and manifest are out of sync')
            expect(out.reason).not.toContain('SHOULD-NOT-RUN')
        })
    })

    test('an in-sync lockfile passes and the check is named in the reason', () => {
        const dir = makeDir({scripts: {test: 'exit 0'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        withFakeBin('npm', 'exit 0', () => {
            const out = runFinalIntegrationGate(dir)
            expect(out.ok).toBe(true)
            expect(out.reason).toContain('npm ci --dry-run')
            expect(out.reason).toContain('bun run test')
        })
    })

    test('a lock-check tool that cannot run (127) is an env gap → skipped', () => {
        const dir = makeDir({scripts: {test: 'exit 0'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        withFakeBin('npm', 'exit 127', () => {
            const out = runFinalIntegrationGate(dir)
            expect(out.ok).toBe(true)
        })
    })

    test('a lockfile check alone (no test/build scripts) still gates', () => {
        const dir = makeDir({name: 'x'})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        withFakeBin('npm', 'exit 1', () => {
            expect(runFinalIntegrationGate(dir).ok).toBe(false)
        })
    })
})

describe('discoverGateCommandLabels', () => {
    test('combines the static and integration halves, deduplicated', () => {
        const dir = makeDir({scripts: {lint: 'echo l', test: 'echo t', build: 'echo b'}})
        expect(discoverGateCommandLabels(dir)).toEqual([
            'bun run lint',
            'bun run test',
            'bun run build'
        ])
    })

    test('lock-check labels are included (deleting the lockfile trips the shrink guard)', () => {
        const dir = makeDir({scripts: {test: 'echo t'}})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        expect(discoverGateCommandLabels(dir)).toContain('bun install --frozen-lockfile --dry-run')
        fs.rmSync(path.join(dir, 'bun.lock'))
        expect(discoverGateCommandLabels(dir)).not.toContain(
            'bun install --frozen-lockfile --dry-run'
        )
    })

    test('nothing discoverable → empty (degrades to nothing-to-guard)', () => {
        expect(discoverGateCommandLabels(makeDir())).toEqual([])
    })
})
