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
        // Same detach discipline as runChild (GitHub issue #9): `signal` is the
        // run-long orchestrator signal, so a listener left behind by a normally
        // finished `git ls-files` would retain that child for the whole run.
        const onAbort = (): void => {
            if (!proc.killed) proc.kill('SIGTERM')
        }
        let settled = false
        const settle = (value: string): void => {
            signal?.removeEventListener('abort', onAbort)
            if (settled) return
            settled = true
            resolve(value)
        }
        proc.once('error', () => settle(''))
        proc.once('close', code => settle(code === 0 ? stdout : ''))
        if (signal) {
            // An already-aborted signal never emits 'abort', so without this check
            // a run cancelled before this point would let the child run to term.
            if (signal.aborted) onAbort()
            else signal.addEventListener('abort', onAbort, {once: true})
        }
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
