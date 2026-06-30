/**
 * Project file inventory — runs `git ls-files` once per /task run so research
 * workers can skip their own discovery loops and jump straight to targeted
 * read/grep on known paths. Returns '' on failure (non-git repo, git missing,
 * timeout) so callers can fall back to the pre-inventory behavior.
 */

import {spawn} from 'node:child_process'
import {TASKS_DIR_NAME} from './task-types.js'

const DEFAULT_MAX_LINES = 2000

/**
 * Drop the committed task directory from the inventory. `git ls-files` lists
 * tracked files regardless of `.ignore`, so once tasks are committed they would
 * otherwise be handed to every research worker (and feed orientation). The user
 * wants tasks committable but invisible to workers and the local model, so we
 * strip `.pi-tasks/` here — the inventory's single chokepoint. (`git ls-files`
 * always emits posix-style paths, so the forward-slash prefix is correct on all
 * platforms.)
 */
export function stripTasksDir(raw: string): string {
    const prefix = `${TASKS_DIR_NAME}/`
    return raw
        .split('\n')
        .filter(l => !l.startsWith(prefix))
        .join('\n')
}

function runGitLsFiles(cwd: string, signal?: AbortSignal): Promise<string> {
    return new Promise(resolve => {
        let stdout = ''
        let proc: ReturnType<typeof spawn>
        try {
            proc = spawn('git', ['ls-files'], {cwd, stdio: ['ignore', 'pipe', 'pipe']})
        } catch {
            resolve('')
            return
        }
        proc.stdout?.on('data', (d: Buffer) => {
            stdout += d.toString()
        })
        proc.on('error', () => resolve(''))
        proc.on('close', code => resolve(code === 0 ? stdout : ''))
        signal?.addEventListener('abort', () => {
            if (!proc.killed) proc.kill('SIGTERM')
        })
    })
}

/** Cap output to maxLines real (non-blank) paths; tag truncation when cut. */
export function capInventory(raw: string, maxLines: number = DEFAULT_MAX_LINES): string {
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    if (lines.length <= maxLines) return lines.join('\n')
    const shown = lines.slice(0, maxLines)
    return `${shown.join('\n')}\n(truncated: ${lines.length - maxLines} more files)`
}

export async function getFileInventory(
    cwd: string,
    signal?: AbortSignal,
    maxLines: number = DEFAULT_MAX_LINES
): Promise<string> {
    const raw = await runGitLsFiles(cwd, signal)
    if (!raw) return ''
    return capInventory(stripTasksDir(raw), maxLines)
}

/**
 * Derive a compact PROJECT STATE block (root-level files + top-level directories)
 * from a raw `git ls-files` listing. Pure/testable; `getProjectSnapshot` wires it
 * to the live repo. Returns '' when there is nothing tracked so the caller omits
 * the block entirely (and the model is then correctly free to treat the target as
 * an empty/greenfield project).
 */
export function formatProjectSnapshot(raw: string): string {
    const lines = stripTasksDir(raw)
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
    const rootFiles = [...new Set(lines.filter(l => !l.includes('/')))].sort()
    const dirs = [...new Set(lines.filter(l => l.includes('/')).map(l => l.split('/')[0]))].sort()
    if (rootFiles.length === 0 && dirs.length === 0) return ''
    return (
        'EXISTING PROJECT STATE (a factual snapshot of the target directory — trust it over '
        + 'assumptions: do NOT assume an empty or greenfield project, do NOT invent directory '
        + 'paths, and do NOT propose creating files that already exist. Treat the config/manifest '
        + "files listed here as the project's established setup unless the request explicitly says "
        + 'to replace them):\n'
        + `Root files: ${rootFiles.join(', ') || '(none)'}\n`
        + `Top-level directories: ${dirs.join(', ') || '(none)'}`
    )
}

/**
 * Live PROJECT STATE snapshot for the planning phase. Clarify otherwise only
 * "may" read the repo; a weak model that skips the read then assumes a greenfield
 * project and recommends creating package.json/tsconfig from scratch — or invents
 * a path like /workspace — even when those configs already exist on disk. Handing
 * it the facts up front removes the guess. Empty (non-git / nothing tracked) ⇒ ''.
 */
export async function getProjectSnapshot(cwd: string, signal?: AbortSignal): Promise<string> {
    const raw = await runGitLsFiles(cwd, signal)
    if (!raw) return ''
    return formatProjectSnapshot(raw)
}
