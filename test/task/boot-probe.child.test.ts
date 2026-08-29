import {describe, expect, test} from 'bun:test'
import {runBootCheck, type BootChild, type BootDeps} from '../../src/task/boot-probe.js'

/**
 * The boot state machine, driven through a SCRIPTED child.
 *
 * `BootDeps` injected nine things the check LOOKS AT and not the thing it looks
 * THROUGH: `spawn` was imported directly, so every branch below needed a real
 * process on a real clock. `boot-probe.test.ts` is 52 tests / ~13.6s of real
 * `process.execPath -e` children with 300–5000ms grace windows; this file covers
 * the exit ladder, the listener rules and the orphan-port branch in milliseconds.
 *
 * The seam is `BootChild`, defined from what `runBootCheck` CALLS — the same way
 * `driveSession(cdp: CdpLike, …)` was defined from the two `Cdp` methods it uses,
 * rather than from Node's `ChildProcess`.
 */

type Handlers = {
    error?: (e: Error) => void
    exit?: (status: number | null, signal: NodeJS.Signals | null) => void
}

interface FakeChildOptions {
    pid?: number
    /** Emit on stdout before anything else. */
    stdout?: string
    stderr?: string
}

/** A child that does nothing until the test tells it to exit or fault. */
function fakeChild(o: FakeChildOptions = {}) {
    const h: Handlers = {}
    const streams: Record<'stdout' | 'stderr', Array<(c: Buffer | string) => void>> = {
        stdout: [],
        stderr: []
    }
    const killed: Array<{pid: number; signal: string}> = []
    const child: BootChild = {
        pid: o.pid ?? 4242,
        unref: () => {},
        stdout: {on: (_e, cb) => streams.stdout.push(cb)},
        stderr: {on: (_e, cb) => streams.stderr.push(cb)},
        on: ((event: string, cb: never) => {
            if (event === 'error') h.error = cb
            else h.exit = cb
        }) as BootChild['on']
    }
    // Deliver any scripted output as soon as the check has subscribed.
    queueMicrotask(() => {
        if (o.stdout) for (const cb of streams.stdout) cb(o.stdout)
        if (o.stderr) for (const cb of streams.stderr) cb(o.stderr)
    })
    /** `runBootCheck` awaits pickPort() before subscribing, so a microtask is too
     *  early — wait until the handler is actually there. */
    const when = (get: () => unknown, fire: () => void): void => {
        const tick = (): void => {
            if (get()) fire()
            else setTimeout(tick, 1)
        }
        setTimeout(tick, 1)
    }
    return {
        child,
        killed,
        exit: (status: number | null, signal: NodeJS.Signals | null = null) =>
            when(
                () => h.exit,
                () => h.exit?.(status, signal)
            ),
        fault: (e: Error) =>
            when(
                () => h.error,
                () => h.error?.(e)
            ),
        deps: (over: BootDeps = {}): BootDeps => ({
            spawnBoot: () => child,
            killGroup: (pid, signal) => killed.push({pid, signal}),
            ...over
        })
    }
}

const CMD: [string, string[]] = ['bun', ['run', 'start']]

/**
 * `runBootCheck` forces `expectServer` FALSE on win32 (there are no process
 * groups to attribute a listener to), so every served-app branch below is
 * unreachable there and degrades to the survival rule. Same convention as
 * `boot-probe.test.ts`'s `itPosix`.
 */
const IS_WINDOWS = process.platform === 'win32'
const testPosix = IS_WINDOWS ? test.skip : test

