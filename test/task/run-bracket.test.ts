import {afterEach, beforeEach, expect, mock, test} from 'bun:test'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

// The push half of announceTerminal is a no-op under NODE_ENV=test, so observe
// it at the module boundary instead of through the network.
const pushes: Array<{title: string; body: string; tag?: string}> = []
void mock.module('../../src/remote/push.js', () => ({
    pushNotify: async (title: string, body: string, tag?: string) => {
        pushes.push({title, body, tag})
    }
}))

const {withRun, announceTerminal} = await import('../../src/task/run-bracket.js')
const {isRunActive, holdInput, heldInput, resetMidRunInput} =
    await import('../../src/task/mid-run-input.js')
const {isCancelListenerArmed, forceDisarmCancelListener} =
    await import('../../src/task/cancel-input.js')
const {getBridge} = await import('../../src/remote/bridge.js')
const {broadcast: wsBroadcast} = await import('../../src/remote/broadcast.js')
const {reset: resetSessionState, _setSink} = await import('../../src/remote/session-state.js')

/** Persistent remote errors go through the session-state sink, not the bridge. */
const sunk: unknown[] = []

type Handler = (data: string) => {consume?: boolean; data?: string} | undefined

/** The TUI surface the bracket touches: raw input, the editor, and toasts. */
function fakeCtx(): {
    ctx: ExtensionCommandContext
    notified: Array<{msg: string; level: string}>
    listeners: () => number
    submit: (text: string) => void
} {
    let text = ''
    const handlers = new Set<Handler>()
    const notified: Array<{msg: string; level: string}> = []
    const ctx = {
        isIdle: () => true,
        ui: {
            onTerminalInput: (h: Handler) => {
                handlers.add(h)
                return () => handlers.delete(h)
            },
            getEditorText: () => text,
            setEditorText: (t: string) => {
                text = t
            },
            notify: (msg: string, level: string) => notified.push({msg, level})
        }
    } as unknown as ExtensionCommandContext
    return {
        ctx,
        notified,
        listeners: () => handlers.size,
        submit: (line: string) => {
            text = line
            for (const h of handlers) if (h('\r')?.consume) return
        }
    }
}

beforeEach(() => {
    resetMidRunInput()
    forceDisarmCancelListener()
    resetSessionState()
    sunk.length = 0
    _setSink(m => sunk.push(m))
    pushes.length = 0
    const b = getBridge()
    b.sent.length = 0
    b.broadcast = m => b.sent.push(m)
})

afterEach(() => {
    resetMidRunInput()
    forceDisarmCancelListener()
    const b = getBridge()
    b.sent.length = 0
    b.broadcast = msg => wsBroadcast(msg)
})

// ─── withRun ─────────────────────────────────────────────────────────────────

test('the bracket holds and arms for exactly the duration of fn, and returns its value', async () => {
    const {ctx, listeners} = fakeCtx()
    expect(isRunActive()).toBe(false)
    expect(isCancelListenerArmed()).toBe(false)
    const out = await withRun(ctx, {}, async () => {
        expect(isRunActive()).toBe(true)
        expect(isCancelListenerArmed()).toBe(true)
        expect(listeners()).toBe(1)
        return 42
    })
    expect(out).toBe(42)
    expect(isRunActive()).toBe(false)
    expect(isCancelListenerArmed()).toBe(false)
    expect(listeners()).toBe(0)
})

test('a throw still disarms and ends the run, and rethrows', async () => {
    const {ctx, listeners} = fakeCtx()
    await expect(
        withRun(ctx, {}, async () => {
            throw new Error('boom')
        })
    ).rejects.toThrow('boom')
    expect(isRunActive()).toBe(false)
    expect(isCancelListenerArmed()).toBe(false)
    expect(listeners()).toBe(0)
})

test('nested brackets refcount: the inner end leaves the outer run held and armed', async () => {
    const {ctx, listeners} = fakeCtx()
    await withRun(ctx, {}, async () => {
        await withRun(ctx, {}, async () => {
            expect(isRunActive()).toBe(true)
        })
        // Inner ended — the loop is still a run.
        expect(isRunActive()).toBe(true)
        expect(isCancelListenerArmed()).toBe(true)
        expect(listeners()).toBe(1)
    })
    expect(isRunActive()).toBe(false)
    expect(isCancelListenerArmed()).toBe(false)
})

test('an inner throw does not un-arm the outer run', async () => {
    const {ctx} = fakeCtx()
    await withRun(ctx, {}, async () => {
        await withRun(ctx, {}, async () => {
            throw new Error('inner')
        }).catch(() => {})
        expect(isRunActive()).toBe(true)
        expect(isCancelListenerArmed()).toBe(true)
    })
    expect(isRunActive()).toBe(false)
})

test('onCancel is wired to a typed /task-auto-cancel, and receives the live ctx', async () => {
    const {ctx, submit} = fakeCtx()
    const seen: ExtensionCommandContext[] = []
    await withRun(ctx, {onCancel: live => seen.push(live)}, async () => {
        submit('/task-auto-cancel')
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe(ctx)
})

test('a plain line typed inside the bracket is held, and reported as dropped when no turn took it', async () => {
    const {ctx, submit, notified} = fakeCtx()
    await withRun(ctx, {}, async () => {
        submit('also add retries')
        expect(heldInput()).toEqual(['also add retries'])
    })
    expect(heldInput()).toEqual([])
    const dropped = notified.find(n => n.msg.includes('could be delivered'))
    expect(dropped?.level).toBe('warning')
    expect(dropped?.msg).toContain('also add retries')
})

test('a line held by the inner run is NOT dropped at the inner end — the outer run still owns it', async () => {
    const {ctx, notified} = fakeCtx()
    await withRun(ctx, {}, async () => {
        await withRun(ctx, {}, async () => {
            holdInput('for later')
        })
        expect(heldInput()).toEqual(['for later'])
        expect(notified.some(n => n.msg.includes('could be delivered'))).toBe(false)
    })
    expect(notified.some(n => n.msg.includes('could be delivered'))).toBe(true)
})

// ─── announceTerminal ────────────────────────────────────────────────────────

test('announceTerminal fans out to toast, remote notify and push, with the same text', () => {
    const {ctx, notified} = fakeCtx()
    announceTerminal(ctx, 'TASK_0001 completed.', 'info')
    expect(notified).toEqual([{msg: 'TASK_0001 completed.', level: 'info'}])
    const notify = getBridge().sent.find(m => (m as {type: string}).type === 'notify') as
        {message: string; level: string} | undefined
    expect(notify?.message).toBe('TASK_0001 completed.')
    expect(notify?.level).toBe('info')
    expect(pushes).toEqual([{title: 'Task finished', body: 'TASK_0001 completed.', tag: 'pi-end'}])
})

test('an error becomes the persistent remote error, not a transient notify', () => {
    const {ctx} = fakeCtx()
    announceTerminal(ctx, 'TASK_0001 stopped: x', 'error')
    expect(sunk.map(m => (m as {type: string}).type)).toContain('agent_error')
    expect(getBridge().sent.some(m => (m as {type: string}).type === 'notify')).toBe(false)
    expect(pushes).toHaveLength(1)
})

test('push: false keeps the two live surfaces and skips the push', () => {
    const {ctx, notified} = fakeCtx()
    announceTerminal(ctx, 'TASK_PLAN_0001 cancelled — nothing planned.', 'warning', {push: false})
    expect(notified).toHaveLength(1)
    expect(getBridge().sent.some(m => (m as {type: string}).type === 'notify')).toBe(true)
    expect(pushes).toHaveLength(0)
})
