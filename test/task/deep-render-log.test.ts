/**
 * The request-log half of deep-render-check.
 *
 * `deriveLegacyFacts` reduces the whole log to what the rest of the judge needs:
 * the auth request, and two counters — post-phase XHRs attempted, and how many
 * returned 2xx. Those counters cannot see WHAT came back, so the two rules here
 * read the log itself.
 *
 * The verdict table for everything else lives in deep-render-check.test.ts.
 * These are the cases the counters alone cannot express.
 */
import {describe, expect, test} from 'bun:test'
import {
    deriveLegacyFacts,
    judgeDeepSession,
    type DeepSessionFacts,
    type SessionRequest
} from '../../src/task/deep-render-check'

const req = (over: Partial<SessionRequest>): SessionRequest => ({
    method: 'GET',
    path: '/api/x',
    status: 200,
    mimeType: 'application/json',
    failed: false,
    initiator: 'xhr',
    phase: 'post',
    ...over
})

/** A session the server authenticated, whose client left the wall — every branch
 *  before the two rules already satisfied, so only the log decides. */
const session = (log: SessionRequest[]): DeepSessionFacts => ({
    sessionRequests: log,
    landingHadAuthWall: true,
    credentialsFound: true,
    submitted: true,
    ...deriveLegacyFacts(log),
    foreignOriginFailures: [],
    leftAuthWall: true,
    urlBefore: 'http://127.0.0.1:3000/login',
    urlAfter: 'http://127.0.0.1:3000/',
    postAuthDomOk: true,
    postAuthDomDetail: ''
})

const login = (status: number, over: Partial<SessionRequest> = {}): SessionRequest =>
    req({method: 'POST', path: '/api/auth/login', status, phase: 'auth', ...over})

describe('deriveLegacyFacts', () => {
    test('the phase-auth entry IS the sign-in request', () => {
        const f = deriveLegacyFacts([req({phase: 'pre'}), login(200), req({})])
        expect(f.authRequest).toEqual({
            method: 'POST',
            path: '/api/auth/login',
            status: 200,
            failed: false
        })
    })

    test('a session with no sign-in request has none', () => {
        expect(deriveLegacyFacts([req({phase: 'pre'})]).authRequest).toBeNull()
    })

    test('the data counts are post-phase XHR only — not documents, not pre-auth calls', () => {
        const f = deriveLegacyFacts([
            req({phase: 'pre', status: 401}), // before sign-in: not data evidence
            login(200),
            req({phase: 'post', initiator: 'document', mimeType: 'text/html'}), // a navigation
            req({phase: 'post', initiator: 'other', path: '/main.js'}), // a bundle
            req({phase: 'post', status: 200}),
            req({phase: 'post', status: 500}),
            req({phase: 'post', status: null}) // still in flight at the cut-off
        ])
        expect(f.postAuthDataAttempted).toBe(3)
        expect(f.postAuthData2xx).toBe(1)
    })
})

describe('rule A — a status that means the route is not mounted', () => {
    test('a 404 on an XHR FAILS, naming the request', () => {
        const r = judgeDeepSession(session([login(404, {mimeType: 'text/plain'})]))
        expect(r.outcome).toBe('fail')
        const detail = (r as {detail: string}).detail
        expect(detail).toContain('`POST /api/auth/login` → 404')
        expect(detail).toContain('does not route')
    })

    test('405 and 501 are the same defect', () => {
        for (const status of [405, 501]) {
            expect(judgeDeepSession(session([login(status)])).outcome).toBe('fail')
        }
    })

    // The rule may not eat the SKIPs the check exists to protect: a handler that
    // ANSWERS — with a rejection, a permission error, a validation error — is the
    // app working, and a 5xx is the server failing under it.
    test('401/403/422 and 5xx keep their existing verdict', () => {
        for (const status of [400, 401, 403, 419, 422, 500, 503]) {
            const r = judgeDeepSession(session([login(status)]))
            expect(r.outcome).toBe('skip')
            expect((r as {note: string}).note).toContain(String(status))
        }
    })

    test('a 404 on a DOCUMENT or an asset is not a dead client call', () => {
        const r = judgeDeepSession(
            session([
                req({
                    initiator: 'document',
                    path: '/favicon.ico',
                    status: 404,
                    mimeType: 'text/html'
                }),
                req({initiator: 'other', path: '/old.css', status: 404, mimeType: 'text/css'}),
                login(200),
                req({status: 200})
            ])
        )
        expect(r.outcome).toBe('pass')
    })
})

describe('rule B — an XHR answered with the SPA shell', () => {
    // One route of several is broken: sign-in and /api/auth/me answer healthy
    // JSON, the listings route is not mounted, and the SPA catch-all answers its
    // XHR with index.html at 200. `postAuthDataAttempted` and `postAuthData2xx`
    // both count that as a success, so the counters say healthy and the app is
    // not. Only the content-type on the log entry gives it away.
    test('200 text/html on an XHR FAILS even when every counter is green', () => {
        const f = session([
            login(200),
            req({path: '/api/auth/me', status: 200}),
            req({path: '/api/listings', status: 200, mimeType: 'text/html'})
        ])
        expect(f.postAuthDataAttempted).toBe(2)
        expect(f.postAuthData2xx).toBe(2)
        const r = judgeDeepSession(f)
        expect(r.outcome).toBe('fail')
        const detail = (r as {detail: string}).detail
        expect(detail).toContain('`GET /api/listings` → 200 text/html')
        expect(detail).toContain('SPA shell')
    })

    test('a document navigation answered with HTML is normal', () => {
        const r = judgeDeepSession(
            session([
                req({initiator: 'document', path: '/', mimeType: 'text/html'}),
                login(200),
                req({status: 200})
            ])
        )
        expect(r.outcome).toBe('pass')
    })

    test('text/html with a charset parameter is still the shell', () => {
        const r = judgeDeepSession(
            session([login(200), req({path: '/api/me', mimeType: 'text/html; charset=utf-8'})])
        )
        expect(r.outcome).toBe('fail')
    })
})

describe('a session recorded before the log existed', () => {
    // sessionRequests is optional so that a hand-written or previously recorded
    // session stays judgeable. Absent evidence must judge as before, never as a
    // failure invented from nothing.
    test('no log at all → the pre-log verdict, exactly', () => {
        const f: DeepSessionFacts = {
            landingHadAuthWall: true,
            credentialsFound: true,
            submitted: true,
            authRequest: {method: 'POST', path: '/api/auth/login', status: 200, failed: false},
            postAuthDataAttempted: 6,
            postAuthData2xx: 6,
            foreignOriginFailures: [],
            leftAuthWall: true,
            urlBefore: 'http://127.0.0.1:3000/login',
            urlAfter: 'http://127.0.0.1:3000/',
            postAuthDomOk: true,
            postAuthDomDetail: ''
        }
        const r = judgeDeepSession(f)
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('6/6')
    })
})
