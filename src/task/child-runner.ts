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
    type LoopHit,
    CHILD_BASE_ARGS
} from '../shared/child-process.js'
import {LoopDetector} from './loop-detector.js'
import {
    detectLeakedToolCall,
    leakedToolCallHint,
    MAX_LEAK_RETRIES
} from '../shared/leaked-tool-call.js'
import {readSection, setTaskSection} from './task-io.js'

// ─── Loop detection constants ────────────────────────────────────────────────
// Defined here (not in phases.ts) to avoid a circular dependency:
//   phases.ts → child-runner.ts → phases.ts

export const LOOP_WINDOW = 20
export const LOOP_THRESHOLD = 5
export const MAX_LOOP_RESTARTS = 2 // 3 strikes total (initial attempt + 2 restarts)
// MAX_LEAK_RETRIES lives in shared/leaked-tool-call.ts (imported above).

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

export function childArgs(tools: string, prompt: string): string[] {
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
    const toolFlags = tools === '' ? ['--no-tools'] : ['--tools', tools]
    return [...CHILD_BASE_ARGS, '--mode', 'json', ...toolFlags, prompt]
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
    const invocation = getPiInvocation(childArgs(tools, prompt))
    let loopHit: LoopHit | undefined

    const result = await runChildUnified(
        spawnFn ?? (spawn as unknown as SpawnFn),
        invocation,
        cwd,
        signal,
        {
            mode: 'json-events',
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
    return {
        text,
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
        loopHit,
        modelError: result.modelError,
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
    /** Write a timestamped line to the per-task debug log. Fire-and-forget. */
    logDebug?: (msg: string) => void
}

export type {PhaseDeps}

/**
 * Run a child pi and return its assistant text. Throws if exit code != 0.
 *
 * If the child leaks a tool call as plain text (wrong dialect — never executed),
 * re-prompt with a correction hint up to MAX_LEAK_RETRIES times; if it keeps
 * leaking, throw LeakedToolCallError rather than returning the unexecuted call.
 */
export async function runPhaseChild(
    deps: PhaseDeps,
    name: string,
    tools: string,
    prompt: string
): Promise<string> {
    let hint: string | null = null
    for (let attempt = 0; attempt <= MAX_LEAK_RETRIES; attempt++) {
        const r = await runChild(
            deps.cwd,
            tools,
            prependHint(hint, prompt),
            deps.signal,
            deps.onChildOutput,
            deps.onContextUsage,
            undefined,
            deps.spawn
        )
        if (r.exitCode !== 0) {
            throw new Error(`${name} child failed: ${r.stderr || '(no stderr)'}`)
        }
        if (r.modelError) {
            // The model/provider failed (pi exited 0 with an stopReason "error"
            // turn). Surface the real cause and fail fast — pi already retried.
            throw new ModelError(name, r.modelError)
        }
        if (r.text.trim().length === 0) {
            // An empty completion (exit 0, no assistant text, no stderr) is almost
            // always transient — a model/API error swallowed inside --mode json,
            // not a repeatable mistake — so re-spawn rather than fail the phase.
            // There's nothing to correct, so we carry no hint. Reuses the leak
            // retry budget: MAX_LEAK_RETRIES+1 attempts, then surface the error.
            if (attempt === MAX_LEAK_RETRIES) {
                throw new Error(
                    `${name} child produced no output${r.stderr ? ' — stderr: ' + r.stderr : ''}`
                )
            }
            continue
        }
        if (r.leakedToolCall) {
            if (attempt === MAX_LEAK_RETRIES) {
                throw new LeakedToolCallError(name, r.leakedToolCall)
            }
            hint = leakedToolCallHint(r.leakedToolCall)
            continue
        }
        return r.text
    }
    // Unreachable: the loop returns clean text or throws on the final leak.
    throw new LeakedToolCallError(name, '(unknown)')
}

function formatLoopHint(hit: LoopHit): string {
    const argsStr = JSON.stringify(hit.call.args)
    return (
        `[SYSTEM NOTE: Your prior attempt called ${hit.call.name}(${argsStr}) `
        + `${hit.count} times in the last ${hit.windowSize} tool calls — you appeared to be `
        + `stuck in a loop. Avoid repeating that exact call; if you've already seen its result, `
        + `work from memory or pick a different angle.]`
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
    outcome: 'restarted with hint' | 'phase failed'
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
export async function runPhaseWithLoopGuard(
    deps: PhaseDeps,
    name: string,
    tools: string,
    buildPrompt: (loopHint: string | null) => string
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
            await appendLoopEvent(
                deps.cwd,
                deps.taskId,
                name,
                r.loopHit,
                strike + 1,
                isLastStrike ? 'phase failed' : 'restarted with hint'
            )
            if (isLastStrike) throw new LoopExhaustedError(name, loopHistory)
            nextHint = formatLoopHint(r.loopHit)
            continue
        }
        if (r.exitCode !== 0) {
            throw new Error(`${name} child failed: ${r.stderr || '(no stderr)'}`)
        }
        if (r.modelError) {
            // The model/provider failed (pi exited 0 with a stopReason "error"
            // turn). Surface the real cause and fail fast — pi already retried.
            throw new ModelError(name, r.modelError)
        }
        if (r.text.trim().length === 0) {
            // An empty completion (exit 0, no assistant text, no stderr) is almost
            // always transient — a model/API error swallowed inside --mode json,
            // not a repeatable mistake — so re-spawn rather than fail the phase.
            // Nothing to correct, so leave nextHint as-is. Reuses the strike
            // budget shared with loop/leak restarts: MAX_LOOP_RESTARTS+1 attempts.
            if (strike === MAX_LOOP_RESTARTS) {
                throw new Error(
                    `${name} child produced no output${r.stderr ? ' — stderr: ' + r.stderr : ''}`
                )
            }
            continue
        }
        if (r.leakedToolCall) {
            if (strike === MAX_LOOP_RESTARTS) {
                throw new LeakedToolCallError(name, r.leakedToolCall)
            }
            nextHint = leakedToolCallHint(r.leakedToolCall)
            continue
        }
        return r.text
    }
    throw new LoopExhaustedError(name, loopHistory)
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
