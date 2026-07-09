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
    discoverBootCommand,
    discoverIntegrationCommands,
    discoverGateCommandLabels,
    discoverLockfileChecks,
    runBootCheck,
    runFinalIntegrationGate
} from './final-gate.js'
import {readAcceptDebts, recordAcceptDebt} from './accept-debt.js'

function makeDir(pkg?: object): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-final-gate-'))
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    return dir
}

/** Shadow a real binary with a stub script for the duration of `fn`. */
async function withFakeBin(
    name: string,
    script: string,
    fn: () => void | Promise<void>
): Promise<void> {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fake-bin-'))
    const file = path.join(bin, name)
    fs.writeFileSync(file, `#!/bin/sh\n${script}\n`)
    fs.chmodSync(file, 0o755)
    const old = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${old ?? ''}`
    try {
        await fn()
    } finally {
        process.env.PATH = old
    }
}

describe('discoverIntegrationCommands', () => {
    test('package.json: test before build, only scripts that exist', async () => {
        const dir = makeDir({scripts: {build: 'echo b', test: 'echo t', lint: 'echo l'}})
        const {ecosystem, cmds} = discoverIntegrationCommands(dir)
        expect(ecosystem).toBe('package.json')
        expect(cmds).toEqual([
            ['bun', ['run', 'test']],
            ['bun', ['run', 'build']]
        ])
    })

    test('no manifest → nothing to run', async () => {
        const dir = makeDir()
        expect(discoverIntegrationCommands(dir)).toEqual({ecosystem: null, cmds: []})
    })

    test('Makefile targets are detected', async () => {
        const dir = makeDir()
        fs.writeFileSync(path.join(dir, 'Makefile'), 'test:\n\ttrue\n')
        expect(discoverIntegrationCommands(dir)).toEqual({
            ecosystem: 'Makefile',
            cmds: [['make', ['test']]]
        })
    })
})

describe('discoverLockfileChecks', () => {
    test('manifest without a lockfile → nothing to verify', async () => {
        expect(discoverLockfileChecks(makeDir({name: 'x'}))).toEqual([])
    })

    test('lockfile without its manifest → nothing to verify', async () => {
        const dir = makeDir()
        fs.writeFileSync(path.join(dir, 'Cargo.lock'), '')
        expect(discoverLockfileChecks(dir)).toEqual([])
    })

    test('bun.lock and bun.lockb map to one frozen-install check', async () => {
        const dir = makeDir({name: 'x'})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        expect(discoverLockfileChecks(dir)).toEqual([
            ['bun', ['install', '--frozen-lockfile', '--dry-run']]
        ])
        fs.writeFileSync(path.join(dir, 'bun.lockb'), '')
        expect(discoverLockfileChecks(dir)).toHaveLength(1)
    })

    test('each ecosystem pairs its own manifest and lockfile', async () => {
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
    test('no manifest at all → pass (nothing can regress)', async () => {
        const out = await runFinalIntegrationGate(makeDir())
        expect(out.ok).toBe(true)
    })

    test('passing test + build scripts → pass naming what ran', async () => {
        const dir = makeDir({scripts: {test: 'exit 0', build: 'exit 0'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.reason).toContain('bun run test')
        expect(out.reason).toContain('bun run build')
    })

    test('failing test script → FAIL naming the command, exit code, and output tail', async () => {
        const dir = makeDir({
            scripts: {test: 'echo "2 tests failed: photos upload limit" && exit 1'}
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('`bun run test` exited 1')
        expect(out.reason).toContain('photos upload limit')
    })

    test('build failure surfaces after a passing test', async () => {
        const dir = makeDir({scripts: {test: 'exit 0', build: 'exit 2'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('`bun run build` exited 2')
    })

    test('command-not-found inside the script chain (127) is an env gap → skipped', async () => {
        const dir = makeDir({scripts: {test: 'definitely-not-a-real-command-xyz'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
    })

    test('a static (lint) failure gates BEFORE integration commands run', async () => {
        const dir = makeDir({scripts: {lint: 'exit 1', test: 'echo SHOULD-NOT-RUN && exit 1'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('static checks:')
        expect(out.reason).not.toContain('SHOULD-NOT-RUN')
    })

    test('a lockfile desync FAILS the gate before any integration command runs', async () => {
        const dir = makeDir({scripts: {test: 'echo SHOULD-NOT-RUN && exit 1'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin(
            'npm',
            'echo "lock and manifest are out of sync" >&2; exit 1',
            async () => {
                const out = await runFinalIntegrationGate(dir)
                expect(out.ok).toBe(false)
                expect(out.reason).toContain('lockfile check: `npm ci --dry-run` exited 1')
                expect(out.reason).toContain('lock and manifest are out of sync')
                expect(out.reason).not.toContain('SHOULD-NOT-RUN')
            }
        )
    })

    test('an in-sync lockfile passes and the check is named in the reason', async () => {
        const dir = makeDir({scripts: {test: 'exit 0'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin('npm', 'exit 0', async () => {
            const out = await runFinalIntegrationGate(dir)
            expect(out.ok).toBe(true)
            expect(out.reason).toContain('npm ci --dry-run')
            expect(out.reason).toContain('bun run test')
        })
    })

    test('a lock-check tool that cannot run (127) is an env gap → skipped', async () => {
        const dir = makeDir({scripts: {test: 'exit 0'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin('npm', 'exit 127', async () => {
            const out = await runFinalIntegrationGate(dir)
            expect(out.ok).toBe(true)
        })
    })

    test('a lockfile check alone (no test/build scripts) still gates', async () => {
        const dir = makeDir({name: 'x'})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin('npm', 'exit 1', async () => {
            expect((await runFinalIntegrationGate(dir)).ok).toBe(false)
        })
    })

    test('a crashing start command FAILS the gate after tests passed', async () => {
        const dir = makeDir({
            scripts: {test: 'exit 0', start: 'echo "port 3000 in use" >&2 && exit 3'}
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('boot check: `bun run start` exited 3')
        expect(out.reason).toContain('port 3000 in use')
    })

    test('a long-running start command PASSES the gate and is named', async () => {
        const dir = makeDir({scripts: {test: 'exit 0', start: 'sleep 30'}})
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
        expect(out.ok).toBe(true)
        expect(out.reason).toContain('bun run start')
    })

    test('a start-only project (no test/build scripts) still gates', async () => {
        const dir = makeDir({scripts: {start: 'exit 1'}})
        expect((await runFinalIntegrationGate(dir)).ok).toBe(false)
    })
})

describe('discoverBootCommand', () => {
    test('package.json: start preferred, dev is the fallback, none → null', async () => {
        expect(discoverBootCommand(makeDir({scripts: {start: 'x', dev: 'y'}}))).toEqual([
            'bun',
            ['run', 'start']
        ])
        expect(discoverBootCommand(makeDir({scripts: {dev: 'y'}}))).toEqual(['bun', ['run', 'dev']])
        expect(discoverBootCommand(makeDir({scripts: {test: 't'}}))).toBeNull()
    })

    test('Makefile run target', async () => {
        const dir = makeDir()
        fs.writeFileSync(path.join(dir, 'Makefile'), 'run:\n\ttrue\n')
        expect(discoverBootCommand(dir)).toEqual(['make', ['run']])
        expect(discoverBootCommand(makeDir())).toBeNull()
    })
})

describe('runBootCheck', () => {
    test('fast non-zero exit → FAIL carrying the output tail', async () => {
        const r = await runBootCheck('/tmp', ['sh', ['-c', 'echo boom >&2; exit 3']])
        expect(r).toEqual({outcome: 'fail', detail: 'exited 3 — boom'})
    })

    test('quick exit 0 → PASS (CLI-style run that finished)', async () => {
        const r = await runBootCheck('/tmp', ['sh', ['-c', 'exit 0']])
        expect(r.outcome).toBe('pass')
    })

    test('still alive after the grace window → PASS, whole process group killed', async () => {
        const dir = makeDir()
        const pidFile = path.join(dir, 'child.pid')
        const r = await runBootCheck(
            dir,
            ['sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`]],
            300
        )
        expect(r.outcome).toBe('pass')
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
        // The grandchild (sleep) must die with the group, not linger and mask
        // later boot checks. Poll briefly — SIGTERM delivery is asynchronous.
        let alive = true
        for (let i = 0; i < 40 && alive; i++) {
            await new Promise(res => setTimeout(res, 50))
            try {
                process.kill(pid, 0)
            } catch {
                alive = false
            }
        }
        expect(alive).toBe(false)
    })

    test('signal death within the window → FAIL naming the signal', async () => {
        const r = await runBootCheck('/tmp', ['sh', ['-c', 'kill -SEGV $$']])
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('SIGSEGV')
    })

    test('missing binary (ENOENT) is an env gap → skip', async () => {
        const r = await runBootCheck('/tmp', ['definitely-not-a-real-command-xyz', []])
        expect(r.outcome).toBe('skip')
    })

    test('exit 127 inside the script chain is an env gap → skip', async () => {
        const r = await runBootCheck('/tmp', ['sh', ['-c', 'exit 127']])
        expect(r.outcome).toBe('skip')
    })
})

