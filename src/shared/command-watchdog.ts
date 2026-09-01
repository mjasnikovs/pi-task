/**
 * Command watchdog — the per-tool-call wall-clock machine, shared by both
 * surfaces that can run a command which never returns.
 *
 * WHY THIS LIVES IN shared/: pi's bash tool takes an OPTIONAL `timeout` and has
 * no default for it. Its schema says so in as many words — "Timeout in seconds
 * (optional, no default timeout)" — and its resolver returns `undefined` for an
 * absent value, which skips arming any timer at all. So ANY command the model
 * did not bound itself runs forever. That is true in two places, and they are
 * disjoint:
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
 *   main session — ctx.abort() ends the whole agent operation, not just the one
 *                  tool call (pi types it "Abort the current agent operation"),
 *                  and pi's agent defaults `toolExecution` to "parallel", so
 *                  siblings really are in flight together. An
 *                  overrun kills every tool in flight in that turn — including
 *                  one exempted via commandTimeoutExemptTools, which only stops
 *                  a timer being armed FOR that tool, not its being collateral
 *                  when a guarded sibling trips. There is no per-call
 *                  cancellation channel to do better with. The session itself
 *                  survives to receive the follow-up reminder turn.
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
    /** Optional exact policy for tools with their own bounded execution contract. */
    shouldWatch?: (toolName: string) => boolean
    schedule: (fn: () => void, ms: number) => TimerHandle
    cancel: (handle: TimerHandle) => void
    /** Invoked when a command overruns: each adapter aborts/kills here. */
    onFire: (toolCallId: string, toolName: string, timeoutMs: number) => void
}

/** Whole minutes for the human-facing ceiling in both messages: rounded to
 *  nearest, then floored at 1 so a sub-minute ceiling never reads "0 minutes". */
function minutes(timeoutMs: number): string {
    const mins = Math.max(1, Math.round(timeoutMs / 60_000))
    return `${mins} minute${mins === 1 ? '' : 's'}`
}

