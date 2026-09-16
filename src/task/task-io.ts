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
import {readTextFile} from '../shared/fs-text.js'

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
    // Normalize CRLF/CR → LF at the read boundary: every parser below (front
    // matter, body strip, sectionRegex) assumes '\n'. A Windows/autocrlf file
    // would otherwise fail as "malformed front matter". See shared/fs-text.ts.
    const raw = await readTextFile(taskFilePath(cwd, id))
    const fm = parseFrontMatter(raw)
    if (!fm) throw new Error(`malformed front matter in ${id}.md`)
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    return {frontMatter: fm, body}
}

/**
 * One writer per task file at a time. Research workers in graph mode, the
 * loop-events trail and the gate recorder all rewrite the same file from
 * overlapping continuations; without this, two read-modify-write pairs interleave
 * and the second one erases the first, or a reader catches a half-written file
 * and reports it as malformed front matter.
 */
const fileChains = new Map<string, Promise<unknown>>()

async function withTaskFile<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = fileChains.get(file) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    fileChains.set(
        file,
        next.catch(() => {})
    )
    try {
        return await next
    } finally {
        if (fileChains.get(file) === next) fileChains.delete(file)
    }
}

export async function writeTaskFile(cwd: string, fm: TaskFrontMatter, body: string): Promise<void> {
    await ensureTasksDir(cwd)
    const file = taskFilePath(cwd, fm.id)
    const content = `${emitFrontMatter(fm)}\n${body}`
    // Written beside and renamed over: a reader never sees a truncated file.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
    await fsp.writeFile(tmp, content, 'utf8')
    try {
        await fsp.rename(tmp, file)
    } catch (err) {
        await fsp.rm(tmp, {force: true}).catch(() => {})
        throw err
    }
}

export async function updateTaskFrontMatter(
    cwd: string,
    id: string,
    patch: Partial<TaskFrontMatter>
): Promise<void> {
    await withTaskFile(taskFilePath(cwd, id), async () => {
        const {frontMatter, body} = await readTaskFile(cwd, id)
        const next: TaskFrontMatter = {
            ...frontMatter,
            ...patch,
            updated_at: new Date().toISOString()
        }
        await writeTaskFile(cwd, next, body)
    })
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

export function setTaskSection(
    cwd: string,
    id: string,
    heading: string,
    content: string
): Promise<void> {
    return withTaskFile(taskFilePath(cwd, id), () =>
        rewriteSection(cwd, id, heading, () => content)
    )
}

/** The read-modify-write itself; callers hold the file's chain. */
async function rewriteSection(
    cwd: string,
    id: string,
    heading: string,
    render: (existing: string | null) => string
): Promise<void> {
    const {frontMatter, body} = await readTaskFile(cwd, id)
    const re = sectionRegex(heading)
    const m = re.exec(body)
    const content = render(m ? m[2].trim() : null)
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

/**
 * Rewrite a section from its own current contents.
 *
 * The read-then-write pair a caller would otherwise inline, kept whole here
 * because the RE-ENTRY case is where it goes wrong: a resumed run that reaches a
 * section it did not fully regenerate (an autofix re-entry runs zero phases)
 * calls `setTaskSection` with what THIS pass produced and erases what the first
 * pass proved. `merge` receives null when the section is absent.
 */
export function mergeTaskSection(
    cwd: string,
    id: string,
    heading: string,
    merge: (old: string | null) => string
): Promise<void> {
    return withTaskFile(taskFilePath(cwd, id), () => rewriteSection(cwd, id, heading, merge))
}

/**
 * Append one timestamped line to the task's `## gates` section — the durable
 * per-task trail of gate outcomes (verify verdicts, enforce mode/verdict, commit
 * results). A verdict that lives only in memory and a terminal notify cannot
 * answer "did enforce run for this task, and in which mode?" after the run.
 * Best-effort by design: a failure to record must never break the gate sequence,
 * so all errors are swallowed.
 */
export async function appendGateRecord(cwd: string, id: string, line: string): Promise<void> {
    try {
        const stamp = new Date().toISOString()
        const entry = `- ${stamp} ${line.replace(/\s*\n\s*/g, ' ').trim()}`
        await mergeTaskSection(cwd, id, 'gates', existing =>
            existing ? `${existing}\n${entry}` : entry
        )
    } catch {
        // Recording is observability, not control flow — never propagate.
    }
}

/** Remove a section (heading + body) if present; a no-op when it's absent. */
export function removeTaskSection(cwd: string, id: string, heading: string): Promise<void> {
    return withTaskFile(taskFilePath(cwd, id), async () => {
        const {frontMatter, body} = await readTaskFile(cwd, id)
        const re = sectionRegex(heading)
        if (!re.test(body)) return
        const next = body.replace(re, '')
        await writeTaskFile(cwd, {...frontMatter, updated_at: new Date().toISOString()}, next)
    })
}
