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
 *
 * A skip is never silent, though. A DISCOVERED boot command that never ran is its
 * own verdict (bootSkipVerdict, mx5 run 18) — nothing else the gate observed can
 * cancel it. Validation harnesses for that lever:
 *   scripts/boot-skip-baserate.ts      base rate, shipped gate, before the change
 *   scripts/boot-skip-verdict-ab.ts    two-armed deterministic A/B + invariants
 *   scripts/boot-skip-fp-suite.ts      zero-FP arms over every local repo
 */
import {spawn, spawnSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import * as net from 'node:net'
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
import {runRenderCheck, type RenderOutcome} from './render-check.js'
import {
    collectProjectEnv,
    pinnedLocalPort,
    runDeepRenderCheck,
    type DeepRenderOutcome
} from './deep-render-check.js'
import {resolveRunner, runnerEnv, isCommandNotFound} from './runner-resolve.js'
import {taskThatIntroduced} from './task-provenance.js'
import {findDanglingArtifacts, danglingGateFailureText} from './artifact-closure.js'
import {findMissingServeEntry, serveEntryGateFailureText} from './serve-entry.js'

export interface FinalGateOutcome {
    /** true → statics and every runnable integration command passed (or nothing to run). */
    ok: boolean
    /**
     * On a fail: the exact command(s), exit code(s), and output tail(s) — the
     * MECHANICAL failures only. The accept-debt note is deliberately NOT folded in
     * here (mx5 run 11): this string seeds the final-gate AUTOFIX child's prompt,
     * and a debt included there is read as an instruction — the run-11 fix child
     * `rm`'d a sibling task's verified deliverable to satisfy a recorded claim. The
     * child cannot act on text it never receives; debts travel in `debtNote`.
     * With multiple failures this is the numbered, ranked list (see `failures`).
     */
    reason: string
    /**
     * On a fail: EVERY section failure individually, ranked most load-bearing
     * first — boot/render ("the app does not serve/render") outranks any single
     * test failure. The gate runs every section and aggregates rather than
     * early-returning (mx5 run 13: a bun-test glob failure shadowed the boot +
     * render probe, so the user accepted the FAIL having only ever seen 1 failing
     * CT test while the shipped app 404'd on every non-API GET). Callers trail
     * each entry and show the full list wherever an ACCEPT decision is made.
     */
    failures?: string[]
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
    /**
     * Set (with the UNOBSERVED note) when the gate could not OBSERVE something it was
     * supposed to. Two independent triggers, either or both:
     *   - nothing dynamic ran at all — no command was discoverable, or every discovered
     *     one skipped as an environment gap (unobservedVerdict);
     *   - a served app's boot command was discovered and SKIPPED, whatever else ran
     *     (bootSkipVerdict, mx5 run 18 — test suites may not stand in for a launch).
     * `ok` is still true (the statics did pass and there is nothing to fix), but this is
     * NOT a PASS: the caller must record it as UNOBSERVED, never as "checked and fine".
     * Absent ⇒ everything the gate meant to observe, it observed.
     */
    unobserved?: string
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
 *
 * THE MANIFEST ALLOWLIST BELOW IS NARROW, AND THAT IS A KNOWN, MEASURED GAP: a
 * C++/CMake project (no package.json) and a package.json whose only script is
 * `verify` both discover NOTHING here. That outcome is now reported as UNOBSERVED
 * rather than as a PASS (see unobservedVerdict), which makes the blindness loud and
 * durable — it does not remove it. The gap itself stands.
 *
 * The obvious fix — harvest each task's own `## verified tooling` section, which
 * DOES record the missing commands — was measured on 2026-07-27 and REFUTED. That
 * section is model-authored and, despite its name, unverified: on godot-engine it
 * yields 3 commands that exit 0 and 8 that exit non-zero, six of those for purely
 * fabricated reasons (recorded without a required argument, pointing at files that
 * do not exist, naming a test runner the project does not use) — so harvesting it
 * turns that project's PASS into a FAIL citing "No scene path provided", plus ~15
 * minutes of hang. Full numbers, the reproduction rig, and why no pre-execution
 * filter can separate a fabricated command from a real one:
 * scripts/harvest-verified-tooling-step0.ts. DO NOT re-propose the harvest without
 * first fixing the PROVENANCE of `## verified tooling` (record cwd + exit code at
 * authoring time); widening this allowlist tool-by-tool is not the fix either.
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

/** Leading `FOO=bar` env assignments and `sudo`/`exec` wrappers carry no verb. */
function commandTokens(member: string): string[] {
    const t = member.trim().split(/\s+/).filter(Boolean)
    while (
        t.length > 0
        && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0]) || /^(?:sudo|exec|env)$/.test(t[0]))
    ) {
        t.shift()
    }
    return t
}

/** The chain members of a shell script body, in order (`&&`, `||`, `;`, `|`). */
function chainMembers(body: string): string[] {
    return body
        .split(/&&|\|\||;|\|/)
        .map(s => s.trim())
        .filter(s => s.length > 0)
}

/** Container/infra orchestration: `docker compose … up`, `docker-compose … up -d`,
 *  `podman-compose … up`, `docker run …`. The verb must be a bare token, so a
 *  filename like `docker-compose.dev.yml` never counts as one. */
function isContainerOrchestration(member: string): boolean {
    const t = commandTokens(member)
    if (t.length === 0) return false
    const bin = path.posix.basename(t[0])
    if (!/^(?:docker|podman|nerdctl)(?:-compose)?$/.test(bin)) return false
    const verbs = new Set(['up', 'start', 'run'])
    return t.slice(1).some(tok => verbs.has(tok))
}

const MULTIPLEXER_RE = /^(?:concurrently|npm-run-all|run-p|run-s|turbo)$/
/** A watcher that recompiles ASSETS and never listens: the tool is a
 *  bundler/compiler/preprocessor AND it is in watch mode. `bun run --watch x.ts`
 *  is deliberately NOT here — that re-executes an entrypoint, which may serve. */
