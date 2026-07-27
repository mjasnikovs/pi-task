/**
 * Tell the user when mid-run input never reached the agent.
 *
 * A line held for the next task turn (src/task/mid-run-input.ts) normally lands
 * as a steer. When the run ends before any turn starts — a cancel, a failure, a
 * final task with nothing left to implement — the held text has nowhere to go.
 * Delivering it afterwards would recreate the surprise of pi's queue replaying
 * lines into a finished run (issue #8), so it is dropped; dropping it QUIETLY
 * would be the same trap. Both surfaces get told, with the text quoted back so
 * it can be re-sent by hand.
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {publishNotify} from '../remote/bridge.js'

/** Trim a held line to something that fits in a toast. */
function preview(text: string): string {
    const oneLine = text.replace(/\s+/g, ' ').trim()
    return oneLine.length > 80 ? `${oneLine.slice(0, 77)}…` : oneLine
}

export function formatDroppedInput(dropped: readonly string[]): string | null {
    if (dropped.length === 0) return null
    const head = preview(dropped[0]!)
    const rest = dropped.length > 1 ? ` (+${dropped.length - 1} more)` : ''
    return `The run ended before your message could be delivered: "${head}"${rest}`
}

export function reportDroppedInput(
    dropped: readonly string[],
    ctx?: ExtensionCommandContext
): void {
    const message = formatDroppedInput(dropped)
    if (message === null) return
    try {
        ctx?.ui.notify(message, 'warning')
    } catch {
        // A stale ctx after session replacement must not swallow the remote copy.
    }
    publishNotify(message, 'warning')
}
