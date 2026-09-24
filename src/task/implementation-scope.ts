/**
 * The implementation-turn bracket: one entry arms the status widget and the
 * runaway guard and takes custody of the task dir, one `leave` ends all three.
 *
 * The bracket, not each module, decides when a fire-and-forget turn ends, and it
 * ends all three at once: a missed disarm on any one outlives the turn. Commit
 * ebac475 added a third disarm site for one path that was covered on the widget
 * and not the guard.
 */

import type {ExtensionContext} from '@earendil-works/pi-coding-agent'
import {notifyRun} from '../remote/bridge.js'
import {armImplWidget, disarmImplWidget, type ImplWidgetMeta} from './impl-widget.js'
import {armImplementationGuard, disarmImplementationGuard} from './implementation-guards.js'
import {forgetRecoveryTurn, offTurnOver, onTurnOver} from './recovery-turn.js'
import {takeTaskDirCustody, taskDirRestoredNotice} from './task-dir-custody.js'

const TURN_OVER_KEY = 'implementation-scope'

/**
 * `oneShot` true (fire-and-forget /task) ends the bracket when the turn is over,
 * recovery turns included (recovery-turn.ts); false (awaited /task-auto) keeps it
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
    forgetRecoveryTurn()
    const releaseTaskDir = await takeTaskDirCustody(opts.cwd)
    armImplWidget(meta)
    armImplementationGuard()
    let left = false
    const leave = async (): Promise<string[]> => {
        if (left) return []
        left = true
        offTurnOver(TURN_OVER_KEY, endOneShot)
        disarmImplWidget()
        disarmImplementationGuard()
        return releaseTaskDir()
    }
    // pi awaits the hook before the next run starts, so the restore finishes
    // before that run can write anything.
    async function endOneShot(ctx: ExtensionContext): Promise<void> {
        const restored = await leave()
        if (restored.length > 0) {
            notifyRun(ctx, taskDirRestoredNotice('The implementation turn', restored), 'warning')
        }
    }
    // Always replaced: an earlier one-shot's hook would end this bracket.
    if (opts.oneShot) onTurnOver(TURN_OVER_KEY, endOneShot)
    else offTurnOver(TURN_OVER_KEY)
    return leave
}
