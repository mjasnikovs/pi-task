import {describe, expect, test} from 'bun:test'
import {
    collectProjectEnv,
    findLoginCredentials,
    judgeDeepSession,
    parseEnvFile,
    pinnedLocalPort,
    Cdp,
    fillExpr,
    runDeepRenderCheck,
    settle,
    type DeepSessionFacts
} from './deep-render-check'
import {mkdtempSync, writeFileSync} from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const dirWithEnv = (contents: string, name = '.env'): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'deep-render-test-'))
    writeFileSync(path.join(dir, name), contents)
    return dir
}

describe('parseEnvFile', () => {
    test('reads KEY=VALUE, export prefixes, quotes and comments', () => {
        const vars = parseEnvFile(
            [
                '# a comment',
                'ADMIN_PHONE=+37120000001',
                'export ADMIN_PASSWORD="p@ss word"',
                "DATABASE_URL='postgres://u:p@h/db'",
                'APP_URL=http://localhost:3000 # trailing note',
                'not a var',
                ''
            ].join('\n')
        )
        expect(vars.ADMIN_PHONE).toBe('+37120000001')
        expect(vars.ADMIN_PASSWORD).toBe('p@ss word')
        expect(vars.DATABASE_URL).toBe('postgres://u:p@h/db')
        expect(vars.APP_URL).toBe('http://localhost:3000')
        expect(Object.keys(vars)).toHaveLength(4)
    })
})

describe('findLoginCredentials', () => {
    test('pairs ADMIN_PHONE with ADMIN_PASSWORD (the mx5 launch-contract account)', () => {
        const c = findLoginCredentials({
            ADMIN_PHONE: '+37120000001',
            ADMIN_PASSWORD: 'secret',
            DATABASE_URL: 'postgres://…'
        })
        expect(c?.identifier).toBe('+37120000001')
        expect(c?.password).toBe('secret')
        expect(c?.identifierKey).toBe('ADMIN_PHONE')
        expect(c?.passwordKey).toBe('ADMIN_PASSWORD')
    })

    test('a DB credential pair is NOT a login (DB_USER + DB_PASSWORD share a prefix)', () => {
        expect(
            findLoginCredentials({DB_USER: 'mx5', DB_PASSWORD: 'mx5', POSTGRES_PASSWORD: 'x'})
        ).toBeNull()
    })

    test('an app account is preferred over an unranked prefix', () => {
        const c = findLoginCredentials({
            SUPPORT_EMAIL: 'a@b.c',
            SUPPORT_PASSWORD: 'x',
            ADMIN_EMAIL: 'admin@b.c',
            ADMIN_PASSWORD: 'y'
        })
        expect(c?.identifierKey).toBe('ADMIN_EMAIL')
    })

    test('a password with no identifier of the same prefix is not a pair', () => {
        expect(findLoginCredentials({SESSION_SECRET: 'x', ADMIN_PASSWORD: 'y'})).toBeNull()
    })

    test('an empty value does not count as declared', () => {
        expect(findLoginCredentials({ADMIN_PHONE: '', ADMIN_PASSWORD: 'y'})).toBeNull()
    })

    test('projects with no credentials at all yield null (→ SKIP, never FAIL)', () => {
        expect(findLoginCredentials({PORT: '3000', NODE_ENV: 'production'})).toBeNull()
    })
})

describe('collectProjectEnv', () => {
    test('reads the project dotenv and lets the real environment win', () => {
        const dir = dirWithEnv('ADMIN_PHONE=+371000\nADMIN_PASSWORD=fromfile\n')
        const vars = collectProjectEnv(dir, {ADMIN_PASSWORD: 'fromenv'} as NodeJS.ProcessEnv)
        expect(vars.ADMIN_PHONE).toBe('+371000')
        expect(vars.ADMIN_PASSWORD).toBe('fromenv')
    })

    test('a project with no dotenv is simply empty of them', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'deep-render-test-'))
        expect(findLoginCredentials(collectProjectEnv(dir, {} as NodeJS.ProcessEnv))).toBeNull()
    })
})

