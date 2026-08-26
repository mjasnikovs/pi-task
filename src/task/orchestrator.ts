/**
 * pi-task — deterministic spec orchestrator for local models.
 *
 * Drives the prompt through five phases — refine → research → grill → compose →
 * critique — then hands the final spec to the main pi thread via
 * pi.sendUserMessage so the user can keep working in the main conversation.
 *
 * Slash commands:
 *   /task <prompt>         start a new task
 *   /task-list             open the task list in an editor dialog
 *   /task-resume [id]      resume the most recent (or named) non-completed task
 *   /task-cancel           cancel the running task (soft-terminal — still resumable)
 *
 * The orchestrator persists after every phase boundary to
 * <cwd>/.pi-tasks/TASK_NNNN.md. All user interaction during phases runs through
 * ctx.ui dialogs; the main pi chat only receives the final spec.
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {
    PHASES,
    postCommitPhase,
    replayPhaseCarry,
    runPhaseRow,
    type PhaseContext
} from './phases.js'
import {handleFailure} from './failure-classifier.js'
import {
    PHASE_INDEX,
    PHASE_ORDER,
    RESUMABLE_STATES,
    type TaskFrontMatter,
    type PhaseName
} from './task-types.js'
import {normaliseTaskId, parseFrontMatter, extractSection} from './task-parsers.js'
import {readTextFile} from '../shared/fs-text.js'
import {
    allocateTaskId,
    ensureTasksDir,
    readSection,
    readTaskFile,
    setTaskSection,
    taskFilePath,
    tasksDir,
    updateTaskFrontMatter,
    writeTaskFile
} from './task-io.js'
import {startWidget, type WidgetState} from './widget.js'
import {armImplWidget, disarmImplWidget, setupImplWidget} from './impl-widget.js'
import {publishViewer, publishNotify, registerBridgeCommand, getBridge} from '../remote/bridge.js'
import {pushNotify} from '../remote/push.js'
import {getConfig} from '../config/config.js'
import {gateDebugWriter} from './debug-log.js'
import {buildGateDeps, type RunTaskFn} from './gate-deps.js'
import {runGatesForTask, type GateDeps} from './task-gates.js'
import {parseVerifyBlock} from './spec-validation.js'
import {findDeliveryPhantoms, formatApiOverrideBanner} from '../workers/phantom-imports.js'
import {titleForDisplay} from './parsers.js'
import {USER_CANCELLED, type PhaseDeps} from './child-runner.js'
import {cancelCheckpoint} from './cancel-points.js'
import {holdImplementationThinking, type ThinkingControl} from './implementation-thinking.js'
import {rearmCancelListener} from './cancel-input.js'
import {takeHeldInput} from './mid-run-input.js'
import {withRun, announceTerminal} from './run-bracket.js'
import {RUN_END_POLICY, runSucceeded, type RunEnd} from './run-end.js'
import {formatTimings, type TimingEntry} from './timings.js'
import {getParentContextWindow, resolveContextUsage} from './context-usage.js'
import type {SpawnFn} from '../shared/child-process.js'
import {
    superviseImplementation,
    type SteerCtx,
    type SuperviseOptions
} from './implementation-turn.js'
import {TERMINAL_OUTCOMES, formatAt, formatWhy} from './terminal-outcome.js'

// ─── Module-level state ──────────────────────────────────────────────────────

let activeTask: TaskRunner | null = null

/** Set the module-level active task (avoids `this` aliasing in TaskRunner.run). */
function setActiveTask(runner: TaskRunner): void {
    activeTask = runner
}

function clearActiveTask(runner: TaskRunner): void {
    if (activeTask === runner) {
        activeTask = null
    }
}

// Captured from the factory so command handlers can call pi.sendUserMessage.
let piApi: ExtensionAPI | null = null

/**
 * The live session's thinking level, as a {@link ThinkingControl}.
 *
 * Goes through `piApi` rather than the command ctx because
 * `ExtensionCommandContext` exposes `thinkingLevel` READ-ONLY; the setter lives
 * on the extension API. Before `registerTask(pi)` has run there is nothing to
 * control, so this degrades to a no-op pair rather than throwing — a task that
 * cannot move the level should still run.
 */
function piThinkingControl(): ThinkingControl {
    const api = piApi
    if (!api) return {get: () => 'off', set: () => {}}
    return {get: () => api.getThinkingLevel(), set: level => api.setThinkingLevel(level)}
}

// ─── TaskRunner options ──────────────────────────────────────────────────────

/**
 * Everything one TaskRunner needs, as one object. The runner is the shared core
 * under `runSingleTask` (and so under /task-auto's per-task loop), so this is the
 * shape both of those construct; `RunSingleTaskOptions` extends the injectable
 * subset and adds what only the wrapper reads.
 */