const ASSET_TOOL_RE =
    /(?:^|[\s/@])(?:tailwindcss|postcss|sass|node-sass|less|stylus|esbuild|rollup|webpack|parcel|swc|babel|tsc|tsup|chokidar)(?:$|[\s"'])/
const WATCH_FLAG_RE = /(?:^|\s)(?:--watch|-w|--watch=[^\s]*)(?:\s|$)/

/** The quoted commands a multiplexer runs, or its bare script-name arguments
 *  resolved through the manifest (`run-p dev:css dev:js`). One level only. */
function multiplexerChildren(member: string, scripts: Record<string, string>): string[] {
    const quoted = [...member.matchAll(/"([^"]+)"|'([^']+)'/g)].map(m => m[1] ?? m[2])
    if (quoted.length > 0) return quoted
    const t = commandTokens(member)
        .slice(1)
        .filter(a => !a.startsWith('-'))
    return t.flatMap(name => (scripts[name] !== undefined ? [scripts[name]] : []))
}

/** Every member of the chain that could plausibly stay up and serve. Members that
 *  are one-shot setup (`mkdir`, `sleep`, an `until … done` wait loop) are not
 *  themselves launches, but they are not disqualifying either — only the two
 *  shapes below are. */
function isWatcherOnlyMultiplexer(member: string, scripts: Record<string, string>): boolean {
    const t = commandTokens(member)
    if (t.length === 0) return false
    const bin = path.posix.basename(t[0])
    const runner = /^(?:npx|bunx|pnpm|yarn|npm)$/.test(bin)
    const head =
        runner ?
            (t.slice(1).find(a => !a.startsWith('-') && a !== 'exec' && a !== 'dlx' && a !== 'run')
            ?? '')
        :   bin
    if (!MULTIPLEXER_RE.test(path.posix.basename(head))) return false
    const children = multiplexerChildren(member, scripts)
    if (children.length === 0) return false
    // Every child is an ASSET watcher ⇒ nothing in here ever listens.
    return children.every(c => ASSET_TOOL_RE.test(c) && WATCH_FLAG_RE.test(c))
}

/**
 * Why this script is NOT a launch of the shipped app, or null when it plausibly
 * is one (mx5 run 18, validated).
 *
 * Run 18's boot command resolved to `bun run dev`, whose body is
 * `docker compose -f docker-compose.dev.yml up -d && until docker compose … pg_isready
 * … && concurrently "bun run dev:css" "bun run dev:js" "bun run --watch
 * src/server/index.ts"`. The gate sandbox has no docker, so the chain died at 127 and
 * the boot SKIPPED as an environment gap — while the shipped app had no HTTP listener
 * at all. A script whose first act is `docker compose up` cannot distinguish "the app
 * is broken" from "this box has no docker", so it is not evidence either way: better
 * to discover NO boot command — reported as "nothing to boot" — and let the static
 * serve-entry check (serve-entry.ts) carry the signal, than to spend the grace window
 * producing an unfalsifiable skip.
 *
 * CONSERVATIVE AND LEXICAL BY CONSTRUCTION. Only two shapes are rejected, both
 * decidable from the script text alone:
 *   1. the chain OPENS with container orchestration (docker/podman/nerdctl … up|start|run);
 *   2. the whole body is a multiplexer (concurrently/npm-run-all/run-p/run-s/turbo)
 *      whose every child is an ASSET watcher in watch mode (tailwind/tsc/esbuild/…),
 *      i.e. nothing in it can ever listen.
 * Anything else — `vite`, `next dev`, `node dist/index.js`, `nodemon`, `bun --watch
 * src/index.ts`, and any multiplexer with one non-asset child — is accepted
 * unchanged. Deciding whether a watcher actually SERVES is not attempted here; that
 * is exactly what the static serve-entry check is for.
 */
export function nonLaunchScriptReason(
    body: string,
    scripts: Record<string, string> = {}
): string | null {
    const members = chainMembers(body)
    if (members.length === 0) return null
    if (isContainerOrchestration(members[0])) {
        return 'it opens with container orchestration, which starts infrastructure rather than the app'
    }
    if (members.every(m => isWatcherOnlyMultiplexer(m, scripts))) {
        return 'its only long-running member multiplexes asset watchers, none of which serves'
    }
    return null
}

/**
 * The project's OWN launch command, if it declares one (package.json `start`,
 * else `dev`; Makefile `run`). null means the project has nothing to boot —
 * the boot check degrades to nothing-to-run.
 *
 * A script that is not a LAUNCH at all (nonLaunchScriptReason — mx5 run 18's
 * `docker compose up` orchestrator) is rejected here and falls through to the
 * next candidate, then to null. Discovering nothing is strictly better than
 * discovering something unfalsifiable: an env-gap skip of an orchestration script
 * says nothing about the app, and null is reported as "nothing to boot".
 */
export function discoverBootCommand(cwd: string): HealthCommand | null {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        for (const name of ['start', 'dev']) {
            if (s[name] && nonLaunchScriptReason(s[name], s) === null) return ['bun', ['run', name]]
        }
        return null
    }
    if (existsSync(path.join(cwd, 'Makefile')) && makeHasTarget(cwd, 'run')) {
        return ['make', ['run']]
    }
    return null
}

/**
 * The launch script that EXISTS but was rejected as not-a-launch, if any. Without
 * this the rejection would trade run 18's unfalsifiable skip for pure silence: no
 * boot command means bootSkipVerdict has no label to name, and a project whose test
 * suite ran still reports `observed > 0`, so unobservedVerdict stays quiet too. A
 * served app whose only declared launch script cannot start it was not observed to
 * run, and must say so.
 */
export function rejectedLaunchScript(cwd: string): {name: string; reason: string} | null {
    if (!existsSync(path.join(cwd, 'package.json'))) return null
    const s = packageScripts(cwd)
    for (const name of ['start', 'dev']) {
        if (!s[name]) continue
        const reason = nonLaunchScriptReason(s[name], s)
        if (reason === null) return null // this one IS a launch — it was chosen
        return {name, reason}
    }
    return null
}

type BootOutcome =
    | {
          outcome: 'skip' | 'pass'
          /** Set when the render check could not OBSERVE the served page (no browser,
           *  undeterminable port) or its AUTHENTICATED half (no declared credentials,
           *  an undrivable sign-in form, credentials the server rejected) — surfaced
           *  by the gate as an UNOBSERVED warning. */
          renderNote?: string
          /** skip only: the boot command never spawned (ENOENT) — feeds the
           *  full-blindness guard (mx5 run 16), unlike a 127 where the runner ran. */
          spawnFailed?: boolean
      }
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
    /**
     * The (lowest) TCP port a listener owned by process group `pgid` is bound to,
     * or null when it cannot be determined. Feeds the render check's URL; injected
     * for tests, default probes ss/lsof + pgid.
     */
    groupListeningPort?: (pgid: number) => number | null
    /**
     * Load the served page once in a headless browser and judge the RENDERED DOM
     * (mx5 runs 8/11: curl cannot execute JS, so a blank-mount app passed every
     * gate). Runs only for a served app, against the live listener, before the
     * boot child is killed. Absent → the boot check behaves exactly as before;
     * the gate wires runRenderCheck by default for served apps.
     */
    renderProbe?: (url: string) => RenderOutcome
    /**
     * SIGN IN on the served page and judge the AUTHENTICATED half of the app (mx5
     * run 17). Runs only after `renderProbe` PASSED — the shallow blank-page rule
     * keeps its own RED/GREEN-proven verdict and is never shadowed by this one.
     * Absent → the boot check behaves exactly as before; the gate wires
     * runDeepRenderCheck by default for served apps. May only FAIL when the SERVER
     * itself authenticated the session (see deep-render-check.judgeDeepSession);
     * anything else — no browser, no declared credentials, an undrivable form,
     * rejected credentials — is an env gap and skips with an UNOBSERVED note.
     */
    deepRenderProbe?: (url: string) => DeepRenderOutcome | Promise<DeepRenderOutcome>
    /**
     * Can this box enumerate listeners with pids AT ALL (ss/netstat/lsof)? False
     * means the served-app requirement is UNOBSERVABLE here and must degrade to the
     * survival rule rather than fail — see canEnumerateListeners.
     */
    enumerationCapable?: () => boolean
    /**
     * Reserve a free port to hand the boot child as PORT, so an HTTP answer on it is
     * ownership evidence. null → no port could be reserved (the check then relies on
     * pgid attribution alone). Injected for tests.
     */
    pickPort?: () => Promise<number | null>
    /**
     * The port the project's own client was BUILT to call, when it declares one and
     * nothing is holding it — preferred over a freshly reserved port so the served
     * origin and the origin the client calls are the same one (see pinnedLocalPort).
     * null → use the reserved private port exactly as before.
     */
    preferredPort?: () => Promise<number | null>
    /** Does anything answer HTTP on 127.0.0.1:`port`? Injected for tests. */
    httpProbe?: (port: number) => boolean
}