// The verdict table. Only ONE row may fail: a session the SERVER authenticated whose
// client could not use it. Every other row is an environment/shape gap → skip.
describe('judgeDeepSession', () => {
    const base: DeepSessionFacts = {
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

    test('no auth wall on the landing page → PASS, assertions do not apply', () => {
        const r = judgeDeepSession({...base, landingHadAuthWall: false})
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('not a sign-in wall')
    })

    test('auth wall but no declared credentials → SKIP (I3), never FAIL', () => {
        const r = judgeDeepSession({...base, credentialsFound: false})
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('NOT observed')
    })

    test('an undrivable form → SKIP', () => {
        expect(judgeDeepSession({...base, submitted: false}).outcome).toBe('skip')
    })

    test('a bundle pinned to another origin → SKIP naming that origin', () => {
        const r = judgeDeepSession({
            ...base,
            authRequest: null,
            foreignOriginFailures: ['http://localhost:3000']
        })
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('http://localhost:3000')
    })

    test('the server REJECTED the credentials → SKIP (config gap, not an app defect)', () => {
        const r = judgeDeepSession({
            ...base,
            authRequest: {method: 'POST', path: '/api/auth/login', status: 401, failed: false}
        })
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('401')
    })

    // mx5 run 17, exactly: login 200 + session cookie, zero /api/auth/me calls ever
    // issued, app bounces back to /login forever.
    test('authenticated but never left the wall → FAIL naming the missing evidence', () => {
        const r = judgeDeepSession({
            ...base,
            leftAuthWall: false,
            postAuthDataAttempted: 0,
            postAuthData2xx: 0,
            urlAfter: 'http://127.0.0.1:3000/login?redirect=%2F'
        })
        expect(r.outcome).toBe('fail')
        const detail = (r as {detail: string}).detail
        expect(detail).toContain('NEVER LEFT THE SIGN-IN WALL')
        expect(detail).toContain('/api/auth/login')
        expect(detail).toContain('200')
    })

    test('authenticated, left the wall, but every data call failed → FAIL', () => {
        const r = judgeDeepSession({...base, postAuthDataAttempted: 4, postAuthData2xx: 0})
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('0 of 4')
    })

    test('authenticated, left the wall, page renders BLANK → FAIL (run-16 class inside)', () => {
        const r = judgeDeepSession({
            ...base,
            postAuthDomOk: false,
            postAuthDomDetail: 'the rendered body is EMPTY after client JS executed'
        })
        expect(r.outcome).toBe('fail')
        expect((r as {detail: string}).detail).toContain('EMPTY')
    })

    test('the healthy session → PASS carrying the network evidence', () => {
        const r = judgeDeepSession(base)
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('6/6')
    })

    // A server-rendered app that redirects to a fresh document issues no XHR at all.
    // STEP 0 registered this as UNOBSERVED, not a failure: the false-FAIL class the
    // task's literal "≥1 same-origin /api/* 2xx" wording would have created.
    test('no data calls attempted after sign-in → PASS but the half is UNOBSERVED', () => {
        const r = judgeDeepSession({...base, postAuthDataAttempted: 0, postAuthData2xx: 0})
        expect(r.outcome).toBe('pass')
        expect((r as {detail: string}).detail).toContain('UNOBSERVED')
    })
})

// A bundler bakes the base URL into the client at BUILD time, so a client served on
// some other port calls an origin nothing answers on — and the authenticated half
// becomes unobservable for reasons that have nothing to do with the code.
describe('pinnedLocalPort', () => {
    test('reads the app URL the project declares', () => {
        expect(
            pinnedLocalPort({APP_URL: 'http://localhost:3000', DATABASE_URL: 'postgres://h/db'})
        ).toBe(3000)
    })

    test('127.0.0.1 and a trailing path are the same declaration', () => {
        expect(pinnedLocalPort({VITE_API_URL: 'http://127.0.0.1:8080/api'})).toBe(8080)
    })

    test('a remote base URL pins nothing local', () => {
        expect(pinnedLocalPort({APP_URL: 'https://mx5.example.com'})).toBeNull()
    })

    test('no URL variable at all → null (the reserved private port stands)', () => {
        expect(pinnedLocalPort({PORT: '3000'})).toBeNull()
    })

    test('several declarations → the lowest (the app port, not an HMR/socket port)', () => {
        expect(
            pinnedLocalPort({APP_URL: 'http://localhost:3000', WS_URL: 'http://localhost:24678'})
        ).toBe(3000)
    })
})

describe('runDeepRenderCheck env gaps', () => {
    test('no browser on this box → SKIP, never FAIL (I2)', async () => {
        const r = await runDeepRenderCheck('http://127.0.0.1:1/', os.tmpdir(), {browser: null})
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('no headless Chrome-family browser')
    })

    test('a browser that cannot launch → SKIP with the reason, never FAIL', async () => {
        const r = await runDeepRenderCheck('http://127.0.0.1:1/', os.tmpdir(), {
            browser: path.join(os.tmpdir(), 'no-such-browser-binary'),
            credentials: {
                identifier: 'x',
                password: 'y',
                identifierKey: 'ADMIN_PHONE',
                passwordKey: 'ADMIN_PASSWORD'
            },
            timeoutMs: 5_000
        })
        expect(r.outcome).toBe('skip')
        expect((r as {note: string}).note).toContain('NOT observed')
    })
})

/**
 * The driver internals that need no browser.
 *
 * `drive()` itself cannot be exercised without a real Chrome, but the three
 * pieces below decide whether it works at all: whether a reply is matched to the
 * request that asked for it, whether a password survives being embedded in an
 * injected expression, and when a page counts as settled.
 */
describe('Cdp', () => {
    /** A `ws`-shaped double: records what was sent, lets the test reply. */
    function fakeSocket() {
        const sent: Array<Record<string, unknown>> = []
        let onMessage: ((data: string) => void) | null = null
        let throwOnSend: Error | null = null
        return {
            sent,
            reply: (msg: unknown) => onMessage?.(JSON.stringify(msg)),
            raw: (text: string) => onMessage?.(text),
            failNextSend: (e: Error) => {
                throwOnSend = e
            },
            ws: {
                on: (event: string, cb: (data: string) => void) => {
                    if (event === 'message') onMessage = cb
                },
                send: (data: string) => {
                    if (throwOnSend) throw throwOnSend
                    sent.push(JSON.parse(data) as Record<string, unknown>)
                }
            } as never
        }
    }

    test('matches each reply to the request that asked for it', async () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)

        const first = cdp.send('Page.navigate', {url: 'http://x/'})
        const second = cdp.send('Runtime.evaluate', {expression: '1'})

        expect(s.sent.map(m => m.method)).toEqual(['Page.navigate', 'Runtime.evaluate'])
        expect(s.sent[0].id).not.toBe(s.sent[1].id)

        // Out of order, as a real browser answers.
        s.reply({id: s.sent[1].id, result: {value: 1}})
        s.reply({id: s.sent[0].id, result: {frameId: 'F'}})

        expect(await first).toEqual({frameId: 'F'})
        expect(await second).toEqual({value: 1})
    })

    test('a protocol error rejects that one call', async () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)
        const p = cdp.send('Runtime.evaluate')
        s.reply({id: s.sent[0].id, error: {message: 'Cannot find context'}})
        await expect(p).rejects.toThrow('Cannot find context')
    })

    test('an error with no message still rejects, with a usable one', async () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)
        const p = cdp.send('Runtime.evaluate')
        s.reply({id: s.sent[0].id, error: {}})
        await expect(p).rejects.toThrow('CDP error')
    })

    test('a reply with no result resolves empty rather than hanging', async () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)
        const p = cdp.send('Page.enable')
        s.reply({id: s.sent[0].id})
        expect(await p).toEqual({})
    })

    test('carries the sessionId when one is given, and omits it otherwise', () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)
        void cdp.send('Page.enable', {}, 'SESSION-1')
        void cdp.send('Page.enable')
        expect(s.sent[0].sessionId).toBe('SESSION-1')
        expect('sessionId' in s.sent[1]).toBe(false)
    })

    test('a socket that refuses the write rejects instead of leaking a pending call', async () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)
        s.failNextSend(new Error('socket closed'))
        await expect(cdp.send('Page.enable')).rejects.toThrow('socket closed')
    })

    test('fans events out to every handler, and survives junk on the wire', () => {
        const s = fakeSocket()
        const cdp = new Cdp(s.ws)
        const a: unknown[] = []
        const b: unknown[] = []
        cdp.on('Network.requestWillBeSent', p => a.push(p))
        cdp.on('Network.requestWillBeSent', p => b.push(p))

        s.raw('not json at all')
        s.reply({method: 'Network.requestWillBeSent', params: {requestId: '1'}})
        s.reply({method: 'Network.somethingNobodyListensTo'})
        s.reply({method: 'Network.requestWillBeSent'}) // no params → {}
        s.reply({id: 999, result: {}}) // a reply to a call we never made

        expect(a).toEqual([{requestId: '1'}, {}])
        expect(b).toEqual(a)
    })
})

