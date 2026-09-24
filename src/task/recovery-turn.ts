import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {isStaleCtxError} from './stale-ctx.js'

/**
 * The turn a watchdog starts after it aborts a run, telling the model what it cut.
 *
 * Posted from `agent_settled`, which pi defers until settlement ends and then runs
 * before any `waitForIdle` resolves. Sent straight after `ctx.abort()` instead, it
 * is stranded: pi's loop returns on the aborted message without draining
 * follow-ups, so the text waits for some LATER prompt.
 *
 * Module state, one queue for both watchdogs: two calls of one batch can both
 * overrun, and the model must hear about each.
 */
const queued: string[] = []
let posted = false
/** The run now going is a recovery turn, from its start to its settle. */
let recovering = false

export function queueRecoveryTurn(text: string): void {
    if (!queued.includes(text)) queued.push(text)
}

/**
 * True from the abort until the recovery turn starts. A one-shot scope that ends
 * at this settle would leave that turn unguarded, so it holds on while this is set.
 */
export function recoveryTurnPending(): boolean {
    return queued.length > 0 || posted
}

/** True while a recovery turn runs. A stall in one that has said nothing yet is
 *  the server, not the turn, and another recovery turn would only stall again. */
export function inRecoveryTurn(): boolean {
    return recovering
}

export function registerRecoveryTurns(pi: ExtensionAPI): void {
    pi.on('agent_settled', () => {
        recovering = false
        if (queued.length === 0) return
        const text = queued.splice(0).join('\n\n')
        posted = true
        try {
            pi.sendUserMessage(text, {deliverAs: 'followUp'})
        } catch (err) {
            posted = false
            if (!isStaleCtxError(err)) throw err
        }
    })
    pi.on('agent_start', () => {
        if (posted) recovering = true
        posted = false
    })
    // A reminder for a session that is gone must not land in its replacement.
    pi.on('session_shutdown', () => {
        queued.length = 0
        posted = false
        recovering = false
    })
}
