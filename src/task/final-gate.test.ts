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
    detectsServedApp,
    discoverBootCommand,
    discoverIntegrationCommands,
    discoverGateCommandLabels,
    discoverLockfileChecks,
    runBootCheck,
    runFinalIntegrationGate
} from './final-gate.js'
import {readAcceptDebts, recordAcceptDebt} from './accept-debt.js'
import {appendDeclaredScripts} from './launch-contract.js'

// Some cases exercise irreducibly-POSIX process/shell mechanics — death by a
// Unix signal (no equivalent on Windows), or shadowing `npm` (a .cmd on Windows,
// which node's bare spawn can't resolve without a shell). Skip those on Windows
// rather than pretend; the product paths they cover degrade to env-gap-skip there.
const IS_WINDOWS = process.platform === 'win32'
const itPosix = IS_WINDOWS ? test.skip : test

/** A cross-platform child fixture: `node -e <script>` behaves identically on every
 *  OS, unlike `sh -c` (no sh/POSIX-shell semantics on Windows). */
const nodeScript = (script: string): [string, string[]] => [process.execPath, ['-e', script]]

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

    // mx5 run 10 item 2: EVERY test-shaped script must run, not just `test`.
    test('every test*/test:* script runs — plain test leads, then test:* / test-*, build last', async () => {
        const dir = makeDir({
            scripts: {
                build: 'echo b',
                'test:ct': 'echo ct',
                test: 'echo t',
                test_unit: 'echo u',
                lint: 'echo l'
            }
        })
        const {cmds} = discoverIntegrationCommands(dir)
        expect(cmds).toEqual([
            ['bun', ['run', 'test']],
            ['bun', ['run', 'test:ct']],
            ['bun', ['run', 'test_unit']],
            ['bun', ['run', 'build']]
        ])
    })

    test('a test:* script with no plain `test` is still discovered', async () => {
        const dir = makeDir({scripts: {'test:ct': 'echo ct'}})
        expect(discoverIntegrationCommands(dir).cmds).toEqual([['bun', ['run', 'test:ct']]])
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

    // mx5 run 10 item 2: `test:ct` (Playwright CT) must RUN in the gate, but on a box
    // with no browsers installed it is an ENVIRONMENT gap, not a code FAIL. Playwright
    // exits non-zero (not 127) with a recognisable "Executable doesn't exist" message.
    test('a browser suite with no browsers installed is an env gap → skipped, not failed', async () => {
        const dir = makeDir({
            scripts: {
                'test:ct':
                    'echo "Error: browserType.launch: Executable doesn\'t exist at /root/.cache/ms-playwright" && exit 1'
            }
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
    })

    test('a browser suite that fails for a REAL reason still FAILs the gate', async () => {
        const dir = makeDir({
            scripts: {'test:ct': 'echo "1 failed: Button renders wrong colour" && exit 1'}
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('`bun run test:ct` exited 1')
    })

    test('command-not-found inside the script chain (127) is an env gap → skipped', async () => {
        // A command that exits 127 (command-not-found) is the env-gap contract;
        // exit 127 explicitly so the case is deterministic on every OS's shell.
        const dir = makeDir({scripts: {test: "node -e 'process.exit(127)'"}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
    })

    // mx5 run 10 item 4: a script the design declared but the manifest never exposed
    // (migrate/seed) is a launch-surface defect the final gate must FAIL on.
    test('a declared script missing from the manifest FAILs the gate naming it', async () => {
        const dir = makeDir({scripts: {dev: 'exit 0', build: 'exit 0', test: 'exit 0'}})
        await appendDeclaredScripts(dir, ['dev', 'build', 'migrate', 'seed', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('launch contract:')
        expect(out.reason).toContain('migrate')
        expect(out.reason).toContain('seed')
    })

    test('every declared script present → the launch check passes silently', async () => {
        const dir = makeDir({
            scripts: {
                dev: 'exit 0',
                build: 'exit 0',
                migrate: 'exit 0',
                seed: 'exit 0',
                test: 'exit 0'
            }
        })
        await appendDeclaredScripts(dir, ['dev', 'build', 'migrate', 'seed', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.reason).not.toContain('launch contract')
    })

    test('a static (lint) failure gates BEFORE integration commands run', async () => {
        const dir = makeDir({scripts: {lint: 'exit 1', test: 'echo SHOULD-NOT-RUN && exit 1'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('static checks:')
        expect(out.reason).not.toContain('SHOULD-NOT-RUN')
    })

    itPosix('a lockfile desync FAILS the gate before any integration command runs', async () => {
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

    itPosix('an in-sync lockfile passes and the check is named in the reason', async () => {
        const dir = makeDir({scripts: {test: 'exit 0'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin('npm', 'exit 0', async () => {
            const out = await runFinalIntegrationGate(dir)
            expect(out.ok).toBe(true)
            expect(out.reason).toContain('npm ci --dry-run')
            expect(out.reason).toContain('bun run test')
        })
    })

    itPosix('a lock-check tool that cannot run (127) is an env gap → skipped', async () => {
        const dir = makeDir({scripts: {test: 'exit 0'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin('npm', 'exit 127', async () => {
            const out = await runFinalIntegrationGate(dir)
            expect(out.ok).toBe(true)
        })
    })

    itPosix('a lockfile check alone (no test/build scripts) still gates', async () => {
        const dir = makeDir({name: 'x'})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin('npm', 'exit 1', async () => {
            expect((await runFinalIntegrationGate(dir)).ok).toBe(false)
        })
    })

    test('a crashing start command FAILS the gate after tests passed', async () => {
        const dir = makeDir({
            scripts: {
                test: 'exit 0',
                // A genuine app crash (not a bind collision — that path is now the
                // distinct orphan-port diagnosis; see the item-3 tests below).
                start: 'node -e \'process.stderr.write("TypeError: boom"); process.exit(3)\''
            }
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('boot check: `bun run start` exited 3')
        expect(out.reason).toContain('TypeError: boom')
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
        const r = await runBootCheck(
            os.tmpdir(),
            nodeScript("process.stderr.write('boom'); process.exit(3)")
        )
        expect(r).toEqual({outcome: 'fail', detail: 'exited 3 — boom'})
    })

    test('quick exit 0 → PASS (CLI-style run that finished)', async () => {
        const r = await runBootCheck(os.tmpdir(), nodeScript('process.exit(0)'))
        expect(r.outcome).toBe('pass')
    })

    test('still alive after the grace window → PASS, whole process group killed', async () => {
        const dir = makeDir()
        const pidFile = path.join(dir, 'child.pid')
        // A parent that spawns a long-lived grandchild, records its pid, and stays
        // alive itself. The boot check must tear down the WHOLE tree (grandchild
        // included), so a leaked server can't mask later boot checks — killGroup
        // uses a process-group kill on POSIX and taskkill /T on Windows.
        const fixture =
            `const {spawn}=require('child_process');const fs=require('fs');`
            + `const c=spawn(process.execPath,['-e','setTimeout(()=>{},600000)'],{stdio:'ignore'});`
            + `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));`
            + `setTimeout(()=>{},600000)`
        const r = await runBootCheck(dir, nodeScript(fixture), 300)
        expect(r.outcome).toBe('pass')
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
        // The grandchild must die with the tree, not linger. Poll briefly — kill
        // delivery is asynchronous.
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

    // Death by a Unix signal has no Windows equivalent (child.on('exit') never
    // reports a signal there), so this behavior is POSIX-only.
    itPosix('signal death within the window → FAIL naming the signal', async () => {
        const r = await runBootCheck(os.tmpdir(), ['sh', ['-c', 'kill -SEGV $$']])
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('SIGSEGV')
    })

    test('missing binary (ENOENT) is an env gap → skip', async () => {
        const r = await runBootCheck(os.tmpdir(), ['definitely-not-a-real-command-xyz', []])
        expect(r.outcome).toBe('skip')
    })

    test('exit 127 inside the script chain is an env gap → skip', async () => {
        const r = await runBootCheck(os.tmpdir(), nodeScript('process.exit(127)'))
        expect(r.outcome).toBe('skip')
    })

    // mx5 run 9 item 3: a bind collision is an environment condition, not an app
    // crash — it must be classified distinctly (orphan-port), never a bare FAIL.
    test('EADDRINUSE bind failure → orphan-port with the port, not a FAIL', async () => {
        const r = await runBootCheck(
            os.tmpdir(),
            nodeScript(
                "process.stderr.write('error: listen EADDRINUSE: address already in use :3000'); process.exit(1)"
            )
        )
        expect(r.outcome).toBe('orphan-port')
        expect((r as {port: number | null}).port).toBe(3000)
    })

    test('Bun\'s "Is port N in use?" phrasing is also recognised', async () => {
        const r = await runBootCheck(
            os.tmpdir(),
            nodeScript(
                "process.stderr.write('Failed to start server. Is port 3000 in use?'); process.exit(1)"
            )
        )
        expect(r.outcome).toBe('orphan-port')
        expect((r as {port: number | null}).port).toBe(3000)
    })

    test('an ordinary non-zero exit is still a plain FAIL (not orphan-port)', async () => {
        const r = await runBootCheck(
            os.tmpdir(),
            nodeScript("process.stderr.write('TypeError: undefined'); process.exit(1)")
        )
        expect(r.outcome).toBe('fail')
    })
})

// mx5 run 10 item 1: a watcher is not a server. For a served app the boot check must
// observe a LISTENER before it PASSes — mere survival (a CSS/bundler --watch) or a
// quick exit 0 (a type-only entrypoint that serves nothing) is a FAIL. The listener
// probe is injected so these are deterministic without binding a real socket. Skipped
// on Windows, where the pgid-based listener requirement collapses to survival.
describe('runBootCheck — served-app listener requirement (run 10 item 1)', () => {
    const alive = nodeScript('setTimeout(()=>{},600000)')

    itPosix('watcher: stays alive but never listens → FAIL naming the missing socket', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 800, {
            expectServer: true,
            deps: {groupHasListener: () => false}
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('listening socket')
    })

    itPosix('type-only entrypoint: exits 0 without listening → FAIL', async () => {
        const r = await runBootCheck(os.tmpdir(), nodeScript('process.exit(0)'), 2000, {
            expectServer: true,
            deps: {groupHasListener: () => false}
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('listening socket')
    })

    itPosix('a listener owned by our group appears → PASS (early, before grace)', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {groupHasListener: () => true}
        })
        expect(r.outcome).toBe('pass')
    })

    itPosix(
        'CLI project (expectServer off): staying alive still PASSes, no listener needed',
        async () => {
            const r = await runBootCheck(os.tmpdir(), alive, 500, {
                expectServer: false,
                deps: {groupHasListener: () => false}
            })
            expect(r.outcome).toBe('pass')
        }
    )
})

describe('detectsServedApp (run 10 item 1)', () => {
    test('a server-framework dependency ⇒ served app', () => {
        const dir = makeDir({dependencies: {hono: '^4', react: '^18'}})
        expect(detectsServedApp(dir)).toBe(true)
    })

    test('a scoped framework family (@hono/*) also counts', () => {
        const dir = makeDir({dependencies: {'@hono/zod-validator': '^0.2'}})
        expect(detectsServedApp(dir)).toBe(true)
    })

    test('a pure client/CLI manifest ⇒ NOT a served app', () => {
        const dir = makeDir({dependencies: {react: '^18', clsx: '^2', wouter: '^3'}})
        expect(detectsServedApp(dir)).toBe(false)
    })

    test('plan/spec text promising a server flips a bare CLI manifest', () => {
        const dir = makeDir({dependencies: {chalk: '^5'}})
        expect(detectsServedApp(dir)).toBe(false)
        expect(detectsServedApp(dir, 'The app serves /api and static dist/ over HTTP')).toBe(true)
    })
})

// mx5 run 9 item 3, layer (b): the final gate must reap OUR OWN orphaned dev server
// and retry, or — if the port is held by something we cannot attribute to ourselves
// — surface a HARNESS diagnosis rather than a bare app FAIL.
describe('runFinalIntegrationGate — orphaned-port recovery (run 9 item 3)', () => {
    // A start script that binds a listener on the injected pid's behalf would need a
    // real server; instead we drive the classifier + recovery with an EADDRINUSE
    // start script and injected BootDeps, keeping the test hermetic.
    const eaddrinuseStart = "process.stderr.write('listen EADDRINUSE :3000'); process.exit(1)"

    test('port held by a FOREIGN process → harness diagnosis, not an app FAIL', async () => {
        const dir = makeDir({scripts: {start: `node -e "${eaddrinuseStart}"`}})
        let reaped = 0
        const out = await runFinalIntegrationGate(dir, 900_000, 300, {
            findPortHolder: () => ({pid: 99999, command: '/usr/bin/postgres -D /data'}),
            reap: () => {
                reaped++
                return true
            }
        })
        expect(out.ok).toBe(false)
        expect(reaped).toBe(0) // never kill a process we don't own
        expect(out.reason).toContain('orphaned process / port already in use')
        expect(out.reason).toContain('harness condition, not an app fault')
        expect(out.reason).not.toMatch(/exited 1\s*$/)
    })

    test('port held by OUR OWN dev server → reaped, boot retried, and it passes', async () => {
        // First boot hits EADDRINUSE; after we "reap", the retry sees a clean start.
        // The boot logic lives in a .mjs FILE (referenced as `node boot.mjs`) rather
        // than an inline `node -e "…"` — the latter's nested quoting + a
        // JSON-stringified Windows path (backslashes) break under cmd.exe on CI.
        const dir = makeDir({scripts: {start: 'node boot.mjs'}})
        fs.writeFileSync(
            path.join(dir, 'boot.mjs'),
            [
                "import {existsSync, writeFileSync} from 'node:fs'",
                // Resolve beside this script, so it works whatever the cwd is.
                "const flag = new URL('booted', import.meta.url)",
                'if (existsSync(flag)) process.exit(0)',
                "writeFileSync(flag, '1')",
                "process.stderr.write('listen EADDRINUSE :3000')",
                'process.exit(1)'
            ].join('\n')
        )
        let reaped = 0
        const out = await runFinalIntegrationGate(dir, 900_000, 300, {
            findPortHolder: () => ({pid: 4242, command: 'bun run start'}),
            reap: () => {
                reaped++
                return true
            }
        })
        expect(reaped).toBe(1) // our own orphan was reaped
        expect(out.ok).toBe(true) // retry booted clean
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
        expect(out.reason).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (1)')
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
        expect(out.reason).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (1)')
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
