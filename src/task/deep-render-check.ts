/**
 * deep-render-check — sign in on the booted app and prove the AUTHENTICATED half
 * of it is alive (mx5 run 17).
 *
 * The failure class this closes: the shallow render check (render-check.ts) loads
 * ONE url and judges the rendered DOM. mx5 run 17 satisfies it completely while
 * being unusable — GET / redirects to /login, the login page renders fully, and
 * that is the whole check. Behind it, src/client/hooks/useAuth.ts called
 * `typedClient.api.auth.me.get()`; hono RPC methods are `$get`/`$post`, so a bare
 * `.get` is just another path segment in hono's createProxy and the call returns a
 * request BUILDER that never issues a request. Login POSTs 200 and sets the
 * session cookie, zero /api/auth/me requests are ever made, and the app bounces to
 * /login forever. Seven call sites were dead the same way, mixed in the same files
 * with correct `$get` ones — the signature of code no runtime ever executed. The
 * server was healthy throughout: 134/134 tests, tsc clean, login 200, me-with-
 * cookie 200. Nothing static could see it.
 *
 * The generic instrument is a NETWORK FACT: after a real sign-in, did the client
 * actually leave the wall, and did its data calls actually reach the server. No
 * cast, mock, replica or type assertion can fake a 2xx on the wire. Deliberately
 * NOT a hono `.get`-vs-`$get` linter: that is a point fix for one library, while
 * the runtime assertion catches the whole dead-client-call class for every client
 * library.
 *
 * SCOPE HONESTY: this is WEB-ONLY. It runs only behind detectsServedApp() and does
 * nothing for C++, Godot, CLI or library projects, which are most of the fleet. It
 * is here because the class is the most expensive one observed — it ended run 16
 * (blank page) and run 17 (dead login) outright.
 *
 * Mechanism, dependency-free: the same discovered Chrome-family binary the shallow
 * check uses, driven over the DevTools protocol through the `ws` dependency the
 * remote server already ships. Nothing is installed; no browser on the box → SKIP.
 *
 * WHAT MAY FAIL, and nothing else: only a session where the server ITSELF accepted
 * our credentials (the sign-in request returned 2xx) and the client still could not
 * use them. Every other outcome — no browser, no declared credentials, a form we
 * could not drive, a sign-in the server rejected, a client pinned to another origin
 * — is an environment gap and SKIPs with an UNOBSERVED note. See judgeDeepSession.
 */
import {spawn} from 'node:child_process'
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import WebSocket from 'ws'
import {findHeadlessBrowser, judgeRenderedDom} from './render-check.js'

export type DeepRenderOutcome =
    | {outcome: 'pass'; detail: string}
    | {outcome: 'fail'; detail: string}
    | {outcome: 'skip'; note: string}

// ── credentials ──────────────────────────────────────────────────────────────

export interface LoginCredentials {
    identifier: string
    password: string
    /** Key names only — the value is never logged or surfaced anywhere. */
    identifierKey: string
    passwordKey: string
}

/** Identifier halves of a credential pair, in preference order. */
const IDENTIFIER_SUFFIXES = ['PHONE', 'EMAIL', 'USERNAME', 'USER', 'LOGIN', 'IDENTIFIER']
const PASSWORD_SUFFIXES = ['PASSWORD', 'PASSWD', 'PASS']
/** Prefixes whose `_PASSWORD` belongs to infrastructure, not to an app account.
 *  `DB_USER`/`DB_PASSWORD` pair perfectly and would otherwise be tried as a login. */
const INFRA_PREFIX_RE =
    /^(DATABASE|DB|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|MONGO|MONGODB|REDIS|RABBIT|RABBITMQ|AMQP|KAFKA|SMTP|IMAP|MAIL|MAILER|S3|MINIO|AWS|GCP|AZURE|DOCKER|REGISTRY|NPM|GITHUB|GITLAB|PROXY|LDAP|VAULT|GRAFANA|SENTRY)$/i
/** Prefixes that name a seeded APP account, tried before any other pair. */
const ACCOUNT_PREFIX_ORDER = ['ADMIN', 'TEST', 'E2E', 'SEED', 'DEV', 'DEFAULT', 'USER', 'LOGIN']

/** Split `ADMIN_PHONE` into prefix `ADMIN` + suffix `PHONE`; '' prefix for a bare
 *  `PASSWORD`. Returns null when the key does not end in one of `suffixes`. */
