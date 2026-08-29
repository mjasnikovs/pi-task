/**
 * final-gate tests — run against real throwaway directories with real `bun run`
 * script execution (the gate's value is its faithfulness to real exit codes; a
 * mocked spawn would test the mock). Scripts are trivial shell one-liners, so
 * each case is fast and hermetic.
 */
import {describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    bootSkipVerdict,
    CLOSURE_SCANS,
    runClosureScans,
    discoverIntegrationCommands,
    discoverGateCommandLabels,
    discoverGateCommandBodies,
    discoverLockfileChecks,
    observabilityGapFailure,
    unobservedVerdict,
    runFinalIntegrationGate,
    taskThatIntroduced
} from '../../src/task/final-gate.js'
import type {ClosureScan} from '../../src/task/final-gate.js'
import {readAcceptDebts, recordDebt} from '../../src/task/accept-debt.js'
import {appendDeclaredScripts} from '../../src/task/launch-contract.js'
import {appendEnvNotes} from '../../src/task/env-notes.js'
import {clearRunnerCache} from '../../src/task/runner-resolve.js'
import {runVerifyCommandLine, rerunDebtVerifyCommand} from '../../src/task/final-gate.js'
import type {CommandRun, CommandRunner} from '../../src/task/command-run.js'
import {inertClosure, type EnvClosure} from '../../src/task/env-template-closure.js'

// Some cases exercise irreducibly-POSIX process/shell mechanics — death by a
// Unix signal (no equivalent on Windows), or shadowing `npm` (a .cmd on Windows,
// which node's bare spawn can't resolve without a shell). Skip those on Windows
// rather than pretend; the product paths they cover degrade to env-gap-skip there.
const IS_WINDOWS = process.platform === 'win32'
const itPosix = IS_WINDOWS ? test.skip : test

function makeDir(pkg?: object): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-final-gate-'))
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    return dir
}

/** Shadow a real binary with a stub script for the duration of `fn`.
 *
 *  The stub must answer `--version` with exit 0: runner-resolve probes the bare
 *  name that way and rejects a present-but-broken binary, so a stub that failed
 *  every invocation gets stepped over in favour of a real one in a well-known
 *  location (/usr/local/bin/npm on CI) — the shadowing the case depends on then
 *  silently does not happen. Resolution is also cached for the process lifetime,
 *  so it is reset around each stub. */
