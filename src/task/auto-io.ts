/**
 * AUTO-file I/O & parsing for /task-auto.
 *
 * Thin layer over task-io/task-parsers: a TASK_AUTO_NNNN.md is a normal task
 * file (same front matter) whose body holds feature prompt, clarifications, and
 * a markdown checkbox list of task titles. The checkboxes are the resume cursor.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir, ensureTasksDir, readTaskFile, setTaskSection} from './task-io.js'
import {extractSection, parseFrontMatter} from './task-parsers.js'
import {readTextFile} from '../shared/fs-text.js'
import {RESUMABLE_STATES} from './task-types.js'
import type {TaskState} from './task-types.js'
import type {AutoResumeCandidate} from './resume-gap.js'

const AUTO_FILE_RE = /^(TASK_AUTO_\d{4,})\.md$/

export interface TaskEntry {
    index: number
    title: string
    done: boolean
    producedId?: string
}

export async function allocateAutoId(cwd: string): Promise<string> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    let max = 0
    for (const e of entries) {
        const m = AUTO_FILE_RE.exec(e)
        if (m) {
            const n = parseInt(m[1].slice('TASK_AUTO_'.length), 10)
            if (n > max) max = n
        }
    }
    return `TASK_AUTO_${String(max + 1).padStart(4, '0')}`
}

/**
 * Parse a decompose-phase model output into a clean list of titles.
 *
 * No cap: every title the model emits is kept. An arbitrary ceiling (was 30)
 * silently dropped the tail of a large plan AND re-clipped every coverage retry,
 * so a design that genuinely needed >N tasks could never escape the ceiling —
 * it burned its coverage rounds and shipped a knowingly-gapped plan. The real
 * bound on task count is the design's own grounded-requirement scope, enforced
 * downstream by the coverage loop; this parser must not pre-empt it.
 */
export function parseDecomposeList(raw: string): string[] {
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*(?:-\s*\[\s*[xX ]?\s*\]\s*|-\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line)
        if (m && m[1].trim().length > 0) out.push(m[1].trim())
    }
    return out
}

/** Parsed DECOMPOSE_COVERAGE_PROMPT verdict. */
export interface CoverageVerdict {
    kind: 'complete' | 'incomplete'
    missing: string[]
}

/**
 * Parse the coverage-triage child's verdict. Returns null when no COVERAGE tag
 * is present (the model wrote prose) — the caller treats that as "accept the
 * list as-is", so a malformed judgment can never block planning.
 */
export function parseCoverageVerdict(raw: string): CoverageVerdict | null {
    const tag = /^\s*COVERAGE:\s*(COMPLETE|INCOMPLETE)\s*$/im.exec(raw)
    if (!tag) return null
    if (tag[1].toUpperCase() === 'COMPLETE') return {kind: 'complete', missing: []}
    const missing: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*MISSING:\s*(.+?)\s*$/i.exec(line)
        if (m && m[1].length > 0) missing.push(m[1])
        if (missing.length >= 8) break
    }
    // INCOMPLETE with no MISSING lines carries no actionable signal to reprompt
    // with — treat it like an unparseable verdict rather than looping blind.
    return missing.length === 0 ? null : {kind: 'incomplete', missing}
}

const CHECKBOX_RE = /^- \[([ xX])\]\s+(.+?)\s*$/
const PRODUCED_ID_RE = /^(TASK_\d{4,})\s{2,}(.+)$/

/** Parse the "## tasks" checkbox list. */
export function parseTaskList(body: string): TaskEntry[] {
    const section = extractSection(body, 'tasks')
    if (section === null) return []
    const entries: TaskEntry[] = []
    let index = 0
    for (const line of section.split('\n')) {
        const m = CHECKBOX_RE.exec(line.trim())
        if (!m) continue
        const done = m[1].toLowerCase() === 'x'
        const rest = m[2].trim()
        // A line carries a stamped TASK_NNNN id both when done (the completed
        // inner task) and when merely started — an unchecked, stamped line is an
        // in-progress entry whose inner task can be resumed.
        const idm = PRODUCED_ID_RE.exec(rest)
        if (idm) {
            entries.push({index, title: idm[2].trim(), done, producedId: idm[1]})
        } else {
            entries.push({index, title: rest, done})
        }
        index++
    }
    return entries
}

/** Build the initial AUTO-file body. `coverage` is the requirement-level
 *  accounting summary (goal A(c) — a durable, user-visible record of what was
 *  carried cross-cutting and what stayed unowned); '' omits the section. */
export function buildAutoBody(
    feature: string,
    clarifications: string,
    titles: string[],
    coverage = ''
): string {
    const tasks = titles.map(t => `- [ ] ${t}`).join('\n')
    return (
        `\n## feature prompt\n\n${feature.trim() || '(none)'}\n\n`
        + `## clarifications\n\n${clarifications.trim() || '(none)'}\n\n`
        + `## tasks\n\n${tasks}\n`
        + (coverage.trim().length > 0 ? `\n## coverage\n\n${coverage.trim()}\n` : '')
    )
}

