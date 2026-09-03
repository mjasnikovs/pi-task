/**
 * Defects the review found in the remote-contract work itself. Each one is a way
 * the fix could still lose a message, evict a live question, or block a run.
 */
import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {
    getBridge,
    SessionUI,
    answerPrompt,
    dispatchRemoteLine,
    isRemoteOrigin,
    registerBridgeCommand,
    notifyBoth
} from '../../src/remote/bridge.js'
import {broadcast as wsBroadcast} from '../../src/remote/broadcast.js'
import {_setSink, getState, reset, snapshot} from '../../src/remote/session-state.js'
import {flashTerminalWidget, NOTIFY_CLEAR_MS} from '../../src/task/widget.js'
import {registerTask} from '../../src/task/orchestrator.js'
import {STYLES} from '../../src/remote/ui-styles.js'

const dirs: string[] = []
function tmpRepo(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-review-'))
    dirs.push(d)
    return d
}

afterEach(() => {
    const b = getBridge()
    b.pending.clear()
    b.sent.length = 0
    b.nextId = 0
    b.broadcast = msg => wsBroadcast(msg)
    b.commands.clear()
    b.currentCtx = null
    reset()
    _setSink(wsBroadcast)
    for (const d of dirs.splice(0)) fs.rmSync(d, {recursive: true, force: true})
})

function frames(): {type: string}[] {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg as never)
    _setSink(msg => b.sent.push(msg as never))
    return b.sent as unknown as {type: string}[]
}

/** A ctx whose `ui` getter throws, which is what pi does once it goes stale. */
function staleCtx(): ExtensionCommandContext {
    return {
        cwd: tmpRepo(),
        hasUI: true,
        mode: 'tui',
        get ui(): never {
            throw new Error('context is no longer active')
        },
        waitForIdle: async () => {},
        isIdle: () => true
    } as unknown as ExtensionCommandContext
}

describe('a stale ctx must not cost the remote the message', () => {
    test('the failure flash still clears on the wire', async () => {
        frames()
        flashTerminalWidget(staleCtx(), 'cancelled', 'TASK_0007', undefined)
        expect(JSON.stringify(getState().taskWidget)).toContain('TASK_0007')

        // The flash clears on a timer. A throw from the local half must not take
        // the wire clear with it, or the browser keeps ⚠ TASK_0007 forever.
        await new Promise(r => setTimeout(r, NOTIFY_CLEAR_MS + 200))
        expect(getState().taskWidget).toBeNull()
    }, 10_000)

    test('notifyBoth publishes even when the local notify throws', () => {
        frames()
        notifyBoth(staleCtx(), 'still reaches the browser', 'warning')
        expect(JSON.stringify(getBridge().sent)).toContain('still reaches the browser')
    })
})

