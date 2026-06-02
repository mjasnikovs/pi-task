/**
 * Project file inventory — runs `git ls-files` once per /task run so research
 * workers can skip their own discovery loops and jump straight to targeted
 * read/grep on known paths. Returns '' on failure (non-git repo, git missing,
 * timeout) so callers can fall back to the pre-inventory behavior.
 */

import {spawn} from 'node:child_process'

const DEFAULT_MAX_LINES = 2000

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
    return capInventory(raw, maxLines)
}