/** Rewrite the Nth checkbox line of the "## tasks" section in place. */
async function rewriteTaskLine(
    cwd: string,
    id: string,
    index: number,
    render: () => string,
    label: string
): Promise<void> {
    const {body} = await readTaskFile(cwd, id)
    const section = extractSection(body, 'tasks') ?? ''
    const lines = section.split('\n')
    let seen = -1
    for (let i = 0; i < lines.length; i++) {
        if (!CHECKBOX_RE.test(lines[i].trim())) continue
        seen++
        if (seen === index) {
            lines[i] = render()
            break
        }
    }
    if (seen < index) {
        throw new Error(
            `${label}: index ${index} out of range in ${id} (only ${seen + 1} checkboxes found)`
        )
    }
    await setTaskSection(cwd, id, 'tasks', lines.join('\n'))
}

/** Check off the Nth checkbox line, stamping the produced TASK_NNNN id. */
export async function checkOffTask(
    cwd: string,
    id: string,
    index: number,
    producedId: string,
    title: string
): Promise<void> {
    await rewriteTaskLine(
        cwd,
        id,
        index,
        () => (producedId ? `- [x] ${producedId}  ${title}` : `- [x] ${title}`),
        'checkOffTask'
    )
}

/**
 * Stamp the inner TASK_NNNN id onto the Nth (still-unchecked) entry the moment
 * the inner task is allocated. This links the AUTO entry to its in-progress
 * inner task so /task-auto-resume can continue it from its saved phase instead
 * of starting a brand-new task — matching how /task-resume behaves.
 */
export async function stampTaskInProgress(
    cwd: string,
    id: string,
    index: number,
    producedId: string,
    title: string
): Promise<void> {
    await rewriteTaskLine(
        cwd,
        id,
        index,
        () => `- [ ] ${producedId}  ${title}`,
        'stampTaskInProgress'
    )
}

/** The bare title of a checkbox line (id stamp stripped), or null if not one. */
function entryTitle(line: string): string | null {
    const m = CHECKBOX_RE.exec(line.trim())
    if (!m) return null
    const rest = m[2].trim()
    const idm = PRODUCED_ID_RE.exec(rest)
    return idm ? idm[2].trim() : rest
}

/**
 * Insert a NEW unchecked entry directly after the `afterIndex`th checkbox — the
 * mid-run plan mutation the root-cause repair channel needs: a repair task must
 * land BEFORE the next dependent task, not at the end of the plan, or the defect
 * keeps failing everything in between.
 *
 * MONOTONIC by construction: this only ever
 * SPLICES a line in. No existing entry is rewritten, reordered, or dropped, and
 * an already-present title is a no-op — so a plan can grow mid-run but never
 * shrink, and a retried insert cannot duplicate. Returns whether a line was added.
 *
 * Later entries shift down by one, which is safe because the /task-auto loop
 * re-reads and re-parses the plan at the top of every iteration and locates its
 * next step by "first unchecked" rather than by a cached index.
 */
export async function insertTaskAfter(
    cwd: string,
    id: string,
    afterIndex: number,
    title: string
): Promise<boolean> {
    const clean = title.trim()
    if (clean.length === 0) return false
    const {body} = await readTaskFile(cwd, id)
    const section = extractSection(body, 'tasks') ?? ''
    const lines = section.split('\n')
    // Duplicate check scans the WHOLE list first: an existing entry with this exact
    // title (checked or not) means the plan already carries this step, wherever it
    // sits relative to afterIndex — never add a second one.
    if (lines.some(l => entryTitle(l) === clean)) return false
    let seen = -1
    let insertAt = -1
    for (let i = 0; i < lines.length; i++) {
        if (!CHECKBOX_RE.test(lines[i].trim())) continue
        seen++
        insertAt = i + 1
        if (seen === afterIndex) break
    }
    // An out-of-range index appends after the LAST checkbox rather than throwing:
    // a plan that grew underneath the caller must still receive the entry.
    if (insertAt === -1) return false
    lines.splice(insertAt, 0, `- [ ] ${clean}`)
    await setTaskSection(cwd, id, 'tasks', lines.join('\n'))
    return true
}

/**
 * Find the most-recently-updated resumable TASK_AUTO_* file, with the state and
 * last-write time the resume banner reports (see resume-gap.ts). Null when there
 * is nothing resumable.
 *
 * `states` narrows which states count as resumable, and the UNATTENDED path passes
 * UNATTENDED_STATES so the search answers the question that path actually asks —
 * "is there an IN-FLIGHT run to pick up?". Selecting the newest human-resumable run
 * and only then refusing it on state let one failed run shadow an in-flight one
 * behind it: the boot hook refused every restart and the in-flight run stayed in
 * exactly the dead air this feature exists to end.
 */
export async function findResumableAutoDetailed(
    cwd: string,
    states: readonly TaskState[] = RESUMABLE_STATES
): Promise<AutoResumeCandidate | null> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    const candidates: AutoResumeCandidate[] = []
    for (const f of entries) {
        const m = AUTO_FILE_RE.exec(f)
        if (!m) continue
        try {
            const raw = await readTextFile(path.join(tasksDir(cwd), f))
            const fm = parseFrontMatter(raw)
            if (!fm) continue
            if (!states.includes(fm.state)) continue
            const st = await fsp.stat(path.join(tasksDir(cwd), f))
            candidates.push({id: m[1], state: fm.state, lastWriteMs: st.mtimeMs})
        } catch {
            /* skip unreadable */
        }
    }
    candidates.sort((a, b) => b.lastWriteMs - a.lastWriteMs)
    return candidates.length > 0 ? candidates[0] : null
}

/** Id-only form of {@link findResumableAutoDetailed}. */
export async function findResumableAuto(cwd: string): Promise<string | null> {
    return (await findResumableAutoDetailed(cwd))?.id ?? null
}
