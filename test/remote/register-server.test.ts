/**
 * registerRemote's SERVER side — the lifecycle wiring the /remote command tests
 * next door never reach: starting the http server lazily, degrading when the
 * bind or the Tailscale handshake fails, tearing it down on quit, and rendering
 * the QR overlay.
 *
 * The network is faked at the module boundary (server / tailscale / qr) because
 * the thing under test is the WIRING — which callback goes where, what is
 * cached on globalThis, what the user is told when a step fails.
 */

import {afterEach, beforeEach, expect, mock, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import * as realServer from '../../src/remote/server.js'
import * as realTailscale from '../../src/remote/tailscale.js'
import type {ServerHandle} from '../../src/remote/server.js'
import type {ServeResult} from '../../src/remote/tailscale.js'
import {getBridge} from '../../src/remote/bridge.js'
import {getConfig} from '../../src/config/config.js'

interface StartArgs {
    onMessage: (text: string) => void
    getHtml: (wsUrl: string) => string
    onInterrupt?: () => void
    onClearHeld?: () => void
}

const started: StartArgs[] = []
const teardowns: number[] = []
let stopCount = 0
let startFails: Error | null = null
let serveResult: ServeResult | Promise<never> = {state: 'unavailable'}

function makeHandle(): ServerHandle {
    return {
        port: 41234,
        ip: '10.0.0.5',
        ips: {primary: '10.0.0.5', all: ['10.0.0.5']} as never,
        stop: () => {
            stopCount++
        },
        onFirstConnect: null
    }
}
let handle = makeHandle()

void mock.module('../../src/remote/server.js', () => ({
    ...realServer,
    startServer: async (
        onMessage: StartArgs['onMessage'],
        getHtml: StartArgs['getHtml'],
        onInterrupt?: () => void,
        onClearHeld?: () => void
    ) => {
        started.push({onMessage, getHtml, onInterrupt, onClearHeld})
        if (startFails) throw startFails
        return handle
    }
}))

void mock.module('../../src/remote/tailscale.js', () => ({
    ...realTailscale,
    ensureTailscaleServe: async () => serveResult,
    teardownTailscaleServe: async (port: number) => {
        teardowns.push(port)
    }
}))

void mock.module('../../src/remote/qr.js', () => ({
    qrLines: async () => ['██ QR ██', '██ QR ██']
}))

const {registerRemote} =
    (await import('../../src/remote/register.js')) as typeof import('../../src/remote/register.js')

type Handlers = Map<string, (event: never, ctx: never) => unknown>

function fakePi(): {pi: ExtensionAPI; on: Handlers} {
    const on: Handlers = new Map()
    const pi = {
        on: (name: string, handler: (event: never, ctx: never) => unknown) => {
            // setupEvents re-registers many events; the LAST registration for a
            // name is registerRemote's own only for the two it owns, so keep the
            // first — registerRemote runs before setupEvents.
            if (!on.has(name)) on.set(name, handler)
        },
        registerCommand: () => {},
        sendUserMessage: () => {}
    } as unknown as ExtensionAPI
    return {pi, on}
}

function eventCtx(): {ctx: unknown; notifies: Array<{msg: string; level: string}>} {
    const notifies: Array<{msg: string; level: string}> = []
    return {
        ctx: {
            isIdle: () => true,
            ui: {
                notify: (msg: string, level: string) => notifies.push({msg, level})
            }
        },
        notifies
    }
}

interface CustomCall {
    factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => never
    opts: {overlay?: boolean; overlayOptions?: {width: number}; onHandle?: (h: never) => void}
}

function commandCtx(mode: string): {
    ctx: unknown
    notifies: Array<{msg: string; level: string}>
    customs: CustomCall[]
} {
    const notifies: Array<{msg: string; level: string}> = []
    const customs: CustomCall[] = []
    return {
        ctx: {
            mode,
            isIdle: () => true,
            ui: {
                notify: (msg: string, level: string) => notifies.push({msg, level}),
                custom: async (factory: CustomCall['factory'], opts: CustomCall['opts']) => {
                    customs.push({factory, opts})
                }
            }
        },
        notifies,
        customs
    }
}

const remoteGlobal = (): {server: ServerHandle | null; serveResult: ServeResult | null} =>
    (
        globalThis as unknown as Record<
            string,
            {server: ServerHandle | null; serveResult: ServeResult | null}
        >
    ).__piRemote!

let savedRemoteFlag: boolean

beforeEach(() => {
    started.length = 0
    teardowns.length = 0
    stopCount = 0
    startFails = null
    serveResult = {state: 'unavailable'}
    handle = makeHandle()
    remoteGlobal().server = null
    remoteGlobal().serveResult = null
    const b = getBridge()
    b.sent.length = 0
    b.commands.clear()
    b.currentCtx = null
    savedRemoteFlag = getConfig().remote
})
afterEach(() => {
    getConfig().remote = savedRemoteFlag
    remoteGlobal().server = null
    remoteGlobal().serveResult = null
    getBridge().currentCtx = null
})

const runRemote = async (args: string, ctx: unknown): Promise<void> => {
    await getBridge().commands.get('remote')!(args, ctx as never)
}

test('session_start starts the server when remote is enabled', async () => {
    getConfig().remote = true
    const {pi, on} = fakePi()
    registerRemote(pi)
    const {ctx} = eventCtx()

    on.get('session_start')!({} as never, ctx as never)
    await Bun.sleep(0)

    expect(started).toHaveLength(1)
    expect(remoteGlobal().server).toBe(handle)
})

test('session_start leaves the server alone when remote is disabled', async () => {
    getConfig().remote = false
    const {pi, on} = fakePi()
    registerRemote(pi)
    const {ctx} = eventCtx()

    on.get('session_start')!({} as never, ctx as never)
    await Bun.sleep(0)

    expect(started).toEqual([])
    expect(remoteGlobal().server).toBeNull()
})

test('a bind failure warns and leaves pi running — remote is optional', async () => {
    getConfig().remote = true
    startFails = new Error('EADDRINUSE')
    const {pi, on} = fakePi()
    registerRemote(pi)
    const {ctx, notifies} = eventCtx()

    on.get('session_start')!({} as never, ctx as never)
    await Bun.sleep(0)

    expect(notifies).toEqual([{msg: 'Remote UI unavailable: EADDRINUSE', level: 'warning'}])
    expect(remoteGlobal().server).toBeNull()
})

test('a Tailscale failure degrades to unavailable rather than killing the server', async () => {
    getConfig().remote = true
    serveResult = Promise.reject(new Error('no tailscaled'))
    const {pi, on} = fakePi()
    registerRemote(pi)
    const {ctx, notifies} = eventCtx()

    on.get('session_start')!({} as never, ctx as never)
    await Bun.sleep(0)

    expect(remoteGlobal().server).toBe(handle)
    expect(remoteGlobal().serveResult).toEqual({state: 'unavailable'})
    expect(notifies).toEqual([])
})

test('session_start seeds a shimmed ctx, and never clobbers a real command ctx', () => {
    getConfig().remote = false
    const {pi, on} = fakePi()
    registerRemote(pi)
    const {ctx} = eventCtx()

    on.get('session_start')!({} as never, ctx as never)
    const shimmed = getBridge().currentCtx
    expect(shimmed).not.toBeNull()

    // A second session_start replaces one shim with another…
    on.get('session_start')!({} as never, ctx as never)
    expect(getBridge().currentCtx).not.toBe(shimmed)

    // …but a real command ctx captured from the terminal survives.
    const real = {mode: 'tui'} as never
    getBridge().currentCtx = real
    on.get('session_start')!({} as never, ctx as never)
    expect(getBridge().currentCtx).toBe(real)
})

test('quitting stops the server and tears down the Tailscale serve', async () => {
    getConfig().remote = true
    const {pi, on} = fakePi()
    registerRemote(pi)
    on.get('session_start')!({} as never, eventCtx().ctx as never)
    await Bun.sleep(0)

    on.get('session_shutdown')!({reason: 'quit'} as never, {} as never)

    expect(stopCount).toBe(1)
    expect(teardowns).toEqual([41234])
    expect(remoteGlobal().server).toBeNull()
    expect(remoteGlobal().serveResult).toBeNull()
})

test('a non-quit shutdown keeps the server up — it outlives one session', async () => {
    getConfig().remote = true
    const {pi, on} = fakePi()
    registerRemote(pi)
    on.get('session_start')!({} as never, eventCtx().ctx as never)
    await Bun.sleep(0)

    on.get('session_shutdown')!({reason: 'switch'} as never, {} as never)

    expect(stopCount).toBe(0)
    expect(remoteGlobal().server).toBe(handle)
})

test('/remote refuses when remote is disabled in config', async () => {
    getConfig().remote = false
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx, notifies} = commandCtx('print')

    await runRemote('', ctx)

    expect(started).toEqual([])
    expect(notifies).toEqual([
        {msg: 'Remote is disabled — enable it in /task-config.', level: 'info'}
    ])
})

