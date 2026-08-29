/**
 * /task-plan — plan ONE task with the model, then hand it to /task.
 *
 * The command is a thin wiring layer. Everything it does is already in the
 * codebase and is reused as-is:
 *
 *   • the question loop, the duplicate backstop and the A/B answer mapping
 *                              → plan-session.ts, via question-source.ts (which
 *                                uses parsers.ts and question-dedup.ts),
 *                                question-dialog.ts, inline-markdown.ts, yolo.ts
 *   • the child process, its loop/leak/stall guards and retries → child-runner.ts
 *   • local TUI + remote browser prompt fan-out, and the boxed
 *     picker the TUI half renders                              → remote/bridge.ts
 *   • the status widget                 → child-status.ts, which drives widget.ts
 *   • the plan file (.pi-tasks/TASK_PLAN_NNNN.md)               → task-io.ts
 *   • the handoff itself                                        → orchestrator.ts
 *
 * The handoff is deliberately the SAME call /task makes for a typed prompt —
 * gated when `verify work` / `enforce guidelines` is on, fire-and-forget
 * otherwise — so a planned task is not a second kind of task. What /task
 * receives beyond a bare /task is HANDOFF_DELIVERABLE_RULE, which rides on every
 * handoff, and the decisions block when anything was settled.
 */

import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {prependHint, USER_CANCELLED, type PhaseDeps} from './child-runner.js'
import {PLAN_QUESTION_PROMPT, PLAN_ANSWER_PROMPT} from './plan-prompts.js'
import {
    runPlanSession,
    type PlanSessionDeps,
    type PlanAskSpec,
    type PlanOutcome,
    ASK_TITLE
} from './plan-session.js'
import {
    allocatePlanId,
    buildPlanBody,
    buildHandoffPrompt,
    formatPlanDecisions,
    type PlanEntry
} from './plan-io.js'
import {
    writeTaskFile,
    readTaskFile,
    setTaskSection,
    readSection,
    updateTaskFrontMatter,
    taskFilePath,
    tasksDir
} from './task-io.js'
import {extractSection} from './task-parsers.js'
import {collectTreeChanges} from './gate-deps.js'
import type {TreeChangeSummary} from './write-guard.js'
import {
    PLAN_TOOLS,
    newTreeChanges,
    isEmptyChange,
    formatReadOnlyViolation
} from './plan-readonly.js'
import type {TaskFrontMatter} from './task-types.js'
import {deriveTitle} from './parsers.js'
import {renderInlineMarkdown} from './inline-markdown.js'
import {expandFeatureMentions} from './auto-orchestrator.js'
import {runSingleTask, runGatedTask} from './orchestrator.js'
import {
    SessionUI,
    publishViewer,
    publishLifecycleNotice,
    registerBridgeCommand
} from '../remote/bridge.js'
import {withRun, announceTerminal} from './run-bracket.js'
import {getConfig} from '../config/config.js'
import {isYoloMode} from './yolo.js'
import {gateDebugWriter} from './debug-log.js'
import {getParentContextWindow} from './context-usage.js'
import {ChildStatus, runPlanningChild, statusCallbacks} from './child-status.js'
import * as fsp from 'node:fs/promises'

/** Loader labels for the two planning children. */
const PLAN_STEPS: Record<string, string> = {
    'plan-question': 'question',
    'plan-answer': 'answering you'
}

/**
 * Build the session deps around a live command ctx: children with a status
 * loader, prompts fanned out to the terminal AND any remote viewer, and the plan
 * file rewritten after every entry.
 */
