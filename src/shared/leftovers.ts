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

/**
 * Start tracking a child about to be spawned with `base` as its environment.
 * `graceMs` is POSIX's, between SIGTERM and SIGKILL. win32 has no grace to give:
 * `taskkill /F` returns once the tree is dead, and its port free (40 of 40 on the
 * windows runner).
 *
 * `procs` is the process table the reap works against, injectable because losing a
 * live leftover from the scan is what the reap has to survive — see the comment on
 * the hold in `trackToken`.
 */
export function trackLeftovers(
    platform: NodeJS.Platform,
    base: NodeJS.ProcessEnv,
    graceMs: number,
    procs?: Procs
): Leftovers {
    if (platform === 'win32') return trackShells(base)
    if (platform === 'linux' || platform === 'darwin') {
        return trackToken(base, graceMs, procs ?? procsFor(platform))
    }
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

/** A pid's row in the process table. `ended` covers zombies: one has released its
 *  ports already and only waits to be reaped. */
export type Sample =
    | {startedAt: string; ended: boolean}
    /** No row at all: the process is gone, and its ports with it. */
    | 'gone'
    /** The table could not be read. Says nothing about the process. */
    | 'unknown'

/**
 * The process table the reap works against. One object, so what the reap needs of
 * the table stays one dependency however many readings it takes.
 */
export interface Procs {
    /** Pids whose environment carries `marker`. */
    scan: (marker: string) => number[]
    /** `pid`'s row, read in one pass: state and start time at the same instant. */
    sample: (pid: number) => Sample
    signal: (pid: number, sig: NodeJS.Signals) => void
}

export function procsFor(platform: 'linux' | 'darwin'): Procs {
    return {
        scan: marker =>
            platform === 'linux' ? linuxPidsWith(marker) : pidsInPsTable(darwinPsTable(), marker),
        sample: pid => (platform === 'linux' ? linuxSample(pid) : darwinSample(pid)),
        signal: (pid, sig) => process.kill(pid, sig)
    }
}

function trackToken(base: NodeJS.ProcessEnv, graceMs: number, procs: Procs): Leftovers {
    const token = randomUUID()
    const marker = `${LEFTOVER_TOKEN_ENV}=${token}`
    return {
        env: {...base, [LEFTOVER_TOKEN_ENV]: token},
        reap: () =>
            new Promise(resolve => {
                const started = performance.now()
                // Discovery is by token; liveness cannot be. A dying process releases
                // its memory — and with it the token — while it still holds its ports,
                // so the scan reads it as gone about 9 times in 10. Each pid found is
                // pinned to its start time and followed in the process table until its
                // row is gone.
                const held = new Map<number, string | undefined>()
                // The pids this pass could still show to be the ones it found: the
                // token says so, or their start time does. Nothing else is signalled.
                const proven = new Set<number>()
                const termedAt = new Map<number, number>()
                const killed = new Set<number>()
                const send = (pid: number, sig: NodeJS.Signals): void => {
                    try {
                        procs.signal(pid, sig)
                    } catch {
                        // already gone
                    }
                }
                const follow = (): void => {
                    const seen = new Set(procs.scan(marker))
                    proven.clear()
                    for (const pid of new Set([...held.keys(), ...seen])) {
                        const row = procs.sample(pid)
                        const pin = nextPin(row, seen.has(pid), held.get(pid))
                        if (pin === drop) {
                            held.delete(pid)
                            continue
                        }
                        held.set(pid, pin)
                        if (seen.has(pid) || row !== 'unknown') proven.add(pid)
                    }
                }
                /**
                 * Its own grace runs from its own SIGTERM: a leftover discovered late
                 * has had none of the run's. `last` is the pass the reap gives up on.
                 */
                const due = (pid: number, waited: number, last: boolean): Signal | undefined => {
                    const termed = termedAt.get(pid)
                    if (termed === undefined) return last ? 'SIGKILL' : 'SIGTERM'
                    if (killed.has(pid)) return undefined
                    return last || waited - termed >= graceMs ? 'SIGKILL' : undefined
                }
                const signalDue = (waited: number, last: boolean): void => {
                    for (const pid of held.keys()) {
                        if (!proven.has(pid)) continue
                        const sig = due(pid, waited, last)
                        if (sig === undefined) continue
                        send(pid, sig)
                        if (!termedAt.has(pid)) termedAt.set(pid, waited)
                        if (sig === 'SIGKILL') killed.add(pid)
                    }
                }
                const poll = (): void => {
                    const passStart = performance.now()
                    follow()
                    const waited = performance.now() - started
                    // A process SIGKILL cannot end (uninterruptible sleep) gets one
                    // more grace, then the run goes on without it — never before it
                    // has had that SIGKILL.
                    const last = waited >= 2 * graceMs
                    signalDue(waited, last)
                    if (held.size === 0 || last) return resolve()
                    // Each pass waits as long as the one before it took, so the wait
                    // costs half a core at most and no invented interval.
                    setTimeout(poll, performance.now() - passStart).unref()
                }
                poll()
            })
    }
}

type Signal = 'SIGTERM' | 'SIGKILL'

/** The reap is done with this pid: ended, or no longer provably the one it held. */
const drop = Symbol('drop')

/**
 * The pin a held pid keeps for the next pass. `ours` is the token scan's answer,
 * and it is proof the pid is ours right now, whoever held it before.
 */
function nextPin(
    row: Sample,
    ours: boolean,
    pin: string | undefined
): string | undefined | typeof drop {
    if (row === 'unknown') return pin
    if (row === 'gone' || row.ended) return drop
    if (ours) return row.startedAt
    return pin === row.startedAt ? pin : drop
}

/** The state follows the LAST ')': the name before it can hold ') Z' itself. */
function statAfterName(stat: string): string {
    return stat.slice(stat.lastIndexOf(')') + 2)
}

/** starttime is stat field 22, and `rest` begins at field 3. */
function startTimeIn(rest: string): string {
    return rest.split(' ')[19] ?? ''
}

/** Zombie and dead: the process has released its ports, reaped or not. */
const ENDED_STATE = /^[ZXx]/

export function linuxSample(pid: number, procRoot = '/proc'): Sample {
    let stat: string
    try {
        stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8')
    } catch (e) {
        // A missing entry is an answer. EACCES, EMFILE and the rest are not.
        return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unknown'
    }
    const rest = statAfterName(stat)
    return {startedAt: startTimeIn(rest), ended: ENDED_STATE.test(rest)}
}

/** `ps -p` as the sampler runs it, injectable so a failed fork can be tested. */
export type RunPs = (args: string[]) => {error?: Error; status: number | null; stdout?: string}

const runPs: RunPs = args => spawnSync('/bin/ps', args, {encoding: 'utf8'})

export function darwinSample(pid: number, run: RunPs = runPs): Sample {
    const r = run(['-o', 'state=,lstart=', '-p', String(pid)])
    // A fork that failed says nothing about the process. `ps` exits 1 when there is
    // genuinely no such process, and that is the only empty answer to believe.
    if (r.error || r.status === null) return 'unknown'
    const row = /^(\S+)\s+(\S.*)$/.exec(r.stdout?.trim() ?? '')
    if (row) return {startedAt: row[2]!, ended: row[1]!.startsWith('Z')}
    return r.status === 0 ? 'unknown' : 'gone'
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

function trackShells(base: NodeJS.ProcessEnv): Leftovers {
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
                const started = startedByShells(parseProcessTable(await processTable()), shells)
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
 * Every process as `pid ppid creation-FILETIME`, one per line. Not bounded: a cold
 * WMI outlasted the kill grace on the windows runner, and a query cut short reaps nothing.
 */
function processTable(): Promise<string> {
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
        ps.stdout.on('data', (d: Buffer) => (out += d.toString()))
        ps.on('error', () => resolve(''))
        ps.on('close', () => resolve(out))
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