/** Stamped on a PASS the boot check could not actually observe, so the trail says
 *  so out loud instead of implying the listener requirement was met. */
const UNOBSERVED_LISTENER_NOTE =
    'listener check UNOBSERVED: no socket-enumeration tool (ss/netstat/lsof) in this '
    + 'environment and the app never answered on the port it was given — passed on the '
    + 'survival rule (the process stayed up), NOT on observed serving'

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

/** `ss -tlnpH` rows → {pid, port}. Column 4 (0-based 3) is the local address; the
 *  port is its last `:`-suffixed number ("0.0.0.0:3000", "[::]:3000"). */
export function parseSsListeners(stdout: string): Array<{pid: number; port: number}> {
    const out: Array<{pid: number; port: number}> = []
    for (const line of stdout.split('\n')) {
        const pm = /pid=(\d+)/.exec(line)
        if (!pm) continue
        const local = line.trim().split(/\s+/)[3] ?? ''
        const portm = /:(\d+)$/.exec(local)
        if (!portm) continue
        out.push({pid: Number(pm[1]), port: Number(portm[1])})
    }
    return out
}

/**
 * `netstat -tlnp` rows → {pid, port} (mx5 run 14, validated: the agent-sandbox
 * image ships NEITHER ss NOR lsof — only ps and netstat — so the served-app boot
 * check could never observe a listener and failed unfalsifiably). The pid rides
 * in the trailing "PID/Program name" column ("1234/bun"); rows the kernel will
 * not attribute to us print "-" there and are skipped.
 */
export function parseNetstatListeners(stdout: string): Array<{pid: number; port: number}> {
    const out: Array<{pid: number; port: number}> = []
    for (const line of stdout.split('\n')) {
        if (!/^\s*tcp/i.test(line)) continue
        const cols = line.trim().split(/\s+/)
        const local = cols[3] ?? ''
        const portm = /:(\d+)$/.exec(local)
        if (!portm) continue
        const pidm = /^(\d+)\//.exec(cols[cols.length - 1] ?? '')
        if (!pidm) continue
        out.push({pid: Number(pidm[1]), port: Number(portm[1])})
    }
    return out
}

/** `lsof -iTCP -sTCP:LISTEN -n -P` rows → {pid, port}. */
export function parseLsofListeners(stdout: string): Array<{pid: number; port: number}> {
    const out: Array<{pid: number; port: number}> = []
    for (const line of stdout.split('\n').slice(1)) {
        const cols = line.trim().split(/\s+/)
        const pid = Number(cols[1])
        const name = cols.find(c => /:\d+$/.test(c)) ?? ''
        const portm = /:(\d+)$/.exec(name)
        if (Number.isInteger(pid) && pid > 0 && portm) {
            out.push({pid, port: Number(portm[1])})
        }
    }
    return out
}

/** The socket-enumeration tools we can attribute listeners with, in preference
 *  order: ss (richest), netstat (present where ss is not), lsof (BSD/macOS). */
const LISTENER_TOOLS: Array<{
    bin: string
    args: string[]
    parse: (stdout: string) => Array<{pid: number; port: number}>
}> = [
    {bin: 'ss', args: ['-tlnpH'], parse: parseSsListeners},
    {bin: 'netstat', args: ['-tlnp'], parse: parseNetstatListeners},
    {bin: 'lsof', args: ['-iTCP', '-sTCP:LISTEN', '-n', '-P'], parse: parseLsofListeners}
]

/** Listening TCP sockets as {pid, port} pairs (best-effort; ss, then netstat, then
 *  lsof). Empty on any failure — the caller then cannot attribute a listener to our
 *  group and the served-app check degrades to survival (never a false FAIL). */
function listeningSockets(): Array<{pid: number; port: number}> {
    for (const {bin, args, parse} of LISTENER_TOOLS) {
        try {
            const t = spawnSync(bin, args, {encoding: 'utf8', timeout: 4000})
            if (t.error || !t.stdout) continue
            const rows = parse(t.stdout)
            if (rows.length > 0) return rows
        } catch {
            // tool missing/unusable — try the next one
        }
    }
    return []
}

/**
 * Can ANY socket-enumeration tool run here at all? (mx5 run 14: the sandbox had
 * none, so `groupHasListener` returned false forever and the boot check emitted
 * "never opened a listening socket" no matter what the app did — an unfalsifiable
 * FAIL that failed a run whose app demonstrably served.) This is a CAPABILITY
 * question, deliberately separate from "did we see a listener": a tool that ran
 * and found nothing is an observation; no tool at all is blindness, and blindness
 * must degrade to the survival rule exactly like win32 — never a false FAIL on a
 * platform we cannot probe.
 *
 * "Ran" = spawned without ENOENT and either exited 0 or printed something (lsof
 * exits 1 on an empty match set; a netstat that rejects `-p` prints nothing).
 * Memoised: the answer is a property of the box, not of the run.
 */
let listenerToolCapability: boolean | null = null

export function canEnumerateListeners(): boolean {
    if (listenerToolCapability !== null) return listenerToolCapability
    listenerToolCapability = LISTENER_TOOLS.some(({bin, args}) => {
        try {
            const r = spawnSync(bin, args, {encoding: 'utf8', timeout: 4000})
            if (r.error) return false
            return r.status === 0 || (r.stdout ?? '').trim().length > 0
        } catch {
            return false
        }
    })
    return listenerToolCapability
}

/** Test seam: forget the memoised capability answer. */
export function resetListenerToolCapability(): void {
    listenerToolCapability = null
}

/**
 * A free TCP port on the loopback interface, or null if one cannot be reserved.
 * The boot check hands this to the child as PORT so that a successful HTTP
 * request to it is OWNERSHIP evidence: nobody else knows the number (mx5 runs
 * 8/10/11 — orphaned servers from earlier checks answered curl on the
 * conventional :3000 and passed checks the app had not earned).
 */
export function pickFreePort(): Promise<number | null> {
    return new Promise(resolve => {
        try {
            const srv = net.createServer()
            srv.once('error', () => resolve(null))
            srv.listen(0, '127.0.0.1', () => {
                const a = srv.address()
                const port = typeof a === 'object' && a !== null ? a.port : null
                srv.close(() => resolve(port))
            })
        } catch {
            resolve(null)
        }
    })
}