function splitKey(key: string, suffixes: string[]): {prefix: string; suffix: string} | null {
    const upper = key.toUpperCase()
    for (const suffix of suffixes) {
        if (upper === suffix) return {prefix: '', suffix}
        if (upper.endsWith(`_${suffix}`)) {
            return {prefix: upper.slice(0, -(suffix.length + 1)), suffix}
        }
    }
    return null
}

/**
 * Parse a dotenv-style file into a plain record. Deliberately minimal (KEY=VALUE,
 * `export ` prefix, # comments, optional matching quotes) — this reads the same
 * file the app's own runtime reads, and anything it cannot parse simply yields no
 * credentials, which is a SKIP.
 */
export function parseEnvFile(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim()
        if (line.length === 0 || line.startsWith('#')) continue
        const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
        if (!m) continue
        let value = m[2].trim()
        const quote = value[0]
        if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
            value = value.slice(1, -1)
        } else {
            value = value.split(' #')[0].trim()
        }
        out[m[1]] = value
    }
    return out
}

/** The variables the booted app itself sees: its dotenv files, overlaid by the real
 *  process environment (bun/node never let a file override an exported var). */
export function collectProjectEnv(
    cwd: string,
    env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
    const merged: Record<string, string> = {}
    for (const name of ['.env', '.env.local', '.env.development']) {
        const file = path.join(cwd, name)
        if (!existsSync(file)) continue
        try {
            Object.assign(merged, parseEnvFile(readFileSync(file, 'utf8')))
        } catch {
            // unreadable dotenv → no credentials from it, never a failure
        }
    }
    for (const [k, v] of Object.entries(env)) {
        if (typeof v === 'string' && v.length > 0) merged[k] = v
    }
    return merged
}

/**
 * A declared app-account credential PAIR sharing one prefix (`ADMIN_PHONE` +
 * `ADMIN_PASSWORD` — exactly what the launch contract's seed step consumes), or
 * null when the project declares none. Null is a SKIP, never a FAIL (I3): a gate
 * that failed for missing credentials would fail every project that has no login.
 */
export function findLoginCredentials(vars: Record<string, string>): LoginCredentials | null {
    const passwords = new Map<string, string>() // prefix → key
    const identifiers = new Map<string, string[]>() // prefix → keys, preference order
    for (const key of Object.keys(vars)) {
        if ((vars[key] ?? '').length === 0) continue
        const pw = splitKey(key, PASSWORD_SUFFIXES)
        if (pw && !INFRA_PREFIX_RE.test(pw.prefix) && !passwords.has(pw.prefix)) {
            passwords.set(pw.prefix, key)
            continue
        }
        const id = splitKey(key, IDENTIFIER_SUFFIXES)
        if (id && !INFRA_PREFIX_RE.test(id.prefix)) {
            const list = identifiers.get(id.prefix) ?? []
            list.push(key)
            identifiers.set(id.prefix, list)
        }
    }
    const rank = (prefix: string): number => {
        const i = ACCOUNT_PREFIX_ORDER.indexOf(prefix)
        return i === -1 ? ACCOUNT_PREFIX_ORDER.length : i
    }
    const prefixes = [...passwords.keys()]
        .filter(p => (identifiers.get(p) ?? []).length > 0)
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    const prefix = prefixes[0]
    if (prefix === undefined) return null
    const idKeys = identifiers.get(prefix) ?? []
    const bySuffix = (key: string): number => {
        const s = splitKey(key, IDENTIFIER_SUFFIXES)
        return s ? IDENTIFIER_SUFFIXES.indexOf(s.suffix) : IDENTIFIER_SUFFIXES.length
    }
    const identifierKey = [...idKeys].sort((a, b) => bySuffix(a) - bySuffix(b))[0]
    const passwordKey = passwords.get(prefix)
    if (!identifierKey || !passwordKey) return null
    return {
        identifier: vars[identifierKey],
        password: vars[passwordKey],
        identifierKey,
        passwordKey
    }
}

/**
 * The LOCAL port the project's own client was built to call, when its dotenv pins
 * one (`APP_URL=http://localhost:3000`, `VITE_API_URL=…`), else null.
 *
 * Why the boot check wants it (measured on mx5@373e88d, both directions): a bundler
 * bakes that base URL into the client at BUILD time, so a client served on the
 * gate's freshly-reserved private port calls an origin nothing is listening on. The
 * app is then unusable for reasons that have nothing to do with the code, and the
 * authenticated assertions cannot run at all — the sign-in POST leaves for the dead
 * origin and never reaches the server we booted. Serving on the app's own declared
 * port makes the session same-origin and the evidence real.
 *
 * This deliberately narrows the private-port ownership evidence of run 14, so it
 * only applies when the port is LOCAL, DECLARED by the project itself, and CURRENTLY
 * FREE — the caller checks freeness and falls back to a reserved port otherwise.
 */
