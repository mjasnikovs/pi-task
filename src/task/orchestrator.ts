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
import {PHASES, postCommitPhase, type PhaseContext} from './phases.js'
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
import {
    publishViewer,
    publishNotify,
    publishLifecycleNotice,
    registerBridgeCommand,
    getBridge
} from '../remote/bridge.js'
import {pushNotify} from '../remote/push.js'
import {getConfig} from '../config/config.js'
import {buildGateDeps, type RunTaskFn} from './gate-deps.js'
import {runGatesForTask, type GateDeps} from './task-gates.js'
import {parseVerifyBlock} from './spec-validation.js'
import {findDeliveryPhantoms, formatApiOverrideBanner} from '../workers/phantom-imports.js'
import {titleForDisplay} from './parsers.js'
import {type PhaseDeps} from './child-runner.js'
import {formatTimings, type TimingEntry} from './timings.js'
import {getParentContextWindow, resolveContextUsage} from './context-usage.js'
import type {SpawnFn} from '../shared/child-process.js'

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
    /** True when the caller awaits the implementation turn (waitForImplementation):
     *  the impl widget stays armed across the whole impl phase (incl. compaction /
     *  steer turns) and is disarmed here. False for fire-and-forget /task, where the
     *  widget is armed one-shot and its own agent_end disarms it. */
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

    constructor(
        ctx: ExtensionCommandContext,
        cwd: string,
        rawPrompt: string,
        resumeId?: string,
        sendSpec?: (spec: string) => Promise<void>,
        spawnFn?: SpawnFn,
        onStart?: (taskId: string) => void | Promise<void>,
        planContext?: string,
        fixInstruction?: string,
        implAwaited?: boolean
    ) {
        this._ctx = ctx
        this._cwd = cwd
        this._rawPrompt = rawPrompt
        this._resumeId = resumeId
        this._sendSpec = sendSpec
        this._onStart = onStart
        this._planContext = planContext
        this._fixInstruction = fixInstruction
        this._implAwaited = implAwaited ?? false
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
            spawn: spawnFn,
            onChildOutput: (line: string) => {
                this._widgetState.lastLine = line
            },
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

    /** Execute the full task lifecycle. */
    async run(): Promise<void> {
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
        this._deps.logDebug = (msg: string) => {
            const line = `${new Date().toISOString()} ${msg}\n`
            fsp.appendFile(debugLogPath, line).catch(() => {
                /* ignore */
            })
        }
        this._deps.logDebug(`run: start phase=${resumePhase}`)

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
                    continue
                }
                await advance(phase.name)
                this._deps.logDebug?.(`phase:${phase.name}: start`)
                const children: TimingEntry[] = []
                this._currentPhaseChildren = children
                const phaseStart = Date.now()
                let out: string
                try {
                    out = await phase.run(this._deps, this._pc)
                } finally {
                    const phaseMs = Date.now() - phaseStart
                    this._timings.push({label: phase.name, ms: phaseMs, children})
                    this._currentPhaseChildren = null
                    this._deps.logDebug?.(`phase:${phase.name}: done ms=${phaseMs}`)
                }
                await setTaskSection(cwd, id, phase.section, out)
                this._pc[phase.field] = out
                await postCommitPhase(phase, this._deps, this._pc, out)
            }

            // All phases done — hand off the spec.
            await advance('done')
            if (parseVerifyBlock(this._pc.spec) === null) throw new Error('no_verify_block')
            await updateTaskFrontMatter(cwd, id, {state: 'completed', phase: 'done'})
            this._disposeWidget()
            await setTaskSection(cwd, id, 'phase timings', formatTimings(this._timings))
            await setTaskSection(cwd, id, 'handoff', `handoff_at: ${new Date().toISOString()}`)
            await this._deliverSpec(ctx)
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
            await handleFailure(err, ctx, cwd, id, this._abort.signal.aborted)
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

    private async _deliverSpec(ctx: ExtensionCommandContext): Promise<void> {
        const spec = this._specForDelivery()
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
        if (ctx.isIdle()) {
            piApi.sendUserMessage(spec)
        } else {
            piApi.sendUserMessage(spec, {deliverAs: 'followUp'})
        }
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
    private _specForDelivery(): string {
        const phantoms = findDeliveryPhantoms(this._pc.spec, this._cwd)
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

export interface RunSingleTaskOptions {
    /** Await the session going idle after the spec is delivered, so the caller
     *  blocks until the agent has implemented it. Default false. */
    waitForImplementation?: boolean
    /** Resume an existing task by ID instead of starting a new one. */
    resumeId?: string
    /** Test seam: spawn function forwarded to TaskRunner. */
    spawnFn?: SpawnFn
    /** Called with the resolved task id once its file exists, before any phase
     *  work. Lets callers record the id (e.g. stamp the /task-auto entry) so an
     *  interrupted run can be resumed instead of restarted. */
    onStart?: (taskId: string) => void | Promise<void>
    /**
     * Ask the user for a steering message after they interrupt (ESC) the
     * implementation turn. Return text to continue the same task as another turn,
     * or undefined/empty to pause the run. Only consulted with
     * waitForImplementation. Defaults to a ctx.ui.input prompt; injectable so the
     * steer loop is testable without a real dialog.
     */
    promptSteer?: (ctx: ExtensionCommandContext) => Promise<string | undefined>
    /**
     * Push a "Task finished" notification to subscribed devices when this run
     * reaches a terminal state (completed / failed / cancelled). Set only by the
     * top-level /task and /task-resume command handlers — NOT by /task-auto's
     * internal per-task runs, which must stay silent. Default false.
     */
    notifyFinish?: boolean
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
}

/** Dialog copy for the post-interrupt steering prompt. */
const STEER_TITLE = 'Paused — steer the model'
const STEER_PLACEHOLDER = 'Type guidance to continue this task, or leave empty to pause'

/**
 * The slice of the replacement-session context the steer loop needs.
 * `sendUserMessage` lives on ReplacedSessionContext (not the base command ctx,
 * and not re-exported from the package), so we narrow to just what we call.
 */
export type SteerCtx = ExtensionCommandContext & {
    sendUserMessage(content: string, options?: {deliverAs?: 'steer' | 'followUp'}): Promise<void>
}

export interface RunSingleTaskResult {
    taskId: string
    ok: boolean
    sessionCancelled: boolean
    /**
     * The session context the caller must use for any work after this call. A
     * successful run replaces the session via ctx.newSession(), which leaves the
     * caller's original ctx stale — this is the fresh replacement ctx and callers
     * MUST adopt it (using the original throws "stale ctx"). On cancellation no
     * replacement happened, so this is the original, still-live ctx. Optional
     * only so test fakes that don't model session replacement can omit it.
     */
    ctx?: ExtensionCommandContext
    /**
     * Set when the user interrupted the implementation (ESC) and then declined to
     * steer (submitted an empty steer prompt) — i.e. they want the run to pause
     * rather than continue. Only meaningful with waitForImplementation. The
     * /task-auto loop reads this to pause (resumable) instead of checking the task
     * off and advancing. A plain ESC that the user follows with steering text does
     * NOT set this — that case loops on the same task until a turn finishes
     * uninterrupted.
     */
    interrupted?: boolean
    /**
     * Why the run is not ok, when known. Set when a waitForImplementation turn
     * ended with stopReason "error" (the model/provider died mid-implementation —
     * e.g. a context-overflow 400 — after the task file was already marked
     * `completed` at spec-handoff). The /task-auto loop surfaces this in its
     * "stopped at …" message so the real cause isn't lost. Undefined otherwise.
     */
    reason?: string
}

/**
 * True when the most recent assistant turn ended because the user interrupted it
 * (pressed ESC). pi records a user abort as stopReason "aborted" on the assistant
 * message, distinct from a natural "stop". Read after the implementation wait so
 * the /task-auto loop can tell "user wants to steer" apart from "task finished".
 */
function wasInterrupted(ctx: ExtensionCommandContext): boolean {
    const entries = ctx.sessionManager.getEntries()
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if ('message' in e && 'role' in e.message && e.message.role === 'assistant') {
            return e.message.stopReason === 'aborted'
        }
    }
    return false
}

/**
 * The error cause when the most recent assistant turn ended with stopReason
 * "error" — the model/provider failed mid-implementation (context overflow,
 * disconnect, provider 5xx) after pi exhausted its own retries. Returns the
 * provider's errorMessage, or undefined if the turn ended cleanly ("stop") or
 * was user-aborted ("aborted", handled by wasInterrupted).
 *
 * The /task-auto loop reads this AFTER the implementation wait: a task's file is
 * marked `completed` at spec-handoff (before implementation), so without this
 * check an implementation turn that died — e.g. "400 ... exceeds the available
 * context size" — would still read as ok and get checked off and committed.
 */
function implementationError(ctx: ExtensionCommandContext): string | undefined {
    const entries = ctx.sessionManager.getEntries()
    for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i]
        if ('message' in e && 'role' in e.message && e.message.role === 'assistant') {
            const m = e.message as {stopReason?: string; errorMessage?: string}
            return m.stopReason === 'error' ? (m.errorMessage ?? 'model error') : undefined
        }
    }
    return undefined
}