export interface TaskRunnerOptions {
    ctx: ExtensionCommandContext
    cwd: string
    rawPrompt: string
    /** Resume an existing task by ID instead of starting a new one. */
    resumeId?: string
    /** Deliver the finished spec to the main session. Absent → nothing is sent. */
    sendSpec?: (spec: string) => Promise<void>
    /** Test seam: spawn function forwarded into `PhaseDeps.spawn`. Keep for tests
     *  that drive the Error-triage ladder or a real process. */
    spawnFn?: SpawnFn
    /**
     * Test seam: `PhaseDeps.runChild(name, tools, prompt)`. Present → every phase
     * child is answered by name, with none of the ladder's guards. Use this when
     * the child is a premise of the test, not its subject.
     */
    runChild?: PhaseDeps['runChild']
    /**
     * Test seam: `PhaseDeps.runWorker(label, input)`. Present → every research
     * worker is answered BY NAME, so the three Research retry gates and the
     * fatal/runaway/empty classification are reachable from a runner-driven test
     * without matching a marker sentence inside the prompt.
     */
    runWorker?: PhaseDeps['runWorker']
    /** Test seam: the four EXTERNAL CONTEXT lookups plus the file inventory. Each
     *  defaults to the real implementation when absent. */
    lookups?: Pick<
        PhaseDeps,
        | 'getFileInventory'
        | 'docsRaw'
        | 'fetchRaw'
        | 'npmVersionLookup'
        | 'docsFocused'
        | 'fetchFocused'
        | 'searchFn'
    >
    /** Called with the resolved task id once its file exists, before any phase
     *  work. Lets callers record the id (e.g. stamp the /task-auto entry) so an
     *  interrupted run can be resumed instead of restarted. */
    onStart?: (taskId: string) => void | Promise<void>
    /**
     * Scope fence naming the sibling steps of a /task-auto plan. Forwarded into
     * the refine phase so a single decomposed step bounds its slice instead of
     * re-expanding the whole referenced spec doc. Set only by /task-auto's loop;
     * a bare /task leaves it undefined and the refine prompt is unchanged.
     */
    planContext?: string
    /**
     * Marks this run as a verify-FAIL re-attempt. When set (only by /task-auto's
     * autofix path, with `resumeId` pointing at the already-composed task), the
     * text — the verify gate's failure reason plus any guidance the user typed —
     * is prepended to the delivered spec as a RE-ATTEMPT banner, so the
     * implementer fixes the specific failure and re-satisfies the VERIFY block
     * rather than blindly redoing the task. Empty/undefined on a first attempt.
     */
    fixInstruction?: string
    /** True when the caller awaits the implementation turn (waitForImplementation):
     *  the impl widget stays armed across the whole impl phase (incl. compaction /
     *  steer turns) and is disarmed here. False for fire-and-forget /task, where the
     *  widget is armed one-shot and its own agent_end disarms it. */
    implAwaited?: boolean
}

// ─── TaskRunner class ────────────────────────────────────────────────────────

/** Encapsulates the full lifecycle of a single pi-task run. */
export class TaskRunner {
    private readonly _ctx: ExtensionCommandContext
    private readonly _cwd: string
    private readonly _rawPrompt: string
    private readonly _resumeId: string | undefined
    private readonly _sendSpec: ((spec: string) => Promise<void>) | undefined
    private readonly _onStart: ((taskId: string) => void | Promise<void>) | undefined
    private readonly _planContext: string | undefined
    private readonly _fixInstruction: string | undefined
    /** See {@link TaskRunnerOptions.implAwaited}. */
    private readonly _implAwaited: boolean

    private readonly _abort = new AbortController()
    private readonly _startedAt: number
    private readonly _widgetState: WidgetState
    private _stopWidget: (() => void) | null = null
    private readonly _deps: PhaseDeps
    private readonly _pc: PhaseContext
    /**
     * Per-phase wall-clock durations collected during the run. Written to the
     * `## phase timings` section on successful completion so we can spot
     * regressions and target future speed work. Each top-level entry is a
     * phase (refine/research/grill/compose/critique); children are optional
     * sub-step splits the phase chose to record via deps.recordSubStep.
     */
    private readonly _timings: TimingEntry[] = []
    private _currentPhaseChildren: TimingEntry[] | null = null

    constructor(opts: TaskRunnerOptions) {
        const {ctx, cwd, rawPrompt} = opts
        this._ctx = ctx
        this._cwd = cwd
        this._rawPrompt = rawPrompt
        this._resumeId = opts.resumeId
        this._sendSpec = opts.sendSpec
        this._onStart = opts.onStart
        this._planContext = opts.planContext
        this._fixInstruction = opts.fixInstruction
        this._implAwaited = opts.implAwaited ?? false
        this._startedAt = Date.now()

        // We'll populate id/title/phase lazily in run().
        // Placeholder — real values set in run().
        this._widgetState = {
            taskId: '',
            title: '',
            phase: 'refine',
            startedAt: this._startedAt
        }

        const parentContextWindow = getParentContextWindow(ctx)

        this._deps = {
            cwd,
            taskId: '',
            signal: this._abort.signal,
            spawn: opts.spawnFn,
            runChild: opts.runChild,
            runWorker: opts.runWorker,
            ...opts.lookups,
            // Deliberately NOT a ChildStatus (child-status.ts): the phase widget's
            // state is the whole-run WidgetState — task id, phase, label — shared by
            // reference with PhaseContext and written by the phases themselves
            // (grill sets `lastLine`, compose sets the title). Only these two
            // callbacks overlap, and they call the same resolveContextUsage.
            onChildOutput: (line: string) => {
                this._widgetState.lastLine = line
            },
            // Handed DOWN so the child's own snapshot carries a window and the
            // StallDetector's churn rule can arm; resolveContextUsage below stays
            // as the fallback for a child that still reports none (issue #16).
            contextWindow: parentContextWindow,
            onContextUsage: snapshot => {
                this._widgetState.contextUsage = resolveContextUsage(
                    snapshot,
                    this._widgetState.contextUsage,
                    parentContextWindow
                )
            },
            recordSubStep: (label: string, ms: number) => {
                if (this._currentPhaseChildren) {
                    this._currentPhaseChildren.push({label, ms, children: []})
                }
            }
        }

        this._pc = {
            cwd,
            id: '',
            ctx,
            widgetState: this._widgetState,
            rawPrompt,
            refined: '',
            research: '',
            qa: '',
            spec: '',
            planContext: this._planContext
        }
    }

