import {getPiInvocation} from '../shared/pi-invocation.js'
import {
    runChildDefault,
    type ContextSnapshot,
    type SpawnFn,
    type ToolCall
} from '../shared/child-process.js'
import {CommandWatchdog, commandTimeoutHint, realTimerDeps} from '../shared/command-watchdog.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {LoopDetector, type LoopHit} from '../task/loop-detector.js'
import {
    LOOP_WINDOW,
    LOOP_THRESHOLD,
    MAX_LOOP_RESTARTS,
    formatLoopHint,
    isConnectionError,
    connectionRetryBackoffMs
} from '../task/child-runner.js'
import {
    detectLeakedToolCall,
    leakedToolCallHint,
    MAX_LEAK_RETRIES
} from '../shared/leaked-tool-call.js'
import {discoverModelEndpoints, probeModelEndpoints} from '../shared/model-endpoint.js'
import {streamStallHint} from '../shared/stream-watchdog.js'

// `--mode json` makes pi emit structured events as they happen instead of
// buffering the assistant text and flushing on exit. That matters for the
// wait/work timing split: in text mode the first stdout chunk only arrives at
// the very end, so onFirstByte fires moments before close and workMs is
// effectively zero. With JSON events the first byte lands as soon as the
// model starts producing — making waitMs the real queue/cold-start cost and
// workMs the real generation+tool-call cost.
const DEFAULT_TOOLS = 'read,grep,find,ls'

/**
 * Tool calls that can GROUND an APIS claim — i.e. return content a signature or
 * command could be cited from. `pi-worker-docs` (the primary), `read` and `grep`
 * (project source), and the web escalations `pi-worker-search`/`pi-worker-fetch`.
 *
 * `ls` and `find` are deliberately EXCLUDED: they return file/directory NAMES,
 * and APIS owns symbols by name only, never paths (RESEARCH_APIS_PROMPT). Bare
 * enumeration cannot verify a signature, so a worker that fabricates its section
 * from memory does not launder itself grounded by calling `ls` once. That
 * exclusion is the anti-gaming property of any gate built on this count: "one
 * trivial `ls` then fabricate the rest" leaves groundingRetrievalCount at 0.
 */
const GROUNDING_RETRIEVAL_TOOLS = new Set([
    'pi-worker-docs',
    'read',
    'grep',
    'pi-worker-search',
    'pi-worker-fetch'
])

/** True when a tool call retrieves content an APIS entry could be grounded in. */
export function isGroundingRetrieval(toolName: string): boolean {
    return GROUNDING_RETRIEVAL_TOOLS.has(toolName)
}

/**
 * Hard wall-clock bound on a single research worker run (one spawn). The
 * exact-match LoopDetector only catches *identical* repeated tool calls; a model
 * that thrashes with slightly-varied calls (different grep patterns each time)
 * slips past it and would otherwise run unbounded. This is the backstop for that
 * case: after this long with no clean exit, abort and restart with a hint. Sized
 * well above a healthy worker's observed runtime (~25-130s on the local backend)
 * so it never trips a legitimately slow run.
 */
const RESEARCH_WORKER_TIMEOUT_MS = 240_000

/**
 * Output-stall window before the dead-backend probe fires (mx5 run 7: model
 * server died mid-gate-child, the child hung MUTE for 64 minutes). This is NOT
 * a wall-clock cap — output progress resets it, and even a fully stalled child
 * is only killed when the model endpoint is actually unreachable. Sized so a
 * long local prompt-processing pass (minutes of legitimate silence, server
 * alive) just gets probed and waits on.
 */
const STALL_AFTER_MS = 180_000

/**
 * Restart hint after a WHOLE-WORKER wall-clock timeout — distinct from both the
 * loop hint and the per-command hint. This one diagnoses over-exploration, which
 * is what the whole-worker cap actually catches. A single hung COMMAND is a
 * different fault with a different fix, and gets commandTimeoutHint instead.
 */
const WORKER_TIMEOUT_HINT =
    '[SYSTEM NOTE: Your previous attempt ran out of time before answering — you '
    + 'were exploring too long. Be decisive: do the minimum reads/greps needed, '
    + 'then write your answer now. Do not re-explore ground you have already covered.]'

/**
 * How much of a discarded attempt's answer is carried into the next one.
 *
 * A restart used to hand the re-spawn nothing but a hint — which is why
 * WORKER_TIMEOUT_HINT above can tell a worker "do not re-explore ground you have
 * already covered" while giving it no record of what that ground was. It could
 * not comply. mx5 run 18 shows the cost: on tasks with >=46 project-source
 * lookups, 5 of 5 workers burned the FULL restart budget, because every attempt
 * re-read the same files against the same clock and died in the same place.
 *
 * Carrying the partial answer forward is what makes a restart converge instead
 * of repeat. The risk it takes is real and is the thing the A/B measures: a
 * half-written or speculative entry, replayed under "already established", is
 * exactly how a fabrication gets laundered into a final answer. That is what the
 * ungrounded-symbol and anti-synthesis guards are pointed at, so the carry is
 * framed as findings to VERIFY-or-DROP rather than as settled fact.
 */
const CARRY_FORWARD_LIMIT = 24_000

/**
 * Restart reasons whose partial output is worth keeping.
 *
 * A clock kill (`worker-timeout`), a hung tool (`command-timeout`), an idle
 * stream (`stream-stall`) and a dropped socket (`connection-error`) all discard
 * work the model genuinely did. A loop kill and a leaked tool call do not — the
 * first is by definition the same call repeated, the second is malformed
 * protocol text, and replaying either would feed the failure back to itself.
 */
const CARRY_FORWARD_REASONS: ReadonlySet<WorkerRestartReason> = new Set([
    'worker-timeout',
    'command-timeout',
    'stream-stall',
    'connection-error'
])

