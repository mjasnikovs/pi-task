import {test, expect, describe, afterEach} from 'bun:test'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {
    isCancelSubmission,
    installCancelListener,
    armCancelListener,
    rearmCancelListener,
    disarmCancelListener,
    isCancelListenerArmed
} from './cancel-input.js'

type Handler = (data: string) => {consume?: boolean; data?: string} | undefined

/** Minimal stand-in for the TUI surface the listener uses: a raw-input
 *  registry plus the editor text, which is all `installCancelListener` reads. */
function fakeUiCtx(initialText = ''): {
    ctx: ExtensionCommandContext
    send: (data: string) => {consume?: boolean; data?: string} | undefined
    setText: (t: string) => void
    text: () => string
    listenerCount: () => number
} {
    let text = initialText
    const handlers = new Set<Handler>()
    const ctx = {
        ui: {
            onTerminalInput: (h: Handler) => {
                handlers.add(h)
                return () => handlers.delete(h)
            },
            getEditorText: () => text,
            setEditorText: (t: string) => {
                text = t
            },
            notify: () => {}
        }
    } as unknown as ExtensionCommandContext
    return {
        ctx,
        send: data => {
            for (const h of handlers) {
                const r = h(data)
                if (r?.consume) return r
            }
            return undefined
        },
        setText: t => {
            text = t
        },
        text: () => text,
        listenerCount: () => handlers.size
    }
}

afterEach(() => disarmCancelListener())

describe('isCancelSubmission', () => {
    test('fires only on Enter over exactly the cancel command', () => {
        expect(isCancelSubmission('\r', '/task-auto-cancel')).toBe(true)
        expect(isCancelSubmission('\n', '  /task-auto-cancel  ')).toBe(true)
        expect(isCancelSubmission('\r\n', '/task-auto-cancel')).toBe(true)
    })

    test('does not fire mid-typing, on other commands, or on prose about it', () => {
        // Still typing — no submit key yet.
        expect(isCancelSubmission('l', '/task-auto-cance')).toBe(false)
        // A different command that merely shares a prefix.
        expect(isCancelSubmission('\r', '/task-auto-resume')).toBe(false)
        expect(isCancelSubmission('\r', '/task-auto build the thing')).toBe(false)
        // Prose mentioning the command must not cancel the run.
        expect(isCancelSubmission('\r', 'why did task-auto-cancel not work?')).toBe(false)
        expect(isCancelSubmission('\r', 'run /task-auto-cancel later')).toBe(false)
    })
})

describe('installCancelListener', () => {
    test('consumes the submit and clears the editor so nothing is queued for replay', () => {
        const f = fakeUiCtx('/task-auto-cancel')
        let fired = 0
        installCancelListener(f.ctx, () => fired++)
        const res = f.send('\r')
        expect(fired).toBe(1)
        // Consuming is what stops pi queueing the line into pendingUserInputs,
        // where it would resurface after the run as "no loop is running".
        expect(res?.consume).toBe(true)
        expect(f.text()).toBe('')
    })

    test('passes every other keystroke through untouched', () => {
        const f = fakeUiCtx('hello')
        let fired = 0
        installCancelListener(f.ctx, () => fired++)
        expect(f.send('\r')).toBeUndefined()
        expect(f.send('\x1b')).toBeUndefined() // ESC — the steer/interrupt path
        expect(f.send('a')).toBeUndefined()
        expect(fired).toBe(0)
        expect(f.text()).toBe('hello')
    })

    test('unsubscribing stops delivery', () => {
        const f = fakeUiCtx('/task-auto-cancel')
        let fired = 0
        const off = installCancelListener(f.ctx, () => fired++)
        off()
        f.send('\r')
        expect(fired).toBe(0)
        expect(f.listenerCount()).toBe(0)
    })

    test('a host without the raw-input hook degrades to a no-op', () => {
        // The shimmed remote ctx has no ui.onTerminalInput; it does not need one,
        // since dispatchRemoteLine calls command handlers directly.
        const bare = {ui: {notify: () => {}}} as unknown as ExtensionCommandContext
        expect(() => installCancelListener(bare, () => {})()).not.toThrow()
    })
})

describe('armCancelListener across session replacement', () => {
    test('re-arming moves delivery to the fresh ctx and drops the old one', () => {
        const first = fakeUiCtx('/task-auto-cancel')
        const fired: string[] = []
        armCancelListener(first.ctx, () => fired.push('first'))
        expect(isCancelListenerArmed()).toBe(true)

        // pi clears every extension terminal-input listener when the old session
        // is invalidated, which happens at the start of each task — the run must
        // re-arm against the replacement ctx or the cancel is undeliverable for
        // the rest of the run.
        const second = fakeUiCtx('/task-auto-cancel')
        rearmCancelListener(second.ctx)
        expect(first.listenerCount()).toBe(0)
        expect(second.listenerCount()).toBe(1)

        second.send('\r')
        expect(fired).toEqual(['first'])
    })

    test('the callback receives the LIVE ctx, not the stale captured one', () => {
        const first = fakeUiCtx()
        const seen: ExtensionCommandContext[] = []
        armCancelListener(first.ctx, live => seen.push(live))
        const second = fakeUiCtx('/task-auto-cancel')
        rearmCancelListener(second.ctx)
        second.send('\r')
        // Using the captured (torn-down) ctx to notify throws "stale ctx".
        expect(seen).toEqual([second.ctx])
    })

    test('re-arming is a no-op when no run armed a listener', () => {
        const f = fakeUiCtx('/task-auto-cancel')
        rearmCancelListener(f.ctx)
        expect(isCancelListenerArmed()).toBe(false)
        expect(f.listenerCount()).toBe(0)
    })

    test('disarming ends delivery for good', () => {
        const f = fakeUiCtx('/task-auto-cancel')
        let fired = 0
        armCancelListener(f.ctx, () => fired++)
        disarmCancelListener()
        expect(isCancelListenerArmed()).toBe(false)
        f.send('\r')
        expect(fired).toBe(0)
    })
})
