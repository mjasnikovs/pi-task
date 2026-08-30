/**
 * A stale ctx must not crash the widget.
 *
 * After a /reload or a session replacement the captured ctx is stale: any access
 * to `ctx.ui` throws the runtime's "stale after session replacement or reload"
 * error. `render` runs from `setInterval`, so a throw there is an
 * uncaughtException rather than a caught UI error — it takes the whole pi process
 * down. So EVERY `ctx.ui` read on a render path sits inside the try/catch, the
 * theme read that feeds buildWidgetLines included, and the catch latches a stale
 * flag and clears the timer rather than swallowing the same throw each tick.
 *
 * Three sites, one per call: startWidget, startAutoLoader, flashTerminalWidget.
 * A fourth test covers a ctx that goes stale AFTER the timer is installed.
 */

import {afterEach, describe, expect, test} from 'bun:test'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {
    startWidget,
    startAutoLoader,
    flashTerminalWidget,
    WIDGET_REFRESH_MS,
    type WidgetState,
    type AutoLoaderState
} from '../../src/task/widget.js'

/** The message the real extension runtime throws from a stale ctx
 *  (mirrors STALE_MSG in ../test-utils/fake-ctx.ts). */
const STALE_MSG =
    'This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().'

/**
 * A stale ctx: `hasUI` is still true (so the widget starters do NOT early-return
 * the no-op disposer) but the `ui` access itself throws, exactly like a real
 * ctx invalidated after session replacement or /reload.
 */
function staleCtx(): ExtensionCommandContext {
    return {
        hasUI: true,
        get ui(): never {
            throw new Error(STALE_MSG)
        }
    } as unknown as ExtensionCommandContext
}

/**
 * A ctx that is healthy for the first `liveAccesses` reads of `.ui` and stale
 * after that — a reload landing while the render timer is already running.
 * The healthy `ui` is the minimum the render path touches: a theme whose `fg`
 * is identity, and a no-op setWidget.
 */
function goesStaleCtx(liveAccesses: number): ExtensionCommandContext {
    let seen = 0
    const liveUi = {
        theme: {fg: (_role: string, text: string) => text},
        setWidget: () => {}
    }
    return {
        hasUI: true,
        get ui() {
            seen += 1
            if (seen > liveAccesses) throw new Error(STALE_MSG)
            return liveUi
        }
    } as unknown as ExtensionCommandContext
}

// Non-null state on purpose: a null state makes
// `s ? buildWidgetLines(s, ctx.ui.theme) : undefined` short-circuit and skip the
// theme read entirely, so a stale ctx is only touched while the widget has
// something to render.
const widgetState: WidgetState = {
    taskId: 'TASK_0015',
    title: 'demo',
    phase: 'grill',
    startedAt: 0
}

const autoState: AutoLoaderState = {
    title: 'demo',
    step: 'clarify',
    stepNum: 1,
    stepTotal: 3,
    startedAt: 0
}

describe('issue #15: a stale ctx must not crash the widget', () => {
    const disposers: Array<() => void> = []
    afterEach(() => {
        while (disposers.length > 0) {
            const dispose = disposers.pop()
            try {
                dispose?.()
            } catch {
                /* a broken disposer is its own assertion below, not cleanup noise */
            }
        }
    })

    test('startWidget survives a stale ctx (the theme read must be guarded)', () => {
        expect(() => disposers.push(startWidget(staleCtx(), () => widgetState))).not.toThrow()
    })

    test('startAutoLoader survives a stale ctx (the theme read must be guarded)', () => {
        expect(() => disposers.push(startAutoLoader(staleCtx(), () => autoState))).not.toThrow()
    })

    test('flashTerminalWidget survives a stale ctx (the theme read must be guarded)', () => {
        expect(() => flashTerminalWidget(staleCtx(), 'failed', 'TASK_0015', 'boom')).not.toThrow()
    })

    test('a ctx that goes stale mid-run stops the timer instead of throwing every tick', async () => {
        // One live `.ui` access: the theme read in the first synchronous render.
        // Every access after it throws, so the setWidget in that same render is
        // already stale and the render loop must latch and stop.
        const thrown: unknown[] = []
        const onUncaught = (err: unknown) => thrown.push(err)
        process.on('uncaughtException', onUncaught)
        try {
            disposers.push(startWidget(goesStaleCtx(1), () => widgetState))
            await new Promise(resolve => setTimeout(resolve, WIDGET_REFRESH_MS * 3))
        } finally {
            process.off('uncaughtException', onUncaught)
        }
        expect(thrown).toEqual([])
    })
})