    get taskId(): string {
        return this._widgetState.taskId
    }

    get signal(): AbortSignal {
        return this._abort.signal
    }

    /** Return the current widget state, or null if not started. */
    status(): WidgetState | null {
        return this._widgetState.taskId ? this._widgetState : null
    }

    /** Cancel the running task by aborting the signal. */
    cancel(): void {
        this._abort.abort()
    }

    /** Execute the full task lifecycle. Mid-run input holds instead of starting
     *  a competing turn for the whole of it, and the terminal interception is
     *  armed for the same window (`withRun`); nested inside `runGatedTask` or
     *  the `/task-auto` loop the bracket refcounts, so this changes nothing there
     *  and covers the fire-and-forget `runSingleTask` path on its own. */
    /**
     * Run the task and NAME how it ended.
     *
     * This returned `void`, so the caller re-read the task file to learn what had
     * just happened here — see run-end.ts for the report that got wrong.
     */
    async run(): Promise<RunEnd> {
        return withRun(this._ctx, {}, () => this._run())
    }

    private async _run(): Promise<RunEnd> {
        const cwd = this._cwd
        const ctx = this._ctx

        // Initialise or resume the TASK file.
        let id: string
        let title: string
        let label: string | undefined
        let resumePhase: PhaseName = 'refine'
        if (this._resumeId) {
            id = this._resumeId
            const {frontMatter} = await readTaskFile(cwd, id)
            title = frontMatter.title
            label = frontMatter.label
            resumePhase = frontMatter.phase
            await updateTaskFrontMatter(cwd, id, {state: 'in_progress'})
        } else {
            id = await allocateTaskId(cwd)
            title = '(refining…)'
            const now = new Date().toISOString()
            const fm: TaskFrontMatter = {
                id,
                state: 'in_progress',
                phase: 'refine',
                created_at: now,
                updated_at: now,
                title
            }
            await writeTaskFile(
                cwd,
                fm,
                `\n## raw prompt\n\n${this._rawPrompt.trim() || '(none)'}\n`
            )
        }

        // Surface the resolved id now that the task file exists, so callers (e.g.
        // the /task-auto loop) can link this run to their own bookkeeping before
        // any phase work — and recover it if the session dies mid-pipeline.
        if (this._onStart) await this._onStart(id)

        // Wire up per-task debug log (<cwd>/.pi-tasks/TASK_XXXX-debug.log).
        const debugLogPath = path.join(tasksDir(cwd), `${id}-debug.log`)
        // Left UNSET at level `off`, so the ~39 `logDebug?.(…)` sites downstream
        // short-circuit before they format a string and the file is never created.
        this._deps.logDebug = gateDebugWriter((msg: string) => {
            const line = `${new Date().toISOString()} ${msg}\n`
            fsp.appendFile(debugLogPath, line).catch(() => {
                /* ignore */
            })
        })
        this._deps.logDebug?.(`run: start phase=${resumePhase}`)

        // Register as active.
        this._widgetState.taskId = id
        this._widgetState.title = title
        this._widgetState.label = label
        this._widgetState.phase = resumePhase
        this._widgetState.startedAt = this._startedAt
        this._deps.taskId = id
        this._pc.id = id
        setActiveTask(this)
        this._stopWidget = startWidget(ctx, () => this.status())

        const advance = async (phase: PhaseName) => {
            this._widgetState.phase = phase
            this._widgetState.lastLine = undefined
            this._widgetState.contextUsage = undefined
            await updateTaskFrontMatter(cwd, id, {phase})
        }

        try {
            const resumeIdx = PHASE_INDEX[resumePhase]

            if (resumeIdx === 0) {
                const {body} = await readTaskFile(cwd, id)
                const onDisk = extractSection(body, 'raw prompt')
                if (onDisk) this._pc.rawPrompt = onDisk
            }

            for (const phase of PHASES) {
                const idx = PHASE_INDEX[phase.name]
                if (idx < resumeIdx) {
                    this._pc[phase.field] = (await readSection(cwd, id, phase.section)) ?? ''
                    // A row's `section` restores exactly ONE field. A phase that also
                    // settles another one declares that as its `carry`, and the replay
                    // is the only thing standing between a resume and losing it — the
                    // task file deliberately stores the PRE-carry text for the field
                    // compose rewrites. Trail lines are discarded: the live run that
                    // wrote this section already recorded them.
                    await replayPhaseCarry(phase, this._deps, this._pc)
                    continue
                }
                await advance(phase.name)
                this._deps.logDebug?.(`phase:${phase.name}: start`)
                const children: TimingEntry[] = []
                this._currentPhaseChildren = children
                const phaseStart = Date.now()
                let out: string
                try {
                    out = await runPhaseRow(phase, this._deps, this._pc)
                } finally {
                    const phaseMs = Date.now() - phaseStart
                    this._timings.push({label: phase.name, ms: phaseMs, children})
                    this._currentPhaseChildren = null
                    this._deps.logDebug?.(`phase:${phase.name}: done ms=${phaseMs}`)
                }
                await setTaskSection(cwd, id, phase.section, out)
                this._pc[phase.field] = out
                await postCommitPhase(phase, this._deps, this._pc, out)
                // SAFE CHECKPOINT (phase boundary): this phase's output is on disk
                // and the next `advance()` has not moved front-matter forward, so a
                // resume re-enters at exactly this phase. Without this the whole
                // spec pipeline (refine→critique, ~4.5 min on the mx5 run, research
                // alone ~3 min) runs to completion after a cancel is requested.
                // Throwing USER_CANCELLED reuses the existing cancellation path:
                // handleFailure leaves the task resumable and /task-auto's catch
                // announces the resume hint.
                if (cancelCheckpoint(`phase:${phase.name}`)) {
                    this._deps.logDebug?.(`cancel: stopping after phase ${phase.name}`)
                    throw new Error(USER_CANCELLED)
                }
            }

            // All phases done — hand off the spec.
            await advance('done')
            if (parseVerifyBlock(this._pc.spec) === null) throw new Error('no_verify_block')
            await updateTaskFrontMatter(cwd, id, {state: 'completed', phase: 'done'})
            this._disposeWidget()
            await setTaskSection(cwd, id, 'phase timings', formatTimings(this._timings))
            await setTaskSection(cwd, id, 'handoff', `handoff_at: ${new Date().toISOString()}`)
            await this._deliverSpec(ctx)
            return {kind: 'completed'}
        } catch (err) {
            this._disposeWidget()
            // Persist whatever timings we collected so failed runs are still
            // useful for analysis. Best-effort — never mask the original error.
            if (this._timings.length > 0) {
                try {
                    await setTaskSection(cwd, id, 'phase timings', formatTimings(this._timings))
                } catch {
                    /* ignore — preserve original failure */
                }
            }
            // `classifyFailure` already decided whether this was a cancel or a
            // fault; the value is the answer, not a side effect of writing a file.
            const c = await handleFailure(err, ctx, cwd, id, this._abort.signal.aborted)
            return c.state === 'cancelled' ?
                    {kind: 'cancelled'}
                :   {kind: 'failed', ...(c.reason === undefined ? {} : {reason: c.reason})}
        } finally {
            this._disposeWidget()
            clearActiveTask(this)
        }
    }

