/**
 * Model-stream watchdog — the inactivity machine for a stream that goes SILENT
 * without erroring.
 *
 * WHY (mx5 run 14): three main-session implementation turns died mid-turn — the
 * session jsonl's last event is an ordinary assistant message, then nothing,
 * forever, while the model server stayed Up(healthy) the whole time. A hung or
 * silently-dropped stream throws NOTHING, so:
 *   - the connection-error retry (child-runner.ts) never fires: it needs a
 *     thrown/reported ModelError,
 *   - the command watchdog never fires: it only covers TOOL executions,
 *   - the child stall guard never fires: it treats a reachable endpoint as proof
 *     of life, which it is — the endpoint was fine, the stream was not.
 * Cost in run 14: ~2.9h of dead air awaiting manual restarts.
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
    /** True while a TOOL is executing: the model stream is legitimately idle then,
     *  and that window belongs to the command watchdog, not to this one. Without
     *  this, a 10-minute build would look identical to a hung stream. */
    private suspended = false
    private fired = false

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
        this.suspended = false
        this.lastEvent = this.deps.now()
        this.timer = this.deps.schedule(() => this.check(), pollIntervalMs(ms))
    }

    /** Any stream event of any kind: resets the idle clock. */
    note(): void {
        this.lastEvent = this.deps.now()
    }

    /** A tool started executing — pause the idle clock until it ends. */
    suspend(): void {
        this.suspended = true
    }

    /** A tool finished — the stream is expected to resume; restart the clock. */
    resume(): void {
        this.suspended = false
        this.note()
    }

    /** Stop watching (turn/agent/session end, or child exit). Safe to call twice. */
    stop(): void {
        if (this.timer !== undefined) this.deps.cancel(this.timer)
        this.timer = undefined
        this.suspended = false
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
 * Real-clock poll deps, unref'd so a pending watchdog poll can never itself keep
 * the process alive on exit. `schedule` returns a repeating interval — the
 * machine cancels it on stop/fire.
 */
export const realStreamTimerDeps: Pick<StreamWatchdogDeps, 'now' | 'schedule' | 'cancel'> = {
    now: () => Date.now(),
    schedule: (fn, ms) => {
        const handle = setInterval(fn, ms)
        if (typeof (handle as {unref?: () => void}).unref === 'function') {
            ;(handle as {unref: () => void}).unref()
        }
        return handle
    },
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
