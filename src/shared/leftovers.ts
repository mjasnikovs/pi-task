/**
 * leftovers — what a model child started that is still running after it ended.
 *
 * A process-group reap misses it. pi's bash tool starts every command detached, in
 * a group of its own, so a server a command backgrounds is in no group of the
 * child's; on win32 the tree it hung from is gone once its shell exits. Measured
 * with pi's own bash tool: the server outlived the group reap and `taskkill /T`,
 * of the exited child and of the live one, on linux and on the windows runner.
 *
 * So descendants are found by what they inherit. On linux and darwin that is an
 * environment token, read back from the process table. Windows cannot read another
 * process's environment, so there `BASH_ENV` has every bash the child runs record
 * its pid and lifetime, and whatever those shells started is found by parent pid.
 */
import {spawn, spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const LEFTOVER_TOKEN_ENV = 'PI_TASK_LEFTOVER_TOKEN'
const SHELL_REGISTRY_ENV = 'PI_TASK_SHELL_REGISTRY'
const USER_BASH_ENV = 'PI_TASK_USER_BASH_ENV'

export interface Leftovers {
    /** The environment to spawn the child with. */
    env: NodeJS.ProcessEnv
    /** End whatever the child left running. Never rejects. */
    reap: () => Promise<void>
}

/** Start tracking a child about to be spawned with `base` as its environment. */
export function trackLeftovers(
    platform: NodeJS.Platform,
    base: NodeJS.ProcessEnv,
    graceMs: number
): Leftovers {
    if (platform === 'win32') return trackShells(base, graceMs)
    if (platform === 'linux' || platform === 'darwin') return trackToken(platform, base, graceMs)
    return {env: base, reap: () => Promise.resolve()}
}

/**
 * A System32 executable by absolute path, so neither PATH nor the working directory
 * can supply another. `||`, not `??`: an empty SystemRoot would make it relative.
 */
export function system32(...segments: string[]): string {
    return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', ...segments)
}

// ─── linux, darwin: the environment token ───────────────────────────────────

function trackToken(
    platform: 'linux' | 'darwin',
    base: NodeJS.ProcessEnv,
    graceMs: number
): Leftovers {
    const token = randomUUID()
    const marker = `${LEFTOVER_TOKEN_ENV}=${token}`
    const find = (): number[] =>
        platform === 'linux' ? linuxPidsWith(marker) : pidsInPsTable(darwinPsTable(), marker)
    return {
        env: {...base, [LEFTOVER_TOKEN_ENV]: token},
        reap: () =>
            new Promise(resolve => {
                const started = performance.now()
                let killed = false
                signalEach(find(), 'SIGTERM')
                // Found again on every pass, never remembered: a pid that died in
                // the grace period may already be someone else's. Each pass waits
                // as long as the scan before it took, so the wait costs half a core
                // at most and no invented interval.
                const poll = (): void => {
                    const scanStart = performance.now()
                    const left = find()
                    const waited = performance.now() - started
                    // A process SIGKILL cannot end (uninterruptible sleep) gets one
                    // more grace, then the run goes on without it.
                    if (left.length === 0 || waited >= 2 * graceMs) return resolve()
                    if (!killed && waited >= graceMs) {
                        signalEach(left, 'SIGKILL')
                        killed = true
                    }
                    setTimeout(poll, performance.now() - scanStart).unref()
                }
                poll()
            })
    }
}

/** Pids whose environment holds `marker`, read from `<procRoot>/<pid>/environ`. */
export function linuxPidsWith(marker: string, procRoot = '/proc'): number[] {
    const inner = Buffer.from(`\0${marker}\0`)
    const first = Buffer.from(`${marker}\0`)
    let names: string[]
    try {
        names = fs.readdirSync(procRoot)
    } catch {
        return []
    }
    const pids: number[] = []
    for (const name of names) {
        if (!/^\d+$/.test(name)) continue
        try {
            const environ = fs.readFileSync(path.join(procRoot, name, 'environ'))
            if (environ.includes(inner) || environ.subarray(0, first.length).equals(first)) {
                pids.push(Number(name))
            }
        } catch {
            // exited meanwhile, or not ours to read
        }
    }
    return pids
}

/** darwin's `ps -E` appends each process's environment to its command line. */
function darwinPsTable(): string {
    const r = spawnSync('/bin/ps', ['-Aww', '-o', 'pid=,ppid=,pgid=,lstart=,command=', '-E'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    })
    return r.stdout ?? ''
}

/** Pids of the `ps -E` rows that carry `marker`. The pid is each row's first field. */
export function pidsInPsTable(table: string, marker: string): number[] {
    return table
        .split('\n')
        .filter(row => row.includes(marker))
        .map(row => Number.parseInt(row, 10))
        .filter(pid => pid > 0)
}

function signalEach(pids: number[], sig: NodeJS.Signals): number {
    let sent = 0
    for (const pid of pids) {
        try {
            process.kill(pid, sig)
            sent++
        } catch {
            // already gone
        }
    }
    return sent
}

// ─── win32: the shells `BASH_ENV` recorded ──────────────────────────────────

/**
 * Sourced by every bash the child starts, after the user's own BASH_ENV so that one
 * cannot replace the exit trap. Builtins only: a fork costs tens of milliseconds
 * under MSYS. `/proc/$$/winpid` maps MSYS's pid to the Windows one.
 */
export const BASH_ENV_SCRIPT = [
    `if [ -n "\${${USER_BASH_ENV}:-}" ]; then . "$${USER_BASH_ENV}"; fi`,
    '__pi_task_winpid=$$',
    'if [ -r /proc/$$/winpid ]; then read -r __pi_task_winpid < /proc/$$/winpid; fi',
    // EPOCHREALTIME is bash 5.0; bash 4 has whole seconds, so the run is read at
    // the start of its second and the exit at the end of it.
    '__pi_task_now() { if [ -n "${EPOCHREALTIME:-}" ]; then __pi_task_t=$EPOCHREALTIME; else printf -v __pi_task_t "%(%s)T" -1; __pi_task_t="$((__pi_task_t + $1)).000000"; fi; }',
    `__pi_task_now 0; printf 'ran %s %s\\n' "$__pi_task_winpid" "$__pi_task_t" >> "$${SHELL_REGISTRY_ENV}"`,
    `trap '__pi_task_now 1; printf "exited %s %s\\n" "$__pi_task_winpid" "$__pi_task_t" >> "$${SHELL_REGISTRY_ENV}"' EXIT`,
    ''
].join('\n')

function trackShells(base: NodeJS.ProcessEnv, graceMs: number): Leftovers {
    let dir: string
    try {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-task-shells-'))
        fs.writeFileSync(path.join(dir, 'bash-env.sh'), BASH_ENV_SCRIPT)
    } catch {
        return {env: base, reap: () => Promise.resolve()}
    }
    const registry = path.join(dir, 'shells')
    const env: NodeJS.ProcessEnv = {
        ...base,
        BASH_ENV: forwardSlashes(path.join(dir, 'bash-env.sh')),
        [SHELL_REGISTRY_ENV]: forwardSlashes(registry)
    }
    if (base.BASH_ENV) env[USER_BASH_ENV] = base.BASH_ENV
    return {
        env,
        reap: async () => {
            try {
                const shells = parseShells(
                    fs.existsSync(registry) ? fs.readFileSync(registry, 'utf8') : ''
                )
                if (shells.length === 0) return
                const table = await processTable(graceMs)
                const started = startedByShells(parseProcessTable(table), shells)
                await Promise.all(started.map(taskkillTree))
            } catch {
                // best-effort, like every other reap
            }
            try {
                fs.rmSync(dir, {recursive: true, force: true})
            } catch {
                // a handle still open in there; the run must not wait on it
            }
        }
    }
}

/** Git Bash reads MSYS paths; forward slashes are the spelling both sides accept. */
function forwardSlashes(p: string): string {
    return p.replace(/\\/g, '/')
}

/** A shell the registry recorded: its Windows pid and when it ran, as FILETIMEs. */
export interface Shell {
    pid: number
    ranAt: bigint
    /** Absent when the shell was killed, exec'd into its command, or is still running. */
    exitedAt?: bigint
}

/** FILETIME counts 100ns ticks from 1601; the Unix epoch is this many ticks in. */
const UNIX_EPOCH_FILETIME = 116_444_736_000_000_000n

/** `EPOCHREALTIME` as a FILETIME. Its decimal mark follows bash's locale. */
function filetimeOf(epochRealtime: string): bigint | undefined {
    const m = /^(\d+)[.,](\d{6})$/.exec(epochRealtime)
    return m ? (BigInt(m[1]!) * 1_000_000n + BigInt(m[2]!)) * 10n + UNIX_EPOCH_FILETIME : undefined
}

/** Rows are `ran <pid> <time>` and `exited <pid> <time>`. Each exit closes its pid's latest run. */
export function parseShells(text: string): Shell[] {
    const shells: Shell[] = []
    for (const row of text.split('\n')) {
        const m = /^(ran|exited) (\d+) (\S+)$/.exec(row.trim())
        const at = m ? filetimeOf(m[3]!) : undefined
        if (!m || at === undefined) continue
        const pid = Number(m[2])
        if (m[1] === 'ran') {
            shells.push({pid, ranAt: at})
        } else {
            const open = shells.findLast(s => s.pid === pid && s.exitedAt === undefined)
            if (open) open.exitedAt = at
        }
    }
    return shells
}

export interface ProcessRow {
    pid: number
    ppid: number
    createdAt: bigint
}

/**
 * The processes a recorded shell started: those created while it lived. Windows
 * hands a dead shell's pid to the next process, whose children carry the same
 * parent pid, so only the shell's lifetime tells them apart.
 */
export function startedByShells(rows: ProcessRow[], shells: Shell[]): number[] {
    const startedBy = (shell: Shell, row: ProcessRow): boolean => {
        if (shell.pid !== row.ppid || row.createdAt < shell.ranAt) return false
        if (shell.exitedAt !== undefined) return row.createdAt <= shell.exitedAt
        // No exit on record: a process holding the pid since before the run is the shell.
        return rows.some(r => r.pid === shell.pid && r.createdAt <= shell.ranAt)
    }
    return rows.filter(row => shells.some(shell => startedBy(shell, row))).map(row => row.pid)
}

export function parseProcessTable(text: string): ProcessRow[] {
    const rows: ProcessRow[] = []
    for (const line of text.split('\n')) {
        const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim())
        if (m) rows.push({pid: Number(m[1]), ppid: Number(m[2]), createdAt: BigInt(m[3]!)})
    }
    return rows
}

/**
 * Every process as `pid ppid creation-FILETIME`, one per line. A CIM query that
 * has not answered within the kill grace is given up on: the run is waiting.
 */
function processTable(graceMs: number): Promise<string> {
    const query =
        'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate'
        + ' | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToFileTimeUtc())" }'
    return new Promise(resolve => {
        let out = ''
        const ps = spawn(
            system32('WindowsPowerShell', 'v1.0', 'powershell.exe'),
            ['-NoProfile', '-NonInteractive', '-Command', query],
            {stdio: ['ignore', 'pipe', 'ignore']}
        )
        const giveUp = setTimeout(() => ps.kill(), graceMs)
        ps.stdout.on('data', (d: Buffer) => (out += d.toString()))
        ps.on('error', () => resolve(''))
        ps.on('close', () => {
            clearTimeout(giveUp)
            resolve(out)
        })
    })
}

function taskkillTree(pid: number): Promise<void> {
    return new Promise(resolve => {
        const tk = spawn(system32('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], {
            stdio: 'ignore'
        })
        tk.on('error', () => resolve())
        tk.on('close', () => resolve())
    })
}
