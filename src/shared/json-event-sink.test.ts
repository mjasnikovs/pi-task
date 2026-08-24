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

    test('captures modelError from a stopReason "error" agent_end with empty text', () => {
        // pi's handleRunFailure emits the failure as an agent_end whose assistant
        // message has empty text + stopReason "error" + errorMessage. The sink must
        // surface the cause so callers report it instead of "produced no output".
        const s = sink()
        s.feed(
            line({
                type: 'agent_end',
                messages: [
                    {
                        role: 'assistant',
                        content: [{type: 'text', text: ''}],
                        stopReason: 'error',
                        errorMessage: 'other side closed'
                    }
                ]
            })
        )
        expect(s.text).toBe('')
        expect(s.modelError).toBe('other side closed')
    })

    test('clears modelError when a LATER agent_end answers (pi retried past a blip)', () => {
        // Measured live (flaky proxy dropping the first connection): pi retries a
        // failed turn itself and emits agent_end(error) → auto_retry_start →
        // agent_end(text). Latching the first one reports a failure for a run that
        // actually succeeded — which is how one dropped fetch used to fail a phase
        // that had a perfectly good answer in hand.
        const s = sink()
        s.feed(
            line({
                type: 'agent_end',
                messages: [
                    {
                        role: 'assistant',
                        content: [],
                        stopReason: 'error',
                        errorMessage: 'Connection error.'
                    }
                ]
            })
        )
        expect(s.modelError).toBe('Connection error.')
        s.feed(line({type: 'auto_retry_start'}))
        s.feed(
            line({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'OK'}]}]
            })
        )
        expect(s.text).toBe('OK')
        expect(s.modelError).toBeUndefined()
    })

    test('keeps modelError when the failure comes AFTER the answering turn', () => {
        // The opposite order is a real partial failure: the child answered, then a
        // later turn died. The text on hand is a truncated run, so the cause must
        // survive and the caller must still treat it as failed.
        const s = sink()
        s.feed(
            line({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'partial'}]}]
            })
        )
        s.feed(
            line({
                type: 'agent_end',
                messages: [
                    {role: 'assistant', content: [{type: 'text', text: 'partial'}]},
                    {
                        role: 'assistant',
                        content: [],
                        stopReason: 'error',
                        errorMessage: 'socket hang up'
                    }
                ]
            })
        )
        expect(s.text).toBe('partial')
        expect(s.modelError).toBe('socket hang up')
    })

    test('leaves modelError undefined on a normal successful agent_end', () => {
        const s = sink()
        s.feed(
            line({
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'done'}]}]
            })
        )
        expect(s.modelError).toBeUndefined()
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

    // ─── Context usage (GitHub issue #16) ────────────────────────────────────
    //
    // `context_usage` is NOT, and never was, a pi event. Verified against the
    // published tarballs: zero occurrences of the string in
    // @earendil-works/pi-coding-agent AND @earendil-works/pi-agent-core at BOTH
    // 0.80.2 (the devDependency this handler was written against) and 0.84.2.
    // pi's own docs/json.md prints the whole wire union — session, agent_*,
    // turn_*, message_*, tool_execution_*, queue_update, compaction_*,
    // auto_retry_* — and none of its members carries a context window; the
    // session header is {type,version,id,timestamp,cwd,parentSession}, and
    // `contextUsage` exists only as the IN-PROCESS `ctx.getContextUsage()`
    // extension API, which a `--mode json` child never speaks to its parent.
    //
    // So the branch that read `context_usage` was unreachable from the day it
    // was written, and that is what hid the real defect: the ONLY live path
    // (`message_end`) reported `contextWindow: 0`, which left
    // StallDetector.churnTripped() permanently disabled and the widget's gauge
    // reliant on a downstream substitution.
    test('ignores a phantom context_usage event — no pi version has ever emitted one', () => {
        const seen: ContextSnapshot[] = []
        const s = sink({contextWindow: 1000, onContextUsage: snap => seen.push(snap)})
        s.feed(line({type: 'context_usage', tokens: 120, contextWindow: 999, percent: 12}))
        expect(seen).toEqual([])
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

    test('message_end carries the caller-supplied context window and a derived percent', () => {
        const seen: ContextSnapshot[] = []
        const s = sink({contextWindow: 1000, onContextUsage: snap => seen.push(snap)})
        s.feed(
            line({
                type: 'message_end',
                message: {
                    role: 'assistant',
                    usage: {input: 100, cacheRead: 40, cacheWrite: 10, output: 50}
                }
            })
        )
        expect(seen).toEqual([{tokens: 200, contextWindow: 1000, percent: 20}])
    })

    test('percent is capped at 100 when reported tokens exceed the window', () => {
        const seen: ContextSnapshot[] = []
        const s = sink({contextWindow: 100, onContextUsage: snap => seen.push(snap)})
        s.feed(
            line({
                type: 'message_end',
                message: {role: 'assistant', usage: {input: 500, output: 0}}
            })
        )
        expect(seen).toEqual([{tokens: 500, contextWindow: 100, percent: 100}])
    })

    // The exact event sequence pi 0.84.2 puts on stdout for one tool-free turn
    // (docs/json.md "Output Format"). No `context_usage` anywhere in it — this is
    // the whole point: the readout must come out of THIS stream, not a phantom.
    test('a real pi 0.84.2 turn yields a windowed snapshot with no context_usage event', () => {
        const seen: ContextSnapshot[] = []
        const s = sink({contextWindow: 250_000, onContextUsage: snap => seen.push(snap)})
        for (const evt of [
            {type: 'session', version: 3, id: 'uuid', timestamp: 'ts', cwd: '/repo'},
            {type: 'agent_start'},
            {type: 'turn_start'},
            {type: 'message_start', message: {role: 'assistant', content: []}},
            {
                type: 'message_update',
                usage: {input: 4900, output: 22},
                assistantMessageEvent: {type: 'text_delta', contentIndex: 0, delta: 'hi'}
            },
            {
                type: 'message_end',
                message: {
                    role: 'assistant',
                    usage: {input: 4900, cacheRead: 0, cacheWrite: 0, output: 22}
                }
            },
            {type: 'turn_end', message: {role: 'assistant'}, toolResults: []},
            {
                type: 'agent_end',
                messages: [{role: 'assistant', content: [{type: 'text', text: 'hi'}]}]
            },
            {type: 'agent_settled'}
        ]) {
            s.feed(line(evt))
        }
        expect(seen).toEqual([
            {tokens: 4922, contextWindow: 250_000, percent: (4922 / 250_000) * 100}
        ])
        expect(s.text).toBe('hi')
    })

    test('emits onLine for tool calls with summarized args', () => {
        const lines: string[] = []
        const s = sink({onLine: l => lines.push(l)})
        s.feed(line({type: 'tool_execution_start', toolName: 'bash', args: {command: 'ls -la'}}))
        s.feed(line({type: 'message_update', assistantMessageEvent: {type: 'thinking_start'}}))
        expect(lines).toEqual(['bash: ls -la', 'thinking…'])
    })

    // mx5 run 10 item 6: the tool RESULT must reach the caller so the gate log can
    // record what a `bash`/`curl` actually returned (the real tool_execution_end shape).
    test('emits onToolResult on tool_execution_end with the combined output and isError', () => {
        const results: Array<{name: string; isError: boolean; text: string}> = []
        const s = sink({onToolResult: r => results.push(r)})
        s.feed(
            line({
                type: 'tool_execution_end',
                toolName: 'bash',
                result: {content: [{type: 'text', text: 'HELLO_WORLD_123\n'}]},
                isError: false
            })
        )
        s.feed(
            line({
                type: 'tool_execution_end',
                toolName: 'bash',
                result: {
                    content: [
                        {type: 'text', text: 'curl: (7) Failed to connect to localhost port 3000'}
                    ]
                },
                isError: true
            })
        )
        expect(results).toEqual([
            {name: 'bash', isError: false, text: 'HELLO_WORLD_123\n'},
            {
                name: 'bash',
                isError: true,
                text: 'curl: (7) Failed to connect to localhost port 3000'
            }
        ])
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