/**
 * True when the implementation turn went idle right after a context compaction —
 * the most recent entry in the branch is a `compaction` boundary sitting after the
 * last assistant message.
 *
 * A *threshold* auto-compaction (the runtime's "context is getting large" path)
 * compacts and then deliberately does NOT auto-continue: it returns to idle and
 * expects a manual continue (`_runAutoCompaction("threshold", false)` →
 * `hasQueuedMessages()` is false → the agent loop stops). Our implementation wait
 * resolves at exactly that idle. Without this check it reads as "the model
 * finished" (the last assistant message is a normal `stop`, not `aborted`/`error`),
 * so the run jumps straight to the verify gate and abandons a half-done task at the
 * compaction boundary — the failure this detector closes.
 *
 * Position-based, not timestamp-based: the runtime APPENDS the compaction entry to
 * the tail of the branch after the assistant message that triggered it
 * (`appendCompaction` → `_appendEntry` push), so a `compaction` after the last
 * assistant message means we are parked on a compaction with no continuation. A
 * genuinely finished turn ends on an assistant message with no trailing compaction;
 * an *overflow* compaction self-retries, so it never leaves us idle here.
 */
export function endedAtCompactionBoundary(ctx: ExtensionCommandContext): boolean {
    const entries = ctx.sessionManager.getEntries()
    let lastAssistant = -1
    let lastCompaction = -1
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i]
        if ('message' in e && 'role' in e.message && e.message.role === 'assistant') {
            lastAssistant = i
        } else if (e.type === 'compaction') {
            lastCompaction = i
        }
    }
    return lastCompaction > lastAssistant
}