async function withFakeBin(
    name: string,
    script: string,
    fn: () => void | Promise<void>
): Promise<void> {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-fake-bin-'))
    const file = path.join(bin, name)
    fs.writeFileSync(
        file,
        `#!/bin/sh\ncase "$1" in --version) echo 0.0.0-fake; exit 0;; esac\n${script}\n`
    )
    fs.chmodSync(file, 0o755)
    const old = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${old ?? ''}`
    clearRunnerCache()
    try {
        await fn()
    } finally {
        process.env.PATH = old
        clearRunnerCache()
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

    // item 2: EVERY test-shaped script must run, not just `test`.
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

    // item 2: `test:ct` (Playwright CT) must RUN in the gate, but on a box
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

    // item 4: a script the design declared but the manifest never exposed
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

    // The gate AGGREGATES — an earlier section failure does not
    // shadows the later sections (the boot + render probe was ordered last and
    // never ran, so the user accepted a FAIL seeing 1 CT test while the app
    // 404'd on /). Statics failing now reports the integration failure too.
    test('a static (lint) failure no longer shadows integration commands — both aggregate', async () => {
        const dir = makeDir({scripts: {lint: 'exit 1', test: 'echo ALSO-RAN && exit 1'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('static checks:')
        expect(out.reason).toContain('`bun run test` exited 1')
        expect(out.reason).toContain('ALSO-RAN')
        expect(out.failures).toHaveLength(2)
    })

    itPosix('a lockfile desync aggregates with a failing integration command', async () => {
        const dir = makeDir({scripts: {test: 'echo TEST-ALSO-FAILED && exit 1'}})
        fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}')
        await withFakeBin(
            'npm',
            'echo "lock and manifest are out of sync" >&2; exit 1',
            async () => {
                const out = await runFinalIntegrationGate(dir)
                expect(out.ok).toBe(false)
                expect(out.reason).toContain('lockfile check: `npm ci --dry-run` exited 1')
                expect(out.reason).toContain('lock and manifest are out of sync')
                expect(out.reason).toContain('TEST-ALSO-FAILED')
                expect(out.failures).toHaveLength(2)
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
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(out.ok).toBe(true)
        expect(out.reason).toContain('bun run start')
    })

    test('a start-only project (no test/build scripts) still gates', async () => {
        const dir = makeDir({scripts: {start: 'exit 1'}})
        expect((await runFinalIntegrationGate(dir)).ok).toBe(false)
    })
})

// item 3, layer (b): the final gate must reap OUR OWN orphaned dev server
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
        const out = await runFinalIntegrationGate(dir, {
            timeoutMs: 900_000,
            bootGraceMs: 300,
            bootDeps: {
                findPortHolder: () => ({pid: 99999, command: '/usr/bin/postgres -D /data'}),
                reap: () => {
                    reaped++
                    return true
                }
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
        const out = await runFinalIntegrationGate(dir, {
            timeoutMs: 900_000,
            bootGraceMs: 300,
            bootDeps: {
                findPortHolder: () => ({pid: 4242, command: 'bun run start'}),
                reap: () => {
                    reaped++
                    return true
                }
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

describe('discoverGateCommandBodies', () => {
    test('each label resolves to what it actually RUNS (mx5 run 19)', async () => {
        const dir = makeDir({
            scripts: {
                lint: 'eslint . && tsc --noEmit',
                test: 'AGENT=1 bun test',
                start: 'bun src/i.ts'
            }
        })
        expect(discoverGateCommandBodies(dir)).toEqual({
            'bun run lint': 'eslint . && tsc --noEmit',
            'bun run test': 'AGENT=1 bun test',
            'bun run start': 'bun src/i.ts'
        })
    })

    test('a command with no indirection resolves to itself', async () => {
        const dir = makeDir({scripts: {test: 'echo t'}})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        expect(discoverGateCommandBodies(dir)['bun install --frozen-lockfile --dry-run']).toBe(
            'bun install --frozen-lockfile --dry-run'
        )
    })

    test('Makefile targets resolve to their recipe lines (non-npm parity)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-bodies-'))
        fs.writeFileSync(
            path.join(dir, 'Makefile'),
            'lint:\n\truff check .\n\ntest:\n\tpytest -q\n'
        )
        expect(discoverGateCommandBodies(dir)).toEqual({
            'make lint': 'ruff check .',
            'make test': 'pytest -q'
        })
        fs.rmSync(dir, {recursive: true, force: true})
    })
})

// The whole gate must FAIL when the served app renders blank, and
// surface UNOBSERVED when no browser could observe it. Injected render probe +
// listener keep it hermetic (a real alive start script, faked observation).
describe('runFinalIntegrationGate — served-page render check (runs 8/11)', () => {
    // hono dep ⇒ detectsServedApp; a start script that stays alive so the poll runs.
    const servedApp = (): string =>
        makeDir({
            dependencies: {hono: '^4'},
            scripts: {start: 'node -e "setTimeout(()=>{},600000)"'}
        })

    itPosix('a served app that renders blank FAILs the whole gate', async () => {
        const dir = servedApp()
        const out = await runFinalIntegrationGate(dir, {
            timeoutMs: 900_000,
            bootGraceMs: 5000,
            bootDeps: {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({
                    outcome: 'fail',
                    detail: 'the rendered body is EMPTY after client JS executed'
                })
            }
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('boot check')
        expect(out.reason).toContain('EMPTY')
    })

    itPosix(
        'a served app whose page cannot be observed → PASS with an UNOBSERVED warning',
        async () => {
            const dir = servedApp()
            const out = await runFinalIntegrationGate(dir, {
                timeoutMs: 900_000,
                bootGraceMs: 5000,
                bootDeps: {
                    groupHasListener: () => true,
                    groupListeningPort: () => 3000,
                    renderProbe: () => ({outcome: 'skip', note: 'no headless browser found'})
                }
            })
            expect(out.ok).toBe(true)
            expect(out.reason).toContain('WARNING')
            expect(out.reason).toContain('UNOBSERVED')
        }
    )

    itPosix('a served app that renders content → clean PASS, no warning', async () => {
        const dir = servedApp()
        const out = await runFinalIntegrationGate(dir, {
            timeoutMs: 900_000,
            bootGraceMs: 5000,
            bootDeps: {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({outcome: 'pass', detail: 'rendered visible text'}),
                // The listener here is FAKED, so the real deep probe would drive a browser
                // against whatever happens to answer on :3000 on the test box. Injected to
                // keep this hermetic; the deep probe's own behaviour is covered above.
                deepRenderProbe: () => Promise.resolve({outcome: 'pass', detail: 'no sign-in wall'})
            }
        })
        expect(out.ok).toBe(true)
        expect(out.reason).not.toContain('WARNING')
    })
})

// Early-returning on the FIRST failing section,
// so the boot + render probe (ordered last, and the run's most load-bearing signal)
// never executed once any test failed — the user accepted the FAIL having seen only
// 1 failing CT test while the shipped app 404'd on every non-API GET. The gate now
// runs EVERY section, aggregates, and ranks boot/render failures first.
describe('runFinalIntegrationGate — failure aggregation + ranking (run 13)', () => {
    test('a single failure keeps the exact single-failure wording and rides in failures[]', async () => {
        const dir = makeDir({scripts: {test: 'echo boom && exit 1'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.failures).toEqual([out.reason])
        expect(out.reason).not.toContain('failures (ranked')
    })

    test('multiple failures become a numbered list carrying every entry', async () => {
        const dir = makeDir({scripts: {test: 'exit 1', build: 'exit 2'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.failures).toHaveLength(2)
        expect(out.reason).toContain('2 failures (ranked, most load-bearing first):')
        expect(out.reason).toContain('1. `bun run test` exited 1')
        expect(out.reason).toContain('2. `bun run build` exited 2')
    })

    test('the boot failure OUTRANKS earlier test failures — ranked first, run last', async () => {
        const dir = makeDir({
            scripts: {
                test: 'echo "1 test failed" && exit 1',
                start: 'node -e \'process.stderr.write("TypeError: boom"); process.exit(3)\''
            }
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.failures).toHaveLength(2)
        expect(out.failures![0]).toContain('boot check: `bun run start` exited 3')
        expect(out.failures![1]).toContain('`bun run test` exited 1')
    })

    // The replay: a failing bun-test glob (the
    // playwright .spec collision) PLUS an unservable app (listener up, page never
    // renders — no index.html producer). Baseline (early-return) showed ONLY the
    // test failure; the aggregate must carry BOTH with the render failure FIRST.
    itPosix('run-13 replay: failing test glob + unservable app → both, render first', async () => {
        const dir = makeDir({
            dependencies: {hono: '^4'},
            scripts: {
                test: 'echo "playwright .spec picked up by bun test: 63 errors" && exit 1',
                start: 'node -e "setTimeout(()=>{},600000)"'
            }
        })
        const out = await runFinalIntegrationGate(dir, {
            timeoutMs: 900_000,
            bootGraceMs: 5000,
            bootDeps: {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({
                    outcome: 'fail',
                    detail: 'GET / responded 404 — the rendered document is the not-found page'
                })
            }
        })
        expect(out.ok).toBe(false)
        expect(out.failures).toHaveLength(2)
        expect(out.failures![0]).toContain('boot check')
        expect(out.failures![0]).toContain('404')
        expect(out.failures![1]).toContain('`bun run test` exited 1')
        // The reason (picker question + autofix seed) carries the full ranked list.
        expect(out.reason).toContain('1. boot check')
        expect(out.reason).toContain('2. `bun run test` exited 1')
    })

    test('launch-contract, launch-script and integration failures all aggregate', async () => {
        const dir = makeDir({
            scripts: {
                test: 'exit 1',
                migrate: `node -e "console.error('TypeError: result.rows'); process.exit(1)"`
            }
        })
        await appendDeclaredScripts(dir, ['migrate', 'seed', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.failures).toHaveLength(3)
        const joined = out.failures!.join('\n')
        expect(joined).toContain('launch contract:')
        expect(joined).toContain('seed')
        expect(joined).toContain('`bun run test` exited 1')
        expect(joined).toContain('launch script: `bun run migrate` exited 1')
    })

    test('a PASS carries no failures list', async () => {
        const out = await runFinalIntegrationGate(makeDir({scripts: {test: 'exit 0'}}))
        expect(out.ok).toBe(true)
        expect(out.failures).toBeUndefined()
    })
})

describe('runFinalIntegrationGate — dangling-artifact closure (run 13, PROMPT 2)', () => {
    test('a runtime ref with no producer FAILS the gate, ranked with the load-bearing class', async () => {
        // The shape: server reads dist/index.html; the build enumerable
        // outputs are main.js (Bun.build entrypoint) + app.css (tailwind -o) —
        // index.html has no producer anywhere. Statics/tests are green.
        const dir = makeDir({scripts: {test: 'exit 0', build: 'node build.js'}})
        fs.mkdirSync(path.join(dir, 'src'), {recursive: true})
        fs.writeFileSync(
            path.join(dir, 'build.js'),
            [
                'Bun.spawn(["bunx", "@tailwindcss/cli", "-i", "src/index.css", "-o", "dist/app.css"])',
                'await Bun.build({entrypoints: ["src/main.tsx"], outdir: "dist"})'
            ].join('\n')
        )
        fs.writeFileSync(path.join(dir, 'src', 'server.ts'), "Bun.file('dist/index.html')")
        // `bun run build` will fail here too (no real sources) — the point is
        // the dangling failure is PRESENT and carries referencer + path.
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        const dangling = (out.failures ?? []).filter(f => f.startsWith('dangling artifact:'))
        expect(dangling).toHaveLength(1)
        expect(dangling[0]).toContain('src/server.ts')
        expect(dangling[0]).toContain('dist/index.html')
        // rank 0: it precedes ordinary (rank 1) failures in the ranked list.
        expect(out.failures![0]).toBe(dangling[0])
    })

    test('goes quiet when a producer exists (cp into dist) — no gate failure', async () => {
        const dir = makeDir({
            scripts: {
                test: 'exit 0',
                build: 'node build.js && cp src/template.html dist/index.html'
            }
        })
        fs.mkdirSync(path.join(dir, 'src'), {recursive: true})
        fs.writeFileSync(
            path.join(dir, 'build.js'),
            'await Bun.build({entrypoints: ["src/main.tsx"], outdir: "dist"})'
        )
        fs.writeFileSync(path.join(dir, 'src', 'server.ts'), "Bun.file('dist/index.html')")
        const out = await runFinalIntegrationGate(dir)
        expect((out.failures ?? []).filter(f => f.startsWith('dangling artifact:'))).toHaveLength(0)
    })
})

describe('runFinalIntegrationGate — env-template closure (run 19, nexttask 10)', () => {
    /** The check reads git, so a fixture must be a real work tree. Files written
     *  AFTER the commit are untracked on purpose (inv-untracked-invisible). */
    function makeRepo(
        files: Record<string, string>,
        untracked: Record<string, string> = {}
    ): string {
        const dir = makeDir()
        const write = (rel: string, body: string): void => {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), {recursive: true})
            fs.writeFileSync(path.join(dir, rel), body)
        }
        write(
            'package.json',
            JSON.stringify({name: 'fx', private: true, scripts: {test: 'exit 0'}})
        )
        for (const [rel, body] of Object.entries(files)) write(rel, body)
        spawnSync('git', ['init', '-q'], {cwd: dir})
        spawnSync('git', ['add', '-A'], {cwd: dir})
        spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x'], {
            cwd: dir
        })
        for (const [rel, body] of Object.entries(untracked)) write(rel, body)
        return dir
    }

    const envFailures = (out: {failures?: string[]}): string[] =>
        (out.failures ?? []).filter(f => f.startsWith('env closure:'))

    /** A real run in miniature: `seed.ts` requires two variables the tracked
     *  `.env.example` never declares, and every command passes. */
    const SEED_TS =
        'const phone = process.env.ADMIN_PHONE\n'
        + 'const password = process.env.ADMIN_PASSWORD\n'
        + "const displayName = process.env.ADMIN_DISPLAY_NAME ?? 'Admin'\n"
        + "if (!phone) throw new Error('ADMIN_PHONE environment variable is required')\n"
        + "if (!password) throw new Error('ADMIN_PASSWORD environment variable is required')\n"
        + 'export {displayName}\n'

    test('a required variable no template declares FAILS the gate at rank 0', async () => {
        const dir = makeRepo({
            '.env.example': 'DATABASE_URL=postgres://x\nAPP_URL=http://localhost:3000\n',
            'src/server/seed.ts': SEED_TS
        })
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        const env = envFailures(out)
        expect(env).toHaveLength(2)
        expect(env[0]).toContain('ADMIN_PHONE')
        expect(env[0]).toContain('src/server/seed.ts:1')
        expect(env[1]).toContain('ADMIN_PASSWORD')
        expect(env[1]).toContain('.env.example')
        // rank 0 — the same load-bearing class as boot/render and dangling refs.
        expect(out.failures![0]).toBe(env[0])
    })

    test('inv-no-template-no-finding — no tracked template ⇒ inert, gate PASSes', async () => {
        const out = await runFinalIntegrationGate(makeRepo({'src/server/seed.ts': SEED_TS}))
        expect(envFailures(out)).toHaveLength(0)
        expect(out.ok).toBe(true)
    })

    test('inv-declared-silent — a declared variable never produces a finding', async () => {
        const out = await runFinalIntegrationGate(
            makeRepo({
                '.env.example': 'ADMIN_PHONE=\nADMIN_PASSWORD=\n',
                'src/server/seed.ts': SEED_TS
            })
        )
        expect(envFailures(out)).toHaveLength(0)
        expect(out.ok).toBe(true)
    })

    test('inv-untracked-invisible — gitignored/untracked reads and templates are silent', async () => {
        const out = await runFinalIntegrationGate(
            makeRepo(
                {'.env.example': 'DATABASE_URL=\n', '.gitignore': 'scratch.ts\n.env\n'},
                {
                    'scratch.ts':
                        "const k = process.env.IGNORED_SECRET\nif (!k) throw new Error('x')\n",
                    'untracked.ts':
                        "const k = process.env.OTHER_SECRET\nif (!k) throw new Error('x')\n",
                    '.env.sample': '# untracked template\n',
                    '.env': 'DATABASE_URL=postgres://local\n'
                }
            )
        )
        expect(envFailures(out)).toHaveLength(0)
        expect(out.ok).toBe(true)
    })

    test('inv-no-verdict-flip-on-clean — a complete template with unread extras stays green', async () => {
        // dace-pro's shape: more declared than required. The check is
        // one-directional and must never complain about the other direction.
        const out = await runFinalIntegrationGate(
            makeRepo({
                '.env.example': 'ADMIN_PHONE=\nADMIN_PASSWORD=\nSMTP_HOST=\nSMTP_PORT=\nUNUSED=\n',
                'src/server/seed.ts': SEED_TS
            })
        )
        expect(envFailures(out)).toHaveLength(0)
        expect(out.ok).toBe(true)
    })

    test('inv-idempotent — the same tree yields the same failure list twice', async () => {
        const dir = makeRepo({
            '.env.example': 'DATABASE_URL=\n',
            'src/server/seed.ts': SEED_TS
        })
        const a = await runFinalIntegrationGate(dir)
        const b = await runFinalIntegrationGate(dir)
        expect(envFailures(a)).toEqual(envFailures(b))
    })

    test('one finding per variable, however many files read it', async () => {
        const out = await runFinalIntegrationGate(
            makeRepo({
                '.env.example': 'DATABASE_URL=\n',
                'src/a.ts': "const p = process.env.ADMIN_PHONE\nif (!p) throw new Error('x')\n",
                'src/b.ts': "const q = process.env.ADMIN_PHONE\nif (!q) throw new Error('x')\n"
            })
        )
        expect(envFailures(out)).toHaveLength(1)
    })
})

describe('runFinalIntegrationGate — serve-entry closure (run 18, nexttask 2B)', () => {
    /** The failing shape in miniature: a Hono app with an SPA fallback and no bind. */
    function makeUnservableTree(scripts: Record<string, string>): string {
        const dir = makeDir({name: 'x', dependencies: {hono: '4'}, scripts})
        fs.mkdirSync(path.join(dir, 'src', 'server'), {recursive: true})
        fs.writeFileSync(
            path.join(dir, 'src', 'server', 'index.ts'),
            "import {Hono} from 'hono'\nconst app = new Hono()\n"
                + "app.get('*', async c => c.body(await Bun.file('dist/index.html').arrayBuffer()))\n"
                + 'export {app}\n'
        )
        return dir
    }

    test('an app nothing can start FAILS the gate at rank 0, even with green tests', async () => {
        const dir = makeUnservableTree({test: 'exit 0', dev: 'docker compose up'})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        const found = (out.failures ?? []).filter(f => f.startsWith('serve entry missing:'))
        expect(found).toHaveLength(1)
        expect(found[0]).toContain('src/server/index.ts')
        // rank 0 — it leads the ranked list, ahead of any ordinary failure.
        expect(out.failures![0]).toBe(found[0])
    })

    test('runs even when NOTHING dynamic is discoverable — a static check needs no runner', async () => {
        // No scripts at all: the gate's zero-discovery door returns UNOBSERVED, which
        // must not swallow a defect that is decidable from the tree alone.
        const dir = makeUnservableTree({})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('serve entry missing:')
    })

    test('a rejected launch script is UNOBSERVED, not silence (2A + nexttask 1)', async () => {
        // Served app that DOES bind, so the serve-entry section is quiet — the only
        // thing wrong is that its one launch script cannot start it.
        const dir = makeUnservableTree({test: 'exit 0', dev: 'docker compose up -d'})
        fs.appendFileSync(
            path.join(dir, 'src', 'server', 'index.ts'),
            'Bun.serve({port: 3000, fetch: app.fetch})\n'
        )
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('is not a launch')
        expect(out.unobserved).toContain('container orchestration')
        expect(out.reason).toContain('never observed to run')
    })

    test('the same tree WITH a listener passes the section', async () => {
        const dir = makeUnservableTree({test: 'exit 0'})
        fs.appendFileSync(
            path.join(dir, 'src', 'server', 'index.ts'),
            'Bun.serve({port: 3000, fetch: app.fetch})\n'
        )
        const out = await runFinalIntegrationGate(dir)
        expect((out.failures ?? []).filter(f => f.startsWith('serve entry missing:'))).toHaveLength(
            0
        )
    })
})

describe('CLOSURE_SCANS — the run-level closure scan table and its driver', () => {
    /** Collect what the driver feeds the gate's `fail`, rank included. */
    function drive(
        stage: 'pre-discovery' | 'post-boot',
        scans: ClosureScan[]
    ): Array<{rank: number; text: string}> {
        const out: Array<{rank: number; text: string}> = []
        runClosureScans(stage, {cwd: '/nonexistent'}, (text, rank) => out.push({rank, text}), scans)
        return out
    }

    const row = (id: string, run: ClosureScan['run'], rank = 0): ClosureScan => ({
        id,
        stage: 'post-boot',
        rank,
        run
    })

    test('the table holds exactly the three checks that share this shape', () => {
        expect(CLOSURE_SCANS.map(s => s.id)).toEqual([
            'serve-entry',
            'dangling-artifact',
            'env-template'
        ])
        // All three say some form of "the app cannot be started / cannot serve what
        // it references / cannot be configured", which is rank 0 by construction.
        expect(CLOSURE_SCANS.every(s => s.rank === 0)).toBe(true)
    })

    test('serve-entry is pre-discovery — a static check must survive the zero-discovery door', () => {
        const byId = new Map(CLOSURE_SCANS.map(s => [s.id, s.stage]))
        expect(byId.get('serve-entry')).toBe('pre-discovery')
        expect(byId.get('dangling-artifact')).toBe('post-boot')
        expect(byId.get('env-template')).toBe('post-boot')
    })

    test('a scanner that THROWS does not stop the scans after it (fault isolation is per row)', () => {
        const got = drive('post-boot', [
            row('first', function* () {
                yield 'first finding'
            }),
            // Throws on CALL — the realistic shape (the scan faults reading the tree).
            row('boom', () => {
                throw new Error('scanner fault')
            }),
            row('third', function* () {
                yield 'third finding'
            })
        ])
        expect(got.map(f => f.text)).toEqual(['first finding', 'third finding'])
    })

    test('a scan that throws MID-list keeps the findings it already emitted', () => {
        // The pre-table code formatted and failed one finding at a time inside the
        // try, so a partial scan kept its partial output. Rows are generators for
        // exactly this reason — an eager `.map()` would have lost the first finding.
        const got = drive('post-boot', [
            row('partial', function* () {
                yield 'kept'
                throw new Error('fault after the first finding')
            }),
            row('after', function* () {
                yield 'still ran'
            })
        ])
        expect(got.map(f => f.text)).toEqual(['kept', 'still ran'])
    })

    test('the driver runs only its own stage, in table order', () => {
        const scans: ClosureScan[] = [
            {
                id: 'early',
                stage: 'pre-discovery',
                rank: 0,
                *run() {
                    yield 'early'
                }
            },
            row('late-a', function* () {
                yield 'late-a'
            }),
            row('late-b', function* () {
                yield 'late-b'
            })
        ]
        expect(drive('pre-discovery', scans).map(f => f.text)).toEqual(['early'])
        expect(drive('post-boot', scans).map(f => f.text)).toEqual(['late-a', 'late-b'])
    })

    test("the rank is the ROW's, not a hand-typed argument at a call site", () => {
        const got = drive('post-boot', [
            row(
                'ordinary',
                function* () {
                    yield 'rank one finding'
                },
                1
            ),
            row('load-bearing', function* () {
                yield 'rank zero finding'
            })
        ])
        expect(got).toEqual([
            {rank: 1, text: 'rank one finding'},
            {rank: 0, text: 'rank zero finding'}
        ])
    })

    test('a row sees cwd and planText — the serve-entry scan needs the plan', () => {
        const seen: Array<{cwd: string; planText?: string}> = []
        runClosureScans('post-boot', {cwd: '/tmp/x', planText: 'the app serves'}, () => {}, [
            row('spy', input => {
                seen.push(input)
                return []
            })
        ])
        expect(seen).toEqual([{cwd: '/tmp/x', planText: 'the app serves'}])
    })
})

describe('runFinalIntegrationGate — ACCEPT-debt re-check (run 4 B3 / run 8 TASK_0012)', () => {
    test('a non-static (frozen-path) debt is SURFACED on a PASS and kept in the ledger', async () => {
        const dir = makeDir() // no manifest → statics + integration trivially pass
        await recordDebt(dir, 'TASK_0012', 'modified frozen path src/main.tsx', 'accepted')
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([
            {taskId: 'TASK_0012', reason: 'modified frozen path src/main.tsx'}
        ])
        // The note rides in its own field: `reason` stays mechanical because it
        // seeds the autofix child.
        expect(out.debtNote).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (1)')
        expect(out.debtNote).toContain('TASK_0012')
        expect(out.reason).not.toContain('UNRESOLVED VERIFY-FAIL DEBT')
        // Behavioral debts are never auto-closed — the ledger still holds it for resume.
        expect(await readAcceptDebts(dir)).toHaveLength(1)
    })

    test('a static-class debt is RESOLVED and PRUNED when the gate statics now pass', async () => {
        const dir = makeDir({scripts: {lint: 'exit 0'}}) // static check passes
        await recordDebt(
            dir,
            'TASK_0009',
            'repo health: bun run lint exited 1 — 3 errors',
            'accepted'
        )
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([])
        expect(out.reason).not.toContain('ACCEPTED VERIFY-FAIL DEBT')
        // Provably resolved ⇒ pruned from the ledger so resume does not re-surface it.
        expect(await readAcceptDebts(dir)).toEqual([])
    })

    test('a static-class debt stays OPEN and surfaces when the gate statics still fail', async () => {
        const dir = makeDir({scripts: {lint: 'exit 1'}}) // static check fails
        await recordDebt(
            dir,
            'TASK_0009',
            'repo health: bun run lint exited 1 — 3 errors',
            'accepted'
        )
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('static checks:')
        expect(out.openDebts).toHaveLength(1)
        expect(out.debtNote).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (1)')
        expect(out.reason).not.toContain('UNRESOLVED VERIFY-FAIL DEBT')
        expect(await readAcceptDebts(dir)).toHaveLength(1)
    })

    test('mixed: static debt pruned, behavioral debt surfaced (only the provable one closes)', async () => {
        const dir = makeDir({scripts: {lint: 'exit 0'}})
        await recordDebt(dir, 'T9', 'repo health: lint exited 1', 'accepted')
        await recordDebt(dir, 'T12', 'upload endpoint returned HTML not JSON', 'accepted')
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
        expect(out.debtNote).toBeUndefined()
        expect(out.reason).not.toContain('ACCEPTED VERIFY-FAIL DEBT')
    })
})

describe('taskThatIntroduced + end-to-end conflict annotation (mx5 run 11)', () => {
    const git = (dir: string, ...args: string[]): void => {
        const r = Bun.spawnSync(['git', ...args], {cwd: dir})
        if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
    }

    /** A throwaway repo where a task's commit introduces the admin page. */
    function makeRepoWithTaskCommits(): string {
        const dir = makeDir()
        git(dir, 'init', '-q')
        git(dir, 'config', 'user.email', 'test@test')
        git(dir, 'config', 'user.name', 'test')
        fs.mkdirSync(path.join(dir, 'src/client/pages'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'src/client/pages/home.tsx'), 'export const Home = 1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'task: Client shell (TASK_0006)')
        fs.writeFileSync(path.join(dir, 'src/client/pages/admin.tsx'), 'export const Admin = 1\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'task: Admin panel page with user ban toggle (TASK_0008)')
        return dir
    }

    test('resolves the ORIGINAL introducing task commit, even after deletion', async () => {
        const dir = makeRepoWithTaskCommits()
        expect(taskThatIntroduced(dir, 'src/client/pages/admin.tsx')).toBe('TASK_0008')
        // The shape: the file was rm'd from the worktree — attribution holds.
        fs.rmSync(path.join(dir, 'src/client/pages/admin.tsx'))
        expect(taskThatIntroduced(dir, 'src/client/pages/admin.tsx')).toBe('TASK_0008')
    })

    test('a non-task commit or unknown file attributes to nobody', () => {
        const dir = makeRepoWithTaskCommits()
        fs.writeFileSync(path.join(dir, 'README.md'), 'x\n')
        git(dir, 'add', '-A')
        git(dir, 'commit', '-qm', 'docs: readme')
        expect(taskThatIntroduced(dir, 'README.md')).toBeNull()
        expect(taskThatIntroduced(dir, 'src/never/was.ts')).toBeNull()
        expect(taskThatIntroduced(makeDir(), 'anything.ts')).toBeNull() // not a repo
    })

    test('gate outcome: T9-shaped debt is annotated CONFLICTING; reason stays mechanical', async () => {
        const dir = makeRepoWithTaskCommits()
        await recordDebt(
            dir,
            'TASK_0009',
            'Verification check #7 fails: src/client/pages/admin.tsx exists (introduced by '
                + 'prior TASK_0008, not this task).',
            'accepted'
        )
        const out = await runFinalIntegrationGate(dir)
        expect(out.openDebts).toHaveLength(1)
        expect(out.openDebts![0].conflict).toContain("TASK_0008's committed deliverable")
        expect(out.debtNote).toContain('⚠ CONFLICTING CLAIM')
        // The autofix seed (reason) must not carry the claim.
        expect(out.reason).not.toContain('admin.tsx')
    })
})

// Existence is not launchability — declared launch scripts must RUN.
describe('runFinalIntegrationGate — launch-contract scripts EXECUTE (run 11)', () => {
    test('a declared script that dies on first call FAILs the gate with its output', async () => {
        // The shape: migrate/seed shipped with a first-call TypeError
        // (`.rows` on a Bun sql array result) and every gate stayed green.
        const dir = makeDir({
            scripts: {
                test: 'exit 0',
                migrate: `node -e "console.error('TypeError: undefined is not an object (evaluating result.rows)'); process.exit(1)"`
            }
        })
        await appendDeclaredScripts(dir, ['migrate', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('launch script: `bun run migrate` exited 1')
        expect(out.reason).toContain('result.rows')
    })

    test('a declared launch script RUNS even when no integration/boot command is discoverable', async () => {
        // Firing the zero-discovery return BEFORE the launch-script loop
        // (found and left unfixed in f5d7110): a package.json whose only scripts
        // are `migrate`/`seed` discovers no test/build/start, so the gate returned
        // UNOBSERVED without ever running the launch contract it had been handed.
        // The return now asks the tally — no attempt, no failure — after the loop.
        const dir = makeDir({
            scripts: {
                migrate: `node -e "console.error('TypeError: undefined is not an object (evaluating result.rows)'); process.exit(1)"`
            }
        })
        await appendDeclaredScripts(dir, ['migrate'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('launch script: `bun run migrate` exited 1')
        expect(out.reason).toContain('result.rows')
    })

    test('a declared launch script that passes on a zero-discovery tree is a PASS naming it', async () => {
        const dir = makeDir({scripts: {seed: 'exit 0'}})
        await appendDeclaredScripts(dir, ['seed'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.unobserved).toBeUndefined()
        expect(out.reason).toBe('statics + `bun run seed` passed')
    })

    test('nothing declared, nothing discoverable → the zero-discovery UNOBSERVED verdict, unchanged', async () => {
        const dir = makeDir({scripts: {verify: 'exit 0'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('nothing at all')
        expect(out.reason).toBe(out.unobserved!)
    })

    test('missing external infrastructure is an env gap, not a script fault', async () => {
        const dir = makeDir({
            scripts: {
                test: 'exit 0',
                migrate: `node -e "console.error('connect ECONNREFUSED 127.0.0.1:5432'); process.exit(1)"`
            }
        })
        await appendDeclaredScripts(dir, ['migrate', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.reason).not.toContain('WARNING') // no excuse note → plain skip
    })

    test('an infra-gap skip whose script carries a standing EXCUSE note surfaces UNOBSERVED', async () => {
        const dir = makeDir({
            scripts: {
                test: 'exit 0',
                migrate: `node -e "console.error('connect ECONNREFUSED 127.0.0.1:5432'); process.exit(1)"`
            }
        })
        await appendDeclaredScripts(dir, ['migrate', 'test'])
        // The verbatim excuse-note class: the note excused the exact
        // scripts that shipped broken.
        await appendEnvNotes(
            dir,
            ['pre-existing scripts have .rows bug — migrate and seed fail, unrelated to this task'],
            'TASK_0002'
        )
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.reason).toContain('WARNING')
        expect(out.reason).toContain('`migrate`')
        expect(out.reason).toContain('UNOBSERVED')
    })

    test('boot-class declared scripts are NOT run as one-shots (the boot check owns them)', async () => {
        // `watch` would exit 1 if executed; it must be excluded as boot-class.
        const dir = makeDir({
            scripts: {test: 'exit 0', watch: 'exit 1'}
        })
        await appendDeclaredScripts(dir, ['watch', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.reason).not.toContain('watch')
    })

    test('already-covered integration scripts are not run twice', async () => {
        // `test` is declared AND an integration command; a double run would append
        // to the marker file twice.
        const dir = makeDir({
            scripts: {test: `node -e "require('fs').appendFileSync('ran.txt','x')"`}
        })
        await appendDeclaredScripts(dir, ['test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(fs.readFileSync(path.join(dir, 'ran.txt'), 'utf8')).toBe('x')
    })

    test('launch scripts run in declared order, after integration commands', async () => {
        const dir = makeDir({
            scripts: {
                test: `node -e "require('fs').appendFileSync('order.txt','test;')"`,
                migrate: `node -e "require('fs').appendFileSync('order.txt','migrate;')"`,
                seed: `node -e "require('fs').appendFileSync('order.txt','seed;')"`
            }
        })
        await appendDeclaredScripts(dir, ['seed', 'migrate', 'test'])
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(fs.readFileSync(path.join(dir, 'order.txt'), 'utf8')).toBe('test;seed;migrate;')
        expect(out.reason).toContain('`bun run seed`')
        expect(out.reason).toContain('`bun run migrate`')
    })
})

describe('observabilityGapFailure — full-skip is never a PASS (mx5 run 16)', () => {
    const resolvable = () => true
    const unresolvable = () => false

    test('nothing discovered → no gap (a repo with nothing to run is legitimately static-only)', () => {
        expect(
            observabilityGapFailure({
                attempted: 0,
                observed: 0,
                spawnFailures: 0,
                runnerBins: [],
                runnerResolvable: resolvable
            })
        ).toBeNull()
    })

    test('at least one command observed (pass or fail) → no gap', () => {
        expect(
            observabilityGapFailure({
                attempted: 5,
                observed: 1,
                spawnFailures: 4,
                runnerBins: ['bun'],
                runnerResolvable: resolvable
            })
        ).toBeNull()
    })

    test('tool-level gaps only (runner spawned; browser/127 skips) → NO gap — the classic env-gap contract holds', () => {
        expect(
            observabilityGapFailure({
                attempted: 3,
                observed: 0,
                spawnFailures: 0,
                runnerBins: ['bun'],
                runnerResolvable: resolvable
            })
        ).toBeNull()
    })

    test('every attempt failed to even SPAWN → rank-0 failure text naming the count', () => {
        const t = observabilityGapFailure({
            attempted: 7,
            observed: 0,
            spawnFailures: 7,
            runnerBins: ['bun'],
            runnerResolvable: resolvable
        })
        expect(t).toContain('observability gap')
        expect(t).toContain('7 integration/boot command(s)')
        expect(t).toContain('cannot vouch')
        // Runner IS resolvable here, so the text must not blame it.
        expect(t).not.toContain('not spawnable')
    })

    test('the run-16 shape: all skipped AND the runner is unspawnable → the runner is named', () => {
        const t = observabilityGapFailure({
            attempted: 4,
            observed: 0,
            spawnFailures: 4,
            runnerBins: ['bun'],
            runnerResolvable: unresolvable
        })
        expect(t).toContain('`bun`')
        expect(t).toContain('not spawnable')
    })
})

/**
 * The THIRD verdict. Zero discovery returning
 * `PASS — no integration command found (statics passed)`, so "we never checked" read
 * exactly like "we checked and it was fine" — the same blindness class,
 * entering through the door observabilityGapFailure deliberately leaves open
 * (attempted === 0 → null). The two guards are complementary and BOTH are asserted
 * here on the same inputs, because the guard must not be softened to make room
 * for this one.
 */
describe('unobservedVerdict — zero observation is UNOBSERVED, never a PASS (IAR1)', () => {
    const resolvable = () => true

    test('truth table: attempted=0/observed=0 → gap guard silent, UNOBSERVED note raised', async () => {
        expect(
            observabilityGapFailure({
                attempted: 0,
                observed: 0,
                spawnFailures: 0,
                runnerBins: [],
                runnerResolvable: resolvable
            })
        ).toBeNull()
        const t = unobservedVerdict({discovered: 0, observed: 0})
        expect(t).toContain('UNOBSERVED')
        expect(t).toContain('NOT a pass')
        expect(t).toContain('no integration, lockfile or boot command was discoverable')
        // Short enough to survive the run-level trail's 300-char slice intact —
        // the durable record IS the point of this verdict.
        expect(t!.length).toBeLessThanOrEqual(300)
    })

    test('truth table: attempted>0/observed=0/allSpawnFail → gap guard FAILS, and the note also fires', () => {
        // The rank-0 failure owns this case; the note is redundant-but-consistent
        // (the gate returns on the failure list before ever reading it).
        expect(
            observabilityGapFailure({
                attempted: 3,
                observed: 0,
                spawnFailures: 3,
                runnerBins: ['bun'],
                runnerResolvable: resolvable
            })
        ).toContain('observability gap')
        expect(unobservedVerdict({discovered: 3, observed: 0})).toContain('UNOBSERVED')
    })

    test('truth table: attempted>0/observed=0/toolGap → gap guard silent (env-gap contract), UNOBSERVED note names the count', () => {
        expect(
            observabilityGapFailure({
                attempted: 3,
                observed: 0,
                spawnFailures: 0,
                runnerBins: ['bun'],
                runnerResolvable: resolvable
            })
        ).toBeNull()
        const t = unobservedVerdict({discovered: 3, observed: 0})
        expect(t).toContain('all 3 discovered command(s) skipped as environment gaps')
        expect(t).toContain('NOT a pass')
    })

    test('truth table: attempted>0/observed>0 → both guards silent (a real PASS is untouched)', () => {
        expect(
            observabilityGapFailure({
                attempted: 3,
                observed: 1,
                spawnFailures: 0,
                runnerBins: ['bun'],
                runnerResolvable: resolvable
            })
        ).toBeNull()
        expect(unobservedVerdict({discovered: 3, observed: 1})).toBeNull()
        // One observation out of many is still an observation: the verdict turns on
        // whether ANYTHING dynamic ran, never on how much of it did.
        expect(unobservedVerdict({discovered: 99, observed: 1})).toBeNull()
    })

    test('a tree with nothing discoverable (the IAR1 shape) carries the UNOBSERVED note, not a bare PASS', async () => {
        const out = await runFinalIntegrationGate(makeDir())
        // NON-BLOCKING by decision (see unobservedVerdict): ok stays true — there is
        // nothing here a fix child could legitimately repair, and the harvest lever
        // that would give such projects a command source was refuted.
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('UNOBSERVED')
        expect(out.reason).toContain('UNOBSERVED')
        expect(out.reason).not.toContain('no integration command found (statics passed)')
    })

    test('a tree whose only discovered command env-gap-skips is UNOBSERVED too — and is still not a FAIL (I2)', async () => {
        const dir = makeDir({scripts: {test: "node -e 'process.exit(127)'"}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('all 1 discovered command(s) skipped')
    })

    test('I1: a project whose commands actually RUN is unaffected — no note, verbatim reason', async () => {
        const dir = makeDir({scripts: {test: 'exit 0', build: 'exit 0'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.unobserved).toBeUndefined()
        expect(out.reason).toBe('statics + `bun run test`, `bun run build` passed')
    })

    test('I1: a FAILing project is unaffected — the failure text is the whole reason', async () => {
        const dir = makeDir({scripts: {test: 'echo "boom" && exit 1'}})
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(false)
        expect(out.unobserved).toBeUndefined()
        expect(out.reason).toContain('`bun run test` exited 1')
        expect(out.reason).not.toContain('UNOBSERVED')
    })
})

/**
 * A SKIPPED boot check is a verdict, not a silence.
 *
 * The shape reproduced exactly: a served app whose boot command was
 * discovered and env-gap-skipped, while every other dynamic command ran and
 * passed — so dynObserved > 0, observabilityGapFailure stayed correctly quiet, and
 * "the app was never observed to boot" produced byte-identical output to "the app
 * booted fine". Backed by a base rate, a two-armed A/B, and a
 * zero-false-positive suite.
 */
describe('bootSkipVerdict — a discovered boot that never ran is UNOBSERVED (mx5 run 18)', () => {
    /** A served app (hono in deps is what detectsServedApp reads) whose `dev`
     *  script exits 127 inside the chain — a docker-less skip, in miniature. */
    const servedSkipPkg = (extra: Record<string, string> = {}) => ({
        dependencies: {hono: '4.12.27'},
        scripts: {test: 'exit 0', build: 'exit 0', dev: 'pi-task-no-such-binary-9f3c', ...extra}
    })

    test('truth table: fires only for a DISCOVERED + SKIPPED boot on a served app', () => {
        const note = bootSkipVerdict({label: 'bun run dev', skipped: true, expectServer: true})
        expect(note).toContain('`bun run dev`')
        expect(note).toContain('NEVER RAN')
        expect(note).toContain('not observed to start')
        // Leads the reason, which the run-level trail slices at 300 chars — the
        // command name must always survive that slice.
        expect(note!.length).toBeLessThanOrEqual(200)
        // Nothing to boot is NOT the same as a boot that was not observed.
        expect(bootSkipVerdict({label: null, skipped: true, expectServer: true})).toBeNull()
        // A boot that ran (pass/fail/orphan-port) is already a real observation.
        expect(
            bootSkipVerdict({label: 'bun run dev', skipped: false, expectServer: true})
        ).toBeNull()
        // CLI/library projects are fenced off by decision (inv-cli-unaffected).
        expect(
            bootSkipVerdict({label: 'bun run dev', skipped: true, expectServer: false})
        ).toBeNull()
    })

    test('the run-18 shape: other commands PASS, the boot skips → UNOBSERVED, not a bare PASS', async () => {
        const dir = makeDir(servedSkipPkg())
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        // Non-blocking by decision, exactly like unobservedVerdict: a missing docker
        // is not something an autofix child can repair, and putting it in `reason`
        // as a FAIL invites a fabricated boot command.
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('NEVER RAN')
        expect(out.unobserved).toContain('`bun run dev`')
        expect(out.reason).toContain('`bun run dev`')
        expect(out.reason).toContain('NEVER RAN')
    })

    test('observations from OTHER commands cannot cancel it — the CT-tests trap', async () => {
        // A suite can be green on dozens of Playwright CT tests with no server at all:
        // CT mounts components,
        // it never assembles or starts one. Six observed commands here, boot still
        // unobserved, and the zero-observation note must NOT fire (things did run).
        const dir = makeDir(
            servedSkipPkg({'test:ct': 'exit 0', 'test:e2e': 'exit 0', lint: 'exit 0'})
        )
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('NEVER RAN')
        expect(out.unobserved).not.toContain('gate ran nothing')
        expect(out.reason).toContain('`bun run test:ct`')
    })

    test('inv-nothing-to-boot: a served app with NO start/dev script keeps its bare PASS', async () => {
        const dir = makeDir({
            dependencies: {hono: '4.12.27'},
            scripts: {test: 'exit 0', build: 'exit 0'}
        })
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(out.unobserved).toBeUndefined()
        expect(out.reason).toBe('statics + `bun run test`, `bun run build` passed')
    })

    test('inv-cli-unaffected: no server dependency ⇒ byte-identical to having no boot at all', async () => {
        const cli = makeDir({
            scripts: {test: 'exit 0', build: 'exit 0', dev: 'pi-task-no-such-bin'}
        })
        const none = makeDir({scripts: {test: 'exit 0', build: 'exit 0'}})
        const a = await runFinalIntegrationGate(cli, {timeoutMs: 900_000, bootGraceMs: 400})
        const b = await runFinalIntegrationGate(none, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(a.unobserved).toBeUndefined()
        expect(a.reason).toBe(b.reason)
    })

    test('inv-boot-pass-untouched: a boot that really listens is unchanged', async () => {
        const dir = makeDir({
            dependencies: {hono: '4.12.27'},
            scripts: {test: 'exit 0', start: 'sleep 30'}
        })
        // Grace must outlast the 500ms listener poll, or the boot never gets the
        // chance to be observed and this stops being a boot-`pass` case at all.
        const out = await runFinalIntegrationGate(dir, {
            timeoutMs: 900_000,
            bootGraceMs: 5_000,
            bootDeps: {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({outcome: 'pass', detail: 'rendered'}),
                deepRenderProbe: () => ({outcome: 'pass', detail: 'authenticated'})
            }
        })
        expect(out.ok).toBe(true)
        expect(out.unobserved).toBeUndefined()
        expect(out.reason).toBe('statics + `bun run test`, `bun run start` passed')
        // Timeout > graceMs: where expectServer collapses (win32) there is no
        // listener poll to end the boot early, so it always burns the full grace.
    }, 30_000)

    test('the same skip when the runner, not a posix shell, reports the miss (CI regression)', async () => {
        // Windows bun runs the script in its OWN shell: no 127, just exit 1 with
        // `bun: command not found: …`. Reproduced here on every platform so the
        // contract is one contract — a boot that never ran is UNOBSERVED, never a
        // FAIL, whichever shell noticed the binary was missing.
        const dir = makeDir({
            dependencies: {hono: '4.12.27'},
            scripts: {
                test: 'exit 0',
                dev: `node -e "console.error('bun: command not found: no-such-bin'); process.exit(1)"`
            }
        })
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(out.ok).toBe(true)
        expect(out.failures ?? []).toEqual([])
        expect(out.unobserved).toContain('NEVER RAN')
        expect(out.unobserved).toContain('`bun run dev`')
    })

    test('a boot skip does NOT turn a FAILing gate into a different failure', async () => {
        const dir = makeDir(servedSkipPkg({test: 'echo boom && exit 1'}))
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(out.ok).toBe(false)
        expect(out.unobserved).toBeUndefined()
        expect(out.failures?.some(f => f.includes('NEVER RAN'))).toBeFalsy()
    })

    test('both notes stack when NOTHING ran either — boot named first', async () => {
        const dir = makeDir({
            dependencies: {hono: '4.12.27'},
            scripts: {test: "node -e 'process.exit(127)'", dev: 'pi-task-no-such-binary-9f3c'}
        })
        const out = await runFinalIntegrationGate(dir, {timeoutMs: 900_000, bootGraceMs: 400})
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('NEVER RAN')
        expect(out.unobserved).toContain('skipped as environment gaps')
        expect(out.unobserved!.indexOf('NEVER RAN')).toBeLessThan(
            out.unobserved!.indexOf('skipped as environment gaps')
        )
    })
})

// ─── the debt-closing path (was untested) ────────────────────────────────────

/**
 * `runVerifyCommandLine` and `rerunDebtVerifyCommand` are the only things in the
 * gate that can auto-CLOSE a recorded debt (`inv-no-false-clear`), and until the
 * command runner became injectable they had no `bun test` coverage at all — their
 * only callers were harness scripts. The tracked-state guard below, which decides
 * whether "the command edited the tree into a pass", was entirely unexercised.
 */
function scriptedRunner(byBin: Record<string, CommandRun | CommandRun[]>): {
    run: CommandRunner
    seen: string[]
} {
    const seen: string[] = []
    const counts: Record<string, number> = {}
    const run: CommandRunner = async spec => {
        seen.push([spec.bin, ...spec.args].join(' '))
        const entry = byBin[spec.bin]
        if (entry === undefined) throw new Error(`no scripted result for ${spec.bin}`)
        if (!Array.isArray(entry)) return entry
        const i = counts[spec.bin] ?? 0
        counts[spec.bin] = i + 1
        return entry[Math.min(i, entry.length - 1)]
    }
    return {run, seen}
}

const ok = (stdout = ''): CommandRun => ({
    failedToStart: false,
    status: 0,
    stdout,
    stderr: ''
})

test('runVerifyCommandLine: a VERIFY line is run through sh -c, not as an argv', async () => {
    const {run, seen} = scriptedRunner({sh: ok()})
    const r = await runVerifyCommandLine(
        '/repo',
        'AGENT=1 bun test a.test.ts',
        1000,
        undefined,
        run
    )
    expect(r.outcome).toBe('pass')
    // Env prefixes, && and redirects are ordinary in a VERIFY line, so it must
    // reach a shell rather than being split into a binary and arguments.
    expect(seen[0]).toBe('sh -c AGENT=1 bun test a.test.ts')
})

test('runVerifyCommandLine: only exit 0 is conclusive — everything else leaves the debt open', async () => {
    const cases: Array<[CommandRun, 'pass' | 'fail' | 'gap']> = [
        [ok(), 'pass'],
        [{failedToStart: false, status: 1, stdout: '', stderr: '2 failing'}, 'fail'],
        [
            {failedToStart: true, failureMessage: 'ENOENT', status: null, stdout: '', stderr: ''},
            'gap'
        ],
        [{failedToStart: false, status: null, stdout: '', stderr: ''}, 'gap'],
        [{failedToStart: false, status: 127, stdout: '', stderr: 'sh: bun: not found'}, 'gap'],
        [
            {
                failedToStart: false,
                status: 1,
                stdout: '',
                stderr: 'connect ECONNREFUSED 127.0.0.1:5432'
            },
            'gap'
        ]
    ]
    for (const [result, expected] of cases) {
        const {run} = scriptedRunner({sh: result})
        expect(
            (await runVerifyCommandLine('/repo', 'bun test', 1000, undefined, run)).outcome
        ).toBe(expected)
    }
})

test('rerunDebtVerifyCommand: a clean pass with an unchanged tree CLOSES the debt', async () => {
    const {run} = scriptedRunner({git: ok(''), sh: ok()})
    expect(await rerunDebtVerifyCommand('/repo', 'bun test', run)).toEqual({outcome: 'pass'})
})

test('rerunDebtVerifyCommand: a pass that CHANGED tracked files proves nothing', async () => {
    // inv-no-write. A re-run that edits the tree into a pass would have the run
    // certifying its own side effect, so the pass is downgraded to INCONCLUSIVE.
    const {run} = scriptedRunner({git: [ok(''), ok(' M src/app.ts\n')], sh: ok()})
    const r = await rerunDebtVerifyCommand('/repo', 'bun test', run)
    expect(r.outcome).toBe('gap')
    expect(r.detail).toContain('CHANGED tracked files')
})

test('rerunDebtVerifyCommand: untracked output does not trip the guard', async () => {
    // `git status --porcelain --untracked-files=no` is what the guard reads, so a
    // build's own artifacts — which a repo with the usual ignores does not track —
    // leave the before/after strings identical.
    const {run} = scriptedRunner({git: ok(''), sh: ok()})
    expect((await rerunDebtVerifyCommand('/repo', 'bun run build && bun test', run)).outcome).toBe(
        'pass'
    )
})

test('rerunDebtVerifyCommand: a repo the guard cannot READ is inconclusive, not a pass', async () => {
    // "Nothing changed" would be an assumption rather than an observation.
    const gitGone: CommandRun = {
        failedToStart: true,
        failureMessage: 'ENOENT',
        status: null,
        stdout: '',
        stderr: ''
    }
    const {run} = scriptedRunner({git: gitGone, sh: ok()})
    const r = await rerunDebtVerifyCommand('/repo', 'bun test', run)
    expect(r.outcome).toBe('gap')
    expect(r.detail).toContain('could not read git status')
})

test('rerunDebtVerifyCommand: a FAILING command never reaches the tracked-state guard', async () => {
    // Only the pass path needs the guard, and a failing re-run must report the
    // failure rather than a git-read problem.
    const {run, seen} = scriptedRunner({
        git: ok(''),
        sh: {failedToStart: false, status: 1, stdout: '', stderr: 'assertion failed'}
    })
    const r = await rerunDebtVerifyCommand('/repo', 'bun test', run)
    expect(r.outcome).toBe('fail')
    expect(r.detail).toContain('exit 1')
    // One git read (the "before"), never the second.
    expect(seen.filter(c => c.startsWith('git')).length).toBe(1)
})

// ─── The config-gap demotion, reachable at last ──────────────────────────────
//
//  shipped this branch and it has never executed under test. Not by
// oversight: reaching it needs `scanEnvTemplateClosure` to find a TRACKED
// `.env.example` in a real git work tree, and every launch-contract test uses a
// bare `makeDir()` with no `git init` — so `closure.templates` was always empty
// and `findLaunchConfigGap` always returned null. Covering it on real spawns
// would take seven independent pieces of on-disk state, simultaneously, for one
// `if`. With `envClosure`/`trackedFiles`/`run` seamed, the four facts the branch
// actually reads are stated directly.
//
// This is the highest-stakes branch in the file: it is the difference between a
// failing launch script FAILING the run and being demoted to UNOBSERVED debt.
describe('launch-script config gap → UNOBSERVED, not FAIL (run 20)', () => {
    const SEED = 'const p = process.env.ADMIN_PHONE!\nconsole.log(p.length)\n'

    /** A tree whose `seed` script reads a variable its tracked template declares.
     *  `seed` is DECLARED (the plan-time launch contract), which is what puts it in
     *  the executing loop at all. */
    async function gapDir(): Promise<string> {
        // A discoverable integration command too: with only `seed` the gate takes
        // the zero-discovery early return and never reaches the launch loop.
        const dir = makeDir({scripts: {test: 'exit 0', seed: 'bun run src/seed.ts'}})
        fs.mkdirSync(path.join(dir, 'src'), {recursive: true})
        fs.writeFileSync(path.join(dir, 'src/seed.ts'), SEED)
        fs.writeFileSync(path.join(dir, '.env.example'), 'ADMIN_PHONE=\n')
        await appendDeclaredScripts(dir, ['seed'])
        return dir
    }

    const closure = (): EnvClosure => ({
        templates: ['.env.example'],
        declared: new Set(['ADMIN_PHONE']),
        reads: [],
        missing: []
    })
    const tracked = (): string[] => ['package.json', 'src/seed.ts', '.env.example']

    /** A runner that fails the bare run and passes only when the variable is set. */
    const pass = {failedToStart: false, status: 0, stdout: '', stderr: ''}
    const runner =
        (calls: Array<Record<string, string | undefined> | undefined>): CommandRunner =>
        async spec => {
            if (!spec.args.includes('seed')) return pass
            calls.push(spec.env)
            // The script's own failure mode: it dies without the variable, and
            // exits 0 once the probe supplies it.
            return spec.env?.ADMIN_PHONE !== undefined ?
                    pass
                :   {failedToStart: false, status: 1, stdout: '', stderr: 'TypeError: undefined'}
        }

    test('the probe passes with the variable supplied → demoted to UNOBSERVED', async () => {
        const calls: Array<Record<string, string | undefined> | undefined> = []
        const out = await runFinalIntegrationGate(await gapDir(), {
            timeoutMs: 20_000,
            bootGraceMs: 200,
            run: runner(calls),
            envClosure: closure,
            trackedFiles: tracked
        })
        // The real run failed and the probe passed, so the script is NOT a fault.
        expect(out.unobserved).toContain('CONFIG GAP')
        expect(out.unobserved).toContain('ADMIN_PHONE')
        expect((out.failures ?? []).join('\n')).not.toContain('bun run seed')
        // Two spawns for `seed`: the real run, then the diagnostic probe with the
        // placeholder present. The probe is a diagnostic, never an observation.
        expect(calls.filter(e => e?.ADMIN_PHONE !== undefined).length).toBe(1)
    })

    test('a script that fails WITH the variable present stays a FAIL', async () => {
        // An absent variable is not a licence to ignore an exit code the code caused.
        const alwaysFails: CommandRunner = async spec =>
            spec.args.includes('seed') ?
                {failedToStart: false, status: 1, stdout: '', stderr: 'TypeError: rows'}
            :   pass
        const out = await runFinalIntegrationGate(await gapDir(), {
            timeoutMs: 20_000,
            bootGraceMs: 200,
            run: alwaysFails,
            envClosure: closure,
            trackedFiles: tracked
        })
        expect((out.failures ?? []).join('\n')).toContain('bun run seed')
        expect(out.unobserved ?? '').not.toContain('CONFIG GAP')
    })

    test('no tracked template → the check is inert and the failure stands', async () => {
        // A project with no env template gains no excuse.
        const out = await runFinalIntegrationGate(await gapDir(), {
            timeoutMs: 20_000,
            bootGraceMs: 200,
            run: runner([]),
            envClosure: () => inertClosure(),
            trackedFiles: () => null
        })
        expect((out.failures ?? []).join('\n')).toContain('bun run seed')
        expect(out.unobserved ?? '').not.toContain('CONFIG GAP')
    })
})

// ─── The run-end gate no longer blocks the event loop ────────────────────────
//
// `CommandRunner` was `(spec) => CommandRun`, so its only implementation could be
// `spawnSync` and the whole run-end gate ran without ever yielding: repo-health
// under a 600s cap, then every lockfile/test/build/launch command under a 900s
// cap, then every ACCEPT-debt re-run under a 300s cap. No loader could paint and
// no cancel could be noticed through any of it. `repo-health-check.ts`'s own doc
// comment told gate callers to use the async runner; `final-gate.ts` was a gate
// caller using the sync one.
//
// The instrument is the one that found the defect: a 100ms interval counting its
// own executions is an honest "is the screen frozen", independent of whether
// pi-task drew anything.
describe('runFinalIntegrationGate — the event loop keeps turning', () => {
    test('timers fire while the gate runs its commands', async () => {
        const dir = makeDir({name: 'x', scripts: {lint: 'true', test: 'true', build: 'true'}})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        let ticks = 0
        const timer = setInterval(() => ticks++, 20)
        try {
            // A runner that takes real asynchronous time, the way a project's own
            // lint does. Under spawnSync this window delivered ZERO ticks.
            await runFinalIntegrationGate(dir, {
                timeoutMs: 20_000,
                bootGraceMs: 100,
                run: async () => {
                    await new Promise<void>(r => setTimeout(r, 60))
                    return {failedToStart: false, status: 0, stdout: '', stderr: ''}
                }
            })
        } finally {
            clearInterval(timer)
        }
        expect(ticks).toBeGreaterThan(2)
    })

    test('the run signal reaches the commands the gate spawns', async () => {
        const dir = makeDir({name: 'x', scripts: {lint: 'true', test: 'true'}})
        fs.writeFileSync(path.join(dir, 'bun.lock'), '{}')
        const ctrl = new AbortController()
        const seen: Array<boolean> = []
        await runFinalIntegrationGate(dir, {
            timeoutMs: 20_000,
            bootGraceMs: 100,
            signal: ctrl.signal,
            run: async spec => {
                seen.push(spec.signal === ctrl.signal)
                return {failedToStart: false, status: 0, stdout: '', stderr: ''}
            }
        })
        // Nothing could be cancelled while the runner was synchronous: the event
        // loop never got a turn in which to notice.
        expect(seen.length).toBeGreaterThan(0)
        expect(seen.every(Boolean)).toBe(true)
    })
})

/**
 * REGRESSION — the run's cancel must reach every command the gate spawns.
 *
 * `FinalGateOptions.signal` was added so a cancel can reach repo-health, the
 * lockfile/integration/launch sections and every ACCEPT-debt re-run — the whole
 * reason `CommandRunner` became async. Nothing in the suite held the gate to it,
 * and the three production call sites did not pass one at all, so the plumbing
 * was inert in the shipped path.
 */
describe('the run cancel reaches the gate children', () => {
    test('every command the gate spawns carries the caller signal', async () => {
        const dir = makeDir({
            scripts: {lint: 'exit 0', typecheck: 'exit 0', test: 'exit 0', build: 'exit 0'}
        })
        const seen: Array<{bin: string; signal: AbortSignal | undefined}> = []
        const recording: CommandRunner = spec => {
            seen.push({bin: spec.bin, signal: spec.signal})
            return Promise.resolve({failedToStart: false, status: 0, stdout: '', stderr: ''})
        }
        const ac = new AbortController()
        await runFinalIntegrationGate(dir, {run: recording, signal: ac.signal})
        // Repo-health runs first, then the discovered sections — all through the
        // same injected runner, so an unplumbed leg shows up as a missing signal.
        expect(seen.length).toBeGreaterThan(0)
        for (const s of seen) expect(s.signal).toBe(ac.signal)
    })

    test('an ALREADY-cancelled run observes nothing rather than passing', async () => {
        // A real runner under an aborted signal kills at once, which the gap ladder
        // reads as `killed`. The point is that the gate is not told the commands
        // passed: a cancel must not manufacture a green verdict.
        const dir = makeDir({scripts: {lint: 'exit 0', test: 'exit 0'}})
        const seen: Array<AbortSignal | undefined> = []
        const killed: CommandRunner = spec => {
            seen.push(spec.signal)
            return Promise.resolve({
                failedToStart: false,
                status: spec.signal?.aborted ? null : 0,
                stdout: '',
                stderr: ''
            })
        }
        const ac = new AbortController()
        ac.abort()
        await runFinalIntegrationGate(dir, {run: killed, signal: ac.signal})
        expect(seen.length).toBeGreaterThan(0)
        for (const s of seen) expect(s?.aborted).toBe(true)
    })

    test('with no signal given, nothing invents one', async () => {
        const dir = makeDir({scripts: {lint: 'exit 0', test: 'exit 0'}})
        const seen: Array<AbortSignal | undefined> = []
        const recording: CommandRunner = spec => {
            seen.push(spec.signal)
            return Promise.resolve({failedToStart: false, status: 0, stdout: '', stderr: ''})
        }
        await runFinalIntegrationGate(dir, {run: recording})
        expect(seen.length).toBeGreaterThan(0)
        for (const s of seen) expect(s).toBeUndefined()
    })
})
