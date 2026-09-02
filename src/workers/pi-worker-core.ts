import {getPiInvocation} from '../shared/pi-invocation.js'
import {
    runChildDefault,
    type ContextSnapshot,
    type LoopHit,
    type SpawnFn
} from '../shared/child-process.js'
import {
    commandCeilingForAttempt,
    commandTimeoutHint,
    commandWatch,
    type CommandKill
} from '../shared/command-watchdog.js'

export {commandCeilingForAttempt} from '../shared/command-watchdog.js'
import {isGroundingRetrieval as isGrounding, workerChannel} from './worker-channels.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {LoopDetector, MAX_LOOP_RESTARTS, formatLoopHint} from '../task/loop-detector.js'
import {StallDetector, formatStallHint} from '../task/stall-detector.js'
import {isConnectionError, connectionRetryBackoffMs} from '../shared/connection-error.js'
import {
    detectLeakedToolCall,
    leakedToolCallHint,
    MAX_LEAK_RETRIES
} from '../shared/leaked-tool-call.js'
import {childModelEndpoints, probeModelEndpoints} from '../shared/model-endpoint.js'
import {modelSpecFromArgs} from '../config/group-models.js'
import {streamStallHint} from '../shared/stream-watchdog.js'
import {classifyWorkerFailure} from './worker-failure.js'
import {CARRY_FORWARD_IDS, RESTART_ORDER, type WorkerKillId} from './worker-kill.js'
import {
    applyOverride,
    WORKER_PROFILES,
    type WorkerGuardOverride,
    type WorkerGuardPolicy,
    type WorkerPolicyInputs,
    type WorkerProfileId
} from './worker-profiles.js'

/** The tool whitelist a caller gets when it names none. */
const DEFAULT_TOOLS = 'read,grep,find,ls'

/**
 * The argv of one model child.
 *
 * `--mode json` puts the child into the structured event stream the runner
 * parses. Without it the child emits plain text, every line fails JSON.parse,
 * finalText stays empty, and every caller fails with "produced no output". A
 * refactor has dropped it once already; do not remove it again.
 *
 * An empty `tools` string means "no tools at all" — `--no-tools`, never
 * `--tools ''`, which pi rejects. A no-tools child cannot make a tool call, so
 * it carries no in-run guard extension either: the guards all hang off pi's
 * `tool_call` hook.
 *
 * The prompt is NOT an argv element: it goes over stdin (getPiInvocation), so a
 * large prompt cannot exceed the OS argv ceiling, which fails the spawn outright
 * rather than truncating (`E2BIG` on this platform).
 *
 * `groupArgs` is the child's group fragment, `--model` then `--thinking`, either
 * half possibly absent. Resolved by the CALLER: both are properties of the
 * child's ROLE, and this function is handed tools, not a name. One field rather
 * than a `model` beside a `thinking` so nothing composes the halves by hand.
 */
export function childArgs(
    tools: string,
    extensions: readonly string[] = [],
    groupArgs: readonly string[] = []
): string[] {
    const toolFlags = tools === '' ? ['--no-tools'] : ['--tools', tools]
    const internal = tools === '' ? [] : extensions
    return [...childBaseArgs(internal), ...groupArgs, '--mode', 'json', ...toolFlags]
}

/**
 * The one place `'unknown'` becomes the 0 both consumers already treat as
 * "no window". Written once so a future reader cannot re-introduce the optional
 * by handling the union at only one of the two sites that read it.
 */
function contextWindowTokens(cw: number | 'unknown'): number {
    return cw === 'unknown' || cw <= 0 ? 0 : cw
}

/**
 * Tool calls that can GROUND an APIS claim — i.e. return content a signature or
 * command could be cited from. `pi-worker-docs` (the primary), `read` and `grep`
 * (project source), and the web escalations `pi-worker-search`/`pi-worker-fetch`.
 *
 * `ls` and `find` are deliberately EXCLUDED: they return file and directory
 * NAMES, and APIS owns symbols by name only, never paths (see
 * RESEARCH_APIS_PROMPT in prompts.ts). Bare enumeration cannot verify a
 * signature, so a worker that fabricates its section from memory cannot launder
 * itself grounded by calling `ls` once — "one trivial `ls` then fabricate the
 * rest" still leaves groundingRetrievalCount at 0.
 *
 * The set is DERIVED from WORKER_CHANNELS (worker-channels.ts), not hand-kept.
 * Re-exported here only so worker-channels.test.ts can assert this module hands
 * back the same predicate.
 */