/**
 * Nudge that resumes an implementation turn the runtime parked at a compaction
 * boundary. It must let a turn that was genuinely finished (then tipped over the
 * threshold by its own final message) confirm completion without inventing busywork
 * — we cannot tell "paused mid-task by compaction" from "finished, then compacted"
 * from the boundary alone, so the wording lets a done turn end in one line.
 */
export const CONTINUE_AFTER_COMPACTION =
    'Your context was automatically compacted. Continue implementing this task from '
    + 'exactly where you left off, and keep going until it is fully done. If the '
    + 'implementation is already complete, say so in one line and stop — do not invent '
    + 'extra work or restart the task.'

/**
 * Safety cap on compaction-driven resumes for a single implementation turn. Each
 * resume follows a real compaction (which only fires after the model produced a
 * turn large enough to cross the threshold), so a legitimately large task may
 * resume a handful of times; the cap exists only to stop a pathological loop from
 * auto-sending forever with no user in the loop. Hitting it stops resuming and lets
 * the verify gate / `/task-auto-resume` catch any leftover incompleteness.
 */
export const MAX_COMPACTION_RESUMES = 20

/**
 * Resume an implementation turn that went idle at a threshold-compaction boundary.
 * The runtime compacts and parks at idle without auto-continuing; we send a
 * continue and wait again, repeating across successive compactions until the turn
 * ends on a real assistant message (genuine completion). A user ESC takes priority
 * (it is not a compaction boundary, and `wasInterrupted` guards the loop so the
 * steer loop handles it), and the safety cap bounds a runaway. Returns the number
 * of resumes performed (0 when the turn did not end on a compaction).
 */
export async function resumeAcrossCompactions(ctx: SteerCtx): Promise<number> {
    let resumes = 0
    while (
        resumes < MAX_COMPACTION_RESUMES
        && !wasInterrupted(ctx)
        && endedAtCompactionBoundary(ctx)
    ) {
        await ctx.sendUserMessage(CONTINUE_AFTER_COMPACTION)
        await ctx.waitForIdle()
        resumes++
    }
    return resumes
}

/**
 * After the implementation turn settles, honour a user ESC by letting them steer.
 *
 * `waitForIdle` resolves both on natural completion AND on an ESC (which aborts
 * the turn → idle). When the last turn was aborted, the host's main input loop is
 * blocked inside our command handler, so a message typed in the editor would only
 * queue, never run (interactive-mode routes idle input through onInputCallback,
 * which is unset while we hold the loop). We therefore solicit the steering text
 * ourselves and feed it back as another turn via sendUserMessage — which runs to
 * completion when the session is idle. Repeat until a turn finishes uninterrupted.
 *
 * Returns true when the user declined to steer (empty/cancelled) and the run
 * should pause; false when the implementation completed (steered or not).
 */
async function steerUntilDone(
    ctx: SteerCtx,
    promptSteer?: (ctx: ExtensionCommandContext) => Promise<string | undefined>
): Promise<boolean> {
    const ask = promptSteer ?? (c => c.ui.input(STEER_TITLE, STEER_PLACEHOLDER))
    while (wasInterrupted(ctx)) {
        const steer = await ask(ctx)
        if (steer === undefined || steer.trim().length === 0) return true // pause
        await ctx.sendUserMessage(steer)
        await ctx.waitForIdle()
    }
    return false
}

