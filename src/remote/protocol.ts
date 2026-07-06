// Wire format shared by the WS server and the inline browser app.
// Keep these shapes in sync with the hand-written switch in ui.ts.

export interface PromptMessage {
    type: 'prompt'
    id: string
    question: string
    recommended?: string
    recommended2?: string
    allowSkip: boolean
}

export interface PromptResolvedMessage {
    type: 'prompt_resolved'
    id: string
}

/** Structured task-widget payload — lets the browser render a real progress bar,
 *  phase badge and elapsed clock instead of reflowing the terminal's text lines.
 *  Always sent ALONGSIDE `lines`, which stays the authoritative fallback. */
export interface WidgetData {
    /** Head line, e.g. "TASK_0003 · auth routes" or "/task-auto · building". */
    title: string
    /** Current phase/stage label, e.g. "refine", "implementing", "enforcing guidelines". */
    phase: string
    /** Progress numerator (current step) — omitted for stages without numbering. */
    done?: number
    /** Progress denominator (total steps) — omitted for stages without numbering. */
    total?: number
    /** Pre-formatted elapsed clock, e.g. "2:14". */
    elapsed?: string
}

/** The single task-widget slot. `lines: null` clears it. `data` carries the
 *  structured view (null when clearing or when a producer only has text). */
export interface WidgetMessage {
    type: 'widget'
    lines: string[] | null
    data?: WidgetData | null
}

export interface NotifyMessage {
    type: 'notify'
    message: string
    level: 'info' | 'warning' | 'error'
}

export interface ViewerMessage {
    type: 'viewer'
    title: string
    text: string
}

export interface ContextUsage {
    tokens?: number
    contextWindow?: number
    percent?: number
}

/** Seeds the context-usage bar for a freshly-connected client (the live value is
 *  otherwise only carried on agent_end). */
export interface ContextMessage {
    type: 'context'
    contextUsage: ContextUsage
}

/** Tells the browser to wipe the transcript/widgets/prompt when a new session
 *  starts, so it reflects the fresh session instead of the previous one. */
export interface ResetMessage {
    type: 'reset'
}

/** The full authoritative state sent to a (re)connecting client. Defined in
 *  session-state.ts (its serializer); re-exported here as part of the wire type. */
export type {SnapshotMessage} from './session-state.js'

/** Server → browser messages. The live text_delta / tool_* / agent_* /
 *  user_message deltas are emitted by the SessionState mutators
 *  and not all enumerated here; the snapshot below carries the full state. */
export type ServerMessage =
    | PromptMessage
    | PromptResolvedMessage
    | WidgetMessage
    | NotifyMessage
    | ViewerMessage
    | ContextMessage
    | ResetMessage
    | import('./session-state.js').SnapshotMessage

/** Browser → server messages. */
export interface ClientChatMessage {
    type: 'message'
    text: string
}
export interface ClientPromptAnswer {
    type: 'prompt_answer'
    id: string
    value: string | undefined
}
/** Stop the running agent turn (the browser Stop button). */
export interface ClientInterrupt {
    type: 'interrupt'
}
export type ClientMessage = ClientChatMessage | ClientPromptAnswer | ClientInterrupt

export function isClientMessage(x: unknown): x is ClientMessage {
    if (typeof x !== 'object' || x === null) return false
    const m = x as Record<string, unknown>
    if (m.type === 'message') return typeof m.text === 'string'
    if (m.type === 'interrupt') return true
    if (m.type === 'prompt_answer') {
        return typeof m.id === 'string' && (m.value === undefined || typeof m.value === 'string')
    }
    return false
}