export function pinnedLocalPort(vars: Record<string, string>): number | null {
    const ports: number[] = []
    for (const [key, value] of Object.entries(vars)) {
        if (!/URL$/i.test(key) || typeof value !== 'string') continue
        const m =
            /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))?(?:\/|$)/i.exec(
                value.trim()
            )
        if (!m) continue
        const port =
            m[1] ? Number(m[1])
            : value.trim().toLowerCase().startsWith('https') ? 443
            : 80
        if (Number.isInteger(port) && port > 1024 && port < 65536) ports.push(port)
    }
    return ports.length > 0 ? Math.min(...ports) : null
}

// ── verdict (pure, unit-tested against recorded sessions) ────────────────────

/**
 * One same-origin request the session issued, as the wire saw it. This is the whole
 * evidence base: `authRequest`, `postAuthDataAttempted` and `postAuthData2xx` below
 * are DERIVED from this list (deriveLegacyFacts), never recorded separately.
 *
 * `mimeType` is here because status alone cannot see a misrouted GET: an SPA
 * catch-all answers every unmatched GET with index.html at 200, so a dead API call
 * looks healthy to any status rule and only the content type gives it away.
 */
export interface SessionRequest {
    method: string
    path: string
    status: number | null
    mimeType: string | null
    failed: boolean
    /** CDP resource type, collapsed: what ISSUED this request. */
    initiator: 'xhr' | 'document' | 'other'
    /** Relative to the sign-in request: before it, it, or after it. */
    phase: 'pre' | 'auth' | 'post'
}

export interface DeepSessionFacts {
    /** Every same-origin request of the whole session, in order. Optional only so
     *  that a hand-written or pre-existing recorded session stays valid: absent
     *  means "not recorded", and the request-log rules simply do not fire. The live
     *  driver always populates it. */
    sessionRequests?: SessionRequest[]
    /** The landing page presented a sign-in wall (a visible password input). */
    landingHadAuthWall: boolean
    /** A credential pair was declared by the project. */
    credentialsFound: boolean
    /** The form could be filled and submitted. */
    submitted: boolean
    /** The sign-in request the SUBMIT issued, when one was issued at all.
     *  Derived: the `sessionRequests` entry in phase 'auth'. */
    authRequest: {method: string; path: string; status: number | null; failed: boolean} | null
    /** Same-origin XHR/fetch requests issued AFTER the sign-in response, excluding
     *  the sign-in request itself. Derived: `sessionRequests` in phase 'post'. */
    postAuthDataAttempted: number
    postAuthData2xx: number
    /** Origins the client called that are not the app's own, whose requests failed
     *  (a bundle pinned to a build-time base URL that is not the port under test). */
    foreignOriginFailures: string[]
    /** No visible password input after settle, or the URL path changed. */
    leftAuthWall: boolean
    urlBefore: string
    urlAfter: string
    /** judgeRenderedDom over the post-sign-in DOM. */
    postAuthDomOk: boolean
    postAuthDomDetail: string
}

/**
 * The three request-shaped facts, computed from the log and from nothing else. The
 * driver records `sessionRequests` and calls this; the values are exactly what the
 * pre-log driver computed by filtering the same map (the sign-in request is the
 * first same-origin non-GET after submit; the data requests are the same-origin
 * XHR/fetch issued at or after it, itself excluded).
 */
export function deriveLegacyFacts(
    log: SessionRequest[]
): Pick<DeepSessionFacts, 'authRequest' | 'postAuthDataAttempted' | 'postAuthData2xx'> {
    const auth = log.find(r => r.phase === 'auth') ?? null
    const data = log.filter(r => r.phase === 'post' && r.initiator === 'xhr')
    return {
        authRequest:
            auth === null ? null : (
                {method: auth.method, path: auth.path, status: auth.status, failed: auth.failed}
            ),
        postAuthDataAttempted: data.length,
        postAuthData2xx: data.filter(r => r.status !== null && r.status >= 200 && r.status < 300)
            .length
    }
}

/** Statuses that mean "no handler is mounted here", as opposed to a handler that
 *  answered No. 501 is included because a server that routes but implements
 *  nothing is the same dead call from the client's side. */
const MISSING_ROUTE_STATUS = new Set([404, 405, 501])

