import {describe, it, expect, beforeEach} from 'bun:test'
import {
    getState,
    _setSink,
    agentStart,
    appendText,
    textEnd,
    appendThinking,
    thinkingEnd,
    startTool,
    endTool,
    agentEnd,
    addUserTurn,
    addError,
    setTaskWidget,
    setPrompt,
    clearPrompt,
    setContext,
    reset,
    snapshot
} from './session-state.js'
import type {PromptMessage} from './protocol.js'

let captured: unknown[] = []

beforeEach(() => {
    reset() // also broadcasts a reset into the (old) sink; fine
    captured = []
    _setSink(msg => captured.push(msg))
})

describe('session-state mutators', () => {
    it('agentStart opens a live turn and broadcasts agent_start', () => {
        agentStart()
        expect(getState().live).toEqual({parts: [], textOpen: false})
        expect(getState().agentRunning).toBe(true)
        expect(captured).toContainEqual({type: 'agent_start'})
    })

    it('appendText accumulates into the open text part and broadcasts the delta', () => {
        agentStart()
        appendText('he')
        appendText('llo')
        expect(getState().live?.parts).toEqual([{kind: 'text', text: 'hello'}])
        expect(captured).toContainEqual({type: 'text_delta', delta: 'llo'})
    })

    it('endTool fills the tool part in place, preserving order and args', () => {
        agentStart()
        appendText('let me check')
        startTool('t1', 'bash', {command: 'ls'})
        // The tool part sits AFTER the text part, in order, still running.
        expect(getState().live?.parts).toEqual([
            {kind: 'text', text: 'let me check'},
            {
                kind: 'tool',
                toolCallId: 't1',
                toolName: 'bash',
                args: {command: 'ls'},
                result: undefined,
                isError: false,
                done: false
            }
        ])
        endTool('t1', 'bash', 'output', false)
        // Same part, now completed — args captured at start survive, no reordering.
        expect(getState().live?.parts[1]).toEqual({
            kind: 'tool',
            toolCallId: 't1',
            toolName: 'bash',
            args: {command: 'ls'},
            result: 'output',
            isError: false,
            done: true,
            elapsedMs: expect.any(Number)
        })
        expect(captured).toContainEqual({
            type: 'tool_end',
            toolCallId: 't1',
            toolName: 'bash',
            result: 'output',
            isError: false,
            elapsedMs: expect.any(Number)
        })
    })

    it('appendThinking accumulates a thinking part and broadcasts the delta', () => {
        agentStart()
        appendThinking('let me ')
        appendThinking('reason')
        expect(getState().live?.parts).toEqual([
            {kind: 'thinking', text: 'let me reason', done: false}
        ])
        expect(captured).toContainEqual({type: 'thinking_delta', delta: 'reason'})
    })

    it('thinkingEnd closes the thinking part; following text starts a fresh bubble', () => {
        agentStart()
        appendThinking('hmm')
        thinkingEnd()
        appendText('here is the answer')
        expect(getState().live?.parts).toEqual([
            {kind: 'thinking', text: 'hmm', done: true},
            {kind: 'text', text: 'here is the answer'}
        ])
        expect(captured).toContainEqual({type: 'thinking_end'})
    })

    it('keeps text segments separate across a text_end / tool boundary', () => {
        agentStart()
        appendText('first')
        textEnd()
        appendText('second') // new segment, not merged into "first"
        const parts = getState().live?.parts ?? []
        expect(parts).toEqual([
            {kind: 'text', text: 'first'},
            {kind: 'text', text: 'second'}
        ])
    })

    it('setTaskWidget([]) clears the slot to null', () => {
        setTaskWidget(['line'])
        expect(getState().taskWidget).toEqual(['line'])
        setTaskWidget([])
        expect(getState().taskWidget).toBeNull()
        expect(captured).toContainEqual({type: 'widget', lines: null})
    })

    it('setPrompt / clearPrompt track the active prompt', () => {
        const p: PromptMessage = {type: 'prompt', id: '1', question: 'Q?', allowSkip: false}
        setPrompt(p)
        expect(getState().prompt).toEqual(p)
        clearPrompt('1')
        expect(getState().prompt).toBeNull()
        expect(captured).toContainEqual({type: 'prompt_resolved', id: '1'})
    })
})

describe('snapshot()', () => {
    it('commits a full turn and clears live by agent_end', () => {
        agentStart()
        appendText('sure')
        startTool('t1', 'bash', {command: 'ls'})
        endTool('t1', 'bash', 'ok', false)
        agentEnd({tokens: 100, contextWindow: 1000, percent: 10})

        const snap = snapshot()
        expect(snap.live).toBeNull()
        expect(snap.agentRunning).toBe(false)
        expect(snap.context).toEqual({tokens: 100, contextWindow: 1000, percent: 10})
        const last = snap.turns[snap.turns.length - 1]
        expect(last.role).toBe('assistant')
        // Ordered parts: text, then the tool, in sequence — not a merged blob.
        expect(last.parts).toEqual([
            {kind: 'text', text: 'sure'},
            {
                kind: 'tool',
                toolCallId: 't1',
                toolName: 'bash',
                args: {command: 'ls'},
                result: 'ok',
                isError: false,
                done: true,
                elapsedMs: expect.any(Number)
            }
        ])
    })

    it('reflects an in-progress turn so a mid-stream joiner sees partial state', () => {
        agentStart()
        appendText('thinking...')
        startTool('t2', 'read', {path: 'x'})
        const snap = snapshot()
        expect(snap.agentRunning).toBe(true)
        expect(snap.live?.parts[0]).toEqual({kind: 'text', text: 'thinking...'})
        const toolPart = snap.live?.parts[1]
        expect(toolPart?.kind).toBe('tool')
        expect((toolPart as {done: boolean}).done).toBe(false)
    })

    it('carries the user transcript and an error turn', () => {
        addUserTurn('do it')
        addError('boom')
        const snap = snapshot()
        expect(snap.turns).toContainEqual({role: 'user', text: 'do it'})
        expect(snap.turns).toContainEqual({
            role: 'assistant',
            text: 'boom',
            error: true
        })
    })

    it('reset() empties the snapshot', () => {
        agentStart()
        appendText('x')
        setTaskWidget(['w'])
        setContext({tokens: 1, contextWindow: 2, percent: 50})
        reset()
        const snap = snapshot()
        expect(snap.turns).toEqual([])
        expect(snap.live).toBeNull()
        expect(snap.taskWidget).toBeNull()
        expect(snap.prompt).toBeNull()
        expect(snap.context).toBeNull()
        expect(snap.agentRunning).toBe(false)
    })
})
