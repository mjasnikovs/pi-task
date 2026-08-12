/**
 * Driver-level tests for deep-render-check's `drive()` — the half of the module
 * that needs a browser and was therefore the only untested half (59% of its
 * functions never ran).
 *
 * The browser here is a FAKE: a WebSocket server that prints the DevTools banner
 * Chrome prints and then answers the exact CDP calls the driver makes. That is
 * enough to exercise the real driver end to end — the target/session handshake,
 * the request log, the phase arithmetic around the sign-in request, the re-entry
 * navigation, and every one of the driver's own failure modes. What it cannot
 * prove is that real Chrome speaks this protocol; the judgment those facts feed
 * is pure and covered in deep-render-check.test.ts.
 *
 * The fake is launched through a POSIX shell shebang, exactly as render-check's
 * fake browser is, so the spawn-flow cases are POSIX-only.
 */
import {afterAll, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    runDeepRenderCheck,
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

interface Scenario {
    /** Requests to emit on each Page.navigate, in call order. */
    navigations?: FakeRequest[][]
    /** Requests to emit when the submit expression is evaluated. */
    onSubmit?: FakeRequest[]
    /** Sequential answers to the page-inspect expression (last one repeats). */
    inspect: Array<{hasPassword: boolean; url: string; pathname: string; html: string}>
    fill?: {ok: boolean; reason?: string}
    submit?: {ok: boolean; reason?: string}
}

const dirs: string[] = []
afterAll(() => {
    for (const d of dirs) fs.rmSync(d, {recursive: true, force: true})
})

/** A CDP-speaking fake browser on disk. `mode` 'hang' never prints the banner;
 *  'crash' exits before it — the driver's two launch failure modes. */
function fakeBrowser(scenario: Scenario, mode: 'serve' | 'hang' | 'crash' = 'serve'): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-render-fake-'))
    dirs.push(dir)
    const js = path.join(dir, 'fake-chrome.mjs')
    fs.writeFileSync(js, FAKE_SOURCE(scenario, mode))
    const sh = path.join(dir, 'chrome')
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`)
    fs.chmodSync(sh, 0o755)
    return sh
}

function FAKE_SOURCE(scenario: Scenario, mode: 'serve' | 'hang' | 'crash'): string {
    if (mode === 'crash') return 'process.exit(3)\n'
    // `ws` is resolved from THIS package and passed in absolutely: the fake lives
    // in a temp dir, where a bare `import 'ws'` would find no node_modules.
    const wsUrl = import.meta.resolve('ws')
    return `
const {WebSocketServer} = await import(${JSON.stringify(wsUrl)})
const S = ${JSON.stringify(scenario)}
const wss = new WebSocketServer({host: '127.0.0.1', port: 0})
wss.on('listening', () => {
    ${mode === 'hang' ? '' : `process.stderr.write('DevTools listening on ws://127.0.0.1:' + wss.address().port + '/devtools/browser/fake\\n')`}
})
wss.on('connection', ws => {
    let inspectCall = 0
    let navCall = 0
    let requestSeq = 0
    const emit = (method, params) => ws.send(JSON.stringify({method, params}))
    const fire = list => {
        for (const r of list ?? []) {
            const requestId = 'req-' + ++requestSeq
            const type = r.type ?? 'Document'
            emit('Network.requestWillBeSent', {
                requestId,
                request: {url: r.url, method: r.method ?? 'GET'},
                type
            })
            if (r.failed) emit('Network.loadingFailed', {requestId})
            else {
                emit('Network.responseReceived', {
                    requestId,
                    response: {status: r.status ?? 200, mimeType: r.mimeType ?? 'text/html'},
                    type
                })
            }
        }
    }
    ws.on('message', raw => {
        const msg = JSON.parse(String(raw))
        const reply = result => ws.send(JSON.stringify({id: msg.id, result: result ?? {}}))
        if (msg.method === 'Target.createTarget') return reply({targetId: 'target-1'})
        if (msg.method === 'Target.attachToTarget') return reply({sessionId: 'session-1'})
        if (msg.method === 'Page.navigate') {
            reply({})
            return fire((S.navigations ?? [])[navCall++])
        }
        if (msg.method === 'Runtime.evaluate') {
            const expr = String(msg.params.expression)
            if (expr.includes('setValue')) return reply({result: {value: S.fill ?? {ok: true}}})
            if (expr.includes('requestSubmit')) {
                reply({result: {value: S.submit ?? {ok: true}}})
                return fire(S.onSubmit)
            }
            const at = Math.min(inspectCall++, S.inspect.length - 1)
            return reply({result: {value: S.inspect[at]}})
        }
        return reply({})
    })
})
`
}

const wall = (pathname: string) => ({
    hasPassword: true,
    url: BASE + pathname,
    pathname,
    html: '<html><body><form><input type=password></form></body></html>'
})
const inside = (pathname: string) => ({
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

/** Every settle window would otherwise cost the 1.2s production quiet period; the
 *  fake answers instantly, so 20ms of silence means the same thing here. */
function run(
    browser: string,
    over: {timeoutMs?: number; onFacts?: (f: DeepSessionFacts) => void} = {}
) {
    return runDeepRenderCheck(`${BASE}/`, os.tmpdir(), {
        browser,
        credentials: CREDS,
        quietMs: 20,
        ...over
    })
}

// The fake browser is launched via a POSIX shell shebang — Windows has neither
// /bin/sh nor the process-group kill the driver's cleanup uses.
const posix = process.platform === 'win32' ? test.skip : test

describe('drive: a session that works', () => {
    posix('signs in, leaves the wall, and its authenticated data calls 2xx → pass', async () => {
        let facts: DeepSessionFacts | null = null
        const r = await run(
            fakeBrowser({
                navigations: [
                    landing,
                    [
                        {
                            url: `${BASE}/api/me`,
                            type: 'XHR',
                            status: 200,
                            mimeType: 'application/json'
                        }
                    ]
                ],
                onSubmit: [loginPost],
                inspect: [wall('/login'), inside('/dashboard')]
            }),
            {onFacts: f => void (facts = f)}
        )
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('1/1 same-origin data requests')

        const f = facts as unknown as DeepSessionFacts
        expect(f.submitted).toBe(true)
        expect(f.leftAuthWall).toBe(true)
        expect(f.authRequest).toEqual({
            method: 'POST',
            path: '/api/auth/login',
            status: 200,
            failed: false
        })
        // The re-entry navigation is what produced the data request: without it the
        // authenticated path is never observed at all (a success card issues nothing).
        expect(f.postAuthDataAttempted).toBe(1)
        expect(f.sessionRequests?.map(s => s.phase)).toEqual(['pre', 'auth', 'post'])
    })

    posix('a landing page with no wall short-circuits before any fill → pass', async () => {
        const r = await run(
            fakeBrowser({
                navigations: [landing],
                inspect: [inside('/')]
            })
        )
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('not a sign-in wall')
    })
})

describe('drive: the run-17 class', () => {
    posix('server accepts the credentials, client never leaves the wall → fail', async () => {
        let facts: DeepSessionFacts | null = null
        const r = await run(
            fakeBrowser({
                navigations: [landing],
                onSubmit: [loginPost],
                inspect: [wall('/login'), wall('/login')]
            }),
            {onFacts: f => void (facts = f)}
        )
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('NEVER LEFT THE SIGN-IN WALL')
        // No re-entry navigation on a session that never left the wall.
        expect((facts as unknown as DeepSessionFacts).postAuthDataAttempted).toBe(0)
    })

    posix('an authenticated XHR answered by the SPA catch-all → fail', async () => {
        const r = await run(
            fakeBrowser({
                navigations: [
                    landing,
                    [{url: `${BASE}/api/me`, type: 'XHR', status: 200, mimeType: 'text/html'}]
                ],
                onSubmit: [loginPost],
                inspect: [wall('/login'), inside('/dashboard')]
            })
        )
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('got the SPA')
    })

    posix('an authenticated XHR on an unmounted route → fail', async () => {
        const r = await run(
            fakeBrowser({
                navigations: [
                    landing,
                    [
                        {
                            url: `${BASE}/api/me`,
                            type: 'XHR',
                            status: 404,
                            mimeType: 'application/json'
                        }
                    ]
                ],
                onSubmit: [loginPost],
                inspect: [wall('/login'), inside('/dashboard')]
            })
        )
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('does not route')
    })

    posix('signed in, left the wall, blank page behind it → fail', async () => {
        const r = await run(
            fakeBrowser({
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
        )
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('EMPTY')
    })
})

describe('drive: sessions that report on the environment, never on the app', () => {
    posix('a form that cannot be filled → skip', async () => {
        const r = await run(
            fakeBrowser({
                navigations: [landing],
                inspect: [wall('/login')],
                fill: {ok: false, reason: 'no password input'}
            })
        )
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('could not be driven')
    })

    posix('a form with no submit control → skip', async () => {
        const r = await run(
            fakeBrowser({
                navigations: [landing],
                inspect: [wall('/login')],
                submit: {ok: false, reason: 'no submit control'}
            })
        )
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('could not be driven')
    })

    posix('a client pinned to a build-time origin names that origin → skip', async () => {
        const r = await run(
            fakeBrowser({
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
        )
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('http://localhost:9999')
    })

    posix('a sign-in the server rejected → skip, never fail', async () => {
        const r = await run(
            fakeBrowser({
                navigations: [landing],
                onSubmit: [{...loginPost, status: 401}],
                inspect: [wall('/login'), wall('/login')]
            })
        )
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('did not accept the declared credentials')
    })

    posix('a browser that exits before it listens → skip', async () => {
        const r = await run(fakeBrowser({inspect: []}, 'crash'))
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('could not run')
    })

    posix('a browser that never prints the DevTools banner → skip on the budget', async () => {
        const r = await run(fakeBrowser({inspect: []}, 'hang'), {timeoutMs: 400})
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('timed out after 400ms')
    })
})