describe('the exit ladder', () => {
    test('exit 0 on a non-served project PASSes', async () => {
        const f = fakeChild()
        const p = runBootCheck('/tmp/x', CMD, 5_000, {deps: f.deps()})
        f.exit(0)
        expect(await p).toEqual({outcome: 'pass'})
    })

    test('a plain non-zero exit FAILs and quotes the output tail', async () => {
        const f = fakeChild({stderr: 'TypeError: app is not a function'})
        const p = runBootCheck('/tmp/x', CMD, 5_000, {deps: f.deps()})
        f.exit(1)
        const r = await p
        expect(r.outcome).toBe('fail')
        if (r.outcome === 'fail') {
            expect(r.detail).toContain('exited 1')
            expect(r.detail).toContain('app is not a function')
        }
    })

    test('killed-by-signal reports the signal, not an exit code', async () => {
        const f = fakeChild()
        const p = runBootCheck('/tmp/x', CMD, 5_000, {deps: f.deps()})
        f.exit(null, 'SIGSEGV')
        const r = await p
        expect(r.outcome).toBe('fail')
        if (r.outcome === 'fail') expect(r.detail).toContain('killed by SIGSEGV')
    })

    // The boot never RAN, so it is an environment gap and not an app fault.
    test('command-not-found inside the chain SKIPs', async () => {
        const f = fakeChild({stderr: 'bun: command not found: vite'})
        const p = runBootCheck('/tmp/x', CMD, 5_000, {deps: f.deps()})
        f.exit(127)
        expect((await p).outcome).toBe('skip')
    })

    test('a spawn fault SKIPs and says so', async () => {
        const f = fakeChild()
        const p = runBootCheck('/tmp/x', CMD, 5_000, {deps: f.deps()})
        f.fault(new Error('ENOENT'))
        expect(await p).toEqual({outcome: 'skip', spawnFailed: true})
    })

    // A bind collision is an environment condition, not an app defect — the gate
    // reaps its own orphan and retries rather than reporting the app "crashed".
    test('EADDRINUSE is orphan-port, with the port extracted', async () => {
        const f = fakeChild({
            stderr: 'error: Failed to start server. Is port 3000 in use?\nEADDRINUSE'
        })
        const p = runBootCheck('/tmp/x', CMD, 5_000, {deps: f.deps()})
        f.exit(1)
        const r = await p
        expect(r.outcome).toBe('orphan-port')
        if (r.outcome === 'orphan-port') expect(r.port).toBe(3000)
    })
})

describe('the served-app listener rule', () => {
    const served = (over: BootDeps = {}) => ({expectServer: true, deps: over})

    testPosix('a listener seen by pgid PASSes without waiting out the grace window', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 60_000, {
            ...served(
                f.deps({
                    enumerationCapable: () => true,
                    groupHasListener: () => true,
                    pickPort: () => Promise.resolve(41234)
                })
            )
        })
        expect(r.outcome).toBe('pass')
    })

    // mx5 run 10: a watcher (`dev` = tailwind --watch) stays alive forever without
    // ever listening, and "still alive after the grace window = PASS" blessed a
    // project that cannot serve a single request.
    testPosix('alive but never listening FAILs when enumeration works', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 20, {
            ...served(
                f.deps({
                    enumerationCapable: () => true,
                    groupHasListener: () => false,
                    httpProbe: () => false,
                    pickPort: () => Promise.resolve(41234)
                })
            )
        })
        expect(r.outcome).toBe('fail')
        if (r.outcome === 'fail') expect(r.detail).toContain('never opened a listening socket')
    })

    // An observer limitation is not an app defect (mx5 run 14).
    testPosix('alive, never listening, and BLIND passes UNOBSERVED instead', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 20, {
            ...served(
                f.deps({
                    enumerationCapable: () => false,
                    groupHasListener: () => false,
                    httpProbe: () => false,
                    pickPort: () => Promise.resolve(null)
                })
            )
        })
        expect(r.outcome).toBe('pass')
        if (r.outcome === 'pass') expect(r.renderNote).toContain('UNOBSERVED')
    })

    testPosix(
        'exit 0 without ever listening FAILs — a boot that serves nothing is not a launch',
        async () => {
            const f = fakeChild()
            const p = runBootCheck('/tmp/x', CMD, 60_000, {
                ...served(
                    f.deps({
                        enumerationCapable: () => true,
                        groupHasListener: () => false,
                        httpProbe: () => false,
                        pickPort: () => Promise.resolve(41234)
                    })
                )
            })
            f.exit(0)
            const r = await p
            expect(r.outcome).toBe('fail')
            if (r.outcome === 'fail') expect(r.detail).toContain('exited 0 without ever opening')
        }
    )

    // An HTTP answer on a number only this child was told is proof of OUR listener,
    // not of some orphan on :3000.
    testPosix('no pgid attribution falls back to the private assigned port', async () => {
        const f = fakeChild()
        const probed: number[] = []
        const r = await runBootCheck('/tmp/x', CMD, 60_000, {
            ...served(
                f.deps({
                    enumerationCapable: () => true,
                    groupHasListener: () => false,
                    pickPort: () => Promise.resolve(41234),
                    httpProbe: port => {
                        probed.push(port)
                        return true
                    }
                })
            )
        })
        expect(r.outcome).toBe('pass')
        expect(probed).toContain(41234)
    })
})