describe('fillExpr', () => {
    test('embeds both credentials as JSON literals', () => {
        const expr = fillExpr('admin@example.com', 'hunter2')
        expect(expr).toContain('"admin@example.com"')
        expect(expr).toContain('"hunter2"')
    })

    test('a password full of quotes and backslashes cannot break out', () => {
        const nasty = `a"b'c\\d\n</script>`
        const expr = fillExpr('u', nasty)
        // The literal is escaped, so the raw sequence never appears verbatim…
        expect(expr).not.toContain(`a"b'c\\d\n`)
        // …and evaluating the emitted literal gives the password back unchanged.
        const literal = expr.slice(expr.lastIndexOf('setValue(pw, ') + 'setValue(pw, '.length)
        expect(JSON.parse(literal.slice(0, literal.indexOf('\n')).replace(/\)$/, ''))).toBe(nasty)
    })

    test('drives the framework, not the raw value — a controlled input needs the events', () => {
        const expr = fillExpr('u', 'p')
        expect(expr).toContain("new Event('input', {bubbles: true})")
        expect(expr).toContain("new Event('change', {bubbles: true})")
        // The identifier field is picked by exclusion, never by name guessing.
        expect(expr).toContain("'hidden', 'submit', 'button', 'checkbox'")
    })
})

describe('settle', () => {
    test('returns once the page has been quiet for the window', async () => {
        const started = Date.now()
        const lastActivity = Date.now()
        await settle(() => lastActivity, 5_000, 60)
        expect(Date.now() - started).toBeLessThan(1_000)
    })

    test('gives up at the cap when the page never goes quiet', async () => {
        const started = Date.now()
        await settle(() => Date.now(), 120, 10_000)
        const spent = Date.now() - started
        expect(spent).toBeGreaterThanOrEqual(100)
        expect(spent).toBeLessThan(2_000)
    })

    test('an already-quiet page costs nothing', async () => {
        const started = Date.now()
        await settle(() => Date.now() - 10_000, 5_000, 1_200)
        expect(Date.now() - started).toBeLessThan(50)
    })
})
