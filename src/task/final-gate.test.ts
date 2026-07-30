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
    bootSkipVerdict,
    detectsServedApp,
    discoverBootCommand,
    discoverIntegrationCommands,
    discoverGateCommandLabels,
    discoverLockfileChecks,
    nonLaunchScriptReason,
    observabilityGapFailure,
    unobservedVerdict,
    parseLsofListeners,
    parseNetstatListeners,
    parseSsListeners,
    pickFreePort,
    runBootCheck,
    runFinalIntegrationGate,
    taskThatIntroduced
} from './final-gate.js'
import {readAcceptDebts, recordAcceptDebt} from './accept-debt.js'
import {appendDeclaredScripts} from './launch-contract.js'
import {appendEnvNotes} from './env-notes.js'
import {clearRunnerCache} from './runner-resolve.js'

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

    // mx5 run 13: the gate AGGREGATES — an earlier section failure no longer
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

    test('a container-orchestration script is not a launch — run 18 verbatim', async () => {
        const dev =
            'docker compose -f docker-compose.dev.yml up -d && until docker compose -f '
            + 'docker-compose.dev.yml exec -T postgres pg_isready > /dev/null 2>&1; do sleep 1; '
            + 'done && concurrently "bun run dev:css" "bun run dev:js" "bun run --watch '
            + 'src/server/index.ts"'
        expect(discoverBootCommand(makeDir({scripts: {dev}}))).toBeNull()
        // …and a REAL start script still wins, orchestration `dev` or not.
        expect(discoverBootCommand(makeDir({scripts: {start: 'bun serve.ts', dev}}))).toEqual([
            'bun',
            ['run', 'start']
        ])
    })
})