    /** Stop the phase widget — clearing both the terminal and remote surfaces —
     *  exactly once. Nulling the disposer makes repeat calls no-ops, so the
     *  failure flash that handleFailure sets after the catch isn't wiped by the
     *  finally block's call. */
    private _disposeWidget(): void {
        this._stopWidget?.()
        this._stopWidget = null
    }

    private async _deliverSpec(_ctx: ExtensionCommandContext): Promise<void> {
        const spec = await this._specForDelivery()
        // Keep the rich status block alive across the implementation turn (the phase
        // widget was disposed at handoff). Awaited (/task-auto) stays armed across all
        // sub-turns and is disarmed here; fire-and-forget (/task) arms one-shot and its
        // own agent_end disarms it after the single turn.
        const meta = {
            taskId: this._widgetState.taskId,
            title: this._widgetState.title,
            label: this._widgetState.label
        }
        if (this._sendSpec) {
            armImplWidget(meta, {oneShot: !this._implAwaited})
            try {
                await this._sendSpec(spec)
            } finally {
                if (this._implAwaited) disarmImplWidget()
            }
            return
        }
        if (!piApi) {
            throw new Error('extension not initialised (no ExtensionAPI captured)')
        }
        armImplWidget(meta, {oneShot: true})
        // Always name a delivery mode. pi ignores it when the session is idle and
        // uses it when something else is streaming — so this one call is correct
        // in both cases, where an isIdle() check is a check-then-act race that
        // loses to any turn starting in between (issue #8).
        piApi.sendUserMessage(spec, {deliverAs: 'followUp'})
    }