/**
 * Does this partial output carry ANSWER CONTENT, or is it the model clearing its
 * throat?
 *
 * Salvage originally kept the LONGEST partial, which is not the same question. On
 * the live carry arm, TASK_0020 and TASK_0021 both timed out on all three
 * attempts and salvage shipped this as the section:
 *
 *     "Now let me get more details on the specific APIs and components I need:"
 *
 * — a preamble sentence, which beats an empty string on length and carries
 * nothing. Both trials scored 2 entries and DEGRADED, against 22 and 5 for the
 * same fixtures in baseline.
 *
 * A research worker's answer is a list of lines that each name something and
 * describe it. The test is therefore structural, not lexical: at least two lines
 * that look like entries — a name, then a gap, then a description. Prose wraps
 * at no particular column and does not repeat that shape.
 */
export function hasAnswerContent(text: string): boolean {
    const entryish = text
        .split('\n')
        .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
        .filter(l => /^\S.*?(?:\s{2,}|\s+[—–-]\s+)\S/.test(l) && !/[.:]$/.test(l))
    return entryish.length >= 2
}

/**
 * Frame a discarded attempt's output as work already done.
 *
 * Kept deliberately blunt about status. Appended text loses to preserved text
 * when the two disagree, so the carry must not read as a finished answer the
 * model can simply re-emit: it is labelled partial, unverified, and truncated
 * when it is.
 */
export function formatCarryForward(text: string): string | null {
    const body = text.trim()
    if (body.length === 0) return null
    const truncated = body.length > CARRY_FORWARD_LIMIT
    // Keep the TAIL: the model writes progressively, so the end of a partial
    // answer is the furthest it got and the best statement of where to resume.
    const kept = truncated ? body.slice(body.length - CARRY_FORWARD_LIMIT) : body
    return (
        '[WORK ALREADY DONE — from your previous attempt, which was cut off before '
        + 'it could answer. These findings came from real reads of this project, so '
        + 'do NOT gather them again; spend your time on what is still missing. They '
        + 'are PARTIAL and UNVERIFIED: keep every item you can confirm, and drop any '
        + 'item you cannot — do not carry an unconfirmed item into your answer, and '
        + 'do not treat this as your answer.'
        + (truncated ? ' (Earlier portion omitted; this is the most recent part.)' : '')
        + ']\n'
        + kept
    )
}

