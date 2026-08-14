/**
 * Child process runner for the pi-task orchestrator.
 *
 * Thin wrapper layer over the unified `runChild` in `shared/child-process.ts`.
 * Provides JSON event-stream parsing, loop detection, and context-usage tracking
 * for phase-level child pi invocations.
 */

import {spawn} from 'node:child_process'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {
    runChild as runChildUnified,
    type SpawnFn,
    type ContextSnapshot,
    type ToolCall,
    type LoopHit
} from '../shared/child-process.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {LoopDetector} from './loop-detector.js'
import {
    detectLeakedToolCall,
    leakedToolCallHint,
    MAX_LEAK_RETRIES
} from '../shared/leaked-tool-call.js'
import {readSection, setTaskSection} from './task-io.js'
import {streamStallCause} from '../shared/stream-watchdog.js'
import {getConfig} from '../config/config.js'
import type {DebugLine} from './debug-log.js'

// ─── Loop detection constants ────────────────────────────────────────────────
// Defined here (not in phases.ts) to avoid a circular dependency:
//   phases.ts → child-runner.ts → phases.ts

export const LOOP_WINDOW = 20
export const LOOP_THRESHOLD = 5
export const MAX_LOOP_RESTARTS = 2 // 3 strikes total (initial attempt + 2 restarts)
// MAX_LEAK_RETRIES lives in shared/leaked-tool-call.ts (imported above).

// ─── Phase-child wall-clock cap ──────────────────────────────────────────────

/**
 * Hard wall-clock bound on ONE spawn of a phase child.
 *
 * The loop detector above only sees IDENTICAL repeated calls; a child that
 * re-reads the same design file at varying offsets slips past it and, with pi
 * compacting its context whenever the window fills, never exits on its own.
 * mx5-n 2026-08-14 is the observed case: a decompose child ran 16m23s at
 * 117,370 of a 120,064-token window, adding ~56k tokens of tool output per
 * minute, and had to be killed by hand. `streamInactivityMs` cannot catch it —
 * that guard fires on SILENCE and this child was the opposite of silent.
 *
 * Sized against measured HEALTHY planning children on the same local 27B
 * backend, which is the slowest thing we run: requirement extraction 54s,
 * artifact closure 47s, decompose 89s (22 titles), coverage 17s, and a whole
 * plan phase (clarify + two extractions + decompose) 321s end to end. Ten
 * minutes is 3-6x the slowest of those and well under the runaway, so it ends
 * the pathology without ever trimming honest work. Deliberately far above
 * RESEARCH_WORKER_TIMEOUT_MS (240s): a research worker answers one question,
 * a planning child reasons over the whole design doc.
 */
export const PHASE_CHILD_TIMEOUT_MS = 600_000

/**
 * Restart hint after a phase child burns its whole wall-clock budget. It
 * diagnoses over-exploration, which is what the cap actually catches — the same
 * job WORKER_TIMEOUT_HINT does for research workers.
 */
export const PHASE_TIMEOUT_HINT =
    '[SYSTEM NOTE: Your previous attempt ran out of time before answering — you '
    + 'were re-reading source material you had already seen. Read each file AT '
    + 'MOST ONCE, then write your answer from what you have. Do not re-open a '
    + 'file you have already read.]'

/**
 * Combine the caller's abort signal with a wall-clock timer into one signal,
 * keeping the two causes apart: `timedOut()` is true only when the timer fired,
 * never when the user cancelled — so a cap can restart the child while a cancel
 * still ends the run. `ms <= 0` disables the timer entirely.
 *
 * (workers/pi-worker-core.ts has the same shape for research workers. It is not
 * shared because that module imports FROM this one; a common home for it would
 * be worth it if a third caller ever appears.)
 */
function phaseTimeout(
    external: AbortSignal,
    ms: number
): {signal: AbortSignal; timedOut: () => boolean; cleanup: () => void} {
    const ctrl = new AbortController()
    let firedByTimer = false
    const armed = ms > 0 && Number.isFinite(ms)
    const timer =
        armed ?
            setTimeout(() => {
                firedByTimer = true
                ctrl.abort()
            }, ms)
        :   undefined
    const onExternal = (): void => ctrl.abort()
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', onExternal, {once: true})
    return {
        signal: ctrl.signal,
        timedOut: () => firedByTimer,
        cleanup: () => {
            if (timer) clearTimeout(timer)
            external.removeEventListener('abort', onExternal)
        }
    }
}