    /**
     * The spec as the implementer should receive it (Layer B). Layer A strips phantom
     * specifiers from the upstream pipeline text, but a residual affirmative can survive
     * into the composed spec, or arrive when pi expands an `@design.md` the spec
     * references — and the implementer is told that doc is authoritative. Prepend a
     * VERIFIED API OVERRIDES banner that outranks the spec for any specifier the
     * deterministic check proves does not exist. No-op (returns the spec unchanged) when
     * nothing is flagged or the runtime's types aren't installed.
     */
    private async _specForDelivery(): Promise<string> {
        const phantoms = await findDeliveryPhantoms(this._pc.spec, this._cwd)
        const apiBanner = formatApiOverrideBanner(phantoms)
        if (apiBanner) {
            this._deps.logDebug?.(
                `impl-handoff API override banner prepended for: ${phantoms.map(p => p.spec).join(', ')}`
            )
        }
        // A verify-FAIL re-attempt: the work was already implemented once and the
        // verification gate rejected it. Lead with WHY so the model fixes that
        // specific failure and re-satisfies the VERIFY block, rather than redoing
        // the task from scratch (or repeating the same mistake).
        let fixBanner = ''
        if (this._fixInstruction && this._fixInstruction.trim().length > 0) {
            this._deps.logDebug?.('impl-handoff RE-ATTEMPT banner prepended (verify FAIL fix)')
            fixBanner =
                'RE-ATTEMPT — your previous implementation of this task FAILED verification.\n'
                + "Fix the cause below, then make the spec's VERIFY block pass. Do NOT start over;\n"
                + 'change only what is needed to resolve the failure.\n\n'
                + `VERIFICATION FAILURE:\n${this._fixInstruction.trim()}`
        }
        const banners = [fixBanner, apiBanner].filter(b => b && b.length > 0).join('\n\n')
        return banners ? `${banners}\n\n${this._pc.spec}` : this._pc.spec
    }
}

// ─── runSingleTask ────────────────────────────────────────────────────────────

export interface RunSingleTaskOptions extends Pick<
    TaskRunnerOptions,
    | 'resumeId'
    | 'spawnFn'
    | 'runChild'
    | 'runWorker'
    | 'lookups'
    | 'onStart'
    | 'planContext'
    | 'fixInstruction'
> {
    /** Await the session going idle after the spec is delivered, so the caller
     *  blocks until the agent has implemented it. Default false. */
    waitForImplementation?: boolean
    /**
     * Ask the user for a steering message after they interrupt (ESC) the
     * implementation turn. Return text to continue the same task as another turn,
     * or undefined/empty to pause the run. Only consulted with
     * waitForImplementation. Defaults to a bridged SessionUI.ask (local TUI input
     * raced against a remote browser card); injectable so the steer loop is
     * testable without a real dialog.
     */
    promptSteer?: SuperviseOptions['promptSteer']
    /**
     * Push a "Task finished" notification to subscribed devices when this run
     * reaches a terminal state (completed / failed / cancelled). Set only by the
     * top-level /task and /task-resume command handlers — NOT by /task-auto's
     * internal per-task runs, which must stay silent. Default false.
     */
    notifyFinish?: boolean
    /**
     * How the implementation turn's thinking level is read and written. Defaults
     * to the live pi session; injected by tests, which must be able to assert
     * the restore without a real session to restore.
     */
    thinkingControl?: ThinkingControl
}

export interface RunSingleTaskResult {
    taskId: string
    /**
     * How the run ended, named by the runner rather than re-derived from disk.
     *
     * This was `ok: boolean` plus `sessionCancelled`, `interrupted` and `reason`
     * — four fields for one fact, three of them smuggled out of the `withSession`
     * closure through mutable captures. `/task-cancel` fell into the `!ok` arm
     * and was reported as a failure; see run-end.ts.
     */
    end: RunEnd
    /**
     * The session context the caller must use for any work after this call. A
     * successful run replaces the session via ctx.newSession(), which leaves the
     * caller's original ctx stale — this is the fresh replacement ctx and callers
     * MUST adopt it (using the original throws "stale ctx"). On cancellation no
     * replacement happened, so this is the original, still-live ctx. Optional
     * only so test fakes that don't model session replacement can omit it.
     */
    ctx?: ExtensionCommandContext
}

/**
 * Run one prompt through the full single-task pipeline in a fresh session and
 * deliver its spec. With waitForImplementation, block until the agent finishes
 * implementing the delivered spec.
 *
 * The ending comes from `TaskRunner.run`. It used to be read back off the task
 * file's front matter — a disk round-trip this process made to learn what it had
 * just done, and one that could not tell a cancel from a failure.
 */
