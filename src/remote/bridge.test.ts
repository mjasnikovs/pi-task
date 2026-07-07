import {afterEach, expect, test} from 'bun:test'
import {
    getBridge,
    answerPrompt,
    SessionUI,
    publishNotify,
    publishLifecycleNotice,
    publishViewer,
    registerBridgeCommand,
    dispatchRemoteLine,
    dispatchRemoteNewSession,
    makeShimmedCtx
} from './bridge.js'
import {broadcast as wsBroadcast} from './broadcast.js'
import {getState, _setSink, reset} from './session-state.js'

// Reset the singletons between tests.
afterEach(() => {
    const b = getBridge()
    b.pending.clear()
    b.sent.length = 0
    b.nextId = 0
    b.broadcast = msg => wsBroadcast(msg) // restore production default
    b.commands.clear()
    b.currentCtx = null
    reset()
    _setSink(wsBroadcast) // restore production default for the session-state sink
})

// Minimal fake ctx whose ui.input is controllable + abortable.
function fakeCtx(opts: {
    hasUI?: boolean
    onInput?: (resolve: (v: string | undefined) => void, signal?: AbortSignal) => void
}) {
    return {
        hasUI: opts.hasUI ?? true,
        ui: {
            theme: {fg: (_c: string, s: string) => s, bold: (s: string) => s},
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
    _setSink(msg => b.sent.push(msg as never)) // prompt/prompt_resolved flow through SessionState
    let aborted = false
    const ui = new SessionUI(
        fakeCtx({
            onInput: (_resolve, signal) => signal?.addEventListener('abort', () => (aborted = true))
        }),
        b
    )
    const p = ui.ask({localTitle: 'Q', question: 'Q', recommended: 'pg', allowSkip: false})
    const promptId = getState().prompt!.id
    answerPrompt(promptId, 'mysql')
    await expect(p).resolves.toBe('mysql')
    expect(aborted).toBe(true)
    expect(b.sent.some(m => (m as {type: string}).type === 'prompt_resolved')).toBe(true)
    expect(getState().prompt).toBeNull()
})

test('local answer wins and broadcasts prompt_resolved', async () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    const ui = new SessionUI(fakeCtx({onInput: resolve => resolve('local-answer')}), b)
    await expect(ui.ask({localTitle: 'Q', question: 'Q', allowSkip: true})).resolves.toBe(
        'local-answer'
    )
    expect(b.pending.size).toBe(0)
    expect(b.sent.some(m => (m as {type: string}).type === 'prompt_resolved')).toBe(true)
})

test('first answer wins; duplicate answerPrompt is a no-op', async () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    const ui = new SessionUI(fakeCtx({onInput: () => {}}), b)
    const p = ui.ask({localTitle: 'Q', question: 'Q', allowSkip: false})
    const id = getState().prompt!.id
    answerPrompt(id, 'first')
    answerPrompt(id, 'second') // already removed from pending → ignored
    await expect(p).resolves.toBe('first')
})

test('no UI (headless): only remote can answer', async () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    const ui = new SessionUI(fakeCtx({hasUI: false}), b)
    const p = ui.ask({localTitle: 'Q', question: 'Q', allowSkip: false})
    answerPrompt(getState().prompt!.id, 'remote-only')
    await expect(p).resolves.toBe('remote-only')
})

test('remote off (no server, default broadcast): resolves from local, no crash', async () => {
    // afterEach restores the production wsBroadcast, which iterates the (empty)
    // client set — this proves ask() is a clean no-op on the wire when nobody is
    // connected and still resolves from the local input alone.
    const ui = new SessionUI(fakeCtx({onInput: resolve => resolve('local')}))
    await expect(ui.ask({localTitle: 'Q', question: 'Q', allowSkip: true})).resolves.toBe('local')
})

test('localPlaceholder feeds the local input but never the remote card', async () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    const ctx = fakeCtx({onInput: resolve => resolve('typed')})
    // Capture the placeholder the local dialog receives (the steer prompt's
    // "type guidance…" hint) — it must reach ui.input but MUST NOT surface on
    // the remote card as a recommended answer.
    let placeholder: string | undefined
    const realInput = ctx.ui.input.bind(ctx.ui)
    ctx.ui.input = (t, ph, o) => {
        placeholder = ph
        return realInput(t, ph, o)
    }
    const ui = new SessionUI(ctx, b)
    await expect(
        ui.ask({localTitle: 'T', question: 'Q', localPlaceholder: 'hint text', allowSkip: true})
    ).resolves.toBe('typed')
    expect(placeholder).toBe('hint text')
    const prompt = b.sent.find(m => (m as {type: string}).type === 'prompt') as unknown as {
        recommended?: string
        question: string
    }
    expect(prompt).toBeDefined()
    expect(prompt.recommended).toBeUndefined()
    expect(prompt.question).toBe('Q')
})

