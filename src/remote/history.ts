// An assistant turn is an ORDERED list of parts — text segments and tool calls
// interleaved exactly as they happened — so the remote transcript reproduces the
// terminal's layout instead of collapsing a whole run into one text blob.

export interface TextPart {
    kind: 'text'
    text: string
}

export interface ThinkingPart {
    kind: 'thinking'
    text: string
    /** false while thinking deltas are still streaming; true once thinking_end fires. */
    done?: boolean
}

export interface ToolPart {
    kind: 'tool'
    toolCallId: string
    toolName: string
    args: unknown
    result: unknown
    isError: boolean
    /** false while the tool is still running (result not in yet). */
    done: boolean
    /** Wall-clock duration once finished, shown dimly in the tool summary. */
    elapsedMs?: number
}

export type Part = TextPart | ThinkingPart | ToolPart

export interface Turn {
    role: 'user' | 'assistant' | 'system'
    /** User text, error text, or a system note. Assistant content lives in `parts`. */
    text?: string
    /** Ordered assistant content (text + tools). */
    parts?: Part[]
    error?: boolean
    /** Epoch ms when the turn was committed — the client renders a dim HH:MM. */
    ts?: number
}

export class HistoryBuffer {
    private entries: Turn[] = []
    private readonly limit: number

    constructor(limit = 20) {
        this.limit = limit
    }

    addUserMessage(text: string): void {
        this._push({role: 'user', text})
    }

    addAssistantTurn(parts: Part[]): void {
        this._push({role: 'assistant', parts})
    }

    addError(text: string): void {
        this._push({role: 'assistant', text, error: true})
    }

    /** A persistent, inline system note (e.g. "Context compacted"). */
    addSystemNote(text: string): void {
        this._push({role: 'system', text})
    }

    getEntries(): Turn[] {
        return [...this.entries]
    }

    private _push(entry: Turn): void {
        this.entries.push({ts: Date.now(), ...entry})
        if (this.entries.length > this.limit) {
            this.entries.shift()
        }
    }
}
