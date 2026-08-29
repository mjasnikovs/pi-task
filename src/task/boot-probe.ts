/**
 * boot-probe — does the assembled product actually START, and does the page it
 * serves actually render?
 *
 * Its one consumer is final-gate.ts, which imports twelve names from here, calls
 * `discoverBootCommand` at three sites and `runBootSection` at one, and re-exports
 * six of them plus `BootSectionVerdict` for its own callers.
 *
 * The entry points are `discoverBootCommand`, `detectsServedApp`, `runBootCheck`,
 * `runBootSection` and `bootSkipVerdict`. Much else is exported too — the three
 * listener parsers, the port helpers (`pickFreePort`, `isPortFree`,
 * `preferredDeclaredPort`), `canEnumerateListeners`, `defaultFindPortHolder`,
 * `recoverOrphanPort`, `rejectedLaunchScript` — because the gate or their own
 * tests reach for them. Only the pgid helpers, the HTTP evidence probe, the reap
 * and the spawn/teardown defaults are private.
 *
 * The boot check is deliberately NOT a CLOSURE_SCANS row (final-gate.ts): it is an
 * async, stateful, port-binding exercise, and every row would need its own escape
 * hatch.
 */
import {spawn, spawnSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'
import type {RenderOutcome} from './render-check.js'
import {runRenderCheck} from './render-check.js'
import {resolveRunner, runnerEnv, isCommandNotFound} from './runner-resolve.js'
import {outputTail} from './command-run.js'
import {packageScripts, makeHasTarget} from './launch-manifest.js'
import {
    collectProjectEnv,
    pinnedLocalPort,
    runDeepRenderCheck,
    type DeepRenderOutcome
} from './deep-render-check.js'
import type {HealthCommand} from './repo-health-check.js'

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
 * is one.
 *
 * A boot command can resolve to `bun run dev`, whose body is
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
 * decidable from the script text alone, and both run against every case named
 * below:
 *   1. the chain OPENS with container orchestration (docker/podman/nerdctl … up|start|run);
 *   2. the whole body is a multiplexer (concurrently/npm-run-all/run-p/run-s/turbo)
 *      whose every child is an ASSET watcher in watch mode (tailwind/tsc/esbuild/…),
 *      i.e. nothing in it can ever listen.
 * Anything else — `vite`, `next dev`, `node dist/index.js`, `nodemon`, `bun run
 * --watch src/index.ts`, and any multiplexer with one non-asset child — is accepted
 * unchanged. All of those were run and accepted; so was a bare
 * `tailwindcss … --watch`, which is only rejected INSIDE a multiplexer. A chain
 * opening `docker compose … up` is rejected even when a real launch follows it,
 * while `bun run docker-compose.dev.yml` is accepted, since the verb must be a
 * bare token.
 *
 * Deciding whether a watcher actually SERVES is not attempted here; that is exactly
 * what the static serve-entry check is for.
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
 * A script that is not a LAUNCH at all (nonLaunchScriptReason — an
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
 * this the rejection would trade an unfalsifiable skip for pure silence: no
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
           *  full-blindness guard, unlike a 127 where the runner ran. */
          spawnFailed?: boolean
      }
    | {outcome: 'fail'; detail: string}
    // An address-already-in-use bind failure: the app code is fine, a process is
    // sitting on the port (a gate child's orphaned `bun run dev` holding
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
     * served-app boot check: a watcher (`dev` = tailwind/bundler
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
     * (curl cannot execute JS, so a blank-mount app passes every
     * gate). Runs only for a served app, against the live listener, before the
     * boot child is killed. Absent → the boot check behaves exactly as before;
     * the gate wires runRenderCheck by default for served apps.
     */
    renderProbe?: (url: string) => RenderOutcome
    /**
     * SIGN IN on the served page and judge the AUTHENTICATED half of the app.
     * Runs only after `renderProbe` PASSED — the shallow blank-page rule
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
    /**
     * Spawn the boot child. THE SUBJECT of this check, and the one thing `BootDeps`
     * did not seam.
     *
     * Nine fields above inject something the check LOOKS AT; `spawn` was imported
     * directly, so the ~220-line state machine below — seven locals threaded by
     * closure, four `BootOutcome` kinds, five exit arms — was reachable only through
     * a real process on a real clock. Measured: 52 tests / 13.6s, with 300–5000ms
     * grace windows scripted as real `process.execPath -e` children.
     *
     * `BootChild` is defined from what this function CALLS, not from Node's
     * `ChildProcess` — the same way `driveSession(cdp: CdpLike, …)` was defined from
     * the two `Cdp` methods it uses. A scripted fake is a dozen lines.
     */
    spawnBoot?: (bin: string, args: string[], opts: BootSpawnOptions) => BootChild
    /**
     * Tear down the child's whole process group. Injected with `spawnBoot`, because
     * a fake child has no group to kill and a real `process.kill(pid)` against a
     * fake pid would signal something else entirely.
     */
    killGroup?: (pid: number, signal: NodeJS.Signals) => void
}

/** What `runBootCheck` passes to its spawn. */
export interface BootSpawnOptions {
    cwd: string
    detached: true
    stdio: ['ignore', 'pipe', 'pipe']
    env: Record<string, string | undefined>
}

/** A stream the boot check reads output from. */
export interface BootStream {
    on: (event: 'data', cb: (chunk: Buffer | string) => void) => void
}

/**
 * The boot child, as the check actually uses it: a pid, two output streams, an
 * `error` event and an `exit` event carrying (status, signal).
 */
export interface BootChild {
    pid?: number | undefined
    unref?: () => void
    stdout?: BootStream | null
    stderr?: BootStream | null
    on: {
        (event: 'error', cb: (err: Error) => void): void
        (event: 'exit', cb: (status: number | null, signal: NodeJS.Signals | null) => void): void
    }
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
 * `netstat -tlnp` rows → {pid, port}. Three parsers exist because no single
 * enumerator is present everywhere — a box may ship netstat and no ss, or ss and
 * no netstat — and without SOME enumerator the served-app check can never observe
 * a listener and fails unfalsifiably.
 *
 * The pid rides in the trailing "PID/Program name" column ("1234/bun"); rows the
 * kernel will not attribute to us print "-" there and are skipped. Both run as
 * described.
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
 * Can ANY socket-enumeration tool run here at all? (a sandbox may have
 * none, so `groupHasListener` returned false forever and the boot check emitted
 * "never opened a listening socket" no matter what the app did — an unfalsifiable
 * FAIL that failed a run whose app demonstrably served.) This is a CAPABILITY
 * question, deliberately separate from "did we see a listener": a tool that ran
 * and found nothing is an observation; no tool at all is blindness, and blindness
 * must degrade to the survival rule exactly like win32 — never a false FAIL on a
 * platform we cannot probe.
 *
 * "Ran" = spawned without ENOENT and either exited 0 or printed something. Both
 * halves of that disjunction are load-bearing: `lsof` really does exit 1 on an
 * empty match set (checked), and a netstat that rejects `-p` prints nothing, so
 * neither an exit code nor output alone would answer the question.
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

/**
 * A free TCP port on the loopback interface, or null if one cannot be reserved.
 * The boot check hands this to the child as PORT so that a successful HTTP request
 * to it is OWNERSHIP evidence: nobody else knows the number, whereas an orphaned
 * server left by an earlier check still answers on a conventional port and would
 * pass a check the app had not earned.
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

/** Can we bind 127.0.0.1:`port` right now? Free ⇒ the boot child can have it.
 *  Run: true for a just-reserved port, false while anything holds it. */
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
 * Does anything answer HTTP on 127.0.0.1:`port`? Any response at all counts — a
 * status IS a listener, and a live server answering 404 on an unknown path is the
 * ordinary case — so only a connection error or a timeout is a no.
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
export function defaultFindPortHolder(port: number): {pid: number; command: string} | null {
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

/** The real spawn. Kept beside the seam so the default is one line to read. */
function defaultSpawnBoot(bin: string, args: string[], o: BootSpawnOptions): BootChild {
    return spawn(bin, args, o) as unknown as BootChild
}

/**
 * The real group teardown, best-effort. A group already gone is not an error.
 *
 * On POSIX the negative pid signals the whole group, which is what makes a
 * `detached` spawn reapable together with anything it backgrounded. Windows has
 * neither process groups nor a negative-pid kill, so that branch shells out to
 * `taskkill /T /F` as a single forced tree teardown instead of escalating.
 */
function defaultKillGroup(pid: number, sig: NodeJS.Signals): void {
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'])
        } else {
            process.kill(-pid, sig)
        }
    } catch {
        // group already gone
    }
}

/**
 * Exercise the start command ONCE. All four outcomes below were run against real
 * child processes in throwaway projects.
 *
 * For a CLI project (`expectServer` false) the command's own fate within the grace
 * window decides:
 *
 *   - non-zero exit (or signal death) before the window closes → FAIL, output tail;
 *   - exit 0 before the window closes → PASS (a CLI-style "run" that finished);
 *   - still alive when the window closes → PASS, then the whole process group is
 *     killed (detached spawn = own group; SIGTERM, escalating to SIGKILL).
 *
 * For a SERVED app (`expectServer` true — the spec/plan promised an HTTP server) mere
 * survival is not enough: a watcher (`dev` = tailwind/bundler --watch) stays alive
 * forever without ever listening, and a type-only entrypoint exits 0 in <1s having
 * served nothing. The boot then
 * PASSes only once a LISTENing socket owned by our process group is observed; if the
 * command exits, or the grace window closes, with no listener ever seen → FAIL naming
 * that a listening server was expected.
 *
 * OBSERVABILITY is a precondition of that FAIL. The listener requirement needs
 * pgid-attributed socket enumeration; win32 has none, and neither does a Linux
 * image shipping no ss, netstat or lsof. Without a defence the check would emit
 * "never opened a listening socket" against an app that demonstrably serves, and
 * no amount of fixing could falsify it. Two defences, in order:
 *
 *   - the child is spawned with a freshly reserved, otherwise-unused PORT, and an
 *     HTTP answer on THAT port proves a listener regardless of tooling. The private
 *     port is what makes the HTTP probe trustworthy: an orphaned server from an
 *     earlier check answers on:3000, but nobody else knows this number.
 *   - if nothing can enumerate listeners AND the assigned port never answered, the
 *     served-app requirement is unobservable here, so `expectServer` collapses to
 *     the survival rule and the PASS is stamped UNOBSERVED. An app that ignores PORT
 *     is indistinguishable from one that never listened — an observer limitation,
 *     not an app defect, and it may not be reported as one.
 *
 * A child that EXITS non-zero still FAILs in every environment: "the process died"
 * needs no socket probe. Confirmed — a start script exiting 3 comes back as
 * `exited 3` with the output tail attached, with no listener question asked. That
 * is what keeps a crashed app reportable even where a hot-reloading runtime would
 * otherwise hold the process open.
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
    // to the freshly reserved private port that the ownership evidence needs.
    const noPreference = (): Promise<number | null> => Promise.resolve(null)
    const preferred = expectServer ? await (opts.deps?.preferredPort ?? noPreference)() : null
    const assignedPort =
        preferred ?? (expectServer ? await (opts.deps?.pickPort ?? pickFreePort)() : null)
    // Runner resolution: same contract as runGateCommand — resolve
    // the runner and carry its directory on PATH so the boot script's own chain
    // can re-invoke it.
    const runner = resolveRunner(bin)
    const spawnBoot = opts.deps?.spawnBoot ?? defaultSpawnBoot
    return new Promise(resolve => {
        const child = spawnBoot(runner.bin, args, {
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
        child.unref?.()
        let out = ''
        let err = ''
        let listenerSeen = false
        const cap = (s: string) => (s.length > 8000 ? s.slice(-8000) : s)
        child.stdout?.on('data', d => {
            out = cap(out + String(d))
        })
        child.stderr?.on('data', d => {
            err = cap(err + String(d))
        })
        let settled = false
        const settle = (r: BootOutcome) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (poll) clearInterval(poll)
            resolve(r)
        }
        const reapGroup = opts.deps?.killGroup ?? defaultKillGroup
        const killGroup = (sig: NodeJS.Signals) => {
            // Truthiness, deliberately: `process.kill(0, sig)` signals the
            // CALLER's own process group, so a pid of 0 turns a best-effort
            // teardown into self-termination. Node's spawn never yields 0, but
            // `spawnBoot` is a seam now and a fake or future child could.
            if (!child.pid) return
            reapGroup(child.pid, sig)
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
        // check against the LIVE listener (a listener that serves a
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
                    // is alive: the server accepted the login and the
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
                // an app defect.
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
            // than reporting the app "crashed".
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
 * The SAME third verdict, at the door unobservedVerdict cannot reach: the boot
 * check specifically.
 *
 * A run can ship an app with no HTTP server behind a converged final gate. Its
 * `src/server/index.ts` ends at `export {app}` — no `Bun.serve`, no
 * `export default app`, no `start` script — so `bun run src/server/index.ts` exits
 * 0 immediately and the product cannot be started at all. The gate's boot command
 * resolved to `bun run dev`, whose body begins `docker compose … up -d`; the gate
 * sandbox had no docker, so the boot SKIPPED as an environment gap. Skips
 * contribute nothing to `dynObserved`, and `bun run test`, `test:ct`, `build`,
 * `lint`, `seed` and `migrate` all ran — so `dynObserved > 0`, the full-skip
 * blindness guard (observabilityGapFailure) stayed correctly quiet, and the trail
 * report then reads `final-gate: autofix converged — statics + … passed`, with
 * every task green.
 *
 * The defect is that "the app was never observed to boot" and "the app booted
 * fine" produced BYTE-IDENTICAL gate output. That is the class the verdict check
 * exists to kill one layer up: absence of evidence rendered in the shape of
 * evidence. So a discovered-but-skipped boot now names itself, and — unlike every
 * other skip — it CANNOT be cancelled by observations from other commands.
 * Component tests are the trap here, not the alibi: a suite of green Playwright
 * CT tests, and CT mounts components in a browser without ever assembling or
 * starting the server.
 *
 * DECIDED, do not silently re-open:
 *  - NOT a FAIL. A boot skip on a docker-less box is a genuine environment gap, and
 *    failing it re-creates the unfalsifiable-FAIL mistake pointing the other
 *    way. UNOBSERVED blocks nothing while being loud and durable (the caller records
 *    it as final-gate debt the next run re-surfaces), and it keeps "boot never ran"
 *    out of the autofix child's seed — a child cannot fix a missing docker, so the
 *    highest-probability response would be to FABRICATE a bootable command, the
 *    class that refuted the `## verified tooling` harvest.
 *  - BOTH skip flavours count. A skip can carry `spawnFailed: false` (127 inside
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
export async function recoverOrphanPort(
    cwd: string,
    boot: HealthCommand,
    first: {outcome: 'orphan-port'; detail: string; port: number | null},
    /** One options object, not four trailing positionals — `bootGraceMs` and a
     *  boolean sat adjacent and swapped without a type error. */
    opts: {graceMs?: number; deps: BootDeps; expectServer: boolean}
): Promise<BootOutcome> {
    const {graceMs: bootGraceMs, deps, expectServer} = opts
    if (first.port === null) return first
    const holder = (deps.findPortHolder ?? defaultFindPortHolder)(first.port)
    if (!holder || !holderIsOurs(holder.command, boot)) return first
    const reaped = (deps.reap ?? defaultReap)(holder.pid)
    if (!reaped) return first
    // Give the OS a moment to release the socket, then re-run the boot once.
    await new Promise(r => setTimeout(r, 1_500))
    return runBootCheck(cwd, boot, bootGraceMs, {expectServer, deps})
}

