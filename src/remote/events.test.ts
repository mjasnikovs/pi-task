import {describe, it, expect, beforeEach} from 'bun:test'
import {setupEvents} from './events.js'
import {HistoryBuffer} from './history.js'

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
    getContextUsage: () => ({tokens: 5000, contextWindow: 100000, percent: 5})
}

describe('setupEvents', () => {
    let pi: ReturnType<typeof makePiMock>
    let history: HistoryBuffer
    const captured: unknown[] = []

    beforeEach(() => {
        pi = makePiMock()
        history = new HistoryBuffer()
        captured.length = 0
        setupEvents(pi as never, history, msg => captured.push(msg))
    })

    it('broadcasts agent_start on agent_start event', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        expect(captured).toContainEqual({type: 'agent_start'})
    })

    it('broadcasts agent_end with contextUsage on agent_end event', () => {
        pi.emit('agent_end', {type: 'agent_end'})
        expect(captured).toContainEqual({
            type: 'agent_end',
            contextUsage: {tokens: 5000, contextWindow: 100000, percent: 5}
        })
    })

    it('broadcasts text_delta for text_delta assistant events', () => {
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'text_delta', delta: 'hello'}
        })
        expect(captured).toContainEqual({type: 'text_delta', delta: 'hello'})
    })

    it('does not broadcast text_delta for non-text events', () => {
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

    it('broadcasts tool_end on tool_execution_end and saves to history', () => {
        pi.emit('agent_start', {type: 'agent_start'})
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
            isError: false
        })
    })

    it('saves user message to history and broadcasts user_message on input', () => {
        pi.emit('input', {type: 'input', text: 'do the thing', images: [], source: 'interactive'})
        expect(history.getEntries()).toContainEqual({role: 'user', text: 'do the thing', tools: []})
        expect(captured).toContainEqual({type: 'user_message', text: 'do the thing'})
    })

    it('broadcasts agent_error and records it in history on error events', () => {
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
        expect(history.getEntries()).toContainEqual({
            role: 'assistant',
            text: 'Connection error.',
            tools: [],
            error: true
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
        expect(history.getEntries()).toEqual([])
    })

    it('saves assistant turn to history on agent_end', () => {
        pi.emit('agent_start', {type: 'agent_start'})
        pi.emit('message_update', {
            type: 'message_update',
            message: {},
            assistantMessageEvent: {type: 'text_delta', delta: 'sure!'}
        })
        pi.emit('agent_end', {type: 'agent_end'})
        const entries = history.getEntries()
        expect(entries.find(e => e.role === 'assistant' && e.text === 'sure!')).toBeTruthy()
    })
})