/** Thrown when a phase child spends its whole restart budget hitting the cap. */
export class PhaseTimeoutError extends Error {
    constructor(
        readonly childName: string,
        readonly budgetMs: number,
        readonly attempts: number
    ) {
        super(
            `${childName} child exceeded its ${Math.round(budgetMs / 1000)}s budget on all `
                + `${attempts} attempt(s) — it never stopped working long enough to answer`
        )
        this.name = 'PhaseTimeoutError'
    }
}

// ─── Connection-error retry ──────────────────────────────────────────────────

/**
 * A connection-class model error is transient: a single dropped fetch to a live
 * endpoint, not a repeatable mistake. On a local single-slot server (e.g.
 * llama-server with `--parallel 1`) pi-task's own concurrent fan-out can briefly
 * saturate the slot, and one request fails to connect even though the model is
 * up and the next request succeeds. pi already retries internally, but those
 * retries don't always absorb it on a saturated local server — and pi-task's
 * fail-fast then kills the whole task (and, under /task-auto, the whole run) for
 * a single blip. We retry these within the existing strike/leak budget.
 *
 * A NON-connection model error (bad request, context-length overflow, auth,
 * provider 5xx that names a real fault) still fails fast: re-spawning against
 * the same request won't fix it, so burning the budget only delays the report.
 */
const CONNECTION_ERROR_RE =
    /\b(?:connection error|connection (?:lost|closed|reset|refused|aborted)|econnreset|econnrefused|econnaborted|epipe|etimedout|enetunreach|enetdown|eai_again|socket hang up|fetch failed|network (?:error|timeout)|premature close|request timed out|terminated|unreachable)\b/i

export function isConnectionError(cause: string): boolean {
    return CONNECTION_ERROR_RE.test(cause)
}

/** Exponential backoff before a connection-error retry: 500ms, 1s, 2s, …, so a
 *  brief saturation window can drain before we re-issue the request. */
export function connectionRetryBackoffMs(attempt: number): number {
    return 500 * 2 ** attempt
}

const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>(resolve => setTimeout(resolve, ms))

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PhaseRunResult {
    text: string
    exitCode: number
    stderr: string
    loopHit?: LoopHit
    /** Set when the assistant text contains an unexecuted, leaked tool call. */
    leakedToolCall?: string
    /** Set when the child's final turn failed with stopReason "error" (model/provider failure). */
    modelError?: string
}

// ─── Spawn helpers ───────────────────────────────────────────────────────────

export function childArgs(tools: string): string[] {
    // `--mode json` puts the child into the structured event stream the
    // unified runner parses in `mode: 'json-events'`. Without it the child
    // emits plain text, every line fails JSON.parse, finalText stays empty,
    // and every phase fails with "X child produced no output". Was silently
    // dropped in the 4e34f96 split-refactor; do not remove again.
    //
    // An empty `tools` string means "no tools at all" — emit `--no-tools`
    // instead of `--tools ''` (which pi would reject). Used by pure-judgment
    // phases like critique-triage that should reason only over the text we
    // hand them, never spend time reading the repo.
    //
    // The prompt is NOT an argv element: it goes to the child over stdin (see
    // runChild below / getPiInvocation), so a large inlined-design prompt can't
    // overflow the OS command-line limit (Windows `spawn ENAMETOOLONG`).
    const toolFlags = tools === '' ? ['--no-tools'] : ['--tools', tools]
    return [...childBaseArgs(), '--mode', 'json', ...toolFlags]
}

// Sentinel error thrown when the user dismisses a grill-me dialog.
// Defined here (not in failure-classifier.ts) to avoid circular dependency.
export const USER_CANCELLED = '__user_cancelled__'

// ─── Core child runner (JSON event-stream mode) ─────────────────────────────

/**
 * Run a child pi process with JSON event-stream output, loop detection, and
 * context-usage tracking. This is the typed convenience wrapper used by
 * phase-level code.
 */
