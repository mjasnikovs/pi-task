import {afterEach, expect, test} from 'bun:test'
import {registerRemote} from './register.js'
import {getBridge, dispatchRemoteLine, makeShimmedCtx} from './bridge.js'
import {broadcast as wsBroadcast} from './broadcast.js'

afterEach(() => {
    const b = getBridge()
    b.sent.length = 0
    b.broadcast = msg => wsBroadcast(msg)
    b.commands.clear()
    b.currentCtx = null
    const g = globalThis as unknown as Record<string, {server: unknown} | undefined>
    if (g.__piRemote) g.__piRemote.server = null
})

/** Minimal ExtensionAPI stand-in: registerRemote only needs `on` + `registerCommand`. */
function fakePi() {
    const commands = new Map<string, {handler: (args: string, ctx: unknown) => unknown}>()
    const pi = {
        on: () => {},
        registerCommand: (name: string, def: {handler: (args: string, ctx: unknown) => unknown}) =>
            commands.set(name, def)
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionAPI
    return {pi, commands}
}

function notifications(): string[] {
    return getBridge()
        .sent.filter(m => (m as {type: string}).type === 'notify')
        .map(m => (m as {message?: string}).message ?? '')
}

test('registerRemote exposes /remote to the remote bridge', () => {
    const {pi} = fakePi()
    registerRemote(pi)
    expect(getBridge().commands.has('remote')).toBe(true)
})

test('/remote stop from the browser stops a running server', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const {pi} = fakePi()
    registerRemote(pi)

    let stopped = false
    const g = globalThis as unknown as Record<string, {server: unknown} | undefined>
    g.__piRemote!.server = {port: 41234, stop: () => (stopped = true)}

    const notified: string[] = []
    b.currentCtx = makeShimmedCtx({
        isIdle: () => true,
        ui: {notify: (msg: string) => notified.push(msg)}
    } as never)

    const handled = dispatchRemoteLine('/remote stop', {onPlain: () => {}})

    expect(handled).toBe(true)
    expect(notifications().some(m => m.includes('Unknown command'))).toBe(false)
    expect(stopped).toBe(true)
    expect(g.__piRemote!.server).toBeNull()
    expect(notified).toEqual(['Remote server stopped'])
})

test('/remote stop reports when no server is running', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const {pi} = fakePi()
    registerRemote(pi)

    const notified: string[] = []
    b.currentCtx = makeShimmedCtx({
        isIdle: () => true,
        ui: {notify: (msg: string) => notified.push(msg)}
    } as never)

    expect(dispatchRemoteLine('/remote stop', {onPlain: () => {}})).toBe(true)
    expect(notified).toEqual(['Remote server is not running'])
})
