import {test, expect, describe, afterEach} from 'bun:test'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {beginRun, heldInput, resetMidRunInput} from '../../src/task/mid-run-input.js'
import {getBridge} from '../../src/remote/bridge.js'
import {setPrompt, reset as resetSessionState, _setSink} from '../../src/remote/session-state.js'
import {
    forceDisarmCancelListener,
    isCancelSubmission,
    installCancelListener,
    armCancelListener,
    rearmCancelListener,
    disarmCancelListener,
    isCancelListenerArmed
} from '../../src/task/cancel-input.js'

type Handler = (data: string) => {consume?: boolean; data?: string} | undefined

/** Minimal stand-in for the TUI surface the listener uses: a raw-input
 *  registry plus the editor text, which is all `installCancelListener` reads. */
function fakeUiCtx(initialText = ''): {
    ctx: ExtensionCommandContext
    send: (data: string) => {consume?: boolean; data?: string} | undefined
    setText: (t: string) => void
    text: () => string
    listenerCount: () => number
    setIdle: (v: boolean) => void
} {
    let text = initialText
    let idle = true
    const handlers = new Set<Handler>()
    const ctx = {
        isIdle: () => idle,
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
        listenerCount: () => handlers.size,
        setIdle: (v: boolean) => {
            idle = v
        }
    }
}

_setSink(() => {}) // these tests never need the real broadcast

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
        // Consuming is what stops pi queueing the line. In interactive-mode.js a
        // submitted line goes to `onInputCallback` if one is set and otherwise to
        // `this.pendingUserInputs.push(text)`, which a later `shift()` replays —
        // so an unconsumed cancel is silent now and resurfaces after the run.
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
        // The shimmed remote ctx has no ui.onTerminalInput and does not need one:
        // dispatchRemoteLine (remote/bridge.ts:342) looks the name up in the
        // bridge's own command map and calls the handler directly.
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

        // pi clears every extension terminal-input listener when a session is
        // invalidated: `setBeforeSessionInvalidate(() => this.resetExtensionUI())`
        // in interactive-mode.js, and resetExtensionUI calls
        // clearExtensionTerminalInputListeners. A task replaces the session, so
        // the run must re-arm against the replacement ctx or the cancel is
        // undeliverable for the rest of the run.
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

// ─── Mid-run parity with the browser ─────────────────────────────────────────
//
// A mid-run line typed in the terminal must reach the run, not pi's
// pendingUserInputs queue — where it is silent at the time and then replayed all
// at once against a finished run.
describe('mid-run terminal input', () => {
    afterEach(() => {
        forceDisarmCancelListener()
        resetMidRunInput()
        resetSessionState()
        getBridge().commands.clear()
    })

    // Runs nest: /task-auto arms for the loop and each task inside arms again.
    // A plain replace/disarm pair would leave the rest of the loop unarmed.
    test('arming is refcounted so an inner run end does not unarm the loop', () => {
        const f = fakeUiCtx('x')
        armCancelListener(f.ctx, () => {})
        armCancelListener(f.ctx) // inner task
        disarmCancelListener()
        expect(isCancelListenerArmed()).toBe(true)
        disarmCancelListener()
        expect(isCancelListenerArmed()).toBe(false)
    })

    test('a run that arms without a cancel callback still holds plain lines', () => {
        const f = fakeUiCtx('also add retries')
        armCancelListener(f.ctx) // a plain /task: no /task-auto ack to post
        beginRun()
        expect(f.send('\r')?.consume).toBe(true)
        expect(heldInput()).toEqual(['also add retries'])
    })

    // Without an ack callback the literal command is not special-cased; it is a
    // bridge command, so the generic dispatch runs it exactly like the browser.
    test('/task-auto-cancel falls through to bridge dispatch when no ack is wired', () => {
        const f = fakeUiCtx('/task-auto-cancel')
        let ran = false
        getBridge().commands.set('task-auto-cancel', () => {
            ran = true
        })
        armCancelListener(f.ctx)
        beginRun()
        expect(f.send('\r')?.consume).toBe(true)
        expect(ran).toBe(true)
    })

    test('a plain line is held for the next task turn, not queued by pi', () => {
        const f = fakeUiCtx('also add retries')
        armCancelListener(f.ctx, () => {})
        beginRun()
        expect(f.send('\r')?.consume).toBe(true)
        expect(heldInput()).toEqual(['also add retries'])
        expect(f.text()).toBe('') // editor cleared: nothing left to replay
    })

    test('a bridge slash command runs immediately, like it does from the browser', () => {
        const f = fakeUiCtx('/task-list')
        let ran = ''
        getBridge().commands.set('task-list', args => {
            ran = `list:${args}`
        })
        armCancelListener(f.ctx, () => {})
        beginRun()
        expect(f.send('\r')?.consume).toBe(true)
        expect(ran).toBe('list:')
        expect(heldInput()).toEqual([])
    })

    test('a pi builtin is left alone so /model still works', () => {
        const f = fakeUiCtx('/model')
        armCancelListener(f.ctx, () => {})
        beginRun()
        expect(f.send('\r')).toBeUndefined()
        expect(heldInput()).toEqual([])
        expect(f.text()).toBe('/model')
    })

    // The raw listener is called for keys an open dialog is also waiting on. So
    // when a dialog is up this Enter is the user's ANSWER, and swallowing it
    // would break clarify questions and the ESC-steer prompt.
    test('nothing is intercepted while a prompt dialog is open', () => {
        const f = fakeUiCtx('some answer')
        armCancelListener(f.ctx, () => {})
        beginRun()
        setPrompt({type: 'prompt', id: '1', question: 'which db?', allowSkip: true})
        expect(f.send('\r')).toBeUndefined()
        expect(heldInput()).toEqual([])
    })

    test('outside a run, pi handles input normally', () => {
        const f = fakeUiCtx('just chatting')
        armCancelListener(f.ctx, () => {})
        expect(f.send('\r')).toBeUndefined()
        expect(heldInput()).toEqual([])
    })

    test('while the agent streams, pi steers it — we stay out of the way', () => {
        const f = fakeUiCtx('use the other API')
        armCancelListener(f.ctx, () => {})
        beginRun()
        f.setIdle(false)
        expect(f.send('\r')).toBeUndefined()
        expect(heldInput()).toEqual([])
    })

    test('/task-auto-cancel still wins over every other rule', () => {
        const f = fakeUiCtx('/task-auto-cancel')
        let fired = 0
        armCancelListener(f.ctx, () => fired++)
        beginRun()
        setPrompt({type: 'prompt', id: '1', question: 'which db?', allowSkip: true})
        expect(f.send('\r')?.consume).toBe(true)
        expect(fired).toBe(1)
    })
})
