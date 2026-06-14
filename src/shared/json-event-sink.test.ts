import {test, expect, describe} from 'bun:test'
import {
    JsonEventSink,
    type RunChildJsonEventsOptions,
    type ContextSnapshot,
    type ToolCall,
    type LoopHit
} from './child-process.js'

const noop = () => {}
const line = (o: unknown) => JSON.stringify(o) + '\n'

function sink(opts: Partial<RunChildJsonEventsOptions> = {}, onLoopKill = noop): JsonEventSink {
    return new JsonEventSink({mode: 'json-events', ...opts}, onLoopKill)
}

describe('JsonEventSink', () => {
    test('extracts assistant text from agent_end', () => {
        const s = sink()
        s.feed(
            line({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'hello world'}]}]
            })
        )
        expect(s.text).toBe('hello world')
    })

    test('accumulates text_delta when there is no agent_end', () => {
        const s = sink()
        s.feed(line({type: 'message_update', assistantMessageEvent: {type: 'text_start'}}))
        s.feed(
            line({
                type: 'message_update',
                assistantMessageEvent: {type: 'text_delta', delta: 'foo'}
            })
        )
        s.feed(
            line({
                type: 'message_update',
                assistantMessageEvent: {type: 'text_delta', delta: 'bar'}
            })
        )
        expect(s.text).toBe('foobar')
    })

    test('agent_end text wins over accumulated deltas', () => {
        const s = sink()
        s.feed(
            line({
                type: 'message_update',
                assistantMessageEvent: {type: 'text_delta', delta: 'partial'}
            })
        )
        s.feed(
            line({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'final'}]}]
            })
        )
        expect(s.text).toBe('final')
    })

    test('reports context usage from context_usage events', () => {
        const seen: ContextSnapshot[] = []
        const s = sink({onContextUsage: snap => seen.push(snap)})
        s.feed(line({type: 'context_usage', tokens: 120, contextWindow: 1000, percent: 12}))
        expect(seen).toEqual([{tokens: 120, contextWindow: 1000, percent: 12}])
    })

    test('sums token usage from an assistant message_end', () => {
        const seen: ContextSnapshot[] = []
        const s = sink({onContextUsage: snap => seen.push(snap)})
        s.feed(
            line({
                type: 'message_end',
                message: {
                    role: 'assistant',
                    usage: {input: 10, cacheRead: 5, cacheWrite: 0, output: 7}
                }
            })
        )
        expect(seen).toEqual([{tokens: 22, contextWindow: 0, percent: 0}])
    })

    test('emits onLine for tool calls with summarized args', () => {
        const lines: string[] = []
        const s = sink({onLine: l => lines.push(l)})
        s.feed(line({type: 'tool_execution_start', toolName: 'bash', args: {command: 'ls -la'}}))
        s.feed(line({type: 'message_update', assistantMessageEvent: {type: 'thinking_start'}}))
        expect(lines).toEqual(['bash: ls -la', 'thinking…'])
    })

    test('calls onLoopKill when onToolCall reports a hit', () => {
        let killed = 0
        const hit: LoopHit = {call: {name: 'read', args: {}}, count: 5, windowSize: 20}
        const onToolCall = (_c: ToolCall): LoopHit | null => hit
        const s = sink({onToolCall}, () => killed++)
        s.feed(line({type: 'tool_execution_start', toolName: 'read', args: {file_path: 'x.ts'}}))
        expect(killed).toBe(1)
    })

    test('does not kill when onToolCall returns null', () => {
        let killed = 0
        const s = sink({onToolCall: () => null}, () => killed++)
        s.feed(line({type: 'tool_execution_start', toolName: 'read', args: {}}))
        expect(killed).toBe(0)
    })

    test('parses an event split across two feeds', () => {
        const s = sink()
        const raw = line({
            type: 'agent_end',
            messages: [{role: 'assistant', content: [{type: 'text', text: 'spanning'}]}]
        })
        const mid = Math.floor(raw.length / 2)
        s.feed(raw.slice(0, mid))
        expect(s.text).toBe('') // not yet terminated
        s.feed(raw.slice(mid))
        expect(s.text).toBe('spanning')
    })

    test('flush parses a trailing line with no newline', () => {
        const s = sink()
        // No trailing newline — only flush() should complete it.
        s.feed(
            JSON.stringify({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'tail'}]}]
            })
        )
        expect(s.text).toBe('')
        s.flush()
        expect(s.text).toBe('tail')
    })

    test('ignores non-JSON lines (startup banners etc.)', () => {
        const s = sink()
        s.feed('not json at all\n')
        s.feed(
            line({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'ok'}]}]
            })
        )
        expect(s.text).toBe('ok')
    })
})
