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
    allocateTaskId,
    ensureTasksDir,
    normaliseTaskId,
    parseFrontMatter,
    readSection,
    readTaskFile,
    setTaskSection,
    taskFilePath,
    tasksDir,
    updateTaskFrontMatter,
    writeTaskFile,
    extractSection,
    type TaskFrontMatter,
    type PhaseName,
    RESUMABLE_STATES
} from './task-file.js'
import {startWidget, WIDGET_KEY, type WidgetState} from './widget.js'
import {parseVerifyBlock} from './parsers.js'
import {type PhaseDeps} from './child-runner.js'
import {formatTimings, type TimingEntry} from './timings.js'
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
        spawnFn?: SpawnFn
    ) {
        this._ctx = ctx
        this._cwd = cwd
        this._rawPrompt = rawPrompt
        this._resumeId = resumeId
        this._sendSpec = sendSpec
        this._startedAt = Date.now()

        // We'll populate id/title/phase lazily in run().
        // Placeholder — real values set in run().
        this._widgetState = {
            taskId: '',
            title: '',
            phase: 'refine',
            startedAt: this._startedAt
        }

        const parentContextWindow =
            ((ctx as unknown as {model?: {contextWindow?: number}}).model?.contextWindow as
                | number
                | undefined) ?? 0

        this._deps = {
            cwd,
            taskId: '',
            signal: this._abort.signal,
            spawn: spawnFn,
            onChildOutput: (line: string) => {
                this._widgetState.lastLine = line
            },
            onContextUsage: snapshot => {
                const prev = this._widgetState.contextUsage
                const cw =
                    snapshot.contextWindow > 0 ?
                        snapshot.contextWindow
                    :   prev?.contextWindow || parentContextWindow
                const percent =
                    cw > 0 ? Math.min(100, (snapshot.tokens / cw) * 100) : snapshot.percent
                this._widgetState.contextUsage = {
                    tokens: snapshot.tokens,
                    contextWindow: cw,
                    percent
                }
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
            spec: ''
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
        let resumePhase: PhaseName = 'refine'
        if (this._resumeId) {
            id = this._resumeId
            const {frontMatter} = await readTaskFile(cwd, id)
            title = frontMatter.title
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

        // Register as active.
        this._widgetState.taskId = id
        this._widgetState.title = title
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
                const children: TimingEntry[] = []
                this._currentPhaseChildren = children
                const phaseStart = Date.now()
                let out: string
                try {
                    out = await phase.run(this._deps, this._pc)
                } finally {
                    this._timings.push({
                        label: phase.name,
                        ms: Date.now() - phaseStart,
                        children
                    })
                    this._currentPhaseChildren = null
                }
                await setTaskSection(cwd, id, phase.section, out)
                this._pc[phase.field] = out
                await postCommitPhase(phase, this._pc, out)
            }

            // All phases done — hand off the spec.
            await advance('done')
            if (parseVerifyBlock(this._pc.spec) === null) throw new Error('no_verify_block')
            await updateTaskFrontMatter(cwd, id, {state: 'completed', phase: 'done'})
            this._stopWidget?.()
            try {
                ctx.ui.setWidget(WIDGET_KEY, undefined)
            } catch {
                /* stale ctx */
            }
            await setTaskSection(cwd, id, 'phase timings', formatTimings(this._timings))
            await setTaskSection(cwd, id, 'handoff', `handoff_at: ${new Date().toISOString()}`)
            await this._deliverSpec(ctx)
        } catch (err) {
            this._stopWidget?.()
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
            this._stopWidget?.()
            clearActiveTask(this)
        }
    }

    private async _deliverSpec(ctx: ExtensionCommandContext): Promise<void> {
        if (this._sendSpec) {
            await this._sendSpec(this._pc.spec)
            return
        }
        if (!piApi) {
            throw new Error('extension not initialised (no ExtensionAPI captured)')
        }
        if (ctx.isIdle()) {
            piApi.sendUserMessage(this._pc.spec)
        } else {
            piApi.sendUserMessage(this._pc.spec, {deliverAs: 'followUp'})
        }
    }
}

// ─── runSingleTask ────────────────────────────────────────────────────────────

export interface RunSingleTaskOptions {
    /** Await the session going idle after the spec is delivered, so the caller
     *  blocks until the agent has implemented it. Default false. */
    waitForImplementation?: boolean
    /** Test seam: spawn function forwarded to TaskRunner. */
    spawnFn?: SpawnFn
}

export interface RunSingleTaskResult {
    taskId: string
    ok: boolean
    sessionCancelled: boolean
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
    const result = await ctx.newSession({
        withSession: async newCtx => {
            const runner = new TaskRunner(
                newCtx,
                cwd,
                rawPrompt,
                undefined,
                async spec => {
                    await newCtx.sendUserMessage(spec)
                    if (opts.waitForImplementation) await newCtx.waitForIdle()
                },
                opts.spawnFn
            )
            await runner.run()
            taskId = runner.taskId
        }
    })
    if (result.cancelled) {
        return {taskId, ok: false, sessionCancelled: true}
    }
    let ok = false
    if (taskId) {
        try {
            const {frontMatter} = await readTaskFile(cwd, taskId)
            ok = frontMatter.state === 'completed'
        } catch {
            ok = false
        }
    }
    return {taskId, ok, sessionCancelled: false}
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
    const {sessionCancelled} = await runSingleTask(ctx, cwd, raw)
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
            const raw = await fsp.readFile(path.join(tasksDir(cwd), f), 'utf8')
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
            `${fm.id}  ${fm.state.padEnd(12)}  ${phasePart.padEnd(24)}  ${date}  "${fm.title}"`
        )
    }
    if (lines.length === 0) lines.push('(no tasks in .pi-tasks/)')
    lines.push(
        '',
        'resume: /task-resume <id>   (eligible: in_progress, pending, cancelled, failed)'
    )
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
                const raw = await fsp.readFile(path.join(tasksDir(cwd), f), 'utf8')
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
            return
        }
        id = candidates[0].id
    }
    const runner = new TaskRunner(ctx, cwd, '', id)
    await runner.run()
}

// eslint-disable-next-line @typescript-eslint/require-await
async function handleTaskCancel(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!activeTask) {
        ctx.ui.notify('No task is running.', 'info')
        return
    }
    activeTask.cancel()
    ctx.ui.notify(`Cancelling ${activeTask.taskId}…`, 'warning')
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export function registerTask(pi: ExtensionAPI): void {
    piApi = pi
    pi.registerCommand('task', {
        description: 'Start a new task. Usage: /task <prompt>',
        handler: handleTask
    })
    pi.registerCommand('task-list', {
        description: 'List tasks in this project.',
        handler: handleTaskList
    })
    pi.registerCommand('task-resume', {
        description: 'Resume a task. Usage: /task-resume [id]',
        handler: handleTaskResume
    })
    pi.registerCommand('task-cancel', {
        description: 'Cancel the currently running task.',
        handler: handleTaskCancel
    })
}
