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
import {StallDetector, formatStallHint} from './stall-detector.js'
import {
    detectLeakedToolCall,
    leakedToolCallHint,
    MAX_LEAK_RETRIES
} from '../shared/leaked-tool-call.js'
import {readSection, setTaskSection} from './task-io.js'
import {streamStallCause} from '../shared/stream-watchdog.js'
import {getConfig} from '../config/config.js'
import {groupThinkingArgs} from '../config/reasoning-args.js'
import {reasoningGroupForChild} from '../config/reasoning.js'
import type {DebugLine} from './debug-log.js'
// Type-only: `PhaseDeps` declares the research/auto-answer seams, and a seam is
// declared by the shape of the thing it stands in for. Erased at compile time,
// so this does not make the child runner depend on the worker modules.
import type {RunWorkerInput, RunWorkerResult} from '../workers/pi-worker-core.js'
import type {docsRaw, docsFocused} from '../workers/docs-core.js'
import type {fetchRaw, fetchFocused} from '../workers/fetch-core.js'
import type {npmVersionLookup} from '../workers/npm-version.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'

// ─── Loop detection constants ────────────────────────────────────────────────
// Defined here (not in phases.ts) to avoid a circular dependency:
//   phases.ts → child-runner.ts → phases.ts

export const LOOP_WINDOW = 20
export const LOOP_THRESHOLD = 5
export const MAX_LOOP_RESTARTS = 2 // 3 strikes total (initial attempt + 2 restarts)
// MAX_LEAK_RETRIES lives in shared/leaked-tool-call.ts (imported above).

// ─── Phase-child wall-clock cap ──────────────────────────────────────────────

/**
 * Optional wall-clock bound on ONE spawn of a phase child. DEFAULT: OFF.
 *
 * It used to default to 600_000, sized against measured HEALTHY planning
 * children on one local 27B backend (decompose 89s, whole plan phase 321s) on
 * the reasoning that ten minutes was a 3-6x margin over honest work.
 *
 * That premise was measured and is false. Replaying ONE captured auto-decompose
 * request against the same backend with reasoning ON, n=10, everything else
 * byte-identical (2026-08-17): all ten answered correctly with 26-42 titles, and
 * every one took 610-927s. The cap would have killed 10 out of 10 GOOD runs and
 * then failed the phase with PhaseTimeoutError. The number was not measuring the
 * pathology, it was measuring one model's speed on one day.
 *
 * The runaway it was there to catch — a decompose child that ran 16m23s at
 * 117,370 of a 120,064-token window, forward-paging past the loop detector — is
 * now caught by StallDetector (stall-detector.ts), which bounds NON-PROGRESS and
 * CONTEXT CHURN instead of elapsed seconds. Both of those are properties of the
 * pathology, so neither has to be re-tuned for a slower model or a bigger repo.
 *
 * The value and the plumbing stay for a caller that genuinely wants a hard stop
 * (tests inject a short one), but nothing sets it in production. Pass
 * `timeoutMs` explicitly to arm it.
 */
export const PHASE_CHILD_TIMEOUT_MS = 0

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

