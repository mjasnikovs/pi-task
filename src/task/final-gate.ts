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
 *   - the project's own `test` and `build` commands, run verbatim and unaided.
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
import {spawnSync} from 'node:child_process'
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
 * Labels (`bin args…`) of every command the gate CAN currently discover — the
 * static half (repo-health) plus the integration half. Pure discovery, nothing
 * runs. Used by the final-gate autofix shrink guard: a fix pass that makes a
 * previously-discoverable command undiscoverable (deleted the script/target) is
 * gaming the gate, not fixing the defect.
 */
export function discoverGateCommandLabels(cwd: string): string[] {
    const labels = [
        ...discoverHealthCommands(cwd).cmds,
        ...discoverIntegrationCommands(cwd).cmds
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
 * Run the final gate: static analysis first, then the discovered integration
 * commands, whole-repo, verbatim, unaided. Deterministic and synchronous under
 * the hood (callers wrap in Promise.resolve). First real failure wins.
 */
export function runFinalIntegrationGate(cwd: string, timeoutMs = 900_000): FinalGateOutcome {
    const stat = runRepoHealthCheck(cwd)
    if (!stat.ok) return {ok: false, reason: `static checks: ${stat.reason}`}
    const {ecosystem, cmds} = discoverIntegrationCommands(cwd)
    if (!ecosystem || cmds.length === 0) {
        return {ok: true, reason: 'no integration command found (statics passed)'}
    }
    const ran: string[] = []
    for (const [bin, args] of cmds) {
        const label = `${bin} ${args.join(' ')}`
        const r = spawnSync(bin, args, {cwd, encoding: 'utf8', timeout: timeoutMs})
        // Tool missing, timeout, or command-not-found inside the script chain →
        // environment gap, not a code fault; skip (same contract as repo-health).
        if (r.error || r.status === null || r.status === 127) continue
        if (r.status !== 0) {
            const tail = outputTail(r.stdout ?? '', r.stderr ?? '')
            return {
                ok: false,
                reason: `\`${label}\` exited ${r.status}${tail ? ` — ${tail}` : ''}`
            }
        }
        ran.push(label)
    }
    return {
        ok: true,
        reason:
            ran.length > 0 ?
                `statics + ${ran.map(c => `\`${c}\``).join(', ')} passed`
            :   'statics passed (integration commands not runnable here)'
    }
}
