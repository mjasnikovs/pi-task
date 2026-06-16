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
    stampTaskInProgress,
    findResumableAuto
} from './auto-io.js'
import {writeTaskFile, readTaskFile, updateTaskFrontMatter, taskFilePath} from './task-io.js'
import {gitCommitAll, type CommitResult} from './auto-commit.js'
import type {TaskFrontMatter} from './task-types.js'
import {runPhaseChild, USER_CANCELLED, type PhaseDeps} from './child-runner.js'
import {SessionUI, registerBridgeCommand} from '../remote/bridge.js'
import {pushNotify} from '../remote/push.js'
import {getConfig} from '../config/config.js'
import {startAutoLoader, type ContextSnapshot} from './widget.js'
import {getParentContextWindow, resolveContextUsage} from './context-usage.js'

/**
 * Injectable seams so the planner and loop are testable without spawning pi.
 * `runChild` is used by planAuto; `runTask` is used by runAutoLoop.
 */
export interface AutoDeps {
    runChild: (name: string, tools: string, prompt: string) => Promise<string>
    runTask: (
        ctx: ExtensionCommandContext,
        cwd: string,
        title: string,
        opts?: {
            /** Resume this inner task id instead of allocating a fresh one. */
            resumeId?: string
            /** Called with the inner task id once its file exists, before phases. */
            onStart?: (taskId: string) => void | Promise<void>
        }
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

/**
 * The @file references in the feature that point at a readable file on disk —
 * the bare path tokens, deduped, in first-seen order. Unreadable mentions
 * (typos, non-file @tokens) are dropped so we never advertise a missing file as
 * an authoritative spec.
 */
export async function readableMentions(cwd: string, feature: string): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    for (const m of feature.matchAll(MENTION_RE)) {
        const rel = m[1]
        if (seen.has(rel)) continue
        seen.add(rel)
        try {
            await fsp.access(path.resolve(cwd, rel))
            out.push(rel)
        } catch {
            // not a readable file — don't thread it into task titles
        }
    }
    return out
}

/** A trailing "[decisions: …]" clause decompose may attach to a task line. */
const DECISIONS_RE = /\s*\[decisions:\s*(.+?)\]\s*$/i

/**
 * Thread the feature's spec references AND any per-task decisions into every
 * decomposed task title. A title is ALL a per-task pipeline ever sees, so both
 * the design doc the feature pointed at and the user's clarification choices have
 * to ride along or they're invisible downstream — this is how an "Implement
 * @design.md" run built a generic `posts` table the spec never mentioned, and how
 * a "do not use vite" clarification got silently overridden by the doc's own
 * vite.config.ts.
 *
 * Precedence is the crux: a clarification is a CORRECTION to a (possibly stale)
 * spec doc, so the decisions clause is marked as overriding the doc, while the doc
 * stays authoritative for everything the decisions don't touch. Decompose scopes
 * each decision to the task(s) it governs, so most titles carry none. No readable
 * refs and no decisions → title unchanged, so a doc-less /task-auto behaves
 * exactly as before.
 */
export function attachSpecRefs(titles: string[], refs: string[]): string[] {
    const list = refs.map(r => '@' + r).join(' ')
    return titles.map(t => {
        if (t.includes('| spec:') || t.includes('| decisions')) return t // already threaded
        const dm = DECISIONS_RE.exec(t)
        const base = dm ? t.slice(0, dm.index).trimEnd() : t
        const decisions = dm ? dm[1].trim() : ''
        let out = base
        if (decisions) {
            out += ` | decisions (explicit user choices — these OVERRIDE the spec doc wherever they conflict; follow them exactly): ${decisions}`
        }
        if (refs.length > 0) {
            out += ` | spec: ${list} — otherwise authoritative; read it and follow it over this title wherever they differ`
        }
        return out
    })
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
    // exactly like /task's grill dialog: a binary fork offers two options (A/B),
    // otherwise the model's recommendation is shown as the input placeholder and
    // in the title. Nothing is pre-filled into the editor — submitting an empty
    // field is what accepts the recommendation (see the typed.length === 0 branch
    // below); typing overrides it. We never auto-answer; the model emits NONE when
    // nothing remains.
    const theme = ctx.ui.theme
    const ui = new SessionUI(ctx)
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
        const {question, suggested, alt} = parsed[0]
        // Render markdown (bold/code) for the displayed prompt; keep plain text
        // for the editable default and the persisted file.
        const shownQ = renderInlineMarkdown(question, theme)
        const plainQ = stripInlineMarkdown(question)
        const plainSuggested = suggested === undefined ? undefined : stripInlineMarkdown(suggested)
        const plainAlt = alt === undefined ? undefined : stripInlineMarkdown(alt)
        // Identical to /task's grill dialog: a binary fork becomes a select()
        // picker locally — each option on its own line, labelled A/B; a single
        // recommendation rides under the question as the input default; an open
        // question shows the bare prompt. No verbose "Recommended:" /
        // "press Enter to accept" scaffolding.
        const twoOption = plainSuggested !== undefined && plainAlt !== undefined
        const title =
            !twoOption && plainSuggested ?
                `${shownQ}\n${renderInlineMarkdown(suggested!, theme)}`
            :   shownQ
        const a = await ui.ask({
            localTitle: title,
            question: plainQ,
            recommended: plainSuggested,
            ...(plainAlt !== undefined && {recommended2: plainAlt}),
            allowSkip: plainSuggested === undefined && plainAlt === undefined,
            ...(twoOption && {
                options: [
                    {
                        label: `A: ${renderInlineMarkdown(suggested!, theme)}`,
                        value: plainSuggested!
                    },
                    {label: `B: ${renderInlineMarkdown(alt!, theme)}`, value: plainAlt!}
                ]
            })
        })
        if (a === undefined) {
            announceDone(ctx, '/task-auto cancelled.', 'warning')
            return null
        }
        const typed = a.trim()
        // The local picker resolves to the chosen option's full value, but a
        // remote user (or the picker's free-text fallback) may still type a bare
        // "A"/"B" — map those back to the option's full text. Mirrors phaseGrill.
        let answer: string
        if (typed.length === 0 && plainSuggested) {
            answer = `${plainSuggested} (accepted recommendation)`
        } else if (typed.length === 0) {
            answer = '(skipped)'
        } else if (twoOption && /^a[.)]?$/i.test(typed)) {
            answer = plainSuggested!
        } else if (twoOption && /^b[.)]?$/i.test(typed)) {
            answer = plainAlt!
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
    // Thread the feature's spec doc(s) into every title so each per-task
    // pipeline — which only ever sees its title — reads the real spec instead of
    // a lossy one-line paraphrase of it.
    const refs = await readableMentions(cwd, feature)
    const titles = attachSpecRefs(parseDecomposeList(listRaw), refs)
    if (titles.length === 0) {
        announceDone(ctx, '/task-auto: no tasks produced from the feature.', 'warning')
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
    const parentContextWindow = getParentContextWindow(ctx)
    const phaseDeps: PhaseDeps = {
        cwd,
        taskId: '',
        signal,
        onChildOutput: (line: string) => {
            lastLine = line
        },
        onContextUsage: snapshot => {
            contextUsage = resolveContextUsage(snapshot, contextUsage, parentContextWindow)
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
        runTask: (c, cwd2, t, opts) =>
            runSingleTask(c, cwd2, t, {
                waitForImplementation: true,
                resumeId: opts?.resumeId,
                onStart: opts?.onStart
            }),
        commit: (cwd2, message) =>
            getConfig().autoCommit ?
                gitCommitAll(cwd2, message, signal)
            :   Promise.resolve({committed: false, reason: 'auto-commit disabled'})
    }
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let cancelRequested = false
let autoRunning = false

export function requestAutoCancel(): void {
    cancelRequested = true
}

/**
 * Announce a terminal /task-auto-overall outcome both in the terminal and to
 * subscribed devices. The push body reuses the exact terminal message, so a
 * backgrounded phone learns the same thing the TUI shows. Used ONLY at the
 * overall run's terminal points — never per internal task (those go through
 * runSingleTask without notifyFinish, so they stay silent).
 */
function announceDone(
    ctx: ExtensionCommandContext,
    msg: string,
    level: 'info' | 'warning' | 'error'
): void {
    ctx.ui.notify(msg, level)
    void pushNotify('Task finished', msg, 'pi-end').catch(() => {})
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
                announceDone(active, `${id} cancelled — resume with /task-auto-resume.`, 'warning')
                return
            }
            const {body} = await readTaskFile(cwd, id)
            const entries = parseTaskList(body)
            const next = entries.find(e => !e.done)
            if (!next) {
                await updateTaskFrontMatter(cwd, id, {state: 'completed'})
                announceDone(active, `${id} complete — all ${entries.length} tasks done.`, 'info')
                return
            }
            active.ui.notify(
                `${id}: task ${next.index + 1}/${entries.length} — ${next.title}`,
                'info'
            )
            // If this entry already has a stamped inner id, it was started in a
            // previous (interrupted) run — resume it from its saved phase rather
            // than spawning a fresh task. But the stamped inner file can be gone
            // (deleted, or never written because allocation was interrupted), and
            // resuming a missing file throws ENOENT deep in the runner — which used
            // to take pi down. So verify the file exists and otherwise fall back to
            // a fresh start. Either way an unstamped/restarted entry is (re)stamped
            // the moment its inner id exists, keeping the next interruption
            // resumable. This mirrors /task-resume's continue-don't-restart.
            let resumeId = next.producedId
            if (resumeId) {
                try {
                    await fsp.access(taskFilePath(cwd, resumeId))
                } catch {
                    resumeId = undefined
                }
            }
            // Before starting, fold any uncommitted work into its own checkpoint
            // commit so a dirty tree at the start of the run — or edits left behind
            // by an interrupted/failed task — land separately instead of being swept
            // into this task's snapshot. Best-effort and a no-op on a clean tree
            // (gitCommitAll commits nothing), so it only ever produces a commit when
            // there is stray work; the matching post-task commit below is the "after"
            // half. Only the success path is announced to keep the common no-op quiet.
            const checkpoint = await deps.commit(cwd, `chore: checkpoint before "${next.title}"`)
            if (checkpoint.committed) {
                active.ui.notify(
                    `${id}: checkpointed uncommitted work before "${next.title}".`,
                    'info'
                )
            }
            const res = await deps.runTask(active, cwd, next.title, {
                resumeId,
                onStart:
                    resumeId ? undefined : (
                        innerId => stampTaskInProgress(cwd, id, next.index, innerId, next.title)
                    )
            })
            active = res.ctx ?? active
            if (res.sessionCancelled) {
                announceDone(
                    active,
                    `${id} paused — could not start a session. Run /task-auto-resume to retry.`,
                    'warning'
                )
                return
            }
            if (res.interrupted) {
                // The user interrupted implementation (ESC) and then declined to
                // steer (empty steer prompt) — they want to stop here. Pause
                // without checking the task off, so /task-auto-resume re-delivers
                // this task's spec to finish it. (A plain ESC that the user
                // follows with steering text never reaches here — that loops on
                // the same task inside runSingleTask until a turn completes.)
                announceDone(
                    active,
                    `${id} paused at "${next.title}" — resume with /task-auto-resume.`,
                    'warning'
                )
                return
            }
            if (!res.ok) {
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                // res.reason is set when the implementation turn itself died
                // (e.g. a context-overflow 400) — surface it so the real cause
                // isn't lost behind the generic "stopped" message.
                const why = res.reason ? ` — ${res.reason.slice(0, 160)}` : ''
                announceDone(
                    active,
                    `${id} stopped at "${next.title}"${why} — fix and run /task-auto-resume.`,
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
    } catch (err) {
        // Safety net: no failure inside the loop may propagate out of runAutoLoop,
        // because the resume handler doesn't wrap this call and an unhandled
        // rejection crashes pi outright. Convert it into a failed run + notify,
        // mirroring the in-loop per-task failure path.
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) {
            announceDone(active, `${id} cancelled — resume with /task-auto-resume.`, 'warning')
            return
        }
        await updateTaskFrontMatter(cwd, id, {state: 'failed'}).catch(() => {})
        announceDone(active, `${id} stopped: ${msg} — fix and run /task-auto-resume.`, 'error')
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
    autoRunning = true
    const abort = new AbortController()
    const deps = defaultDeps(ctx, cwd, abort.signal, deriveTitle(raw))
    let id: string | null
    try {
        id = await planAuto(ctx, cwd, raw, deps)
    } catch (err) {
        autoRunning = false
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) {
            announceDone(ctx, '/task-auto cancelled.', 'warning')
            return
        }
        announceDone(ctx, `/task-auto planning failed: ${msg}`, 'error')
        return
    }
    if (!id) {
        autoRunning = false
        return
    }
    // Check for a cancel that was requested during the planning phase before the
    // loop resets the flag.
    if (cancelRequested) {
        cancelRequested = false
        autoRunning = false
        announceDone(ctx, '/task-auto cancelled.', 'warning')
        return
    }
    await runAutoLoop(ctx, cwd, id, deps)
    autoRunning = false
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
    autoRunning = true
    const abort = new AbortController()
    // Resume only runs the loop (runTask); no planning children, so the loader
    // title is unused here — pass the id for clarity if that ever changes.
    await runAutoLoop(ctx, cwd, id, defaultDeps(ctx, cwd, abort.signal, id))
    autoRunning = false
}

// eslint-disable-next-line @typescript-eslint/require-await
async function handleTaskAutoCancel(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!autoRunning) {
        ctx.ui.notify('No /task-auto loop is running.', 'info')
        return
    }
    requestAutoCancel()
    ctx.ui.notify('Stopping /task-auto after the current task…', 'warning')
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerTaskAuto(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-auto', {
        description: 'Plan a feature into tasks and run them. Usage: /task-auto <feature>',
        handler: handleTaskAuto
    })
    registerBridgeCommand(pi, 'task-auto-resume', {
        description: 'Resume the active /task-auto run.',
        handler: handleTaskAutoResume
    })
    registerBridgeCommand(pi, 'task-auto-cancel', {
        description: 'Stop the running /task-auto loop after the current task.',
        handler: handleTaskAutoCancel
    })
}