describe('nonLaunchScriptReason', () => {
    test('container orchestration at the head of the chain', () => {
        for (const body of [
            'docker compose -f docker-compose.dev.yml up -d && bun run serve.ts',
            'docker-compose up',
            'podman-compose -f x.yml up -d',
            'sudo docker compose up',
            'DEBUG=1 nerdctl compose up -d && node server.js'
        ]) {
            expect(nonLaunchScriptReason(body)).toContain('container orchestration')
        }
    })

    test('orchestration LATER in the chain does not reject — the app leads', () => {
        expect(nonLaunchScriptReason('node server.js && docker compose up')).toBeNull()
    })

    test('a compose FILENAME is not a verb', () => {
        expect(nonLaunchScriptReason('bun run --watch src/server/index.ts')).toBeNull()
        expect(nonLaunchScriptReason('node scripts/docker-compose-lint.js')).toBeNull()
    })

    test('a multiplexer of pure asset watchers can never listen', () => {
        expect(
            nonLaunchScriptReason(
                'concurrently "tailwindcss -i a.css -o b.css --watch" "tsc --watch"'
            )
        ).toContain('asset watchers')
        expect(
            nonLaunchScriptReason('run-p css js', {
                css: 'sass --watch a b',
                js: 'esbuild --watch x'
            })
        ).toContain('asset watchers')
    })

    test('a multiplexer with ONE serving child is a launch', () => {
        expect(
            nonLaunchScriptReason(
                'concurrently "tailwindcss -i a.css -o b.css --watch" "bun run --watch serve.ts"'
            )
        ).toBeNull()
        expect(
            nonLaunchScriptReason('npm-run-all -p css server', {
                css: 'tailwindcss --watch -i a -o b',
                server: 'node server.js'
            })
        ).toBeNull()
    })

    test('ordinary launch scripts are untouched', () => {
        for (const body of [
            'vite',
            'next dev',
            'node dist/index.js',
            'bun --watch src/index.ts',
            'npx nodemon -e ts --exec "npm run compile-and-run"',
            'node --enable-source-maps --env-file=secrets.env.production ./dist/src/index.js'
        ]) {
            expect(nonLaunchScriptReason(body)).toBeNull()
        }
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

    // `enumerationCapable` is pinned in these cases: the FAIL is only legitimate on a
    // box that CAN observe listeners, and leaving it to discovery would silently flip
    // these tests to the survival rule on a toolless runner (mx5 run 14's sandbox).
    const canSee = {enumerationCapable: () => true, pickPort: async () => null}

    itPosix('watcher: stays alive but never listens → FAIL naming the missing socket', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 800, {
            expectServer: true,
            deps: {...canSee, groupHasListener: () => false}
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('listening socket')
    })

    itPosix('type-only entrypoint: exits 0 without listening → FAIL', async () => {
        const r = await runBootCheck(os.tmpdir(), nodeScript('process.exit(0)'), 2000, {
            expectServer: true,
            deps: {...canSee, groupHasListener: () => false}
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('listening socket')
    })

    itPosix('a listener owned by our group appears → PASS (early, before grace)', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {...canSee, groupHasListener: () => true}
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

// mx5 run 14: the sandbox shipped no ss/netstat/lsof, so the listener requirement
// was unfalsifiable — it failed a run whose app demonstrably served, three autofix
// passes could not move it, and 13 real repairs were stranded uncommitted.
describe('runBootCheck — unobservable listener degrades, never false-FAILs (run 14)', () => {
    const alive = nodeScript('setTimeout(()=>{},600000)')
    const blind = {enumerationCapable: () => false, groupHasListener: () => false}

    itPosix('no enumeration tool + the assigned port answers → PASS on real evidence', async () => {
        const probed: number[] = []
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                ...blind,
                pickPort: async () => 45671,
                httpProbe: p => {
                    probed.push(p)
                    return true
                }
            }
        })
        expect(r.outcome).toBe('pass')
        // The PRIVATE assigned port is what makes an HTTP answer ownership evidence.
        expect(probed).toContain(45671)
        expect((r as {renderNote?: string}).renderNote).toBeUndefined()
    })

    itPosix('no enumeration tool + port never answers → survival PASS, UNOBSERVED', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 800, {
            expectServer: true,
            deps: {...blind, pickPort: async () => 45672, httpProbe: () => false}
        })
        expect(r.outcome).toBe('pass')
        const note = (r as {renderNote: string}).renderNote
        expect(note).toContain('UNOBSERVED')
        expect(note).toContain('ss/netstat/lsof')
    })

    itPosix('blindness never excuses a child that DIED — nonzero exit still FAILs', async () => {
        const r = await runBootCheck(os.tmpdir(), nodeScript('process.exit(3)'), 5000, {
            expectServer: true,
            deps: {...blind, pickPort: async () => 45673, httpProbe: () => false}
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('exited 3')
    })

    itPosix('a listener seen via the assigned port still gets the render probe', async () => {
        let url = ''
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                ...blind,
                pickPort: async () => 45674,
                httpProbe: () => true,
                renderProbe: u => {
                    url = u
                    return {outcome: 'fail', detail: 'the rendered body is EMPTY'}
                }
            }
        })
        // Same port the listener was proven on — not a guess at :3000.
        expect(url).toBe('http://127.0.0.1:45674/')
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('EMPTY')
    })

    itPosix('the boot child is told the reserved port via PORT', async () => {
        const r = await runBootCheck(
            os.tmpdir(),
            nodeScript('console.log("PORT="+process.env.PORT);setTimeout(()=>{},600000)'),
            800,
            {
                expectServer: true,
                deps: {...blind, pickPort: async () => 45675, httpProbe: () => false}
            }
        )
        expect(r.outcome).toBe('pass')
    })
})

describe('listener enumeration parsers (run 14)', () => {
    test('ss rows yield pid + port', () => {
        const out = 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("bun",pid=1234,fd=20))'
        expect(parseSsListeners(out)).toEqual([{pid: 1234, port: 3000}])
    })

    // The tool the run-14 sandbox actually had.
    test('netstat -tlnp rows yield pid + port, skipping unattributed rows', () => {
        const out = [
            'Active Internet connections (only servers)',
            'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
            'tcp        0      0 0.0.0.0:3000            0.0.0.0:*               LISTEN      1234/bun',
            'tcp6       0      0 :::5432                 :::*                    LISTEN      -',
            'tcp6       0      0 :::8080                 :::*                    LISTEN      77/node'
        ].join('\n')
        expect(parseNetstatListeners(out)).toEqual([
            {pid: 1234, port: 3000},
            {pid: 77, port: 8080}
        ])
    })

    test('lsof rows yield pid + port', () => {
        const out = [
            'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
            'bun      1234 root   20u  IPv4  12345      0t0  TCP 127.0.0.1:3000 (LISTEN)'
        ].join('\n')
        expect(parseLsofListeners(out)).toEqual([{pid: 1234, port: 3000}])
    })

    test('pickFreePort reserves a port nothing is bound to', async () => {
        const p = await pickFreePort()
        expect(typeof p).toBe('number')
        expect(p as number).toBeGreaterThan(1024)
    })
})

