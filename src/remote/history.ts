// An assistant turn is an ORDERED list of parts — text segments and tool calls
// interleaved exactly as they happened — so the remote transcript reproduces the
// terminal's layout instead of collapsing a whole run into one text blob.

export interface TextPart {
    kind: 'text'
    text: string
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
}

export type Part = TextPart | ToolPart

export interface Turn {
    role: 'user' | 'assistant'
    /** User message text, or error text. Assistant content lives in `parts`. */
    text?: string
    /** Ordered assistant content (text + tools). */
    parts?: Part[]
    error?: boolean
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

    getEntries(): Turn[] {
        return [...this.entries]
    }

    private _push(entry: Turn): void {
        this.entries.push(entry)
        if (this.entries.length > this.limit) {
            this.entries.shift()
        }
    }
}