// ─── The boot SECTION ────────────────────────────────────────────────────────

/**
 * Everything the run-end gate records about "did the assembled product start?".
 *
 * This module owned the mechanics but not the CONCEPT: answering that question
 * meant reading ~110 lines of `final-gate.ts` as well, where the four-armed
 * {@link BootOutcome} union was destructured, the render/deep-render/port probe
 * defaults were bound, `recoverOrphanPort` was re-invoked with six positional
 * arguments, and the port-holder diagnosis reached back into `BootDeps` a SECOND
 * time to build its own sentence. CONTEXT.md records the earlier extraction as
 * "a file move, not a re-shaping"; this is the re-shaping it left open.
 *
 * The gate's boot branch is now: call this, write the fields into the tally.
 * `runBootCheck` stays exported unchanged — seven harnesses under `scripts/`
 * drive it directly.
 */
export interface BootSectionVerdict {
    /** The bin the gate counts as ATTEMPTED. Absent ⇒ there was nothing to boot. */
    attempted?: string
    /** A probe LOOKED. False for a skip, and for a project with no launch surface. */
    observed: boolean
    /** The runner binary never spawned — feeds the full-blindness guard. */
    spawnFailedBin?: string
    /** The UNOBSERVED note, offered on both branches (a rejected launch script has one). */
    unobservedNote?: string
    /**
     * The one failure this section can produce, with the rank the gate gives it (0 —
     * boot failures lead the aggregate) and whether a probe OBSERVED it. A harness
     * condition (a port we could not clear) is a failure that nothing observed about
     * the APP, which is why `observed` is a field and not implied by `failure`.
     */
    failure?: {detail: string; rank: number; observed: boolean}
    /** The label recorded as having RUN, on a clean boot. */
    ranLabel?: string
    /** UNOBSERVED warnings — a listener that served but whose page could not be judged. */
    warnings: string[]
}

