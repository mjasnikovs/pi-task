import {describe, it, expect, beforeEach} from 'bun:test'
import {setupEvents} from '../../src/remote/events.js'
import {getState, _setSink, reset, snapshot} from '../../src/remote/session-state.js'
import {getBridge} from '../../src/remote/bridge.js'

// Minimal mock ExtensionAPI
function makePiMock() {
    const handlers: Record<string, ((event: unknown, ctx: unknown) => void)[]> = {}
    return {
        on(event: string, handler: (e: unknown, ctx: unknown) => void) {
            handlers[event] ??= []
            handlers[event].push(handler)
        },
        emit(event: string, data: unknown, ctx: unknown = mockCtx) {
            for (const h of handlers[event] ?? []) h(data, ctx)
        }
    }
}

const mockCtx = {
    getContextUsage: () => ({tokens: 5000, contextWindow: 100000, percent: 5}),
    model: {name: 'Qwen3.6 27B'}
}

describe('setupEvents', () => {
    let pi: ReturnType<typeof makePiMock>
    let captured: unknown[] = []

    beforeEach(() => {
        reset()
        captured = []
        _setSink(msg => captured.push(msg))
        pi = makePiMock()
        setupEvents(pi as never)
    })

    it('broadcasts agent_start (with model) and opens a live turn', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        expect(captured).toContainEqual({type: 'agent_start', model: 'Qwen3.6 27B'})
        expect(getState().agentRunning).toBe(true)
    })

    it('broadcasts agent_end with contextUsage + model and stores them on the state', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('agent_end', {type: 'agent_end'})
        expect(captured).toContainEqual({
            type: 'agent_end',
            contextUsage: {tokens: 5000, contextWindow: 100000, percent: 5},
            model: 'Qwen3.6 27B'
        })
        expect(snapshot().context).toEqual({tokens: 5000, contextWindow: 100000, percent: 5})
        expect(snapshot().model).toBe('Qwen3.6 27B')
    })

    it('accumulates text_delta into the live turn', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'text_delta', delta: 'hello'}
        })
        expect(captured).toContainEqual({type: 'text_delta', delta: 'hello'})
        expect(getState().live?.parts).toContainEqual({kind: 'text', text: 'hello'})
    })

    it('forwards thinking_delta/thinking_end into a thinking part', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'thinking_delta', delta: 'reasoning…'}
        })
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'thinking_end', content: 'reasoning…'}
        })
        expect(captured).toContainEqual({type: 'thinking_delta', delta: 'reasoning…'})
        expect(captured).toContainEqual({type: 'thinking_end'})
        expect(getState().live?.parts).toContainEqual({
            kind: 'thinking',
            text: 'reasoning…',
            done: true
        })
    })

    it('does not emit text_delta for non-text events', () => {
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'input_json_delta', partial_json: '{}'}
        })
        expect(
            captured.find((m: unknown) => (m as {type?: string}).type === 'text_delta')
        ).toBeUndefined()
    })

    it('broadcasts text_end on message_end', () => {
        pi.emit('message_end', {type: 'message_end', message: {}})
        expect(captured).toContainEqual({type: 'text_end'})
    })

    it('broadcasts tool_start on tool_execution_start', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('tool_execution_start', {
            type: 'tool_execution_start',
            toolCallId: 'id1',
            toolName: 'bash',
            args: {command: 'ls'}
        })
        expect(captured).toContainEqual({
            type: 'tool_start',
            toolCallId: 'id1',
            toolName: 'bash',
            args: {command: 'ls'}
        })
    })

    it('broadcasts tool_end on tool_execution_end and records it on the live turn', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('tool_execution_start', {
            type: 'tool_execution_start',
            toolCallId: 'id1',
            toolName: 'bash',
            args: {command: 'ls'}
        })
        pi.emit('tool_execution_end', {
            type: 'tool_execution_end',
            toolCallId: 'id1',
            toolName: 'bash',
            result: 'output',
            isError: false
        })
        expect(captured).toContainEqual({
            type: 'tool_end',
            toolCallId: 'id1',
            toolName: 'bash',
            result: 'output',
            isError: false,
            elapsedMs: expect.any(Number)
        })
        expect(getState().live?.parts).toContainEqual({
            kind: 'tool',
            toolCallId: 'id1',
            toolName: 'bash',
            args: {command: 'ls'},
            result: 'output',
            isError: false,
            done: true,
            elapsedMs: expect.any(Number)
        })
    })

    it('records a user turn and broadcasts user_message on interactive input', () => {
        pi.emit('input', {type: 'input', text: 'do the thing', images: [], source: 'interactive'})
        expect(snapshot().turns).toContainEqual({
            role: 'user',
            text: 'do the thing',
            ts: expect.any(Number)
        })
        expect(captured).toContainEqual({type: 'user_message', text: 'do the thing'})
    })

    it('broadcasts agent_error and records it in the transcript on error events', () => {
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {
                type: 'error',
                reason: 'error',
                error: {errorMessage: 'Connection error.'}
            }
        })
        expect(captured).toContainEqual({type: 'agent_error', message: 'Connection error.'})
        expect(snapshot().turns).toContainEqual({
            role: 'assistant',
            text: 'Connection error.',
            error: true,
            ts: expect.any(Number)
        })
    })

    it('ignores silent aborts (aborted reason with no message)', () => {
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'error', reason: 'aborted', error: {}}
        })
        expect(
            captured.find((m: unknown) => (m as {type?: string}).type === 'agent_error')
        ).toBeUndefined()
        expect(snapshot().turns).toEqual([])
    })

    it('commits the assistant turn to the transcript on agent_end', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'text_delta', delta: 'sure!'}
        })
        pi.emit('agent_end', {type: 'agent_end'})
        const turns = snapshot().turns
        const assistant = turns.find(e => e.role === 'assistant')
        expect(assistant?.parts).toContainEqual({kind: 'text', text: 'sure!'})
    })

    it('mirrors context compaction to the remote (toast + persistent note)', () => {
        const b = getBridge()
        const prev = b.broadcast
        const toasts: unknown[] = []
        b.broadcast = msg => {
            toasts.push(msg)
        }
        try {
            pi.emit('session_before_compact', {type: 'session_before_compact'})
            pi.emit('session_compact', {type: 'session_compact'})
        } finally {
            b.broadcast = prev
        }
        // Attention toast on start. TRANSIENT: `notify` is only broadcast, never
        // written to the history, so it is gone after a reconnect.
        expect(toasts).toContainEqual({
            type: 'notify',
            message: 'Context full — compacting…',
            level: 'warning'
        })
        // Completion goes through `addSystemNote`, which does BOTH halves — a live
        // `system_note` delta for connected clients now…
        expect(captured).toContainEqual({type: 'system_note', text: 'Context compacted'})
        // …and a `history.addSystemNote` commit, so it survives a reconnect.
        expect(snapshot().turns).toContainEqual({
            role: 'system',
            text: 'Context compacted',
            ts: expect.any(Number)
        })
    })
})