// mx5 runs 8/11: a served listener is not enough — the page must RENDER. The
// render probe is injected here so the flow is deterministic without a browser.
describe('runBootCheck — render check on the served page (runs 8/11)', () => {
    const alive = nodeScript('setTimeout(()=>{},600000)')

    itPosix(
        'a served page that renders blank → FAIL naming the port and the blank body',
        async () => {
            const r = await runBootCheck(os.tmpdir(), alive, 5000, {
                expectServer: true,
                deps: {
                    groupHasListener: () => true,
                    groupListeningPort: () => 3000,
                    renderProbe: url => {
                        expect(url).toBe('http://127.0.0.1:3000/')
                        return {
                            outcome: 'fail',
                            detail: 'the rendered body is EMPTY after client JS executed'
                        }
                    }
                }
            })
            expect(r.outcome).toBe('fail')
            expect((r as {detail: string}).detail).toContain(':3000')
            expect((r as {detail: string}).detail).toContain('EMPTY')
        }
    )

    itPosix('a served page that renders content → PASS, no warning', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({outcome: 'pass', detail: 'rendered visible text'})
            }
        })
        expect(r.outcome).toBe('pass')
        expect((r as {renderNote?: string}).renderNote).toBeUndefined()
    })

    itPosix('no browser (render SKIP) → PASS but UNOBSERVED renderNote', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({outcome: 'skip', note: 'no headless browser found'})
            }
        })
        expect(r.outcome).toBe('pass')
        expect((r as {renderNote: string}).renderNote).toContain('UNOBSERVED')
    })

    itPosix('a listener whose port is undeterminable → PASS but UNOBSERVED', async () => {
        let probed = false
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                groupHasListener: () => true,
                groupListeningPort: () => null,
                renderProbe: () => {
                    probed = true
                    return {outcome: 'pass', detail: 'x'}
                }
            }
        })
        expect(r.outcome).toBe('pass')
        expect(probed).toBe(false) // no port ⇒ the probe is never called
        expect((r as {renderNote: string}).renderNote).toContain('port could not be determined')
    })
})

