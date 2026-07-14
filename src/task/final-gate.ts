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
import {
    readAcceptDebts,
    recheckAcceptDebts,
    writeAcceptDebts,
    buildAcceptDebtNote,
    annotateDebtConflicts,
    type AcceptDebt
} from './accept-debt.js'
import {
    readDeclaredScripts,
    missingDeclaredScripts,
    runnableDeclaredScripts
} from './launch-contract.js'
import {readEnvNotes, parseEnvNotes, isExcuseNote} from './env-notes.js'

export interface FinalGateOutcome {
    /** true → statics and every runnable integration command passed (or nothing to run). */
    ok: boolean
    /**
     * On a fail: the exact command, its exit code, and the tail of its output — the
     * MECHANICAL failure only. The accept-debt note is deliberately NOT folded in
     * here (mx5 run 11): this string seeds the final-gate AUTOFIX child's prompt,
     * and a debt included there is read as an instruction — the run-11 fix child
     * `rm`'d a sibling task's verified deliverable to satisfy a recorded claim. The
     * child cannot act on text it never receives; debts travel in `debtNote`.
     */
    reason: string
    /**
     * Human-facing suffix listing the still-open accepted-defect claims (see
     * buildAcceptDebtNote) — for the picker question and the trail, NEVER for the
     * autofix seed. Absent when nothing is open.
     */
    debtNote?: string
    /**
     * ACCEPT-despite-verify-FAIL debts still open at run end (mx5 run 4 B3 / run 8
     * TASK_0012): tasks the user blessed as-is despite a verify-FAIL that a
     * deterministic re-check could not prove resolved. The caller surfaces them so a
     * run never completes silently carrying an accepted defect. Empty/absent = none.
     */
    openDebts?: AcceptDebt[]
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
        // Every test-shaped script, not just the one literally named `test` (mx5 run
        // 10: `test:ct` — 89 Playwright component tests, the ONLY client-executing
        // suite — never ran because the gate looked only for `test`/`build`). Plain
        // `test` leads (richer, most common), then `test:*`/`test-*` in declaration
        // order, then `build`. Env-gap SKIP still applies per command (a suite whose
        // browser/runtime is absent skips, it does not fail — see runGateCommand).
        const testNames = Object.keys(s).filter(n => n === 'test' || /^test[:_-]/.test(n))
        testNames.sort((a, b) =>
            a === 'test' ? -1
            : b === 'test' ? 1
            : 0
        )
        for (const name of testNames) cmds.push(['bun', ['run', name]])
        if (s.build) cmds.push(['bun', ['run', 'build']])
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

type BootOutcome =
    | {outcome: 'skip' | 'pass'}
    | {outcome: 'fail'; detail: string}
    // An address-already-in-use bind failure: the app code is fine, a process is
    // sitting on the port (mx5 run 9: a gate child's orphaned `bun run dev` held
    // :3000, so the final gate's own `bun run start` died with EADDRINUSE and got
    // mislabeled an app FAIL). Handled distinctly from a real fail.
    | {outcome: 'orphan-port'; detail: string; port: number | null}

/** Recognise an "address already in use" bind failure across runtimes (Node
 *  EADDRINUSE, Bun "Is port N in use?", Go "address already in use", generic). */
function isAddressInUse(text: string): boolean {
    return /EADDRINUSE|address already in use|address in use|port \d+ (?:is |already )?in use/i.test(
        text
    )
}

/** Best-effort port number from a bind-failure message, for the diagnosis line. The
 *  digit run ends on any non-digit (a `(?!\d)` lookahead, NOT `\b`): runtimes often
 *  print ":3000" flush against the next token with no separating space/newline
 *  ("…:3000error: script exited"), where a trailing `\b` would never match. */
function extractPort(text: string): number | null {
    const m =
        /(?:port|:)\s*(\d{2,5})(?!\d)/i.exec(text) ?? /\baddress[^0-9]*(\d{2,5})(?!\d)/i.exec(text)
    if (!m) return null
    const n = Number(m[1])
    return n > 0 && n < 65536 ? n : null
}

/** Injectable environment probes for the boot check's orphan-port recovery, so the
 *  reap-and-retry path is deterministically testable without a real listener. */
export interface BootDeps {
    /** The pid + command line holding `port` in LISTEN, or null if none/unknown. */
    findPortHolder?: (port: number) => {pid: number; command: string} | null
    /** Terminate a pid we attribute to ourselves; returns whether it was signalled. */
    reap?: (pid: number) => boolean
    /**
     * Does process group `pgid` currently own a LISTENing TCP socket? Drives the
     * served-app boot check (mx5 run 10): a watcher (`dev` = tailwind/bundler
     * --watch) stays alive forever without ever listening, so "still alive after the
     * grace window = PASS" blessed a project that cannot serve a single request.
     * Injected so the listener requirement is deterministically testable without a
     * real socket; the default probes ss/lsof + pgid.
     */
    groupHasListener?: (pgid: number) => boolean
}

/** Package deps that mean "this project stands up an HTTP server" — the deterministic
 *  proxy for "the plan/spec promised a served app". Bare framework names plus the
 *  scoped families whose presence implies a listener at runtime. */
function isServerFrameworkDep(name: string): boolean {
    return (
        /^(?:hono|express|fastify|koa|polka|restify|next|nuxt|http-server|serve|ws|socket\.io)$/.test(
            name
        ) || /^@(?:hono|fastify|koa|nestjs|sveltejs|remix-run)\//.test(name)
    )
}

/** Spec/plan phrasings that promise a listening server, for the text signal. */
const SERVE_TEXT_RE =
    /\b(?:https?\s+server|web\s+server|serves?\b|listen(?:s|ing)?\b|Bun\.serve|app\.listen|createServer|serve\s+(?:static|the)|\/api\/|endpoints?\b)/i

/**
 * Does the finished run stand up a listening HTTP server? Deterministic, from the
 * built manifest (a server-framework dependency is the plan's own artifact) OR, when
 * available, the plan/spec text. Used to decide whether the boot check must observe a
 * LISTENER (served app) or may pass on mere survival / quick exit (CLI project).
 */
export function detectsServedApp(cwd: string, planText?: string): boolean {
    try {
        const j = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }
        const all = {...(j.dependencies ?? {}), ...(j.devDependencies ?? {})}
        if (Object.keys(all).some(isServerFrameworkDep)) return true
    } catch {
        // no/unreadable manifest → fall through to the text signal
    }
    return planText !== undefined && SERVE_TEXT_RE.test(planText)
}