// Mock ctx.ui.custom for the boxed picker: builds the real component, drives it
// `down` rows then confirms with Enter — exercising the actual navigation +
// onChoose wiring. `rendered` captures the component's lines for assertions.
function boxedCtx(opts: {down: number; input?: () => Promise<string | undefined>}) {
    const rendered: string[] = []
    const ctx = {
        hasUI: true,
        ui: {
            theme: {fg: (_c: string, s: string) => s, bold: (s: string) => s},
            custom: <T>(
                factory: (
                    tui: unknown,
                    theme: unknown,
                    kb: unknown,
                    done: (r: T) => void
                ) => {render: (w: number) => string[]; handleInput: (d: string) => void}
            ) =>
                new Promise<T>(resolve => {
                    const comp = factory({}, {}, {}, resolve)
                    rendered.push(...comp.render(80))
                    for (let i = 0; i < opts.down; i++) comp.handleInput('\x1b[B')
                    comp.handleInput('\r')
                }),
            input: opts.input ?? (async () => undefined),
            notify: () => {},
            setWidget: () => {}
        }
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionCommandContext
    return {ctx, rendered}
}

test('boxed picker: choosing an option resolves to its value, not its label', async () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    const {ctx, rendered} = boxedCtx({down: 1}) // move to the "B: …" card, then Enter
    const ui = new SessionUI(ctx, b)
    await expect(
        ui.ask({
            localTitle: 'npm or pnpm?',
            question: 'npm or pnpm?',
            recommended: 'npm',
            recommended2: 'pnpm',
            allowSkip: false,
            options: [
                {label: 'A: npm', value: 'npm'},
                {label: 'B: pnpm', value: 'pnpm'}
            ]
        })
    ).resolves.toBe('pnpm')
    // Both options plus the free-text fallback render as boxed cards.
    const all = rendered.join('\n')
    expect(all).toContain('A: npm')
    expect(all).toContain('B: pnpm')
    expect(all).toContain('Type a different answer…')
})

test('boxed picker: "type a different answer" falls through to a text input', async () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    // Two cards + the manual fallback → index 2 is the trailing free-text entry.
    const {ctx} = boxedCtx({down: 2, input: async () => 'yarn'})
    const ui = new SessionUI(ctx, b)
    await expect(
        ui.ask({
            localTitle: 'npm or pnpm?',
            question: 'npm or pnpm?',
            recommended: 'npm',
            recommended2: 'pnpm',
            allowSkip: false,
            options: [
                {label: 'A: npm', value: 'npm'},
                {label: 'B: pnpm', value: 'pnpm'}
            ]
        })
    ).resolves.toBe('yarn')
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

test('publishLifecycleNotice: an error becomes a persistent red bubble in the transcript', () => {
    const b = getBridge()
    _setSink(msg => b.sent.push(msg as never))
    publishLifecycleNotice('TASK_0001 failed: clarify model error.', 'error')
    // addError → persistent agent_error (survives reconnect via the snapshot),
    // matching the terminal's red text — not a transient toast.
    // agent_error is a live SessionState delta — intentionally not in the typed
    // ServerMessage union (see protocol.ts), so cast the literal like the rest of
    // this file does for sink captures.
    expect(b.sent).toContainEqual({
        type: 'agent_error',
        message: 'TASK_0001 failed: clarify model error.'
    } as never)
    expect(
        getState()
            .history.getEntries()
            .some(t => t.error)
    ).toBe(true)
})

test('publishLifecycleNotice: a non-error is a transient toast', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    publishLifecycleNotice('TASK_0001 cancelled.', 'warning')
    expect(b.sent).toContainEqual({
        type: 'notify',
        message: 'TASK_0001 cancelled.',
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

test('dispatchRemoteLine routes a registered slash command to its handler', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const calls: Array<{args: string}> = []
    const ctx = {
        hasUI: true,
        waitForIdle: () => {}
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionCommandContext
    b.currentCtx = ctx
    b.commands.set('task', (args, _ctx) => {
        calls.push({args})
    })
    const handled = dispatchRemoteLine('/task add retries', {
        onPlain: () => {}
    })
    expect(handled).toBe(true)
    expect(calls).toEqual([{args: 'add retries'}])
})

test('dispatchRemoteLine toasts on unknown slash command', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    b.currentCtx = {} as never
    const handled = dispatchRemoteLine('/bogus xyz', {onPlain: () => {}})
    expect(handled).toBe(true)
    expect(b.sent.some(m => (m as {type: string}).type === 'notify')).toBe(true)
})

test('dispatchRemoteLine sends plain lines to onPlain', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    let plain = ''
    const handled = dispatchRemoteLine('hello there', {onPlain: t => (plain = t)})
    expect(handled).toBe(false)
    expect(plain).toBe('hello there')
})

test('dispatchRemoteLine invokes the command with the seeded (shimmed) ctx', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    // session_start seeds a shimmed, command-capable ctx, so commands run against
    // it immediately — no terminal interaction required.
    b.currentCtx = makeShimmedCtx({isIdle: () => true} as never)
    let receivedCtx: unknown
    b.commands.set('task', (_args, ctx) => {
        receivedCtx = ctx
    })
    const handled = dispatchRemoteLine('/task go', {onPlain: () => {}})
    expect(handled).toBe(true)
    expect(typeof (receivedCtx as {waitForIdle?: unknown}).waitForIdle).toBe('function')
})

test('dispatchRemoteLine toasts when an async command handler rejects', async () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    b.currentCtx = {waitForIdle: () => {}} as never
    b.commands.set('task', () => Promise.reject(new Error('boom')))
    dispatchRemoteLine('/task go', {onPlain: () => {}})
    await new Promise(r => setTimeout(r, 0)) // let the rejection settle
    expect(
        b.sent.some(
            m =>
                (m as {type: string; message?: string}).type === 'notify'
                && (m as {message?: string}).message?.includes('boom')
        )
    ).toBe(true)
})

