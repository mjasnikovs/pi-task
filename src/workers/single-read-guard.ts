/**
 * In-process thrash guards for the TOOLING research worker.
 *
 * Two guards, one mechanism — deny a wasteful repeat *inside the run* (the
 * extension returns the block from a `tool_call` handler, pi feeds `reason` back
 * as an error tool result, the worker continues). No kill, no restart: detect-
 * and-kill only re-spawns a model that deterministically re-thrashes.
 *
 *   - SingleReadGuard: "read each LINE of a file once". Validated against every
 *     recorded mx5 run — a healthy TOOLING worker reads each file exactly once
 *     (max same-file reads = 1 across 7 tasks). TASK_0017 re-read one file 50×.
 *
 *     It used to key on the resolved path alone, blocking any second read
 *     "regardless of offset". That made a file bigger than one read into a trap.
 *     Measured 2026-08-17 on a captured auto-decompose request: the planner asked
 *     for `DESIGN/marketplace.html` with `limit: 80` — the first 80 lines of 743,
 *     deliberately paging — and its request for offset 80 was refused. It never
 *     reached the end of the file, and spent the rest of the run asking for the
 *     remainder: 197 of 200 tool calls were this guard's own refusal. The guard
 *     did not stop a thrash, it CAUSED one.
 *
 *     So the unit is the line range, not the file. A request that extends past
 *     the furthest line already delivered is forward paging and passes; one that
 *     lies entirely within ground already delivered is a re-read and is blocked.
 *
 *   - RepeatedCallGuard: "no identical search twice", for grep/find/ls. TASK_0017
 *     also looped on grep({pattern:"^\\s*}",path:".../index.ts"}) ×5 — a path the
 *     read guard never covered, so the call fell back to the ineffective detect→
 *     restart path. Keyed on (toolName, stableStringify(args)) — the *same* key
 *     the LoopDetector uses — so only byte-identical repeats trip; a legitimately
 *     different grep pattern on the same file still passes.
 *
 * Pure logic, no I/O — the extension does path resolution and tool routing.
 */

import {stableStringify} from '../task/loop-detector.js'

export interface ReadBlock {
    block: true
    reason: string
}

/**
 * The error text the model receives in place of the re-read's contents.
 *
 * It must say what to do NEXT, and the honest next move depends on whether there
 * is any of the file left: with `covered` lines already delivered, asking for
 * line `covered + 1` is always allowed, so the message says so. The old wording
 * ("Do not read it again") was a dead end for a model that was mid-way through a
 * file — it had nowhere legal to go and kept asking anyway.
 */
export function singleReadReason(path: string, covered: number): string {
    if (!Number.isFinite(covered)) {
        return (
            `You already read all of ${path} earlier in this run — its contents are in your `
            + `context. Re-reading it is blocked. Use what you have already gathered and write `
            + `your final answer now.`
        )
    }
    return (
        `You already read ${path} through line ${covered} earlier in this run — those lines are `
        + `in your context. Re-reading them is blocked. To see more of this file, read it again `
        + `starting at line ${covered + 1}; otherwise use what you have already gathered and `
        + `write your final answer now.`
    )
}

/** Default `limit` pi's read tool applies when the call names none. */
const DEFAULT_READ_LIMIT = 2000

/** The 1-based line a read starts at (`offset` absent or junk means line 1). */
function startLine(offset: unknown): number {
    return typeof offset === 'number' && Number.isFinite(offset) && offset >= 1 ?
            Math.floor(offset)
        :   1
}

/**
 * The last line a read reaches. A `limit` of exactly the tool default is treated
 * as "no limit given" — indistinguishable at this layer, and the safe reading is
 * the generous one, since blocking honest paging is the failure this guard had.
 */
function endLine(start: number, limit: unknown): number {
    if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return Infinity
    if (limit >= DEFAULT_READ_LIMIT) return Infinity
    return start + Math.floor(limit) - 1
}

export class SingleReadGuard {
    /** Furthest line already delivered per path; Infinity once a read hit EOF. */
    private readonly covered = new Map<string, number>()

    /**
     * Record a read of `resolvedPath` over an optional line range. Returns a
     * ReadBlock when the request lies entirely within lines already delivered,
     * else null — which includes every first read and every forward page.
     * Callers pass an already-resolved/normalized path so `a.ts` and `./a.ts`
     * dedupe to one entry.
     */
    check(resolvedPath: string, offset?: unknown, limit?: unknown): ReadBlock | null {
        const seen = this.covered.get(resolvedPath)
        const start = startLine(offset)
        const end = endLine(start, limit)
        if (seen !== undefined && end <= seen) {
            return {block: true, reason: singleReadReason(resolvedPath, seen)}
        }
        this.covered.set(resolvedPath, Math.max(seen ?? 0, end))
        return null
    }
}

/** The error text the model receives in place of a repeated grep/find/ls call. */
export function repeatedCallReason(toolName: string): string {
    return (
        `You already ran this exact ${toolName} call earlier in this run — its result is in your `
        + `context. Repeating the identical call is blocked. Use what you have already gathered, or `
        + `try a different angle if you still need more, then write your final answer.`
    )
}

export class RepeatedCallGuard {
    private readonly seen = new Set<string>()

    /**
     * Record a `toolName` call with `args`. Returns a ReadBlock the second time
     * the same (toolName, stable-stringified args) pair is seen (and every time
     * after), else null on the first. Uses the LoopDetector's stableStringify so
     * argument key-order never causes a miss; only byte-identical calls collapse.
     */
    check(toolName: string, args: unknown): ReadBlock | null {
        const key = `${toolName}\x00${stableStringify(args)}`
        if (this.seen.has(key)) {
            return {block: true, reason: repeatedCallReason(toolName)}
        }
        this.seen.add(key)
        return null
    }
}
