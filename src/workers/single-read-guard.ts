/**
 * In-process thrash guards for the TOOLING research worker.
 *
 * Two guards, one mechanism — deny a wasteful repeat *inside the run* (the
 * extension returns the block from a `tool_call` handler, pi feeds `reason` back
 * as an error tool result, the worker continues). No kill, no restart: detect-
 * and-kill only re-spawns a model that deterministically re-thrashes.
 *
 *   - SingleReadGuard: "read each file once". Validated against every recorded
 *     mx5 run — a healthy TOOLING worker reads each file exactly once (max
 *     same-file reads = 1 across 7 tasks). TASK_0017 re-read one file up to 50×.
 *     Keyed on the resolved path so any re-read is blocked regardless of offset.
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

/** The error text the model receives in place of the re-read's contents. */
export function singleReadReason(path: string): string {
    return (
        `You already read ${path} earlier in this run — its contents are in your context. `
        + `Re-reading the same file is blocked. Do not read it again: use what you have already `
        + `gathered and write your final answer now.`
    )
}

export class SingleReadGuard {
    private readonly seen = new Set<string>()

    /**
     * Record a read of `resolvedPath`. Returns a ReadBlock the first time a path
     * is seen a second time (and every time after), else null on the first read.
     * Callers pass an already-resolved/normalized path so `a.ts` and `./a.ts`
     * dedupe to one entry.
     */
    check(resolvedPath: string): ReadBlock | null {
        if (this.seen.has(resolvedPath)) {
            return {block: true, reason: singleReadReason(resolvedPath)}
        }
        this.seen.add(resolvedPath)
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
