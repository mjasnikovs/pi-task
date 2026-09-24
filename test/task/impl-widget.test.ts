import {afterEach, describe, expect, test} from 'bun:test'
import {armImplWidget, disarmImplWidget, setupImplWidget} from '../../src/task/impl-widget.js'
import {WIDGET_REFRESH_MS} from '../../src/task/widget.js'
import {getState, _setSink, reset} from '../../src/remote/session-state.js'

type Handler = (event: unknown, ctx: unknown) => void

/** Collect the lifecycle handlers setupImplWidget registers, keyed by event. */
function fakePi(): {handlers: Map<string, Handler>} {
    const handlers = new Map<string, Handler>()
    const pi = {
        on(event: string, handler: Handler) {
            handlers.set(event, handler)
        }
    }
    setupImplWidget(pi as never)
    return {handlers}
}

/** A ctx whose setWidget calls land in `widgets`, with a fixed context usage. */
function fakeCtx(usage: {tokens: number | null; contextWindow: number; percent: number | null}) {
    const widgets: Array<string[] | undefined> = []
    const ctx = {
        getContextUsage: () => usage,
        ui: {
            theme: {fg: (_: string, s: string) => s},
            setWidget: (_key: string, content: string[] | undefined) => widgets.push(content)
        }
    }
    return {ctx, widgets}
}

afterEach(() => {
    disarmImplWidget()
    reset()
})

describe('impl-widget controller', () => {
    test('agent_start renders the impl block with the host context bar', () => {
        reset()
        const sent: unknown[] = []
        _setSink(msg => sent.push(msg))
        const {handlers} = fakePi()
        const {ctx, widgets} = fakeCtx({tokens: 48_000, contextWindow: 200_000, percent: 24})

        armImplWidget({taskId: 'TASK_0007', title: 'Add dark mode'})
        handlers.get('agent_start')!({}, ctx)

        const last = widgets.at(-1)!
        expect(last[0]).toBe('TASK_0007 · Add dark mode')
        expect(last[1]).toContain('implementing · ')
        expect(last[1]).toContain('48k/200k')
        // render() also calls setTaskWidget, so the remote slot carries it too.
        expect(getState().taskWidget).not.toBeNull()
    })

    test('tool_execution_start feeds the ↳ trailer on the next render tick', async () => {
        const {handlers} = fakePi()
        const {ctx, widgets} = fakeCtx({tokens: 1, contextWindow: 200_000, percent: 0})

        armImplWidget({taskId: 'TASK_0007', title: 'demo'})
        handlers.get('agent_start')!({}, ctx) // startTimer renders once immediately
        expect(widgets.at(-1)).toHaveLength(2)
        handlers.get('tool_execution_start')!(
            {toolName: 'read', args: {path: 'src/index.ts'}, toolCallId: 'x'},
            ctx
        )
        // tool_execution_start only assigns lastLine; the setInterval render is what
        // paints it, so the trailer cannot appear before one refresh has elapsed.
        await new Promise(r => setTimeout(r, WIDGET_REFRESH_MS + 50))
        expect(widgets.at(-1)).toContain('↳ read src/index.ts')
    })

    test('agent_end hides but stays armed, so a retry or recovery turn re-shows it', () => {
        const {handlers} = fakePi()
        const {ctx, widgets} = fakeCtx({tokens: 1, contextWindow: 200_000, percent: 0})

        armImplWidget({taskId: 'TASK_0007', title: 'demo'})
        handlers.get('agent_start')!({}, ctx)
        handlers.get('agent_end')!({}, ctx)
        expect(widgets.at(-1)).toBeUndefined()

        // agent_end left the slot armed, so a second agent_start renders again.
        widgets.length = 0
        handlers.get('agent_start')!({}, ctx)
        expect(widgets.at(-1)).toBeDefined()

        // Only the bracket's disarm tears it down for good.
        disarmImplWidget()
        widgets.length = 0
        handlers.get('agent_start')!({}, ctx)
        expect(widgets).toHaveLength(0)
    })

    test('unknown token count (post-compaction) omits the context bar', () => {
        const {handlers} = fakePi()
        const {ctx, widgets} = fakeCtx({tokens: null, contextWindow: 200_000, percent: null})

        armImplWidget({taskId: 'TASK_0007', title: 'demo'})
        handlers.get('agent_start')!({}, ctx)

        const last = widgets.at(-1)!
        expect(last[1]).toContain('implementing · ')
        expect(last[1]).not.toContain('200k')
    })

    test('a stray turn with nothing armed renders nothing', () => {
        const {handlers} = fakePi()
        const {ctx, widgets} = fakeCtx({tokens: 1, contextWindow: 200_000, percent: 0})
        handlers.get('agent_start')!({}, ctx)
        expect(widgets).toHaveLength(0)
    })
})