export async function runSingleTask(
    ctx: ExtensionCommandContext,
    cwd: string,
    rawPrompt: string,
    opts: RunSingleTaskOptions = {}
): Promise<RunSingleTaskResult> {
    let taskId = ''
    // How the runner said it ended. `no-session` until it has run at all — the
    // withSession callback below may never be entered.
    let runEnd: RunEnd = {kind: 'no-session'} as RunEnd
    // The newSession replacement ctx, captured so the caller can keep driving the
    // UI after the original ctx is torn down. Defaults to the original for the
    // cancellation path (where no replacement occurs).
    let freshCtx: ExtensionCommandContext = ctx
    let interrupted = false
    // The implementation turn's failure cause, when it ended with stopReason
    // "error" (only meaningful in the waitForImplementation path). The task file
    // was already marked `completed` at spec-handoff, so this is the only signal
    // that the implementation itself died and the task must not be checked off.
    let implError: string | undefined
    const result = await ctx.newSession({
        withSession: async newCtx => {
            freshCtx = newCtx
            getBridge().currentCtx = newCtx // keep remote dispatch ctx fresh across session replacement
            // Same reason, for the terminal: pi clears every extension terminal
            // input listener when the old session is invalidated, and that
            // happens at the START of each task — precisely the window a typed
            // /task-auto-cancel has to survive. No-op unless a run armed one.
            rearmCancelListener(newCtx)
            const runner = new TaskRunner({
                ctx: newCtx,
                cwd,
                rawPrompt,
                resumeId: opts.resumeId,
                sendSpec: async spec => {
                    // The implementation turn is the one "child" that is not a
                    // child: it runs in the user's own session, so its reasoning
                    // group is applied by moving pi's level and moving it back.
                    // The autofix re-runner (gateRunTask) re-enters runSingleTask
                    // and so re-enters this closure, which is why the hold lives
                    // here rather than at either call site.
                    const release = holdImplementationThinking(
                        opts.thinkingControl ?? piThinkingControl()
                    )
                    try {
                        // Queue-or-run: never throws, whatever else is on the session (issue #8).
                        await newCtx.sendUserMessage(spec, {deliverAs: 'followUp'})
                        if (opts.waitForImplementation) {
                            await newCtx.waitForIdle()
                            // A threshold auto-compaction parks the turn at idle WITHOUT
                            // auto-continuing, and a user ESC ends it "aborted": the
                            // first idle is not the turn's real end. superviseImplementation
                            // resumes across compactions, steers across interrupts, and
                            // reads how the turn ACTUALLY ended.
                            const outcome = await superviseImplementation(newCtx as SteerCtx, {
                                promptSteer: opts.promptSteer
                            })
                            interrupted = outcome.interrupted
                            implError = outcome.error
                        }
                    } finally {
                        release()
                    }
                },
                spawnFn: opts.spawnFn,
                runChild: opts.runChild,
                runWorker: opts.runWorker,
                lookups: opts.lookups,
                onStart: opts.onStart,
                planContext: opts.planContext,
                fixInstruction: opts.fixInstruction,
                implAwaited: opts.waitForImplementation
            })
            runEnd = await runner.run()
            taskId = runner.taskId
        }
    })
    if (result.cancelled) {
        // No replacement happened — the original ctx is still live.
        if (opts.notifyFinish) {
            void pushNotify(
                'Task finished',
                `${taskId || 'Task'} cancelled — could not start a session.`,
                'pi-end'
            ).catch(() => {})
        }
        return {taskId, end: {kind: 'no-session'}, ctx}
    }
    // The runner already named the ending. What the SUPERVISION adds is the two
    // endings the runner cannot see, because they happen after the spec is
    // delivered and the task file already reads `completed`:
    //
    //   • the user interrupted and declined to steer — a pause, not a fault;
    //   • the implementation turn died with stopReason "error" (a context-overflow
    //     400, say), which must stop /task-auto here rather than let it commit and
    //     advance on a file that says `completed`.
    //
    // Both used to reach the caller as extra fields beside a boolean, and both are
    // endings.
    let end = runEnd
    if (end.kind === 'completed' && interrupted) end = {kind: 'interrupted'}
    else if (end.kind === 'completed' && implError) end = {kind: 'failed', reason: implError}
    if (opts.notifyFinish) {
        // One push per top-level /task or /task-resume, on any terminal end.
        void pushNotify('Task finished', `${taskId || 'Task'} ${end.kind}.`, 'pi-end').catch(
            () => {}
        )
    }
    return {taskId, end, ctx: freshCtx}
}

// ─── Gated single-task flow ────────────────────────────────────────────────────

/**
 * The AUTOFIX re-runner injected into the gate deps: re-run a task's
 * implementation turn, blocking until it finishes (steering across interrupts and
 * resuming across compactions). Shared by /task and /task-auto so both gate the
 * same way; lives here because it wraps runSingleTask (gate-deps must not import the
 * orchestrators, to keep the dependency graph acyclic).
 */
export const gateRunTask: RunTaskFn = (c, cwd, t, opts) =>
    runSingleTask(c, cwd, t, {
        waitForImplementation: true,
        resumeId: opts?.resumeId,
        onStart: opts?.onStart,
        planContext: opts?.planContext,
        fixInstruction: opts?.fixInstruction
    })

/**
 * Demote a task file to a resumable state after a gate (or its implementation)
 * stopped short. The file is marked `completed` at spec-handoff — before the work
 * is even verified — so a gate FAIL would otherwise leave it un-resumable
 * (`completed` is not in RESUMABLE_STATES). Best-effort; a missing/empty id is a
 * no-op. Mirrors how /task-auto marks the parent run `failed` so resume re-runs it.
 */
export async function markResumable(cwd: string, taskId: string): Promise<void> {
    if (!taskId) return
    try {
        await updateTaskFrontMatter(cwd, taskId, {state: 'failed'})
    } catch {
        /* best-effort */
    }
}