/**
 * Judge a recorded session. The ONE thing that may FAIL is a session the SERVER
 * authenticated (2xx on the sign-in request) whose client then could not use it:
 *
 *   - never left the wall                → the run-17 signature exactly;
 *   - data calls attempted, none 2xx     → the same class one page deeper;
 *   - post-sign-in page renders blank    → the run-16 class behind the wall.
 *
 * Everything else is an environment or shape gap and SKIPs. Note what is NOT a
 * failure: zero data calls attempted after sign-in. A server-rendered app that
 * redirects to a fresh document legitimately issues no XHR at all, so the missing
 * half is reported UNOBSERVED in the detail instead. (The task text asked for
 * "≥1 same-origin /api/* 2xx during the session" as a hard assertion; STEP 0
 * refuted that wording — the BROKEN mx5 build satisfies it with the probe's own
 * login POST — so the assertion is registered post-auth and excludes the sign-in
 * request. See the scratch REGISTERED-METRIC record quoted in the commit.)
 */
export function judgeDeepSession(f: DeepSessionFacts): DeepRenderOutcome {
    if (!f.landingHadAuthWall) {
        return {
            outcome: 'pass',
            detail: 'the landing page is not a sign-in wall — the authenticated assertions do not apply'
        }
    }
    if (!f.credentialsFound) {
        return {
            outcome: 'skip',
            note:
                'the landing page is a sign-in wall but the project declares no account credentials '
                + '(no matching <PREFIX>_PHONE/EMAIL/USER + <PREFIX>_PASSWORD pair) — the authenticated '
                + 'half of the app was NOT observed'
        }
    }
    if (!f.submitted) {
        return {
            outcome: 'skip',
            note: 'the sign-in form could not be driven (no submit control found) — the authenticated half of the app was NOT observed'
        }
    }
    if (f.authRequest === null) {
        const pinned =
            f.foreignOriginFailures.length > 0 ?
                ` — the client calls ${f.foreignOriginFailures.join(', ')}, not the origin under test (a base URL baked in at build time)`
            :   ''
        return {
            outcome: 'skip',
            note: `submitting the sign-in form issued no request to the app's own origin${pinned} — the authenticated half of the app was NOT observed`
        }
    }
    // Rule A — a route the server does not have. The client addressed a path
    // nothing is mounted on, so the request was never evaluated by any handler.
    // Deliberately narrow: 400/401/403/419/422 are a handler ANSWERING (a rejected
    // password, a missing permission — the app working), 5xx is the server failing,
    // and both keep their existing behaviour. Only "no such route" is here.
    const missingRoute = (f.sessionRequests ?? []).find(
        r => r.initiator === 'xhr' && r.status !== null && MISSING_ROUTE_STATUS.has(r.status)
    )
    if (missingRoute) {
        return {
            outcome: 'fail',
            detail:
                `\`${missingRoute.method} ${missingRoute.path}\` → ${String(missingRoute.status)}: `
                + 'the client sent this to a path the server does not route. The credentials were '
                + 'never evaluated. This is a dead client call — a base URL joined twice, a renamed '
                + 'route, a wrong method. No type or mock can produce a route that is not mounted.'
        }
    }
    // Rule B — the SPA catch-all answering an API call. Any server with a
    // `GET /*` → index.html fallback returns 200 for a route it does not have, so
    // the status is healthy and the body is the app shell. A document navigation
    // answered with HTML is normal; an XHR asking for data and getting HTML is a
    // call that reached nothing.
    const swallowed = (f.sessionRequests ?? []).find(
        r => r.initiator === 'xhr' && (r.mimeType ?? '').startsWith('text/html')
    )
    if (swallowed) {
        return {
            outcome: 'fail',
            detail:
                `\`${swallowed.method} ${swallowed.path}\` → ${String(swallowed.status)} `
                + `${swallowed.mimeType ?? ''}: an XHR asked this server for data and got the SPA `
                + 'shell. The route is not mounted and the catch-all answered instead, so the client '
                + 'sees a 200 it cannot parse. No status check can see this.'
        }
    }
    const {method, path: p, status, failed} = f.authRequest
    if (failed || status === null || status < 200 || status >= 300) {
        return {
            outcome: 'skip',
            note:
                `the server did not accept the declared credentials (\`${method} ${p}\` → `
                + `${failed ? 'request failed' : String(status)}) — with no authenticated session there is `
                + 'nothing to assert; the authenticated half of the app was NOT observed'
        }
    }
    const signedIn = `signed in (\`${method} ${p}\` → ${status})`
    if (!f.leftAuthWall) {
        return {
            outcome: 'fail',
            detail:
                `${signedIn} but the client NEVER LEFT THE SIGN-IN WALL: the page is still `
                + `${f.urlAfter} with a password field, and ${f.postAuthData2xx} of `
                + `${f.postAuthDataAttempted} same-origin data request(s) after sign-in succeeded. `
                + 'The server authenticated the session and the client could not use it — the dead '
                + 'client-call class (a request builder that is never sent, a wrong RPC method name, '
                + 'a handler that never fires). No type, cast or mock can produce the missing 2xx.'
        }
    }
    if (!f.postAuthDomOk) {
        return {
            outcome: 'fail',
            detail: `${signedIn} and reached ${f.urlAfter}, but ${f.postAuthDomDetail}`
        }
    }
    if (f.postAuthDataAttempted > 0 && f.postAuthData2xx === 0) {
        return {
            outcome: 'fail',
            detail:
                `${signedIn} and reached ${f.urlAfter}, but EVERY same-origin data request the `
                + `authenticated client made failed: 0 of ${f.postAuthDataAttempted} returned 2xx. `
                + 'The page rendered, its data did not.'
        }
    }
    const dataEvidence =
        f.postAuthDataAttempted > 0 ?
            `${f.postAuthData2xx}/${f.postAuthDataAttempted} same-origin data requests returned 2xx`
        :   'UNOBSERVED: the authenticated page issued no same-origin data request, so the '
            + 'network half could not be checked (a server-rendered app legitimately issues none)'
    return {
        outcome: 'pass',
        detail: `${signedIn}, left the wall for ${f.urlAfter}, ${dataEvidence}`
    }
}

