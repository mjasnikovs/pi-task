/**
 * The phase children's adapter over the one attempt loop.
 *
 * `runWorker` (workers/pi-worker-core.ts) owns every guard a model child runs
 * under and every restart it may be granted; the `phase` row of WORKER_PROFILES
 * says which. What is left here is what a PHASE child is that a research worker
 * is not: it is named, its name picks its group, its failure is THROWN as a
 * typed error the pipeline switches on, and its loop kills leave a trail in the
 * task file. Nothing here re-decides how a child may die.
 */

import {
    runWorker,
    type RunWorkerInput,
    type RunWorkerResult,
    type WorkerRestart
} from '../workers/pi-worker-core.js'
import {classifyWorkerFailure, type WorkerFailure} from '../workers/worker-failure.js'
import {isFatalKill} from '../workers/worker-kill.js'
import {MAX_LOOP_RESTARTS} from './loop-detector.js'
import {MAX_LEAK_RETRIES} from '../shared/leaked-tool-call.js'
import {readSection, setTaskSection} from './task-io.js'
import {streamStallCause} from '../shared/stream-watchdog.js'
import {getConfig} from '../config/config.js'
import {groupChildArgs, groupWindow} from '../config/group-args.js'
import {groupForChild, type ChildGroup} from '../config/groups.js'
import type {SpawnFn, ContextSnapshot, LoopHit} from '../shared/child-process.js'
import type {DebugLine} from './debug-log.js'
// Type-only: `PhaseDeps` declares the research/auto-answer seams, and a seam is
// declared by the shape of the thing it stands in for.
import type {docsRaw, docsFocused} from '../workers/docs-core.js'
import type {fetchRaw, fetchFocused} from '../workers/fetch-core.js'
import type {npmVersionLookup} from '../workers/npm-version.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'

// Sentinel error thrown when the user dismisses a grill-me dialog or cancels a
// run. Defined here (not in failure-classifier.ts) to avoid a circular dependency.
export const USER_CANCELLED = '__user_cancelled__'

// ─── The phase failure vocabulary ────────────────────────────────────────────

/**
 * Why a phase child did not answer.
 *
 * The worker roster's kills, plus the two outcomes `worker-failure.ts`
 * deliberately leaves to the consumer: a reported model error, and an empty
 * answer. For a phase child both ARE failures, so they join the union here.
 * `loop` carries how many strikes it took, which is what the notice reports.
 */
export type ChildFailure =
    | Exclude<WorkerFailure, {kind: 'loop'}>
    | {kind: 'loop'; hit: LoopHit; strikes: number}
    | {kind: 'model-error'; cause: string}
    | {kind: 'empty-answer'}

/**
 * ONE error class for every way a phase child fails, carrying the cause as data.
 *
 * Six classes plus a string sentinel used to say the same nine things, and
 * `classifyFailure` rebuilt the ladder by `instanceof` and then fell through
 * to sniffing the message — the tell that the vocabulary was leaking. A catch
 * site asks `isFatalChildCause`; the notice switches on `failure.kind`.
 */
export class ChildFailureError extends Error {
    constructor(
        readonly phase: string,
        readonly failure: ChildFailure,
        readonly stderr = ''
    ) {
        super(describeChildFailure(phase, failure, stderr))
        this.name = 'ChildFailureError'
    }
}

