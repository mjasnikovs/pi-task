import {resolve} from 'node:path'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {SingleReadGuard} from './single-read-guard.js'

/**
 * Loaded via `-e` into the TOOLING research worker only. Blocks a second read of
 * any file the worker has already read this run, returning a reason the model
 * receives as an error tool result (agent-loop: block → createErrorToolResult).
 * The worker then continues from what it has instead of re-reading. See
 * SingleReadGuard for why this is scoped to TOOLING.
 */
export default function (pi: ExtensionAPI): void {
    const guard = new SingleReadGuard()
    pi.on('tool_call', event => {
        if (event.toolName !== 'read') return
        const path = (event.input as {path?: unknown}).path
        if (typeof path !== 'string') return
        return guard.check(resolve(process.cwd(), path)) ?? undefined
    })
}