// ── CDP driver ───────────────────────────────────────────────────────────────

/** Whole-session wall-clock cap, including browser launch (I4). */
export const DEEP_RENDER_TIMEOUT_MS = 45_000
/** No new request for this long ⇒ the page has settled. */
const QUIET_MS = 1_200
/** Caps for the two settle windows (initial load, post-submit). */
const SETTLE_CAP_MS = 8_000
const POST_SUBMIT_CAP_MS = 12_000
/** Cap for the one authenticated re-entry into the landing URL (see `drive`). Kept
 *  small so the three settle windows together stay inside DEEP_RENDER_TIMEOUT_MS. */
const RE_NAV_CAP_MS = 6_000

interface CdpMessage {
    id?: number
    method?: string
    params?: Record<string, unknown>
    result?: Record<string, unknown>
    error?: {message?: string}
    sessionId?: string
}

interface TrackedRequest {
    url: string
    method: string
    type: string
    status: number | null
    mimeType: string | null
    failed: boolean
    at: number
}

/** Minimal DevTools-protocol client: request/response ids over one socket, plus
 *  event fan-out. Everything the driver needs and nothing more. */
class Cdp {
    private nextId = 1
    private readonly pending = new Map<
        number,
        {resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void}
    >()
    private readonly handlers = new Map<string, Array<(params: Record<string, unknown>) => void>>()

    constructor(private readonly ws: WebSocket) {
        ws.on('message', (data: Buffer | string) => {
            let msg: CdpMessage
            try {
                msg = JSON.parse(String(data)) as CdpMessage
            } catch {
                return
            }
            if (typeof msg.id === 'number') {
                const p = this.pending.get(msg.id)
                if (!p) return
                this.pending.delete(msg.id)
                if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
                else p.resolve(msg.result ?? {})
                return
            }
            if (!msg.method) return
            for (const h of this.handlers.get(msg.method) ?? []) h(msg.params ?? {})
        })
    }

    on(method: string, cb: (params: Record<string, unknown>) => void): void {
        const list = this.handlers.get(method) ?? []
        list.push(cb)
        this.handlers.set(method, list)
    }

    send(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string
    ): Promise<Record<string, unknown>> {
        const id = this.nextId++
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject})
            try {
                this.ws.send(
                    JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})
                )
            } catch (e) {
                this.pending.delete(id)
                reject(e instanceof Error ? e : new Error(String(e)))
            }
        })
    }
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** Page-side probe: what the user would see right now. */
const INSPECT_EXPR = `(() => {
    const visible = el => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return s.display !== 'none' && s.visibility !== 'hidden' && (r.width > 0 || r.height > 0)
    }
    const pw = [...document.querySelectorAll('input[type=password]')].filter(visible)
    return {
        hasPassword: pw.length > 0,
        url: location.href,
        pathname: location.pathname,
        html: document.documentElement.outerHTML.slice(0, 400000)
    }
})()`

/** Page-side fill: native value setters + input/change events, so a controlled
 *  React/Vue/Svelte input actually updates its state (a bare `el.value = …` does
 *  not, and the form then submits empty). */
