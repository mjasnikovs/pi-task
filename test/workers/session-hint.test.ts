/**
 * The startup-hint lifecycle, driven through the one interface both hints use.
 *
 * The REFINE half is the reason this file exists. It was written in
 * reasoning-warning.ts and reachable by no test there — every test model lacked
 * a `baseUrl`, so the branch that repaints after a server probe never ran. The
 * rule it enforces (never repaint a widget the user has already dismissed) was a
 * closure variable in one of the two hints; here it is asserted.
 */
import {describe, expect, test} from 'bun:test'
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {registerSessionHint, type SessionHint} from '../../src/workers/session-hint.js'

type SessionStart = (event: unknown, ctx: unknown) => void

interface Harness {
    /** Every `setWidget` call, in order. `state` is undefined for a clear. */
    widgets: Array<{key: string; state: unknown}>
    /** Raw-input listeners currently installed. */
    listeners: number
    /** Feed a keystroke to every listener. */
    press: () => void
    /** Run the handler pi would have subscribed. */
    start: () => void
}

/** `throwOn` makes `setWidget` throw, standing in for a stale ctx. */
function harness(
    compose: (ctx: ExtensionContext) => SessionHint | null,
    opts: {mode?: string; throwOn?: 'first' | 'all'} = {}
): Harness {
    const widgets: Array<{key: string; state: unknown}> = []
    const handlers = new Set<() => unknown>()
    let calls = 0
    const ui = {
        theme: {fg: (_slot: string, s: string) => s},
        setWidget: (key: string, state: unknown) => {
            calls += 1
            if (opts.throwOn === 'all' || (opts.throwOn === 'first' && calls === 1)) {
                throw new Error('stale ctx')
            }
            widgets.push({key, state})
        },
        onTerminalInput: (h: () => unknown) => {
            handlers.add(h)
            return () => handlers.delete(h)
        }
    }
    let handler: SessionStart | undefined
    const pi = {
        on: (event: string, h: SessionStart) => {
            if (event === 'session_start') handler = h
        }
    }
    registerSessionHint(pi as unknown as ExtensionAPI, 'hint-key', compose)
    return {
        widgets,
        get listeners() {
            return handlers.size
        },
        press: () => {
            for (const h of [...handlers]) h()
        },
        start: () => handler!({}, {mode: opts.mode ?? 'tui', ui})
    }
}

/** Let the microtask queue drain, which is all a resolved `refine` needs. */
async function settle(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
}

describe('the session-hint lifecycle', () => {
    test('paints the composed line under a key', () => {
        const h = harness(() => ({text: 'hello'}))

        h.start()

        expect(h.widgets).toEqual([{key: 'hint-key', state: ['hello']}])
        expect(h.listeners).toBe(1)
    })

    test('paints nothing outside a TUI, and does not even compose', () => {
        let composed = 0
        const h = harness(
            () => {
                composed += 1
                return {text: 'hello'}
            },
            {mode: 'print'}
        )

        h.start()

        expect(composed).toBe(0)
        expect(h.widgets.length).toBe(0)
        expect(h.listeners).toBe(0)
    })

    test('a compose that returns null says nothing and installs no listener', () => {
        const h = harness(() => null)

        h.start()

        expect(h.widgets.length).toBe(0)
        expect(h.listeners).toBe(0)
    })

    test('the first keystroke clears the widget and unsubscribes', () => {
        const h = harness(() => ({text: 'hello'}))

        h.start()
        h.press()

        expect(h.widgets.at(-1)).toEqual({key: 'hint-key', state: undefined})
        expect(h.listeners).toBe(0)
    })

    test('a stale ctx at first paint is not fatal and leaves no listener', () => {
        const h = harness(() => ({text: 'hello'}), {throwOn: 'first'})

        h.start()

        expect(h.widgets.length).toBe(0)
        expect(h.listeners).toBe(0)
    })

    test('a stale ctx while clearing is swallowed, and still unsubscribes', () => {
        const h = harness(() => ({text: 'hello'}), {throwOn: 'all'})
        // First paint throws too, so drive the clear through a hint that painted.
        const ok = harness(() => ({text: 'hello'}))

        ok.start()
        expect(() => h.start()).not.toThrow()
        ok.press()

        expect(ok.listeners).toBe(0)
    })
})

describe('a hint that refines itself later', () => {
    test('repaints with the refined line', async () => {
        const h = harness(() => ({text: 'base', refine: Promise.resolve('base + cause')}))

        h.start()
        await settle()

        expect(h.widgets.map(w => w.state)).toEqual([['base'], ['base + cause']])
    })

    test('a refinement resolving null leaves the first line standing', async () => {
        const h = harness(() => ({text: 'base', refine: Promise.resolve(null)}))

        h.start()
        await settle()

        expect(h.widgets.map(w => w.state)).toEqual([['base']])
    })

    test('a rejected refinement leaves the first line standing', async () => {
        const h = harness(() => ({text: 'base', refine: Promise.reject(new Error('probe'))}))

        h.start()
        await settle()

        expect(h.widgets.map(w => w.state)).toEqual([['base']])
    })

    test('a refinement that lands AFTER a keystroke does not repaint', async () => {
        let land: (text: string | null) => void = () => {}
        const refine = new Promise<string | null>(resolve => {
            land = resolve
        })
        const h = harness(() => ({text: 'base', refine}))

        h.start()
        h.press()
        land('base + cause')
        await settle()

        // The clear is the last word: the dismissed hint never comes back.
        expect(h.widgets.map(w => w.state)).toEqual([['base'], undefined])
    })

    test('a rejected refinement is handled even when the FIRST PAINT failed', async () => {
        // `compose` builds the refine promise EAGERLY — the reasoning hint kicks
        // its probe off inside it — so attaching the handler after the paint bail
        // orphans the rejection on exactly the path the paint's try/catch exists
        // for: a stale ctx after a session switch.
        const rejections: unknown[] = []
        const onUnhandled = (e: unknown): void => {
            rejections.push(e)
        }
        process.on('unhandledRejection', onUnhandled)
        try {
            const h = harness(() => ({text: 'base', refine: Promise.reject(new Error('probe'))}), {
                throwOn: 'all'
            })

            h.start()
            await settle()

            expect(h.widgets).toEqual([])
            expect(rejections).toEqual([])
        } finally {
            process.off('unhandledRejection', onUnhandled)
        }
    })

    test('the refinement never delays or prevents the first paint', () => {
        const h = harness(() => ({text: 'base', refine: new Promise<string | null>(() => {})}))

        h.start()

        expect(h.widgets.map(w => w.state)).toEqual([['base']])
        expect(h.listeners).toBe(1)
    })
})
