/**
 * final-gate — the run-level integration gate /task-auto runs ONCE, after every
 * task is checked off and before the run is declared complete.
 *
 * The failure this closes (mx5 runs 3 and 5, validated): every existing gate is
 * per-task/per-slice, so a run can finish with each slice individually blessed
 * while the ASSEMBLED project is dead — statics green yet every protected route
 * 500ing, 105/174 tests failing across slices, later tasks breaking files earlier
 * tasks verified. Per-task repo-health closes the static half; nothing ever ran
 * the project's own test/build commands against the finished whole.
 *
 * Like repo-health-check (whose discovery style this mirrors), it is deterministic
 * — no model, no per-file narrowing, no "not my task" gray area. It discovers the
 * project's OWN integration commands (the ones a fresh checkout / CI would run)
 * and lets their REAL exit codes decide:
 *
 *   - static analysis first (runRepoHealthCheck — cheap, precise), then
 *   - lockfile↔manifest consistency (mx5 run 7, validated: the lockfile carried a
 *     dependency no committed manifest declared, so the tree tested green here
 *     but a FRESH CHECKOUT could not even install — each ecosystem's own offline
 *     "is the lock in sync" command decides), then
 *   - the project's own `test` and `build` commands, run verbatim and unaided, then
 *   - one boot exercise of the project's own start command (mx5 run 7, validated:
 *     every static and test gate green, yet `bun run start` died in ~1s on a
 *     self-inflicted EADDRINUSE — nothing had ever LAUNCHED the finished project).
 *     No ports, URLs, or framework knowledge: fast non-zero exit → FAIL, quick
 *     exit 0 → PASS (CLI-style), still alive after the grace window → PASS and
 *     the whole process group is killed (scripts spawn children; a leaked child
 *     server would mask every later boot check with a port collision).
 *
 * Environment-gap safety, same contract as repo-health-check: a command that
 * CANNOT run (ENOENT, exit 127 = command-not-found inside the script chain, or a
 * timeout) is an environment problem, not a code fault — it is SKIPPED, never
 * failed. Only a command that actually ran and exited non-zero fails the gate,
 * and the reason carries the tail of its real output so the user (and a resume
 * fix) can act on it. A test suite that needs a database will fail here when the
 * database is genuinely reachable-but-mis-wired — which is exactly the class the
 * per-task gates kept excusing — and the caller puts a human on the decision
 * (accept / leave failed), so a genuine external gap can still be overridden.
 */
import {spawn, spawnSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import {
    runRepoHealthCheck,
    discoverHealthCommands,
    type HealthCommand
} from './repo-health-check.js'

export interface FinalGateOutcome {
    /** true → statics and every runnable integration command passed (or nothing to run). */
    ok: boolean
    /** On a fail: the exact command, its exit code, and the tail of its output. */
    reason: string
}

function packageScripts(cwd: string): Record<string, string> {
    try {
        const j = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
        }
        return j.scripts ?? {}
    } catch {
        return {}
    }
}

function makeHasTarget(cwd: string, target: string): boolean {
    try {
        const mk = readFileSync(path.join(cwd, 'Makefile'), 'utf8')
        return new RegExp(`^${target}:`, 'm').test(mk)
    } catch {
        return false
    }
}

/**
 * The project's OWN whole-repo integration commands (test, then build — test
 * first because it is the richer signal and the more common script). First
 * manifest that exists wins, mirroring discoverHealthCommands. Empty means
 * "nothing to run" — the static half may still gate.
 */
export function discoverIntegrationCommands(cwd: string): {
    ecosystem: string | null
    cmds: HealthCommand[]
} {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        const cmds: HealthCommand[] = []
        for (const name of ['test', 'build']) {
            if (s[name]) cmds.push(['bun', ['run', name]])
        }
        return {ecosystem: 'package.json', cmds}
    }
    if (existsSync(path.join(cwd, 'Makefile'))) {
        const cmds: HealthCommand[] = []
        for (const target of ['test', 'build']) {
            if (makeHasTarget(cwd, target)) cmds.push(['make', [target]])
        }
        return {ecosystem: 'Makefile', cmds}
    }
    if (existsSync(path.join(cwd, 'Cargo.toml'))) {
        return {
            ecosystem: 'Cargo.toml',
            cmds: [
                ['cargo', ['test', '--quiet']],
                ['cargo', ['build', '--quiet']]
            ]
        }
    }
    if (existsSync(path.join(cwd, 'go.mod'))) {
        return {
            ecosystem: 'go.mod',
            cmds: [
                ['go', ['test', './...']],
                ['go', ['build', './...']]
            ]
        }
    }
    if (existsSync(path.join(cwd, 'pyproject.toml'))) {
        return {ecosystem: 'pyproject.toml', cmds: [['pytest', ['-q']]]}
    }
    return {ecosystem: null, cmds: []}
}