export async function runChild(
    cwd: string,
    tools: string,
    prompt: string,
    signal: AbortSignal,
    onLine?: (line: string) => void,
    onContextUsage?: (snapshot: ContextSnapshot) => void,
    onToolCall?: (call: ToolCall) => LoopHit | null,
    spawnFn?: SpawnFn
): Promise<PhaseRunResult> {
    const invocation = getPiInvocation(childArgs(tools), prompt)
    let loopHit: LoopHit | undefined

    const result = await runChildUnified(
        spawnFn ?? (spawn as unknown as SpawnFn),
        invocation,
        cwd,
        signal,
        {
            mode: 'json-events',
            // A hung model stream reports nothing at all, so without this the
            // phase child waits forever (mx5 run 14: ~2.9h of dead air). The kill
            // is reported below as a connection-class cause, which routes it into
            // the retry/backoff path this file already has for a LOUD disconnect.
            streamInactivityMs: getConfig().streamInactivityMs,
            onLine,
            onContextUsage,
            onToolCall: call => {
                if (!onToolCall) return null
                const hit = onToolCall(call)
                if (hit && !loopHit) {
                    loopHit = hit
                }
                return hit // propagate to unified runner so it can kill
            }
        }
    )

    // Use `||` (not `??`) so an empty string from json-events mode falls
    // back to raw stdout. Without this, a child that exits 0 but emits no
    // assistant text (e.g. model API error swallowed in json mode) always
    // fails with the unhelpful "X child produced no output" — the raw
    // stdout/stderr that might contain the real error is discarded.
    const text = result.text || result.stdout.trim()
    // The stream watchdog's kill leaves no provider error to report (that is the
    // whole failure mode), so name it here rather than letting it surface as the
    // meaningless "produced no output". Never overwrite a real reported cause.
    const modelError =
        result.modelError
        ?? (result.streamStalled ? streamStallCause(result.streamStalled.idleMs) : undefined)
    return {
        text,
        // WE killed this child, so its exit status describes our own SIGTERM, not
        // the child's verdict. Report 0 and let `modelError` carry the cause —
        // otherwise the wrappers' `exitCode !== 0` guard throws a bare "child
        // failed" before the connection-error retry ever gets to look.
        exitCode: result.streamStalled ? 0 : result.exitCode,
        stderr: result.stderr.trim(),
        loopHit,
        modelError,
        // A tool call the model wrote as text (wrong dialect) never executed and
        // sailed past the structured-event guards above; flag it so the wrappers
        // can re-prompt instead of accepting the unexecuted call. Only meaningful
        // when the run otherwise succeeded — a loop kill truncates text mid-stream.
        leakedToolCall: loopHit ? undefined : (detectLeakedToolCall(text) ?? undefined)
    }
}

// ─── Phase-level wrappers ────────────────────────────────────────────────────

interface PhaseDeps {
    cwd: string
    taskId: string
    signal: AbortSignal
    onChildOutput?: (line: string) => void
    onContextUsage?: (snapshot: ContextSnapshot) => void
    /**
     * Record a sub-step duration under the currently running top-level phase.
     * The orchestrator rebinds this between phases so each call lands in the
     * right phase's children array. Phases that don't care can ignore it.
     */
    recordSubStep?: (label: string, ms: number) => void
    spawn?: SpawnFn
    /**
     * Wall-clock budget for ONE spawn of this child, in ms. Defaults to
     * PHASE_CHILD_TIMEOUT_MS; `0` disables the cap. Mirrors runWorker's
     * `timeoutMs` input, which is the same backstop one layer down
     * (workers/pi-worker-core.ts). Tests inject a short budget.
     */
    timeoutMs?: number
    /**
     * Write a timestamped line to the per-task debug log. Fire-and-forget, and
     * UNSET entirely when the trail is off — so a caller must keep the `?.` and
     * must not do work to build a message outside the call.
     *
     * `kind` defaults to `'event'` (a decision or guard action, kept at the
     * default level). Pass `'stream'` for raw child output and tool results,
     * which only the `full` level keeps. See debug-log.ts.
     */
    logDebug?: (msg: string, kind?: DebugLine) => void
    /** Injectable delay for connection-error backoff; defaults to a real timer.
     *  Tests override it with a no-op so retries don't actually sleep. */
    sleepFor?: (ms: number) => Promise<void>
}

