import {test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from './tmp-dir.js'

/** A shell-script taskkill cannot run on win32, and there the real one would find the fake pid. */
export const testOffWin32 = test.skipIf(process.platform === 'win32')

/**
 * A `%SystemRoot%\System32\taskkill.exe` that logs its argv instead of killing, so
 * the win32 reap runs for real on a POSIX host. Pair it with `testOffWin32`.
 *
 * `relative` plants it where an empty SystemRoot would resolve: SystemRoot is set
 * to '' and the fake's root becomes the working directory.
 */
export function fakeTaskkill({relative = false}: {relative?: boolean} = {}): {
    /** Every taskkill invocation and `note`, in the order they happened. */
    calls: () => string[]
    note: (line: string) => void
    restore: () => void
} {
    const root = tmpDir('fake-systemroot-')
    const log = path.join(root, 'calls.log')
    const bin = path.join(root, 'System32', 'taskkill.exe')
    fs.mkdirSync(path.dirname(bin))
    fs.writeFileSync(bin, `#!/bin/sh\necho "taskkill $*" >> "${log}"\n`)
    fs.chmodSync(bin, 0o755)
    const prevRoot = process.env.SystemRoot
    const prevCwd = process.cwd()
    process.env.SystemRoot = relative ? '' : root
    if (relative) process.chdir(root)
    return {
        calls: () =>
            fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
        note: line => fs.appendFileSync(log, `${line}\n`),
        restore: () => {
            process.chdir(prevCwd)
            if (prevRoot === undefined) delete process.env.SystemRoot
            else process.env.SystemRoot = prevRoot
        }
    }
}

export type RecordedKill = {pid: number; sig: string | number | undefined}

/** Run `fn` with `process.kill` recording instead of signalling, so a fake pid never reaches a real group. */
export async function recordKills(fn: () => unknown): Promise<RecordedKill[]> {
    const killed: RecordedKill[] = []
    const realKill = process.kill.bind(process)
    process.kill = ((pid: number, sig?: string | number) => {
        killed.push({pid, sig})
        return true
    }) as typeof process.kill
    try {
        await fn()
    } finally {
        process.kill = realKill
    }
    return killed
}
