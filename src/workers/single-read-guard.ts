/**
 * In-process "read each file once" guard for the TOOLING research worker.
 *
 * Validated against every recorded mx5 run: a healthy TOOLING worker reads each
 * file exactly once (max same-file reads = 1 across 7 tasks). The failure case
 * (TASK_0017) re-read the same file up to 50× — the model already had the answer
 * (package.json) but kept oscillating read→write-fragment→read until it looped.
 *
 * Rather than detect-and-kill (which only restarts a model that re-thrashes), we
 * deny the re-read *inside the run*: the extension wiring returns this guard's
 * block result from a `tool_call` handler, so pi feeds `reason` back to the model
 * as an error tool result and the worker continues without the re-read. No kill,
 * no restart. Pure logic, no I/O — the extension does path resolution.
 */

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