test('dispatchRemoteNewSession does not throw when newSession is stale (sync throw)', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    // A stale command ctx still LOOKS command-capable (waitForIdle is a function)
    // but newSession() throws synchronously from assertActive — this is the crash.
    b.currentCtx = {
        waitForIdle: () => {},
        newSession: () => {
            throw new Error('This extension ctx is stale after session replacement')
        }
    } as never
    let rebound = false
    expect(() =>
        dispatchRemoteNewSession(() => {
            rebound = true
        })
    ).not.toThrow()
    expect(rebound).toBe(false)
    expect(
        b.sent.some(
            m =>
                (m as {type: string; message?: string}).type === 'notify'
                && (m as {message?: string}).message?.includes('stale')
        )
    ).toBe(true)
})

test('dispatchRemoteNewSession toasts when currentCtx is null', () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    b.currentCtx = null
    dispatchRemoteNewSession(() => {})
    expect(b.sent.some(m => (m as {type: string}).type === 'notify')).toBe(true)
})

test("dispatchRemoteNewSession toasts the shim's actionable error when only a shimmed ctx is available", () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    // A shimmed ctx is command-capable but its newSession throws a clear, actionable
    // message; dispatchRemoteNewSession surfaces it as a toast and does not rebind.
    b.currentCtx = makeShimmedCtx({isIdle: () => true} as never)
    let rebound = false
    dispatchRemoteNewSession(() => (rebound = true))
    expect(rebound).toBe(false)
    expect(
        b.sent.some(
            m =>
                (m as {type: string; message?: string}).type === 'notify'
                && (m as {message?: string}).message?.includes('Run /remote in the terminal once')
        )
    ).toBe(true)
})

test('dispatchRemoteNewSession invokes newSession and rebinds via withSession', async () => {
    const b = getBridge()
    b.broadcast = msg => b.sent.push(msg)
    const newCtx = {waitForIdle: () => {}} as never
    let withSessionCb: ((ctx: never) => unknown) | undefined
    b.currentCtx = {
        waitForIdle: () => {},
        newSession: (opts: {withSession?: (ctx: never) => unknown}) => {
            withSessionCb = opts.withSession
            return Promise.resolve({cancelled: false})
        }
    } as never
    let reboundWith: unknown
    dispatchRemoteNewSession(ctx => (reboundWith = ctx))
    expect(withSessionCb).toBeDefined()
    await withSessionCb!(newCtx)
    expect(reboundWith).toBe(newCtx)
    expect(b.currentCtx).toBe(newCtx)
})

test('registerBridgeCommand records the handler and forwards to pi.registerCommand', () => {
    const b = getBridge()
    const registered: string[] = []
    const pi = {
        registerCommand: (name: string) => registered.push(name)
    } as unknown as import('@earendil-works/pi-coding-agent').ExtensionAPI
    registerBridgeCommand(pi, 'task-cancel', {description: 'x', handler: () => {}})
    expect(registered).toContain('task-cancel')
    expect(b.commands.has('task-cancel')).toBe(true)
})