export type {PhaseDeps}

// ─── Shared error-triage ladder ──────────────────────────────────────────────

/**
 * What the caller should do next after `triageChildResult` has looked at a
 * finished child. Either the run is good (`done`, carrying the assistant text)
 * or the caller must spend another attempt.
 *
 * On a retry, `hint` is the correction to prepend to the next prompt. It is
 * OMITTED (not null) when this rung has nothing to correct — the caller then
 * keeps whatever hint it was already carrying, exactly as the two hand-written
 * ladders did by falling through to `continue` without touching it.
 */
type LadderStep = {done: true; text: string} | {done: false; hint?: string}

/**
 * The error-triage ladder both phase wrappers run over a finished child, in
 * this fixed order: non-zero exit → model error → empty completion → leaked
 * tool call. Callers own the loop, the prompt and the hint; this owns the
 * verdict, so a fix to any rung lands in every caller at once.
 *
 * `attempt` is the caller's 0-based counter (its attempt/strike), `budget` the
 * matching restart allowance (MAX_LEAK_RETRIES for runPhaseChild's leak budget,
 * MAX_LOOP_RESTARTS for runPhaseWithLoopGuard's strike budget) — so both run
 * `budget + 1` attempts in total before a rung gives up and throws.
 *
 * `verb` names the caller's restart in the debug log ("retry" for runPhaseChild,
 * "restart" for runPhaseWithLoopGuard). It is the only externally visible thing
 * that differs between the two, and the only way to tell from a debug log which
 * wrapper produced a given line — so it is passed in rather than hardcoded.
 *
 * A loop kill (`r.loopHit`) is NOT handled here: only runPhaseWithLoopGuard
 * detects loops, and it must consume the hit before calling this.
 */
async function triageChildResult(
    deps: PhaseDeps,
    name: string,
    r: PhaseRunResult,
    attempt: number,
    budget: number,
    verb: 'retry' | 'restart'
): Promise<LadderStep> {
    if (r.exitCode !== 0) {
        throw new Error(`${name} child failed: ${r.stderr || '(no stderr)'}`)
    }
    if (r.modelError) {
        // The model/provider failed (pi exited 0 with a stopReason "error"
        // turn). A connection-class cause is transient — re-spawn within the
        // caller's budget after a backoff; anything else fails fast (pi already
        // retried, and re-spawning won't fix a real fault).
        if (isConnectionError(r.modelError) && attempt < budget) {
            deps.logDebug?.(
                `${name}: connection error "${r.modelError}" — ${verb} `
                    + `${attempt + 1}/${budget}`
            )
            await (deps.sleepFor ?? defaultSleep)(connectionRetryBackoffMs(attempt))
            return {done: false}
        }
        throw new ModelError(name, r.modelError)
    }
    if (r.text.trim().length === 0) {
        // An empty completion (exit 0, no assistant text, no stderr) is almost
        // always transient — a model/API error swallowed inside --mode json,
        // not a repeatable mistake — so re-spawn rather than fail the phase.
        // There's nothing to correct, so we carry no hint (and leave any hint
        // the caller already has alone). Shares the caller's budget: budget+1
        // attempts, then surface the error.
        if (attempt === budget) {
            throw new Error(
                `${name} child produced no output${r.stderr ? ' — stderr: ' + r.stderr : ''}`
            )
        }
        return {done: false}
    }
    if (r.leakedToolCall) {
        if (attempt === budget) {
            throw new LeakedToolCallError(name, r.leakedToolCall)
        }
        return {done: false, hint: leakedToolCallHint(r.leakedToolCall)}
    }
    return {done: true, text: r.text}
}

