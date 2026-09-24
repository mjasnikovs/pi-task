import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {isStaleCtxError} from './stale-ctx.js'

/**
 * The turn a watchdog starts after it aborts a run, telling the model what it cut,
 * and the one place that decides when an implementation turn is over.
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
/** Posted at a settle. Cleared when its run starts, or when another input proves it never will. */
let posted: string | undefined
let recovering = false
/** A tool call succeeded in this recovery turn. A turn with none would only fail the same way again. */
let progressed = false
/** The runaway guard ended this run, and its verdict is not retried. */
let vetoed = false

type TurnOverHook = (ctx: ExtensionContext) => void | Promise<void>
/** Keyed, so a module registered again replaces its hook instead of adding a second. */
const turnOverHooks = new Map<string, TurnOverHook>()

export function queueRecoveryTurn(text: string): void {
    if (vetoed || (recovering && !progressed)) return
    if (!queued.includes(text)) queued.push(text)
}

export function vetoRecoveryTurn(): void {
    vetoed = true
    queued.length = 0
}

/** `hook` runs once each implementation turn, recovery turns included, is over. */
export function onTurnOver(key: string, hook: TurnOverHook): void {
    turnOverHooks.set(key, hook)
}

/** With `hook`, removes it only while it still holds `key`, so a later owner's is kept. */
export function offTurnOver(key: string, hook?: TurnOverHook): void {
    if (hook === undefined || turnOverHooks.get(key) === hook) turnOverHooks.delete(key)
}

/** A new implementation turn starts clean: a recovery left from an earlier one is not its. */
export function forgetRecoveryTurn(): void {
    queued.length = 0
    posted = undefined
    recovering = false
    progressed = false
    vetoed = false
}

/** @internal Test seam: is a recovery turn queued or posted and not yet started? */
export function recoveryTurnPending(): boolean {
    return queued.length > 0 || posted !== undefined
}

/** @internal Test seam: is the run now going a recovery turn? */
export function inRecoveryTurn(): boolean {
    return recovering
}

async function turnOver(ctx: ExtensionContext): Promise<void> {
    const results = await Promise.allSettled(
        [...turnOverHooks.values()].map(async hook => hook(ctx))
    )
    const failed = results.find(r => r.status === 'rejected')
    if (failed) throw failed.reason
}

export function registerRecoveryTurns(pi: ExtensionAPI): void {
    const post = (text: string): boolean => {
        try {
            pi.sendUserMessage(text, {deliverAs: 'followUp'})
            posted = text
            return true
        } catch (err) {
            if (!isStaleCtxError(err)) throw err
            return false
        }
    }

    pi.on('agent_settled', async (_event, ctx) => {
        recovering = false
        vetoed = false
        if (queued.length > 0 && post(queued.splice(0).join('\n\n'))) return
        await turnOver(ctx)
    })
    // pi reports a failed deferred prompt to no extension. Another prompt arriving
    // first is the proof that ours never ran.
    pi.on('input', async (event, ctx) => {
        if (posted === undefined || event.text === posted) return
        posted = undefined
        await turnOver(ctx)
    })
    pi.on('agent_start', () => {
        if (posted === undefined) return
        posted = undefined
        recovering = true
        progressed = false
    })
    pi.on('tool_execution_end', event => {
        if (recovering && !event.isError) progressed = true
    })
    // A reminder for a session that is gone must not land in its replacement.
    pi.on('session_shutdown', forgetRecoveryTurn)
}
