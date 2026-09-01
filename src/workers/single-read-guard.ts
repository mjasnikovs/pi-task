/**
 * In-process thrash guards, armed by single-read-extension.ts in the TOOLING
 * research worker and the planning children.
 *
 * Two guards, one mechanism — deny a wasteful repeat *inside the run*. The
 * extension returns the block from a `tool_call` handler, pi feeds `reason` back
 * as an error tool result, and the child continues. No kill, no restart:
 * detect-and-kill only re-spawns a model that deterministically re-thrashes.
 *
 *   - SingleReadGuard: "read each LINE of a file once".
 *
 *     Keying on the resolved path alone — blocking any second read regardless of
 *     offset — turns a file bigger than one read into a TRAP. A child paging
 *     deliberately, first 80 lines then the next 80, has its second request
 *     refused; it never reaches the end of the file and spends the rest of the run
 *     asking for the remainder. That guard does not stop a thrash, it causes one.
 *
 *     So the unit is the line range, not the file. A request that extends past the
 *     furthest line already delivered is forward paging and passes; one that lies
 *     entirely within ground already delivered is a re-read and is blocked.
 *
 *   - RepeatedCallGuard: "no identical search twice", for grep/find/ls — the
 *     shapes the read guard cannot see, such as the same grep pattern re-run
 *     against the same path. Keyed with `loopKey`, the same identity
 *     `LoopDetector.record` uses, so argument key order never causes a miss and
 *     only an identical repeat trips. A different pattern on the same file still
 *     passes.
 *
 * Pure logic, no I/O — the extension does path resolution and tool routing.
 */

import {loopKey} from '../task/loop-detector.js'

export interface ReadBlock {
    block: true
    reason: string
}

/**
 * The error text the model receives in place of the re-read's contents.
 *
 * It must say what to do NEXT, and the honest next move depends on whether there
 * is any of the file left: with `covered` lines already delivered, asking for line
 * `covered + 1` is always allowed, so the message says so. A bare "do not read it
 * again" is a dead end for a model mid-way through a file — it has nowhere legal
 * to go and keeps asking anyway. A read that reached EOF has `covered` set to
 * Infinity and gets the other wording, with no line to resume from.
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

/** pi's own read truncation ceiling (`DEFAULT_MAX_LINES` in its truncate.js): a
 *  read that names no `limit` returns at most this many lines. */
const DEFAULT_READ_LIMIT = 2000

/** The 1-based line a read starts at (`offset` absent or junk means line 1). */
function startLine(offset: unknown): number {
    return typeof offset === 'number' && Number.isFinite(offset) && offset >= 1 ?
            Math.floor(offset)
        :   1
}

/**
 * The last line a read reaches, or Infinity when the read is unbounded. A `limit`
 * at or above pi's own ceiling is treated as "no limit given" — indistinguishable
 * at this layer — and so is a `limit` that is absent, zero, negative or not a
 * number. The generous reading is the safe one, since blocking honest paging is
 * the failure mode this guard has.
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
     * after), else null on the first. Shares the LoopDetector's key, so argument
     * key-order never causes a miss; only byte-identical calls collapse.
     */
    check(toolName: string, args: unknown): ReadBlock | null {
        const key = loopKey({name: toolName, args})
        if (this.seen.has(key)) {
            return {block: true, reason: repeatedCallReason(toolName)}
        }
        this.seen.add(key)
        return null
    }
}