describe('the render probes', () => {
    const servedDeps = (f: ReturnType<typeof fakeChild>, over: BootDeps) =>
        f.deps({
            enumerationCapable: () => true,
            groupHasListener: () => true,
            groupListeningPort: () => 41234,
            pickPort: () => Promise.resolve(41234),
            ...over
        })

    testPosix('a failing render probe FAILs the boot, naming the port', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 60_000, {
            expectServer: true,
            deps: servedDeps(f, {
                renderProbe: () => ({outcome: 'fail', detail: 'served a blank page'})
            })
        })
        expect(r.outcome).toBe('fail')
        if (r.outcome === 'fail') expect(r.detail).toBe('listens on :41234 but served a blank page')
    })

    testPosix('a skipped render probe PASSes with an UNOBSERVED note', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 60_000, {
            expectServer: true,
            deps: servedDeps(f, {renderProbe: () => ({outcome: 'skip', note: 'no browser'})})
        })
        expect(r.outcome).toBe('pass')
        if (r.outcome === 'pass') expect(r.renderNote).toBe('render check UNOBSERVED: no browser')
    })

    // The shallow blank-page rule keeps its own verdict and is never shadowed.
    testPosix('the deep probe only runs after the shallow one PASSed', async () => {
        const f = fakeChild()
        let deepRan = false
        await runBootCheck('/tmp/x', CMD, 60_000, {
            expectServer: true,
            deps: servedDeps(f, {
                renderProbe: () => ({outcome: 'fail', detail: 'blank'}),
                deepRenderProbe: () => {
                    deepRan = true
                    return {outcome: 'pass', detail: 'signed in'}
                }
            })
        })
        expect(deepRan).toBe(false)
    })

    // THE RE-ARM. A browser session outlives the grace window by design; settling
    // there would kill the server under it and discard its verdict. Undrivable
    // before the child was a seam — it is a race between a 500ms interval, a
    // re-armed timer and an async probe.
    testPosix(
        'a deep probe in flight re-arms the grace window instead of being killed',
        async () => {
            const f = fakeChild()
            // 700ms grace: long enough for the 500ms poll to see the listener and start
            // the deep probe, short enough that the probe is still in flight when the
            // window expires.
            const r = await runBootCheck('/tmp/x', CMD, 700, {
                expectServer: true,
                deps: servedDeps(f, {
                    renderProbe: () => ({outcome: 'pass', detail: 'rendered 12 nodes'}),
                    deepRenderProbe: () =>
                        new Promise(resolve =>
                            setTimeout(
                                () => resolve({outcome: 'fail', detail: 'never signed in'}),
                                1500
                            )
                        )
                })
            })
            // The grace window expired twice over while the session ran; the deep
            // verdict still won, rather than being killed and discarded.
            expect(r.outcome).toBe('fail')
            if (r.outcome === 'fail') expect(r.detail).toBe('listens on :41234 but never signed in')
        }
    )

    // A probe that throws is a harness fault, and a harness fault may never fail
    // the gate on its own.
    testPosix('a deep probe that REJECTS degrades to a plain pass', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 60_000, {
            expectServer: true,
            deps: servedDeps(f, {
                renderProbe: () => ({outcome: 'pass', detail: 'rendered 12 nodes'}),
                deepRenderProbe: () => Promise.reject(new Error('chrome died'))
            })
        })
        expect(r).toEqual({outcome: 'pass'})
    })
})

describe('teardown', () => {
    test('a PASS still reaps the child’s process group', async () => {
        const f = fakeChild({pid: 9931})
        const r = await runBootCheck('/tmp/x', CMD, 20, {deps: f.deps()})
        expect(r.outcome).toBe('pass')
        expect(f.killed[0]).toEqual({pid: 9931, signal: 'SIGTERM'})
    })

    test('a child that already exited is not signalled', async () => {
        const f = fakeChild({pid: 9931})
        const p = runBootCheck('/tmp/x', CMD, 60_000, {deps: f.deps()})
        f.exit(0)
        await p
        expect(f.killed).toHaveLength(0)
    })
})

// The rule that makes every test above posix-only, asserted rather than assumed.
describe('the win32 degrade', () => {
    test('expectServer is forced false on win32 — there are no process groups', async () => {
        const f = fakeChild()
        const r = await runBootCheck('/tmp/x', CMD, 20, {
            expectServer: true,
            deps: f.deps({
                enumerationCapable: () => true,
                groupHasListener: () => false,
                httpProbe: () => false,
                pickPort: () => Promise.resolve(41234)
            })
        })
        if (IS_WINDOWS) {
            // Degraded to the survival rule: still alive after the window ⇒ PASS,
            // with no listener requirement to have missed.
            expect(r).toEqual({outcome: 'pass'})
        } else {
            expect(r.outcome).toBe('fail')
            if (r.outcome === 'fail') expect(r.detail).toContain('never opened a listening socket')
        }
    })
})
