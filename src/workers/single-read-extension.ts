import {resolve} from 'node:path'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {RepeatedCallGuard, SingleReadGuard} from './single-read-guard.js'

/** Read-like tools whose byte-identical repeats are blocked (read is handled separately). */
const DEDUP_TOOLS = new Set(['grep', 'find', 'ls'])

/**
 * Loaded via `-e` into two kinds of child, both of which have their source
 * INLINED and so can only be thrashing when they re-read: the TOOLING research
 * worker (phases.ts) and the planning children (auto-orchestrator.ts).
 *
 * Two in-run blocks. Each returns a `reason`, which pi turns into an error tool
 * result — `agent-loop.js` does `createErrorToolResult(beforeResult.reason)` on a
 * blocked call — so the child reads the explanation and continues instead of
 * dying:
 *   - read: blocks a re-read of LINES already delivered; forward paging passes,
 *     and the reason names the line to resume from.
 *   - grep/find/ls: blocks a byte-identical repeat, keyed on the args; a call
 *     with any different argument passes.
 * A tool outside this set is never touched. See single-read-guard.ts for why the
 * read-once rule is safe only where it is armed.
 */
export default function (pi: ExtensionAPI): void {
    const reads = new SingleReadGuard()
    const calls = new RepeatedCallGuard()
    pi.on('tool_call', event => {
        if (event.toolName === 'read') {
            const input = event.input as {path?: unknown; offset?: unknown; limit?: unknown}
            if (typeof input.path !== 'string') return
            return (
                reads.check(resolve(process.cwd(), input.path), input.offset, input.limit)
                ?? undefined
            )
        }
        if (DEDUP_TOOLS.has(event.toolName)) {
            return calls.check(event.toolName, event.input) ?? undefined
        }
        return
    })
}
