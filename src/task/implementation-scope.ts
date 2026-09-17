/**
 * The implementation-turn bracket: one entry arms the status widget and the
 * runaway guard and takes custody of the task dir, one `leave` ends all three.
 *
 * Each module keeps its own lifecycle handlers, and the first two draw the turn
 * boundary differently on purpose: the widget hides on `agent_end` (a sub-turn is
 * over, the screen should say so), the guard survives until `agent_settled`
 * (compactions and retries fire `agent_end` INSIDE a turn — see its header). What
 * they share is the caller's decision — when to arm, and on which paths to disarm
 * — and a missed disarm on either one outlives the turn: commit ebac475 added a
 * third disarm site for one path that was covered on the widget and not the guard.
 */

import {armImplWidget, disarmImplWidget, type ImplWidgetMeta} from './impl-widget.js'
import {armImplementationGuard, disarmImplementationGuard} from './implementation-guards.js'
import {takeTaskDirCustody} from './task-dir-custody.js'

/**
 * `oneShot` true (fire-and-forget /task) lets each module's own settle handler
 * end it after the single turn; false (awaited /task-auto) keeps all three
 * across resume and steer turns until `leave` is called.
 *
 * `leave` is idempotent: a second call is a no-op, so a caller can put it in a
 * `finally` and a `catch` without ending a bracket entered since. It resolves to
 * the task files it restored.
 */
export async function enterImplementationTurn(
    meta: ImplWidgetMeta,
    opts: {oneShot: boolean; cwd: string}
): Promise<() => Promise<string[]>> {
    const {oneShot} = opts
    const releaseTaskDir = await takeTaskDirCustody(opts.cwd, {oneShot})
    armImplWidget(meta, {oneShot})
    armImplementationGuard({oneShot})
    let left = false
    return async () => {
        if (left) return []
        left = true
        disarmImplWidget()
        disarmImplementationGuard()
        return releaseTaskDir()
    }
}