export function buildPlanDeps(
    ctx: ExtensionCommandContext,
    cwd: string,
    planId: string,
    task: string,
    signal: AbortSignal
): PlanSessionDeps {
    const ui = new SessionUI(ctx)
    const theme = ctx.ui.theme
    let status: string | undefined
    const childStatus = new ChildStatus({parentContextWindow: getParentContextWindow(ctx)})
    const title = deriveTitle(task)

    const logDebug = gateDebugWriter((msg: string) => {
        const line = `${new Date().toISOString()} ${msg}\n`
        void fsp.appendFile(path.join(tasksDir(cwd), `${planId}-debug.log`), line).catch(() => {})
    })

    const phaseDeps: PhaseDeps = {
        cwd,
        taskId: planId,
        signal,
        ...statusCallbacks(childStatus),
        ...(logDebug && {logDebug})
    }

    /**
     * Run a planning child under the shared /task-auto-style loader, with the
     * read-only contract enforced around it: the child gets exactly
     * {@link PLAN_TOOLS}, and the working tree is compared before and after so a
     * hole in that prevention is reported instead of shipped silently. The
     * comparison excludes `.pi-tasks/` (collectTreeChanges does), which is where
     * the plan file itself is written.
     */
    const child = async (name: string, prompt: string): Promise<string> => {
        const before = await collectTreeChanges(cwd, signal).catch(() => null)
        try {
            return await runPlanningChild({
                ctx,
                status: childStatus,
                phaseDeps,
                name,
                tools: PLAN_TOOLS,
                prompt,
                loader: {
                    command: '/task-plan',
                    title,
                    step: n => ({step: status ?? PLAN_STEPS[n] ?? n, stepNum: 1, stepTotal: 1})
                }
            })
        } finally {
            // `before` is null only when the snapshot itself failed, and there
            // is then nothing to compare against. A non-repo cwd does NOT take
            // that path: `git status` exits 128 and collectTreeChanges answers an
            // empty summary, so the comparison runs and finds nothing.
            if (before) {
                const after = await collectTreeChanges(cwd, signal).catch(() => null)
                const touched = after ? newTreeChanges(before, after) : null
                if (touched && !isEmptyChange(touched)) {
                    await reportReadOnlyViolation(ctx, cwd, planId, name, touched, logDebug)
                }
            }
        }
    }

    return {
        generateQuestion: (priorQA, hint) =>
            child('plan-question', prependHint(hint, PLAN_QUESTION_PROMPT(task, priorQA))),
        answerUserQuestion: (priorQA, question) =>
            child('plan-answer', PLAN_ANSWER_PROMPT(task, priorQA, question)),
        ask: (spec: PlanAskSpec) => ui.ask(spec),
        promptText: (localTitle, question) =>
            ui.ask({
                localTitle,
                question,
                // No recommendation and no options: both surfaces fall back to
                // their plain text input, which is exactly what "type your
                // question" needs. Skip = changed my mind.
                allowSkip: true
            }),
        showAnswer: async (question, answer) => {
            const text = `You asked:\n${question}\n\n${answer}\n`
            publishViewer(ASK_TITLE, text)
            await ctx.ui.editor(ASK_TITLE, text)
        },
        onEntries: async entries => {
            await persistEntries(cwd, planId, entries)
        },
        renderMarkdown: (s: string) => renderInlineMarkdown(s, theme),
        setStatus: line => {
            status = line
        },
        yolo: isYoloMode(),
        ...(logDebug && {logDebug})
    }
}

/**
 * A planning step touched the project: say so on every surface and write it into
 * the plan file, which is the one record that outlives the session.
 *
 * Deliberately NOT a rollback. If this ever fires, something wrote a file we
 * cannot account for; deleting it unseen would turn a reporting bug into data
 * loss. The user gets the path and decides.
 */
async function reportReadOnlyViolation(
    ctx: ExtensionCommandContext,
    cwd: string,
    planId: string,
    step: string,
    touched: TreeChangeSummary,
    logDebug?: (msg: string) => void
): Promise<void> {
    const line = formatReadOnlyViolation(step, touched)
    logDebug?.(line)
    try {
        ctx.ui.notify(line, 'error')
    } catch {
        /* stale ctx — the record below is what matters */
    }
    publishLifecycleNotice(line, 'error')
    try {
        const existing = (await readSection(cwd, planId, 'read-only violations')) ?? ''
        await setTaskSection(
            cwd,
            planId,
            'read-only violations',
            existing ? `${existing}\n- ${line}` : `- ${line}`
        )
    } catch {
        /* best-effort */
    }
}

/**
 * Write the transcript into the plan file. The decisions and the model's answers
 * to the user's questions live in separate sections: only the decisions are
 * authoritative for the implementation, and the file must not blur that.
 */