// mx5 run 17: the page above renders and the app is still unusable — the server
// authenticates the login and the client never uses the session. The deep probe is
// injected here so the flow is deterministic without a browser or an app.
describe('runBootCheck — authenticated deep-render check (run 17)', () => {
    const alive = nodeScript('setTimeout(()=>{},600000)')
    const served = {groupHasListener: () => true, groupListeningPort: () => 3000}
    const rendered = () => ({outcome: 'pass', detail: 'rendered visible text'}) as const

    itPosix('a session the server authenticated but the client cannot use → FAIL', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                ...served,
                renderProbe: rendered,
                deepRenderProbe: url => {
                    expect(url).toBe('http://127.0.0.1:3000/')
                    return Promise.resolve({
                        outcome: 'fail',
                        detail: 'signed in (`POST /api/auth/login` → 200) but the client NEVER LEFT THE SIGN-IN WALL'
                    })
                }
            }
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('NEVER LEFT THE SIGN-IN WALL')
        expect((r as {detail: string}).detail).toContain(':3000')
    })

    itPosix('a working authenticated session → PASS with no warning', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                ...served,
                renderProbe: rendered,
                deepRenderProbe: () =>
                    Promise.resolve({outcome: 'pass', detail: 'signed in, 6/6 data requests 2xx'})
            }
        })
        expect(r.outcome).toBe('pass')
        expect((r as {renderNote?: string}).renderNote).toBeUndefined()
    })

    itPosix('no credentials / no browser (deep SKIP) → PASS but UNOBSERVED', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                ...served,
                renderProbe: rendered,
                deepRenderProbe: () =>
                    Promise.resolve({
                        outcome: 'skip',
                        note: 'the project declares no account credentials'
                    })
            }
        })
        expect(r.outcome).toBe('pass')
        expect((r as {renderNote: string}).renderNote).toContain('UNOBSERVED')
        expect((r as {renderNote: string}).renderNote).toContain('no account credentials')
    })

    itPosix(
        'the shallow render FAILs → the deep probe never runs (its verdict leads)',
        async () => {
            let deepRan = false
            const r = await runBootCheck(os.tmpdir(), alive, 5000, {
                expectServer: true,
                deps: {
                    ...served,
                    renderProbe: () => ({outcome: 'fail', detail: 'the rendered body is EMPTY'}),
                    deepRenderProbe: () => {
                        deepRan = true
                        return Promise.resolve({outcome: 'pass', detail: 'x'})
                    }
                }
            })
            expect(r.outcome).toBe('fail')
            expect(deepRan).toBe(false)
        }
    )

    itPosix('a NON-served project never reaches the deep probe (I1)', async () => {
        let deepRan = false
        const r = await runBootCheck(os.tmpdir(), nodeScript('process.exit(0)'), 3000, {
            expectServer: false,
            deps: {
                ...served,
                renderProbe: rendered,
                deepRenderProbe: () => {
                    deepRan = true
                    return Promise.resolve({outcome: 'fail', detail: 'must never be reached'})
                }
            }
        })
        expect(r.outcome).toBe('pass')
        expect(deepRan).toBe(false)
    })

    // The browser session signs in and waits for the app's data calls, so it routinely
    // outlives the boot grace window. Settling on the timer would kill the server under
    // it and silently discard the verdict.
    itPosix(
        'a deep session slower than the grace window still decides the boot',
        async () => {
            const r = await runBootCheck(os.tmpdir(), alive, 1200, {
                expectServer: true,
                deps: {
                    ...served,
                    renderProbe: rendered,
                    deepRenderProbe: () =>
                        new Promise(resolve =>
                            setTimeout(
                                () =>
                                    resolve({
                                        outcome: 'fail',
                                        detail: 'never left the sign-in wall'
                                    }),
                                2500
                            )
                        )
                }
            })
            expect(r.outcome).toBe('fail')
            expect((r as {detail: string}).detail).toContain('never left the sign-in wall')
        },
        20_000
    )

    // The port the app is served on decides whether the authenticated half is
    // observable at all: a client with its base URL baked in at build time calls
    // that origin and no other.
    itPosix('a declared local port is served instead of a reserved one', async () => {
        let reservedUsed = false
        // The child dies unless it was handed the declared port, so a PASS is proof
        // the boot really served on 4321 and not on the reserved number.
        const wantsPort = nodeScript(
            "if(process.env.PORT!=='4321')process.exit(3); setTimeout(()=>{},600000)"
        )
        const r = await runBootCheck(os.tmpdir(), wantsPort, 3000, {
            expectServer: true,
            deps: {
                preferredPort: () => Promise.resolve(4321),
                pickPort: () => {
                    reservedUsed = true
                    return Promise.resolve(59999)
                },
                groupHasListener: () => true,
                groupListeningPort: () => 4321,
                renderProbe: url => {
                    expect(url).toBe('http://127.0.0.1:4321/')
                    return {outcome: 'pass', detail: 'rendered'}
                }
            }
        })
        expect(r.outcome).toBe('pass')
        expect(reservedUsed).toBe(false)
    })

    itPosix('no declared port (or one already held) → the reserved port, unchanged', async () => {
        let reservedUsed = false
        const r = await runBootCheck(os.tmpdir(), alive, 3000, {
            expectServer: true,
            deps: {
                preferredPort: () => Promise.resolve(null),
                pickPort: () => {
                    reservedUsed = true
                    return Promise.resolve(59999)
                },
                groupHasListener: () => true,
                groupListeningPort: () => 59999,
                renderProbe: () => ({outcome: 'pass', detail: 'rendered'}),
                deepRenderProbe: () => Promise.resolve({outcome: 'pass', detail: 'no wall'})
            }
        })
        expect(r.outcome).toBe('pass')
        expect(reservedUsed).toBe(true)
    })

    itPosix('a deep probe that THROWS can never fail the gate on its own fault', async () => {
        const r = await runBootCheck(os.tmpdir(), alive, 5000, {
            expectServer: true,
            deps: {
                ...served,
                renderProbe: rendered,
                deepRenderProbe: () => Promise.reject(new Error('protocol error'))
            }
        })
        expect(r.outcome).toBe('pass')
    })
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

