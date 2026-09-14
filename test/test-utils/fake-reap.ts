import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from './tmp-dir.js'

let built: string | undefined

/**
 * A compiled executable rather than a shell script: CreateProcess cannot start a
 * script, so only a real binary lets the win32 reap run against the fake on the
 * windows runner too. It logs beside its own path, so every hard link logs apart.
 */
function loggerExecutable(): string {
    if (built) return built
    const dir = tmpDir('fake-taskkill-build-')
    const source = path.join(dir, 'taskkill.ts')
    fs.writeFileSync(
        source,
        [
            "import * as fs from 'node:fs'",
            "import * as path from 'node:path'",
            "const log = path.join(path.dirname(process.execPath), 'calls.log')",
            "fs.appendFileSync(log, `taskkill ${process.argv.slice(2).join(' ')}\\n`)"
        ].join('\n')
    )
    const out = path.join(dir, 'taskkill.exe')
    const r = spawnSync(process.execPath, ['build', '--compile', source, '--outfile', out], {
        encoding: 'utf8'
    })
    if (r.status !== 0) throw new Error(`could not build the fake taskkill: ${r.stderr}`)
    built = out
    return out
}

/**
 * A `%SystemRoot%\System32\taskkill.exe` that logs its argv instead of killing, so
 * the win32 reap runs for real on every host.
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
    const bin = path.join(root, 'System32', 'taskkill.exe')
    const log = path.join(root, 'System32', 'calls.log')
    fs.mkdirSync(path.dirname(bin))
    fs.linkSync(loggerExecutable(), bin)
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

/**
 * Run `fn` with `process.kill` recording. The signal is dropped, so a fake pid never
 * reaches a real group, unless `passThrough` sends it on to real processes.
 */
export async function recordKills(
    fn: () => unknown,
    {passThrough = false}: {passThrough?: boolean} = {}
): Promise<RecordedKill[]> {
    const killed: RecordedKill[] = []
    const realKill = process.kill.bind(process)
    process.kill = ((pid: number, sig?: string | number) => {
        killed.push({pid, sig})
        return passThrough ? realKill(pid, sig) : true
    }) as typeof process.kill
    try {
        await fn()
    } finally {
        process.kill = realKill
    }
    return killed
}