/** Can we bind 127.0.0.1:`port` right now? (Free ⇒ the boot child can have it.) */
export function isPortFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
        try {
            const srv = net.createServer()
            srv.once('error', () => resolve(false))
            srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)))
        } catch {
            resolve(false)
        }
    })
}

/**
 * The project's own declared local port, but only if nothing is holding it — the
 * default `preferredPort` for the gate. A declared port that is BUSY falls back to
 * a reserved one rather than colliding: a stranger's server on :3000 must never be
 * mistaken for the app we just booted.
 */
export async function preferredDeclaredPort(cwd: string): Promise<number | null> {
    const port = pinnedLocalPort(collectProjectEnv(cwd))
    if (port === null) return null
    return (await isPortFree(port)) ? port : null
}

/**
 * Does anything answer HTTP on 127.0.0.1:`port`? Any response at all (404, 500 —
 * a status is a listener) counts; only a connection error or timeout is a no.
 * Runs in a throwaway child of our own runtime so it needs no curl on PATH and
 * stays synchronous inside the boot poll.
 */
function defaultHttpProbe(port: number): boolean {
    const script =
        `fetch('http://127.0.0.1:${port}/').then(()=>process.exit(0),()=>process.exit(1));`
        + `setTimeout(()=>process.exit(1),2000)`
    try {
        const r = spawnSync(process.execPath, ['-e', script], {
            encoding: 'utf8',
            timeout: 5000
        })
        return !r.error && r.status === 0
    } catch {
        return false
    }
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
    for (const {pid} of listeningSockets()) {
        if (pgidOf(pid) === pgid) return true
    }
    return false
}

/** Default port lookup for the render check: the LOWEST port among the group's
 *  listeners (a dev toolchain may open an HMR socket too; the app's own server
 *  conventionally sits on the lower, configured port). Null when undeterminable. */
function defaultGroupListeningPort(pgid: number): number | null {
    const ports = listeningSockets()
        .filter(({pid}) => pgidOf(pid) === pgid)
        .map(({port}) => port)
    return ports.length > 0 ? Math.min(...ports) : null
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
 * that a listening server was expected.
 *
 * OBSERVABILITY is a precondition of that FAIL (mx5 run 14, validated). The listener
 * requirement needs pgid-attributed socket enumeration; win32 has none, and neither
 * does a Linux image shipping no ss/netstat/lsof — run 14's sandbox was exactly that,
 * so the check emitted "never opened a listening socket" against an app that
 * demonstrably served, three autofix passes could not falsify it, and the run was
 * recorded failed. Two defences, in order:
 *
 *   - the child is spawned with a freshly reserved, otherwise-unused PORT, and an
 *     HTTP answer on THAT port proves a listener regardless of tooling. The private
 *     port is what makes the HTTP probe trustworthy: an orphaned server from an
 *     earlier check answers on :3000, but nobody else knows this number.
 *   - if nothing can enumerate listeners AND the assigned port never answered, the
 *     served-app requirement is unobservable here, so `expectServer` collapses to
 *     the survival rule and the PASS is stamped UNOBSERVED. An app that ignores PORT
 *     is indistinguishable from one that never listened — an observer limitation,
 *     not an app defect, and it may not be reported as one.
 *
 * A child that EXITS non-zero still FAILs in every environment: "the process died"
 * needs no socket probe, so run 14's original true positive (a `--hot` runtime
 * pinning a crashed app) stays reportable wherever the tooling exists.
 *
 * Env-gap contract as everywhere: spawn error (ENOENT) or a command-not-found
 * inside the chain (exit 127, or the runner's own wording where the platform
 * reports it that way — see isCommandNotFound) → skip.
 */