function fillExpr(identifier: string, password: string): string {
    return `(() => {
    const setValue = (el, v) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
        if (desc && desc.set) desc.set.call(el, v)
        else el.value = v
        el.dispatchEvent(new Event('input', {bubbles: true}))
        el.dispatchEvent(new Event('change', {bubbles: true}))
    }
    const pw = document.querySelector('input[type=password]')
    if (!pw) return {ok: false, reason: 'no password input'}
    const scope = pw.form ?? document
    const skip = ['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'password']
    const ident = [...scope.querySelectorAll('input')].find(i => !skip.includes(i.type))
    if (ident) { ident.focus(); setValue(ident, ${JSON.stringify(identifier)}) }
    pw.focus()
    setValue(pw, ${JSON.stringify(password)})
    return {ok: true, identifierFilled: !!ident, hasForm: !!pw.form}
})()`
}

/** Page-side submit, run as a SEPARATE evaluation so the framework has flushed the
 *  state updates the fill scheduled before the handler reads them. */
const SUBMIT_EXPR = `(() => {
    const pw = document.querySelector('input[type=password]')
    if (!pw) return {ok: false, reason: 'no password input'}
    const scope = pw.form ?? document
    const submit =
        scope.querySelector('button[type=submit], input[type=submit]')
        ?? [...scope.querySelectorAll('button')].find(b => !b.disabled)
        ?? null
    if (pw.form && typeof pw.form.requestSubmit === 'function') {
        pw.form.requestSubmit(submit && submit.tagName === 'BUTTON' ? submit : undefined)
        return {ok: true, how: 'requestSubmit'}
    }
    if (submit) { submit.click(); return {ok: true, how: 'click'} }
    return {ok: false, reason: 'no submit control'}
})()`

/** Wait until `ms` of silence pass with no new request, or `cap` elapses. */
async function settle(lastActivity: () => number, cap: number, quiet = QUIET_MS): Promise<void> {
    const deadline = Date.now() + cap
    for (;;) {
        const idleFor = Date.now() - lastActivity()
        if (idleFor >= quiet || Date.now() >= deadline) return
        await sleep(Math.min(200, quiet - idleFor))
    }
}

/**
 * Drive one authenticated session against `url` and judge it. `cwd` is the project
 * whose dotenv declares the account. Every failure mode of the DRIVER itself
 * (no browser, launch failure, protocol error, timeout) resolves to SKIP: this
 * check may only report on the app, never on itself.
 */
export async function runDeepRenderCheck(
    url: string,
    cwd: string,
    opts: {
        browser?: string | null
        credentials?: LoginCredentials | null
        timeoutMs?: number
        env?: NodeJS.ProcessEnv
        /** Recorder hook: receives the facts the verdict was made on. Used by the
         *  corpus builder; the gate itself never passes it. */
        onFacts?: (f: DeepSessionFacts) => void
    } = {}
): Promise<DeepRenderOutcome> {
    const credentials =
        opts.credentials !== undefined ?
            opts.credentials
        :   findLoginCredentials(collectProjectEnv(cwd, opts.env))
    const bin = opts.browser === undefined ? findHeadlessBrowser() : opts.browser
    if (!bin) {
        return {
            outcome: 'skip',
            note: 'no headless Chrome-family browser found on this box (PATH, CHROME_BIN, Playwright cache) — the authenticated half of the app was NOT observed'
        }
    }
    const budget = opts.timeoutMs ?? DEEP_RENDER_TIMEOUT_MS
    const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'pi-task-deep-render-'))
    let child: ReturnType<typeof spawn> | null = null
    let socket: WebSocket | null = null
    const cleanup = (): void => {
        try {
            socket?.close()
        } catch {
            // socket already gone
        }
        try {
            if (child?.pid) process.kill(-child.pid, 'SIGKILL')
        } catch {
            // group already gone
        }
        try {
            rmSync(userDataDir, {recursive: true, force: true})
        } catch {
            // best-effort temp cleanup
        }
    }
    try {
        return await withTimeout(
            drive(
                url,
                bin,
                userDataDir,
                credentials,
                c => {
                    child = c
                },
                s => {
                    socket = s
                },
                opts.onFacts
            ),
            budget
        )
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e)
        return {
            outcome: 'skip',
            note: `the authenticated render session could not run (${why}) — the authenticated half of the app was NOT observed`
        }
    } finally {
        cleanup()
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
        t.unref?.()
        p.then(
            v => {
                clearTimeout(t)
                resolve(v)
            },
            e => {
                clearTimeout(t)
                reject(e instanceof Error ? e : new Error(String(e)))
            }
        )
    })
}

