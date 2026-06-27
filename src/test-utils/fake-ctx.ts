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
        selects: Array<{title: string; options: string[]}>
        widgets: CapturedWidget[]
        editorTexts: string[]
        editors: Array<{title: string; content: string}>
        sentMessages: Array<{spec: string; opts?: unknown}>
        /** Ordered log of sendUserMessage ('send') / waitForIdle ('idle') calls. */
        calls: string[]
    }
    queueInput: (value: string | undefined) => void
    queueSelect: (value: string | undefined) => void
    queueEditor: (value: string | undefined) => void
    /**
     * Set the stopReason of the most recent assistant turn the fake session
     * reports via sessionManager.getEntries(). Use "aborted" to simulate the user
     * pressing ESC during an implementation wait, or "error" with an errorMessage
     * to simulate the model/provider dying mid-implementation (e.g. a context
     * overflow). Shared across session generations, like the captured arrays.
     */
    setStopReason: (reason: string | undefined, errorMessage?: string) => void
    /**
     * Script the session entries reported by sessionManager.getEntries() as a
     * sequence of snapshots, one per turn. Each waitForIdle() advances to the next
     * snapshot (clamped at the last), modelling a session whose branch evolves as
     * the implementation turn and its resumes complete: snapshot[0] is the state
     * after the first idle, snapshot[1] after the next, and so on. Use this to
     * exercise compaction-boundary handling (a snapshot ending in a `compaction`
     * entry → the turn parked at a compaction; one ending in an assistant `stop` →
     * genuine completion). Takes precedence over setStopReason while set.
     */
    setIdleEntries: (snapshots: unknown[][]) => void
}

/** Build a fake assistant message entry with the given stopReason. */
export function assistantEntry(stopReason: string, errorMessage?: string): unknown {
    return {type: 'message', message: {role: 'assistant', stopReason, errorMessage}}
}

/** Build a fake compaction-boundary entry (the runtime appends one at the branch
 *  tail after a context compaction). */
export function compactionEntry(): unknown {
    return {type: 'compaction', summary: 'compacted'}
}

// Matches the message the real extension runtime throws from a stale ctx.
const STALE_MSG =
    'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().'

export function makeFakeCtx(cwd: string): FakeCtxHandle {
    const inputQueue: Array<string | undefined> = []
    const selectQueue: Array<string | undefined> = []
    const editorQueue: Array<string | undefined> = []
    // The stopReason runSingleTask reads after waitForIdle to detect a user ESC.
    // Shared across generations so the value survives session replacement.
    let lastStopReason: string | undefined
    let lastErrorMessage: string | undefined
    // Scripted entries-per-turn (see setIdleEntries). Shared across generations,
    // like lastStopReason. idleCount advances on each waitForIdle so getEntries
    // returns the snapshot for the most recently settled turn.
    let idleEntries: unknown[][] | null = null
    let idleCount = 0
    const captured: FakeCtxHandle['captured'] = {
        notifies: [],
        inputs: [],
        selects: [],
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
                select: guard(async (title: string, options: string[]) => {
                    captured.selects.push({title, options})
                    if (selectQueue.length === 0) return undefined
                    return selectQueue.shift()
                }),
                // The boxed clarify/grill picker (askQuestionBox) goes through
                // ui.custom. Build the real component, capture its header + card
                // labels into `selects`, and drive it to the queued choice: the
                // queued value is the LABEL of the card to pick (the manual
                // "type a different answer" card then falls through to ui.input),
                // or undefined to cancel.
                custom: guard(
                    async <T>(
                        factory: (
                            tui: unknown,
                            theme: unknown,
                            kb: unknown,
                            done: (r: T) => void
                        ) => {
                            cardLabels: string[]
                            headerText: string
                            handleInput: (d: string) => void
                        }
                    ): Promise<T> => {
                        let resolved: T = undefined as T
                        const comp = factory({}, {}, {}, r => {
                            resolved = r
                        })
                        captured.selects.push({
                            title: comp.headerText,
                            options: comp.cardLabels
                        })
                        const want = selectQueue.length === 0 ? undefined : selectQueue.shift()
                        const idx = want === undefined ? -1 : comp.cardLabels.indexOf(want)
                        if (idx < 0) {
                            comp.handleInput('\x1b') // cancel
                            return resolved
                        }
                        for (let i = 0; i < idx; i++) comp.handleInput('\x1b[B')
                        comp.handleInput('\r')
                        return resolved
                    }
                ),
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
                idleCount++
            }),
            isIdle: guard(() => true),
            sessionManager: {
                getEntries: guard(() => {
                    if (idleEntries) {
                        const i = Math.min(Math.max(idleCount - 1, 0), idleEntries.length - 1)
                        return idleEntries[i]
                    }
                    return lastStopReason === undefined ?
                            []
                        :   [
                                {
                                    type: 'message',
                                    message: {
                                        role: 'assistant',
                                        stopReason: lastStopReason,
                                        errorMessage: lastErrorMessage
                                    }
                                }
                            ]
                })
            },
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
        queueSelect: (value: string | undefined) => {
            selectQueue.push(value)
        },
        queueEditor: (value: string | undefined) => {
            editorQueue.push(value)
        },
        setStopReason: (reason: string | undefined, errorMessage?: string) => {
            lastStopReason = reason
            lastErrorMessage = errorMessage
        },
        setIdleEntries: (snapshots: unknown[][]) => {
            idleEntries = snapshots
            idleCount = 0
        }
    }
}
