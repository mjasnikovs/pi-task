/**
 * Command watchdog — the per-tool-call wall-clock machine, shared by both
 * surfaces that can run a command which never returns.
 *
 * WHY THIS LIVES IN shared/: pi's bash tool takes an OPTIONAL `timeout` with NO
 * default (pi-coding-agent core/tools/bash.js), so ANY command the model didn't
 * bound runs forever. That is true in two places, and they are disjoint:
 *
 *   MAIN SESSION — the implementation turn, handed off via sendUserMessage
 *                  (task/orchestrator.ts). Guarded by registerCommandWatchdog
 *                  in task/command-watchdog.ts.
 *   CHILD pi     — the verify / lint-fix / recommend / final-fix gate children
 *                  (task/gate-deps.ts). Children are spawned `--no-extensions`
 *                  (CHILD_BASE_ARGS), so the host's extension-event watchdog
 *                  cannot see them at all. Guarded inside runWorker.
 *
 * Neither registration can cover the other's surface, so both exist — but the
 * TIMER STATE MACHINE is identical, and lives here once. What differs is only
 * the `onFire` side effect, which each adapter supplies:
 *
 *   main session — ctx.abort() cancels just that tool call and the session
 *                  survives to receive a follow-up reminder turn.
 *   child        — there is no per-tool cancellation channel into a child, so
 *                  the whole child is killed and re-spawned with
 *                  {@link commandTimeoutHint} prepended. Coarser by necessity:
 *                  the child's accumulated context is lost.
 */

/** Opaque timer handle — a real `setTimeout` return in production, anything the
 *  test's fake scheduler hands back under test. */
export type TimerHandle = unknown

export interface WatchdogDeps {
    /**
     * The ceiling in ms, read PER command-start. How live that read is depends
     * on the adapter: the main session passes a config read, so a /task-config
     * change takes effect on the next command with no reload; the child adapter
     * passes a constant frozen per attempt (the halved ceiling), so there a
     * config change lands at the next attempt/gate, not the next command.
     * 0 (or any non-positive value) means the watchdog is off and never arms.
     */
    getTimeoutMs: () => number
    schedule: (fn: () => void, ms: number) => TimerHandle
    cancel: (handle: TimerHandle) => void
    /** Invoked when a command overruns: each adapter aborts/kills here. */
    onFire: (toolCallId: string, toolName: string, timeoutMs: number) => void
}

/** Whole minutes, floored at 1, for the human-facing ceiling in both messages. */
function minutes(timeoutMs: number): string {
    const mins = Math.max(1, Math.round(timeoutMs / 60_000))
    return `${mins} minute${mins === 1 ? '' : 's'}`
}

/**
 * The core correction, shared by both adapters' messages. Two jobs, both
 * learned from live runs: stop the model reporting a killed command as a
 * success, and name the ONE mechanism that prevents a repeat (the bash tool's
 * own `timeout` parameter) rather than leaving "be faster" as the takeaway.
 */
function correction(): string {
    return (
        `The command was killed before it finished and produced NO result, so do not `
        + `report it as completed or successful, and do not claim that anything it would `
        + `have started (a server, build, or process) is now running. `
        + `If it was a genuinely long-running command, you MUST re-run it with an explicit `
        + `timeout — set the bash tool's \`timeout\` parameter (in seconds) so it cannot hang `
        + `again — or break it into smaller steps. Do NOT simply retry the same unbounded command.`
    )
}

/**
 * Stable substring of {@link reminderMessage}, used by the steer loop
 * (orchestrator steerUntilDone) to recognise the watchdog's follow-up turn in
 * the session entries — the artifact that distinguishes a watchdog abort from a
 * human ESC. Interpolated into the message so the detector and the text cannot
 * drift apart.
 */
export const WATCHDOG_CANCEL_MARKER = 'was automatically cancelled — it looked stuck.'

/**
 * MAIN-SESSION reminder, delivered as a follow-up turn after ctx.abort() has
 * cancelled the offending tool call. The session is still alive and remembers
 * the call, so this addresses it in the second person, present tense.
 */
export function reminderMessage(toolName: string, timeoutMs: number): string {
    return (
        `[SYSTEM] Your \`${toolName}\` call ran longer than ${minutes(timeoutMs)} `
        + `and ${WATCHDOG_CANCEL_MARKER} `
        + correction()
    )
}

/**
 * CHILD restart hint, prepended to the prompt of a re-spawned gate child. The
 * killed child is GONE — this one never saw the command — so it is framed as
 * "your previous attempt" and names the command, which the fresh child would
 * otherwise have no way to know it must avoid repeating unbounded.
 *
 * `editsMayPersist` — set for a write-capable child (edit/write tools, or bash,
 * whose commands have side effects). Nothing reverts the working tree between
 * attempts, so telling such a child its previous attempt was "discarded" is
 * false: partial edits and command side effects survive the kill, and a fresh
 * child that believes it starts clean may re-apply them or misread the tree.
 * Only the CONVERSATION is gone; the hint must say so precisely.
 *
 * Replaces the generic worker-timeout hint for this case: that one blames
 * "exploring too long", which is the wrong diagnosis for a hung command and
 * never mentions the timeout parameter.
 */
export function commandTimeoutHint(
    toolName: string,
    timeoutMs: number,
    opts?: {commandDetail?: string; editsMayPersist?: boolean}
): string {
    const what = opts?.commandDetail ? ` (${opts.commandDetail})` : ''
    const aftermath =
        opts?.editsMayPersist ?
            `killed and that attempt's conversation was discarded — you are starting over, `
            + `BUT any file edits or command side effects it made before the kill are still `
            + `in the working tree. Check the current state of files before assuming they `
            + `are untouched or re-applying changes. `
        :   `killed and that attempt was discarded — you are seeing this task again from `
            + `the start. `
    return (
        `[SYSTEM NOTE: Your previous attempt ran a \`${toolName}\` command${what} that had not `
        + `returned after ${minutes(timeoutMs)}, so it was `
        + aftermath
        + correction()
        + `]`
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

    /** Cancel every armed timer — a turn-end / session-shutdown / child-exit
     *  safety net so no stray timer can fire into a later, unrelated command. */
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
 * Real-clock schedule/cancel. Shared by both adapters; tests substitute a fake
 * scheduler instead.
 *
 * REF'd, for the same measured reason as the stream watchdog's poll (see
 * realStreamTimerDeps): under Bun on windows an unref'd timer never fires once
 * nothing ref'd is pending, and a child sitting in a hung command is exactly
 * that state — so the unref disabled the guard in the one case it exists for.
 * The timer is cleared when the tool ends and in runWorker's `finally`, so it
 * cannot outlive the call it watches.
 */
export const realTimerDeps: Pick<WatchdogDeps, 'schedule' | 'cancel'> = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}
