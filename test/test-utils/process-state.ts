import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'

/**
 * Whether `pid` has ended, zombies included: a zombie still answers `kill(pid, 0)`
 * until whoever inherited it reaps, yet it already released its ports. Windows keeps
 * no zombies, so there `kill(pid, 0)` already reads the end.
 */
export function dead(pid: number): boolean {
    if (process.platform === 'linux') {
        let stat: string
        try {
            stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        } catch {
            return true
        }
        // The state follows the LAST ')': the name before it can hold ') Z' itself.
        return /^[ZX]/.test(stat.slice(stat.lastIndexOf(')') + 2))
    }
    if (process.platform === 'darwin') {
        const r = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'})
        if (r.error) throw r.error
        const state = r.stdout.trim()
        return state === '' || state.startsWith('Z')
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