export interface BootSectionOptions {
    /** The plan text, for served-app detection. */
    planText?: string
    /** Grace period for the boot check. */
    graceMs?: number
    /**
     * Probe overrides. The render, deep-render and preferred-port defaults are
     * bound HERE now: they were the gate's, so a caller that wanted the real boot
     * behaviour had to know to supply three functions it should never have had to
     * name — `findPortHolder` was already defaulted inside this module, and the
     * other three now match it.
     */
    deps?: BootDeps
}

export async function runBootSection(
    cwd: string,
    opts: BootSectionOptions = {}
): Promise<BootSectionVerdict> {
    const boot = discoverBootCommand(cwd)
    const expectServer = detectsServedApp(cwd, opts.planText)
    const warnings: string[] = []

    if (!boot) {
        // Nothing to boot — but if the reason is that the project's only launch
        // script was REJECTED as not-a-launch (2A), that is not the same thing as a
        // project with no launch surface, and it must not degrade into silence.
        const rejected = rejectedLaunchScript(cwd)
        if (rejected && expectServer) {
            return {
                observed: false,
                warnings,
                unobservedNote:
                    `boot check: this project's only launch script (\`${rejected.name}\`) is not a `
                    + `launch — ${rejected.reason} — so nothing was started and the app was never `
                    + 'observed to run.'
            }
        }
        return {observed: false, warnings}
    }

    const label = `${boot[0]} ${boot[1].join(' ')}`
    // Render check: for a served app, load the live page in a
    // headless browser and judge the RENDERED DOM — curl can't run JS, so a
    // blank-mount app passed every prior "renders" check. runRenderCheck
    // env-gap-SKIPs when no browser exists, so a box without one never gets a
    // false FAIL.
    //
    // Authenticated deep-render check: the page above renders, so now
    // sign in with the account the project's own dotenv declares (the same
    // ADMIN_PHONE/ADMIN_PASSWORD the launch contract's seed step consumes) and
    // require the session to actually work. WEB-ONLY by construction — it hangs off
    // the served-app branch and never runs for C++, Godot, CLI or library projects.
    // It may only FAIL when the SERVER authenticated us; no browser, no
    // credentials, an undrivable form or rejected credentials all skip as env gaps.
    const deps: BootDeps = {
        ...opts.deps,
        renderProbe: opts.deps?.renderProbe ?? runRenderCheck,
        deepRenderProbe: opts.deps?.deepRenderProbe ?? (url => runDeepRenderCheck(url, cwd)),
        preferredPort: opts.deps?.preferredPort ?? (() => preferredDeclaredPort(cwd))
    }

    let b = await runBootCheck(cwd, boot, opts.graceMs, {expectServer, deps})
    if (b.outcome === 'orphan-port') {
        b = await recoverOrphanPort(cwd, boot, b, {
            ...(opts.graceMs === undefined ? {} : {graceMs: opts.graceMs}),
            deps,
            expectServer
        })
    }

    const verdict: BootSectionVerdict = {
        attempted: boot[0],
        observed: b.outcome !== 'skip',
        warnings,
        ...(b.outcome === 'skip' && b.spawnFailed ? {spawnFailedBin: boot[0]} : {})
    }
    const unobserved = bootSkipVerdict({label, skipped: b.outcome === 'skip', expectServer})
    if (unobserved !== null) verdict.unobservedNote = unobserved

    if (b.outcome === 'fail') {
        // OBSERVED. Every path that produces `fail` here is a probe
        // that looked: the render judge saw an empty body, the deep session saw the
        // authenticated half dead, the enumerator saw no listener, or the launch
        // command itself exited non-zero. The one condition that means "we could not
        // look" — no ss/netstat/lsof — returns PASS stamped UNOBSERVED
        // and never reaches here.
        verdict.failure = {detail: `boot check: \`${label}\` ${b.detail}`, rank: 0, observed: true}
    } else if (b.outcome === 'orphan-port') {
        // Could not clear the port. Distinct HARNESS diagnosis, never a bare app
        // FAIL: name the port and (when known) the process squatting on it. The
        // holder lookup reads the SAME deps the boot ran under. A
        // second reach into `BootDeps` from the gate, one layer away from the run.
        const holder =
            b.port !== null ? (deps.findPortHolder ?? defaultFindPortHolder)(b.port) : null
        const who =
            holder ? ` — held by an orphaned process (pid ${holder.pid}: ${holder.command})`
            : b.port !== null ? ` — port ${b.port} is held by another process`
            : ''
        verdict.failure = {
            detail:
                `boot check: \`${label}\` could not bind: orphaned process / port already in `
                + `use${who} (harness condition, not an app fault)`,
            rank: 0,
            observed: false
        }
    } else if (b.outcome === 'pass') {
        verdict.ranLabel = label
        // A listener that served, but whose page could not be OBSERVED to render
        // (no browser, undeterminable port) → UNOBSERVED warning, not a silent pass.
        if (b.renderNote) warnings.push(b.renderNote)
    }
    return verdict
}