test('/remote starts the server once and announces the URL', async () => {
    getConfig().remote = true
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx, notifies, customs} = commandCtx('print')

    await runRemote('', ctx)
    await runRemote('', ctx)

    expect(started).toHaveLength(1) // cached on globalThis
    expect(customs).toEqual([]) // no overlay outside the TUI
    expect(notifies).toEqual([
        {msg: 'Remote running at http://10.0.0.5:41234', level: 'info'},
        {msg: 'Remote running at http://10.0.0.5:41234', level: 'info'}
    ])
})

test('/remote upgrades the bridge to the real command ctx', async () => {
    getConfig().remote = true
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx} = commandCtx('print')

    await runRemote('', ctx)

    expect(getBridge().currentCtx).toBe(ctx as never)
})

test('/remote announces the https URL when Tailscale serve is live', async () => {
    getConfig().remote = true
    serveResult = {state: 'served', url: 'https://box.ts.net', host: 'box.ts.net'}
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx, notifies} = commandCtx('print')

    await runRemote('', ctx)

    expect(notifies).toEqual([{msg: 'Remote running at https://box.ts.net', level: 'info'}])
})

test('/remote in the TUI draws a centred QR overlay that any key dismisses', async () => {
    getConfig().remote = true
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx, customs} = commandCtx('tui')

    await runRemote('', ctx)

    expect(customs).toHaveLength(1)
    const {factory, opts} = customs[0]
    expect(opts.overlay).toBe(true)
    expect(opts.overlayOptions!.width).toBeGreaterThanOrEqual(36)

    let done = 0
    const comp = factory({}, {}, {}, () => {
        done++
    }) as unknown as {
        render: (w: number) => string[]
        handleInput: () => void
        dispose: () => void
        invalidate: () => void
    }
    const lines = comp.render(60)
    expect(lines.some(l => l.includes('██ QR ██'))).toBe(true)
    expect(lines.some(l => l.includes('10.0.0.5:41234'))).toBe(true)
    expect(lines.some(l => l.includes('Waiting for connection…'))).toBe(true)

    comp.handleInput()
    comp.dispose()
    comp.invalidate()
    expect(done).toBe(2)

    // The overlay hides itself the moment a phone actually connects.
    let hidden = 0
    opts.onHandle!({hide: () => hidden++} as never)
    handle.onFirstConnect!()
    expect(hidden).toBe(1)
})

test('/remote reports the failure instead of throwing at the user', async () => {
    getConfig().remote = true
    startFails = new Error('EADDRINUSE')
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx, notifies} = commandCtx('print')

    await runRemote('', ctx)

    expect(notifies).toEqual([{msg: 'Remote UI unavailable: EADDRINUSE', level: 'error'}])
})

test('a browser /new goes through the new-session dispatcher, not the agent', async () => {
    getConfig().remote = true
    const {pi} = fakePi()
    registerRemote(pi)
    const {ctx} = commandCtx('print')
    await runRemote('', ctx)

    const sends: string[] = []
    getBridge().currentCtx = {
        newSession: async ({withSession}: {withSession: (c: unknown) => Promise<unknown>}) => {
            await withSession({sendUserMessage: (m: string) => sends.push(m)})
            return {cancelled: false}
        },
        ui: {notify: () => {}}
    } as never

    started[0].onMessage('/new')
    await Bun.sleep(0)

    // The replacement session's sender is now the one plain lines use.
    started[0].onMessage('hello from the phone')
    await Bun.sleep(0)
    expect(sends).toEqual(['hello from the phone'])
})