describe('a display must not evict a live question', () => {
    test('a parked ask is still answerable after a /task-list closes', async () => {
        const b = frames()
        const ctx = {
            hasUI: true,
            ui: {
                theme: {fg: (_c: string, s: string) => s, bold: (s: string) => s},
                input: () => new Promise<string | undefined>(() => {}),
                custom: () => new Promise<string | undefined>(() => {}),
                editor: () => new Promise<string | undefined>(() => {}),
                notify: () => {}
            }
        } as unknown as ExtensionCommandContext
        const ui = new SessionUI(ctx, getBridge())

        const asked = ui.ask({localTitle: 'q', question: 'which provider?', allowSkip: false})
        await new Promise(r => setTimeout(r, 10))
        const askId = getState().prompt!.id

        void ui.show({localTitle: 'Tasks', localText: 'l', question: 'Tasks', body: 'l'})
        await new Promise(r => setTimeout(r, 10))
        const listId = getState().prompt!.id
        expect(listId).not.toBe(askId)

        answerPrompt(listId, '')
        await new Promise(r => setTimeout(r, 10))

        // The question was there first and nobody answered it. It must be back on
        // screen and back in the snapshot, not silently unanswerable.
        expect(getState().prompt?.id).toBe(askId)
        expect(JSON.stringify(snapshot())).toContain('which provider?')
        answerPrompt(askId, 'exa')
        expect(await asked).toBe('exa')
        expect(b.length).toBeGreaterThan(0)
    })

    test('a dismiss-only display does not push "pi needs your input"', async () => {
        const pushes: string[] = []
        const push = await import('../../src/remote/push.js')
        const real = push.pushNotify
        ;(push as {pushNotify: unknown}).pushNotify = (title: string) => {
            pushes.push(title)
            return Promise.resolve()
        }
        const b = getBridge()
        frames()
        const ctx = {
            hasUI: true,
            ui: {
                theme: {fg: (_c: string, s: string) => s},
                editor: () => new Promise<string | undefined>(() => {}),
                notify: () => {}
            }
        } as unknown as ExtensionCommandContext
        void new SessionUI(ctx, b).show({
            localTitle: 'Tasks',
            localText: 'l',
            question: 'Tasks',
            body: 'l'
        })
        await new Promise(r => setTimeout(r, 10))
        // A read-only card is not a request for input; waking a phone for it is a lie.
        ;(push as {pushNotify: unknown}).pushNotify = real
        // A read-only card is not a request for input; waking a phone for it is a lie.
        expect(pushes).toEqual([])
        expect(getState().prompt?.dismissOnly).toBe(true)
    })

    test('a display never blocks a run on a host with no TUI', async () => {
        frames()
        const ctx = {hasUI: false, ui: {}} as unknown as ExtensionCommandContext
        // No local editor and possibly no browser: a DISPLAY has nothing to wait for.
        await new SessionUI(ctx, getBridge()).show({
            localTitle: 'Tasks',
            localText: 'TASK_0001 pending',
            question: 'Tasks',
            body: 'TASK_0001 pending'
        })
        expect(JSON.stringify(snapshot())).toContain('TASK_0001 pending')
    })
})

describe('the remote-origin marker stays off the shared ctx', () => {
    test('a remote slash line does not make the NEXT terminal call look remote', () => {
        frames()
        const b = getBridge()
        const seen: boolean[] = []
        const pi = {
            on: () => {},
            registerCommand: () => {},
            registerTool: () => {},
            sendUserMessage: () => {}
        } as unknown as ExtensionAPI
        registerBridgeCommand(pi, 'probe', {
            description: 'p',
            handler: (_a: string, c: ExtensionCommandContext) => {
                seen.push(isRemoteOrigin(c))
            }
        })
        const host = {cwd: tmpRepo(), ui: {notify: () => {}}} as unknown as ExtensionCommandContext
        b.currentCtx = host

        dispatchRemoteLine('/probe', {onPlain: () => {}})
        dispatchRemoteLine('/probe', {onPlain: () => {}})

        expect(seen).toEqual([true, true])
        // The clone must not become the stored ctx: every later remote line would
        // otherwise clone the clone, growing the prototype chain for the session.
        expect(b.currentCtx).toBe(host)
    })
})

describe('a command reply reaches the browser exactly once', () => {
    test('no duplicate frame for a /task-resume refusal', async () => {
        const cwd = tmpRepo()
        const sent = frames()
        const table = new Map<string, (a: string, c: ExtensionCommandContext) => unknown>()
        const pi = {
            on: () => {},
            registerCommand: (
                n: string,
                o: {handler: (a: string, c: ExtensionCommandContext) => unknown}
            ) => table.set(n, o.handler),
            registerTool: () => {},
            sendUserMessage: () => {}
        } as unknown as ExtensionAPI
        registerTask(pi)
        const ctx = {
            cwd,
            hasUI: true,
            ui: {notify: () => {}, setEditorText: () => {}},
            waitForIdle: async () => {}
        } as unknown as ExtensionCommandContext

        await table.get('task-resume')!('', ctx)

        const hits = sent.filter(f => JSON.stringify(f).includes('No resumable tasks.'))
        expect(hits).toHaveLength(1)
    })
})

describe('a multi-line system note renders as multiple lines', () => {
    test('.sysnote keeps its newlines', () => {
        // publishNote is the durable channel for /task-config; the browser sets
        // textContent, so without this the whole settings table collapses to one line.
        const rule = STYLES.slice(STYLES.indexOf('.sysnote {'))
        expect(rule.slice(0, rule.indexOf('}'))).toContain('white-space: pre-wrap')
    })
})