/** Pids currently owning a LISTENing TCP socket (best-effort; ss first, then lsof).
 *  Empty on any failure — the caller then cannot attribute a listener to our group
 *  and the served-app check degrades to survival (never a false FAIL). */
function listeningSocketPids(): number[] {
    const pids = new Set<number>()
    try {
        const t = spawnSync('ss', ['-tlnpH'], {encoding: 'utf8', timeout: 4000})
        if (!t.error && t.stdout) {
            for (const m of t.stdout.matchAll(/pid=(\d+)/g)) pids.add(Number(m[1]))
        }
    } catch {
        // ss missing — try lsof
    }
    if (pids.size === 0) {
        try {
            const t = spawnSync('lsof', ['-iTCP', '-sTCP:LISTEN', '-t', '-n', '-P'], {
                encoding: 'utf8',
                timeout: 4000
            })
            if (!t.error && t.stdout) {
                for (const line of t.stdout.split('\n')) {
                    const n = Number(line.trim())
                    if (Number.isInteger(n) && n > 0) pids.add(n)
                }
            }
        } catch {
            // neither tool available
        }
    }
    return [...pids]
}

/** Process-group id of `pid`, or null if it cannot be read. */
function pgidOf(pid: number): number | null {
    try {
        const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 4000
        })
        const n = Number((r.stdout ?? '').trim())
        return Number.isInteger(n) && n > 0 ? n : null
    } catch {
        return null
    }
}

/** Default listener probe: any LISTENing socket owned by a pid in process group
 *  `pgid` (the detached boot child IS its own group leader, so pgid === child.pid). */
function defaultGroupHasListener(pgid: number): boolean {
    for (const pid of listeningSocketPids()) {
        if (pgidOf(pid) === pgid) return true
    }
    return false
}

/** Default port-holder lookup: `lsof` first, then `ss`/`fuser`. Returns null on any
 *  failure (the diagnosis then omits the pid — never blocks). */
