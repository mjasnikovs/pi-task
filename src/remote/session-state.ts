// The single authoritative mirror of what a connected browser should be showing.
//
// Every change funnels through a mutator that (1) updates this object and (2)
// broadcasts the matching live delta. On (re)connect the server serializes the
// whole object with snapshot() and the client replaces its entire view. Because
// the snapshot and the live deltas read/write the same object, they can never
// disagree — which is what kills the duplicate-transcript / orphaned-widget /
// two-task-widget drift the ad-hoc broadcasting used to cause.
//
// State lives on globalThis so it survives jiti module re-evaluation on session
// switches, the same pattern broadcast.ts and bridge.ts use.

import {broadcast as wsBroadcast} from './broadcast.js'
import {HistoryBuffer} from './history.js'
import type {Turn, ToolSummary} from './history.js'
import type {ContextUsage, PromptMessage} from './protocol.js'

export interface ActiveTool {
    toolCallId: string
    toolName: string
    args: unknown
}

export interface LiveTurn {
    /** Streamed assistant text so far this turn. */
    text: string
    /** Tools that have finished this turn. */
    tools: ToolSummary[]
    /** Tools still in flight, in start order. */
    activeTools: ActiveTool[]
}

export interface SnapshotMessage {
    type: 'snapshot'
    turns: Turn[]
    live: LiveTurn | null
    agentRunning: boolean
    taskWidget: string[] | null
    prompt: PromptMessage | null
    context: ContextUsage | null
}

interface SessionState {
    history: HistoryBuffer
    live: LiveTurn | null
    agentRunning: boolean
    taskWidget: string[] | null
    prompt: PromptMessage | null
    context: ContextUsage | null
    /** Broadcast sink — swapped in tests via _setSink. */
    sink: (msg: unknown) => void
}

const g = globalThis as unknown as {__piSessionState?: SessionState}

function fresh(): SessionState {
    return {
        history: new HistoryBuffer(20),
        live: null,
        agentRunning: false,
        taskWidget: null,
        prompt: null,
        context: null,
        sink: wsBroadcast
    }
}

export function getState(): SessionState {
    if (!g.__piSessionState) g.__piSessionState = fresh()
    return g.__piSessionState
}

/** @internal Test-only: swap the broadcast sink to capture emitted deltas. */
export function _setSink(fn: (msg: unknown) => void): void {
    getState().sink = fn
}

function ensureLive(s: SessionState): LiveTurn {
    if (!s.live) s.live = {text: '', tools: [], activeTools: []}
    return s.live
}

// ─── Mutators ────────────────────────────────────────────────────────────────

export function agentStart(): void {
    const s = getState()
    s.live = {text: '', tools: [], activeTools: []}
    s.agentRunning = true
    s.sink({type: 'agent_start'})
}

export function appendText(delta: string): void {
    const s = getState()
    ensureLive(s).text += delta
    s.sink({type: 'text_delta', delta})
}

export function textEnd(): void {
    getState().sink({type: 'text_end'})
}

export function startTool(toolCallId: string, toolName: string, args: unknown): void {
    const s = getState()
    ensureLive(s).activeTools.push({toolCallId, toolName, args})
    s.sink({type: 'tool_start', toolCallId, toolName, args})
}

export function updateTool(toolCallId: string, partialResult: unknown): void {
    getState().sink({type: 'tool_update', toolCallId, partialResult})
}

export function endTool(
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError: boolean
): void {
    const s = getState()
    const live = ensureLive(s)
    // Recover the args captured at tool_start — tool_end doesn't carry them, and
    // the committed/snapshot tool summary needs them or it renders "name: undefined".
    const started = live.activeTools.find(t => t.toolCallId === toolCallId)
    live.activeTools = live.activeTools.filter(t => t.toolCallId !== toolCallId)
    live.tools.push({toolName, args: started ? started.args : undefined, result, isError})
    s.sink({type: 'tool_end', toolCallId, toolName, result, isError})
}

export function agentEnd(context: ContextUsage): void {
    const s = getState()
    if (s.live) s.history.addAssistantTurn(s.live.text, s.live.tools)
    s.live = null
    s.agentRunning = false
    s.context = context
    s.sink({type: 'agent_end', contextUsage: context})
}

export function addUserTurn(text: string): void {
    const s = getState()
    s.history.addUserMessage(text)
    s.sink({type: 'user_message', text})
}

export function addError(message: string): void {
    const s = getState()
    s.history.addError(message)
    s.live = null
    s.agentRunning = false
    s.sink({type: 'agent_error', message})
}

/** The single task-widget slot. Empty/undefined lines clear it. */
export function setTaskWidget(lines: string[] | null | undefined): void {
    const s = getState()
    s.taskWidget = lines && lines.length ? lines : null
    s.sink({type: 'widget', lines: s.taskWidget})
}

export function setPrompt(prompt: PromptMessage): void {
    const s = getState()
    s.prompt = prompt
    s.sink(prompt)
}

export function clearPrompt(id: string): void {
    const s = getState()
    s.prompt = null
    s.sink({type: 'prompt_resolved', id})
}

export function setContext(context: ContextUsage): void {
    const s = getState()
    s.context = context
    s.sink({type: 'context', contextUsage: context})
}

/** Wipe everything (new session) and tell connected clients to clear. */
export function reset(): void {
    const s = getState()
    s.history = new HistoryBuffer(20)
    s.live = null
    s.agentRunning = false
    s.taskWidget = null
    s.prompt = null
    s.context = null
    s.sink({type: 'reset'})
}

/** Serialize the whole state for a (re)connecting client. */
export function snapshot(): SnapshotMessage {
    const s = getState()
    return {
        type: 'snapshot',
        turns: s.history.getEntries(),
        live:
            s.live ?
                {text: s.live.text, tools: [...s.live.tools], activeTools: [...s.live.activeTools]}
            :   null,
        agentRunning: s.agentRunning,
        taskWidget: s.taskWidget,
        prompt: s.prompt,
        context: s.context
    }
}