/**
 * Run a child pi and return its assistant text. Throws if exit code != 0.
 *
 * If the child leaks a tool call as plain text (wrong dialect — never executed),
 * re-prompt with a correction hint up to MAX_LEAK_RETRIES times; if it keeps
 * leaking, throw LeakedToolCallError rather than returning the unexecuted call.
 * Empty completions and connection-class model errors share that same budget —
 * see triageChildResult, which decides every one of those cases.
 *
 * TWO RUNAWAY GUARDS ride the same budget, because this is the runner every
 * /task-auto planning child goes through (clarify, decompose, coverage,
 * contract-extract) and until mx5-n 2026-08-14 it had neither:
 *   • a LoopDetector, so an identical repeated tool call is killed and
 *     re-prompted instead of being allowed to fill the context window;
 *   • PHASE_CHILD_TIMEOUT_MS, the backstop for the varied-args thrash the
 *     detector cannot see — the shape that actually cost us a 16-minute
 *     decompose child that was never going to return.
 * Both are checked BEFORE the triage ladder: we killed the child, so its exit
 * status describes our SIGTERM and says nothing about its verdict.
 */
export async function runPhaseChild(
    deps: PhaseDeps,
    name: string,
    tools: string,
    prompt: string
): Promise<string> {
    let hint: string | null = null
    const loopHistory: LoopHit[] = []
    const budgetMs = deps.timeoutMs ?? PHASE_CHILD_TIMEOUT_MS
    for (let attempt = 0; attempt <= MAX_LEAK_RETRIES; attempt++) {
        const detector = new LoopDetector(LOOP_WINDOW, LOOP_THRESHOLD)
        const clock = phaseTimeout(deps.signal, budgetMs)
        let r: PhaseRunResult
        try {
            r = await runChild(
                deps.cwd,
                tools,
                prependHint(hint, prompt),
                clock.signal,
                deps.onChildOutput,
                deps.onContextUsage,
                call => detector.record(call),
                deps.spawn
            )
        } finally {
            clock.cleanup()
        }
        // A user cancel must not be mistaken for either guard.
        if (deps.signal.aborted) throw new Error(USER_CANCELLED)
        if (r.loopHit) {
            loopHistory.push(r.loopHit)
            if (attempt === MAX_LEAK_RETRIES) throw new LoopExhaustedError(name, loopHistory)
            deps.logDebug?.(
                `${name}: looped on ${r.loopHit.call.name} — retry ${attempt + 1}/${MAX_LEAK_RETRIES}`
            )
            hint = formatLoopHint(r.loopHit)
            continue
        }
        if (clock.timedOut()) {
            if (attempt === MAX_LEAK_RETRIES) {
                throw new PhaseTimeoutError(name, budgetMs, MAX_LEAK_RETRIES + 1)
            }
            deps.logDebug?.(
                `${name}: exceeded its ${Math.round(budgetMs / 1000)}s budget — `
                    + `retry ${attempt + 1}/${MAX_LEAK_RETRIES}`
            )
            hint = PHASE_TIMEOUT_HINT
            continue
        }
        const step = await triageChildResult(deps, name, r, attempt, MAX_LEAK_RETRIES, 'retry')
        if (step.done) return step.text
        if (step.hint !== undefined) hint = step.hint
    }
    // Unreachable: the loop returns clean text or throws on the final leak.
    throw new LeakedToolCallError(name, '(unknown)')
}

export function formatLoopHint(hit: LoopHit): string {
    const argsStr = JSON.stringify(hit.call.args)
    return (
        `[SYSTEM NOTE: Your prior attempt called ${hit.call.name}(${argsStr}) `
        + `${hit.count} times in the last ${hit.windowSize} tool calls — you appeared to be `
        + `stuck in a loop. Avoid repeating that exact call; if you've already seen its result, `
        + `work from memory or pick a different angle.]`
    )
}

/**
 * Terminal hint for the degrade attempt: the model has thrashed through the whole
 * strike budget re-reading files without converging, so we strip its tools and
 * order it to emit the deliverable NOW from what it already has. Used only by
 * read-only analysis phases (refine) whose output is a text rewrite that never
 * strictly required a successful read — far better to ship a best-effort spec
 * than to hard-fail the whole /task-auto run. See countRevisits / LoopExhausted.
 */
export function formatDegradeHint(hit: LoopHit): string {
    return (
        `[SYSTEM NOTE: You called ${hit.call.name}(${JSON.stringify(hit.call.args)}) `
        + `repeatedly and made no forward progress — you are stuck re-reading the same files. `
        + `You now have NO tools: you cannot read, grep, list, or open anything further. `
        + `STOP exploring. Produce the COMPLETE required output IMMEDIATELY, using only the task `
        + `description and what you have already seen. Emit the full structured result now — do not `
        + `ask to read more, do not explain, just output the final answer.]`
    )
}