export function childArgs(
    tools: string,
    extensions: readonly string[] = [],
    /**
     * An already-resolved `['--thinking', level]`, or `[]` for "emit no flag".
     * Resolved by the CALLER, never here: the level is a property of the child's
     * ROLE, and this function is handed tools and extensions, not a name.
     * Omitted ⇒ byte-identical argv to the version before reasoning profiles.
     */
    thinking: readonly string[] = []
): string[] {
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
    //
    // `extensions` are internal `-e` loads for in-run guards (the caller supplies
    // the path). A no-tools child cannot make a tool call, so it never carries
    // one — the guards all hang off pi's `tool_call` hook.
    const toolFlags = tools === '' ? ['--no-tools'] : ['--tools', tools]
    const internal = tools === '' ? [] : extensions
    return [...childBaseArgs(internal), ...thinking, '--mode', 'json', ...toolFlags]
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
/**
 * One child-pi invocation, as a value.
 *
 * WHY A RECORD. This was thirteen ordered positionals, and the thirteenth
 * carried its own DEBT note saying so. Two production callers reached it, and
 * they had already drifted: the degrade attempt wrote three bare `undefined`s to
 * reach the later slots and passed the RAW signal, so it escaped the wall clock
 * its own strike siblings run under — the same defect class this file already
 * recorded for `runAutoInstall` and for the deleted `runPhaseWithLoopGuard`.
 * Adjacent optionals of the same type can no longer swap without a type error.
 */
export interface ChildRun {
    cwd: string
    /** `''` means `--no-tools`. See childArgs. */
    tools: string
    prompt: string
    signal: AbortSignal
    onLine?: (line: string) => void
    onContextUsage?: (snapshot: ContextSnapshot) => void
    onToolCall?: (call: ToolCall) => LoopHit | null
    spawn?: SpawnFn
    /** Internal `-e` extension paths for in-run guards (see childArgs). */
    extensions?: readonly string[]
    /**
     * Every finished tool call's result text. The StallDetector's churn rule
     * needs the size of what actually entered the child's context, which the
     * CALL alone does not carry (task/stall-detector.ts).
     */
    onToolResult?: (text: string, isError: boolean) => void
    /**
     * The child's context window in tokens. Nothing in pi's event stream reports
     * one (issue #16), so the parent hands its own down — children carry no `-m`
     * and resolve the same default model. 0 / omitted = unknown, as before.
     */
    contextWindow?: number
    /**
     * The resolved `['--thinking', level]` fragment for this child's reasoning
     * group, or `[]`/omitted to inherit the session default as before.
     */
    thinking?: readonly string[]
}

export async function runChild({
    cwd,
    tools,
    prompt,
    signal,
    onLine,
    onContextUsage,
    onToolCall,
    spawn: spawnFn,
    extensions,
    onToolResult,
    contextWindow,
    thinking
}: ChildRun): Promise<PhaseRunResult> {
    const invocation = getPiInvocation(childArgs(tools, extensions, thinking), prompt)
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
            ...(contextWindow && contextWindow > 0 ? {contextWindow} : {}),
            onToolResult: onToolResult ? r => onToolResult(r.text, r.isError) : undefined,
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

export interface PhaseDeps {
    cwd: string
    taskId: string
    signal: AbortSignal
    onChildOutput?: (line: string) => void
    onContextUsage?: (snapshot: ContextSnapshot) => void
    /**
     * The parent session's context window in tokens, handed down to every child.
     *
     * pi's `--mode json` stream reports token counts but no window (issue #16),
     * so without this the gauge shows a bare number and — worse — the
     * StallDetector's CONTEXT CHURN rule, which is gated on a positive window,
     * can never fire. Children are spawned without `-m` (CHILD_BASE_ARGS) and so
     * run the parent's own default model; its window is the honest value.
     * Absent = unknown, and both consumers degrade exactly as they did before.
     */
    contextWindow?: number
    /**
     * Record a sub-step duration under the currently running top-level phase.
     * The orchestrator rebinds this between phases so each call lands in the
     * right phase's children array. Phases that don't care can ignore it.
     */
    recordSubStep?: (label: string, ms: number) => void
    spawn?: SpawnFn
    /**
     * Internal `-e` extension paths loaded into this child for IN-RUN guards.
     *
     * The point of a guard that runs inside the child is that it does not have
     * to kill it: pi turns a `tool_call` handler's `{block, reason}` into an
     * error tool result, so the model reads the reason as its own tool output
     * and continues with its context intact. The host's only alternative is to
     * kill and re-spawn from nothing, which just re-runs a model that
     * deterministically re-thrashes (workers/single-read-guard.ts).
     */
    childExtensions?: readonly string[]
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
    /**
     * Run ONE named Child pi and return its assistant text — the seam every phase
     * child goes through. Absent (production) → the real wrappers run, with the
     * loop detector, the wall-clock budget and the Error-triage ladder. Present →
     * the substitute answers directly and NONE of those guards run.
     *
     * The child's NAME is the first parameter because the name is what a caller
     * branches on and what a test wants to assert. It used to be discarded before
     * reaching the only injectable boundary (`spawn`), so a phase test had to
     * reconstruct it by matching prompt PROSE against prompts.ts — which made
     * prompt copy load-bearing test infrastructure in a codebase whose practice is
     * rewording prompts and A/B-ing them.
     *
     * `spawn` stays: the ladder's OWN tests must drive a real process to exercise
     * the rungs. This seam is for callers to whom the child is a premise.
     */
    runChild?: (name: string, tools: string, prompt: string) => Promise<string>

    // ─── Research + auto-answer seams ────────────────────────────────────────
    //
    // These used to be two trailing `= {}` dep bags on `phaseResearch` and
    // `phaseAutoAnswer` (`PhaseResearchDeps`, `PhaseAutoAnswerDeps`). Nothing in
    // production ever passed either — `PhaseConfig.run` takes `(deps, pc)`, so a
    // row physically could not reach a third parameter — which left nine seams
    // that only a direct call could use and ~30 routing decisions in two suites
    // keyed on prompt PROSE. They belong here for exactly the reason `runChild`
    // does: this is the interface a phase's children are a premise behind, and
    // it is already threaded end to end from `TaskRunnerOptions`.
    //
    // Each defaults to the real implementation when absent, so production wiring
    // is untouched.

    /**
     * Run ONE research worker. Absent (production) → the real `runWorker`.
     *
     * Every decision `runSpec` makes — the three Research retry gates, the
     * fatal/runaway/empty classification, the marker choice, `postProcess` — is a
     * pure function of the returned `RunWorkerResult`, but reaching any of them
     * otherwise requires driving a fake process that emits JSON events.
     *
     * `label` is the worker's name — the same one `recordWorker` trails — because
     * a substitute must answer differently per worker, and the only alternative
     * is matching a marker sentence inside the prompt. Same reason `runChild`
     * takes a name.
     */
    runWorker?: (label: string, input: RunWorkerInput) => Promise<RunWorkerResult>
    /** The project file inventory handed to every research worker's header. */
    getFileInventory?: (cwd: string, signal?: AbortSignal) => Promise<string>
    /** RAW docs lookup — the research phase's EXTERNAL CONTEXT variant. */
    docsRaw?: typeof docsRaw
    /** RAW url fetch — the research phase's EXTERNAL CONTEXT variant. */
    fetchRaw?: typeof fetchRaw
    /** Live npm version lookup for the research phase's named deps. */
    npmVersionLookup?: typeof npmVersionLookup
    /** FOCUSED docs lookup — the grill auto-answer's variant. */
    docsFocused?: typeof docsFocused
    /** FOCUSED url fetch — the grill auto-answer's variant. */
    fetchFocused?: typeof fetchFocused
    /**
     * Live web search. ONE field, not two: the research phase and the auto-answer
     * differ in the doc/url worker VARIANT (raw vs focused) and in POLICY, never
     * in how they search — the two dep bags declared it identically.
     */
    searchFn?: (input: SearchCoreInput) => Promise<SearchCoreResult>
}

/**
 * The subset of `PhaseDeps` a CALLER may supply — every injectable seam, derived
 * by naming what the runner owns instead of by listing what it does not.
 *
 * `TaskRunnerOptions` used to declare `spawnFn`, `runChild`, `runWorker` and a
 * seven-name `Pick` called `lookups` separately; `RunSingleTaskOptions` re-picked
 * all four, `runSingleTask` re-forwarded each by name, and the constructor spread
 * them back together. Four coordinated edits, none of which failed to compile if
 * you skipped one — the exact indictment this codebase already recorded against
 * `ConfigItem`. Four seams (`timeoutMs`, `sleepFor`, `childExtensions`,
 * `logDebug`) had in fact been left behind, so a runner-driven test of the
 * connection-error rung really slept and the debug trail could not be asserted at
 * all. Derived by `Omit`, a NEW seam field joins this with no second edit.
 */
export type PhaseSeams = Omit<
    PhaseDeps,
    | 'cwd'
    | 'taskId'
    | 'signal'
    | 'onChildOutput'
    | 'onContextUsage'
    | 'contextWindow'
    | 'recordSubStep'
>

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
 * `attempt` is the caller's 0-based counter, `budget` the matching restart
 * allowance (MAX_LEAK_RETRIES, which is also MAX_LOOP_RESTARTS — the loop and
 * leak budgets were separate constants at the same value and are shared by one
 * loop now) — so a phase runs `budget + 1` attempts before a rung gives up.
 *
 * `verb` names the restart in the debug log ("retry" by default, "restart" for
 * refine and grill-gen). It is the only externally visible thing that differed
 * between the two loops this collapsed, and the only way to tell from a debug
 * log which phase produced a line — so it is passed in rather than hardcoded.
 *
 * A loop kill (`r.loopHit`) is NOT handled here: the caller detects loops and
 * must consume the hit before calling this.
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
        // The exit code is the only signal when stderr is empty, and pi exits
        // silently on several paths (143 = SIGTERM/loop-kill, 137 = SIGKILL/OOM).
        // Dropping it left "(no stderr)" as the whole diagnosis.
        const why = r.stderr || `no stderr, exit ${r.exitCode}`
        throw new Error(`${name} child failed: ${why}`)
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
 * THREE RUNAWAY GUARDS ride the same budget, because this is the runner every
 * /task-auto planning child goes through (clarify, decompose, coverage,
 * contract-extract) and until mx5-n 2026-08-14 it had none:
 *   • a LoopDetector, so an identical repeated tool call is killed and
 *     re-prompted instead of being allowed to fill the context window;
 *   • a StallDetector, the backstop for the varied-args thrash the loop
 *     detector's short window cannot see — the shape that actually cost us a
 *     16-minute decompose child that was never going to return. It bounds
 *     consecutive no-new-ground calls and total context churn, NOT elapsed time;
 *   • PHASE_CHILD_TIMEOUT_MS, a hard wall clock, OFF by default because the
 *     measured healthy range (610-927s for a reasoning-on decompose) overlaps
 *     any value that would catch the pathology. See its comment.
 * All three are checked BEFORE the triage ladder: we killed the child, so its
 * exit status describes our SIGTERM and says nothing about its verdict.
 */
/**
 * The `--thinking` fragment for a named child, or `[]` when the name is unmapped.
 *
 * An unmapped name INHERITS rather than throwing: a child that reaches the model
 * with today's argv is always safe, and aborting a user's task over a missing
 * table row would be a worse failure than the one it reports. The guard that
 * makes the table complete is `reasoning-groups.test.ts`, which fails the BUILD —
 * where someone can actually fix it.
 */
export function thinkingForChild(name: string): string[] {
    const group = reasoningGroupForChild(name)
    return group ? groupThinkingArgs(group) : []
}

/**
 * What a PHASE child's invocation carries, said once.
 *
 * Both callers of `runChild` in this file are phase children — the strike
 * attempts and the no-tools degrade that rescues them — and everything they
 * disagree about is in `over`. Anything not there is the same by construction,
 * which is what the degrade's own comment ("the degrade changes the TOOLS, not
 * the role") claimed while three bare `undefined`s quietly made it false.
 */
function phaseChildRun(
    deps: PhaseDeps,
    over: Pick<ChildRun, 'tools' | 'prompt' | 'signal' | 'thinking'>
        & Partial<Pick<ChildRun, 'onContextUsage' | 'onToolCall' | 'onToolResult'>>
): ChildRun {
    return {
        cwd: deps.cwd,
        onLine: deps.onChildOutput,
        onContextUsage: deps.onContextUsage,
        spawn: deps.spawn,
        extensions: deps.childExtensions,
        contextWindow: deps.contextWindow,
        ...over
    }
}

export async function runPhaseChild(
    deps: PhaseDeps,
    name: string,
    tools: string,
    prompt: string,
    opts: PhaseChildOptions = {}
): Promise<string> {
    if (deps.runChild) return await deps.runChild(name, tools, prompt)
    // Resolved ONCE per call, not per attempt: a /task-config change landing
    // between a loop-kill and its retry would otherwise make the two attempts
    // different experiments, and the retry exists to repeat the first one with a
    // hint. An unmapped name inherits, which is today's argv — the build-time
    // guard for that is reasoning-groups.test.ts, not a throw in a user's run.
    const thinking = thinkingForChild(name)
    const verb = opts.verb ?? 'retry'
    let hint: string | null = null
    const loopHistory: LoopHit[] = []
    const budgetMs = deps.timeoutMs ?? PHASE_CHILD_TIMEOUT_MS
    for (let attempt = 0; attempt <= MAX_LEAK_RETRIES; attempt++) {
        // A cancel between attempts must not buy another spawn.
        if (deps.signal.aborted) throw new Error(USER_CANCELLED)
        const detector = new LoopDetector(LOOP_WINDOW, LOOP_THRESHOLD)
        const stall = new StallDetector()
        // Arm the churn rule BEFORE the first tool call. The window used to reach
        // the detector only through a context snapshot, and pi's stream never
        // carries one, so it was always 0 and rule 2 never fired (issue #16). The
        // parent knows the value at spawn time — say it then, not later.
        stall.noteContext(deps.contextWindow ?? 0)
        const clock = phaseTimeout(deps.signal, budgetMs)
        let r: PhaseRunResult
        try {
            r = await runChild(
                phaseChildRun(deps, {
                    tools,
                    prompt: prependHint(hint, prompt),
                    signal: clock.signal,
                    thinking,
                    onContextUsage: snapshot => {
                        // Real window or nothing: noteContext ignores 0, and until
                        // deps.contextWindow existed 0 was all it ever saw, which
                        // left the churn rule permanently disarmed (issue #16).
                        stall.noteContext(snapshot.contextWindow)
                        deps.onContextUsage?.(snapshot)
                    },
                    onToolCall: call => detector.record(call) ?? stall.record(call),
                    onToolResult: (text, isError) => stall.noteResult(text, isError)
                })
            )
        } finally {
            clock.cleanup()
        }
        // A user cancel must not be mistaken for any of the guards.
        if (deps.signal.aborted) throw new Error(USER_CANCELLED)
        if (r.loopHit) {
            const isLastStrike = attempt === MAX_LEAK_RETRIES
            loopHistory.push(r.loopHit)
            await appendLoopEvent(
                deps.cwd,
                deps.taskId,
                name,
                r.loopHit,
                attempt + 1,
                isLastStrike ?
                    opts.degradeOnExhaustion ?
                        'degraded — no-tools final attempt'
                    :   'phase failed'
                :   'restarted with hint'
            )
            if (isLastStrike) {
                if (opts.degradeOnExhaustion) {
                    return await runDegradedFinalAttempt(deps, name, prompt, r.loopHit, loopHistory)
                }
                throw new LoopExhaustedError(name, loopHistory)
            }
            deps.logDebug?.(
                r.loopHit.stall ?
                    `${name}: stalled (${r.loopHit.stall}) on ${r.loopHit.call.name} — `
                        + `${verb} ${attempt + 1}/${MAX_LEAK_RETRIES}`
                :   `${name}: looped on ${r.loopHit.call.name} — ${verb} ${attempt + 1}/${MAX_LEAK_RETRIES}`
            )
            hint = r.loopHit.stall ? formatStallHint(r.loopHit.stall) : formatLoopHint(r.loopHit)
            continue
        }
        if (clock.timedOut()) {
            if (attempt === MAX_LEAK_RETRIES) {
                throw new PhaseTimeoutError(name, budgetMs, MAX_LEAK_RETRIES + 1)
            }
            deps.logDebug?.(
                `${name}: exceeded its ${Math.round(budgetMs / 1000)}s budget — `
                    + `${verb} ${attempt + 1}/${MAX_LEAK_RETRIES}`
            )
            hint = PHASE_TIMEOUT_HINT
            continue
        }
        const step = await triageChildResult(deps, name, r, attempt, MAX_LEAK_RETRIES, verb)
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

/**
 * Append one line to the task file's `loop events` section.
 *
 * Best-effort by contract: it runs for EVERY phase child now that there is one
 * loop, and the six sites that used to reach the un-trailed wrapper do not all
 * own a task file on disk (a scripted harness, a bare unit deps bag). A trail
 * that cannot be written must cost the phase nothing — the loop kill itself is
 * already reported through the debug log and the thrown LoopExhaustedError.
 */
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
    try {
        const existing = (await readSection(cwd, taskId, 'loop events')) ?? ''
        const next = existing ? `${existing}\n${line}` : line
        await setTaskSection(cwd, taskId, 'loop events', next)
    } catch {
        /* best-effort: a trail is never worth failing a phase for */
    }
}

/**
 * The two things a phase child can disagree about. Everything else — the loop
 * and stall detectors, the wall clock, the loop trail, the triage ladder and its
 * budget — is the one loop's, because the two wrappers that used to differ
 * disagreed on nothing else that was ever observable.
 */
export interface PhaseChildOptions {
    /**
     * The wrapper's own word in the debug log for "we are going round again".
     * An option rather than one word because it is the single externally visible
     * difference between the two loops this collapsed, and the debug trail of a
     * real run is read by a human who knows which phases restart and which retry.
     */
    verb?: 'retry' | 'restart'
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
    prompt: string,
    hit: LoopHit,
    loopHistory: LoopHit[]
): Promise<string> {
    deps.logDebug?.(`${name}: loop budget exhausted — degrading to a no-tools final attempt`)
    // BEHAVIOUR DELTA. This attempt now runs under the same wall clock as the
    // strikes that led here. It used to pass `deps.signal` raw — one of the
    // three drifts that came of reaching past bare `undefined`s to the later
    // positionals — so the one attempt made after a loop budget was spent was
    // also the one attempt that could hang forever.
    const clock = phaseTimeout(deps.signal, deps.timeoutMs ?? PHASE_CHILD_TIMEOUT_MS)
    let r: PhaseRunResult
    try {
        r = await runChild(
            phaseChildRun(deps, {
                tools: '', // --no-tools: the model cannot read/grep/list, only answer
                prompt: prependHint(formatDegradeHint(hit), prompt),
                signal: clock.signal,
                // Same group as the attempts that led here. The degrade changes the
                // TOOLS, not the role — running it at a different thinking level would
                // make the fallback a different experiment from the thing it rescues.
                thinking: thinkingForChild(name)
            })
        )
    } finally {
        clock.cleanup()
    }
    if (r.exitCode !== 0 || r.modelError || r.text.trim().length === 0) {
        // A wall-clock kill is NOT a loop. The clock above is new here, and
        // without this check a degrade that outran its budget was reported as
        // "loop budget exhausted", carrying a loop history that did not cause it
        // — the same mislabel class the worker-kill roster exists to prevent, on
        // the very path that clock was added to guard.
        if (clock.timedOut()) {
            throw new PhaseTimeoutError(name, deps.timeoutMs ?? PHASE_CHILD_TIMEOUT_MS, 1)
        }
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
        public override readonly cause: string
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
