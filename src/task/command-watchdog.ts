import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'

/**
 * Command watchdog — cancels a single tool execution that overruns the
 * configured ceiling and reminds the model to bound its own commands.
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
 * though in practice only bash runs long enough to trip it. The pure timer
 * state lives in {@link CommandWatchdog}; all side effects (abort, reminder,
 * per-call ctx lookup) live in the registration's `onFire`, so the machine is
 * unit-testable without a real pi session.
 */

/** Opaque timer handle — a real `setTimeout` return in production, anything the
 *  test's fake scheduler hands back under test. */
export type TimerHandle = unknown

export interface WatchdogDeps {
    /**
     * The ceiling in ms, read PER command-start so a /task-config change takes
     * effect on the next command with no reload. 0 (or any non-positive value)
     * means the watchdog is off and never arms.
     */
    getTimeoutMs: () => number
    schedule: (fn: () => void, ms: number) => TimerHandle
    cancel: (handle: TimerHandle) => void
    /** Invoked when a command overruns: the registration aborts + reminds here. */
    onFire: (toolCallId: string, toolName: string, timeoutMs: number) => void
}

/**
 * The reminder delivered to the model after its command is cancelled. Kept pure
 * and exported so a test can assert its shape without driving the whole session.
 */
export function reminderMessage(toolName: string, timeoutMs: number): string {
    const mins = Math.max(1, Math.round(timeoutMs / 60_000))
    return (
        `[SYSTEM] Your \`${toolName}\` call ran longer than ${mins} minute`
        + `${mins === 1 ? '' : 's'} and was automatically cancelled — it looked stuck. `
        // Anti-fabrication: a live run showed the model react to the cancel by
        // reporting the killed command as succeeded ("the server is now running").
        // State plainly that it produced nothing so the model can't claim success.
        + `The command was killed before it finished and produced NO result, so do not `
        + `report it as completed or successful, and do not claim that anything it would `
        + `have started (a server, build, or process) is now running. `
        + `If it was a genuinely long-running command, you MUST re-run it with an explicit `
        + `timeout — set the bash tool's \`timeout\` parameter (in seconds) so it cannot hang `
        + `again — or break it into smaller steps. Do NOT simply retry the same unbounded command.`
    )
}

export class CommandWatchdog {
    /** Armed timers, keyed by the tool call they guard. Tool executions are
     *  sequential, so this holds at most one entry in normal operation, but the
     *  map keeps it correct even if pi ever overlaps two calls. */
    private readonly active = new Map<string, TimerHandle>()

    constructor(private readonly deps: WatchdogDeps) {}

    /** Arm a timer for a starting tool. No-op when the watchdog is off. */
    onStart(toolCallId: string, toolName: string): void {
        const ms = this.deps.getTimeoutMs()
        if (!(ms > 0)) return
        // A duplicate start for the same id must not leak the previous timer.
        this.disarm(toolCallId)
        const handle = this.deps.schedule(() => this.fire(toolCallId, toolName, ms), ms)
        this.active.set(toolCallId, handle)
    }

    /** Disarm the timer for a finished tool. */
    onEnd(toolCallId: string): void {
        this.disarm(toolCallId)
    }

    /** Cancel every armed timer — a turn-end / session-shutdown safety net so no
     *  stray timer can fire into a later, unrelated command. */
    clearAll(): void {
        for (const handle of this.active.values()) this.deps.cancel(handle)
        this.active.clear()
    }

    private disarm(toolCallId: string): void {
        const handle = this.active.get(toolCallId)
        if (handle !== undefined) {
            this.deps.cancel(handle)
            this.active.delete(toolCallId)
        }
    }

    private fire(toolCallId: string, toolName: string, ms: number): void {
        // If the tool ended in the same tick the timer fired, its entry is gone
        // already — never abort a command that has just finished cleanly.
        if (!this.active.has(toolCallId)) return
        this.active.delete(toolCallId)
        this.deps.onFire(toolCallId, toolName, ms)
    }
}

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
        schedule: (fn, ms) => {
            const handle = setTimeout(fn, ms)
            // Don't let a pending watchdog timer keep the process alive on exit.
            if (typeof (handle as {unref?: () => void}).unref === 'function') {
                ;(handle as {unref: () => void}).unref()
            }
            return handle
        },
        cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
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
