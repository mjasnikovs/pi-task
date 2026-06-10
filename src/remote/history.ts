export interface ToolSummary {
    toolName: string
    args: unknown
    result: unknown
    isError: boolean
}

export interface Turn {
    role: 'user' | 'assistant'
    text: string
    tools: ToolSummary[]
    error?: boolean
}

export class HistoryBuffer {
    private entries: Turn[] = []
    private readonly limit: number

    constructor(limit = 20) {
        this.limit = limit
    }

    addUserMessage(text: string): void {
        this._push({role: 'user', text, tools: []})
    }

    addAssistantTurn(text: string, tools: ToolSummary[]): void {
        this._push({role: 'assistant', text, tools})
    }

    addError(text: string): void {
        this._push({role: 'assistant', text, tools: [], error: true})
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