export function prependHint(hint: string | null, prompt: string): string {
    return hint === null ? prompt : `${hint}\n\n${prompt}`
}

async function appendLoopEvent(
    cwd: string,
    taskId: string,
    phase: string,
    hit: LoopHit,
    strike: number,
    outcome: 'restarted with hint' | 'phase failed' | 'degraded — no-tools final attempt'
): Promise<void> {
    const ts = new Date().toISOString()
    const argsStr = JSON.stringify(hit.call.args)
    const line =
        `- ${ts}  ${phase}  strike ${strike}/${MAX_LOOP_RESTARTS + 1}  `
        + `${hit.call.name}(${argsStr}) ×${hit.count} in last ${hit.windowSize} calls  → ${outcome}`
    const existing = (await readSection(cwd, taskId, 'loop events')) ?? ''
    const next = existing ? `${existing}\n${line}` : line
    await setTaskSection(cwd, taskId, 'loop events', next)
}

/**
 * Run a phase child with loop detection. On a detected loop, kill and re-spawn
 * with a hint that names the offending call. Cap at MAX_LOOP_RESTARTS restarts;
 * the (MAX_LOOP_RESTARTS+1)th loop throws LoopExhaustedError.
 */
export interface LoopGuardOptions {
    /**
     * When the strike budget is exhausted by loops, do NOT fail the phase. Run
     * ONE final attempt with NO tools and a terminal hint ordering the model to
     * emit its output from what it already has. Only safe for phases whose
     * deliverable is a pure text rewrite that never strictly required a read
     * (refine) — a hard-fail there kills the whole /task-auto run for a model
     * that simply over-explored. Research/location phases must NOT enable this:
     * their output depends on real reads, so a no-tools fallback would fabricate.
     */
    degradeOnExhaustion?: boolean
}

export async function runPhaseWithLoopGuard(
    deps: PhaseDeps,
    name: string,
    tools: string,
    buildPrompt: (loopHint: string | null) => string,
    opts: LoopGuardOptions = {}
): Promise<string> {
    const loopHistory: LoopHit[] = []
    // Carries the correction hint (loop OR leaked-tool-call) into the next strike.
    let nextHint: string | null = null
    for (let strike = 0; strike <= MAX_LOOP_RESTARTS; strike++) {
        if (deps.signal.aborted) throw new Error(USER_CANCELLED)
        const detector = new LoopDetector(LOOP_WINDOW, LOOP_THRESHOLD)
        const prompt = buildPrompt(nextHint)
        const r = await runChild(
            deps.cwd,
            tools,
            prompt,
            deps.signal,
            deps.onChildOutput,
            deps.onContextUsage,
            call => detector.record(call),
            deps.spawn
        )
        if (deps.signal.aborted) throw new Error(USER_CANCELLED)
        if (r.loopHit) {
            const isLastStrike = strike === MAX_LOOP_RESTARTS
            loopHistory.push(r.loopHit)
            const lastOutcome =
                opts.degradeOnExhaustion ? 'degraded — no-tools final attempt' : 'phase failed'
            await appendLoopEvent(
                deps.cwd,
                deps.taskId,
                name,
                r.loopHit,
                strike + 1,
                isLastStrike ? lastOutcome : 'restarted with hint'
            )
            if (isLastStrike) {
                if (opts.degradeOnExhaustion) {
                    return await runDegradedFinalAttempt(
                        deps,
                        name,
                        buildPrompt,
                        r.loopHit,
                        loopHistory
                    )
                }
                throw new LoopExhaustedError(name, loopHistory)
            }
            nextHint = formatLoopHint(r.loopHit)
            continue
        }
        // Everything past the loop kill is the shared ladder: exit code, model
        // error (connection-class restarts within the strike budget), empty
        // completion, leaked tool call. The strike budget is shared with the
        // loop restarts above — MAX_LOOP_RESTARTS+1 attempts across all causes.
        const step = await triageChildResult(deps, name, r, strike, MAX_LOOP_RESTARTS, 'restart')
        if (step.done) return step.text
        // Only a leak produces a new correction hint; the other rungs have
        // nothing to correct and leave any loop hint already in flight alone.
        if (step.hint !== undefined) nextHint = step.hint
    }
    throw new LoopExhaustedError(name, loopHistory)
}

