/**
 * Session-level tests for deep-render-check's `driveSession()` — the protocol half
 * of the driver, split from `launchBrowser()` at the `Cdp` seam so it can be driven
 * in-process against a scripted fake with no browser, no socket and no shell.
 *
 * `deep-render-driver.test.ts` still exercises `runDeepRenderCheck` end to end
 * against a fake Chrome on disk (launch, banner, timeout, teardown); this file is
 * the branch table for what happens once the browser is connected. The rules the
 * scenarios reproduce are the driver's own: a landing is a WALL when a visible
 * password input exists; the sign-in request is the first same-origin non-GET
 * issued after the submit; the wall is LEFT when the password input is gone OR
 * the pathname changed; re-entry happens only after an accepted (2xx) sign-in
 * that left the wall. The verdict those facts feed is `judgeDeepSession`, covered
 * in deep-render-check.test.ts and used as the oracle here.
 */
import {describe, expect, test} from 'bun:test'
import {
    driveSession,
    judgeDeepSession,
    type CdpLike,
    type DeepSessionFacts,
    type LoginCredentials
} from './deep-render-check.js'

const BASE = 'http://127.0.0.1:7654'
const CREDS: LoginCredentials = {
    identifier: 'admin@example.com',
    password: 'hunter2',
    identifierKey: 'ADMIN_EMAIL',
    passwordKey: 'ADMIN_PASSWORD'
}

interface FakeRequest {
    url: string
    method?: string
    type?: string
    status?: number
    mimeType?: string
    failed?: boolean
}
interface Inspect {
    hasPassword: boolean
    url: string
    pathname: string
    html: string
}
interface Scenario {
    /** Requests to emit on each Page.navigate, in call order. */
    navigations?: FakeRequest[][]
    /** Requests to emit when the submit expression is evaluated. */
    onSubmit?: FakeRequest[]
    /** Sequential answers to the page-inspect expression (last one repeats).
     *  `undefined` entries model a page that could not be inspected. */
    inspect: Array<Inspect | undefined>
    fill?: {ok: boolean; reason?: string}
    submit?: {ok: boolean; reason?: string}
    /** Reject this method with the given message the first time it is sent. */
    rejectOn?: {method: string; message: string}
}

/** A scripted CDP: answers `send` by method name, records every call, and can
 *  emit events into whatever the session subscribed. */
class FakeCdp implements CdpLike {
    readonly calls: Array<{method: string; params: Record<string, unknown>; sessionId?: string}> =
        []
    private readonly handlers = new Map<string, Array<(p: Record<string, unknown>) => void>>()
    private inspectCall = 0
    private navCall = 0
    private requestSeq = 0
    private rejected = false

    constructor(private readonly s: Scenario) {}

    on(method: string, cb: (params: Record<string, unknown>) => void): void {
        const list = this.handlers.get(method) ?? []
        list.push(cb)
        this.handlers.set(method, list)
    }

    emit(method: string, params: Record<string, unknown>): void {
        for (const h of this.handlers.get(method) ?? []) h(params)
    }

    /** Emit one request's lifecycle the way Chrome does: will-be-sent, then either
     *  response-received or loading-failed. */
    fire(list: FakeRequest[] | undefined): void {
        for (const r of list ?? []) {
            const requestId = `req-${++this.requestSeq}`
            const type = r.type ?? 'Document'
            this.emit('Network.requestWillBeSent', {
                requestId,
                request: {url: r.url, method: r.method ?? 'GET'},
                type
            })
            if (r.failed) this.emit('Network.loadingFailed', {requestId})
            else {
                this.emit('Network.responseReceived', {
                    requestId,
                    response: {status: r.status ?? 200, mimeType: r.mimeType ?? 'text/html'},
                    type
                })
            }
        }
    }

    async send(
        method: string,
        params: Record<string, unknown> = {},
        sessionId?: string
    ): Promise<Record<string, unknown>> {
        this.calls.push({method, params, sessionId})
        const S = this.s
        if (S.rejectOn && !this.rejected && S.rejectOn.method === method) {
            this.rejected = true
            throw new Error(S.rejectOn.message)
        }
        if (method === 'Target.createTarget') return {targetId: 'target-1'}
        if (method === 'Target.attachToTarget') return {sessionId: 'session-1'}
        if (method === 'Page.navigate') {
            this.fire((S.navigations ?? [])[this.navCall++])
            return {}
        }
        if (method === 'Runtime.evaluate') {
            const expr = String(params.expression)
            if (expr.includes('setValue')) return {result: {value: S.fill ?? {ok: true}}}
            if (expr.includes('requestSubmit')) {
                this.fire(S.onSubmit)
                return {result: {value: S.submit ?? {ok: true}}}
            }
            const at = Math.min(this.inspectCall++, S.inspect.length - 1)
            return {result: {value: S.inspect[at]}}
        }
        return {}
    }