/**
 * Run a single /task through implementation AND the shared verify + enforce gates,
 * blocking until both finish. Used instead of the fire-and-forget handoff whenever
 * `verify work` or `enforce guidelines` is enabled — so /task gates exactly like a
 * /task-auto sub-task does. A terminal stop (the implementation died, or a gate
 * paused/failed) leaves the task resumable and tells the user to /task-resume.
 */
export async function runGatedTask(
    ctx: ExtensionCommandContext,
    cwd: string,
    raw: string,
    opts: {resumeId?: string; deps?: GateDeps} = {}
): Promise<void> {
    // The GATES are part of the run, and they are child processes with the host
    // session idle — the same hold window as the spec phases. Bracketing only
    // TaskRunner would leave verify/enforce looking like "no run", which a live
    // run on pi 0.82.1 showed as runActive=false while the widget still read
    // "verifying work" (issue #8). The body has many early returns, so the
    // bracket lives in this wrapper rather than in a dozen places. The same
    // bracket arms the raw-stdin interception for the WHOLE run: without it a
    // plain /task had no terminal path at all — only /task-auto armed one — so a
    // line typed during it went into pi's queue and fired after the run (seen
    // live). No onCancel: a typed /task-auto-cancel goes through the generic
    // bridge dispatch here.
    await withRun(ctx, {}, () => runGatedTaskInner(ctx, cwd, raw, opts))
}

async function runGatedTaskInner(
    ctx: ExtensionCommandContext,
    cwd: string,
    raw: string,
    opts: {resumeId?: string; deps?: GateDeps} = {}
): Promise<void> {
    const abort = new AbortController()
    const deps =
        opts.deps
        ?? buildGateDeps({
            signal: abort.signal,
            parentContextWindow: getParentContextWindow(ctx),
            runTask: gateRunTask
        })
    let active = ctx
    // One push + remote bubble on the terminal outcome (parity with the
    // notifyFinish push the fire-and-forget path emits via runSingleTask).
    // Bound late to `active`: a gate autofix can replace the live session.
    const announce = (msg: string, level: 'info' | 'warning' | 'error'): void =>
        announceTerminal(active, msg, level)

    // First implementation run (blocking).
    const res = await deps.runTask(active, cwd, raw, {resumeId: opts.resumeId})
    active = res.ctx ?? active
    const tag = res.taskId || 'Task'
    // One dispatch over the named ending. The four-branch ladder this replaces put
    // a CANCELLED run into the `!ok` arm, so `/task-cancel` overwrote the file's
    // `cancelled` with `failed` and told the user their task had stopped and needed
    // fixing. Resumability comes from RUN_END_POLICY; the wording stays here,
    // because `/task-auto` says `/task-auto-resume` where this says `/task-resume`.
    if (!runSucceeded(res.end)) {
        const policy = RUN_END_POLICY[res.end.kind]
        if (policy.resumable) await markResumable(cwd, res.taskId)
        const why =
            res.end.kind === 'failed' && res.end.reason ? ` — ${res.end.reason.slice(0, 160)}` : ''
        const msg =
            res.end.kind === 'no-session' ? `${tag} — could not start a fresh session for /task.`
            : res.end.kind === 'cancelled' ? `${tag} cancelled.`
            : res.end.kind === 'interrupted' ? `${tag} paused — resume with /task-resume.`
            : `${tag} stopped${why} — fix and run /task-resume.`
        announce(msg, policy.level)
        return
    }

    // The composed task's own front-matter title — used in commit messages and
    // notifies (the gate sequence has no plan title to borrow). Degrade to the id.
    let title = tag
    try {
        const {frontMatter} = await readTaskFile(cwd, res.taskId)
        title = frontMatter.title || tag
    } catch {
        /* keep the id as the title */
    }

    const gate = await runGatesForTask(active, deps, {
        cwd,
        taskId: res.taskId,
        title,
        tag
        // No sibling plan → no scope fence; no parent list → no check-off.
    })
    active = gate.ctx
    // What each outcome means for persistence and for the user is stated once, in
    // TERMINAL_OUTCOMES, and shared with /task-auto's loop. `failParent` is
    // ignored here: /task runs one task and has no parent run file to fail.
    const outcome = TERMINAL_OUTCOMES[gate.kind]
    if (outcome.markResumable) await markResumable(cwd, res.taskId)
    announce(
        outcome.message({
            tag,
            at: formatAt(),
            why: formatWhy(gate.kind === 'failed' ? gate.reason : undefined),
            resumeCmd: '/task-resume'
        }),
        outcome.level
    )
}

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleTask(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    const raw = args.trim()
    if (raw.length === 0) {
        ctx.ui.setEditorText('/task ')
        ctx.ui.notify('Type your prompt after /task (use @ for file completion).', 'info')
        return
    }
    // When a gate is enabled, /task awaits the implementation and runs the same
    // verify + enforce gates a /task-auto sub-task does. With both gates off
    // (the default), /task stays fire-and-forget: hand the spec to the main
    // conversation and return immediately, exactly as before.
    const cfg = getConfig()
    if (cfg.verifyWork || cfg.enforceGuidelines) {
        await runGatedTask(ctx, cwd, raw)
        return
    }
    const {end} = await runSingleTask(ctx, cwd, raw, {notifyFinish: true})
    if (end.kind === 'no-session') {
        ctx.ui.notify('Could not start a fresh session for /task.', 'warning')
    }
}