export {isGroundingRetrieval} from './worker-channels.js'

// RESEARCH_WORKER_TIMEOUT_MS and STALL_AFTER_MS live on the profile table
// (worker-profiles.ts): they are the default VALUES of two guard rows, and a
// default that lives apart from the table stating it is a second place to look.

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
 * A restart that hands the re-spawn nothing but a hint is why WORKER_TIMEOUT_HINT
 * above can tell a worker "do not re-explore ground you have already covered"
 * while giving it no record of what that ground was. It cannot comply, so it
 * re-reads the same files against the same clock and dies in the same place.
 *
 * Carrying the partial forward is what lets a restart converge instead of repeat.
 * The risk is real: a half-written or speculative entry, replayed under "already
 * established", is how a fabrication gets laundered into a final answer. That is
 * why `formatCarryForward` frames it as findings to VERIFY-or-DROP rather than as
 * settled fact.
 */
const CARRY_FORWARD_LIMIT = 24_000

/**
 * Restart reasons whose partial output is worth keeping.
 *
 * Exactly four, derived from WORKER_KILLS: `command-timeout`, `stream-stall`,
 * `worker-timeout` and `connection-error` all discard work the model genuinely
 * did. A loop kill and a leaked tool call do not — the first is by definition the
 * same call repeated, the second is malformed protocol text, and replaying either
 * would feed the failure back to itself.
 */
const CARRY_FORWARD_REASONS: ReadonlySet<WorkerKillId> = CARRY_FORWARD_IDS

/**
 * Does this partial output carry ANSWER CONTENT, or is it the model clearing its
 * throat?
 *
 * Keeping the LONGEST partial is not the same question, and it has an obvious
 * failure: a preamble sentence like
 *
 *     "Now let me get more details on the specific APIs and components I need:"
 *
 * beats an empty string on length and carries nothing.
 *
 * A research worker's answer is a list of lines that each name something and
 * describe it. The test is therefore structural, not lexical: at least TWO lines
 * that look like entries — a name, then a gap, then a description. Prose wraps at
 * no particular column and does not repeat that shape; the sentence above scores
 * zero entry lines.
 */
export function hasAnswerContent(text: string): boolean {
    return text.split('\n').filter(isEntryLine).length >= 2
}

/**
 * Is ONE line an entry — a name, a gap, then a description — rather than prose?
 *
 * Split out of `hasAnswerContent` so the same rule can decide what a line IS, not
 * just how many of them there are — a reader of a FILES section needs the same
 * test, and its own idea of an entry would count a preamble sentence or a leaked
 * `</tool_call>` as one.
 *
 * A leading `-`, `*`, `•` or `1.`/`1)` bullet is stripped first. What remains must
 * hold a two-space gap or a spaced dash and must NOT end in `.` or `:`. Prose
 * wraps at no particular column, so it carries neither; when it does carry one, it
 * ends in punctuation and an entry does not.
 */
