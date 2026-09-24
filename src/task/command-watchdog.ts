import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {SELF_BOUNDED_TOOLS} from '../config/tool-list.js'
import {CommandWatchdog, realTimerDeps, reminderMessage} from '../shared/command-watchdog.js'
import {queueRecoveryTurn} from './recovery-turn.js'
import {isStaleCtxError} from './stale-ctx.js'

/**
 * MAIN-SESSION adapter for the command watchdog.
 *
 * WHY: a local model in the MAIN session routinely runs a command that never
 * returns — `godot --headless --check-only` with no timeout, a dev server, a
 * hung test — and the run wedges until the user manually aborts and tells the
 * model to add a timeout. pi's bash tool takes an OPTIONAL `timeout` with NO
 * default: its schema in `core/tools/bash.js` says "optional, no default
 * timeout" and its resolver returns undefined for an absent value, so no timer is
 * ever armed. This supplies the missing default from the host side.
 *
 * HOW: arm a wall-clock timer on `tool_execution_start`, disarm it on
 * `tool_execution_end` — both real pi events. If it elapses, `ctx.abort()`
 * cancels the in-flight operation, which fires the tool's AbortSignal; pi's bash
 * executor imports `killProcessTree` and its own comment on that listener reads
 * "Handle abort signal by killing the entire process tree". Once the aborted run
 * settles, a follow-up user turn tells the model what happened so it retries with a
 * timeout instead of hanging again (see recovery-turn.ts).
 *
 * Tool-agnostic by default: it arms on every tool except exact names listed in
 * `commandTimeoutExemptTools`, which /task-config fills from the live tool list
 * (config/tool-list.ts), and pi-task's own SELF_BOUNDED_TOOLS, exempt in code.
 * Exemptions are for tools that already own a bounded timeout and cancellation
 * contract — the guard's whole justification is that pi's bash has NO default
 * timeout, which says nothing about a tool that does.
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
    WATCHDOG_CANCEL_MARKER,
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
        shouldWatch: toolName =>
            !SELF_BOUNDED_TOOLS.has(toolName)
            && !getConfig().commandTimeoutExemptTools.includes(toolName),
        ...realTimerDeps,
        onFire: (toolCallId, toolName, timeoutMs) => {
            const ctx = ctxByCall.get(toolCallId)
            ctxByCall.delete(toolCallId)
            // Cancel the stuck command (kills the tool's whole process tree via
            // the turn's AbortSignal), then, once that run settles, start a fresh
            // turn telling the model to bound its next attempt.
            if (ctx) {
                try {
                    ctx.abort()
                } catch (err) {
                    // Timer fired after session replacement/reload: the captured ctx
                    // is stale by design (Pi invalidates it in AgentSession.dispose).
                    // Swallow only that guard; anything else keeps throwing, and no
                    // follow-up is posted into the replacement session.
                    if (!isStaleCtxError(err)) throw err
                    return
                }
            }
            queueRecoveryTurn(reminderMessage(toolName, timeoutMs))
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