function describeChildFailure(phase: string, f: ChildFailure, stderr: string): string {
    switch (f.kind) {
        case 'stalled':
            return (
                `${phase} child killed: no output for the stall window and the model `
                + `endpoint did not answer a probe`
            )
        case 'command-timeout':
            return (
                `${phase} child ran \`${f.toolName}\``
                + `${f.detail ? ` (${f.detail})` : ''} past its `
                + `${Math.round(f.timeoutMs / 1000)}s ceiling on every attempt`
            )
        case 'stream-stall':
            return `${phase} child: model error — ${streamStallCause(f.idleMs)}`
        case 'worker-timeout':
            return (
                `${phase} child ran out of time on every attempt — it never stopped `
                + `working long enough to answer`
            )
        case 'loop':
            return `loop detected ${f.strikes} times in ${phase}`
        case 'leaked-tool-call':
            return (
                `${phase} child wrote a tool call as text instead of invoking it `
                + `(${f.text.trim()}) — it never ran`
            )
        case 'aborted':
            return `${phase} child aborted`
        case 'exit':
            // The exit code is the only signal when stderr is empty, and pi exits
            // silently on several paths (143 = SIGTERM, 137 = SIGKILL/OOM).
            return `${phase} child failed: ${stderr || `no stderr, exit ${f.code}`}`
        case 'model-error':
            return `${phase} child: model error — ${f.cause}`
        case 'empty-answer':
            return `${phase} child produced no output${stderr ? ' — stderr: ' + stderr : ''}`
    }
}

/**
 * Causes a best-effort `catch` must NOT absorb.
 *
 * A phase child that merely answered badly should degrade — that is what those
 * catches are for. A dead backend and a user cancel are different in kind: the
 * run is over either way, and swallowing them ships a half-built spec while
 * every later phase dies against the same dead server, or turns an ESC into
 * silent progress. Which kills are fatal is the roster's column, not a list here.
 */
export function isFatalChildCause(e: unknown): boolean {
    if (e instanceof ChildFailureError) return isFatalKill(e.failure.kind)
    return e instanceof Error && e.message === USER_CANCELLED
}

// ─── Phase deps ──────────────────────────────────────────────────────────────

export interface PhaseDeps {
    cwd: string
    taskId: string
    signal: AbortSignal
    onChildOutput?: (line: string) => void
    onContextUsage?: (snapshot: ContextSnapshot) => void
    /**
     * The parent session's context window in tokens, handed down to every child
     * whose group resolved no window of its own.
     *
     * pi's `--mode json` stream reports token counts but no window, so without
     * this the gauge shows a bare number and — worse — the StallDetector's CONTEXT
     * CHURN rule can never fire: it opens with `if (this.contextWindow <= 0)
     * return false`. Absent = unknown, and both consumers degrade.
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
     * Wall-clock budget for ONE spawn of this child, in ms — the `phase`
     * profile's `worker-timeout` row. Nothing sets it in production; the row
     * says why. Tests inject a short budget.
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
     * child goes through. Absent (production) → the real loop runs, with every
     * guard the `phase` profile names. Present → the substitute answers directly
     * and NONE of those guards run.
     *
     * The child's NAME is the first parameter because the name is what a caller
     * branches on and what a test wants to assert. Discarded before it reaches
     * the only injectable boundary (`spawn`), a phase test has to reconstruct it
     * by matching prompt PROSE against prompts.ts — which makes prompt copy
     * load-bearing test infrastructure in a codebase that rewords prompts.
     *
     * `spawn` stays: the loop's OWN tests drive a real process to exercise the
     * rungs. This seam is for callers to whom the child is a premise.
     */
    runChild?: (name: string, tools: string, prompt: string) => Promise<string>