    /** The evaluate calls, classified the way the fake classifies them. */
    evaluations(): Array<'inspect' | 'fill' | 'submit'> {
        return this.calls
            .filter(c => c.method === 'Runtime.evaluate')
            .map(c => {
                const e = String(c.params.expression)
                return (
                    e.includes('setValue') ? 'fill'
                    : e.includes('requestSubmit') ? 'submit'
                    : 'inspect'
                )
            })
    }
    navigations(): number {
        return this.calls.filter(c => c.method === 'Page.navigate').length
    }
}

const wall = (pathname: string): Inspect => ({
    hasPassword: true,
    url: BASE + pathname,
    pathname,
    html: '<html><body><form><input type=password></form></body></html>'
})
const inside = (pathname: string): Inspect => ({
    hasPassword: false,
    url: BASE + pathname,
    pathname,
    html: '<html><body><h1>Dashboard</h1><table><tr><td>Row</td></tr></table></body></html>'
})
const landing: FakeRequest[] = [{url: `${BASE}/`, type: 'Document', status: 200}]
const loginPost: FakeRequest = {
    url: `${BASE}/api/auth/login`,
    method: 'POST',
    type: 'XHR',
    status: 200,
    mimeType: 'application/json'
}
const me: FakeRequest = {
    url: `${BASE}/api/me`,
    type: 'XHR',
    status: 200,
    mimeType: 'application/json'
}

/** Drive one scenario; returns the verdict, the facts the judge saw, and the fake. */
async function run(scenario: Scenario, credentials: LoginCredentials | null = CREDS) {
    const cdp = new FakeCdp(scenario)
    let facts: DeepSessionFacts | null = null
    const verdict = await driveSession(cdp, {
        url: `${BASE}/`,
        credentials,
        judge: f => {
            facts = f
            return judgeDeepSession(f)
        },
        // The fake answers instantly, so 20ms of silence means what 1.2s means live.
        quietMs: 20
    })
    return {verdict, facts: facts as unknown as DeepSessionFacts, cdp}
}

describe('driveSession: the handshake', () => {
    test('creates a target, attaches flat, enables the three domains, then navigates — all on the session', async () => {
        const {cdp} = await run({navigations: [landing], inspect: [inside('/')]})
        expect(cdp.calls.slice(0, 6).map(c => c.method)).toEqual([
            'Target.createTarget',
            'Target.attachToTarget',
            'Page.enable',
            'Runtime.enable',
            'Network.enable',
            'Page.navigate'
        ])
        expect(cdp.calls[1].params).toEqual({targetId: 'target-1', flatten: true})
        for (const c of cdp.calls.slice(2)) expect(c.sessionId).toBe('session-1')
        expect(cdp.calls[5].params).toEqual({url: `${BASE}/`})
    })

    test('a protocol error surfaces as a rejection — the caller turns it into SKIP', async () => {
        await expect(
            run({
                navigations: [landing],
                inspect: [inside('/')],
                rejectOn: {method: 'Network.enable', message: 'Network domain unavailable'}
            })
        ).rejects.toThrow('Network domain unavailable')
    })

    test('a page that cannot be inspected is a driver failure, not a verdict', async () => {
        await expect(run({navigations: [landing], inspect: [undefined]})).rejects.toThrow(
            'the page could not be inspected'
        )
    })
})

