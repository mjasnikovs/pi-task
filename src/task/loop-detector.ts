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
 *
 * This module imports nothing: worker-profiles.ts reads the tuning constants at
 * module top level, and a dependency from here on any runner would close a cycle
 * whose only symptom is a TDZ ReferenceError on import order.
 */

/** Recent tool calls the exact-repeat rule looks back over. */
export const LOOP_WINDOW = 20

/** Repeats of one key within the window that trip the detector. */
export const LOOP_THRESHOLD = 5

/** Re-spawns allowed after a loop kill — 3 attempts total with the initial one. */
export const MAX_LOOP_RESTARTS = 2

export interface ToolCall {
    name: string
    args: unknown
}

export interface LoopHit {
    call: ToolCall
    count: number
    /**
     * How many recent calls `count` was counted over.
     *
     * OPTIONAL because a stall hit counts a streak or a byte total, not a window
     * — it used to carry 0 there, which every renderer printed as "in the last 0
     * calls". Absent means "this hit has no window"; a renderer must say what the
     * hit actually measured instead.
     */
    windowSize?: number
    /**
     * Set when the kill came from the whole-run StallDetector rather than this
     * short-window detector, naming which of its two rules tripped
     * (stall-detector.ts). Absent for an ordinary loop hit. Carried here so a
     * stall rides the kill/restart plumbing the loop hit already has instead of
     * needing a second channel.
     */
    stall?: 'no-new-ground' | 'context-churn'
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
 * The exact-match identity of a tool call. Exported because implementation-guards.ts
 * keys its own per-call strike count on it, and a second hand-written copy of this
 * expression is free to drift away from the one `record` uses.
 */
export function loopKey(call: ToolCall): string {
    return `${call.name}\x00${stableStringify(call.args)}`
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

/**
 * pi's read tool truncates its output at `DEFAULT_MAX_LINES` lines (its
 * `core/tools/truncate` module). A `limit` at or above that asks for as much as
 * the tool will ever return, so it is treated the same as naming no limit at all.
 */
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
    /**
     * Every path the attempt has targeted, with the span it covered — the WHOLE
     * attempt, not the window `buf` holds. It is the only record of what a killed
     * attempt actually read: the kill fires from the tool-call hook, before a byte
     * of answer text streams, so text carry-forward is empty by construction and
     * the re-spawn would otherwise start blind.
     */
    private readonly visits = new Map<string, {from: number; to: number}>()

    constructor(
        private readonly window: number = LOOP_WINDOW,
        private readonly threshold: number = LOOP_THRESHOLD,
        /** Revisits of one path needed to trip; defaults to the exact threshold. */
        private readonly pathThreshold: number = threshold
    ) {}

    /** Record a tool call. Returns LoopHit if either threshold is breached, else null. */
    record(call: ToolCall): LoopHit | null {
        const key = loopKey(call)
        const offset = readOffset(call.args)
        const path = primaryPath(call.args)
        const end = readEnd(call.args, offset)
        this.buf.push({key, path, offset, end})
        if (this.buf.length > this.window) this.buf.shift()
        if (path !== null) {
            const seen = this.visits.get(path)
            this.visits.set(
                path,
                seen ?
                    {from: Math.min(seen.from, offset), to: Math.max(seen.to, end)}
                :   {from: offset, to: end}
            )
        }

        // 1. Exact-match loop: identical (name, args) repeated past threshold.
        let exact = 0
        for (const e of this.buf) if (e.key === key) exact++
        if (exact >= this.threshold) return {call, count: exact, windowSize: this.buf.length}

        // 2. Path-aware loop: the same file re-targeted without forward progress.
        // Caught here precisely because varied offset/limit change the exact key on
        // every call, so pattern 1 above can never see it.
        if (path !== null) {
            const revisits = this.countRevisits(path)
            if (revisits >= this.pathThreshold) {
                return {call, count: revisits, windowSize: this.buf.length}
            }
        }
        return null
    }

    /**
     * The attempt's READ-SET, in first-seen order: every path it opened, with the
     * line span when the call named one. This is what a restart carries instead of
     * answer text — see {@link visits}.
     */
    visited(): string[] {
        return [...this.visits].map(([path, span]) =>
            span.to === Infinity ? path : `${path} (lines ${span.from}-${span.to})`
        )
    }

    /**
     * Count same-path calls in the window that are "revisits" — accesses that end
     * no further into the file than the furthest line already covered for that
     * path. The FIRST call on a path is therefore never a revisit: it sets the
     * high-water mark. Paging yields zero revisits and never trips; repeated
     * whole-file re-reads, backward jumps, narrower re-reads and repeated
     * path-targeting greps all accumulate.
     *
     * The comparison is on the RANGE, not the offset. Keying on offset alone scores
     * `{offset:80, limit:400}` after `{offset:80, limit:300}` as a revisit, even
     * though it covers 100 lines the child has never seen. That is the same mistake
     * SingleReadGuard made by keying on the path alone, and it is corrected the same
     * way.
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

/**
 * What killed the attempt, as prose a human reads in a degraded section or a
 * `loop events` line.
 *
 * ONE renderer because each rule measures something different — calls in a
 * window, a consecutive streak, bytes against a context window — and a shared
 * "×N in the last M calls" template printed the streak's absent window as
 * "in the last 0 calls".
 */
export function describeLoopHit(hit: LoopHit): string {
    const call = `${hit.call.name}(${JSON.stringify(hit.call.args)})`
    if (hit.stall === 'context-churn') {
        return (
            `pulled in about ${hit.count} tokens of tool output, more than its `
            + `${hit.windowSize}-token context window holds (last call ${call})`
        )
    }
    if (hit.stall === 'no-new-ground') {
        return (
            `stopped covering new ground — ${hit.count} consecutive tool calls returned `
            + `nothing it had not already seen (last call ${call})`
        )
    }
    return `stuck in a loop — called ${call} ×${hit.count} in the last ${hit.windowSize} calls`
}

/**
 * The read-set clause a restart hint carries, or '' when the killed attempt
 * opened nothing.
 *
 * It is the only thing a loop restart CAN carry: the kill fires from the
 * tool-call hook, so there is no partial answer to hand forward (which is why
 * `loop` is absent from CARRY_FORWARD_REASONS in pi-worker-core.ts). Without it
 * "do not re-read what you have already read" names no files and the re-spawn
 * re-reads the same ones.
 *
 * Bounded so a rotation over hundreds of files cannot outgrow the prompt it is
 * prepended to; the count keeps the elision honest.
 */
export function formatReadSet(visited: readonly string[]): string {
    if (visited.length === 0) return ''
    const shown = visited.slice(0, MAX_READ_SET_ENTRIES)
    const rest = visited.length - shown.length
    return (
        ` You have already read, do not re-open: ${shown.join(', ')}`
        + (rest > 0 ? `, and ${rest} more` : '')
        + '.'
    )
}

/**
 * How many paths a restart hint lists. The read-set is a reminder, not an
 * inventory: past a screenful the tail stops being read and only costs prefill,
 * and the elision line still tells the child there was more.
 */
const MAX_READ_SET_ENTRIES = 40

/**
 * The restart hint a re-spawned child gets after a loop kill: names the call, and
 * the read-set the killed attempt built up.
 */
export function formatLoopHint(hit: LoopHit, visited: readonly string[] = []): string {
    const argsStr = JSON.stringify(hit.call.args)
    return (
        `[SYSTEM NOTE: Your prior attempt called ${hit.call.name}(${argsStr}) `
        + `${hit.count} times in the last ${hit.windowSize} tool calls — you appeared to be `
        + `stuck in a loop. Avoid repeating that exact call; if you've already seen its result, `
        + `work from memory or pick a different angle.`
        + `${formatReadSet(visited)}]`
    )
}
