import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {CommandWatchdog, realTimerDeps, reminderMessage} from '../shared/command-watchdog.js'

/**
 * MAIN-SESSION adapter for the command watchdog.
 *
 * WHY: a local model in the MAIN session routinely runs a command that never
 * returns — `godot --headless --check-only` with no timeout, a dev server, a
 * hung test — and the run wedges until the user manually aborts and tells the
 * model to add a timeout. pi's bash tool takes an OPTIONAL `timeout` with NO
 * default (see pi-coding-agent tools/bash.js), so any command the model didn't
 * bound runs forever. This supplies the missing default from the host side.
 *
 * HOW: arm a wall-clock timer on `tool_execution_start`, disarm it on
 * `tool_execution_end`. If it elapses, `ctx.abort()` cancels the in-flight
 * operation — which fires the tool's AbortSignal, and pi's bash executor kills
 * the whole process tree on abort — then a follow-up user turn tells the model
 * what happened so it retries with a timeout instead of hanging again.
 *
 * Tool-agnostic: it arms on ANY tool, honouring "any command can run forever",
 * though in practice only bash runs long enough to trip it.
 *
 * SCOPE — this covers the main session ONLY, which is where the implementation
 * turn runs (orchestrator hands the spec off via sendUserMessage). Gate
 * children are spawned `--no-extensions`, so no host extension exists inside
 * them; their equivalent guard lives in runWorker (workers/pi-worker-core.ts)
 * and shares the same machine from shared/command-watchdog.ts.
 */

// Re-exported so existing importers (and the machine's own tests) keep their
// entry point while the implementation lives in shared/.
export {
    CommandWatchdog,
    commandTimeoutHint,
    realTimerDeps,
    reminderMessage,
    type TimerHandle,
    type WatchdogDeps
} from '../shared/command-watchdog.js'

/**
 * Wire the watchdog into the main session. Only ever active in the host session
 * (children run `--no-extensions`), which is exactly where the observed hangs
 * happen.
 */
export function registerCommandWatchdog(pi: ExtensionAPI): void {
    // The ctx that owns each in-flight tool's AbortSignal, captured per start so
    // the timer callback (which fires outside the event handler) aborts the
    // right operation.
    const ctxByCall = new Map<string, ExtensionContext>()

    const watchdog = new CommandWatchdog({
        getTimeoutMs: () => getConfig().requestTimeoutMs,
        ...realTimerDeps,
        onFire: (toolCallId, toolName, timeoutMs) => {
            const ctx = ctxByCall.get(toolCallId)
            ctxByCall.delete(toolCallId)
            // Cancel the stuck command (kills the tool's whole process tree via
            // the turn's AbortSignal), then start a fresh turn telling the model
            // to bound its next attempt.
            ctx?.abort()
            pi.sendUserMessage(reminderMessage(toolName, timeoutMs), {deliverAs: 'followUp'})
        }
    })

    pi.on('tool_execution_start', (event, ctx) => {
        ctxByCall.set(event.toolCallId, ctx)
        watchdog.onStart(event.toolCallId, event.toolName)
    })
    pi.on('tool_execution_end', event => {
        ctxByCall.delete(event.toolCallId)
        watchdog.onEnd(event.toolCallId)
    })

    // Safety net: nothing should outlive its turn, but if a start ever lacks a
    // matching end, clear on turn/session teardown so no timer fires stale.
    const reset = (): void => {
        watchdog.clearAll()
        ctxByCall.clear()
    }
    pi.on('turn_end', reset)
    pi.on('session_shutdown', reset)
}
