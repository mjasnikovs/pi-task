/**
 * The Brave-key startup hint. It is one `session_start` handler, and everything
 * that matters about it is a REFUSAL: it must not paint outside a TUI, under
 * another provider, or when a key is already there — a hint that fires wrongly
 * is worse than no hint, because it tells a working setup it is broken.
 */
import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {registerBraveKeyWarning} from '../../src/workers/brave-warning.js'
import {getConfig} from '../../src/config/config.js'

type SessionStart = (event: unknown, ctx: unknown) => void

/** The handler pi would have subscribed, and nothing else. */
function sessionStartHandler(): SessionStart {
    let handler: SessionStart | undefined
    const pi = {
        on: (event: string, h: SessionStart) => {
            if (event === 'session_start') handler = h
        }
    }
    registerBraveKeyWarning(pi as unknown as ExtensionAPI)
    return handler!
}

interface FakeUi {
    widgets: Array<{key: string; state: unknown}>
    /** Raw-input listeners currently installed. */
    listeners: number
    /** Feed a keystroke to every listener. */
    press: () => void
    ctx: unknown
}

/** `throwOn` makes the named ui call throw, standing in for a stale ctx. */
function fakeCtx(mode: string, throwOn?: 'setWidget'): FakeUi {
    const widgets: Array<{key: string; state: unknown}> = []
    const handlers = new Set<() => unknown>()
    const ui = {
        theme: {fg: (_slot: string, s: string) => s},
        setWidget: (key: string, state: unknown) => {
            if (throwOn === 'setWidget') throw new Error('stale ctx')
            widgets.push({key, state})
        },
        onTerminalInput: (h: () => unknown) => {
            handlers.add(h)
            return () => handlers.delete(h)
        }
    }
    return {
        widgets,
        get listeners() {
            return handlers.size
        },
        press: () => {
            for (const h of [...handlers]) h()
        },
        ctx: {mode, ui}
    }
}

let savedProvider: ReturnType<typeof getConfig>['searchProvider']
let savedBrave: string | undefined
let savedBraveAlt: string | undefined

beforeEach(() => {
    savedProvider = getConfig().searchProvider
    savedBrave = process.env.BRAVE_SEARCH_API_KEY
    savedBraveAlt = process.env.BRAVE_API_KEY
    getConfig().searchProvider = 'brave'
    delete process.env.BRAVE_SEARCH_API_KEY
    delete process.env.BRAVE_API_KEY
})
afterEach(() => {
    getConfig().searchProvider = savedProvider
    if (savedBrave === undefined) delete process.env.BRAVE_SEARCH_API_KEY
    else process.env.BRAVE_SEARCH_API_KEY = savedBrave
    if (savedBraveAlt === undefined) delete process.env.BRAVE_API_KEY
    else process.env.BRAVE_API_KEY = savedBraveAlt
})

describe('the Brave-key hint', () => {
    test('paints once when brave is selected with no key, and names the fix', () => {
        const ui = fakeCtx('tui')

        sessionStartHandler()({}, ui.ctx)

        expect(ui.widgets.length).toBe(1)
        expect(String(ui.widgets[0].state)).toContain('BRAVE_SEARCH_API_KEY')
        expect(String(ui.widgets[0].state)).toContain('/task-config')
    })

    test('the first keystroke clears it and unsubscribes the listener', () => {
        const ui = fakeCtx('tui')
        sessionStartHandler()({}, ui.ctx)
        expect(ui.listeners).toBe(1)

        ui.press()

        expect(ui.widgets.at(-1)).toEqual({key: 'pi-task-brave-warning', state: undefined})
        expect(ui.listeners).toBe(0)
    })

    test('a second keystroke after the clear is harmless', () => {
        const ui = fakeCtx('tui')
        sessionStartHandler()({}, ui.ctx)
        ui.press()
        const after = ui.widgets.length

        ui.press()

        expect(ui.widgets.length).toBe(after)
    })
})

describe('the Brave-key hint stays silent', () => {
    const silent = (ui: FakeUi): void => {
        sessionStartHandler()({}, ui.ctx)
        expect(ui.widgets).toEqual([])
        expect(ui.listeners).toBe(0)
    }

    test('outside a TUI — there is nothing to paint on or dismiss it', () => {
        silent(fakeCtx('print'))
    })

    test('under a keyless provider that cannot be misconfigured this way', () => {
        getConfig().searchProvider = 'ddg'
        silent(fakeCtx('tui'))

        getConfig().searchProvider = 'exa'
        silent(fakeCtx('tui'))
    })

    test('when either accepted key name is already set', () => {
        process.env.BRAVE_SEARCH_API_KEY = 'k'
        silent(fakeCtx('tui'))

        delete process.env.BRAVE_SEARCH_API_KEY
        process.env.BRAVE_API_KEY = 'k'
        silent(fakeCtx('tui'))
    })

    test('a stale ctx that rejects the paint installs no listener', () => {
        const ui = fakeCtx('tui', 'setWidget')

        sessionStartHandler()({}, ui.ctx)

        expect(ui.listeners).toBe(0)
    })
})