/**
 * Run one prompt through the full single-task pipeline in a fresh session and
 * deliver its spec. With waitForImplementation, block until the agent finishes
 * implementing the delivered spec. Success is read off the produced task file's
 * front-matter state (TaskRunner.run never throws).
 */
export async function runSingleTask(
    ctx: ExtensionCommandContext,
    cwd: string,
    rawPrompt: string,
    opts: RunSingleTaskOptions = {}
): Promise<RunSingleTaskResult> {
    let taskId = ''
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
            const runner = new TaskRunner(
                newCtx,
                cwd,
                rawPrompt,
                opts.resumeId,
                async spec => {
                    await newCtx.sendUserMessage(spec)
                    if (opts.waitForImplementation) {
                        await newCtx.waitForIdle()
                        // A threshold auto-compaction parks the turn at idle WITHOUT
                        // auto-continuing (the runtime expects a manual continue). Our
                        // single waitForIdle resolves there, so without this the run
                        // would treat a compaction mid-task as completion and jump
                        // straight to the verify gate. Resume across any compaction
                        // boundaries first, so steering/error inspection below see the
                        // turn's REAL end, not a compaction pause.
                        await resumeAcrossCompactions(newCtx)
                        interrupted = await steerUntilDone(newCtx, opts.promptSteer)
                        // A user-declined steer (interrupted) is its own paused
                        // path; otherwise inspect how the turn actually ended.
                        if (!interrupted) implError = implementationError(newCtx)
                    }
                },
                opts.spawnFn,
                opts.onStart,
                opts.planContext,
                opts.fixInstruction,
                opts.waitForImplementation
            )
            await runner.run()
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
        return {taskId, ok: false, sessionCancelled: true, ctx}
    }
    let ok = false
    let state: string | undefined
    if (taskId) {
        try {
            const {frontMatter} = await readTaskFile(cwd, taskId)
            state = frontMatter.state
            ok = state === 'completed'
        } catch {
            ok = false
        }
    }
    // The file reads `completed` from spec-handoff even when the implementation
    // turn then died. Demote to a failure so /task-auto stops here (leaving the
    // entry unchecked and resumable) instead of committing and advancing.
    if (ok && implError) ok = false
    if (opts.notifyFinish) {
        // One push per top-level /task or /task-resume, on any terminal end. The
        // file state is the source of truth: 'completed' on success, 'failed' /
        // 'cancelled' otherwise; an unreadable/absent file falls back to 'ended'.
        void pushNotify(
            'Task finished',
            `${taskId || 'Task'} ${state ?? 'ended'}.`,
            'pi-end'
        ).catch(() => {})
    }
    return {taskId, ok, sessionCancelled: false, ctx: freshCtx, interrupted, reason: implError}
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
    const announce = (msg: string, level: 'info' | 'warning' | 'error'): void => {
        active.ui.notify(msg, level)
        publishLifecycleNotice(msg, level)
        void pushNotify('Task finished', msg, 'pi-end').catch(() => {})
    }

    // First implementation run (blocking).
    const res = await deps.runTask(active, cwd, raw, {resumeId: opts.resumeId})
    active = res.ctx ?? active
    const tag = res.taskId || 'Task'
    if (res.sessionCancelled) {
        announce(`${tag} — could not start a fresh session for /task.`, 'warning')
        return
    }
    if (res.interrupted) {
        await markResumable(cwd, res.taskId)
        announce(`${tag} paused — resume with /task-resume.`, 'warning')
        return
    }
    if (!res.ok) {
        await markResumable(cwd, res.taskId)
        const why = res.reason ? ` — ${res.reason.slice(0, 160)}` : ''
        announce(`${tag} stopped${why} — fix and run /task-resume.`, 'error')
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
    switch (gate.kind) {
        case 'paused':
            await markResumable(cwd, res.taskId)
            announce(
                `${tag} paused — verification failed and you dismissed the choice; resume with /task-resume.`,
                'warning'
            )
            return
        case 'session-cancelled':
            announce(
                `${tag} paused — could not start a session for autofix. Run /task-resume to retry.`,
                'warning'
            )
            return
        case 'interrupted':
            await markResumable(cwd, res.taskId)
            announce(`${tag} paused — resume with /task-resume.`, 'warning')
            return
        case 'failed': {
            await markResumable(cwd, res.taskId)
            const why = gate.reason ? ` — ${gate.reason.slice(0, 160)}` : ''
            announce(`${tag} stopped${why} — fix and run /task-resume.`, 'error')
            return
        }
        case 'done':
            announce(`${tag} complete — verified.`, 'info')
            return
    }
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
    const {sessionCancelled} = await runSingleTask(ctx, cwd, raw, {notifyFinish: true})
    if (sessionCancelled) {
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
    const {sessionCancelled} = await runSingleTask(ctx, cwd, '', {resumeId: id, notifyFinish: true})
    if (sessionCancelled) {
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
