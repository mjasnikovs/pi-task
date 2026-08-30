import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {
    realStreamTimerDeps,
    StreamWatchdog,
    streamStallReminder
} from '../shared/stream-watchdog.js'
import {noteWatchdogAbort, WATCHDOG_CANCEL_MARKER} from './command-watchdog.js'

/**
 * MAIN-SESSION adapter for the model-stream watchdog.
 *
 * WHY: a turn can die mid-stream — the last thing recorded is an ordinary
 * assistant message, then silence forever, with the model endpoint still up.
 * Nothing throws for that shape, so the connection-error retry (which needs a
 * reported ModelError) cannot fire, and the command watchdog only covers tool
 * executions, so it never arms. Without this the session sits dead until a human
 * notices.
 *
 * HOW: pi's extension events ARE the stream. Any of them — a token delta, a
 * thinking delta, a tool-call delta, the provider's response headers — resets the
 * idle clock; only total silence for the configured window fires. On fire the turn
 * is aborted and a follow-up user turn tells the model to CONTINUE from the
 * transcript (its completed tool calls and results are already recorded, so a
 * blind re-send would re-run them).
 *
 * ONE ABORT CHANNEL: the fire path goes through the command watchdog's existing
 * {@link noteWatchdogAbort} flag and its WATCHDOG_CANCEL_MARKER, so the abort/steer
 * race steerUntilDone already handles covers this watchdog too, instead of racing a
 * second, parallel abort mechanism.
 *
 * SUSPENDED DURING TOOLS: while a tool executes the model stream is legitimately
 * idle — a long build emits nothing on it. That window belongs to the command
 * watchdog (requestTimeoutMs); this one pauses between tool_execution_start and
 * tool_execution_end so the two can never double-fire on the same silence.
 *
 * SCOPE: main session only. Children run `--no-extensions` (CHILD_BASE_ARGS), so
 * none of these events reaches them; their equivalent guard is a second
 * `StreamWatchdog` inside runChild (shared/child-process.ts), on the same
 * machine.
 */
export function registerStreamWatchdog(pi: ExtensionAPI): void {
    // The ctx whose abort() ends the in-flight turn, refreshed on every event so
    // the fire (which happens outside any handler) aborts the CURRENT operation.
    let liveCtx: ExtensionContext | undefined

    const watchdog = new StreamWatchdog({
        getTimeoutMs: () => getConfig().streamInactivityMs,
        ...realStreamTimerDeps,
        onFire: idleMs => {
            const ctx = liveCtx
            liveCtx = undefined
            // Flag BEFORE the abort, exactly as the command watchdog does: the
            // steer loop can otherwise observe the 'aborted' turn first and show
            // a steering prompt to an empty room, wedging an unattended run.
            if (ctx) {
                noteWatchdogAbort()
                ctx.abort()
            }
            pi.sendUserMessage(streamStallReminder(idleMs, WATCHDOG_CANCEL_MARKER), {
                deliverAs: 'followUp'
            })
        }
    })

    // Any event proves the stream is alive. `arm` also (re)starts the machine, so
    // a request that begins after a previous turn ended is watched again without
    // needing a single canonical "request started" event.
    const arm = (ctx?: ExtensionContext): void => {
        if (ctx) liveCtx = ctx
        watchdog.start()
        watchdog.note()
    }

    pi.on('before_provider_request', (_e, ctx) => arm(ctx))
    pi.on('after_provider_response', (_e, ctx) => arm(ctx))
    pi.on('turn_start', (_e, ctx) => arm(ctx))
    pi.on('message_start', (_e, ctx) => arm(ctx))
    pi.on('message_update', (_e, ctx) => arm(ctx))
    pi.on('message_end', (_e, ctx) => arm(ctx))

    // Keyed by toolCallId: a tool BATCH runs in parallel, so the clock must stay
    // paused until the last call settles, not the first (see StreamWatchdog.resume).
    const callId = (e: unknown): string | undefined => {
        const id = (e as {toolCallId?: unknown} | undefined)?.toolCallId
        return typeof id === 'string' && id.length > 0 ? id : undefined
    }

    pi.on('tool_execution_start', (e, ctx) => {
        liveCtx = ctx
        watchdog.suspend(callId(e))
    })
    pi.on('tool_execution_update', (_e, ctx) => {
        liveCtx = ctx
    })
    pi.on('tool_execution_end', (e, ctx) => {
        liveCtx = ctx
        watchdog.resume(callId(e))
    })

    // Nothing is streaming between agent loops; stop so no timer can fire into an
    // idle session (which would abort nothing and post a reminder to no one).
    const stop = (): void => {
        watchdog.stop()
        liveCtx = undefined
    }
    pi.on('agent_end', stop)
    pi.on('session_shutdown', stop)
}
