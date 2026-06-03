/**
 * /task-auto — plans a feature into a resumable list of task titles, then runs
 * each title through the existing single-task pipeline one at a time.
 *
 * This module currently holds the planning half (AutoDeps + planAuto). The run
 * loop, command handlers, and defaultDeps are added by the next task.
 */
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {runSingleTask} from './orchestrator.js'
import type {RunSingleTaskResult} from './orchestrator.js'
import {parseGrillQuestions, deriveTitle} from './parsers.js'
import {AUTO_CLARIFY_PROMPT, AUTO_DECOMPOSE_PROMPT} from './auto-prompts.js'
import {
    allocateAutoId,
    buildAutoBody,
    parseDecomposeList,
    parseTaskList,
    checkOffTask,
    findResumableAuto
} from './auto-io.js'
import {writeTaskFile, readTaskFile, updateTaskFrontMatter} from './task-io.js'
import type {TaskFrontMatter} from './task-types.js'
import {runPhaseChild, USER_CANCELLED, type PhaseDeps} from './child-runner.js'

/**
 * Injectable seams so the planner and loop are testable without spawning pi.
 * `runChild` is used by planAuto; `runTask` is used by runAutoLoop.
 */
export interface AutoDeps {
    runChild: (name: string, tools: string, prompt: string) => Promise<string>
    runTask: (
        ctx: ExtensionCommandContext,
        cwd: string,
        title: string
    ) => Promise<RunSingleTaskResult>
}

/** Plan phase: clarify → decompose → write AUTO file. Returns the new id, or null. */
export async function planAuto(
    ctx: ExtensionCommandContext,
    cwd: string,
    feature: string,
    deps: AutoDeps
): Promise<string | null> {
    // clarify
    const qRaw = await deps.runChild('auto-clarify', 'read', AUTO_CLARIFY_PROMPT(feature))
    const questions = parseGrillQuestions(qRaw)
    const answers: string[] = []
    for (let i = 0; i < questions.length; i++) {
        const a = await ctx.ui.input(questions[i])
        if (a === undefined) {
            ctx.ui.notify('/task-auto cancelled.', 'warning')
            return null
        }
        const typed = a.trim()
        answers.push(`Q${i + 1}: ${questions[i]}\nA${i + 1}: ${typed.length ? typed : '(skipped)'}`)
    }
    const clarifications = answers.join('\n')

    // decompose
    const listRaw = await deps.runChild(
        'auto-decompose',
        'read',
        AUTO_DECOMPOSE_PROMPT(feature, clarifications)
    )
    const titles = parseDecomposeList(listRaw)
    if (titles.length === 0) {
        ctx.ui.notify('/task-auto: no tasks produced from the feature.', 'warning')
        return null
    }

    // persist
    const id = await allocateAutoId(cwd)
    const now = new Date().toISOString()
    const fm: TaskFrontMatter = {
        id,
        state: 'in_progress',
        phase: 'done',
        created_at: now,
        updated_at: now,
        title: deriveTitle(feature)
    }
    await writeTaskFile(cwd, fm, buildAutoBody(feature, clarifications, titles))
    return id
}

function defaultDeps(cwd: string, signal: AbortSignal): AutoDeps {
    const phaseDeps: PhaseDeps = {cwd, taskId: '', signal}
    return {
        runChild: (name, tools, prompt) => runPhaseChild(phaseDeps, name, tools, prompt),
        runTask: (ctx, c, title) => runSingleTask(ctx, c, title, {waitForImplementation: true})
    }
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let cancelRequested = false
export function requestAutoCancel(): void {
    cancelRequested = true
}

export async function runAutoLoop(
    ctx: ExtensionCommandContext,
    cwd: string,
    id: string,
    deps: AutoDeps
): Promise<void> {
    cancelRequested = false
    try {
        for (;;) {
            if (cancelRequested) {
                ctx.ui.notify(`${id} cancelled — resume with /task-auto-resume.`, 'warning')
                return
            }
            const {body} = await readTaskFile(cwd, id)
            const entries = parseTaskList(body)
            const next = entries.find(e => !e.done)
            if (!next) {
                await updateTaskFrontMatter(cwd, id, {state: 'completed'})
                ctx.ui.notify(`${id} complete — all ${entries.length} tasks done.`, 'info')
                return
            }
            ctx.ui.notify(`${id}: task ${next.index + 1}/${entries.length} — ${next.title}`, 'info')
            const res = await deps.runTask(ctx, cwd, next.title)
            if (res.sessionCancelled) {
                ctx.ui.notify(
                    `${id} paused — could not start a session. Run /task-auto-resume to retry.`,
                    'warning'
                )
                return
            }
            if (!res.ok) {
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                ctx.ui.notify(
                    `${id} stopped at "${next.title}" — fix and run /task-auto-resume.`,
                    'error'
                )
                return
            }
            // res.ok === true means runner.run() completed, so res.taskId is the
            // allocated TASK_NNNN id (never empty here). checkOffTask tolerates an
            // empty id by writing a plain checked line, but that path is unreachable.
            await checkOffTask(cwd, id, next.index, res.taskId, next.title)
        }
    } finally {
        cancelRequested = false
    }
}

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleTaskAuto(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    const raw = args.trim()
    if (raw.length === 0) {
        ctx.ui.setEditorText('/task-auto ')
        ctx.ui.notify('Describe the feature after /task-auto (use @ for file completion).', 'info')
        return
    }
    const abort = new AbortController()
    const deps = defaultDeps(cwd, abort.signal)
    let id: string | null
    try {
        id = await planAuto(ctx, cwd, raw, deps)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) {
            ctx.ui.notify('/task-auto cancelled.', 'warning')
            return
        }
        ctx.ui.notify(`/task-auto planning failed: ${msg}`, 'error')
        return
    }
    if (!id) return
    await runAutoLoop(ctx, cwd, id, deps)
}

async function handleTaskAutoResume(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    const id = await findResumableAuto(cwd)
    if (!id) {
        ctx.ui.notify('No resumable /task-auto run.', 'info')
        return
    }
    ctx.ui.notify(`Resuming ${id}…`, 'info')
    await updateTaskFrontMatter(cwd, id, {state: 'in_progress'})
    const abort = new AbortController()
    await runAutoLoop(ctx, cwd, id, defaultDeps(cwd, abort.signal))
}

// eslint-disable-next-line @typescript-eslint/require-await
async function handleTaskAutoCancel(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    requestAutoCancel()
    ctx.ui.notify('Stopping /task-auto after the current task…', 'warning')
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerTaskAuto(pi: ExtensionAPI): void {
    pi.registerCommand('task-auto', {
        description: 'Plan a feature into tasks and run them. Usage: /task-auto <feature>',
        handler: handleTaskAuto
    })
    pi.registerCommand('task-auto-resume', {
        description: 'Resume the active /task-auto run.',
        handler: handleTaskAutoResume
    })
    pi.registerCommand('task-auto-cancel', {
        description: 'Stop the running /task-auto loop after the current task.',
        handler: handleTaskAutoCancel
    })
}