/**
 * Final degrade attempt after the loop budget is spent: re-spawn the child with
 * NO tools and a terminal hint, so a model that thrashed re-reading files is
 * forced to emit its deliverable from what it already has. With no tools there
 * are no tool calls, so no loop can recur — the only failure modes left are a
 * dead turn (non-zero exit, model error) or empty output, any of which fall back
 * to the original LoopExhaustedError so the phase still fails honestly when even
 * the degrade produces nothing.
 */
async function runDegradedFinalAttempt(
    deps: PhaseDeps,
    name: string,
    buildPrompt: (loopHint: string | null) => string,
    hit: LoopHit,
    loopHistory: LoopHit[]
): Promise<string> {
    deps.logDebug?.(`${name}: loop budget exhausted — degrading to a no-tools final attempt`)
    const r = await runChild(
        deps.cwd,
        '', // --no-tools: the model cannot read/grep/list, only answer
        buildPrompt(formatDegradeHint(hit)),
        deps.signal,
        deps.onChildOutput,
        deps.onContextUsage,
        undefined,
        deps.spawn
    )
    if (r.exitCode !== 0 || r.modelError || r.text.trim().length === 0) {
        throw new LoopExhaustedError(name, loopHistory)
    }
    return r.text
}

/**
 * Run a child up to twice; the second attempt gets `emphasized=true` to escalate
 * the prompt. On success, return the validator's value; on two failures, throw
 * the caller-supplied error built from the last problem string.
 */
export async function runWithEmphasisRetry<T>(
    deps: PhaseDeps,
    name: string,
    tools: string,
    build: (retryProblem: string | null) => string,
    validate: (text: string) => {ok: true; value: T} | {ok: false; problem: string},
    onFail: (problem: string) => Error
): Promise<T> {
    let lastProblem = 'unknown'
    for (let attempt = 0; attempt < 2; attempt++) {
        const text = await runPhaseChild(
            deps,
            name,
            tools,
            build(attempt === 0 ? null : lastProblem)
        )
        const result = validate(text)
        if (result.ok) return result.value
        lastProblem = result.problem
    }
    throw onFail(lastProblem)
}

// ─── LoopExhaustedError ──────────────────────────────────────────────────────

export class LoopExhaustedError extends Error {
    constructor(
        public readonly phase: string,
        public readonly history: LoopHit[]
    ) {
        super(`loop detected ${history.length} times in ${phase}`)
        this.name = 'LoopExhaustedError'
    }
}

// ─── ModelError ──────────────────────────────────────────────────────────────

/**
 * Thrown when a phase child's final turn failed with stopReason "error" — the
 * model/provider died (local model disconnect, fetch failed, socket hang up,
 * provider 5xx) after pi exhausted its own internal retries. pi reports this as
 * an agent_end with empty assistant text, which would otherwise surface as the
 * misleading "produced no output"; this names the real cause instead.
 *
 * Fail-fast: not retried at the pi-task layer. pi already retried the retryable
 * cases; re-spawning a fresh child against the same dead endpoint only burns
 * time and buries the real error. Restart the model/provider, then resume.
 */
export class ModelError extends Error {
    constructor(
        public readonly phase: string,
        public readonly cause: string
    ) {
        super(`${phase} child: model error — ${cause}`)
        this.name = 'ModelError'
    }
}

// ─── LeakedToolCallError ─────────────────────────────────────────────────────

/**
 * Thrown when a phase child repeatedly wrote a tool call as plain text (a markup
 * dialect pi's harness didn't parse) instead of invoking it. The call never ran,
 * so the phase output is untrustworthy — fail loudly rather than check it off.
 */
export class LeakedToolCallError extends Error {
    constructor(
        public readonly phase: string,
        public readonly marker: string
    ) {
        super(
            `${phase} child wrote a tool call as text instead of invoking it `
                + `(${marker.trim()}) — it never ran`
        )
        this.name = 'LeakedToolCallError'
    }
}