    // ─── Research + auto-answer seams ────────────────────────────────────────
    //
    // These belong here rather than in trailing `= {}` dep bags on
    // `phaseResearch` and `phaseAutoAnswer`. `PhaseConfig.run` takes
    // `(deps, pc)`, so a row physically cannot reach a third parameter — a seam
    // parked there is reachable only by a direct call, and tests fall back to
    // routing on prompt PROSE. Same reason `runChild` is here: this is the
    // interface a phase's children are a premise behind, and
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
 * Declaring the seams separately on `TaskRunnerOptions`, re-picking them on
 * `RunSingleTaskOptions`, re-forwarding each by name and spreading them back
 * together is four coordinated edits, none of which fails to compile if you skip
 * one. Seams get left behind that way, and a runner-driven test of the
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

/**
 * The two things a phase child can disagree about. Everything else — the
 * guards, the budgets, the loop trail — is the one loop's and the `phase` row's.
 */
export interface PhaseChildOptions {
    /**
     * The wrapper's own word in the debug log for "we are going round again".
     * The debug trail of a real run is read by a human who knows which phases
     * restart and which retry.
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

// ─── The adapter ─────────────────────────────────────────────────────────────

/**
 * The group fragment for a named child, or `[]` when the name is unmapped.
 *
 * An unmapped name INHERITS rather than throwing: a child that reaches the model
 * with today's argv is always safe, and aborting a user's task over a missing
 * table row would be a worse failure than the one it reports. The guard that
 * makes the table complete is `config/groups.test.ts`, which fails the BUILD —
 * where someone can actually fix it.
 */
export function groupArgsForChild(name: string): string[] {
    const group = groupForChild(name)
    return group ? groupChildArgs(group) : []
}

/**
 * The context window a child of this group runs against.
 *
 * The GROUP's window when this session resolved one, else the run's. Too small a
 * window makes the churn rule fire early and kill a healthy child, so an
 * `inherit` or unresolved group keeps the parent's number rather than a guess.
 */
function childContextWindow(deps: PhaseDeps, group: ChildGroup | undefined): number | undefined {
    return (group === undefined ? undefined : groupWindow(group)) ?? deps.contextWindow
}

export async function runPhaseChild(
    deps: PhaseDeps,
    name: string,
    tools: string,
    prompt: string,
    opts: PhaseChildOptions = {}
): Promise<string> {
    if (deps.runChild) return await deps.runChild(name, tools, prompt)
    if (deps.signal.aborted) throw new Error(USER_CANCELLED)
    const verb = opts.verb ?? 'retry'
    const cfg = getConfig()
    // Leak retries draw on their own budget, so `r.attempt` (one counter across
    // every reason) would print 3/2 on a leak after two loop kills.
    const spent = {leak: 0, shared: 0}
    const result = await runWorker({
        prompt,
        cwd: deps.cwd,
        signal: deps.signal,
        spawn: deps.spawn,
        tools,
        extensions: deps.childExtensions,
        onLine: deps.onChildOutput,
        onContextUsage: deps.onContextUsage,
        contextWindow: childContextWindow(deps, groupForChild(name)) ?? 'unknown',
        profile: 'phase',
        policyInputs: {
            commandTimeoutMs: cfg.requestTimeoutMs,
            streamInactivityMs: cfg.streamInactivityMs,
            timeoutMs: deps.timeoutMs
        },
        sleepFor: deps.sleepFor,
        // Resolved ONCE per call, not per attempt: a /task-config change landing
        // between a loop-kill and its retry would otherwise make the two attempts
        // different experiments, and the retry exists to repeat the first one.
        groupArgs: groupArgsForChild(name),
        // The degrade changes the TOOLS, not the role: it runs on the same model
        // at the same level as the attempts it rescues, or it is a different
        // experiment from the thing it stands in for.
        rescue: opts.degradeOnExhaustion ? {tools: '', hint: formatDegradeHint} : undefined,
        onRestart: r => {
            deps.logDebug?.(
                r.rescue ?
                    `${name}: loop budget exhausted — degrading to a no-tools final attempt`
                :   `${name}: ${describeRestart(r)} — ${verb} ${describeBudget(r, spent)}`
            )
        }
    })
    await appendLoopEvents(deps.cwd, deps.taskId, name, result)
    // A user cancel must not be mistaken for any of the guards.
    if (deps.signal.aborted) throw new Error(USER_CANCELLED)
    const failure = phaseFailure(result)
    if (failure) throw new ChildFailureError(name, failure, result.stderr)
    return result.text
}

/** `n/budget` for the budget this restart spent, counted by the caller. */
function describeBudget(r: WorkerRestart, spent: {leak: number; shared: number}): string {
    if (r.reason === 'leaked-tool-call') return `${++spent.leak}/${MAX_LEAK_RETRIES}`
    return `${++spent.shared}/${MAX_LOOP_RESTARTS}`
}

/** The debug-log line for one discarded attempt. */
function describeRestart(r: WorkerRestart): string {
    switch (r.reason) {
        case 'loop':
            return r.loopHit?.stall ?
                    `stalled (${r.loopHit.stall}) on ${r.loopHit.call.name}`
                :   `looped on ${r.loopHit?.call.name ?? r.detail}`
        case 'command-timeout':
            return `${r.detail} outran its ceiling`
        case 'stream-stall':
            return `model stream inactivity (${r.detail})`
        case 'stalled':
            return r.detail ?? 'stalled'
        case 'worker-timeout':
            return `exceeded its budget (${r.detail})`
        case 'connection-error':
            return `connection error "${r.detail}"`
        case 'leaked-tool-call':
            return 'wrote a tool call as text'
        case 'empty-answer':
            return 'empty completion'
    }
}

/**
 * What the pipeline is told about a finished phase child, or `undefined` for an
 * answer.
 *
 * The roster's kills come first, through the one ladder every consumer uses.
 * Then the two consumer-policy outcomes: a rescue that produced nothing is
 * reported as the loop it stood in for — a wall-clock or watchdog kill on the
 * rescue is still that kill, but "the no-tools attempt said nothing" is not a
 * new fact about the child, it is the loop budget being spent.
 */
function phaseFailure(r: RunWorkerResult): ChildFailure | undefined {
    // Strikes the BUDGET saw. The rescue is outside it: a no-tools child cannot
    // loop, and one that somehow did is still the budget's exhaustion, not a
    // fourth strike.
    const loopStrikes =
        r.restarts.filter(x => x.reason === 'loop').length + (r.loopHit && !r.rescued ? 1 : 0)
    const kill = classifyWorkerFailure(r)
    if (kill) return kill.kind === 'loop' ? {...kill, strikes: loopStrikes} : kill
    const answered = r.modelError === undefined && r.text.trim().length > 0
    if (answered) return undefined
    if (r.rescued) {
        const hit = r.restarts.findLast(x => x.loopHit !== undefined)?.loopHit
        if (hit) return {kind: 'loop', hit, strikes: loopStrikes}
    }
    if (r.modelError !== undefined) return {kind: 'model-error', cause: r.modelError}
    return {kind: 'empty-answer'}
}

/**
 * Terminal hint for the degrade attempt: the model has thrashed through the whole
 * strike budget re-reading files without converging, so we strip its tools and
 * order it to emit the deliverable NOW from what it already has.
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
 * Append one line per loop kill to the task file's `loop events` section.
 *
 * Best-effort by contract: it runs for EVERY phase child, and not every caller
 * owns a task file on disk (a scripted harness, a bare unit deps bag). A trail
 * that cannot be written must cost the phase nothing — the loop kill itself is
 * already reported through the debug log and the thrown error.
 */
async function appendLoopEvents(
    cwd: string,
    taskId: string,
    phase: string,
    r: RunWorkerResult
): Promise<void> {
    const line = (hit: LoopHit, strike: number, outcome: string): string =>
        `- ${new Date().toISOString()}  ${phase}  strike ${strike}/${MAX_LOOP_RESTARTS + 1}  `
        + `${hit.call.name}(${JSON.stringify(hit.call.args)}) ×${hit.count} in last `
        + `${hit.windowSize} calls  → ${outcome}`
    const lines = r.restarts.flatMap(x =>
        x.loopHit ?
            [
                line(
                    x.loopHit,
                    x.attempt,
                    x.rescue ? 'degraded — no-tools final attempt' : 'restarted with hint'
                )
            ]
        :   []
    )
    if (r.loopHit) lines.push(line(r.loopHit, r.attempts, 'phase failed'))
    if (lines.length === 0) return
    try {
        const existing = (await readSection(cwd, taskId, 'loop events')) ?? ''
        await setTaskSection(
            cwd,
            taskId,
            'loop events',
            [existing, ...lines].filter(Boolean).join('\n')
        )
    } catch {
        /* best-effort: a trail is never worth failing a phase for */
    }
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
