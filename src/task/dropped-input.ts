/**
 * Tell the user when mid-run input never reached the agent.
 *
 * A line held for the next task turn (mid-run-input.ts) normally lands as a steer:
 * orchestrator takes it on `agent_start` and calls
 * `sendUserMessage(held, {deliverAs: 'steer'})`. When the run ends before any turn
 * starts — a cancel, a failure, a final task with nothing left to implement — the
 * held text has nowhere to go.
 *
 * Delivering it afterwards would recreate the surprise this whole mechanism exists
 * to avoid: pi's own non-streaming submit path pushes a line onto
 * `pendingUserInputs`, which the parked main loop drains only after the run, so
 * the user sees their message answered by a session that has already finished. So
 * it is dropped — but dropping it QUIETLY is the same trap. Both surfaces get
 * told, with the text quoted back so it can be re-sent by hand.
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {publishNotify} from '../remote/bridge.js'

/** Trim a held line to something that fits in a toast: whitespace collapsed to
 *  single spaces, and anything past 80 characters cut to 77 plus an ellipsis. */
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
        // A stale ctx after session replacement must not swallow the remote copy —
        // `publishNotify` below is outside this try for exactly that reason.
        // Confirmed: a ctx whose `notify` throws does not propagate out of here.
    }
    publishNotify(message, 'warning')
}
