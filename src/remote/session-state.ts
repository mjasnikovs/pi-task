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
import type {Turn, Part, ToolPart} from './history.js'
import type {ContextUsage, PromptMessage} from './protocol.js'

export interface LiveTurn {
    /** Ordered assistant content (text segments + tool calls) for this run. */
    parts: Part[]
    /** Is the trailing text part still accumulating deltas? Closed by text_end /
     *  a tool start, so the next text begins a fresh segment (separate bubble). */
    textOpen: boolean
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
    /** tool start timestamps (ms), keyed by toolCallId — kept off the serialized
     *  parts so it never reaches the client; used only to compute elapsedMs. */
    toolStarts: Record<string, number>
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
        toolStarts: {},
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
    if (!s.live) s.live = {parts: [], textOpen: false}
    return s.live
}

// ─── Mutators ────────────────────────────────────────────────────────────────

export function agentStart(): void {
    const s = getState()
    s.live = {parts: [], textOpen: false}
    s.agentRunning = true
    s.sink({type: 'agent_start'})
}

export function appendText(delta: string): void {
    const s = getState()
    const live = ensureLive(s)
    const last = live.parts[live.parts.length - 1]
    if (live.textOpen && last && last.kind === 'text') {
        last.text += delta
    } else {
        live.parts.push({kind: 'text', text: delta})
        live.textOpen = true
    }
    s.sink({type: 'text_delta', delta})
}

export function textEnd(): void {
    const s = getState()
    if (s.live) s.live.textOpen = false // next text starts a new segment
    s.sink({type: 'text_end'})
}

export function startTool(toolCallId: string, toolName: string, args: unknown): void {
    const s = getState()
    const live = ensureLive(s)
    live.textOpen = false
    live.parts.push({
        kind: 'tool',
        toolCallId,
        toolName,
        args,
        result: undefined,
        isError: false,
        done: false
    })
    s.toolStarts[toolCallId] = Date.now()
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
    const part = live.parts.find(
        (p): p is ToolPart => p.kind === 'tool' && p.toolCallId === toolCallId
    )
    const startedAt = s.toolStarts[toolCallId]
    let elapsedMs: number | undefined
    if (startedAt != null) {
        elapsedMs = Date.now() - startedAt
        delete s.toolStarts[toolCallId]
    }
    if (part) {
        part.result = result
        part.isError = isError
        part.done = true
        if (elapsedMs != null) part.elapsedMs = elapsedMs
    } else {
        // tool_end without a matching start (shouldn't happen) — append a done tool.
        live.parts.push({
            kind: 'tool',
            toolCallId,
            toolName,
            args: undefined,
            result,
            isError,
            done: true
        })
    }
    s.sink({type: 'tool_end', toolCallId, toolName, result, isError, elapsedMs})
}

export function agentEnd(context: ContextUsage): void {
    const s = getState()
    if (s.live) s.history.addAssistantTurn(s.live.parts)
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

/** A persistent inline note (committed to the transcript so it survives reconnect)
 *  plus a live delta so connected clients render it immediately. */
export function addSystemNote(text: string): void {
    const s = getState()
    s.history.addSystemNote(text)
    s.sink({type: 'system_note', text})
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
        live: s.live ? {parts: [...s.live.parts], textOpen: s.live.textOpen} : null,
        agentRunning: s.agentRunning,
        taskWidget: s.taskWidget,
        prompt: s.prompt,
        context: s.context
    }
}
