/**
 * Model-stream watchdog — the inactivity machine for a stream that goes SILENT
 * without erroring.
 *
 * WHY: a turn can die mid-stream — the last thing recorded is an ordinary
 * assistant message, then nothing, while the model server stays healthy. A hung
 * or silently-dropped stream throws NOTHING, so none of the three guards that
 * already exist can see it:
 *   - the connection-error retry never fires. child-runner reaches it only
 *     inside `if (r.modelError)`, and a silent hang reports no error at all.
 *   - the command watchdog never fires: it arms per tool call and covers only
 *     TOOL executions.
 *   - the child stall guard never fires: it kills only when a probe finds the
 *     endpoint UNREACHABLE, and here the endpoint answers fine. The stream is
 *     what died, not the server.
 *
 * WHAT THIS MEASURES: time since the last sign of life, NOT wall-clock and NOT
 * time-to-first-token. What counts as a sign differs by surface — for the main
 * session it is any of six pi events (`before_provider_request`,
 * `after_provider_response`, `turn_start`, `message_start`, `message_update`,
 * `message_end`), with every text, thinking and tool-call delta arriving as
 * `message_update`; for a child it is any stdout or stderr CHUNK. A slow model
 * that emits something occasionally is working and must never be killed. Zero
 * for the whole window is a hang.
 *
 * WHY THE DEFAULT IS GENEROUS: prompt processing legitimately emits nothing
 * while it runs, so a tight ceiling would kill honest long prompts. This guard
 * exists to bound dead air, not to police slowness. See
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
 * Default inactivity ceiling. Sized by the constraint that a local model's first
 * token can legitimately be a long way off, so the number has to clear honest
 * prompt processing rather than sit close to it.
 */
export const DEFAULT_STREAM_INACTIVITY_MS = 10 * 60_000

/** Whole minutes for the human-facing window in every message: rounded to
 *  nearest, then floored at 1 so a sub-minute window never reads "0 minutes". */
function minutes(ms: number): string {
    const mins = Math.max(1, Math.round(ms / 60_000))
    return `${mins} minute${mins === 1 ? '' : 's'}`
}

/**
 * How often the machine checks the idle clock. A poll, rather than re-arming a
 * timeout on every token, keeps the cost per window constant instead of per
 * event — and "thousands of events" is not a figure of speech: one captured turn
 * emitted over two thousand, nearly all of them `message_update`.
 *
 * A quarter of the window, clamped: never tighter than 50ms, never looser than
 * 30s. The child stall guard polls with the same shape and its own divisor.
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
     * A SET, not a boolean, and pi's own loop is why. `executeToolCallsParallel`
     * in agent-loop.js emits EVERY `tool_execution_start` up front, before any
     * call is prepared; a call that prepares "immediate" gets its end emitted
     * inline right there, while the rest are deferred as closures and settle
     * through a `Promise.all`. So an end can arrive while earlier siblings are
     * still running. A boolean would be cleared by that first end and leave the
     * long build exposed to a false fire. Same per-toolCallId idiom the command
     * watchdog uses.
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
 * The poll is REF'd, deliberately. Unref'd reads better — a pending watchdog poll
 * should never keep the process alive at exit — but an unref'd timer is only
 * guaranteed to fire while something ref'd is still pending, and that guarantee
 * is not the platform-independent thing it looks like.
 *
 * Measured here, on both runtimes: with nothing else pending an unref'd timer
 * never fires at all, the process just exits; with a spawned child holding its
 * stdout and stderr pipes open it fires on schedule throughout. A silent child
 * is the SECOND case — its pipes are still ref'd work — so on this platform the
 * unref would not have broken the child guard. The reason to keep it ref'd is
 * that this machine also runs in the main session, where no such handle is
 * guaranteed, and the failure mode is silent: a watchdog that never fires looks
 * exactly like a stream that never hung.
 *
 * A poll that can delay exit by one interval is the cheaper failure.
 */
export const realStreamTimerDeps: Pick<StreamWatchdogDeps, 'now' | 'schedule' | 'cancel'> = {
    now: () => Date.now(),
    schedule: (fn, ms) => setInterval(fn, ms),
    cancel: handle => clearInterval(handle as ReturnType<typeof setInterval>)
}

/**
 * The cause string a CHILD's stream stall is reported as. Phrased so
 * {@link isConnectionError} (child-runner.ts) matches it — checked by running the
 * round-trip, and it does. The whole point is to route a silent hang into the
 * retry path that already exists for a LOUD connection failure rather than
 * inventing a second one, so the phrase "connection lost" is load-bearing, not
 * decoration: reword it past that predicate and stream stalls stop retrying.
 * Honest about who killed it, too — pi-task aborted the request, the provider
 * reported nothing.
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