function defaultFindPortHolder(port: number): {pid: number; command: string} | null {
    try {
        const t = spawnSync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-t', '-P', '-n'], {
            encoding: 'utf8',
            timeout: 4000
        })
        const pid = Number((t.stdout ?? '').split('\n')[0]?.trim())
        if (!Number.isInteger(pid) || pid <= 0) return null
        const ps = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], {
            encoding: 'utf8',
            timeout: 4000
        })
        return {pid, command: (ps.stdout ?? '').trim() || `pid ${pid}`}
    } catch {
        return null
    }
}

function defaultReap(pid: number): boolean {
    try {
        process.kill(pid, 'SIGTERM')
        setTimeout(() => {
            try {
                process.kill(pid, 'SIGKILL')
            } catch {
                // already gone
            }
        }, 1_000).unref()
        return true
    } catch {
        return false
    }
}

/** Does the port holder look like one of OUR gate children (a `dev`/`start` run of
 *  the discovered boot command)? Only then do we reap it — never a foreign process
 *  the user happens to be running. */
function holderIsOurs(command: string, boot: HealthCommand): boolean {
    const script = boot[1][boot[1].length - 1] ?? '' // 'start' | 'dev' | 'run'
    const c = command.toLowerCase()
    return (
        (c.includes('bun') || c.includes('node') || c.includes('npm') || c.includes('make'))
        && (c.includes(` ${script}`) || c.endsWith(script))
    )
}

/**
 * Exercise the start command ONCE. For a CLI project (`expectServer` false) the
 * command's own fate within the grace window decides:
 *
 *   - non-zero exit (or signal death) before the window closes → FAIL, output tail;
 *   - exit 0 before the window closes → PASS (a CLI-style "run" that finished);
 *   - still alive when the window closes → PASS, then the whole process group is
 *     killed (detached spawn = own group; SIGTERM, escalating to SIGKILL).
 *
 * For a SERVED app (`expectServer` true — the spec/plan promised an HTTP server) mere
 * survival is not enough: a watcher (`dev` = tailwind/bundler --watch) stays alive
 * forever without ever listening, and a type-only entrypoint exits 0 in <1s having
 * served nothing (mx5 run 10 — both were blessed by the survival rule). The boot then
 * PASSes only once a LISTENing socket owned by our process group is observed; if the
 * command exits, or the grace window closes, with no listener ever seen → FAIL naming
 * that a listening server was expected. (The listener requirement needs pgid probing,
 * absent on win32, where `expectServer` collapses to the survival rule — best-effort,
 * never a false FAIL on a platform we cannot probe.)
 *
 * Env-gap contract as everywhere: spawn error (ENOENT) or exit 127 → skip.
 */