describe('driveSession: the landing', () => {
    test('no password input → not a wall → pass without touching the form', async () => {
        const {verdict, facts, cdp} = await run({navigations: [landing], inspect: [inside('/')]})
        expect(verdict.outcome).toBe('pass')
        expect((verdict as {detail: string}).detail).toContain('not a sign-in wall')
        expect(facts.landingHadAuthWall).toBe(false)
        expect(facts.submitted).toBe(false)
        expect(cdp.evaluations()).toEqual(['inspect'])
        expect(cdp.navigations()).toBe(1)
        expect(facts.sessionRequests?.map(r => r.phase)).toEqual(['pre'])
    })

    test('a wall with no declared credentials → skip; the form is never filled', async () => {
        const {verdict, facts, cdp} = await run(
            {navigations: [landing], inspect: [wall('/login')]},
            null
        )
        expect(verdict.outcome).toBe('skip')
        expect((verdict as {note: string}).note).toContain('declares no account credentials')
        expect(facts.landingHadAuthWall).toBe(true)
        expect(facts.credentialsFound).toBe(false)
        expect(cdp.evaluations()).toEqual(['inspect'])
    })

    test('settle waits for the page to go quiet: every staggered landing request is in the log', async () => {
        const cdp = new FakeCdp({navigations: [[]], inspect: [inside('/')]})
        // Requests trickle in AFTER Page.navigate answered; the session must not
        // inspect until they stop.
        const original = cdp.send.bind(cdp)
        cdp.send = async (method, params, sessionId) => {
            const r = await original(method, params, sessionId)
            if (method === 'Page.navigate') {
                for (const [i, ms] of [5, 15, 25].entries()) {
                    setTimeout(
                        () =>
                            cdp.fire([{url: `${BASE}/asset-${i}.js`, type: 'Script', status: 200}]),
                        ms
                    )
                }
            }
            return r
        }
        let facts: DeepSessionFacts | null = null
        await driveSession(cdp, {
            url: `${BASE}/`,
            credentials: null,
            judge: f => {
                facts = f
                return judgeDeepSession(f)
            },
            quietMs: 40
        })
        const f = facts as unknown as DeepSessionFacts
        expect(f.sessionRequests?.map(r => r.path)).toEqual([
            '/asset-0.js',
            '/asset-1.js',
            '/asset-2.js'
        ])
        expect(f.sessionRequests?.every(r => r.phase === 'pre')).toBe(true)
    })
})

describe('driveSession: signing in', () => {
    test('happy path: fill, submit, accepted 2xx, wall left, re-entry fetches data → pass', async () => {
        const {verdict, facts, cdp} = await run({
            navigations: [landing, [me]],
            onSubmit: [loginPost],
            inspect: [wall('/login'), inside('/dashboard')]
        })
        expect(verdict.outcome).toBe('pass')
        expect((verdict as {detail: string}).detail).toContain('1/1 same-origin data requests')
        expect(cdp.evaluations()).toEqual(['inspect', 'fill', 'submit', 'inspect'])
        // The fill carries the declared credentials, escaped into the expression.
        const fill = cdp.calls.find(c => String(c.params.expression).includes('setValue'))!
        expect(String(fill.params.expression)).toContain(JSON.stringify(CREDS.identifier))
        expect(String(fill.params.expression)).toContain(JSON.stringify(CREDS.password))
        // Re-entry: the second navigate, to the same landing URL.
        expect(cdp.navigations()).toBe(2)
        expect(facts.submitted).toBe(true)
        expect(facts.leftAuthWall).toBe(true)
        expect(facts.urlBefore).toBe(`${BASE}/login`)
        expect(facts.urlAfter).toBe(`${BASE}/dashboard`)
        expect(facts.authRequest).toEqual({
            method: 'POST',
            path: '/api/auth/login',
            status: 200,
            failed: false
        })
        expect(facts.sessionRequests?.map(s => s.phase)).toEqual(['pre', 'auth', 'post'])
        expect(facts.postAuthDataAttempted).toBe(1)
        expect(facts.postAuthData2xx).toBe(1)
    })

    test('the sign-in request is the FIRST same-origin non-GET after submit; GETs before it are not it', async () => {
        const {facts} = await run({
            navigations: [landing, []],
            onSubmit: [
                {url: `${BASE}/api/csrf`, type: 'XHR', status: 200, mimeType: 'application/json'},
                {...loginPost, url: `${BASE}/api/session`, method: 'PUT'},
                {...loginPost, url: `${BASE}/api/audit`}
            ],
            inspect: [wall('/login'), inside('/home')]
        })
        expect(facts.authRequest?.path).toBe('/api/session')
        expect(facts.authRequest?.method).toBe('PUT')
        expect(facts.sessionRequests?.map(s => `${s.phase}:${s.path}`)).toEqual([
            'pre:/',
            'post:/api/csrf',
            'auth:/api/session',
            'post:/api/audit'
        ])
    })

    test('accepted by the server, redirected straight back to the wall → fail, no re-entry', async () => {
        const {verdict, facts, cdp} = await run({
            navigations: [landing],
            onSubmit: [loginPost],
            inspect: [wall('/login'), wall('/login')]
        })
        expect(verdict.outcome).toBe('fail')
        expect((verdict as {detail: string}).detail).toContain('NEVER LEFT THE SIGN-IN WALL')
        expect(facts.leftAuthWall).toBe(false)
        expect(cdp.navigations()).toBe(1)
        expect(facts.postAuthDataAttempted).toBe(0)
    })

    test('a password field on a DIFFERENT pathname counts as having left the wall (a 2FA step)', async () => {
        const {facts, cdp} = await run({
            navigations: [landing, []],
            onSubmit: [loginPost],
            inspect: [wall('/login'), wall('/login/verify')]
        })
        expect(facts.leftAuthWall).toBe(true)
        expect(cdp.navigations()).toBe(2)
    })

    test('the server rejected the credentials → skip, and the wall is not re-entered', async () => {
        const {verdict, facts, cdp} = await run({
            navigations: [landing],
            onSubmit: [{...loginPost, status: 401}],
            inspect: [wall('/login'), wall('/login')]
        })
        expect(verdict.outcome).toBe('skip')
        expect((verdict as {note: string}).note).toContain(
            'did not accept the declared credentials'
        )
        expect(facts.authRequest?.status).toBe(401)
        expect(cdp.navigations()).toBe(1)
    })

    test('an accepted sign-in that left the wall but the re-entered page is blank → fail', async () => {
        const {verdict} = await run({
            navigations: [landing, []],
            onSubmit: [loginPost],
            inspect: [
                wall('/login'),
                {
                    hasPassword: false,
                    url: `${BASE}/dashboard`,
                    pathname: '/dashboard',
                    html: '<html><body><div id="root"></div></body></html>'
                }
            ]
        })
        expect(verdict.outcome).toBe('fail')
        expect((verdict as {detail: string}).detail).toContain('EMPTY')
    })
})

