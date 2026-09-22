import {darwinSample, linuxSample} from '../../src/shared/leftovers.js'

/**
 * Whether `pid` has ended, zombies included: a zombie still answers `kill(pid, 0)`
 * until whoever inherited it reaps, yet it already released its ports. Windows keeps
 * no zombies, so there `kill(pid, 0)` already reads the end.
 */
export function dead(pid: number): boolean {
    // The same reading the reap follows a leftover with, so the two cannot disagree.
    if (process.platform === 'linux' || process.platform === 'darwin') {
        const row = process.platform === 'linux' ? linuxSample(pid) : darwinSample(pid)
        if (row === 'unknown') throw new Error(`the process table would not answer for ${pid}`)
        return row === 'gone' || row.ended
    }
    if (process.platform !== 'win32') {
        throw new Error(`no zombie-aware process state on ${process.platform}`)
    }
    try {
        process.kill(pid, 0)
        return false
    } catch {
        return true
    }
}

/** Resolves once `pid` has ended. Each check waits as long as the last one took. */
export async function gone(pid: number): Promise<void> {
    for (;;) {
        const started = performance.now()
        if (dead(pid)) return
        await new Promise(resolve => setTimeout(resolve, performance.now() - started))
    }
}