export async function persistEntries(
    cwd: string,
    planId: string,
    entries: readonly PlanEntry[]
): Promise<void> {
    const decisions = entries.filter(e => e.kind !== 'note')
    const notes = entries.filter(e => e.kind === 'note')
    await setTaskSection(cwd, planId, 'decisions', formatPlanDecisions(decisions))
    if (notes.length > 0) {
        await setTaskSection(
            cwd,
            planId,
            'notes',
            notes
                .map(n => (n.kind === 'note' ? `Q: ${n.question}\nA: ${n.answer}` : ''))
                .join('\n\n')
        )
    }
}

/**
 * Seams the command flow needs from the outside world. Defaulted to the real
 * thing in {@link handleTaskPlan}; injected in tests so the whole flow — plan
 * file, transcript, handoff prompt — can be exercised without a model or a
 * session replacement.
 */
export interface PlanCommandDeps {
    /** Build the session deps (children + dialogs) for this run. */
    session(
        ctx: ExtensionCommandContext,
        cwd: string,
        planId: string,
        task: string,
        signal: AbortSignal
    ): PlanSessionDeps
    /** Run the loop. */
    run(deps: PlanSessionDeps): Promise<PlanOutcome>
    /** Hand the composed prompt to /task. Returns the produced task id, if any. */
    handoff(ctx: ExtensionCommandContext, cwd: string, prompt: string): Promise<string | undefined>
}

/**
 * The default handoff: EXACTLY what `/task <prompt>` does with a typed prompt —
 * gated when `verify work` / `enforce guidelines` is on, fire-and-forget
 * otherwise. A planned task must not be a second kind of task.
 */
async function defaultHandoff(
    ctx: ExtensionCommandContext,
    cwd: string,
    prompt: string
): Promise<string | undefined> {
    const cfg = getConfig()
    if (cfg.verifyWork || cfg.enforceGuidelines) {
        // runGatedTask owns the whole gated sequence and reports its own outcome;
        // it does not surface the inner task id, so the plan file records the
        // handoff without one.
        await runGatedTask(ctx, cwd, prompt)
        return undefined
    }
    const {taskId, end} = await runSingleTask(ctx, cwd, prompt, {notifyFinish: true})
    if (end.kind === 'no-session') {
        ctx.ui.notify('Could not start a fresh session for /task-plan.', 'warning')
        return undefined
    }
    return taskId || undefined
}

const DEFAULT_COMMAND_DEPS: PlanCommandDeps = {
    session: buildPlanDeps,
    run: runPlanSession,
    handoff: defaultHandoff
}

/**
 * Remove the plan file (and its debug log) when the session ended with nothing
 * in it — the user opened /task-plan and backed out at the first question.
 *
 * The file is allocated up front so a crash mid-session still leaves the record,
 * which means an abandoned session would otherwise leave a stub whose whole
 * content is "(none yet)". That is exactly the artifact this command is not
 * supposed to produce.
 *
 * It refuses to delete anything that carries a read-only violation: that section
 * is the report of a file we could not account for, and it must outlive the
 * session that found it. Best-effort — a failure here leaves the stub, which is
 * harmless.
 */
export async function discardEmptyPlanFile(cwd: string, planId: string): Promise<void> {
    try {
        const {body} = await readTaskFile(cwd, planId)
        if (extractSection(body, 'read-only violations') !== null) return
        const decisions = extractSection(body, 'decisions')
        if (decisions !== null && decisions.trim() !== '(none yet)') return
        if (extractSection(body, 'notes') !== null) return
        await fsp.rm(taskFilePath(cwd, planId), {force: true})
        await fsp.rm(path.join(tasksDir(cwd), `${planId}-debug.log`), {force: true})
    } catch {
        /* best-effort: an unreadable file is left exactly where it is */
    }
}

