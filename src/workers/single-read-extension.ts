import {resolve} from 'node:path'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {RepeatedCallGuard, SingleReadGuard} from './single-read-guard.js'

/** Read-like tools whose byte-identical repeats are blocked (read is handled separately). */
const DEDUP_TOOLS = new Set(['grep', 'find', 'ls'])

/**
 * Loaded via `-e` into the TOOLING research worker only. Two in-run thrash
 * blocks, each returning a reason the model receives as an error tool result
 * (agent-loop: block → createErrorToolResult) so the worker continues instead of
 * looping:
 *   - read: blocks a re-read of LINES already delivered; forward paging passes.
 *   - grep/find/ls: blocks an identical repeat of the same call (args-keyed).
 * See single-read-guard.ts for why this is scoped to TOOLING.
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
