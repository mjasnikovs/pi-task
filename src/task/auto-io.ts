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

const AUTO_FILE_RE = /^(TASK_AUTO_\d{4,})\.md$/
const MAX_TASKS = 30

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

/** Parse a decompose-phase model output into a clean list of titles. */
export function parseDecomposeList(raw: string): string[] {
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const m = /^\s*(?:-\s*\[\s*[xX ]?\s*\]\s*|-\s+|\d+[.)]\s+)(.+?)\s*$/.exec(line)
        if (m && m[1].trim().length > 0) out.push(m[1].trim())
        if (out.length >= MAX_TASKS) break
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

/** Build the initial AUTO-file body. */
export function buildAutoBody(feature: string, clarifications: string, titles: string[]): string {
    const tasks = titles.map(t => `- [ ] ${t}`).join('\n')
    return (
        `\n## feature prompt\n\n${feature.trim() || '(none)'}\n\n`
        + `## clarifications\n\n${clarifications.trim() || '(none)'}\n\n`
        + `## tasks\n\n${tasks}\n`
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

/** Find the most-recently-updated resumable TASK_AUTO_* file, or null. */
export async function findResumableAuto(cwd: string): Promise<string | null> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    const candidates: Array<{id: string; mtime: number}> = []
    for (const f of entries) {
        const m = AUTO_FILE_RE.exec(f)
        if (!m) continue
        try {
            const raw = await readTextFile(path.join(tasksDir(cwd), f))
            const fm = parseFrontMatter(raw)
            if (!fm) continue
            if (!RESUMABLE_STATES.includes(fm.state)) continue
            const st = await fsp.stat(path.join(tasksDir(cwd), f))
            candidates.push({id: m[1], mtime: st.mtimeMs})
        } catch {
            /* skip unreadable */
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    return candidates.length > 0 ? candidates[0].id : null
}
