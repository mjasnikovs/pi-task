/**
 * Task file I/O.
 *
 * File read/write operations for the .pi-tasks directory. Depends on
 * task-types.ts (types, constants) and task-parsers.ts (parsing/formatting).
 */

import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {TASKS_DIR_NAME, type TaskFrontMatter} from './task-types.js'
import {emitFrontMatter, parseFrontMatter, sectionRegex} from './task-parsers.js'

// ─── Directory & path helpers ────────────────────────────────────────────────

export function tasksDir(cwd: string): string {
    return path.join(cwd, TASKS_DIR_NAME)
}

export function taskFilePath(cwd: string, id: string): string {
    return path.join(tasksDir(cwd), `${id}.md`)
}

export async function ensureTasksDir(cwd: string): Promise<void> {
    await fsp.mkdir(tasksDir(cwd), {recursive: true})
}

export async function allocateTaskId(cwd: string): Promise<string> {
    await ensureTasksDir(cwd)
    const entries = await fsp.readdir(tasksDir(cwd))
    let max = 0
    for (const e of entries) {
        const m = /^TASK_(\d{4,})\.md$/.exec(e)
        if (m) {
            const n = parseInt(m[1], 10)
            if (n > max) max = n
        }
    }
    return `TASK_${String(max + 1).padStart(4, '0')}`
}

// ─── File read/write ─────────────────────────────────────────────────────────

export async function readTaskFile(
    cwd: string,
    id: string
): Promise<{frontMatter: TaskFrontMatter; body: string}> {
    const raw = await fsp.readFile(taskFilePath(cwd, id), 'utf8')
    const fm = parseFrontMatter(raw)
    if (!fm) throw new Error(`malformed front matter in ${id}.md`)
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '')
    return {frontMatter: fm, body}
}

export async function writeTaskFile(cwd: string, fm: TaskFrontMatter, body: string): Promise<void> {
    await ensureTasksDir(cwd)
    const content = `${emitFrontMatter(fm)}\n${body}`
    await fsp.writeFile(taskFilePath(cwd, fm.id), content, 'utf8')
}

export async function updateTaskFrontMatter(
    cwd: string,
    id: string,
    patch: Partial<TaskFrontMatter>
): Promise<void> {
    const {frontMatter, body} = await readTaskFile(cwd, id)
    const next: TaskFrontMatter = {
        ...frontMatter,
        ...patch,
        updated_at: new Date().toISOString()
    }
    await writeTaskFile(cwd, next, body)
}

// ─── Section read/write (append if absent, rewrite if present) ───────────────

export async function readSection(
    cwd: string,
    id: string,
    heading: string
): Promise<string | null> {
    const {body} = await readTaskFile(cwd, id)
    const m = sectionRegex(heading).exec(body)
    return m ? m[2].trim() : null
}

export async function setTaskSection(
    cwd: string,
    id: string,
    heading: string,
    content: string
): Promise<void> {
    const {frontMatter, body} = await readTaskFile(cwd, id)
    const re = sectionRegex(heading)
    let next: string
    if (re.test(body)) {
        next = body.replace(re, `$1\n${content.trim()}\n\n`)
    } else {
        const sep =
            body.endsWith('\n\n') ? ''
            : body.endsWith('\n') ? '\n'
            : '\n\n'
        next = `${body}${sep}## ${heading}\n\n${content.trim()}\n`
    }
    await writeTaskFile(cwd, {...frontMatter, updated_at: new Date().toISOString()}, next)
}