/**
 * Per-ecosystem lockfile↔manifest consistency checks. A check applies only when
 * BOTH the manifest and its lockfile exist (no lockfile → nothing to verify),
 * and every command is the ecosystem's own non-mutating "is the lock in sync
 * with the manifest" form — validated to exit 0 fast on an in-sync tree and
 * non-zero on a genuine desync, without touching the tree or (when in sync)
 * the network.
 */
const LOCKFILE_CHECKS: Array<{manifest: string; lockfiles: string[]; cmd: HealthCommand}> = [
    {
        manifest: 'package.json',
        lockfiles: ['bun.lock', 'bun.lockb'],
        cmd: ['bun', ['install', '--frozen-lockfile', '--dry-run']]
    },
    {
        manifest: 'package.json',
        lockfiles: ['package-lock.json'],
        cmd: ['npm', ['ci', '--dry-run']]
    },
    {
        manifest: 'Cargo.toml',
        lockfiles: ['Cargo.lock'],
        cmd: ['cargo', ['metadata', '--locked', '--format-version', '1']]
    },
    {manifest: 'go.mod', lockfiles: ['go.sum'], cmd: ['go', ['mod', 'verify']]},
    {manifest: 'pyproject.toml', lockfiles: ['uv.lock'], cmd: ['uv', ['lock', '--check']]},
    {manifest: 'pyproject.toml', lockfiles: ['poetry.lock'], cmd: ['poetry', ['check', '--lock']]}
]

/** Every lockfile consistency check that applies to this tree (possibly none). */
export function discoverLockfileChecks(cwd: string): HealthCommand[] {
    const cmds: HealthCommand[] = []
    for (const {manifest, lockfiles, cmd} of LOCKFILE_CHECKS) {
        if (!existsSync(path.join(cwd, manifest))) continue
        if (!lockfiles.some(f => existsSync(path.join(cwd, f)))) continue
        cmds.push(cmd)
    }
    return cmds
}

/**
 * The project's OWN launch command, if it declares one (package.json `start`,
 * else `dev`; Makefile `run`). null means the project has nothing to boot —
 * the boot check degrades to nothing-to-run.
 */
export function discoverBootCommand(cwd: string): HealthCommand | null {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        for (const name of ['start', 'dev']) {
            if (s[name]) return ['bun', ['run', name]]
        }
        return null
    }
    if (existsSync(path.join(cwd, 'Makefile')) && makeHasTarget(cwd, 'run')) {
        return ['make', ['run']]
    }
    return null
}

type BootOutcome = {outcome: 'skip' | 'pass'} | {outcome: 'fail'; detail: string}

/**
 * Exercise the start command ONCE, with no port/URL/framework knowledge — the
 * command's own fate within the grace window decides:
 *
 *   - non-zero exit (or signal death) before the window closes → FAIL, output tail;
 *   - exit 0 before the window closes → PASS (a CLI-style "run" that finished);
 *   - still alive when the window closes → PASS, then the whole process group is
 *     killed (detached spawn = own group; SIGTERM, escalating to SIGKILL).
 *
 * Env-gap contract as everywhere: spawn error (ENOENT) or exit 127 → skip.
 */
export function runBootCheck(
    cwd: string,
    [bin, args]: HealthCommand,
    graceMs = 10_000
): Promise<BootOutcome> {
    return new Promise(resolve => {
        const child = spawn(bin, args, {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {...process.env}
        })
        let out = ''
        let err = ''
        const cap = (s: string) => (s.length > 8000 ? s.slice(-8000) : s)
        child.stdout?.on('data', (d: Buffer) => (out = cap(out + String(d))))
        child.stderr?.on('data', (d: Buffer) => (err = cap(err + String(d))))
        let settled = false
        const settle = (r: BootOutcome) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(r)
        }
        const killGroup = (sig: NodeJS.Signals) => {
            try {
                if (child.pid) process.kill(-child.pid, sig)
            } catch {
                // group already gone
            }
        }
        const timer = setTimeout(() => {
            settle({outcome: 'pass'})
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), 2_000).unref()
        }, graceMs)
        child.on('error', () => settle({outcome: 'skip'}))
        child.on('exit', (status, signal) => {
            if (status === 0) return settle({outcome: 'pass'})
            if (status === 127 || (status === null && signal === null)) {
                return settle({outcome: 'skip'})
            }
            const what = status !== null ? `exited ${status}` : `was killed by ${signal}`
            const tail = outputTail(out, err)
            settle({outcome: 'fail', detail: `${what}${tail ? ` — ${tail}` : ''}`})
        })
    })
}

