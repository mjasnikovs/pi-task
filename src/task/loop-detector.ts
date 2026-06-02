/**
 * Pure-logic loop detector for pi-task sub-agent phases.
 *
 * Watches a ring buffer of recent tool-call keys. When the same
 * `(toolName, stable-stringified args)` key appears `threshold` times
 * within the last `window` events, returns a LoopHit so the caller can
 * kill the child and re-spawn with a hint.
 *
 * No I/O. No imports from index.ts. Trivially unit-testable.
 */

export interface ToolCall {
    name: string
    args: unknown
}

export interface LoopHit {
    call: ToolCall
    count: number
    windowSize: number
}

/**
 * JSON.stringify with sorted object keys so {a:1,b:2} and {b:2,a:1} hash equal.
 * Arrays preserve their order (positional). undefined / primitives passthrough.
 */
export function stableStringify(value: unknown): string {
    return JSON.stringify(value, (_key, v) => {
        if (v === null || typeof v !== 'object' || Array.isArray(v)) return v
        const sorted: Record<string, unknown> = {}
        for (const k of Object.keys(v as Record<string, unknown>).sort()) {
            sorted[k] = (v as Record<string, unknown>)[k]
        }
        return sorted
    })
}

export class LoopDetector {
    private readonly buf: string[] = []

    constructor(
        private readonly window: number = 20,
        private readonly threshold: number = 5
    ) {}

    /** Record a tool call. Returns LoopHit if the threshold is breached, else null. */
    record(call: ToolCall): LoopHit | null {
        const key = `${call.name}\x00${stableStringify(call.args)}`
        this.buf.push(key)
        if (this.buf.length > this.window) this.buf.shift()
        let count = 0
        for (const k of this.buf) if (k === key) count++
        return count >= this.threshold ? {call, count, windowSize: this.buf.length} : null
    }
}