export async function runBootCheck(
    cwd: string,
    [bin, args]: HealthCommand,
    graceMs = 10_000,
    opts: {expectServer?: boolean; deps?: BootDeps} = {}
): Promise<BootOutcome> {
    const expectServer = (opts.expectServer ?? false) && process.platform !== 'win32'
    const groupHasListener = opts.deps?.groupHasListener ?? defaultGroupHasListener
    const httpProbe = opts.deps?.httpProbe ?? defaultHttpProbe
    const canEnumerate =
        expectServer ? (opts.deps?.enumerationCapable ?? canEnumerateListeners)() : true
    // Only served apps get an assigned port: a CLI project has nothing to bind, and
    // an unexpected PORT in its env is noise.
    // The app's OWN declared local port wins when it is free (see pinnedLocalPort):
    // a client whose base URL was baked in at build time calls that origin and no
    // other, so serving it anywhere else makes the whole authenticated half
    // unobservable. Anything else — no declaration, a port already held — falls back
    // to the freshly reserved private port that run 14's ownership evidence needs.
    const noPreference = (): Promise<number | null> => Promise.resolve(null)
    const preferred = expectServer ? await (opts.deps?.preferredPort ?? noPreference)() : null
    const assignedPort =
        preferred ?? (expectServer ? await (opts.deps?.pickPort ?? pickFreePort)() : null)
    // Runner resolution (mx5 run 16): same contract as runGateCommand — resolve
    // the runner and carry its directory on PATH so the boot script's own chain
    // can re-invoke it.
    const runner = resolveRunner(bin)
    return new Promise(resolve => {
        const child = spawn(runner.bin, args, {
            cwd,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...runnerEnv(runner),
                ...(assignedPort !== null ? {PORT: String(assignedPort)} : {})
            }
        })
        // Best-effort cleanup only: killGroup below can silently fail to reap the
        // process (platform/sandbox-specific — observed on a GH Actions Linux
        // runner where the group-kill did not take, hanging the whole `bun test
        // --isolate` run on the leaked child's piped stdio). unref() so a child
        // we already tried to kill can never itself keep this process alive.
        child.unref()
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
        const passAndKill = (renderNote?: string) => {
            settle(renderNote ? {outcome: 'pass', renderNote} : {outcome: 'pass'})
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), 2_000).unref()
        }
        const failAndKill = (detail: string) => {
            settle({outcome: 'fail', detail})
            killGroup('SIGTERM')
            setTimeout(() => killGroup('SIGKILL'), 2_000).unref()
        }
        // Served apps only: poll for a listening socket owned by our process group.
        // As soon as one appears the boot has demonstrably served → run the render
        // check against the LIVE listener (mx5 runs 8/11: a listener that serves a
        // permanently blank page passed every curl-shaped check), then PASS/FAIL.
        // The probe is spawnSync, so the interval cannot re-enter mid-check.
        // The deep probe is asynchronous (it drives a browser session), so the
        // interval body must not re-enter while one is in flight — a second session
        // would race the first for the same still-booting child.
        let probing = false
        const poll =
            expectServer ?
                setInterval(() => {
                    if (settled || probing || !child.pid) return
                    // pgid attribution first (precise, cheap). If it saw nothing — or
                    // cannot see anything here — fall back to the private assigned
                    // port: an HTTP answer on a number only this child was told is
                    // proof of OUR listener, not of some orphan on :3000.
                    const byGroup = canEnumerate && groupHasListener(child.pid)
                    const byPort = !byGroup && assignedPort !== null && httpProbe(assignedPort)
                    if (!byGroup && !byPort) return
                    listenerSeen = true
                    const probe = opts.deps?.renderProbe
                    if (!probe) return passAndKill()
                    const port =
                        byGroup ?
                            (opts.deps?.groupListeningPort ?? defaultGroupListeningPort)(child.pid)
                        :   assignedPort
                    if (port === null) {
                        return passAndKill(
                            'render check UNOBSERVED: a listener was seen but its port could not be determined'
                        )
                    }
                    const url = `http://127.0.0.1:${port}/`
                    const rr = probe(url)
                    if (rr.outcome === 'fail') {
                        return failAndKill(`listens on :${port} but ${rr.detail}`)
                    }
                    const deep = opts.deps?.deepRenderProbe
                    if (rr.outcome !== 'pass' || !deep) {
                        return passAndKill(
                            rr.outcome === 'skip' ?
                                `render check UNOBSERVED: ${rr.note}`
                            :   undefined
                        )
                    }
                    // The page renders. Now sign in and prove the AUTHENTICATED half
                    // is alive (mx5 run 17): the server accepted the login and the
                    // client never used it. Async, so the interval is held off by
                    // `probing` until this settles.
                    probing = true
                    void Promise.resolve(deep(url)).then(
                        dr => {
                            if (settled) return
                            if (dr.outcome === 'fail') {
                                return failAndKill(`listens on :${port} but ${dr.detail}`)
                            }
                            passAndKill(
                                dr.outcome === 'skip' ?
                                    `authenticated render check UNOBSERVED: ${dr.note}`
                                :   undefined
                            )
                        },
                        () => {
                            // The deep probe may never fail the gate on its own fault.
                            if (!settled) passAndKill()
                        }
                    )
                }, 500)
            :   null
        const onGrace = (): void => {
            // A browser session in flight outlives the grace window by design (it
            // signs in and waits for the app's data calls). Settling here would kill
            // the server under it and discard its verdict, so the window re-arms
            // until the probe resolves — which it always does, on its own hard
            // timeout (DEEP_RENDER_TIMEOUT_MS).
            if (probing) {
                timer = setTimeout(onGrace, 500)
                return
            }
            if (expectServer && !listenerSeen) {
                // Blind here (no enumeration tool, and the assigned port never
                // answered) ⇒ we cannot tell "never listened" from "ignores PORT".
                // Survival rule, stamped UNOBSERVED — an observer limitation is not
                // an app defect (mx5 run 14).
                if (!canEnumerate) return passAndKill(UNOBSERVED_LISTENER_NOTE)
                settle({
                    outcome: 'fail',
                    detail: `still running after ${graceMs}ms but never opened a listening socket — the spec/dependencies promise an HTTP server`
                })
                killGroup('SIGTERM')
                setTimeout(() => killGroup('SIGKILL'), 2_000).unref()
                return
            }
            passAndKill()
        }
        let timer = setTimeout(onGrace, graceMs)
        child.on('error', () => settle({outcome: 'skip', spawnFailed: true}))
        child.on('exit', (status, signal) => {
            if (status === 0) {
                if (expectServer && !listenerSeen) {
                    if (!canEnumerate) {
                        return settle({outcome: 'pass', renderNote: UNOBSERVED_LISTENER_NOTE})
                    }
                    return settle({
                        outcome: 'fail',
                        detail:
                            'exited 0 without ever opening a listening socket — the spec/dependencies '
                            + 'promise an HTTP server, so a boot that serves nothing is not a launch'
                    })
                }
                return settle({outcome: 'pass'})
            }
            // Command-not-found inside the boot chain — 127 on a posix shell, or
            // the runner's own wording where it isn't (Windows bun exits 1). Either
            // way the boot never RAN, so it is an environment gap, not an app fault.
            if (
                isCommandNotFound(status, `${out}\n${err}`)
                || (status === null && signal === null)
            ) {
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
):
    | {
          outcome: 'skip'
          /** true → the runner binary never spawned (ENOENT). Distinct from a
           *  tool-level gap (127 inside the chain, missing browser, timeout),
           *  where the runner demonstrably RAN: only spawn failures feed the
           *  full-blindness guard (mx5 run 16 — see observabilityGapFailure). */
          spawnFailed: boolean
      }
    | {outcome: 'pass'}
    | {outcome: 'fail'; status: number; tail: string} {
    // Runner resolution (mx5 run 16): a login-shell-stripped PATH left `bun`
    // unspawnable, so every dynamic check skipped and the gate went blind. The
    // resolved binary is spawned, and its directory rides on the child's PATH so
    // the SCRIPT CHAIN can re-invoke the runner (`bun run test` runs `bun test`
    // inside — a bare 127 there is the same blindness one level down).
    // env passed explicitly: bun's spawnSync resolves the binary against a
    // startup snapshot of the environment, not the live process.env.
    const runner = resolveRunner(bin)
    const r = spawnSync(runner.bin, args, {
        cwd,
        encoding: 'utf8',
        timeout: timeoutMs,
        env: runnerEnv(runner)
    })
    if (r.error) return {outcome: 'skip', spawnFailed: true}
    if (r.status === null) return {outcome: 'skip', spawnFailed: false}
    if (r.status !== 0) {
        const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
        if (isCommandNotFound(r.status, output)) return {outcome: 'skip', spawnFailed: false}
        if (ENV_GAP_OUTPUT_RE.test(output)) return {outcome: 'skip', spawnFailed: false}
        if (extraGapRe?.test(output)) return {outcome: 'skip', spawnFailed: false}
        return {outcome: 'fail', status: r.status, tail: outputTail(r.stdout ?? '', r.stderr ?? '')}
    }
    return {outcome: 'pass'}
}

/**
 * The full-skip blindness guard (mx5 run 16, validated): dynamic commands were
 * DISCOVERED but every single one skipped as an environment gap, so the gate
 * decided on statics alone and stamped a permanently blank app green. Per-command
 * env-gap skips stay legitimate (a missing browser must not fail a suite); what
 * may never happen again is ALL of them skipping while the gate still reports
 * PASS — a gate that observed nothing dynamic has no basis to vouch for the
 * assembled app. Pure so the semantics are unit-tested; the caller feeds it the
 * attempt/observation counters and runner resolvability.
 */
export function observabilityGapFailure(args: {
    /** Dynamic commands the gate discovered and tried to run. */
    attempted: number
    /** Of those, how many it actually OBSERVED (a real pass OR a real fail —
     *  either proves the command ran; only skips observe nothing). */
    observed: number
    /** Of the skips, how many were SPAWN failures (runner never ran, ENOENT).
     *  Tool-level gaps (missing browser, 127 inside the chain, timeout) prove
     *  the runner itself works and keep the classic env-gap contract — the
     *  blindness class fires only when EVERY attempt failed to even spawn. */
    spawnFailures: number
    /** Distinct runner bins across the attempted commands. */
    runnerBins: string[]
    /** Is this runner spawnable (bare or via a known install location)? */
    runnerResolvable: (bin: string) => boolean
}): string | null {
    if (args.attempted === 0 || args.observed > 0) return null
    if (args.spawnFailures < args.attempted) return null
    const unresolvable = args.runnerBins.filter(b => !args.runnerResolvable(b))
    const runnerNote =
        unresolvable.length > 0 ?
            ` — the project's own runner ${unresolvable
                .map(b => `\`${b}\``)
                .join(', ')} is not spawnable here (not on PATH nor any known install location)`
        :   ''
    return (
        `observability gap: ${args.attempted} integration/boot command(s) exist but NONE `
        + `could even spawn in this environment${runnerNote}; `
        + `the gate observed nothing dynamic and cannot vouch for the assembled app`
    )
}

/**
 * The THIRD verdict. observabilityGapFailure above covers "commands were DISCOVERED
 * but every one failed to spawn" — a rank-0 FAIL. It deliberately returns null for
 * `attempted === 0`, and until now that silence fell straight through to
 * `PASS — no integration command found (statics passed)`: the run-16 blindness class
 * entering through a different door, where "we never checked" reads exactly like "we
 * checked and it was fine". Measured 2026-07-27: IAR1 (C++/CMake, no package.json)
 * shipped that verdict TWICE while carrying 2 and 3 open verify-FAIL debts, and
 * godot-engine (package.json whose only script is `verify`) reproduces it live today.
 *
 * So: observed anything dynamic ⇒ PASS; discovered-but-all-spawn-failed ⇒ the
 * existing FAIL; observed NOTHING ⇒ this note, carried on an `ok: true` outcome.
 *
 * WHY NON-BLOCKING (decided, not deferred — the evidence cuts both ways and this is
 * the resolution):
 *  - Blocking's case: both real occurrences also carried open verify-FAIL debt, so
 *    the runs with no dynamic evidence were exactly the runs already known to be
 *    carrying defects.
 *  - Against, and decisive: (1) that debt is ALREADY surfaced unconditionally at the
 *    gate moment, on PASS as on FAIL — the IAR1 records literally read "PASS — no
 *    integration command found … UNRESOLVED VERIFY-FAIL DEBT still open (2)". The
 *    missing signal was never the debt, it was the word PASS endorsing the run, and
 *    that is what this fixes. (2) `ok: false` routes into the autofix picker, whose
 *    seed is `reason`; "no integration command is discoverable" is not fixable by
 *    editing code, so the highest-probability child response is to FABRICATE a
 *    runnable command to satisfy the gate — the same fabrication class that refuted
 *    the `## verified tooling` harvest (see discoverIntegrationCommands) and that had
 *    run 11's fix child `rm` a sibling's deliverable. (3) That harvest being refuted
 *    means IAR1 and godot-engine can NEVER discover a command, so blocking would end
 *    every non-npm run in `failed` permanently, with no remedy — the task's own I3
 *    ("show blocking does not block IAR1/godot post-Task-1") is unsatisfiable, and
 *    its stated consequence is to downgrade to a warning and say so. This is that.
 * The teeth are elsewhere and are real: the verdict word changes, the gate trail says
 * UNOBSERVED, and the caller records a durable final-gate debt that the NEXT run's
 * gate re-surfaces (it can never auto-close — it is not static-class).
 */
export function unobservedVerdict(args: {
    /** Dynamic commands the gate discovered and tried to run (0 ⇒ nothing existed). */
    discovered: number
    /** Of those, how many actually RAN (a real pass or a real fail). */
    observed: number
}): string | null {
    if (args.observed > 0) return null
    // Kept short ON PURPOSE: the run-level trail line slices the reason at 300 chars,
    // and the whole point of this verdict is that the durable record carries it.
    const why =
        args.discovered === 0 ?
            'no integration, lockfile or boot command was discoverable here, so the gate ran '
            + 'nothing at all'
        :   `all ${args.discovered} discovered command(s) skipped as environment gaps, so the `
            + 'gate ran nothing observable'
    return (
        `UNOBSERVED — NOT a pass: ${why}; statics passed, but this run produced NO evidence `
        + 'that the assembled product builds, boots or works.'
    )
}

/**
 * The SAME third verdict, at the door unobservedVerdict cannot reach: the boot
 * check specifically (mx5 run 18, validated).
 *
 * Run 18 shipped an app with no HTTP server behind a converged final gate. Its
 * `src/server/index.ts` ends at `export {app}` — no `Bun.serve`, no
 * `export default app`, no `start` script — so `bun run src/server/index.ts` exits
 * 0 immediately and the product cannot be started at all. The gate's boot command
 * resolved to `bun run dev`, whose body begins `docker compose … up -d`; the gate
 * sandbox had no docker, so the boot SKIPPED as an environment gap. Skips
 * contribute nothing to `dynObserved`, and `bun run test`, `test:ct`, `build`,
 * `lint`, `seed` and `migrate` all ran — so `dynObserved > 0`, the full-skip
 * blindness guard (observabilityGapFailure) stayed correctly quiet, and the trail
 * read `final-gate: autofix converged — statics + … passed` with 24/24 tasks green.
 *
 * The defect is that "the app was never observed to boot" and "the app booted
 * fine" produced BYTE-IDENTICAL gate output. That is the class scripts/ab-verdict.ts
 * exists to kill one layer up: absence of evidence rendered in the shape of
 * evidence. So a discovered-but-skipped boot now names itself, and — unlike every
 * other skip — it CANNOT be cancelled by observations from other commands.
 * Component tests are the trap here, not the alibi: run 18 had 51 green Playwright
 * CT tests, and CT mounts components in a browser without ever assembling or
 * starting the server.
 *
 * DECIDED, do not silently re-open:
 *  - NOT a FAIL. A boot skip on a docker-less box is a genuine environment gap, and
 *    failing it re-creates run 16's unfalsifiable-FAIL mistake pointing the other
 *    way. UNOBSERVED blocks nothing while being loud and durable (the caller records
 *    it as final-gate debt the next run re-surfaces), and it keeps "boot never ran"
 *    out of the autofix child's seed — a child cannot fix a missing docker, so the
 *    highest-probability response would be to FABRICATE a bootable command, the
 *    class that refuted the `## verified tooling` harvest.
 *  - BOTH skip flavours count. Run 18's skip carried `spawnFailed: false` (127 inside
 *    the script chain, not an ENOENT on the runner), so keying off spawnFailed would
 *    have missed the actual defect.
 *  - SERVED APPS ONLY. `expectServer === false` (a CLI/library project) is fenced off
 *    deliberately: a CLI whose `dev` script needs an absent tool has no server to be
 *    unobserved, and widening the lever there buys warnings nobody can act on.
 */
export function bootSkipVerdict(args: {
    /** `bin args…` of the DISCOVERED boot command; null ⇒ nothing to boot, which is
     *  not the same thing as a boot that was not observed. */
    label: string | null
    /** Did the boot check end in `skip` (either flavour)? */
    skipped: boolean
    /** Does this project stand up an HTTP server (detectsServedApp)? */
    expectServer: boolean
}): string | null {
    if (args.label === null || !args.skipped || !args.expectServer) return null
    // Deliberately short: the run-level trail slices the reason at 300 chars and this
    // note leads it, so the command name always survives.
    return (
        `boot check: \`${args.label}\` NEVER RAN (environment gap) — the app was not observed `
        + 'to start, and no test suite substitutes for that.'
    )
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

// File → introducing-task provenance moved to task-provenance.ts (mx5 run-12
// PROMPT 2 extracted it for the cross-task deletion guards); re-exported so
// existing importers keep working.
export {taskThatIntroduced}

/**
 * Run the final gate: static analysis first, then the lockfile consistency
 * checks, then the discovered integration commands, then one boot exercise of
 * the start command — whole-repo, verbatim, unaided. Deterministic (no model).
 *
 * EVERY section runs and failures AGGREGATE (mx5 run 13): the gate used to
 * early-return on the first failing section, and the boot + render probe — built
 * after run 11 exactly for "app serves blank/nothing" — was ordered last, so any
 * earlier failure shadowed the most load-bearing signal. Run 13's user accepted
 * the FAIL having seen only 1 failing CT test while the app 404'd on every
 * non-API GET; boot/render never executed in any attempt. Now the outcome
 * carries the full ranked failure list (boot/render first — "the app does not
 * serve/render" outranks any single test), the ACCEPT decision is made on all of
 * it, and autofix converges only when the whole list is empty. Per-section
 * env-gap/INFRA_GAP skip semantics and orphan-port recovery are unchanged.
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
        staticOk: stat.ok,
        // Cross-task-deletion debts auto-close iff the deleted file is back in the
        // tree — a deterministic existence check, corroborating the per-file
        // provenance the record already carries.
        fileExists: rel => existsSync(path.join(cwd, rel))
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
    // Aggregated failures across ALL sections (mx5 run 13 — see the function doc).
    // rank 0 = boot/render ("does not serve/render" is the most load-bearing
    // signal); rank 1 = everything else, kept in execution order by stable sort.
    const failures: Array<{rank: number; text: string}> = []
    const fail = (text: string, rank = 1): void => {
        failures.push({rank, text})
    }
    if (!stat.ok) fail(`static checks: ${stat.reason}`)
    // Launch-contract diff (mx5 run 10 item 4): the design declared `migrate`/`seed`
    // scripts that fell through decompose and shipped missing, unchecked. Diff the
    // plan-time-extracted declared scripts against the manifest; a missing one is a
    // launch-surface defect. FP-safe: empty declared list (nothing grounded) → no check.
    const declared = await readDeclaredScripts(cwd)
    if (declared.length > 0) {
        const missing = missingDeclaredScripts(declared, Object.keys(packageScripts(cwd)))
        if (missing.length > 0) {
            fail(
                `launch contract: the design declares script(s) the shipped package.json does not expose: ${missing.join(', ')} (declared: ${declared.join(', ')})`
            )
        }
    }
    // Serve-entry closure (mx5 run 18, nexttask 2B): the tree builds a server app,
    // expects to serve (SPA fallback / static read / a design clause), and NOTHING
    // anywhere starts a listener — `src/server/index.ts` ended at `export {app}`, so
    // the product could not be started at all while every dynamic probe went blind on
    // a docker-less box. Static, deterministic, milliseconds, and — unlike the boot
    // check — decidable in exactly the environment where the boot skipped. Rank 0:
    // "the app cannot be started" is the same load-bearing class as boot/render.
    // Placed BEFORE the zero-discovery early return on purpose: a project with no
    // runnable command at all must still fail this, not report UNOBSERVED.
    try {
        const noServeEntry = findMissingServeEntry(cwd, planText)
        if (noServeEntry) fail(serveEntryGateFailureText(noServeEntry), 0)
    } catch {
        // best-effort scan — a scanner fault must never break the gate
    }
    const lockCmds = discoverLockfileChecks(cwd)
    const {cmds} = discoverIntegrationCommands(cwd)
    const boot = discoverBootCommand(cwd)
    // ZERO DISCOVERY IS UNOBSERVED, NEVER A PASS (see unobservedVerdict). Nothing was
    // discovered, so nothing ran, so observabilityGapFailure (attempted === 0 → null) does
    // not fire — and this outcome used to be reported as `PASS — no integration command
    // found (statics passed)`, i.e. "we never checked" reading identically to "we checked
    // and it was fine". IAR1 shipped that verdict TWICE while carrying open verify-FAIL
    // debt (its .pi-tasks/TASK_AUTO_0001.md:31 and TASK_AUTO_0002.md:37). The outcome stays
    // `ok: true` (non-blocking, justified at unobservedVerdict) but is now labelled, trailed
    // and carried as debt by the caller. It needs no new command source, so unlike the
    // harvest lever refuted at discoverIntegrationCommands it cannot inject a fabricated
    // failure.
    if (lockCmds.length === 0 && cmds.length === 0 && !boot && failures.length === 0) {
        const note = unobservedVerdict({discovered: 0, observed: 0}) ?? ''
        return withDebts({ok: true, unobserved: note, reason: note})
    }
    const ran: string[] = []
    // Full-skip blindness counters (mx5 run 16): every dynamic spawn counts an
    // attempt; a real pass OR a real fail counts an observation; skips observe
    // nothing. If everything discovered ends up skipped, observabilityGapFailure
    // turns the silence into a rank-0 failure instead of a static-only PASS.
    let dynAttempted = 0
    let dynObserved = 0
    let dynSpawnFailures = 0
    const dynBins = new Set<string>()
    for (const {prefix, list} of [
        {prefix: 'lockfile check: ', list: lockCmds},
        {prefix: '', list: cmds}
    ]) {
        for (const cmd of list) {
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            dynAttempted += 1
            dynBins.add(cmd[0])
            const r = runGateCommand(cwd, cmd, timeoutMs)
            if (r.outcome === 'skip') {
                if (r.spawnFailed) dynSpawnFailures += 1
                continue
            }
            dynObserved += 1
            if (r.outcome === 'fail') {
                fail(`${prefix}\`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`)
                continue
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
        // A declared script the manifest doesn't expose is already a launch-contract
        // failure above; executing it too would double-report (pre-aggregation the
        // contract diff early-returned, so this loop could assume presence).
        const present = new Set(Object.keys(packageScripts(cwd)).map(s => s.toLowerCase()))
        for (const name of runnableDeclaredScripts(declared, covered)) {
            if (!present.has(name.toLowerCase())) continue
            const cmd: HealthCommand = ['bun', ['run', name]]
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            dynAttempted += 1
            dynBins.add(cmd[0])
            const r = runGateCommand(cwd, cmd, Math.min(timeoutMs, 180_000), INFRA_GAP_OUTPUT_RE)
            if (r.outcome === 'skip') {
                if (r.spawnFailed) dynSpawnFailures += 1
                skippedLaunch.push(name)
                continue
            }
            dynObserved += 1
            if (r.outcome === 'fail') {
                fail(
                    `launch script: \`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`
                )
                continue
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
    // Boot + render ALWAYS runs (mx5 run 13): it is independent of test results by
    // construction, and it carries the run's most load-bearing signal — earlier
    // failures no longer shadow it. Its failures rank FIRST in the aggregate.
    // A boot that never RAN is its own verdict (mx5 run 18 — see bootSkipVerdict);
    // it lives outside the dynObserved counters on purpose, so the test/build
    // commands that did run cannot cancel it.
    let bootUnobserved: string | null = null
    if (boot) {
        const label = `${boot[0]} ${boot[1].join(' ')}`
        dynAttempted += 1
        dynBins.add(boot[0])
        const expectServer = detectsServedApp(cwd, planText)
        // Render check (mx5 runs 8/11): for a served app, load the live page in a
        // headless browser and judge the RENDERED DOM — curl can't run JS, so a
        // blank-mount app passed every prior "renders" check. Default to the real
        // probe; tests inject their own. runRenderCheck env-gap-SKIPs when no
        // browser exists, so a box without one never gets a false FAIL.
        // Authenticated deep-render check (mx5 run 17): the page above renders, so
        // now sign in with the account the project's own dotenv declares (the same
        // ADMIN_PHONE/ADMIN_PASSWORD the launch contract's seed step consumes) and
        // require the session to actually work. WEB-ONLY by construction — it hangs
        // off the served-app branch and never runs for C++, Godot, CLI or library
        // projects. It may only FAIL when the SERVER authenticated us; no browser,
        // no credentials, an undrivable form or rejected credentials all skip as
        // env gaps (judgeDeepSession).
        const bootDepsWithRender: BootDeps = {
            ...bootDeps,
            renderProbe: bootDeps.renderProbe ?? runRenderCheck,
            deepRenderProbe: bootDeps.deepRenderProbe ?? (url => runDeepRenderCheck(url, cwd)),
            preferredPort: bootDeps.preferredPort ?? (() => preferredDeclaredPort(cwd))
        }
        let b = await runBootCheck(cwd, boot, bootGraceMs, {
            expectServer,
            deps: bootDepsWithRender
        })
        if (b.outcome === 'orphan-port') {
            b = await recoverOrphanPort(cwd, boot, b, bootGraceMs, bootDepsWithRender, expectServer)
        }
        if (b.outcome !== 'skip') dynObserved += 1
        else if (b.spawnFailed) dynSpawnFailures += 1
        bootUnobserved = bootSkipVerdict({
            label,
            skipped: b.outcome === 'skip',
            expectServer
        })
        if (b.outcome === 'fail') {
            fail(`boot check: \`${label}\` ${b.detail}`, 0)
        } else if (b.outcome === 'orphan-port') {
            // Could not clear the port. Distinct HARNESS diagnosis, never a bare app
            // FAIL: name the port and (when known) the process squatting on it.
            const holder =
                b.port !== null ? (bootDeps.findPortHolder ?? defaultFindPortHolder)(b.port) : null
            const who =
                holder ? ` — held by an orphaned process (pid ${holder.pid}: ${holder.command})`
                : b.port !== null ? ` — port ${b.port} is held by another process`
                : ''
            fail(
                `boot check: \`${label}\` could not bind: orphaned process / port already in use${who} (harness condition, not an app fault)`,
                0
            )
        } else if (b.outcome === 'pass') {
            ran.push(label)
            // A listener that served, but whose page could not be OBSERVED to render
            // (no browser, undeterminable port) → UNOBSERVED warning, not a silent pass.
            if (b.renderNote) warnings.push(b.renderNote)
        }
    } else {
        // Nothing to boot — but if the reason is that the project's only launch
        // script was REJECTED as not-a-launch (2A), that is not the same thing as a
        // project with no launch surface, and it must not degrade into silence.
        const rejected = rejectedLaunchScript(cwd)
        if (rejected && detectsServedApp(cwd, planText)) {
            bootUnobserved =
                `boot check: this project's only launch script (\`${rejected.name}\`) is not a `
                + `launch — ${rejected.reason} — so nothing was started and the app was never `
                + 'observed to run.'
        }
    }
    // Full-skip blindness guard (mx5 run 16): commands were discovered but every
    // one skipped → rank-0 failure, never a static-only PASS. Runner resolvability
    // is checked through resolveRunner so the failure text can name the missing
    // runner when that is the cause (the run-16 shape: login-shell PATH lost bun).
    const gap = observabilityGapFailure({
        attempted: dynAttempted,
        observed: dynObserved,
        spawnFailures: dynSpawnFailures,
        runnerBins: [...dynBins],
        runnerResolvable: b => resolveRunner(b).ok
    })
    if (gap) fail(gap, 0)
    // Artifact-production closure (mx5 run 13, PROMPT 2): a runtime file
    // reference with NO producer anywhere ships silently — the server read
    // `Bun.file('dist/index.html')` while the build emitted only app.css +
    // main.js, so every non-API GET 404'd behind 32/32 green checkoffs.
    // Deterministic scan of the shipped tree (literal refs only, positive
    // producer evidence required — see artifact-closure.ts); each dangle is a
    // ranked failure naming referencer + missing path. Rank 0: "the app cannot
    // serve what it references" is the same load-bearing class as boot/render.
    try {
        for (const d of findDanglingArtifacts(cwd)) fail(danglingGateFailureText(d), 0)
    } catch {
        // best-effort scan — a scanner fault must never break the gate
    }
    if (failures.length > 0) {
        // Stable sort: boot/render (rank 0) leads, everything else keeps execution
        // order. One failure keeps the exact single-failure wording; several become
        // a numbered list so the trail, the ACCEPT picker, and the autofix seed all
        // carry the complete ranked picture.
        const texts = [...failures].sort((a, b) => a.rank - b.rank).map(f => f.text)
        return withDebts({
            ok: false,
            reason:
                texts.length === 1 ?
                    texts[0]
                :   `${texts.length} failures (ranked, most load-bearing first):\n${texts
                        .map((t, i) => `${i + 1}. ${t}`)
                        .join('\n')}`,
            failures: texts
        })
    }
    const warningNote = warnings.length > 0 ? ` — WARNING: ${warnings.join('; WARNING: ')}` : ''
    // The same three-way verdict at the other zero-observation door: commands WERE
    // discovered, none spawn-failed (so the run-16 guard correctly stayed silent — every
    // skip was a tool-level env gap), and yet nothing ran. That was `statics passed
    // (integration commands not runnable here)`, which is the identical "we never checked"
    // silence wearing different words. Unchanged when anything at all was observed, so a
    // project with runnable commands is byte-for-byte unaffected.
    // Two independent UNOBSERVED notes, either or both of which may apply: the boot
    // never ran (run 18), and/or NOTHING dynamic ran at all. The boot note leads
    // because it names a concrete command and the trail line is sliced at 300 chars.
    const unobserved = [
        bootUnobserved,
        unobservedVerdict({discovered: dynAttempted, observed: dynObserved})
    ]
        .filter(n => n !== null)
        .join(' ')
    return withDebts({
        ok: true,
        ...(unobserved ? {unobserved} : {}),
        reason:
            (unobserved ? `${unobserved} — ` : '')
            + (ran.length > 0 ?
                `statics + ${ran.map(c => `\`${c}\``).join(', ')} passed`
            :   'statics passed (integration commands not runnable here)')
            + warningNote
    })
}