export async function handleTaskPlan(
    args: string,
    ctx: ExtensionCommandContext,
    commandDeps: PlanCommandDeps = DEFAULT_COMMAND_DEPS
): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    const raw = args.trim()
    if (raw.length === 0) {
        ctx.ui.setEditorText('/task-plan ')
        ctx.ui.notify('Describe the task after /task-plan (use @ for file completion).', 'info')
        return
    }

    // Inline any @file the user referenced, exactly as /task-auto's planner does:
    // a one-line "Implement @spec.md" reads as trivial to a model that cannot see
    // the file, and the first question comes out useless.
    const task = await expandFeatureMentions(cwd, raw)

    const planId = await allocatePlanId(cwd)
    const now = new Date().toISOString()
    const fm: TaskFrontMatter = {
        id: planId,
        state: 'in_progress',
        // Plan files have no phase pipeline of their own — same as TASK_AUTO_*,
        // which parks at 'done' so the phase progress bar never claims otherwise.
        phase: 'done',
        created_at: now,
        updated_at: now,
        title: deriveTitle(raw)
    }
    await writeTaskFile(cwd, fm, buildPlanBody(task))

    // The plan session owns the session the way a run does: its children run
    // with the host idle, so an unbracketed line typed then went into pi's queue
    // (terminal) or started a competing turn (browser) — the issue #8 shape.
    // /task-auto brackets its planning for the same reason; this one was left
    // out when /task-plan landed. Held lines reach the handed-off /task run's
    // first turn (the bracket nests), or are reported when the plan ends without
    // one. No onCancel: /task-auto-cancel is not this command's to acknowledge.
    await withRun(ctx, {}, () => runPlanCommand(ctx, cwd, planId, task, commandDeps))
}

async function runPlanCommand(
    ctx: ExtensionCommandContext,
    cwd: string,
    planId: string,
    task: string,
    commandDeps: PlanCommandDeps
): Promise<void> {
    const abort = new AbortController()

    let outcome: PlanOutcome
    try {
        outcome = await commandDeps.run(commandDeps.session(ctx, cwd, planId, task, abort.signal))
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await updateTaskFrontMatter(cwd, planId, {
            state: msg === USER_CANCELLED ? 'cancelled' : 'failed',
            reason: msg.slice(0, 200)
        }).catch(() => {})
        // No push: a plan is a conversation, not a task; the run it hands off
        // to pushes its own ending.
        announceTerminal(ctx, `${planId} stopped — ${msg.slice(0, 160)}`, 'error', {push: false})
        return
    }

    if (outcome.kind === 'cancelled') {
        // Whatever WAS decided stays on disk — a cancelled plan is a record, not
        // a rollback. A session that decided NOTHING leaves nothing at all.
        await updateTaskFrontMatter(cwd, planId, {state: 'cancelled'}).catch(() => {})
        if (outcome.entries.length === 0) await discardEmptyPlanFile(cwd, planId)
        const line =
            outcome.entries.length === 0 ?
                `${planId} cancelled — nothing planned.`
            :   `${planId} cancelled — ${outcome.entries.length} entr${outcome.entries.length === 1 ? 'y' : 'ies'} kept in .pi-tasks/${planId}.md`
        announceTerminal(ctx, line, 'warning', {push: false})
        return
    }

    const prompt = buildHandoffPrompt(task, outcome.entries)
    const decisions = outcome.entries.filter(e => e.kind !== 'note').length
    await setTaskSection(
        cwd,
        planId,
        'handoff',
        `handoff_at: ${new Date().toISOString()}\ndecisions: ${decisions}`
    ).catch(() => {})
    await updateTaskFrontMatter(cwd, planId, {state: 'completed'}).catch(() => {})

    const taskId = await commandDeps.handoff(ctx, cwd, prompt)
    if (taskId) {
        // Stamped after the fact: this is the one link from the plan to the task
        // it produced, and /task allocates the id only once its own run starts.
        await setTaskSection(
            cwd,
            planId,
            'handoff',
            `handoff_at: ${new Date().toISOString()}\ndecisions: ${decisions}\ntask: ${taskId}`
        ).catch(() => {})
    }
}

export function registerTaskPlan(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-plan', {
        description:
            'Plan one task with the model — it asks, you answer (or ask it something, or '
            + 'proceed) — then hand the decisions to /task. Usage: /task-plan <prompt>',
        handler: handleTaskPlan
    })
}
