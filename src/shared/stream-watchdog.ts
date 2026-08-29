/**
 * Model-stream watchdog — the inactivity machine for a stream that goes SILENT
 * without erroring.
 *
 * WHY: three main-session implementation turns died mid-turn — the
 * session jsonl's last event is an ordinary assistant message, then nothing,
 * forever, while the model server stayed Up(healthy) the whole time. A hung or
 * silently-dropped stream throws NOTHING, so:
 *   - the connection-error retry (child-runner.ts) never fires: it needs a
 *     thrown/reported ModelError,
 *   - the command watchdog never fires: it only covers TOOL executions,
 *   - the child stall guard never fires: it treats a reachable endpoint as proof
 *     of life, which it is — the endpoint was fine, the stream was not.
 * The cost is hours of dead air waiting on a manual restart.
 *
 * WHAT THIS MEASURES: time since the LAST stream event of ANY kind — text token,
 * tool-call delta, thinking delta, provider response header. NOT wall-clock, and
 * NOT "time to first token". One token every 30s is a working local model and
 * must never be killed; zero events for the whole window is a hang.
 *
 * WHY THE DEFAULT IS GENEROUS: on a local llama-server a 32k-context prompt can
 * spend many minutes in prompt processing emitting nothing at all. A 60-120s
 * ceiling would kill every long prompt on local hardware. See
 * DEFAULT_STREAM_INACTIVITY_MS.
 *
 * TWO SURFACES, one machine (same split as command-watchdog.ts):
 *   MAIN SESSION — task/stream-watchdog.ts arms it from pi's extension events and
 *                  fires ctx.abort() through the SAME abort plumbing the command
 *                  watchdog uses (noteWatchdogAbort → steerUntilDone), so there is
 *                  exactly one abort channel, not two racing ones.
 *   CHILDREN     — shared/child-process.ts arms it on the child's stdout/stderr
 *                  chunks; a fire kills the child and the result carries
 *                  `streamStalled`, which child-runner turns into a
 *                  connection-class cause so the EXISTING retry/backoff path
 *                  handles it (re-spawn from the last durable prompt, never a
 *                  blind re-send of a half-executed turn).
 */

import type {TimerHandle} from './command-watchdog.js'

export type {TimerHandle}

/**
 * Default inactivity ceiling: 10 minutes. Chosen from the constraint that a local
 * model's first token can legitimately be many minutes away — the guard exists to
 * turn hours of dead air into minutes, not to police slowness.
 */
export const DEFAULT_STREAM_INACTIVITY_MS = 10 * 60_000

/** Whole minutes, floored at 1, for the human-facing window in every message. */
function minutes(ms: number): string {
    const mins = Math.max(1, Math.round(ms / 60_000))
    return `${mins} minute${mins === 1 ? '' : 's'}`
}

/**
 * How often the machine checks the idle clock. A poll (rather than re-arming a
 * timeout on every token) keeps cost O(1) per window instead of O(1) per token —
 * a streaming turn emits thousands of events. Same idiom as the child stall guard.
 */
export function pollIntervalMs(timeoutMs: number): number {
    return Math.max(50, Math.min(Math.floor(timeoutMs / 4), 30_000))
}

export interface StreamWatchdogDeps {
    /** The inactivity ceiling in ms, read when the watchdog arms. 0 (or any
     *  non-positive value) means the watchdog is off and never arms. */
    getTimeoutMs: () => number
    now: () => number
    schedule: (fn: () => void, ms: number) => TimerHandle
    cancel: (handle: TimerHandle) => void
    /** Invoked once per arming when the stream has been silent for the ceiling. */
    onFire: (idleMs: number, timeoutMs: number) => void
}

export class StreamWatchdog {
    private timer: TimerHandle | undefined
    private lastEvent = 0
    private armedMs = 0
    /**
     * The tool calls currently executing. While ANY is running the model stream is
     * legitimately idle, and that window belongs to the command watchdog, not to
     * this one — without it a 10-minute build looks identical to a hung stream.
     *
     * A SET, not a boolean: pi runs a tool batch in parallel (agent-loop.js
     * `executeToolCallsParallel` emits every tool_execution_start up front, then one
     * end per call as each settles, and answers an immediate call inline while an
     * earlier one is still running). A boolean would be cleared by the FIRST end and
     * leave the still-running sibling — the long build — exposed to a false fire.
     * Same per-toolCallId idiom the command watchdog uses.
     */
    private readonly active = new Set<string>()
    /** Nesting depth for callers that cannot supply an id, counted so an unkeyed
     *  pair nests the same way a keyed one does. */
    private keyless = 0
    private fired = false

    private get suspended(): boolean {
        return this.active.size > 0 || this.keyless > 0
    }

    constructor(private readonly deps: StreamWatchdogDeps) {}

    /** Begin watching a model request. No-op when the watchdog is off or already armed. */
    start(): void {
        if (this.timer !== undefined) {
            // Already watching — a new request inside the same agent loop just
            // counts as activity rather than restarting the machine.
            this.note()
            return
        }
        const ms = this.deps.getTimeoutMs()
        if (!(ms > 0)) return
        this.armedMs = ms
        this.fired = false
        this.active.clear()
        this.keyless = 0
        this.lastEvent = this.deps.now()
        this.timer = this.deps.schedule(() => this.check(), pollIntervalMs(ms))
    }