// mx5 runs 8/11: the whole gate must FAIL when the served app renders blank, and
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
        const out = await runFinalIntegrationGate(dir, 900_000, 5000, {
            groupHasListener: () => true,
            groupListeningPort: () => 3000,
            renderProbe: () => ({
                outcome: 'fail',
                detail: 'the rendered body is EMPTY after client JS executed'
            })
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('boot check')
        expect(out.reason).toContain('EMPTY')
    })

    itPosix(
        'a served app whose page cannot be observed → PASS with an UNOBSERVED warning',
        async () => {
            const dir = servedApp()
            const out = await runFinalIntegrationGate(dir, 900_000, 5000, {
                groupHasListener: () => true,
                groupListeningPort: () => 3000,
                renderProbe: () => ({outcome: 'skip', note: 'no headless browser found'})
            })
            expect(out.ok).toBe(true)
            expect(out.reason).toContain('WARNING')
            expect(out.reason).toContain('UNOBSERVED')
        }
    )

    itPosix('a served app that renders content → clean PASS, no warning', async () => {
        const dir = servedApp()
        const out = await runFinalIntegrationGate(dir, 900_000, 5000, {
            groupHasListener: () => true,
            groupListeningPort: () => 3000,
            renderProbe: () => ({outcome: 'pass', detail: 'rendered visible text'}),
            // The listener here is FAKED, so the real deep probe would drive a browser
            // against whatever happens to answer on :3000 on the test box. Injected to
            // keep this hermetic; the deep probe's own behaviour is covered above.
            deepRenderProbe: () => Promise.resolve({outcome: 'pass', detail: 'no sign-in wall'})
        })
        expect(out.ok).toBe(true)
        expect(out.reason).not.toContain('WARNING')
    })
})

