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

/**
 * `.ignore` body written into .pi-tasks/ so pi's discovery tools skip it. fd and
 * ripgrep (the find/grep tools the host model AND the research workers use) honor
 * `.ignore`, but git does NOT — so task files stay committable while no worker or
 * the local model ever surfaces them via search. `*` hides the whole directory's
 * contents; the leading comment explains the file to anyone who opens it. This
 * only affects discovery: pi-task reads task files by direct path (see
 * readTaskFile), which no ignore mechanism intercepts.
 */
const TASKS_IGNORE_BODY =
    '# Keep committed task files out of pi find/grep discovery (host model + '
    + 'research\n# workers) while git still tracks them. .ignore is read by '
    + 'fd/ripgrep, not by\n# git, so tasks stay committable. Managed by pi-task.\n*\n'

/**
 * Create .pi-tasks/ and, if absent, its `.ignore`. The ignore file is written
 * only when missing so a hand-edited one is never clobbered.
 */
export async function ensureTasksDir(cwd: string): Promise<void> {
    const dir = tasksDir(cwd)
    await fsp.mkdir(dir, {recursive: true})
    const ignorePath = path.join(dir, '.ignore')
    try {
        await fsp.access(ignorePath)
    } catch {
        await fsp.writeFile(ignorePath, TASKS_IGNORE_BODY, 'utf8')
    }
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
        // Use a replacer FUNCTION, not a replacement string: `content` is
        // untrusted model output and may contain `$`-sequences (`$\``, `$'`,
        // `$&`, `$1`, `$$`). In a replacement string those are special patterns
        // String.prototype.replace would expand — e.g. a spec line with the
        // regex `^\+[1-9]\d{1,14}$` ends in the literal `` $` `` (dollar +
        // closing backtick), which expands to "everything before the match" and
        // silently mangles/truncates the stored section (dropping ACCEPTANCE /
        // VERIFY), making the spec unrunnable. A function return is literal.
        next = body.replace(re, (_m, p1: string) => `${p1}\n${content.trim()}\n\n`)
    } else {
        const sep =
            body.endsWith('\n\n') ? ''
            : body.endsWith('\n') ? '\n'
            : '\n\n'
        next = `${body}${sep}## ${heading}\n\n${content.trim()}\n`
    }
    await writeTaskFile(cwd, {...frontMatter, updated_at: new Date().toISOString()}, next)
}

/** Remove a section (heading + body) if present; a no-op when it's absent. */
export async function removeTaskSection(cwd: string, id: string, heading: string): Promise<void> {
    const {frontMatter, body} = await readTaskFile(cwd, id)
    const re = sectionRegex(heading)
    if (!re.test(body)) return
    const next = body.replace(re, '')
    await writeTaskFile(cwd, {...frontMatter, updated_at: new Date().toISOString()}, next)
}