export interface RunWorkerInput {
    prompt: string
    cwd: string
    signal?: AbortSignal
    spawn?: SpawnFn
    /** Comma-separated tool whitelist passed to `pi --tools`. Defaults to read,grep,find,ls. */
    tools?: string
    /** Internal extension entry-point paths to load via `-e <path>` (see childBaseArgs). */
    extensions?: string[]
    /** Called for each tool execution start and text-writing event inside the worker. */
    onLine?: (line: string) => void
    /** Called when a tool call FINISHES, with its (truncatable) result — lets a caller
     *  log tool OUTPUTS, not just the command (mx5 run 10 item 6). */
    onToolResult?: (result: {
        name: string
        isError: boolean
        text: string
        toolCallId?: string
    }) => void
    /**
     * Called for each context_usage snapshot the child emits (same `--mode json`
     * stream the phase children parse). Lets a caller's status widget show the
     * tokens/window progress bar for the worker exactly like the phase widget,
     * instead of omitting it.
     */
    onContextUsage?: (snapshot: ContextSnapshot) => void
    /**
     * Per-worker wall-clock timeout in ms. Defaults to RESEARCH_WORKER_TIMEOUT_MS.
     * Pass 0 to disable the timeout entirely (run until the child exits on its
     * own) — for a pass that must be allowed to finish however long it takes.
     */
    timeoutMs?: number
    /**
     * PER-TOOL-CALL wall-clock ceiling in ms — the child-side half of the command
     * watchdog (see shared/command-watchdog.ts). Arms on each tool_execution_start
     * and disarms on the matching end; on overrun the child is killed and, within
     * the shared restart budget, re-spawned with commandTimeoutHint.
     *
     * WHY SEPARATE FROM `timeoutMs`: that one bounds the whole worker and is
     * deliberately 0 (unbounded) for gate children, which must run to completion.
     * Neither it nor the stall guard can catch a hung command — the stall guard
     * treats a reachable model endpoint as proof of life, which it is, even while
     * a `bun run dev` the model forgot to bound blocks the child forever.
     *
     * This is the ceiling for the FIRST attempt; each HANG-caused restart halves
     * it (see commandCeilingForAttempt — loop-caused restarts don't count), so a
     * model that ignores the hint cannot spend the full ceiling again on every
     * retry.
     *
     * 0 / omitted = off, so every existing caller is unchanged.
     */
    commandTimeoutMs?: number
    /**
     * Per-worker loop-detector tuning. Defaults to the read-only research/impl
     * guard (LOOP_WINDOW / LOOP_THRESHOLD, path threshold = exact threshold). An
     * edit/fix pass legitimately revisits one file, so it can raise (or disable
     * via Infinity) `pathThreshold`. Pass `false` to turn the detector OFF
     * entirely — no tool-call pattern will ever kill the worker.
     */
    loop?: {window?: number; threshold?: number; pathThreshold?: number} | false
    /**
     * Dead-backend stall guard override. Default ON: no output for
     * STALL_AFTER_MS → probe the model endpoints pi is configured with →
     * unreachable → kill + `stalled: true`. Pass `false` to disable, or
     * override the window/probe (tests, harnesses).
     */
    stall?: {afterMs?: number; probe?: () => Promise<boolean>} | false
    /**
     * Stream-inactivity ceiling in ms (shared/stream-watchdog.ts). The stall guard
     * above cannot catch a HUNG stream on a HEALTHY backend — it reads a reachable
     * endpoint as proof of life, which is exactly what run 14's three hangs looked
     * like. This one asks nothing of the backend: no output for this long (with
     * tool executions excluded) ⇒ kill and restart the attempt with
     * {@link streamStallHint}, inside the same shared restart budget.
     * 0 / omitted = off.
     */
    streamInactivityMs?: number
    /** Backoff sleep, injectable so tests don't wait out the real delays. */
    sleepFor?: (ms: number) => Promise<void>
    /**
     * SCALE arm of nexttask 5B — OFF unless set, and set only by the harness that
     * is measuring it (src/task/research-fanout-budget.ts explains both arms).
     * Each project-source `pi-worker-docs` call pushes this attempt's deadline out
     * by `perLookupMs`, never past `ceilingMs` from the attempt's start: a worker
     * that is making retrieval progress is not killed for making it, while a
     * worker that is thrashing still hits a hard bound.
     */
    fanoutTimeout?: {perLookupMs: number; ceilingMs: number}
    /**
     * Absolute backstop that turns `timeoutMs` from "total time allowed" into
     * "time allowed WITHOUT PROGRESS". A tool call or a line of output re-arms
     * the deadline; only a worker that goes quiet for `timeoutMs` — or exceeds
     * this ceiling outright — is killed.
     *
     * This is the difference between "took too long" and "stopped working". The
     * first is a property of the machine (a slower local model, a bigger file)
     * and must not cost the user their answer; the second is a real fault, and
     * one the output-stall probe already catches on its own terms.
     */
    progressTimeoutCeilingMs?: number
    /**
     * Carry a killed attempt's findings into the re-spawn, and never return less
     * than the best attempt produced. OFF by default so the shipped path is
     * unchanged while the A/B runs — see src/task/research-fanout-budget.ts.
     */
    carryForward?: boolean
    /**
     * Called when a carried-forward partial is INJECTED into an attempt's prompt
     * — once per attempt that receives one. Distinct from `onRestart`, which says
     * an attempt was thrown away; this says the next one was actually handed its
     * findings. The two are separately observable because they can diverge: a
     * restart whose partial had no answer content injects nothing.
     */
    onCarryForward?: (info: {attempt: number; chars: number; promptCharsBefore: number}) => void
    /**
     * Called once per DISCARDED attempt, at the moment the worker decides to
     * re-spawn — the only window in which a restart is observable at all.
     *
     * WHY: every restart branch below throws away a whole attempt's wall clock
     * along with its text, and `waitMs`/`workMs` describe the FINAL attempt only.
     * With no hook here those attempts were structurally invisible: mx5 run 18
     * burned 30 wall-clock timeouts / 120 minutes of compute that appeared in no
     * log and no timing widget, and 21 of the 23 affected workers reported
     * `exit=0` — clean successes as far as the run could tell. The discrepancy
     * was only recoverable by subtracting reported wait+work from the timestamps
     * of the `start` and `done` lines around it.
     */
    onRestart?: (restart: WorkerRestart) => void
    /**
     * Connection-error restart budget. Defaults to MAX_LOOP_RESTARTS, and even
     * then the SHARED restart counter is what actually binds — a worker that
     * already spent the budget looping does not get extra lives here. 0 turns the
     * retry off, which is how scripts/connection-retry-ab.ts gets a baseline arm
     * out of a build that already ships the retry.
     */
    connectionRetries?: number
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Combine an external abort signal with an internal wall-clock timeout into one
 * signal, while keeping the two causes distinguishable: `timedOut()` is true
 * only when the timer fired (not when the external signal aborted), so the caller
 * can restart on a timeout but not on a user cancel.
 */
function workerTimeout(
    external: AbortSignal | undefined,
    ms: number,
    /**
     * Absolute backstop for the progress-based deadline. When set, `ms` stops
     * meaning "total time allowed" and starts meaning "time allowed WITHOUT
     * PROGRESS"; this is the hard limit no amount of progress can pass.
     */
    absoluteCeilingMs?: number
): {
    signal: AbortSignal
    timedOut: () => boolean
    extend: (byMs: number, ceilingMs: number) => void
    /**
     * Report that the worker did something. Re-arms the deadline to
     * `now + ms`, never past the absolute ceiling. Inert unless a ceiling is
     * configured, so the fixed-cap behaviour is unchanged for callers that
     * don't opt in.
     */
    progress: () => void
    /** The wall clock this attempt was actually allowed, extensions included. */
    budgetMs: () => number
    cleanup: () => void
} {
    const ctrl = new AbortController()
    let timedOut = false
    const armed = ms > 0 && Number.isFinite(ms)
    const started = Date.now()
    let deadline = started + ms
    const fire = (): void => {
        timedOut = true
        ctrl.abort()
    }
    // ms <= 0 (or non-finite) disables the wall-clock timeout: no timer is armed,
    // so only the external signal can abort and timedOut() stays false forever.
    let timer = armed ? setTimeout(fire, ms) : undefined
    const onExternal = (): void => ctrl.abort()
    if (external) {
        if (external.aborted) ctrl.abort()
        else external.addEventListener('abort', onExternal, {once: true})
    }
    return {
        signal: ctrl.signal,
        timedOut: () => timedOut,
        // SCALE arm of nexttask 5B, inert unless a caller calls it: push the
        // deadline out, never past `started + ceilingMs`. A disabled timeout
        // (nothing armed) stays disabled — extending "never" is meaningless — and
        // an already-fired timer is not resurrected.
        extend: (byMs, ceilingMs) => {
            if (!armed || timedOut || ctrl.signal.aborted) return
            const next = Math.min(deadline + byMs, started + ceilingMs)
            if (next <= deadline) return
            deadline = next
            clearTimeout(timer)
            timer = setTimeout(fire, Math.max(0, deadline - Date.now()))
        },
        // PROGRESS-BASED DEADLINE. A worker that is making tool calls and
        // emitting text is not stuck — it is slow, and how slow is a property of
        // the user's machine, not of the task. Killing it on total elapsed time
        // makes answer quality depend on the hardware: the same task on a slower
        // local model loses its work and degrades, which no per-file constant can
        // fix. Being STUCK is already detected separately and correctly, by the
        // output-stall probe (STALL_AFTER_MS), which resets on progress and only
        // kills when the model endpoint is unreachable.
        progress: () => {
            if (absoluteCeilingMs === undefined) return
            if (!armed || timedOut || ctrl.signal.aborted) return
            const next = Math.min(Date.now() + ms, started + absoluteCeilingMs)
            if (next <= deadline) return
            deadline = next
            clearTimeout(timer)
            timer = setTimeout(fire, Math.max(0, deadline - Date.now()))
        },
        budgetMs: () => deadline - started,
        cleanup: () => {
            clearTimeout(timer)
            external?.removeEventListener('abort', onExternal)
        }
    }
}

/**
 * Why an attempt was thrown away. One value per restart branch in runWorker, so
 * a log line naming the reason points at exactly one piece of code.
 */
export type WorkerRestartReason =
    | 'loop'
    | 'command-timeout'
    | 'stream-stall'
    | 'worker-timeout'
    | 'connection-error'
    | 'leaked-tool-call'

/** One DISCARDED attempt: its cause and the wall clock it consumed and lost. */
export interface WorkerRestart {
    /** 1-based number of the attempt being discarded (the 1st restart ends attempt 1). */
    attempt: number
    reason: WorkerRestartReason
    /** Wall clock this attempt spent before it was killed — time with no output. */
    wallMs: number
    /** The discarded attempt's own spawn → first-byte split. */
    waitMs: number
    /** The discarded attempt's own first-byte → exit split. */
    workMs: number
    /** Reason-specific diagnosis: the looping call, the hung tool, the error text. */
    detail?: string
}

export interface RunWorkerResult {
    text: string
    exitCode: number
    stderr: string
    aborted: boolean
    /**
     * The provider-reported cause when the model turn itself failed (disconnect,
     * fetch failed, 5xx after pi's own retries): pi delivers it as an assistant
     * message with stopReason "error" and EMPTY text, exit code 0. Phase children
     * have always surfaced this (child-runner.ts) — research workers did not, so a
     * swallowed provider error reached the caller as an indistinguishable empty
     * answer and was reported as the useless "produced no output" (issue #10).
     * Only meaningful when `text` is empty: a turn that produced text after pi
     * recovered is a success, and the first-error capture must not relabel it.
     */
    modelError?: string
    /**
     * Whether the child ever produced a single byte of stdout. Under `--mode json`
     * a live pi child streams protocol events long before any assistant text, so
     * this separates the two ways a worker can come back with nothing:
     *   sawOutput true  — the child ran and the MODEL chose to write nothing
     *                     (a legitimately empty section on a trivial task)
     *   sawOutput false — the child never spoke at all: it died at startup
     *                     (unresolvable provider, missing key, bad argv). That is
     *                     a FAILURE and must never be recorded as "no entries".
     * Derived from the same first-byte timestamp `waitMs`/`workMs` use, so it
     * cannot disagree with them.
     */
    sawOutput: boolean
    /**
     * Milliseconds between spawn and the child's first stdout chunk. When
     * multiple workers run concurrently and the upstream model API queues at
     * some concurrency cap, this is the queue-wait portion of the run.
     *
     * FINAL ATTEMPT ONLY — a restarted attempt's clock is discarded with its
     * text. `waitMs + workMs` is therefore NOT the worker's wall clock whenever
     * `attempts > 1`; `totalWallMs` is.
     */
    waitMs: number
    /**
     * Milliseconds between first stdout chunk and process exit — the
     * generation/tool-call portion, independent of queue wait. Equals total
     * elapsed when the child never produced output. Final attempt only, same as
     * `waitMs`.
     */
    workMs: number
    /**
     * How many attempts (spawns) this call made, including the one that produced
     * `text`. 1 for a worker that ran clean. Always `restarts.length + 1`.
     */
    attempts: number
    /**
     * The worker's TRUE wall clock: entry to return, spanning every discarded
     * attempt and every connection backoff. `totalWallMs - waitMs - workMs` is
     * the time this worker spent on output that was thrown away.
     */
    totalWallMs: number
    /**
     * One entry per discarded attempt, in order — empty on a clean run. The only
     * record that a restart happened: the returned `exitCode`/`text` describe the
     * final attempt and look identical whether it was the first or the third.
     */
    restarts: ReadonlyArray<WorkerRestart>
    /**
     * True when `text` came from a DISCARDED attempt rather than the final one,
     * because the final attempt returned less. The answer is real output the
     * worker produced, but it was cut off mid-flight, so it is likelier to be
     * incomplete than a clean return — callers that grade completeness should
     * treat it as partial rather than as a finished answer.
     */
    salvagedFromDiscardedAttempt: boolean
    /**
     * How many GROUNDING retrieval tool calls the FINAL attempt made — the calls
     * that returned content an APIS entry could be cited from (see
     * isGroundingRetrieval; `ls`/`find` excluded on purpose). Counted over the
     * attempt that produced `text`, not summed across restarts (a restarted
     * attempt discards its predecessor's calls along with its text). Zero here on
     * a non-empty section means every symbol in it came from parametric memory.
     */
    groundingRetrievalCount: number
    /**
     * Set when the worker exhausted its re-prompts still leaking a tool call as
     * text (wrong dialect, never executed). The caller must treat this as a
     * failure rather than trusting the returned text.
     */
    leakedToolCall?: string
    /**
     * Set when the worker was killed for looping (the same tool call repeated
     * past threshold) and still looped after exhausting MAX_LOOP_RESTARTS
     * restarts. The returned text is truncated mid-stream — the caller must treat
     * this as a failure, not trust it.
     */
    loopHit?: LoopHit
    /**
     * Set when the worker's final attempt hit the per-worker wall-clock timeout
     * after exhausting its restart budget. Like loopHit, the text is partial and
     * the caller must treat it as a failure.
     */
    timedOut?: boolean
    /**
     * Set when the stall guard killed the worker: no output progress AND the
     * model endpoint unreachable. Check BEFORE `aborted` — the kill sets
     * aborted too, and mislabeling this as a user cancel hides a dead backend.
     */
    stalled?: boolean
    /**
     * Set when the command watchdog killed the worker's FINAL attempt: one tool
     * call outran `commandTimeoutMs` (a command the model never bounded). Like
     * loopHit/timedOut the text is partial — treat as a failure. Names the tool
     * so the caller's trail says which call hung rather than just "aborted".
     *
     * Check BEFORE `aborted`, same reasoning as `stalled`: the kill aborts too.
     */
    commandTimedOut?: {toolName: string; timeoutMs: number}
    /**
     * Set when the stream watchdog killed the worker's FINAL attempt: the model
     * stream produced nothing for the configured window while no tool was running.
     * Like loopHit/timedOut the text is partial — treat as a failure, and check it
     * BEFORE `aborted` (the kill aborts too), or a hung backend is mislabeled a
     * user cancel.
     */
    streamStalled?: {idleMs: number}
}

/**
 * The per-command ceiling for attempt N, halving each time a hang recurs.
 *
 * The first attempt gets the full configured ceiling — a genuinely slow build or
 * test suite deserves it. But every hang-caused restart carries
 * commandTimeoutHint, which tells the model in as many words to bound its
 * command; a SECOND hang means it ignored an explicit instruction, and a third
 * means it ignored it twice. Giving a non-complying child the full ceiling again
 * would put the worst case at 3 × 15 min = 45 minutes of dead time, resting
 * entirely on the model obeying prose. Halving bounds it at ~26 min while
 * costing a complying child nothing.
 *
 * `priorHangs` counts watchdog kills specifically, NOT total restarts — the
 * restart budget is shared with loop kills, and a child restarted for LOOPING
 * never received the bound-your-command hint, so its first hang still deserves
 * the full ceiling. Only a hang after a hang is defiance.
 *
 * Floored at 30s so repeated halving cannot shrink the ceiling to something no
 * real command could finish inside — but never ABOVE the configured ceiling
 * itself, or a caller asking for 10s would silently get 30.
 */
export function commandCeilingForAttempt(baseMs: number, priorHangs: number): number {
    if (!(baseMs > 0)) return 0
    const floor = Math.min(baseMs, 30_000)
    return Math.max(floor, Math.round(baseMs / 2 ** priorHangs))
}

/**
 * Everything the restart ladder reads about one finished attempt, plus the
 * budgets it draws on. Assembled once per attempt so the rules below can be
 * module-level data instead of six `if` blocks welded into `runWorker`'s closure.
 */
interface RestartState {
    loopHit?: LoopHit
    commandKill?: CommandKill
    streamStalled?: {idleMs: number}
    timedOut: boolean
    modelError?: string
    leaked: string | null
    /** The cap this attempt actually died against — the SCALE arm moves it. */
    effectiveCapMs: number
    /** The child's tool string, which decides whether its edits can persist. */
    tools: string
    restartBudgetSpent: number
    connRetries: number
    connectionRetries: number
    leakRetries: number
}

/** What a rule does to the budgets when it fires. */
interface RestartCounters {
    /** Consume one of the shared loop/timeout/connection restarts. */
    shared?: boolean
    /** Consume one of the leaked-tool-call retries (a separate budget). */
    leak?: boolean
    /** Count a WATCHDOG kill specifically — drives the command-ceiling halving. */
    hang?: boolean
    /** Count a CONNECTION restart specifically — drives the backoff schedule. */
    connection?: boolean
}

/**
 * One restartable failure: how to spot it, what to tell the fresh child, which
 * budget it spends, and how long to wait first.
 */
interface RestartRule {
    reason: WorkerRestartReason
    /**
     * Does this rule apply to the attempt, and is its budget unspent? Returns
     * the restart's detail line, or null to fall through to the next rule.
     *
     * Detection and budget are ONE test on purpose. An out-of-budget failure must
     * fall through to the return path, not stop the ladder — a loop kill with the
     * shared budget spent still has to let the plain-abort return happen.
     */
    detect: (s: RestartState) => {detail: string} | null
    /**
     * The corrective preamble prepended to the next attempt's prompt. Omitted by
     * `connection-error` alone: nothing the model did caused a dropped socket, so
     * there is nothing to correct — and any hint already in flight from an
     * earlier restart must survive the retry rather than be cleared by it.
     */
    hint?: (s: RestartState) => string
    counters: RestartCounters
    /** Backoff before re-spawning, in ms. Only the connection rule waits. */
    backoffMs?: (s: RestartState) => number
}

/**
 * The restart ladder, in precedence order. FIRST MATCH WINS.
 *
 * Read the `!loopHit` guards as "a loop kill outranks me even when it has no
 * budget left". They are not redundant with row order: when a loop is detected
 * but the shared budget is spent, row 1 declines, and without those guards row 2
 * or 4 would then restart the same runaway child under a hint that does not
 * describe why it died.
 *
 * The whole ritual — check the budget, set the hint, spend the counters, record
 * and announce the discarded attempt, sleep, re-spawn — belongs to the loop in
 * `runWorker`, so a new failure mode is one row here and cannot be added without
 * becoming visible in `restarts`.
 */
const RESTART_RULES: readonly RestartRule[] = [
    {
        // A loop-kill gets the same restart-with-hint treatment every other phase
        // already gets (runPhaseWithLoopGuard) — name the offending call so the
        // re-spawn avoids it. Bounded by the shared restart budget.
        reason: 'loop',
        detect: s =>
            s.loopHit && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                {detail: `${s.loopHit.call.name} ×${s.loopHit.count}/${s.loopHit.windowSize}`}
            :   null,
        hint: s => formatLoopHint(s.loopHit!),
        counters: {shared: true}
    },
    {
        // A hung COMMAND is restartable too, on the same budget, but checked
        // before the whole-worker timeout because its hint is the specific one:
        // bound the command. (The two can't be confused — a watchdog kill leaves
        // timeout.timedOut() false, since that flag tracks only its own timer.)
        reason: 'command-timeout',
        detect: s =>
            s.commandKill && !s.loopHit && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                {
                    detail:
                        `${s.commandKill.toolName} > ${s.commandKill.timeoutMs}ms`
                        + (s.commandKill.detail ? `: ${s.commandKill.detail}` : '')
                }
            :   null,
        hint: s =>
            commandTimeoutHint(s.commandKill!.toolName, s.commandKill!.timeoutMs, {
                commandDetail: s.commandKill!.detail,
                // Nothing reverts the tree between attempts, so a child that can
                // mutate it (edit/write, or bash side effects) must not be told
                // its previous attempt left no trace. Same capability test the
                // gate logger uses — decided by tools, not by phase.
                editsMayPersist: /\b(?:edit|bash|write)\b/.test(s.tools)
            }),
        counters: {shared: true, hang: true}
    },
    {
        // A hung model stream is restartable on the same budget. Checked before
        // the wall-clock timeout because it is the more specific diagnosis (and
        // its hint does not blame the model: nothing it did caused the hang).
        reason: 'stream-stall',
        detect: s =>
            s.streamStalled && !s.loopHit && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                {detail: `idle ${s.streamStalled.idleMs}ms`}
            :   null,
        hint: s => streamStallHint(s.streamStalled!.idleMs),
        counters: {shared: true}
    },
    {
        // A wall-clock timeout (the backstop for varied thrash the exact-match
        // detector misses) is also restartable, sharing the same budget. Skip when
        // a loop also tripped — the loop hint above is more specific.
        reason: 'worker-timeout',
        detect: s =>
            s.timedOut && !s.loopHit && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                // The EFFECTIVE cap, which the SCALE arm moves — reporting the
                // configured one would misname why this attempt died.
                {detail: `cap ${s.effectiveCapMs}ms`}
            :   null,
        hint: () => WORKER_TIMEOUT_HINT,
        counters: {shared: true}
    },
    {
        // A connection-class model error is restartable on the same budget, exactly
        // as runPhaseWithLoopGuard already treats it — a research worker had no such
        // retry, so one dropped fetch failed the whole task at research while the
        // identical blip in refine/compose was absorbed.
        //
        // What this can and cannot buy, measured (flaky proxy in front of the local
        // llama-server, dropping every connection for a fixed outage window): pi
        // retries a failed turn itself, 4 attempts over ~15s, and a run that
        // recovers no longer reports modelError at all (see JsonEventSink). So a
        // surfaced connection error means pi's own ~15s budget is already spent, and
        // a re-spawn only helps when the outage outlasts it. It does: at a 20s
        // outage the baseline never recovered and this policy always did, 0/8 → 8/8
        // (Fisher p=0.00016), and the same at 35s. Below ~15s pi absorbs it alone —
        // 8/8 both arms, so the retry neither helps nor costs there. Beyond ~46s
        // (three spawns' combined budget) both arms fail. The price is paid only on
        // a backend that is really gone: time-to-report goes ~15s → ~46s. Re-run:
        // scripts/connection-retry-ab.ts.
        //
        // Connection class ONLY. Auth, bad request and context overflow still fail
        // fast: re-issuing the same request cannot fix them, so spending the budget
        // would only delay the report.
        reason: 'connection-error',
        detect: s =>
            (
                s.modelError !== undefined
                && isConnectionError(s.modelError)
                && s.restartBudgetSpent < MAX_LOOP_RESTARTS
                && s.connRetries < s.connectionRetries
            ) ?
                {detail: s.modelError.slice(0, 120)}
            :   null,
        counters: {shared: true, connection: true},
        backoffMs: s => connectionRetryBackoffMs(s.connRetries)
    },
    {
        // Only reached on a clean, complete run — see how `leaked` is computed. A
        // non-zero exit or abort yields partial text the caller already handles,
        // and detecting there would just mislabel the real failure.
        reason: 'leaked-tool-call',
        detect: s =>
            s.leaked && s.leakRetries < MAX_LEAK_RETRIES ?
                {detail: s.leaked.trim().slice(0, 80)}
            :   null,
        hint: s => leakedToolCallHint(s.leaked!),
        counters: {leak: true}
    }
]

/** What the command watchdog recorded when it killed an attempt. */
interface CommandKill {
    toolName: string
    timeoutMs: number
    /** The command line itself, when the tool carried one — quoted into the hint
     *  so the fresh child knows which call it must not repeat unbounded. */
    detail?: string
}

/**
 * Build the child-side command watchdog for ONE attempt: a per-tool-call timer
 * machine (shared with the main session) whose `onFire` aborts `signal`, which
 * runChild turns into a process-GROUP kill — reaping the hung command itself,
 * not just the pi child holding it.
 *
 * LIMIT: the group kill only reaches processes still IN the group. A hung
 * command that detached a daemon (setsid/nohup dev server) leaves it running —
 * the fresh attempt can then hit a port the dead attempt's escapee still holds
 * (the run-9 orphan-dev-server → false-EADDRINUSE shape). No cheap fix from
 * here; the restart hint's "check current state" line is the mitigation.
 *
 * Returns null when the watchdog is off, so the caller keeps the plain timeout
 * signal and no per-call bookkeeping happens at all.
 */
function commandWatch(timeoutMs: number): {
    onStart: (call: ToolCall) => void
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
        onEnd: id => watchdog.onEnd(key(id)),
        killed: () => killed,
        signal: ctrl.signal,
        clear: () => watchdog.clearAll()
    }
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
    const tools = input.tools ?? DEFAULT_TOOLS
    const baseArgs = [...childBaseArgs(input.extensions ?? []), '--mode', 'json', '--tools', tools]
    const timeoutMs = input.timeoutMs ?? RESEARCH_WORKER_TIMEOUT_MS
    let hint: string | null = null
    // Loop-kill and timeout share one restart budget, mirroring
    // runPhaseWithLoopGuard: a runaway worker gets re-spawned with a corrective
    // hint up to MAX_LOOP_RESTARTS times before we give up. Leaked tool calls
    // keep their own MAX_LEAK_RETRIES budget below — a different failure mode.
    let restartBudgetSpent = 0
    // Watchdog kills specifically — drives the ceiling halving. Kept apart from
    // `restartBudgetSpent` (the shared budget) so a loop-caused restart doesn't shorten
    // the rope of a child that has never hung (see commandCeilingForAttempt).
    let hangKills = 0
    // Connection-error restarts specifically — drives the backoff schedule (and
    // lets a harness set the budget to 0 without touching the shared counter).
    let connRetries = 0
    let leakRetries = 0
    // Entry-to-return wall clock. tAttemptStart below is per-attempt (it is what
    // waitMs/workMs are measured from); this one is the only thing that sees the
    // attempts that were killed and re-spawned.
    const tRunStart = Date.now()
    const restarts: WorkerRestart[] = []
    // The best partial answer any discarded attempt produced, RAW. Without this a
    // restart is amnesiac: it re-reads the same files against the same clock and
    // dies in the same place (see CARRY_FORWARD_LIMIT). Held unformatted because
    // it has two consumers — the next attempt's prompt, which wants it wrapped in
    // the carry-forward framing, and the final return, which must never emit that
    // framing as if it were the worker's answer.
    // Held in a box, not a bare `let`: the only writer is the `noteRestart`
    // closure below, and TypeScript narrows a closure-assigned `let` back to its
    // initialiser at the return site.
    const salvage: {text: string | null} = {text: null}
    for (;;) {
        const carried = salvage.text === null ? null : formatCarryForward(salvage.text)
        // Announce the INJECTION, not just the restart. Without this, "the carry
        // reached the re-spawn" can only be inferred from entry counts — and
        // inferring what a worker did from what it produced is the exact gap 5A
        // exists to close. The prompt goes to the child on stdin, so no log
        // downstream of here can show it.
        if (carried !== null) {
            input.onCarryForward?.({
                attempt: restarts.length + 1,
                chars: carried.length,
                promptCharsBefore: input.prompt.length
            })
        }
        const prompt = [hint, carried, input.prompt]
            .filter((p): p is string => p !== null)
            .join('\n\n')
        const invocation = getPiInvocation([...baseArgs], prompt)
        const tAttemptStart = Date.now()
        let tFirstByte: number | null = null
        // loop === false turns the guard off entirely (detector is null and no
        // tool call is ever flagged); otherwise build a detector from the override
        // or the default research/impl thresholds.
        const loopDetector =
            input.loop === false ?
                null
            :   (() => {
                    const window = input.loop?.window ?? LOOP_WINDOW
                    const threshold = input.loop?.threshold ?? LOOP_THRESHOLD
                    return new LoopDetector(
                        window,
                        threshold,
                        input.loop?.pathThreshold ?? threshold
                    )
                })()
        // Capture the hit the detector reports (it also returns it to the unified
        // runner, which kills the child on a hit). Without capturing it here the
        // SIGTERM that kill produces would surface as a bare non-zero exit the
        // caller couldn't distinguish from a crash.
        let loopHit: LoopHit | undefined
        // Reset EACH attempt: on a restart the previous attempt's calls are
        // discarded with its text, so the count must describe only the attempt
        // whose text this call returns.
        let groundingRetrievalCount = 0
        const timeout = workerTimeout(input.signal, timeoutMs, input.progressTimeoutCeilingMs)
        // Per-tool-call watchdog for this attempt (null when off). Its abort is
        // OR'd with the worker timeout / external cancel into the child's signal.
        const cmdWatch = commandWatch(
            commandCeilingForAttempt(input.commandTimeoutMs ?? 0, hangKills)
        )
        const childSignal =
            cmdWatch ? AbortSignal.any([timeout.signal, cmdWatch.signal]) : timeout.signal
        let result
        try {
            result = await runChildDefault(
                invocation,
                input.cwd,
                childSignal,
                {
                    mode: 'json-events',
                    ...(input.stall === false ?
                        {}
                    :   {
                            stall: {
                                afterMs: input.stall?.afterMs ?? STALL_AFTER_MS,
                                probe:
                                    input.stall?.probe
                                    ?? (() => probeModelEndpoints(discoverModelEndpoints()))
                            }
                        }),
                    ...(input.streamInactivityMs ?
                        {streamInactivityMs: input.streamInactivityMs}
                    :   {}),
                    onFirstByte: () => (tFirstByte = Date.now()),
                    onToolCall: call => {
                        cmdWatch?.onStart(call)
                        // A tool call is the worker working. Inert unless the
                        // caller opted into a progress-based deadline.
                        timeout.progress()
                        if (
                            input.fanoutTimeout
                            && call.name === 'pi-worker-docs'
                            && (call.args as {module?: unknown} | undefined)?.module === '.'
                        ) {
                            timeout.extend(
                                input.fanoutTimeout.perLookupMs,
                                input.fanoutTimeout.ceilingMs
                            )
                        }
                        if (isGroundingRetrieval(call.name)) groundingRetrievalCount++
                        if (!loopDetector) return null
                        const hit = loopDetector.record(call)
                        if (hit && !loopHit) loopHit = hit
                        return hit
                    },
                    // Output is the other half of "still working": a worker
                    // writing its answer is making progress even when it has no
                    // more tool calls to make.
                    onLine: line => {
                        timeout.progress()
                        input.onLine?.(line)
                    },
                    // Always wired now (it used to be conditional on the command
                    // watchdog): the sink only emits tool_execution_end if a
                    // handler exists, and a completed tool call is the clearest
                    // progress signal there is. Without it a worker whose tool
                    // calls all succeed would still look idle to the deadline.
                    onToolResult: r => {
                        timeout.progress()
                        cmdWatch?.onEnd(r.toolCallId)
                        input.onToolResult?.(r)
                    },
                    onContextUsage: input.onContextUsage
                },
                input.spawn
            )
        } finally {
            timeout.cleanup()
            cmdWatch?.clear()
        }
        const tEnd = Date.now()
        const effectiveCapMs = timeout.budgetMs()
        const waitMs = tFirstByte === null ? tEnd - tAttemptStart : tFirstByte - tAttemptStart
        const workMs = tFirstByte === null ? 0 : tEnd - tFirstByte
        // Record + announce a discarded attempt. Called from every `continue`
        // branch below, so a restart cannot be added without becoming visible.
        const noteRestart = (reason: WorkerRestartReason, detail?: string): void => {
            const record: WorkerRestart = {
                attempt: restarts.length + 1,
                reason,
                wallMs: tEnd - tAttemptStart,
                waitMs,
                workMs,
                ...(detail ? {detail} : {})
            }
            restarts.push(record)
            input.onRestart?.(record)
            // Harvest here rather than in each branch: `noteRestart` is the one
            // place every `continue` already has to pass through, so a restart
            // path cannot be added that silently drops the attempt's work.
            // Longest-wins — a later attempt killed early should not replace a
            // fuller answer an earlier one had already reached.
            if (input.carryForward === true && CARRY_FORWARD_REASONS.has(reason)) {
                const partial = text.trim()
                // Longest-with-CONTENT wins. Length alone let a preamble sentence
                // become the answer — see hasAnswerContent.
                if (partial.length > (salvage.text?.length ?? 0) && hasAnswerContent(partial)) {
                    salvage.text = partial
                }
            }
        }
        const text = result.text ?? ''
        const timedOut = timeout.timedOut()
        const commandKill = cmdWatch?.killed()
        const streamStalled = result.streamStalled

        // Only treat output as a leak on a clean, complete run — a non-zero exit
        // or abort yields partial text the caller already handles, and detecting
        // there would just mislabel the real failure.
        const leaked = result.exitCode === 0 && !result.aborted ? detectLeakedToolCall(text) : null

        // THE RESTART LADDER. Precedence is RESTART_RULES' row order; this loop
        // owns the ritual every rule used to repeat: budget, hint, counters,
        // record-and-announce, backoff, re-spawn.
        const state: RestartState = {
            ...(loopHit ? {loopHit} : {}),
            ...(commandKill ? {commandKill} : {}),
            ...(streamStalled ? {streamStalled} : {}),
            timedOut,
            ...(result.modelError !== undefined ? {modelError: result.modelError} : {}),
            leaked,
            effectiveCapMs,
            tools,
            restartBudgetSpent,
            connRetries,
            connectionRetries: input.connectionRetries ?? MAX_LOOP_RESTARTS,
            leakRetries
        }
        let restarted = false
        for (const rule of RESTART_RULES) {
            const hit = rule.detect(state)
            if (!hit) continue
            if (rule.hint) hint = rule.hint(state)
            if (rule.counters.shared) restartBudgetSpent++
            if (rule.counters.leak) leakRetries++
            if (rule.counters.hang) hangKills++
            if (rule.counters.connection) connRetries++
            // Noted BEFORE any backoff sleep, so the record's wallMs stays the
            // attempt's own clock; the sleep lands in totalWallMs, where it belongs.
            noteRestart(rule.reason, hit.detail)
            if (rule.backoffMs) await (input.sleepFor ?? defaultSleep)(rule.backoffMs(state))
            restarted = true
            break
        }
        if (restarted) continue
        // SALVAGE. The run used to return the LAST attempt's text unconditionally,
        // so a worker whose final attempt was killed early reported nothing at all
        // — even when a discarded attempt had produced a usable answer that was
        // still in hand at the moment it was thrown away. A restart budget is
        // meant to buy more chances at an answer, not to overwrite a good attempt
        // with a worse one.
        //
        // Gated on the final attempt having FAILED, not on it being shorter. A
        // worker that finished cleanly has answered, and a short answer is a
        // legitimate answer — length would let a long half-finished fragment
        // override a concise correct one, which is the opposite of the fix.
        const finalAttemptFailed =
            timedOut === true
            || result.aborted
            || result.modelError !== undefined
            || result.stalled === true
            || streamStalled !== undefined
            || commandKill !== undefined
            || loopHit !== undefined
            || text.trim().length === 0
        const answer =
            (
                finalAttemptFailed
                && salvage.text !== null
                && salvage.text.length > text.trim().length
            ) ?
                salvage.text
            :   text
        return {
            text: answer,
            salvagedFromDiscardedAttempt: answer !== text,
            exitCode: result.exitCode,
            stderr: result.stderr.trim(),
            aborted: result.aborted,
            waitMs,
            workMs,
            attempts: restarts.length + 1,
            totalWallMs: Date.now() - tRunStart,
            restarts,
            sawOutput: tFirstByte !== null,
            groundingRetrievalCount,
            ...(result.modelError ? {modelError: result.modelError} : {}),
            ...(leaked ? {leakedToolCall: leaked} : {}),
            ...(loopHit ? {loopHit} : {}),
            ...(timedOut ? {timedOut: true} : {}),
            ...(result.stalled ? {stalled: true} : {}),
            ...(streamStalled ? {streamStalled} : {}),
            ...(commandKill ?
                {
                    commandTimedOut: {
                        toolName: commandKill.toolName,
                        timeoutMs: commandKill.timeoutMs
                    }
                }
            :   {})
        }
    }
}
