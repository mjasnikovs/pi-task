/**
 * PLAN-file I/O & transcript formatting for /task-plan.
 *
 * A TASK_PLAN_NNNN.md is a normal task file — same front matter, same section
 * machinery (task-io.ts) — whose body holds the task prompt and the planning
 * transcript. This mirrors auto-io.ts, which does exactly the same thing for
 * /task-auto's TASK_AUTO_NNNN.md; nothing about the file format is new here.
 *
 * The transcript is the whole point of the command: it is what rides into /task
 * as the handoff prompt, and it is what a human reads afterwards to see which
 * decisions were made and who made them.
 */
import * as fsp from 'node:fs/promises'
import {tasksDir, ensureTasksDir} from './task-io.js'

const PLAN_FILE_RE = /^(TASK_PLAN_\d{4,})\.md$/

/** Next free TASK_PLAN_NNNN id. Mirrors allocateAutoId. */
export async function allocatePlanId(cwd: string): Promise<string> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    let max = 0
    for (const e of entries) {
        const m = PLAN_FILE_RE.exec(e)
        if (m) {
            const n = parseInt(m[1].slice('TASK_PLAN_'.length), 10)
            if (n > max) max = n
        }
    }
    return `TASK_PLAN_${String(max + 1).padStart(4, '0')}`
}

// ─── Transcript entries ──────────────────────────────────────────────────────

/**
 * How an answer to a model question was produced. Recorded verbatim in the plan
 * file because "the user chose this" and "the recommendation was accepted by
 * default" are different levels of evidence when you read the plan back later —
 * the same distinction /task-auto draws with its "(accepted recommendation)" and
 * "(YOLO)" stamps.
 */
export type AnswerSource = 'chosen' | 'accepted' | 'typed' | 'skipped' | 'yolo'

export type PlanEntry =
    /** The model asked; the user answered. */
    | {kind: 'decision'; question: string; answer: string; source: AnswerSource}
    /** The user volunteered a decision without being asked. */
    | {kind: 'stated'; text: string}
    /** The user asked; the model answered. Advisory — decides nothing on its own. */
    | {kind: 'note'; question: string; answer: string}

const SOURCE_STAMP: Record<AnswerSource, string> = {
    chosen: '',
    accepted: ' (accepted recommendation)',
    typed: '',
    skipped: '',
    yolo: ' (YOLO)'
}

/**
 * The transcript as the MODEL sees it — fed back as `priorQA` on every next
 * question, and prepended to the handoff prompt. Decisions are numbered so a
 * later question can refer to one; notes and stated decisions are labelled by who
 * said them, because a model answer the user merely READ must not be mistaken for
 * a decision the user MADE.
 */
export function formatPlanTranscript(entries: readonly PlanEntry[]): string {
    const lines: string[] = []
    let n = 0
    for (const e of entries) {
        if (e.kind === 'decision') {
            n++
            lines.push(`Q${n}: ${e.question}`)
            lines.push(`A${n}: ${e.answer}${SOURCE_STAMP[e.source]}`)
        } else if (e.kind === 'stated') {
            lines.push(`DECIDED BY USER: ${e.text}`)
        } else {
            lines.push(`THE USER ASKED: ${e.question}`)
            lines.push(`YOU ANSWERED: ${e.answer}`)
        }
    }
    return lines.join('\n')
}

/** Body of a fresh plan file, before any entry is recorded. */
export function buildPlanBody(task: string): string {
    return `\n## task prompt\n\n${task.trim() || '(none)'}\n\n## decisions\n\n(none yet)\n`
}

/**
 * The `## decisions` section: the human-readable transcript. Same content as
 * {@link formatPlanTranscript} — the model and the reader see the same record, so
 * there is no hidden channel.
 */
export function formatPlanDecisions(entries: readonly PlanEntry[]): string {
    return entries.length === 0 ? '(none yet)' : formatPlanTranscript(entries)
}

/**
 * The line that pins the DELIVERABLE, and it is not optional.
 *
 * The task prompt leads the handoff verbatim, and users reach /task-plan by
 * phrasing the request as planning — live (aiz-client TASK_PLAN_0001,
 * 2026-08-05): "Lets plan new tab and report @src/app/reports/". /task's refine
 * read the verb as the deliverable and produced a task titled "Plan the addition
 * of a new sub-tab…", whose ACCEPTANCE was "a planning document exists with
 * placeholder sections" and whose VERIFY asserted that no `.ts`/`.tsx` file had
 * changed. It passed. Nothing was built.
 *
 * Planning already happened — this prompt IS its output — so the handoff says so
 * rather than letting the request's own wording re-open it. It rides on every
 * handoff, decisions or none: the verb leaks regardless of how much got settled.
 */
export const HANDOFF_DELIVERABLE_RULE =
    'PLANNING IS ALREADY DONE. This prompt is the OUTPUT of an interactive planning session '
    + 'that has now ended; you are the implementation step. Build the thing. Do not produce a '
    + 'plan, a design, a proposal, or a "planning-only" deliverable, do not write a document '
    + 'whose acceptance is that no code changed, and do not defer the work pending user '
    + 'confirmation — no user is available from here on.'

/**
 * The prompt handed to /task when the user proceeds to execution.
 *
 * The task prompt leads, exactly as a bare `/task <prompt>` would, so refine sees
 * a normal task description first; the deliverable rule and then the decisions
 * follow as an authoritative block. Anything the user did NOT settle is simply
 * absent — /task's own grill phase asks about what is left, which is why this
 * block never invents a decision to fill a gap. A question the user left
 * unanswered is likewise absent: "(skipped)" is not a decision, and carrying it
 * as one is how a non-answer becomes an instruction.
 */
export function buildHandoffPrompt(task: string, entries: readonly PlanEntry[]): string {
    const decisions = entries.filter(
        e => e.kind !== 'note' && !(e.kind === 'decision' && /^\(skipped/i.test(e.answer.trim()))
    )
    const head = `${task.trim()}\n\n${HANDOFF_DELIVERABLE_RULE}`
    if (decisions.length === 0) return head
    return (
        `${head}\n\n`
        + `PLANNING DECISIONS — these were settled with the user before this task was started. `
        + `They are authoritative: implement them as written, and do not re-open or contradict `
        + `them. They may not cover everything; decide anything they leave open as usual.\n\n`
        + `${formatPlanTranscript(decisions)}`
    )
}