async function drive(
    url: string,
    bin: string,
    userDataDir: string,
    credentials: LoginCredentials | null,
    holdChild: (c: ReturnType<typeof spawn>) => void,
    holdSocket: (s: WebSocket) => void,
    onFacts: ((f: DeepSessionFacts) => void) | undefined
): Promise<DeepRenderOutcome> {
    const origin = new URL(url).origin
    /** Every verdict goes through here, so a recorder sees the same facts the judge
     *  does — the corpus is what the gate itself read, not a reconstruction. */
    const judge = (f: DeepSessionFacts): DeepRenderOutcome => {
        onFacts?.(f)
        return judgeDeepSession(f)
    }
    const child = spawn(
        bin,
        [
            '--headless',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-extensions',
            `--user-data-dir=${userDataDir}`,
            '--remote-debugging-port=0',
            'about:blank'
        ],
        {detached: true, stdio: ['ignore', 'pipe', 'pipe']}
    )
    holdChild(child)
    child.unref()
    const wsUrl = await new Promise<string>((resolve, reject) => {
        let buf = ''
        const onData = (d: Buffer): void => {
            buf += String(d)
            const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf)
            if (m) resolve(m[1])
        }
        child.stderr?.on('data', onData)
        child.stdout?.on('data', onData)
        child.on('error', e => reject(e))
        child.on('exit', code => reject(new Error(`browser exited ${code} before listening`)))
    })
    const socket = new WebSocket(wsUrl, {perMessageDeflate: false, maxPayload: 128 * 1024 * 1024})
    holdSocket(socket)
    await new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve())
        socket.once('error', e => reject(e instanceof Error ? e : new Error(String(e))))
    })
    const cdp = new Cdp(socket)

    const requests = new Map<string, TrackedRequest>()
    let lastActivity = Date.now()
    cdp.on('Network.requestWillBeSent', p => {
        const req = p.request as {url?: string; method?: string} | undefined
        requests.set(String(p.requestId), {
            url: String(req?.url ?? ''),
            method: String(req?.method ?? 'GET'),
            type: String(p.type ?? ''),
            status: null,
            mimeType: null,
            failed: false,
            at: Date.now()
        })
        lastActivity = Date.now()
    })
    cdp.on('Network.responseReceived', p => {
        const r = requests.get(String(p.requestId))
        const res = p.response as {status?: number; mimeType?: string} | undefined
        if (r) {
            r.status = typeof res?.status === 'number' ? res.status : r.status
            if (typeof res?.mimeType === 'string' && res.mimeType.length > 0) {
                r.mimeType = res.mimeType
            }
            if (p.type) r.type = String(p.type)
        }
        lastActivity = Date.now()
    })
    cdp.on('Network.loadingFailed', p => {
        const r = requests.get(String(p.requestId))
        if (r) r.failed = true
        lastActivity = Date.now()
    })

    const {targetId} = (await cdp.send('Target.createTarget', {url: 'about:blank'})) as {
        targetId: string
    }
    const {sessionId} = (await cdp.send('Target.attachToTarget', {targetId, flatten: true})) as {
        sessionId: string
    }
    await cdp.send('Page.enable', {}, sessionId)
    await cdp.send('Runtime.enable', {}, sessionId)
    await cdp.send('Network.enable', {}, sessionId)

    const evaluate = async <T>(expression: string): Promise<T> => {
        const r = (await cdp.send(
            'Runtime.evaluate',
            {expression, returnByValue: true, awaitPromise: true},
            sessionId
        )) as {result?: {value?: T}}
        return r.result?.value as T
    }

    await cdp.send('Page.navigate', {url}, sessionId)
    await settle(() => lastActivity, SETTLE_CAP_MS)
    const before = await evaluate<{
        hasPassword: boolean
        url: string
        pathname: string
        html: string
    }>(INSPECT_EXPR)
    if (!before) throw new Error('the page could not be inspected')

    const sameOrigin = (r: TrackedRequest): boolean =>
        r.url.startsWith(`${origin}/`) || r.url === origin
    const isData = (r: TrackedRequest): boolean => r.type === 'XHR' || r.type === 'Fetch'
    const foreignOriginFailures = (): string[] => {
        const out = new Set<string>()
        for (const r of requests.values()) {
            if (sameOrigin(r) || !r.failed || !r.url.startsWith('http')) continue
            try {
                out.add(new URL(r.url).origin)
            } catch {
                // unparseable url — nothing to name
            }
        }
        return [...out]
    }
    const initiatorOf = (r: TrackedRequest): SessionRequest['initiator'] =>
        isData(r) ? 'xhr'
        : r.type === 'Document' ? 'document'
        : 'other'
    /** The same-origin request log, phased against the sign-in request. `authAt` is
     *  Infinity before the submit, so every request so far is 'pre'. */
    const sessionLog = (authId: string | null, authAt: number): SessionRequest[] => {
        const out: SessionRequest[] = []
        for (const [id, r] of requests) {
            if (!sameOrigin(r)) continue
            out.push({
                method: r.method,
                path: pathOf(r.url),
                status: r.status,
                mimeType: r.mimeType,
                failed: r.failed,
                initiator: initiatorOf(r),
                phase:
                    id === authId ? 'auth'
                    : r.at >= authAt ? 'post'
                    : 'pre'
            })
        }
        return out
    }
    const facts = (log: SessionRequest[], over: Partial<DeepSessionFacts>): DeepSessionFacts => ({
        sessionRequests: log,
        ...deriveLegacyFacts(log),
        landingHadAuthWall: before.hasPassword,
        credentialsFound: credentials !== null,
        submitted: false,
        foreignOriginFailures: foreignOriginFailures(),
        leftAuthWall: false,
        urlBefore: before.url,
        urlAfter: before.url,
        postAuthDomOk: true,
        postAuthDomDetail: '',
        ...over
    })
    const unsubmitted = (over: Partial<DeepSessionFacts>): DeepSessionFacts =>
        facts(sessionLog(null, Number.POSITIVE_INFINITY), over)

    if (!before.hasPassword || credentials === null) return judge(unsubmitted({}))

    const submitMark = Date.now()
    const filled = await evaluate<{ok: boolean; reason?: string}>(
        fillExpr(credentials.identifier, credentials.password)
    )
    if (!filled?.ok) return judge(unsubmitted({submitted: false}))
    // Separate turn: the fill's input events schedule framework state updates that
    // the submit handler must already see.
    await sleep(300)
    const submitted = await evaluate<{ok: boolean; reason?: string}>(SUBMIT_EXPR)
    if (!submitted?.ok) return judge(unsubmitted({submitted: false}))
    lastActivity = Date.now()
    await settle(() => lastActivity, POST_SUBMIT_CAP_MS)

    // The sign-in request: the first same-origin non-GET issued by the submit. Its
    // own 2xx is the precondition for judging anything, and it is excluded from the
    // data evidence (STEP 0: the broken build satisfies "≥1 same-origin 2xx" with
    // exactly this request and nothing else).
    const after = new Map([...requests].filter(([, r]) => r.at >= submitMark))
    let authId: string | null = null
    for (const [id, r] of after) {
        if (sameOrigin(r) && r.method !== 'GET') {
            authId = id
            break
        }
    }
    const authReq = authId !== null ? after.get(authId)! : null
    const authAt = authReq?.at ?? submitMark
    const now = await evaluate<{hasPassword: boolean; url: string; pathname: string; html: string}>(
        INSPECT_EXPR
    )
    const domJudgment = judgeRenderedDom(now?.html ?? '')
    const leftAuthWall = !(now?.hasPassword ?? false) || (now?.pathname ?? '') !== before.pathname

    // Exercise the authenticated app once. A sign-in page that ends on a success
    // card — mx5's does — issues NOTHING after the login POST, so the authenticated
    // data path is never observed at all and every request-shaped fact below is a
    // fact about the login form. Re-entering the landing URL with the session cookie
    // is the cheapest way to make the app fetch its own data. Deliberately gated on
    // an accepted sign-in that left the wall: every session that SKIPs or FAILs
    // without it takes exactly the path it took before, request logs included.
    const authAccepted =
        authReq !== null
        && !authReq.failed
        && authReq.status !== null
        && authReq.status >= 200
        && authReq.status < 300
    if (authAccepted && leftAuthWall) {
        await cdp.send('Page.navigate', {url}, sessionId)
        lastActivity = Date.now()
        await settle(() => lastActivity, RE_NAV_CAP_MS)
    }
    return judge(
        facts(sessionLog(authId, authAt), {
            submitted: true,
            foreignOriginFailures: foreignOriginFailures(),
            leftAuthWall,
            urlAfter: now?.url ?? before.url,
            postAuthDomOk: domJudgment.ok,
            postAuthDomDetail: domJudgment.detail
        })
    )
}

function pathOf(url: string): string {
    try {
        return new URL(url).pathname
    } catch {
        return url
    }
}