/**
 * Labels (`bin args…`) of every command the gate CAN currently discover — the
 * static half (repo-health) plus the integration half. Pure discovery, nothing
 * runs. Used by the final-gate autofix shrink guard: a fix pass that makes a
 * previously-discoverable command undiscoverable (deleted the script/target) is
 * gaming the gate, not fixing the defect.
 */
export function discoverGateCommandLabels(cwd: string): string[] {
    const boot = discoverBootCommand(cwd)
    const labels = [
        ...discoverHealthCommands(cwd).cmds,
        ...discoverLockfileChecks(cwd),
        ...discoverIntegrationCommands(cwd).cmds,
        ...(boot ? [boot] : [])
    ].map(([bin, args]) => `${bin} ${args.join(' ')}`)
    return [...new Set(labels)]
}

/** Last ~`limit` chars of the command's combined output, one line, for the reason. */
function outputTail(stdout: string, stderr: string, limit = 400): string {
    const combined = `${stdout}\n${stderr}`.trim()
    if (combined.length === 0) return ''
    const tail = combined.slice(-limit).replace(/\s+/g, ' ').trim()
    return combined.length > limit ? `…${tail}` : tail
}

/**
 * Run one gate command with the env-gap contract: tool missing, timeout, or
 * command-not-found inside the script chain (127) → environment gap, not a code
 * fault → skipped (same contract as repo-health). Only a command that actually
 * ran and exited non-zero fails.
 */
function runGateCommand(
    cwd: string,
    [bin, args]: HealthCommand,
    timeoutMs: number
): {outcome: 'skip' | 'pass'} | {outcome: 'fail'; status: number; tail: string} {
    // env passed explicitly: bun's spawnSync resolves the binary against a
    // startup snapshot of the environment, not the live process.env.
    const r = spawnSync(bin, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: {...process.env}
    })
    if (r.error || r.status === null || r.status === 127) return {outcome: 'skip'}
    if (r.status !== 0) {
        return {outcome: 'fail', status: r.status, tail: outputTail(r.stdout ?? '', r.stderr ?? '')}
    }
    return {outcome: 'pass'}
}

/**
 * Run the final gate: static analysis first, then the lockfile consistency
 * checks, then the discovered integration commands, then one boot exercise of
 * the start command — whole-repo, verbatim, unaided. Deterministic (no model).
 * First real failure wins.
 */
export async function runFinalIntegrationGate(
    cwd: string,
    timeoutMs = 900_000,
    bootGraceMs = 10_000
): Promise<FinalGateOutcome> {
    const stat = runRepoHealthCheck(cwd)
    if (!stat.ok) return {ok: false, reason: `static checks: ${stat.reason}`}
    const lockCmds = discoverLockfileChecks(cwd)
    const {cmds} = discoverIntegrationCommands(cwd)
    const boot = discoverBootCommand(cwd)
    if (lockCmds.length === 0 && cmds.length === 0 && !boot) {
        return {ok: true, reason: 'no integration command found (statics passed)'}
    }
    const ran: string[] = []
    for (const {prefix, list} of [
        {prefix: 'lockfile check: ', list: lockCmds},
        {prefix: '', list: cmds}
    ]) {
        for (const cmd of list) {
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            const r = runGateCommand(cwd, cmd, timeoutMs)
            if (r.outcome === 'skip') continue
            if (r.outcome === 'fail') {
                return {
                    ok: false,
                    reason: `${prefix}\`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`
                }
            }
            ran.push(label)
        }
    }
    if (boot) {
        const label = `${boot[0]} ${boot[1].join(' ')}`
        const b = await runBootCheck(cwd, boot, bootGraceMs)
        if (b.outcome === 'fail') {
            return {ok: false, reason: `boot check: \`${label}\` ${b.detail}`}
        }
        if (b.outcome === 'pass') ran.push(label)
    }
    return {
        ok: true,
        reason:
            ran.length > 0 ?
                `statics + ${ran.map(c => `\`${c}\``).join(', ')} passed`
            :   'statics passed (integration commands not runnable here)'
    }
}
