/**
 * Pure-logic loop detector for pi-task sub-agent phases.
 *
 * Watches a ring buffer of recent tool calls and trips on two thrash patterns:
 *
 *   1. EXACT repeats — the same `(toolName, stable-stringified args)` key appears
 *      `threshold` times within the last `window` events.
 *   2. PATH revisits — the same primary file path is re-targeted `pathThreshold`
 *      times within the window over lines it has ALREADY covered, which the exact
 *      key misses when `offset/limit` vary call-to-call. Forward paging never
 *      trips (see countRevisits).
 *
 * Either pattern returns a LoopHit so the caller can kill the child and re-spawn
 * with a hint. No I/O. No imports from index.ts. Trivially unit-testable.
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

/**
 * The primary file path a tool call targets, mirroring summarizeToolArgs' field
 * precedence. Returns null when the call names no path (e.g. bash, or a grep
 * with only a pattern) so such calls never participate in path detection.
 */
export function primaryPath(args: unknown): string | null {
    if (!args || typeof args !== 'object') return null
    const a = args as Record<string, unknown>
    if (typeof a.file_path === 'string') return a.file_path
    if (typeof a.path === 'string') return a.path
    if (typeof a.filePath === 'string') return a.filePath
    return null
}

/** Numeric read offset (0 when absent/non-numeric) — drives progress vs revisit. */
function readOffset(args: unknown): number {
    if (!args || typeof args !== 'object') return 0
    const o = (args as Record<string, unknown>).offset
    return typeof o === 'number' && Number.isFinite(o) ? o : 0
}

/** Default `limit` pi's read tool applies when the call names none. */
const DEFAULT_READ_LIMIT = 2000

/**
 * The last line a call reaches, so a page can be told from a re-read. Absent,
 * junk, or at-the-tool-default `limit` all mean "to the end of the file": at this
 * layer they are indistinguishable, and the generous reading is the safe one —
 * scoring an honest page as a revisit is the failure this rule had.
 */
function readEnd(args: unknown, offset: number): number {
    if (!args || typeof args !== 'object') return Infinity
    const l = (args as Record<string, unknown>).limit
    if (typeof l !== 'number' || !Number.isFinite(l) || l <= 0 || l >= DEFAULT_READ_LIMIT) {
        return Infinity
    }
    return offset + Math.floor(l) - 1
}

interface Entry {
    /** Exact-match key: name + stable-stringified args. */
    key: string
    /** Primary file path, or null when the call targets none. */
    path: string | null
    /** Read offset (0 when absent), used to tell forward paging from revisits. */
    offset: number
    /** Last line this call reaches (Infinity when it runs to end-of-file). */
    end: number
}

export class LoopDetector {
    private readonly buf: Entry[] = []

    constructor(
        private readonly window: number = 20,
        private readonly threshold: number = 5,
        /** Revisits of one path needed to trip; defaults to the exact threshold. */
        private readonly pathThreshold: number = threshold
    ) {}

    /** Record a tool call. Returns LoopHit if either threshold is breached, else null. */
    record(call: ToolCall): LoopHit | null {
        const key = `${call.name}\x00${stableStringify(call.args)}`
        const offset = readOffset(call.args)
        this.buf.push({key, path: primaryPath(call.args), offset, end: readEnd(call.args, offset)})
        if (this.buf.length > this.window) this.buf.shift()

        // 1. Exact-match loop: identical (name, args) repeated past threshold.
        let exact = 0
        for (const e of this.buf) if (e.key === key) exact++
        if (exact >= this.threshold) return {call, count: exact, windowSize: this.buf.length}

        // 2. Path-aware loop: the same file re-targeted without forward progress.
        // Caught here precisely because varied offset/limit make the exact key
        // miss it (one file read and grepped a dozen times with changing args until
        // the wall-clock timeout, never tripping the exact detector).
        const path = this.buf[this.buf.length - 1].path
        if (path !== null) {
            const revisits = this.countRevisits(path)
            if (revisits >= this.pathThreshold) {
                return {call, count: revisits, windowSize: this.buf.length}
            }
        }
        return null
    }

    /**
     * Count same-path calls in the window that are "revisits" — accesses that end
     * no further into the file than the furthest line already covered for that
     * path. Paging yields zero revisits and never trips; repeated whole-file
     * re-reads, backward jumps and path-targeting greps accumulate.
     *
     * The comparison is on the RANGE, not the offset. Offset alone scored a page
     * that re-asks from the same start with a bigger limit — `{offset:80,
     * limit:400}` after `{offset:80, limit:300}`, real reads from a measured
     * decompose run — as a revisit, even though it covers 100 lines the child had
     * never seen. That is the same mistake SingleReadGuard made by keying on the
     * path alone, and it is corrected the same way.
     */
    private countRevisits(path: string): number {
        let maxEnd = -1
        let revisits = 0
        for (const e of this.buf) {
            if (e.path !== path) continue
            if (e.end > maxEnd)
                maxEnd = e.end // progress: new ground
            else revisits++ // revisit: already-covered ground
        }
        return revisits
    }
}