/**
 * The core correction, shared by both adapters' messages. Two jobs: stop the
 * model reporting a killed command as a success, and name the one mechanism
 * that prevents a repeat — the bash tool's own `timeout` parameter — rather
 * than leaving "be faster" as the takeaway.
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
 * (implementation-turn steerUntilDone) to recognise the watchdog's follow-up turn in
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
 * Used instead of the generic worker-timeout hint, which blames the child for
 * "exploring too long" — the wrong diagnosis for a hung command, and one that
 * never mentions the `timeout` parameter that would prevent it.
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
    /** Armed timers, keyed by the tool call they guard. A map rather than one
     *  handle because pi's agent defaults `toolExecution` to "parallel": a batch
     *  of sibling calls is genuinely in flight together, so several timers can be
     *  armed at once and each must be cancelled by its own id. */
    private readonly active = new Map<string, TimerHandle>()

    constructor(private readonly deps: WatchdogDeps) {}

    /** Arm a timer for a starting tool. No-op when the watchdog is off. */
    onStart(toolCallId: string, toolName: string): void {
        // Disarm first so a live policy/config change cannot leave a timer from
        // a duplicate start armed after the tool becomes exempt or watchdog-off.
        this.disarm(toolCallId)
        if (this.deps.shouldWatch?.(toolName) === false) return
        const ms = this.deps.getTimeoutMs()
        if (!(ms > 0)) return
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
 * REF'd deliberately, and NOT unref'd. Measured on this platform, on both
 * runtimes: an unref'd timer with nothing else ref'd and pending never fires at
 * all — the process simply exits — while the identical ref'd timer does. A
 * watchdog whose whole job is to fire while everything else is stuck cannot
 * afford that. Holding the loop open is safe here because the timer is cancelled
 * when the tool ends and again in runWorker's `finally`, so it cannot outlive
 * the call it watches.
 */
export const realTimerDeps: Pick<WatchdogDeps, 'schedule' | 'cancel'> = {
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** What the command watchdog recorded when it killed a child attempt. */
export interface CommandKill {
    toolName: string
    timeoutMs: number
    /** The command line itself, when the tool carried one — quoted into the hint
     *  so the fresh child knows which call it must not repeat unbounded. */
    detail?: string
}

/**
 * The tool-call fields the child-side watchdog reads. Structural rather than
 * `ToolCall` from child-process.ts, so this module keeps its zero imports and a
 * caller cannot be forced to reach for the runner's types to arm a timer.
 */
export interface WatchedToolCall {
    name: string
    toolCallId?: string
    args: unknown
}

/**
 * Build the child-side command watchdog for ONE attempt: a per-tool-call timer
 * machine whose `onFire` aborts `signal`, which runChild turns into a
 * process-GROUP kill — reaping the hung command itself, not just the pi child
 * holding it.
 *
 * LIMIT: the group kill only reaches processes still IN the group. A hung command
 * that detached a daemon (setsid, nohup, a background dev server) leaves it
 * running, so the fresh attempt can hit a port the dead attempt's escapee still
 * holds. There is no cheap fix from here; the restart hint's "check current state"
 * line is the mitigation.
 *
 * Returns null when the watchdog is off, so the caller keeps the plain timeout
 * signal and no per-call bookkeeping happens at all.
 */
export function commandWatch(timeoutMs: number): {
    onStart: (call: WatchedToolCall) => void
    onEnd: (toolCallId: string | undefined) => void
    killed: () => CommandKill | undefined
    signal: AbortSignal
    clear: () => void
} | null {
    if (!(timeoutMs > 0)) return null
    const ctrl = new AbortController()
    // pi's toolCallId pairs start↔end. When it is absent (a fake stream in a
    // test, an older pi), fall back to one shared slot: tool executions in a
    // child are sequential, so a single slot is still correctly paired.
    const key = (id: string | undefined): string => id ?? 'anon'
    const details = new Map<string, string>()
    let killed: CommandKill | undefined

    const watchdog = new CommandWatchdog({
        getTimeoutMs: () => timeoutMs,
        ...realTimerDeps,
        onFire: (toolCallId, toolName, ms) => {
            killed = {
                toolName,
                timeoutMs: ms,
                ...(details.has(toolCallId) ? {detail: details.get(toolCallId)!} : {})
            }
            ctrl.abort()
        }
    })

    return {
        onStart: call => {
            const id = key(call.toolCallId)
            const args = call.args as {command?: unknown} | undefined
            if (typeof args?.command === 'string') {
                details.set(id, args.command.slice(0, 120))
            }
            watchdog.onStart(id, call.name)
        },
        onEnd: id => {
            // Drop the command line with its call. The `'anon'` fallback above is a
            // SHARED slot, so a stale entry would be attributed to whatever ran
            // next: a `read` that later overran would be reported as
            // "ran a `read` command (bun run dev)".
            details.delete(key(id))
            watchdog.onEnd(key(id))
        },
        killed: () => killed,
        signal: ctrl.signal,
        clear: () => watchdog.clearAll()
    }
}

/**
 * The per-command ceiling for attempt N, halving each time a hang recurs.
 *
 * The first attempt gets the full configured ceiling — a genuinely slow build or
 * test suite deserves it. But every hang-caused restart carries
 * commandTimeoutHint, which tells the model in as many words to bound its
 * command; a SECOND hang means it ignored an explicit instruction, and a third
 * means it ignored it twice. Giving a non-complying child the full ceiling again
 * makes the worst case three times the ceiling, resting entirely on the model
 * obeying prose. Halving bounds it at under twice the ceiling while costing a
 * complying child nothing.
 *
 * `priorHangs` counts watchdog kills specifically, NOT total restarts — the
 * restart budget is shared with loop kills, and a child restarted for LOOPING
 * never received the bound-your-command hint, so its first hang still deserves
 * the full ceiling. Only a hang after a hang is defiance.
 *
 * Floored at 30s so repeated halving cannot shrink the ceiling to something no
 * real command could finish inside — but the floor is `min(base, 30s)`, never
 * above the configured ceiling, so a caller asking for 10s keeps 10s at every
 * hang count. A base of 0 or less disables the watchdog and stays 0.
 */
export function commandCeilingForAttempt(baseMs: number, priorHangs: number): number {
    if (!(baseMs > 0)) return 0
    const floor = Math.min(baseMs, 30_000)
    return Math.max(floor, Math.round(baseMs / 2 ** priorHangs))
}
