import {describe, it, expect, beforeEach} from 'bun:test'
import {
    getState,
    _setSink,
    agentStart,
    appendText,
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
        expect(getState().live).toEqual({text: '', tools: [], activeTools: []})
        expect(getState().agentRunning).toBe(true)
        expect(captured).toContainEqual({type: 'agent_start'})
    })

    it('appendText accumulates into live.text and broadcasts the delta', () => {
        agentStart()
        appendText('he')
        appendText('llo')
        expect(getState().live?.text).toBe('hello')
        expect(captured).toContainEqual({type: 'text_delta', delta: 'llo'})
    })

    it('endTool moves an active tool into completed tools', () => {
        agentStart()
        startTool('t1', 'bash', {command: 'ls'})
        expect(getState().live?.activeTools).toHaveLength(1)
        endTool('t1', 'bash', 'output', false)
        expect(getState().live?.activeTools).toHaveLength(0)
        expect(getState().live?.tools).toContainEqual({
            toolName: 'bash',
            args: undefined,
            result: 'output',
            isError: false
        })
        expect(captured).toContainEqual({
            type: 'tool_end',
            toolCallId: 't1',
            toolName: 'bash',
            result: 'output',
            isError: false
        })
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
        expect(last.text).toBe('sure')
        expect(last.tools).toHaveLength(1)
    })

    it('reflects an in-progress turn so a mid-stream joiner sees partial state', () => {
        agentStart()
        appendText('thinking...')
        startTool('t2', 'read', {path: 'x'})
        const snap = snapshot()
        expect(snap.agentRunning).toBe(true)
        expect(snap.live?.text).toBe('thinking...')
        expect(snap.live?.activeTools).toHaveLength(1)
    })

    it('carries the user transcript and an error turn', () => {
        addUserTurn('do it')
        addError('boom')
        const snap = snapshot()
        expect(snap.turns).toContainEqual({role: 'user', text: 'do it', tools: []})
        expect(snap.turns).toContainEqual({
            role: 'assistant',
            text: 'boom',
            tools: [],
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