export function runBootCheck(
    cwd: string,
    [bin, args]: HealthCommand,
    graceMs = 10_000,
    opts: {expectServer?: boolean; deps?: BootDeps} = {}
): Promise<BootOutcome> {
    const expectServer = (opts.expectServer ?? false) && process.platform !== 'win32'
    const groupHasListener = opts.deps?.groupHasListener ?? defaultGroupHasListener
    return new Promise(resolve => {
        const child = spawn(bin, args, {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {...process.env}
        })
        let out = ''
        let err = ''
        let listenerSeen = false
        const cap = (s: string) => (s.length > 8000 ? s.slice(-8000) : s)
        child.stdout?.on('data', (d: Buffer) => (out = cap(out + String(d))))
        child.stderr?.on('data', (d: Buffer) => (err = cap(err + String(d))))
        let settled = false
        const settle = (r: BootOutcome) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (poll) clearInterval(poll)
            resolve(r)
        }
        const killGroup = (sig: NodeJS.Signals) => {
            try {
                if (!child.pid) return
                if (process.platform === 'win32') {
                    // Windows has no process groups / negative-pid kill. taskkill
                    // /T tears down the whole tree (the detached child plus any
                    // grandchildren it spawned); /F forces it, so the SIGTERM→
                    // SIGKILL escalation collapses to one idempotent call.
                    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
                } else {
                    process.kill(-child.pid, sig)
                }
            } catch {
                // group already gone
            }
        }
        const passAndKill = () => {
            settle({outcome: 'pass'})
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), 2_000).unref()
        }
        // Served apps only: poll for a listening socket owned by our process group.
        // As soon as one appears the boot has demonstrably served → PASS early.
        const poll =
            expectServer ?
                setInterval(() => {
                    if (settled || !child.pid) return
                    if (groupHasListener(child.pid)) {
                        listenerSeen = true
                        passAndKill()
                    }
                }, 500)
            :   null
        const timer = setTimeout(() => {
            if (expectServer && !listenerSeen) {
                settle({
                    outcome: 'fail',
                    detail: `still running after ${graceMs}ms but never opened a listening socket — the spec/dependencies promise an HTTP server`
                })
                killGroup('SIGTERM')
                setTimeout(() => killGroup('SIGKILL'), 2_000).unref()
                return
            }
            passAndKill()
        }, graceMs)
        child.on('error', () => settle({outcome: 'skip'}))
        child.on('exit', (status, signal) => {
            if (status === 0) {
                if (expectServer && !listenerSeen) {
                    return settle({
                        outcome: 'fail',
                        detail:
                            'exited 0 without ever opening a listening socket — the spec/dependencies '
                            + 'promise an HTTP server, so a boot that serves nothing is not a launch'
                    })
                }
                return settle({outcome: 'pass'})
            }
            if (status === 127 || (status === null && signal === null)) {
                return settle({outcome: 'skip'})
            }
            const what = status !== null ? `exited ${status}` : `was killed by ${signal}`
            const tail = outputTail(out, err)
            // A bind collision is an environment condition, not an app defect — hand
            // it back distinctly so the gate can reap our own orphan and retry rather
            // than reporting the app "crashed" (mx5 run 9 item 3).
            if (isAddressInUse(`${out}\n${err}`)) {
                settle({
                    outcome: 'orphan-port',
                    port: extractPort(`${out}\n${err}`),
                    detail: `${what}${tail ? ` — ${tail}` : ''}`
                })
                return
            }
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
 * A non-zero exit whose output shows an EXTERNAL runtime dependency is missing, not
 * a code fault: a browser suite (Playwright/Cypress) whose browser binaries or system
 * libraries were never installed here (mx5 run 10 item 2: `test:ct` must run in the
 * gate, but on a box with no Playwright browsers it is an environment gap, not a FAIL).
 * These exit non-zero (not 127), so they need output-shape recognition to skip.
 */
const ENV_GAP_OUTPUT_RE =
    /Executable doesn't exist|playwright install|browserType\.\w+: Executable|(?:wasn't|weren't) installed|Host system is missing dependencies|No usable sandbox|Cypress verification|Cypress executable (?:not found|was not found)|browser(?:s)? (?:is|are)? ?not installed/i

/**
 * A non-zero exit whose output shows the EXTERNAL INFRASTRUCTURE a launch script
 * talks to is absent HERE — a database/daemon that is not running or not
 * installed — rather than a fault in the script itself. Applied ONLY to
 * launch-contract scripts (a migrate/seed against no DB is an environment gap on
 * this box; the same wording in a `test` run is a real failure the suite must own).
 */
export const INFRA_GAP_OUTPUT_RE =
    /ECONNREFUSED|connection refused|ENOTFOUND|EAI_AGAIN|is the server running|could not connect|cannot connect to the docker daemon|connect: connection|no such host/i

/**
 * Run one gate command with the env-gap contract: tool missing, timeout, or
 * command-not-found inside the script chain (127) → environment gap, not a code
 * fault → skipped (same contract as repo-health). Also skips a non-zero exit whose
 * output shows a missing browser/runtime (ENV_GAP_OUTPUT_RE) — or, when the caller
 * passes `extraGapRe` (launch scripts), missing external infrastructure. Only a
 * command that actually ran and exited non-zero for a real reason fails.
 */
function runGateCommand(
    cwd: string,
    [bin, args]: HealthCommand,
    timeoutMs: number,
    extraGapRe?: RegExp
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
        const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
        if (ENV_GAP_OUTPUT_RE.test(output)) return {outcome: 'skip'}
        if (extraGapRe?.test(output)) return {outcome: 'skip'}
        return {outcome: 'fail', status: r.status, tail: outputTail(r.stdout ?? '', r.stderr ?? '')}
    }
    return {outcome: 'pass'}
}

/**
 * Boot check hit an address-in-use bind failure. If the port is held by one of OUR
 * own orphaned gate children (a `dev`/`start` run), reap it and retry the boot once
 * so the app gets a fair launch; otherwise leave the (foreign) holder alone and let
 * the caller emit the harness diagnosis. Never reaps a process we cannot attribute
 * to ourselves.
 */
async function recoverOrphanPort(
    cwd: string,
    boot: HealthCommand,
    first: {outcome: 'orphan-port'; detail: string; port: number | null},
    bootGraceMs: number,
    deps: BootDeps,
    expectServer: boolean
): Promise<BootOutcome> {
    if (first.port === null) return first
    const holder = (deps.findPortHolder ?? defaultFindPortHolder)(first.port)
    if (!holder || !holderIsOurs(holder.command, boot)) return first
    const reaped = (deps.reap ?? defaultReap)(holder.pid)
    if (!reaped) return first
    // Give the OS a moment to release the socket, then re-run the boot once.
    await new Promise(r => setTimeout(r, 1_500))
    return runBootCheck(cwd, boot, bootGraceMs, {expectServer, deps})
}

/**
 * The task whose commit INTRODUCED `rel` (oldest `--diff-filter=A` commit whose
 * subject carries the pi-task `(TASK_nnnn)` suffix — both the task snapshot and the
 * ENFORCE commit shapes match). Null when the file predates the run, was never
 * committed, git is unavailable, or the adding commit is not a task commit — every
 * unknown degrades to "no conflict claim".
 */
export function taskThatIntroduced(cwd: string, rel: string): string | null {
    const r = spawnSync('git', ['log', '--diff-filter=A', '--format=%s', '--', rel], {
        cwd,
        encoding: 'utf8'
    })
    if (r.error || r.status !== 0 || !r.stdout) return null
    const subjects = r.stdout.trim().split('\n').filter(Boolean)
    // Newest-first output; the LAST line is the original introduction (a
    // delete-and-re-add later in history must not reattribute the file).
    const first = subjects[subjects.length - 1] ?? ''
    const m = /\((TASK_\d+)\)\s*$/.exec(first)
    return m ? m[1] : null
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
    bootGraceMs = 10_000,
    bootDeps: BootDeps = {},
    planText?: string
): Promise<FinalGateOutcome> {
    const stat = runRepoHealthCheck(cwd)
    // ACCEPT-debt re-check (mx5 run 4 B3 / run 8 TASK_0012): read the ledger of tasks
    // the user accepted despite a verify-FAIL and re-check each against the current
    // tree. A static-class debt whose statics now pass is provably RESOLVED (a later
    // task fixed it) and pruned; every other debt cannot be proven resolved
    // deterministically, so it stays OPEN and is surfaced in this gate's report — a
    // run may not complete silently carrying an accepted defect. FP-safe by
    // construction (see accept-debt.ts). Best-effort: a ledger read/write failure
    // must never break the gate.
    const {open: openRaw, resolved} = recheckAcceptDebts(await readAcceptDebts(cwd), {
        staticOk: stat.ok
    })
    if (resolved.length > 0) await writeAcceptDebts(cwd, openRaw)
    // Conflicting-claim annotation (mx5 run 11): an existence-as-failure debt whose
    // named file is another task's committed deliverable is a plan defect — surface
    // the contradiction with the debt so nobody (human or child) treats the claim as
    // a deletion instruction. Pure git-history lookup; degrades to no annotation.
    const openDebts = annotateDebtConflicts(openRaw, p => taskThatIntroduced(cwd, p))
    const debtNote = buildAcceptDebtNote(openDebts)
    // The debt note rides in its OWN field: `reason` stays the mechanical failure
    // because it seeds the autofix child's prompt (see FinalGateOutcome.reason —
    // run 11's fix child executed a recorded claim as an instruction).
    const withDebts = (o: FinalGateOutcome): FinalGateOutcome => ({
        ...o,
        ...(debtNote ? {debtNote} : {}),
        openDebts
    })
    if (!stat.ok) return withDebts({ok: false, reason: `static checks: ${stat.reason}`})
    // Launch-contract diff (mx5 run 10 item 4): the design declared `migrate`/`seed`
    // scripts that fell through decompose and shipped missing, unchecked. Diff the
    // plan-time-extracted declared scripts against the manifest; a missing one is a
    // launch-surface defect. FP-safe: empty declared list (nothing grounded) → no check.
    const declared = await readDeclaredScripts(cwd)
    if (declared.length > 0) {
        const missing = missingDeclaredScripts(declared, Object.keys(packageScripts(cwd)))
        if (missing.length > 0) {
            return withDebts({
                ok: false,
                reason: `launch contract: the design declares script(s) the shipped package.json does not expose: ${missing.join(', ')} (declared: ${declared.join(', ')})`
            })
        }
    }
    const lockCmds = discoverLockfileChecks(cwd)
    const {cmds} = discoverIntegrationCommands(cwd)
    const boot = discoverBootCommand(cwd)
    if (lockCmds.length === 0 && cmds.length === 0 && !boot) {
        return withDebts({ok: true, reason: 'no integration command found (statics passed)'})
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
                return withDebts({
                    ok: false,
                    reason: `${prefix}\`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`
                })
            }
            ran.push(label)
        }
    }
    // EXECUTE the launch contract (mx5 run 11): every declared script that is
    // neither boot-class (the boot check below owns those) nor already covered by
    // the integration commands above RUNS as a one-shot, in declared order —
    // existence is not launchability (`migrate`/`seed` shipped as first-call
    // TypeErrors while the gate checked only that they exist). The env-gap
    // contract extends to missing external INFRASTRUCTURE (no DB/daemon on this
    // box → skip, not fail); a skip whose script also carries a standing EXCUSE
    // note (F7) is surfaced as an UNOBSERVED warning — the note may be covering a
    // real defect the gate could not reach here (run 11's "pre-existing .rows
    // bug" note excused the exact scripts that shipped broken).
    const warnings: string[] = []
    if (declared.length > 0) {
        const covered = cmds.flatMap(([bin, args]) =>
            (bin === 'bun' || bin === 'npm') && args[0] === 'run' && args[1] ? [args[1]] : []
        )
        const skippedLaunch: string[] = []
        for (const name of runnableDeclaredScripts(declared, covered)) {
            const cmd: HealthCommand = ['bun', ['run', name]]
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            const r = runGateCommand(cwd, cmd, Math.min(timeoutMs, 180_000), INFRA_GAP_OUTPUT_RE)
            if (r.outcome === 'skip') {
                skippedLaunch.push(name)
                continue
            }
            if (r.outcome === 'fail') {
                return withDebts({
                    ok: false,
                    reason: `launch script: \`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`
                })
            }
            ran.push(label)
        }
        if (skippedLaunch.length > 0) {
            const notes = parseEnvNotes(await readEnvNotes(cwd)).filter(n => isExcuseNote(n.fact))
            for (const name of skippedLaunch) {
                const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
                const excuse = notes.find(n => re.test(n.fact))
                if (excuse) {
                    warnings.push(
                        `launch script \`${name}\` could not run here (environment gap) and a `
                            + `standing excuse note covers it ("${excuse.fact.slice(0, 160)}") — `
                            + `UNOBSERVED: verify it by hand before trusting the launch surface`
                    )
                }
            }
        }
    }
    if (boot) {
        const label = `${boot[0]} ${boot[1].join(' ')}`
        const expectServer = detectsServedApp(cwd, planText)
        let b = await runBootCheck(cwd, boot, bootGraceMs, {expectServer, deps: bootDeps})
        if (b.outcome === 'orphan-port') {
            b = await recoverOrphanPort(cwd, boot, b, bootGraceMs, bootDeps, expectServer)
        }
        if (b.outcome === 'fail') {
            return withDebts({ok: false, reason: `boot check: \`${label}\` ${b.detail}`})
        }
        if (b.outcome === 'orphan-port') {
            // Could not clear the port. Distinct HARNESS diagnosis, never a bare app
            // FAIL: name the port and (when known) the process squatting on it.
            const holder =
                b.port !== null ? (bootDeps.findPortHolder ?? defaultFindPortHolder)(b.port) : null
            const who =
                holder ? ` — held by an orphaned process (pid ${holder.pid}: ${holder.command})`
                : b.port !== null ? ` — port ${b.port} is held by another process`
                : ''
            return withDebts({
                ok: false,
                reason: `boot check: \`${label}\` could not bind: orphaned process / port already in use${who} (harness condition, not an app fault)`
            })
        }
        if (b.outcome === 'pass') ran.push(label)
    }
    const warningNote = warnings.length > 0 ? ` — WARNING: ${warnings.join('; WARNING: ')}` : ''
    return withDebts({
        ok: true,
        reason:
            (ran.length > 0 ?
                `statics + ${ran.map(c => `\`${c}\``).join(', ')} passed`
            :   'statics passed (integration commands not runnable here)') + warningNote
    })
}
