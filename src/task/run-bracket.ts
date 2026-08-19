/**
 * The run bracket: what "a command owns the session" MEANS, in one place.
 *
 * Every long-running command — `/task`, `/task-auto`, `/task-auto-resume`,
 * `/task-plan`, and `TaskRunner.run` inside all of them — spends most of its
 * life with the host session idle: the spec phases, the planning children and
 * every gate are child `pi` processes, not host turns. Two things must be true
 * for exactly that window, and both are refcounted because the runs nest
 * (`/task-auto` brackets its loop, each task inside brackets its own run):
 *
 *   1. mid-run input is HELD, not queued or turned into a competing turn
 *      (`mid-run-input.ts`: `beginRun`/`endRun`);
 *   2. the raw-stdin interception that makes the terminal behave like the
 *      browser is ARMED (`cancel-input.ts`: `armCancelListener`/`disarm…`).
 *
 * Before this module the pair — begin, arm, … finally disarm, end, report the
 * dropped lines — was written out at four sites in two files, and the `finally`
 * halves disagreed on order (the orchestrator disarmed first; `/task-auto` ended
 * first). The order is not observable — both halves are synchronous, the
 * listener only consults `isRunActive()` on a keystroke, and no keystroke can
 * land between two statements of one tick — so there is ONE order here, not an
 * option: stop listening, then release the hold and report what it dropped.
 *
 * The two refcounts stay two, deliberately. `runDepth` is read by the remote
 * bridge (`isRunActive`) with no ctx in hand and by the listener itself;
 * `armed.depth` guards a live stdin subscription that is re-pointed on every
 * session replacement (`rearmCancelListener`) and is armed on its own by the
 * cancel-latency harness and cancel-points tests. Collapsing them means one
 * module's counter driving the other's lifecycle, or a third counter with both
 * modules demoted to flags — a wider change than the drift it prevents. What
 * prevents drift now is that this bracket is the ONLY production caller of
 * either pair.
 */
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {armCancelListener, disarmCancelListener} from './cancel-input.js'
import {beginRun, endRun} from './mid-run-input.js'
import {reportDroppedInput} from './dropped-input.js'
import {publishLifecycleNotice} from '../remote/bridge.js'
import {pushNotify} from '../remote/push.js'

export interface RunBracketOptions {
    /**
     * Delivered when `/task-auto-cancel` is typed mid-run, with the ctx the
     * listener is currently installed on (the captured one goes stale the moment
     * a task replaces the session). The FIRST run to pass one wins for the whole
     * nest — `/task-auto` passes one so its acknowledgement posts through the
     * live ctx; a plain `/task` passes none and lets the generic bridge dispatch
     * handle the command like any other.
     */
    onCancel?: (live: ExtensionCommandContext) => void
}

/**
 * Run `fn` as the owner of the session: hold mid-run input and arm the terminal
 * interception for exactly its duration, then release both — on return AND on
 * throw — and tell the user about any held line that never found a turn.
 * Nests: an inner bracket neither re-renders the surfaces nor un-arms the outer.
 */
export async function withRun<T>(
    ctx: ExtensionCommandContext,
    opts: RunBracketOptions,
    fn: () => Promise<T>
): Promise<T> {
    beginRun()
    armCancelListener(ctx, opts.onCancel)
    try {
        return await fn()
    } finally {
        disarmCancelListener()
        reportDroppedInput(endRun(), ctx)
    }
}

export type AnnounceLevel = 'info' | 'warning' | 'error'

export interface AnnounceOptions {
    /**
     * Also send a web push ("Task finished") to backgrounded devices. Default
     * true — a run's terminal outcome is what a phone left on the desk needs to
     * hear. `/task-plan` passes false: its cancelled/failed endings are the end
     * of a CONVERSATION, before any task exists, and the plan that does hand off
     * gets the run's own push from `/task`.
     */
    push?: boolean
}

/**
 * Say how a run ended, once, on every surface: the terminal toast, the remote
 * session view (an error becomes a persistent red bubble; the rest a transient
 * notify), and — unless opted out — a web push whose body is the exact terminal
 * message, so a backgrounded phone learns the same thing the TUI shows.
 *
 * Terminal points ONLY: the overall `/task-auto` outcome, `/task`'s outcome
 * after its gates, `/task-plan`'s failed or cancelled ending. Never per internal
 * task — those run through `runSingleTask` without `notifyFinish` and stay
 * silent.
 */
export function announceTerminal(
    ctx: ExtensionCommandContext,
    message: string,
    level: AnnounceLevel,
    opts: AnnounceOptions = {}
): void {
    ctx.ui.notify(message, level)
    // ctx.ui.notify is terminal-only and pushNotify is a backgrounded-device web
    // push — neither shows up in a remote viewer that's watching live.
    publishLifecycleNotice(message, level)
    if (opts.push !== false) void pushNotify('Task finished', message, 'pi-end').catch(() => {})
}
