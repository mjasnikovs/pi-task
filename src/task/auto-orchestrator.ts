/**
 * /task-auto — plans a feature into a resumable list of task titles, then runs
 * each title through the existing single-task pipeline one at a time.
 *
 * This module currently holds the planning half (AutoDeps + planAuto). The run
 * loop, command handlers, and defaultDeps are added by the next task.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {runSingleTask} from './orchestrator.js'
import type {RunSingleTaskResult} from './orchestrator.js'
import {parseClarifyList, deriveTitle} from './parsers.js'
import {renderInlineMarkdown, stripInlineMarkdown} from './inline-markdown.js'
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
import {gitCommitAll, type CommitResult} from './auto-commit.js'
import type {TaskFrontMatter} from './task-types.js'
import {runPhaseChild, USER_CANCELLED, type PhaseDeps} from './child-runner.js'
import {startAutoLoader, type ContextSnapshot} from './widget.js'

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
    /** Snapshot the working tree into one commit after a task passes. */
    commit: (cwd: string, message: string) => Promise<CommitResult>
}

// Matches pi's @-file completion token (a path after @, until whitespace).
const MENTION_RE = /(?:^|\s)@([^\s]+)/g

/**
 * Expand any @file references in the feature text by appending each referenced
 * file's contents, so the planning children (clarify, decompose) always see the
 * real spec inline instead of relying on the model to open the file itself.
 * Without this, clarify on a one-line "Implement @spec.md" tends to bail with
 * NONE because, to the model, the request looks small and unambiguous.
 * Unreadable mentions (typos, non-file @tokens) are left untouched; the feature
 * is returned verbatim when nothing readable is referenced.
 */
export async function expandFeatureMentions(cwd: string, feature: string): Promise<string> {
    const seen = new Set<string>()
    const blocks: string[] = []
    for (const m of feature.matchAll(MENTION_RE)) {
        const rel = m[1]
        if (seen.has(rel)) continue
        seen.add(rel)
        try {
            const body = await fsp.readFile(path.resolve(cwd, rel), 'utf8')
            if (body.trim().length > 0) {
                blocks.push(`--- contents of ${rel} ---\n${body.trim()}`)
            }
        } catch {
            // not a readable file — leave the @token in place, skip expansion
        }
    }
    return blocks.length === 0 ? feature : `${feature.trim()}\n\n${blocks.join('\n\n')}`
}

