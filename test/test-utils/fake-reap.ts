import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {tmpDir} from './tmp-dir.js'

let built: string | undefined

/**
 * A compiled executable rather than a shell script: CreateProcess cannot start a
 * script, so only a real binary lets the win32 reap run against the fake on the
 * windows runner too. Each hard link acts by its own name.
 */
function fakeExecutable(): string {
    if (built) return built
    const dir = tmpDir('fake-system32-build-')
    const source = path.join(dir, 'fake.ts')
    fs.writeFileSync(
        source,
        [
            "import * as fs from 'node:fs'",
            "import * as path from 'node:path'",
            // Not SystemRoot: bun's spawnSync hands the child the environment bun started with.
            "const name = path.basename(process.execPath, '.exe')",
            'const here = path.dirname(process.execPath)',
            "const system32 = name === 'powershell' ? path.resolve(here, '..', '..') : here",
            "const log = path.join(system32, 'calls.log')",
            "if (name === 'powershell') {",
            "    fs.appendFileSync(log, 'powershell\\n')",
            "    const table = path.join(system32, 'process-table')",
            '    const answer = () => {',
            '        if (!fs.existsSync(table)) return',
            '        fs.writeSync(1, fs.readFileSync(table))',
            '        process.exit(0)',
            '    }',
            '    fs.watch(system32, answer)',
            '    answer()',
            '} else {',
            "    fs.appendFileSync(log, `${name} ${process.argv.slice(2).join(' ')}\\n`)",
            '}'
        ].join('\n')
    )
    const out = path.join(dir, 'fake.exe')
    const r = spawnSync(process.execPath, ['build', '--compile', source, '--outfile', out], {
        encoding: 'utf8'
    })
    if (r.status !== 0) throw new Error(`could not build the fake System32: ${r.stderr}`)
    built = out
    return out
}

/**
 * A `%SystemRoot%\System32` whose taskkill logs its argv instead of killing, and whose
 * powershell logs that it was asked and answers only with `answerProcessTable`'s
 * rows. So the win32 reap runs for real on every host.
 *
 * `relative` plants it where an empty SystemRoot would resolve: SystemRoot is set
 * to '' and the fake's root becomes the working directory.
 */
export function fakeSystem32({relative = false}: {relative?: boolean} = {}): {
    /** Every taskkill and powershell invocation and `note`, in the order they happened. */
    calls: () => string[]
    note: (line: string) => void
    /** True once powershell was asked for the process table; false if `waiter` settled first. */
    asked: (waiter: Promise<unknown>) => Promise<boolean>
    answerProcessTable: (rows: string) => void
    restore: () => void
} {
    const root = tmpDir('fake-systemroot-')
    const system32 = path.join(root, 'System32')
    const log = path.join(system32, 'calls.log')
    const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    fs.mkdirSync(path.dirname(powershell), {recursive: true})
    fs.linkSync(fakeExecutable(), path.join(system32, 'taskkill.exe'))
    fs.linkSync(fakeExecutable(), powershell)
    const calls = (): string[] =>
        fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
    const answerProcessTable = (rows: string): void => {
        // Renamed into place, so powershell never reads half of it.
        const staged = path.join(root, 'process-table')
        fs.writeFileSync(staged, rows)
        fs.renameSync(staged, path.join(system32, 'process-table'))
    }
    const prevRoot = process.env.SystemRoot
    const prevCwd = process.cwd()
    process.env.SystemRoot = relative ? '' : root
    if (relative) process.chdir(root)
    return {
        calls,
        note: line => fs.appendFileSync(log, `${line}\n`),
        asked: async waiter => {
            let waiterSettled = false
            const stop = (): void => {
                waiterSettled = true
            }
            void waiter.then(stop, stop)
            while (!calls().includes('powershell')) {
                if (waiterSettled) return false
                const started = performance.now()
                await new Promise(resolve => setTimeout(resolve, performance.now() - started))
            }
            return true
        },
        answerProcessTable,
        restore: () => {
            // A powershell still waiting would outlive the test.
            if (!fs.existsSync(path.join(system32, 'process-table'))) answerProcessTable('')
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