// mx5 run 13: runFinalIntegrationGate early-returned on the FIRST failing section,
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

    // The run-13 replay (nexttask PROMPT 1 item 5): a failing bun-test glob (the
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
        const out = await runFinalIntegrationGate(dir, 900_000, 5000, {
            groupHasListener: () => true,
            groupListeningPort: () => 3000,
            renderProbe: () => ({
                outcome: 'fail',
                detail: 'GET / responded 404 — the rendered document is the not-found page'
            })
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
        // The run-13 shape: server reads dist/index.html; the build enumerable
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

describe('runFinalIntegrationGate — serve-entry closure (run 18, nexttask 2B)', () => {
    /** The run-18 shape in miniature: a Hono app with an SPA fallback and no bind. */
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

describe('runFinalIntegrationGate — ACCEPT-debt re-check (run 4 B3 / run 8 TASK_0012)', () => {
    test('a non-static (frozen-path) debt is SURFACED on a PASS and kept in the ledger', async () => {
        const dir = makeDir() // no manifest → statics + integration trivially pass
        await recordAcceptDebt(dir, 'TASK_0012', 'modified frozen path src/main.tsx')
        const out = await runFinalIntegrationGate(dir)
        expect(out.ok).toBe(true)
        expect(out.openDebts).toEqual([
            {taskId: 'TASK_0012', reason: 'modified frozen path src/main.tsx'}
        ])
        // The note rides in its own field: `reason` stays mechanical because it
        // seeds the autofix child (mx5 run 11 — a debt in the seed became an `rm`).
        expect(out.debtNote).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (1)')
        expect(out.debtNote).toContain('TASK_0012')
        expect(out.reason).not.toContain('UNRESOLVED VERIFY-FAIL DEBT')
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
        expect(out.debtNote).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (1)')
        expect(out.reason).not.toContain('UNRESOLVED VERIFY-FAIL DEBT')
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
        expect(out.debtNote).toBeUndefined()
        expect(out.reason).not.toContain('ACCEPTED VERIFY-FAIL DEBT')
    })
})

describe('taskThatIntroduced + end-to-end conflict annotation (mx5 run 11)', () => {
    const git = (dir: string, ...args: string[]): void => {
        const r = Bun.spawnSync(['git', ...args], {cwd: dir})
        if (r.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString()}`)
    }

    /** A throwaway repo where TASK_0008's commit introduces the admin page. */
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

    test('resolves the ORIGINAL introducing task commit, even after deletion', () => {
        const dir = makeRepoWithTaskCommits()
        expect(taskThatIntroduced(dir, 'src/client/pages/admin.tsx')).toBe('TASK_0008')
        // The run-11 shape: the file was rm'd from the worktree — attribution holds.
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
        await recordAcceptDebt(
            dir,
            'TASK_0009',
            'Verification check #7 fails: src/client/pages/admin.tsx exists (introduced by '
                + 'prior TASK_0008, not this task).'
        )
        const out = await runFinalIntegrationGate(dir)
        expect(out.openDebts).toHaveLength(1)
        expect(out.openDebts![0].conflict).toContain("TASK_0008's committed deliverable")
        expect(out.debtNote).toContain('⚠ CONFLICTING CLAIM')
        // The autofix seed (reason) must not carry the claim (run 11: it became `rm`).
        expect(out.reason).not.toContain('admin.tsx')
    })
})

// mx5 run 11: existence is not launchability — declared launch scripts must RUN.
describe('runFinalIntegrationGate — launch-contract scripts EXECUTE (run 11)', () => {
    test('a declared script that dies on first call FAILs the gate with its output', async () => {
        // The run-11 shape: migrate/seed shipped with a first-call TypeError
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
        // The verbatim run-11 excuse-note class: the note excused the exact
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
 * The THIRD verdict (IAR1, validated 2026-07-27): zero discovery used to return
 * `PASS — no integration command found (statics passed)`, so "we never checked" read
 * exactly like "we checked and it was fine" — the same blindness class as run 16,
 * entering through the door observabilityGapFailure deliberately leaves open
 * (attempted === 0 → null). The two guards are complementary and BOTH are asserted
 * here on the same inputs, because the run-16 guard must not be softened to make room
 * for this one.
 */
describe('unobservedVerdict — zero observation is UNOBSERVED, never a PASS (IAR1)', () => {
    const resolvable = () => true

    test('truth table: attempted=0/observed=0 → gap guard silent, UNOBSERVED note raised', () => {
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
 * A SKIPPED boot check is a verdict, not a silence (mx5 run 18, validated).
 *
 * The run-18 shape reproduced exactly: a served app whose boot command was
 * discovered and env-gap-skipped, while every other dynamic command ran and
 * passed — so dynObserved > 0, observabilityGapFailure stayed correctly quiet, and
 * "the app was never observed to boot" produced byte-identical output to "the app
 * booted fine". Harnesses: scripts/boot-skip-baserate.ts (base rate),
 * scripts/boot-skip-verdict-ab.ts (A/B), scripts/boot-skip-fp-suite.ts (zero-FP).
 */
describe('bootSkipVerdict — a discovered boot that never ran is UNOBSERVED (mx5 run 18)', () => {
    /** A served app (hono in deps is what detectsServedApp reads) whose `dev`
     *  script exits 127 inside the chain — run 18's docker-less skip, in miniature. */
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
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
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
        // Run 18 had 51 green Playwright CT tests and no server: CT mounts components,
        // it never assembles or starts one. Six observed commands here, boot still
        // unobserved, and the zero-observation note must NOT fire (things did run).
        const dir = makeDir(
            servedSkipPkg({'test:ct': 'exit 0', 'test:e2e': 'exit 0', lint: 'exit 0'})
        )
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
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
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
        expect(out.unobserved).toBeUndefined()
        expect(out.reason).toBe('statics + `bun run test`, `bun run build` passed')
    })

    test('inv-cli-unaffected: no server dependency ⇒ byte-identical to having no boot at all', async () => {
        const cli = makeDir({
            scripts: {test: 'exit 0', build: 'exit 0', dev: 'pi-task-no-such-bin'}
        })
        const none = makeDir({scripts: {test: 'exit 0', build: 'exit 0'}})
        const a = await runFinalIntegrationGate(cli, 900_000, 400)
        const b = await runFinalIntegrationGate(none, 900_000, 400)
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
        const out = await runFinalIntegrationGate(dir, 900_000, 5_000, {
            groupHasListener: () => true,
            groupListeningPort: () => 3000,
            renderProbe: () => ({outcome: 'pass', detail: 'rendered'}),
            deepRenderProbe: () => ({outcome: 'pass', detail: 'authenticated'})
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
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
        expect(out.ok).toBe(true)
        expect(out.failures ?? []).toEqual([])
        expect(out.unobserved).toContain('NEVER RAN')
        expect(out.unobserved).toContain('`bun run dev`')
    })

    test('a boot skip does NOT turn a FAILing gate into a different failure', async () => {
        const dir = makeDir(servedSkipPkg({test: 'echo boom && exit 1'}))
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
        expect(out.ok).toBe(false)
        expect(out.unobserved).toBeUndefined()
        expect(out.failures?.some(f => f.includes('NEVER RAN'))).toBeFalsy()
    })

    test('both notes stack when NOTHING ran either — boot named first', async () => {
        const dir = makeDir({
            dependencies: {hono: '4.12.27'},
            scripts: {test: "node -e 'process.exit(127)'", dev: 'pi-task-no-such-binary-9f3c'}
        })
        const out = await runFinalIntegrationGate(dir, 900_000, 400)
        expect(out.ok).toBe(true)
        expect(out.unobserved).toContain('NEVER RAN')
        expect(out.unobserved).toContain('skipped as environment gaps')
        expect(out.unobserved!.indexOf('NEVER RAN')).toBeLessThan(
            out.unobserved!.indexOf('skipped as environment gaps')
        )
    })
})
