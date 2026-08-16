/**
 * boot-probe tests — the probe's own suite, moved wholesale out of
 * final-gate.test.ts along with the module.
 *
 * Every case here is PURE: it drives `runBootCheck` with injected `BootDeps` or
 * feeds a parser a captured `ss`/`netstat`/`lsof` line. None of it needs the gate,
 * a declared launch contract, or a git tree — which is exactly why it separates
 * cleanly. The gate-level cases that happen to exercise boot (orphan-port recovery,
 * the served-page render check, the boot-skip UNOBSERVED verdict) stay with the
 * gate, because they run `runFinalIntegrationGate` end to end.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    discoverBootCommand,
    nonLaunchScriptReason,
    runBootCheck,
    detectsServedApp,
    parseSsListeners,
    parseNetstatListeners,
    parseLsofListeners,
    pickFreePort
} from './boot-probe.js'

// Some cases exercise irreducibly-POSIX process mechanics — death by a Unix signal
// has no Windows equivalent. Skip those rather than pretend.
const IS_WINDOWS = process.platform === 'win32'
const itPosix = IS_WINDOWS ? test.skip : test

/** A cross-platform child fixture: `node -e <script>` behaves identically on every
 *  OS, unlike `sh -c` (no POSIX-shell semantics on Windows). */
const nodeScript = (script: string): [string, string[]] => [process.execPath, ['-e', script]]

function makeDir(pkg?: object): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-boot-probe-'))
    if (pkg) fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    return dir
}

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