export function isEntryLine(raw: string): boolean {
    const l = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()
    return /^\S.*?(?:\s{2,}|\s+[—–-]\s+)\S/.test(l) && !/[.:]$/.test(l)
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
    /**
     * Comma-separated tool whitelist passed to `pi --tools`. Defaults to
     * read,grep,find,ls; `''` means `--no-tools` (see childArgs).
     */
    tools?: string
    /** Internal extension entry-point paths to load via `-e <path>` (see childBaseArgs). */
    extensions?: readonly string[]
    /**
     * ONE more attempt after the loop budget is spent, with different tools and
     * a terminal hint, instead of returning the loop kill. It is not a retry:
     * no restart rule runs on it, and its result is the run's result.
     *
     * For a child whose deliverable is a text rewrite that never strictly
     * needed a read (refine): a model that thrashed re-reading files is stripped
     * of its tools and ordered to emit from what it has, because a hard fail
     * there kills a whole /task-auto run for a model that merely over-explored.
     * A child whose output depends on real reads must NOT carry one — with no
     * tools it would fabricate.
     */
    rescue?: {tools: string; hint: (hit: LoopHit) => string}
    /** Called for each tool execution start and text-writing event inside the worker. */
    onLine?: (line: string) => void
    /** Called when a tool call FINISHES, with its (truncatable) result — lets a caller
     *  log tool OUTPUTS, not just the command. */
    onToolResult?: (result: {
        name: string
        isError: boolean
        text: string
        toolCallId?: string
    }) => void
    /**
     * Called for each context snapshot derived from the child's `message_end`
     * events (same `--mode json` stream the phase children parse). Lets a
     * caller's status widget show the tokens/window progress bar for the worker
     * exactly like the phase widget, instead of omitting it.
     */
    onContextUsage?: (snapshot: ContextSnapshot) => void
    /**
     * The worker child's context window in tokens, or `'unknown'` when the
     * caller genuinely has none.
     *
     * REQUIRED, and required for the same reason `profile` below is. pi's event
     * stream carries NO window — the string `context_usage` appears nowhere in any
     * installed @earendil-works package, and its only usage-bearing JSON event is
     * `message_update` — so this parameter is the only source there is. Left
     * optional, a caller that omits it leaves `noteContext` seeing 0, and
     * `StallDetector`'s CONTEXT CHURN rule is gated on a positive window, so the
     * rule silently does not exist. That reads exactly like a rule that exists and
     * did not trip.
     *
     * WHY A WORD AND NOT `0` OR `null`. Both of those are what a caller types when
     * it has not thought about the question, and both disarm the rule silently.
     * `'unknown'` cannot be typed by accident, is greppable, and shows up in a diff
     * as a decision.
     *
     * Two consumers read it: the churn rule, and the caller's progress bar, which
     * shows a bare token count without a window. Both degrade on `'unknown'`.
     */
    contextWindow: number | 'unknown'
    /**
     * WHICH KIND of worker child this is — the whole guard policy, in one word.
     *
     * REQUIRED, and required on purpose. As independent optionals, a caller that
     * named none of the guard knobs still got a full policy and nobody could see
     * which one — so a child can end up running the strictest wall clock of the
     * three without anyone deciding it should. See worker-profiles.ts.
     */
    profile: WorkerProfileId
    /**
     * The facts the profile needs that are NOT policy: the gate's two watchdog
     * ceilings (user config) and which research worker is docs-capable.
     */
    policyInputs?: WorkerPolicyInputs
    /**
     * Whole guard rows laid over the profile's. TESTS AND HARNESSES ONLY — an
     * override at a production call site is the hand-picked subset this design
     * exists to stop. `worker-profiles.test.ts` enforces it: its "no production
     * source file passes an `override` to runWorker" test scans src/ for a leading
     * `override:` and fails on any hit.
     */
    override?: WorkerGuardOverride
    /**
     * The resolved policy this run will use, reported once before the first
     * attempt.
     *
     * WHY: asserting that a profile RESOLVES correctly proves nothing about
     * whether runWorker then READS it correctly — a rewiring that turns "0 means
     * off" into "0 means on" leaves every profile assertion green. This hook lets
     * a test drive the REAL call site and read back the REAL policy instead of
     * re-typing the table; worker-profiles.test.ts is where those assertions live.
     */
    onPolicy?: (policy: WorkerGuardPolicy) => void
    /** Backoff sleep, injectable so tests don't wait out the real delays. */
    sleepFor?: (ms: number) => Promise<void>
    /**
     * Called when a carried-forward partial is INJECTED into an attempt's prompt
     * — once per attempt that receives one. Distinct from `onRestart`, which says
     * an attempt was thrown away; this says the next one was actually handed its
     * findings. The two are separately observable because they can diverge: a
     * restart whose partial had no answer content injects nothing.
     */
    onCarryForward?: (info: {attempt: number; chars: number; promptCharsBefore: number}) => void
    /**
     * An already-resolved group fragment — `--model` then `--thinking` — or
     * `[]`/omitted to inherit both defaults exactly as before.
     *
     * Resolved by the CALLER because runWorker serves three different groups —
     * the research workers, the post-implementation gates, and the ad-hoc
     * `pi-worker` tool — and has nothing in its input that tells them apart.
     * Guessing here would give a verify gate the research workers' model.
     */
    groupArgs?: readonly string[]
    /**
     * Called once per DISCARDED attempt, at the moment the worker decides to
     * re-spawn — the only window in which a restart is observable at all.
     *
     * WHY: every restart branch below throws away a whole attempt's wall clock
     * along with its text, and `waitMs`/`workMs` describe the FINAL attempt only.
     * With no hook here a discarded attempt is structurally invisible — the worker
     * still returns `exitCode` 0 and reads as a clean success, and the lost time is
     * recoverable only by subtracting the reported wait+work from the timestamps
     * around the call.
     */
    onRestart?: (restart: WorkerRestart) => void
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
        // Push the deadline out, never past `started + ceilingMs`. Inert unless a
        // caller calls it. A disabled timeout (nothing armed) stays disabled —
        // extending "never" is meaningless — and an already-fired timer is not
        // resurrected.
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
export type WorkerRestartReason = (typeof RESTART_ORDER)[number]

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
    /** The hit itself on a `loop` restart, for a consumer that records the call. */
    loopHit?: LoopHit
    /**
     * This attempt was discarded for the RESCUE, not a retry: the loop budget
     * was spent, and what follows runs under `rescue`'s tools and hint.
     */
    rescue?: true
    /**
     * Characters of ANSWER TEXT this attempt had produced at the moment it was
     * thrown away.
     *
     * Recorded whatever `carryForward` says, because the DISCARD is the thing a
     * reader cannot otherwise see. Without it, "the guards worked and the run
     * returned almost nothing" and "the guards worked and the run threw away a
     * finished answer" print identically.
     *
     * It is an OBSERVATION, not a decision: harvesting into `salvage` is still
     * gated on the profile, and this number changes no behaviour.
     */
    partialChars: number
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
     * surface this through child-runner.ts; without it a swallowed provider error
     * reaches the caller as an indistinguishable empty answer and gets reported as
     * the useless "produced no output".
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
    commandTimedOut?: CommandKill
    /**
     * The final attempt was the `rescue`. Its text is the run's answer; a
     * rescue that produced none is honestly the loop kill it stood in for, and
     * the caller reports it as one.
     */
    rescued?: true
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
 * Everything the restart ladder reads about one finished attempt, plus the
 * budgets it draws on. Assembled once per attempt so the rules below can be
 * module-level data instead of six `if` blocks welded into `runWorker`'s closure.
 */
interface RestartState {
    loopHit?: LoopHit
    commandKill?: CommandKill
    streamStalled?: {idleMs: number}
    stalled: boolean
    /** The profile's `stalled.restart` switch. */
    restartOnStalled: boolean
    timedOut: boolean
    modelError?: string
    leaked: string | null
    /** A clean, complete run that answered with no text at all. */
    empty: boolean
    /** The profile's `empty-answer` switch. */
    restartOnEmpty: boolean
    /** The cap this attempt actually died against, not the configured one:
     *  `extend`/`progress` can push the deadline out during the attempt. */
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
/**
 * A stall hit carries no meaningful windowSize (rule 1 sets it to 0), so
 * printing the loop shape would misname why the attempt died.
 */
function loopDetail(hit: LoopHit): string {
    return hit.stall ?
            `${hit.call.name} ${hit.stall} ×${hit.count}`
        :   `${hit.call.name} ×${hit.count}/${hit.windowSize}`
}

export const RESTART_RULES: readonly RestartRule[] = [
    {
        // A loop-kill is restarted with a hint naming the offending call so the
        // re-spawn avoids it. Bounded by the shared restart budget.
        reason: 'loop',
        detect: s =>
            s.loopHit && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                {detail: loopDetail(s.loopHit)}
            :   null,
        hint: s =>
            s.loopHit!.stall ? formatStallHint(s.loopHit!.stall) : formatLoopHint(s.loopHit!),
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
        // A dead-backend kill, for the profiles that would rather earn the
        // verdict on every attempt than trust one probe sample. No hint: nothing
        // the model did caused it, and a hint in flight must survive the retry.
        reason: 'stalled',
        detect: s =>
            (
                s.stalled
                && !s.loopHit
                && s.restartOnStalled
                && s.restartBudgetSpent < MAX_LOOP_RESTARTS
            ) ?
                {detail: 'no output for the stall window and no endpoint answered'}
            :   null,
        counters: {shared: true}
    },
    {
        // A wall-clock timeout (the backstop for varied thrash the exact-match
        // detector misses) is also restartable, sharing the same budget. Skip when
        // a loop also tripped — the loop hint above is more specific.
        reason: 'worker-timeout',
        detect: s =>
            s.timedOut && !s.loopHit && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                // The EFFECTIVE cap, which `extend`/`progress` can have moved —
                // reporting the configured one would misname why this attempt died.
                {detail: `cap ${s.effectiveCapMs}ms`}
            :   null,
        hint: () => WORKER_TIMEOUT_HINT,
        counters: {shared: true}
    },
    {
        // A connection-class model error is restartable on the same budget, exactly
        // as runPhaseChild already treats it. Without it one dropped socket fails
        // the whole task at research, while the identical blip in refine or compose
        // is absorbed.
        //
        // pi retries a failed turn itself before reporting anything, and a run that
        // recovers reports no modelError at all (see JsonEventSink). So a SURFACED
        // connection error means pi's own budget is already spent, and a re-spawn
        // only helps when the outage outlasts it. The price is paid only on a
        // backend that is really gone: time-to-report grows by the extra spawns.
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
    },
    {
        // An empty completion on a clean run, for the profiles that treat it as
        // a swallowed provider error rather than an answer. No hint: there is
        // nothing to correct, and one already in flight must survive.
        reason: 'empty-answer',
        detect: s =>
            s.empty && !s.loopHit && s.restartOnEmpty && s.restartBudgetSpent < MAX_LOOP_RESTARTS ?
                {detail: 'no assistant text'}
            :   null,
        counters: {shared: true}
    }
]

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
    // Reassigned once at most, by the rescue.
    let tools = input.tools ?? DEFAULT_TOOLS
    let rescued = false
    // ONE resolution, before the first attempt. Every guard read below goes
    // through `policy`, so "which knobs is this child running" has exactly one
    // answer and it is observable (`onPolicy`) rather than inferable.
    const policy = applyOverride(
        WORKER_PROFILES[input.profile].resolve(input.policyInputs ?? {}),
        input.override
    )
    input.onPolicy?.(policy)
    const guards = policy.guards
    const clock = guards['worker-timeout']
    const timeoutMs = clock.timeoutMs
    let hint: string | null = null
    // Loop-kill and timeout share one restart budget, mirroring
    // runPhaseChild: a runaway worker gets re-spawned with a corrective
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
        // Announce the INJECTION, not just the restart. The prompt goes to the child
        // on stdin, so no log downstream of here can show it — without this hook
        // "the carry reached the re-spawn" could only be inferred from the answer,
        // which is inferring what a worker did from what it produced.
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
        // `--mode json` (childArgs) makes pi emit events as they happen instead
        // of buffering the assistant text and flushing on exit, which is what
        // makes the wait/work split below real — onFirstByte would otherwise
        // fire moments before close and leave workMs at nearly zero.
        const invocation = getPiInvocation(
            childArgs(tools, input.extensions ?? [], input.groupArgs ?? []),
            prompt
        )
        const tAttemptStart = Date.now()
        let tFirstByte: number | null = null
        // loop === false turns the guard off entirely (detector is null and no
        // tool call is ever flagged); otherwise build a detector from the override
        // or the default research/impl thresholds.
        const loopDetector =
            guards.loop.detector === false ?
                null
            :   new LoopDetector(
                    guards.loop.detector.window,
                    guards.loop.detector.threshold,
                    guards.loop.detector.pathThreshold
                )
        // Reset EACH attempt, like the loop detector: a restart discards the
        // previous attempt's calls along with its text, so a fresh child must not
        // inherit a dead streak it did not earn.
        const stallDetector =
            guards.loop.progress === false ?
                null
            :   new StallDetector(guards.loop.progress.limit, guards.loop.progress.churnFactor)
        // Arm the churn rule BEFORE the first tool call. pi's stream carries no
        // context event at all, so waiting for one leaves the rule permanently
        // disarmed. The parent knows the window at spawn time.
        stallDetector?.noteContext(contextWindowTokens(input.contextWindow))
        // Reset EACH attempt: on a restart the previous attempt's calls are
        // discarded with its text, so the count must describe only the attempt
        // whose text this call returns.
        let groundingRetrievalCount = 0
        const timeout = workerTimeout(input.signal, timeoutMs, clock.progressCeilingMs ?? undefined)
        // Per-tool-call watchdog for this attempt (null when off). Its abort is
        // OR'd with the worker timeout / external cancel into the child's signal.
        const cmdWatch = commandWatch(
            commandCeilingForAttempt(guards['command-timeout'], hangKills)
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
                    ...(guards.stalled === false ?
                        {}
                    :   {
                            stall: {
                                afterMs: guards.stalled.afterMs,
                                // `null` in the policy means the built-in probe.
                                // Kept as data so a resolved policy stays plain
                                // comparable data — see StalledGuard.probe.
                                probe:
                                    guards.stalled.probe
                                    ?? (() =>
                                        probeModelEndpoints(
                                            childModelEndpoints(
                                                modelSpecFromArgs(input.groupArgs ?? [])
                                            )
                                        ))
                            }
                        }),
                    ...(guards['stream-stall'] ? {streamInactivityMs: guards['stream-stall']} : {}),
                    onFirstByte: () => (tFirstByte = Date.now()),
                    onToolCall: call => {
                        cmdWatch?.onStart(call)
                        // A tool call is the worker working. Inert unless the
                        // caller opted into a progress-based deadline.
                        timeout.progress()
                        // Naming ONE tool and ONE of its parameters here would put
                        // that knowledge in the generic runner, so it asks the
                        // tool's own row in WORKER_CHANNELS instead.
                        if (
                            clock.fanout
                            && workerChannel(call.name)?.isProjectSourceLookup?.(
                                (call.args as Record<string, unknown> | undefined) ?? {}
                            ) === true
                        ) {
                            timeout.extend(clock.fanout.perLookupMs, clock.fanout.ceilingMs)
                        }
                        if (isGrounding(call.name)) groundingRetrievalCount++
                        // Loop detector first: it names the offending call and its
                        // hint is the more specific one. The stall detector is the
                        // backstop for the thrash shapes a 20-call argument window
                        // cannot see. A hit is returned to the runner, which kills
                        // the child and reports it as `kill.by === 'loop'`.
                        return loopDetector?.record(call) ?? stallDetector?.record(call) ?? null
                    },
                    // Output is the other half of "still working": a worker
                    // writing its answer is making progress even when it has no
                    // more tool calls to make.
                    onLine: line => {
                        timeout.progress()
                        input.onLine?.(line)
                    },
                    // Always wired, never conditional on the command watchdog: the
                    // sink only emits a tool-execution-end if a handler exists, and
                    // a completed tool call is the clearest progress signal there
                    // is. Without it a worker whose tool calls all succeed would
                    // still look idle to the deadline.
                    onToolResult: r => {
                        timeout.progress()
                        cmdWatch?.onEnd(r.toolCallId)
                        // The RESULT is what entered the child's context, so it —
                        // not the arguments — decides whether it learned anything.
                        stallDetector?.noteResult(r.text, r.isError)
                        input.onToolResult?.(r)
                    },
                    onContextUsage: snapshot => {
                        stallDetector?.noteContext(snapshot.contextWindow)
                        input.onContextUsage?.(snapshot)
                    },
                    ...(contextWindowTokens(input.contextWindow) > 0 ?
                        {contextWindow: contextWindowTokens(input.contextWindow)}
                    :   {})
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
        const noteRestart = (
            reason: WorkerRestartReason,
            detail: string | undefined,
            extra: Pick<WorkerRestart, 'loopHit' | 'rescue'> = {}
        ): void => {
            const record: WorkerRestart = {
                attempt: restarts.length + 1,
                reason,
                wallMs: tEnd - tAttemptStart,
                waitMs,
                workMs,
                partialChars: text.trim().length,
                ...(detail ? {detail} : {}),
                ...extra
            }
            restarts.push(record)
            input.onRestart?.(record)
            // Harvest here rather than in each branch: `noteRestart` is the one
            // place every `continue` already has to pass through, so a restart
            // path cannot be added that silently drops the attempt's work.
            // Longest-wins — a later attempt killed early should not replace a
            // fuller answer an earlier one had already reached.
            if (policy.carryForward && CARRY_FORWARD_REASONS.has(reason)) {
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
        const kill = result.kill
        const loopHit = kill?.by === 'loop' ? kill.hit : undefined
        const commandKill = kill?.by === 'command-timeout' ? kill : undefined
        const streamStalled = kill?.by === 'stream-stall' ? {idleMs: kill.idleMs} : undefined
        const stalled = kill?.by === 'stalled'

        // Only treat output as a leak on a clean, complete run — a non-zero exit
        // or abort yields partial text the caller already handles, and detecting
        // there would just mislabel the real failure.
        const clean = result.exitCode === 0 && !result.aborted
        const leaked = clean ? detectLeakedToolCall(text) : null

        // THE RESTART LADDER. Precedence is RESTART_RULES' row order; this loop
        // owns the ritual every rule would otherwise repeat: budget, hint, counters,
        // record-and-announce, backoff, re-spawn.
        //
        // Not run on the rescue attempt, which is final by contract, nor after a
        // cancel: a user who pressed ESC between attempts must not buy a spawn.
        const state: RestartState = {
            ...(loopHit ? {loopHit} : {}),
            ...(commandKill ? {commandKill} : {}),
            ...(streamStalled ? {streamStalled} : {}),
            stalled,
            restartOnStalled: guards.stalled !== false && guards.stalled.restart,
            timedOut,
            ...(result.modelError !== undefined ? {modelError: result.modelError} : {}),
            leaked,
            empty: clean && result.modelError === undefined && text.trim().length === 0,
            restartOnEmpty: guards['empty-answer'],
            effectiveCapMs,
            tools,
            restartBudgetSpent,
            connRetries,
            connectionRetries: guards['connection-error'],
            leakRetries
        }
        const ladderOpen = !rescued && input.signal?.aborted !== true
        let restarted = false
        for (const rule of ladderOpen ? RESTART_RULES : []) {
            const hit = rule.detect(state)
            if (!hit) continue
            if (rule.hint) hint = rule.hint(state)
            if (rule.counters.shared) restartBudgetSpent++
            if (rule.counters.leak) leakRetries++
            if (rule.counters.hang) hangKills++
            if (rule.counters.connection) connRetries++
            // Noted BEFORE any backoff sleep, so the record's wallMs stays the
            // attempt's own clock; the sleep lands in totalWallMs, where it belongs.
            noteRestart(rule.reason, hit.detail, loopHit ? {loopHit} : {})
            if (rule.backoffMs) await (input.sleepFor ?? defaultSleep)(rule.backoffMs(state))
            restarted = true
            break
        }
        if (restarted) continue
        // Reached only with the loop rule out of budget: the rules above all
        // decline a loop-killed attempt once the shared budget is spent.
        if (ladderOpen && loopHit && input.rescue) {
            rescued = true
            hint = input.rescue.hint(loopHit)
            tools = input.rescue.tools
            noteRestart('loop', loopDetail(loopHit), {loopHit, rescue: true})
            continue
        }
        // SALVAGE. Returning the LAST attempt's text unconditionally makes a
        // worker whose final attempt was killed early report nothing at all — even
        // when a discarded attempt produced a usable answer that was still in hand
        // at the moment it was thrown away. A restart budget is meant to buy more
        // chances at an answer, not to overwrite a good attempt with a worse one.
        //
        // Gated on the final attempt having FAILED, not on it being shorter. A
        // worker that finished cleanly has answered, and a short answer is a
        // legitimate answer — length would let a long half-finished fragment
        // override a concise correct one, which is the opposite of the fix.
        // ASK THE LADDER — do not restate it. Hand-writing this test restates the
        // taxonomy `worker-failure.ts` owns, and a restatement drifts: drop
        // `leakedToolCall` or a plain non-zero `exitCode` from it and an attempt
        // that produced nothing usable counts as NOT failed, so salvage is skipped
        // and a good earlier partial is overwritten — the outcome the comment above
        // forbids.
        //
        // The two non-kill terms stay explicit because `worker-failure.ts`
        // deliberately excludes them as CONSUMER policy: an empty answer and a
        // reported `modelError` on a run that still produced text are not kills.
        const killCause = classifyWorkerFailure({
            exitCode: result.exitCode,
            aborted: result.aborted,
            timedOut,
            ...(stalled ? {stalled: true} : {}),
            ...(loopHit ? {loopHit} : {}),
            ...(leaked ? {leakedToolCall: leaked} : {}),
            ...(commandKill ? {commandTimedOut: commandKill} : {}),
            ...(streamStalled ? {streamStalled} : {})
        })
        const finalAttemptFailed =
            killCause !== undefined || result.modelError !== undefined || text.trim().length === 0
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
            ...(stalled ? {stalled: true} : {}),
            ...(streamStalled ? {streamStalled} : {}),
            ...(commandKill ?
                {
                    commandTimedOut: {
                        toolName: commandKill.toolName,
                        timeoutMs: commandKill.timeoutMs,
                        ...(commandKill.detail ? {detail: commandKill.detail} : {})
                    }
                }
            :   {}),
            ...(rescued ? {rescued: true} : {})
        }
    }
}