describe('driveSession: sessions that report on the environment', () => {
    test('a form that cannot be filled → skip; nothing is submitted', async () => {
        const {verdict, facts, cdp} = await run({
            navigations: [landing],
            inspect: [wall('/login')],
            fill: {ok: false, reason: 'no password input'}
        })
        expect(verdict.outcome).toBe('skip')
        expect((verdict as {note: string}).note).toContain('could not be driven')
        expect(facts.submitted).toBe(false)
        expect(cdp.evaluations()).toEqual(['inspect', 'fill'])
    })

    test('a form with no submit control → skip after the fill', async () => {
        const {verdict, cdp} = await run({
            navigations: [landing],
            inspect: [wall('/login')],
            submit: {ok: false, reason: 'no submit control'}
        })
        expect(verdict.outcome).toBe('skip')
        expect((verdict as {note: string}).note).toContain('could not be driven')
        expect(cdp.evaluations()).toEqual(['inspect', 'fill', 'submit'])
    })

    test('submit issued nothing to the origin under test; a failed foreign call names its origin', async () => {
        const {verdict, facts} = await run({
            navigations: [landing],
            onSubmit: [
                {
                    url: 'http://localhost:9999/api/auth/login',
                    method: 'POST',
                    type: 'XHR',
                    failed: true
                }
            ],
            inspect: [wall('/login'), wall('/login')]
        })
        expect(verdict.outcome).toBe('skip')
        expect((verdict as {note: string}).note).toContain('http://localhost:9999')
        expect(facts.authRequest).toBeNull()
        expect(facts.foreignOriginFailures).toEqual(['http://localhost:9999'])
        // Foreign requests never enter the same-origin log.
        expect(facts.sessionRequests?.map(r => r.path)).toEqual(['/'])
    })

    test('an XHR after sign-in answered by the SPA catch-all → fail', async () => {
        const {verdict} = await run({
            navigations: [landing, [{...me, mimeType: 'text/html'}]],
            onSubmit: [loginPost],
            inspect: [wall('/login'), inside('/dashboard')]
        })
        expect(verdict.outcome).toBe('fail')
        expect((verdict as {detail: string}).detail).toContain('got the SPA')
    })
})