/** Plan phase: clarify → decompose → write AUTO file. Returns the new id, or null. */
export async function planAuto(
    ctx: ExtensionCommandContext,
    cwd: string,
    feature: string,
    deps: AutoDeps
): Promise<string | null> {
    // clarify — sequential & adaptive: ask one question at a time, feeding every
    // answer back into the next call so later questions react to earlier ones
    // (e.g. a framework choice reshapes what gets asked). Each question is shown
    // with the model's recommended default pre-filled (Enter to accept, type to
    // override); we never auto-answer. The model emits NONE when nothing remains.
    const theme = ctx.ui.theme
    // Inline any @file spec the user referenced so clarify/decompose reason over
    // the real content, not a one-line "Implement @file" that reads as trivial.
    const featureForModel = await expandFeatureMentions(cwd, feature)
    const answers: string[] = []
    // Open-ended: keep asking until the model emits NONE or the user dismisses.
    for (;;) {
        const qRaw = await deps.runChild(
            'auto-clarify',
            'read',
            AUTO_CLARIFY_PROMPT(featureForModel, answers.join('\n'))
        )
        const parsed = parseClarifyList(qRaw)
        if (parsed.length === 0) break // NONE / nothing left to ask
        const {question, suggested} = parsed[0]
        // Render markdown (bold/code) for the displayed prompt; keep plain text
        // for the editable default and the persisted file.
        const shownQ = renderInlineMarkdown(question, theme)
        const plainQ = stripInlineMarkdown(question)
        const plainSuggested = suggested === undefined ? undefined : stripInlineMarkdown(suggested)
        const title =
            suggested ?
                `${shownQ}\n${theme.fg('muted', 'Recommended:')}\n\n${renderInlineMarkdown(suggested, theme)}\n\n${theme.fg('muted', 'press Enter to accept')}`
            :   `${shownQ}\n${theme.fg('muted', '(no recommendation — please answer)')}`
        const a = await ctx.ui.input(title, plainSuggested)
        if (a === undefined) {
            ctx.ui.notify('/task-auto cancelled.', 'warning')
            return null
        }
        const typed = a.trim()
        let answer: string
        if (typed.length === 0 && plainSuggested) {
            answer = `${plainSuggested} (accepted recommendation)`
        } else if (typed.length === 0) {
            answer = '(skipped)'
        } else {
            answer = typed
        }
        answers.push(`Q${answers.length + 1}: ${plainQ}\nA${answers.length + 1}: ${answer}`)
    }
    if (answers.length === 0) {
        ctx.ui.notify('No clarifying questions needed — planning tasks…', 'info')
    }
    const clarifications = answers.join('\n')

    // decompose
    const listRaw = await deps.runChild(
        'auto-decompose',
        'read',
        AUTO_DECOMPOSE_PROMPT(featureForModel, clarifications)
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

/** The two feature-level planning children, shown as steps in the loader. */
const AUTO_PLAN_STEPS: Record<string, {step: string; stepNum: number}> = {
    'auto-clarify': {step: 'clarify', stepNum: 1},
    'auto-decompose': {step: 'decompose', stepNum: 2}
}
const AUTO_PLAN_STEP_TOTAL = 2

function defaultDeps(
    ctx: ExtensionCommandContext,
    cwd: string,
    signal: AbortSignal,
    title: string
): AutoDeps {
    // Captured by the loader's getState so the widget mirrors the child's latest
    // output line and context usage, exactly like the single-task phase widget.
    let lastLine: string | undefined
    let contextUsage: ContextSnapshot | undefined
    const parentContextWindow =
        ((ctx as unknown as {model?: {contextWindow?: number}}).model?.contextWindow as
            | number
            | undefined) ?? 0
    const phaseDeps: PhaseDeps = {
        cwd,
        taskId: '',
        signal,
        onChildOutput: (line: string) => {
            lastLine = line
        },
        onContextUsage: snapshot => {
            const cw =
                snapshot.contextWindow > 0 ?
                    snapshot.contextWindow
                :   contextUsage?.contextWindow || parentContextWindow
            const percent = cw > 0 ? Math.min(100, (snapshot.tokens / cw) * 100) : snapshot.percent
            contextUsage = {tokens: snapshot.tokens, contextWindow: cw, percent}
        }
    }
    return {
        runChild: async (name, tools, prompt) => {
            // Planning children are slow LLM calls with no UI of their own; show
            // the same status block as /task so this never goes silent until the
            // drill dialog.
            lastLine = undefined
            contextUsage = undefined
            const startedAt = Date.now()
            const {step, stepNum} = AUTO_PLAN_STEPS[name] ?? {step: name, stepNum: 1}
            const stopLoader = startAutoLoader(ctx, () => ({
                title,
                step,
                stepNum,
                stepTotal: AUTO_PLAN_STEP_TOTAL,
                startedAt,
                lastLine,
                contextUsage
            }))
            try {
                return await runPhaseChild(phaseDeps, name, tools, prompt)
            } finally {
                stopLoader()
            }
        },
        runTask: (c, cwd2, t) => runSingleTask(c, cwd2, t, {waitForImplementation: true}),
        commit: (cwd2, message) => gitCommitAll(cwd2, message, signal)
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
    // Each task runs in its own fresh session (deps.runTask → ctx.newSession),
    // which tears down the current session and leaves the ctx we passed in stale.
    // Adopt the replacement ctx the runner hands back and use it for all further
    // UI and the next task — reusing the captured ctx throws "stale ctx".
    let active = ctx
    try {
        for (;;) {
            if (cancelRequested) {
                active.ui.notify(`${id} cancelled — resume with /task-auto-resume.`, 'warning')
                return
            }
            const {body} = await readTaskFile(cwd, id)
            const entries = parseTaskList(body)
            const next = entries.find(e => !e.done)
            if (!next) {
                await updateTaskFrontMatter(cwd, id, {state: 'completed'})
                active.ui.notify(`${id} complete — all ${entries.length} tasks done.`, 'info')
                return
            }
            active.ui.notify(
                `${id}: task ${next.index + 1}/${entries.length} — ${next.title}`,
                'info'
            )
            const res = await deps.runTask(active, cwd, next.title)
            active = res.ctx ?? active
            if (res.sessionCancelled) {
                active.ui.notify(
                    `${id} paused — could not start a session. Run /task-auto-resume to retry.`,
                    'warning'
                )
                return
            }
            if (!res.ok) {
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                active.ui.notify(
                    `${id} stopped at "${next.title}" — fix and run /task-auto-resume.`,
                    'error'
                )
                return
            }
            // res.ok === true means runner.run() completed, so res.taskId is the
            // allocated TASK_NNNN id (never empty here). checkOffTask tolerates an
            // empty id by writing a plain checked line, but that path is unreachable.
            await checkOffTask(cwd, id, next.index, res.taskId, next.title)
            // Commit the task's work (and the just-written check-off) as one
            // snapshot. Best-effort: a failed/empty commit only warns — the task
            // already passed, so the run continues.
            const message = `task: ${next.title} (${res.taskId})`
            const commit = await deps.commit(cwd, message)
            if (commit.committed) {
                active.ui.notify(`${id}: committed "${next.title}".`, 'info')
            } else {
                active.ui.notify(
                    `${id}: not committed (${commit.reason ?? 'unknown'}) — continuing.`,
                    'warning'
                )
            }
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
    const deps = defaultDeps(ctx, cwd, abort.signal, deriveTitle(raw))
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
    // Resume only runs the loop (runTask); no planning children, so the loader
    // title is unused here — pass the id for clarity if that ever changes.
    await runAutoLoop(ctx, cwd, id, defaultDeps(ctx, cwd, abort.signal, id))
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
