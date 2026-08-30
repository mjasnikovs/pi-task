import {afterEach, expect, test} from 'bun:test'
import {registerRemote} from '../../src/remote/register.js'
import {registerConfig} from '../../src/config/register.js'
import {registerTask} from '../../src/task/orchestrator.js'
import {registerTaskAuto} from '../../src/task/auto-orchestrator.js'
import {registerTaskPlan} from '../../src/task/plan-orchestrator.js'
import {getBridge, dispatchRemoteLine, makeShimmedCtx} from '../../src/remote/bridge.js'
import {broadcast as wsBroadcast} from '../../src/remote/broadcast.js'
import {clientScript} from '../../src/remote/ui-script.js'

afterEach(() => {
    const b = getBridge()
    b.sent.length = 0
    b.broadcast = msg => wsBroadcast(msg)
    b.commands.clear()
    b.currentCtx = null
    const g = globalThis as unknown as Record<string, {server: unknown} | undefined>
    if (g.__piRemote) g.__piRemote.server = null
})

/** Minimal ExtensionAPI stand-in. `on` DISCARDS its handler, so no event handler
 *  ever runs here — which is why `registerCommand` is the only other member the
 *  registrars under test reach. */
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

test('/compact from the browser reaches ctx.compact', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const {pi} = fakePi()
    registerRemote(pi)

    const compacts: unknown[] = []
    b.currentCtx = makeShimmedCtx({
        isIdle: () => true,
        compact: (opts: unknown) => compacts.push(opts),
        ui: {notify: () => {}}
    } as never)

    expect(dispatchRemoteLine('/compact focus on the failing test', {onPlain: () => {}})).toBe(true)
    expect(compacts).toHaveLength(1)
    expect((compacts[0] as {customInstructions?: string}).customInstructions).toBe(
        'focus on the failing test'
    )
    expect(notifications().some(m => m.includes('Unknown command'))).toBe(false)
})

// The browser's suggestion list is a promise: picking an entry must do
// something. A name advertised there with no dispatchable command behind it
// toasts "Unknown command: /x" on every pick. The list is read out of the shipped
// client script, so adding an entry there without a command fails this test.
test('every command the web UI advertises is dispatchable', () => {
    const {pi} = fakePi()
    registerConfig(pi)
    registerTask(pi)
    registerTaskAuto(pi)
    registerTaskPlan(pi)
    registerRemote(pi)

    const advertised = [...clientScript('ws://x/ws').matchAll(/\{ name: '\/([^']+)'/g)].map(
        m => m[1]!
    )
    expect(advertised.length).toBeGreaterThan(0)

    const dispatchable = getBridge().commands
    const orphans = advertised.filter(entry => {
        const name = entry.split(' ')[0]!
        // `/new` never reaches `bridge.commands`: register.ts matches the literal
        // text and calls `dispatchRemoteNewSession` instead.
        return name !== 'new' && !dispatchable.has(name)
    })
    expect(orphans).toEqual([])
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
