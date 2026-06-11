/**
 * Minimal fake ExtensionCommandContext for orchestrator tests.
 *
 * Captures notify/input/widget/editor/sendUserMessage calls into arrays so
 * tests can assert on them. Queue ui.input / ui.editor responses with
 * `queueInput(s)` / `queueEditor(s)`.
 *
 * Session replacement is modelled faithfully: ctx.newSession() marks the
 * current ctx stale (any later use throws, mirroring the real runtime's
 * teardownCurrent → invalidate) and hands a fresh ctx to its withSession
 * callback. Captured arrays and queued inputs are shared across every
 * generation so assertions still see all activity regardless of which ctx
 * produced it.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

export interface CapturedNotify {
    msg: string
    level: 'info' | 'warning' | 'error'
}

export interface CapturedWidget {
    key: string
    state: unknown
}

export interface FakeCtxHandle {
    ctx: ExtensionCommandContext
    cwd: string
    captured: {
        notifies: CapturedNotify[]
        inputs: Array<{title: string; default?: string}>
        widgets: CapturedWidget[]
        editorTexts: string[]
        editors: Array<{title: string; content: string}>
        sentMessages: Array<{spec: string; opts?: unknown}>
        /** Ordered log of sendUserMessage ('send') / waitForIdle ('idle') calls. */
        calls: string[]
    }
    queueInput: (value: string | undefined) => void
    queueEditor: (value: string | undefined) => void
}

// Matches the message the real extension runtime throws from a stale ctx.
const STALE_MSG =
    'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().'

export function makeFakeCtx(cwd: string): FakeCtxHandle {
    const inputQueue: Array<string | undefined> = []
    const editorQueue: Array<string | undefined> = []
    const captured: FakeCtxHandle['captured'] = {
        notifies: [],
        inputs: [],
        widgets: [],
        editorTexts: [],
        editors: [],
        sentMessages: [],
        calls: []
    }

    // Build a context handle bound to its own `stale` cell. newSession marks the
    // current handle stale before creating the replacement, so any code that
    // keeps using the pre-replacement ctx fails exactly like production.
    const makeCtx = (): ExtensionCommandContext => {
        const state = {stale: false}
        const guard =
            <A extends unknown[], R>(fn: (...a: A) => R) =>
            (...a: A): R => {
                if (state.stale) throw new Error(STALE_MSG)
                return fn(...a)
            }
        const ctx = {
            cwd,
            hasUI: true,
            ui: {
                theme: {
                    fg: (_role: string, text: string) => text,
                    bold: (text: string) => text,
                    italic: (text: string) => text
                },
                notify: guard((msg: string, level: 'info' | 'warning' | 'error') => {
                    captured.notifies.push({msg, level})
                }),
                input: guard(async (title: string, defaultValue?: string) => {
                    captured.inputs.push({title, default: defaultValue})
                    if (inputQueue.length === 0) return undefined
                    return inputQueue.shift()
                }),
                setWidget: guard((key: string, widgetState: unknown) => {
                    captured.widgets.push({key, state: widgetState})
                }),
                setEditorText: guard((s: string) => {
                    captured.editorTexts.push(s)
                }),
                editor: guard(async (title: string, content: string) => {
                    captured.editors.push({title, content})
                    if (editorQueue.length === 0) return undefined
                    return editorQueue.shift()
                })
            },
            waitForIdle: guard(async () => {
                captured.calls.push('idle')
            }),
            isIdle: guard(() => true),
            newSession: guard(
                async ({
                    withSession
                }: {
                    withSession: (ctx: ExtensionCommandContext) => Promise<unknown>
                }) => {
                    // teardownCurrent invalidates the current ctx before the
                    // replacement ctx is created and handed to withSession.
                    state.stale = true
                    const fresh = makeCtx()
                    await withSession(fresh)
                    return {cancelled: false}
                }
            ),
            sendUserMessage: guard(async (spec: string, opts?: unknown) => {
                captured.sentMessages.push({spec, opts})
                captured.calls.push('send')
            })
        } as unknown as ExtensionCommandContext
        return ctx
    }

    return {
        ctx: makeCtx(),
        cwd,
        captured,
        queueInput: (value: string | undefined) => {
            inputQueue.push(value)
        },
        queueEditor: (value: string | undefined) => {
            editorQueue.push(value)
        }
    }
}