    /** Any stream event of any kind: resets the idle clock. */
    note(): void {
        this.lastEvent = this.deps.now()
    }

    /** A tool started executing — pause the idle clock until it (and every sibling
     *  still running) ends. `key` is the tool call id where the caller has one. */
    suspend(key?: string): void {
        if (key === undefined) this.keyless++
        else this.active.add(key)
    }

    /**
     * A tool finished. The clock only restarts once the LAST one does — a fast tool
     * settling first says nothing about a sibling that is still running. Unmatched
     * ends (a watchdog armed mid-batch never saw the start) are ignored rather than
     * clearing the whole set.
     */
    resume(key?: string): void {
        if (key === undefined) this.keyless = Math.max(0, this.keyless - 1)
        else this.active.delete(key)
        if (!this.suspended) this.note()
    }

    /** Stop watching (turn/agent/session end, or child exit). Safe to call twice. */
    stop(): void {
        if (this.timer !== undefined) this.deps.cancel(this.timer)
        this.timer = undefined
        this.active.clear()
        this.keyless = 0
    }

    /** @internal Exposed for the poll callback and tests. */
    check(): void {
        if (this.timer === undefined || this.fired || this.suspended) return
        const idle = this.deps.now() - this.lastEvent
        if (idle < this.armedMs) return
        this.fired = true
        const armed = this.armedMs
        this.stop()
        this.deps.onFire(idle, armed)
    }
}

/**
 * Real-clock poll deps. `schedule` returns a repeating interval — the machine
 * cancels it on stop/fire, and runChild's cleanup() stops the watchdog on every
 * settle path (close, error, abort), so it cannot outlive the child it watches.
 *
 * The poll is REF'd, deliberately. Unref'd reads better — a pending watchdog
 * poll should never keep the process alive at exit — but under Bun on WINDOWS an
 * unref'd timer does not fire at all once nothing ref'd is pending. On Linux it
 * fires either way, which is why only Windows CI catches this.
 *
 * That state — no ref'd work outstanding — is EXACTLY the state this watchdog
 * exists to police: a child whose model stream has gone silent. So the unref
 * disabled the guard precisely when it was needed, and every stream-stall
 * integration test hangs forever on windows.
 * A poll that can delay exit by one interval is the cheaper failure.
 */
export const realStreamTimerDeps: Pick<StreamWatchdogDeps, 'now' | 'schedule' | 'cancel'> = {
    now: () => Date.now(),
    schedule: (fn, ms) => setInterval(fn, ms),
    cancel: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}

/**
 * The cause string a CHILD's stream stall is reported as. Phrased so
 * {@link isConnectionError} (child-runner.ts) matches it — the whole point is to
 * route a silent hang into the retry path that already exists for a LOUD
 * connection failure, rather than inventing a second one. Honest about who
 * killed it: pi-task aborted the request, the provider did not report anything.
 */
export function streamStallCause(idleMs: number): string {
    return (
        `model stream inactivity: no stream events for ${minutes(idleMs)} — `
        + `connection lost (aborted by pi-task's stream watchdog; the provider `
        + `reported no error)`
    )
}

/**
 * MAIN-SESSION reminder, delivered as a follow-up turn after ctx.abort() ended the
 * hung turn. Carries the shared WATCHDOG_CANCEL_MARKER so steerUntilDone
 * recognises it as a watchdog recovery rather than a human ESC (see
 * task/command-watchdog.ts) — one marker, one abort channel.
 *
 * Idempotent resume, not a re-send: the aborted turn's tool calls and their
 * results are already in the transcript, so the model is told to CONTINUE from
 * what is recorded. Re-issuing the turn wholesale would re-run tool calls that
 * already ran.
 */
export function streamStallReminder(idleMs: number, marker: string): string {
    return (
        `[SYSTEM] The model stream produced no events for ${minutes(idleMs)} — the response `
        + `appeared to hang, so the turn ${marker} `
        + `Nothing was reported as failed and no error was raised: the stream simply went `
        + `silent, so any work the turn had ALREADY completed (tool calls and their results) `
        + `is still recorded above and must NOT be repeated. Continue from that recorded `
        + `state: re-read anything you are unsure about, then carry on with the remaining `
        + `work. Do not restart the task from the beginning.`
    )
}

/**
 * CHILD restart hint for a re-spawned worker whose previous attempt was killed by
 * the stream watchdog. The killed child is gone and never saw an error, so this
 * states plainly what happened and, unlike the command-timeout hint, does NOT
 * blame the model: a hung stream is an infrastructure fault, and telling the model
 * to "be faster" would teach it to truncate its work for no reason.
 */
export function streamStallHint(idleMs: number): string {
    return (
        `[SYSTEM NOTE: Your previous attempt was aborted because the model stream stopped `
        + `producing output for ${minutes(idleMs)} — an infrastructure hang, not a mistake `
        + `you made. That attempt's conversation is gone, but any file edits or command side `
        + `effects it made are still in the working tree, so check the current state before `
        + `assuming files are untouched. Redo the work from here.]`
    )
}
