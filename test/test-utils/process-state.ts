import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'

/**
 * Read from the kernel, not from `kill(pid, 0)`: a zombie still answers that until
 * whoever inherited it reaps, yet it already released its ports and its environment.
 */
export function dead(pid: number): boolean {
    if (process.platform === 'linux') {
        try {
            return /\) [ZX]/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))
        } catch {
            return true
        }
    }
    if (process.platform === 'darwin') {
        const r = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], {encoding: 'utf8'})
        return r.stdout.trim() === '' || r.stdout.trim().startsWith('Z')
    }
    try {
        process.kill(pid, 0)
        return false
    } catch {
        return true
    }
}
