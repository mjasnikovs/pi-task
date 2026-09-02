/**
 * The implementation-turn bracket: one entry arms both the status widget and the
 * runaway guard, one `leave` disarms both.
 *
 * The two modules keep their own lifecycle handlers, and they draw the turn
 * boundary differently on purpose: the widget hides on `agent_end` (a sub-turn is
 * over, the screen should say so), the guard survives until `agent_settled`
 * (compactions and retries fire `agent_end` INSIDE a turn — see its header). What
 * they share is the caller's decision — when to arm, and on which paths to disarm
 * — and a missed disarm on either one outlives the turn: commit ebac475 added a
 * third disarm site for one path that was covered on the widget and not the guard.
 */

import {armImplWidget, disarmImplWidget, type ImplWidgetMeta} from './impl-widget.js'
import {armImplementationGuard, disarmImplementationGuard} from './implementation-guards.js'

/**
 * `oneShot` true (fire-and-forget /task) lets each module's own settle handler
 * disarm after the single turn; false (awaited /task-auto) keeps both armed
 * across resume and steer turns until `leave` is called.
 *
 * `leave` is idempotent: a second call is a no-op, so a caller can put it in a
 * `finally` and a `catch` without disarming a bracket entered since.
 */
export function enterImplementationTurn(
    meta: ImplWidgetMeta,
    opts: {oneShot: boolean}
): () => void {
    armImplWidget(meta, opts)
    armImplementationGuard(opts)
    let left = false
    return () => {
        if (left) return
        left = true
        disarmImplWidget()
        disarmImplementationGuard()
    }
}
