import {afterEach, expect, test} from 'bun:test'
import {getBridge, answerPrompt, SessionUI, publishWidget, publishNotify, publishViewer} from './bridge.js'
import {broadcast as wsBroadcast} from './broadcast.js'

// Reset the singleton between tests.
afterEach(() => {
    const b = getBridge()
    b.pending.clear()
    b.activePrompt = null
    b.activeWidgets.clear()
    b.sent.length = 0
    b.nextId = 0
    b.broadcast = msg => wsBroadcast(msg) // restore production default
})

// Minimal fake ctx whose ui.input is controllable + abortable.
function fakeCtx(opts: {
    hasUI?: boolean
    onInput?: (resolve: (v: string | undefined) => void, signal?: AbortSignal) => void
}) {
    return {
        hasUI: opts.hasUI ?? true,
        ui: {
            theme: {fg: (_c: string, s: string) => s},
            input: (_title: string, _ph?: string, o?: {signal?: AbortSignal}) =>
                new Promise<string | undefined>(resolve => {
                    o?.signal?.addEventListener('abort', () => resolve(undefined))
                    opts.onInput?.(resolve, o?.signal)
                }),
            notify: () => {},
            setWidget: () => {},
            editor: () => Promise.resolve(undefined)
        }
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionCommandContext
}

test('remote answer wins and aborts the local dialog', async () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    let aborted = false
    const ui = new SessionUI(
        fakeCtx({onInput: (_resolve, signal) => signal?.addEventListener('abort', () => (aborted = true))}),
        b
    )
    const p = ui.ask({localTitle: 'Q', question: 'Q', recommended: 'pg', allowSkip: false})
    const promptId = b.activePrompt!.id
    answerPrompt(promptId, 'mysql')
    await expect(p).resolves.toBe('mysql')
    expect(aborted).toBe(true)
    expect(b.sent.some(m => (m as {type: string}).type === 'prompt_resolved')).toBe(true)
    expect(b.activePrompt).toBeNull()
})

test('local answer wins and broadcasts prompt_resolved', async () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const ui = new SessionUI(fakeCtx({onInput: resolve => resolve('local-answer')}), b)
    await expect(
        ui.ask({localTitle: 'Q', question: 'Q', allowSkip: true})
    ).resolves.toBe('local-answer')
    expect(b.pending.size).toBe(0)
    expect(b.sent.some(m => (m as {type: string}).type === 'prompt_resolved')).toBe(true)
})

test('first answer wins; duplicate answerPrompt is a no-op', async () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const ui = new SessionUI(fakeCtx({onInput: () => {}}), b)
    const p = ui.ask({localTitle: 'Q', question: 'Q', allowSkip: false})
    const id = b.activePrompt!.id
    answerPrompt(id, 'first')
    answerPrompt(id, 'second') // already removed from pending → ignored
    await expect(p).resolves.toBe('first')
})

test('no UI (headless): only remote can answer', async () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const ui = new SessionUI(fakeCtx({hasUI: false}), b)
    const p = ui.ask({localTitle: 'Q', question: 'Q', allowSkip: false})
    answerPrompt(b.activePrompt!.id, 'remote-only')
    await expect(p).resolves.toBe('remote-only')
})

test('publishWidget broadcasts lines and records the active widget', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    publishWidget('pi-tasks', ['TASK_0001 · demo', 'phase 3/5 grill · 0:12'])
    expect(b.activeWidgets.get('pi-tasks')).toEqual(['TASK_0001 · demo', 'phase 3/5 grill · 0:12'])
    expect(b.sent).toContainEqual({
        type: 'widget',
        key: 'pi-tasks',
        lines: ['TASK_0001 · demo', 'phase 3/5 grill · 0:12']
    })
})

test('publishWidget with undefined clears the active widget', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    b.activeWidgets.set('pi-tasks', ['x'])
    publishWidget('pi-tasks', undefined)
    expect(b.activeWidgets.has('pi-tasks')).toBe(false)
    expect(b.sent).toContainEqual({type: 'widget', key: 'pi-tasks', lines: null})
})

test('publishNotify broadcasts a notify message', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    publishNotify('Cancelling TASK_0001…', 'warning')
    expect(b.sent).toContainEqual({
        type: 'notify',
        message: 'Cancelling TASK_0001…',
        level: 'warning'
    })
})

test('publishViewer broadcasts a viewer message', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    publishViewer('Tasks', 'TASK_0001 completed\nTASK_0002 pending')
    expect(b.sent).toContainEqual({
        type: 'viewer',
        title: 'Tasks',
        text: 'TASK_0001 completed\nTASK_0002 pending'
    })
})