describe('discoverGateCommandLabels', () => {
    test('combines the static and integration halves, deduplicated', async () => {
        const dir = makeDir({scripts: {lint: 'echo l', test: 'echo t', build: 'echo b'}})
        expect(discoverGateCommandLabels(dir)).toEqual([
            'bun run lint',
            'bun run test',
            'bun run build'
        ])
    })

    test('lock-check labels are included (deleting the lockfile trips the shrink guard)', async () => {
        const dir = makeDir({scripts: {test: 'echo t'}})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        expect(discoverGateCommandLabels(dir)).toContain('bun install --frozen-lockfile --dry-run')
        fs.rmSync(path.join(dir, 'bun.lock'))
        expect(discoverGateCommandLabels(dir)).not.toContain(
            'bun install --frozen-lockfile --dry-run'
        )
    })

    test('boot label is included (deleting the start script trips the shrink guard)', async () => {
        const dir = makeDir({scripts: {test: 'echo t', start: 'echo s'}})
        expect(discoverGateCommandLabels(dir)).toContain('bun run start')
    })

    test('nothing discoverable → empty (degrades to nothing-to-guard)', async () => {
        expect(discoverGateCommandLabels(makeDir())).toEqual([])
    })
})

describe('runFinalIntegrationGate — ACCEPT-debt re-check (run 4 B3 / run 8 TASK_0012)', () => {
    test('a non-static (frozen-path) debt is SURFACED on a PASS and kept in the ledger', async () => {
        const dir = makeDir() // no manifest → statics + integration trivially pass
        await recordAcceptDebt(dir, 'TASK_0012', 'modified frozen path src/main.tsx')
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([
            {taskId: 'TASK_0012', reason: 'modified frozen path src/main.tsx'}
        ])
        expect(out.reason).toContain('ACCEPTED VERIFY-FAIL DEBT still open (1)')
        expect(out.reason).toContain('TASK_0012')
        // Behavioral debts are never auto-closed — the ledger still holds it for resume.
        expect(await readAcceptDebts(dir)).toHaveLength(1)
    })

    test('a static-class debt is RESOLVED and PRUNED when the gate statics now pass', async () => {
        const dir = makeDir({scripts: {lint: 'exit 0'}}) // static check passes
        await recordAcceptDebt(dir, 'TASK_0009', 'repo health: bun run lint exited 1 — 3 errors')
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([])
        expect(out.reason).not.toContain('ACCEPTED VERIFY-FAIL DEBT')
        // Provably resolved ⇒ pruned from the ledger so resume does not re-surface it.
        expect(await readAcceptDebts(dir)).toEqual([])
    })

    test('a static-class debt stays OPEN and surfaces when the gate statics still fail', async () => {
        const dir = makeDir({scripts: {lint: 'exit 1'}}) // static check fails
        await recordAcceptDebt(dir, 'TASK_0009', 'repo health: bun run lint exited 1 — 3 errors')
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('static checks:')
        expect(out.openDebts).toHaveLength(1)
        expect(out.reason).toContain('ACCEPTED VERIFY-FAIL DEBT still open (1)')
        expect(await readAcceptDebts(dir)).toHaveLength(1)
    })

    test('mixed: static debt pruned, behavioral debt surfaced (only the provable one closes)', async () => {
        const dir = makeDir({scripts: {lint: 'exit 0'}})
        await recordAcceptDebt(dir, 'T9', 'repo health: lint exited 1')
        await recordAcceptDebt(dir, 'T12', 'upload endpoint returned HTML not JSON')
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([
            {taskId: 'T12', reason: 'upload endpoint returned HTML not JSON'}
        ])
        expect(await readAcceptDebts(dir)).toEqual([
            {taskId: 'T12', reason: 'upload endpoint returned HTML not JSON'}
        ])
    })

    test('no ledger → no debts, clean report (nothing to re-check)', async () => {
        const out = await runFinalIntegrationGate(makeDir({scripts: {test: 'exit 0'}}))
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([])
        expect(out.reason).not.toContain('ACCEPTED VERIFY-FAIL DEBT')
    })
})
