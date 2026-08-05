import {afterEach, expect, test} from 'bun:test'
import {registerRemote} from './register.js'
import {registerConfig} from '../config/register.js'
import {registerTask} from '../task/orchestrator.js'
import {registerTaskAuto} from '../task/auto-orchestrator.js'
import {registerTaskPlan} from '../task/plan-orchestrator.js'
import {getBridge, dispatchRemoteLine, makeShimmedCtx} from './bridge.js'
import {broadcast as wsBroadcast} from './broadcast.js'
import {clientScript} from './ui-script.js'

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

// The browser's suggestion list is a promise: picking an entry must do something.
// It used to advertise /clear, /help and /fast — none of which are pi commands at
// all — so every pick toasted "Unknown command: /x" (github issue #8).
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
        return name !== 'new' && !dispatchable.has(name) // /new is special-cased in register.ts
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