async function handleTaskList(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    const cwd = ctx.cwd
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    const taskFiles = entries.filter((e: string) => /^TASK_\d+\.md$/.test(e))
    const rows: Array<{fm: TaskFrontMatter; mtime: number}> = []
    for (const f of taskFiles) {
        try {
            const raw = await readTextFile(path.join(tasksDir(cwd), f))
            const fm = parseFrontMatter(raw)
            if (!fm) continue
            const st = await fsp.stat(path.join(tasksDir(cwd), f))
            rows.push({fm, mtime: st.mtimeMs})
        } catch {
            /* skip unreadable */
        }
    }
    rows.sort((a, b) => b.mtime - a.mtime)
    const lines: string[] = []
    for (const {fm} of rows) {
        const idx = PHASE_INDEX[fm.phase]
        const phasePart = `phase ${Math.min(idx + 1, PHASE_ORDER.length)}/${PHASE_ORDER.length} ${fm.phase}`
        const date = fm.updated_at.replace('T', ' ').slice(0, 16)
        lines.push(
            `${fm.id}  ${fm.state.padEnd(12)}  ${phasePart.padEnd(24)}  ${date}  "${titleForDisplay(fm)}"`
        )
    }
    if (lines.length === 0) lines.push('(no tasks in .pi-tasks/)')
    lines.push(
        '',
        'resume: /task-resume <id>   (eligible: in_progress, pending, cancelled, failed)'
    )
    publishViewer('Tasks', lines.join('\n'))
    await ctx.ui.editor('Tasks', lines.join('\n'))
}

async function handleTaskResume(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    let id: string | undefined
    if (args.trim().length > 0) {
        id = normaliseTaskId(args)
        try {
            await fsp.access(taskFilePath(cwd, id))
        } catch {
            ctx.ui.notify(`${id} not found in .pi-tasks/`, 'error')
            publishNotify(`${id} not found in .pi-tasks/`, 'error')
            return
        }
    } else {
        await ensureTasksDir(cwd)
        const entries = await fsp.readdir(tasksDir(cwd))
        const candidates: Array<{id: string; mtime: number}> = []
        for (const f of entries) {
            const m = /^(TASK_\d+)\.md$/.exec(f)
            if (!m) continue
            try {
                const raw = await readTextFile(path.join(tasksDir(cwd), f))
                const fm = parseFrontMatter(raw)
                if (!fm) continue
                if (!RESUMABLE_STATES.includes(fm.state)) continue
                const st = await fsp.stat(path.join(tasksDir(cwd), f))
                candidates.push({id: m[1], mtime: st.mtimeMs})
            } catch {
                /* skip */
            }
        }
        candidates.sort((a, b) => b.mtime - a.mtime)
        if (candidates.length === 0) {
            ctx.ui.notify('No resumable tasks.', 'info')
            publishNotify('No resumable tasks.', 'info')
            return
        }
        id = candidates[0].id
    }
    // Match /task: resume through the gates when one is enabled, else fire-and-forget.
    const cfg = getConfig()
    if (cfg.verifyWork || cfg.enforceGuidelines) {
        await runGatedTask(ctx, cwd, '', {resumeId: id})
        return
    }
    const {end} = await runSingleTask(ctx, cwd, '', {resumeId: id, notifyFinish: true})
    if (end.kind === 'no-session') {
        ctx.ui.notify('Could not start a fresh session for /task-resume.', 'warning')
    }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function handleTaskCancel(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!activeTask) {
        ctx.ui.notify('No task is running.', 'info')
        publishNotify('No task is running.', 'info')
        return
    }
    activeTask.cancel()
    ctx.ui.notify(`Cancelling ${activeTask.taskId}…`, 'warning')
    publishNotify(`Cancelling ${activeTask.taskId}…`, 'warning')
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function registerTask(pi: ExtensionAPI): void {
    piApi = pi
    setupImplWidget(pi)
    // Deliver whatever the user typed while the run held the session, at the
    // first moment there is a live turn to steer. agent_start fires as streaming
    // begins, so `steer` is accepted here; when nothing is held this is a no-op,
    // which is every turn outside a run.
    pi.on('agent_start', () => {
        const held = takeHeldInput()
        if (held === null) return
        try {
            pi.sendUserMessage(held, {deliverAs: 'steer'})
            publishNotify('Delivered your message to the running task.', 'info')
        } catch (err) {
            publishNotify(`Could not deliver your message: ${(err as Error).message}`, 'warning')
        }
    })
    registerBridgeCommand(pi, 'task', {
        description: 'Start a new task. Usage: /task <prompt>',
        handler: handleTask
    })
    registerBridgeCommand(pi, 'task-list', {
        description: 'List tasks in this project.',
        handler: handleTaskList
    })
    registerBridgeCommand(pi, 'task-resume', {
        description: 'Resume a task. Usage: /task-resume [id]',
        handler: handleTaskResume
    })
    registerBridgeCommand(pi, 'task-cancel', {
        description: 'Cancel the currently running task.',
        handler: handleTaskCancel
    })
}
