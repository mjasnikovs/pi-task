/**
 * The one bounded request, and the three ways it can end.
 *
 * Five modules would otherwise hand-roll this, and the copies drift —
 * `npm-version.ts` never grew the `userAborted` flag, so a user cancel came back
 * as `null`, indistinguishable from a registry that is down. These tests pin the
 * distinction that drift erased.
 */
import {describe, expect, test} from 'bun:test'
import {httpRequest, HttpRequestError, type FetchLike} from '../../src/workers/http-request.js'
import {braveSearch, BraveSearchError} from '../../src/workers/brave-search.js'

const ok = (body: string, init: ResponseInit = {}): Response => new Response(body, init)

describe('httpRequest', () => {
    test('hands the response to the handler and returns what it returns', async () => {
        const fetchImpl: FetchLike = async () => ok('{"a":1}')
        const out = await httpRequest(
            'https://x/',
            {timeoutMs: 1000, fetchImpl},
            async r => (await r.json()) as {a: number}
        )
        expect(out).toEqual({a: 1})
    })

    test('a caller cancel is `aborted`, not `network`', async () => {
        const ctrl = new AbortController()
        ctrl.abort()
        const fetchImpl: FetchLike = async (_u, init) => {
            expect(init?.signal?.aborted).toBe(true)
            throw new Error('The operation was aborted')
        }
        const p = httpRequest(
            'https://x/',
            {timeoutMs: 1000, signal: ctrl.signal, fetchImpl},
            async () => 'unreachable'
        )
        await expect(p).rejects.toBeInstanceOf(HttpRequestError)
        await expect(p).rejects.toMatchObject({kind: 'aborted'})
    })

    test('a refused connection is `network`, and carries the cause verbatim', async () => {
        const fetchImpl: FetchLike = async () => {
            throw new Error('ECONNREFUSED')
        }
        const p = httpRequest('https://x/', {timeoutMs: 1000, fetchImpl}, async () => 'unreachable')
        await expect(p).rejects.toMatchObject({kind: 'network', detail: 'ECONNREFUSED'})
    })

    test('the handler runs INSIDE the clock — a slow body still times out', async () => {
        // fetch resolves on headers, so a seam that cleared its timer before the
        // handler would leave a hung body unbounded. The handler sees the abort.
        const fetchImpl: FetchLike = async () => ok('never read')
        let sawAbort = false
        await httpRequest('https://x/', {timeoutMs: 10, fetchImpl}, async (_r, ctl) => {
            await new Promise<void>(resolve => {
                if (ctl.signal.aborted) return resolve()
                ctl.signal.addEventListener('abort', () => resolve(), {once: true})
            })
            sawAbort = ctl.timedOut()
        })
        expect(sawAbort).toBe(true)
    })

    test('the handler can abort for its own reason, and tell it apart from a cancel', async () => {
        const fetchImpl: FetchLike = async () => ok('body')
        const out = await httpRequest(
            'https://x/',
            {timeoutMs: 1000, fetchImpl},
            async (_r, ctl) => {
                ctl.abort()
                return {
                    aborted: ctl.signal.aborted,
                    byUser: ctl.userAborted(),
                    byClock: ctl.timedOut()
                }
            }
        )
        expect(out).toEqual({aborted: true, byUser: false, byClock: false})
    })

    test('a throw from the handler is the caller’s own policy — it passes through', async () => {
        const fetchImpl: FetchLike = async () => ok('body', {status: 500})
        const p = httpRequest('https://x/', {timeoutMs: 1000, fetchImpl}, async () => {
            throw new Error('my own status policy')
        })
        await expect(p).rejects.toThrow(/my own status policy/)
        await expect(p).rejects.not.toBeInstanceOf(HttpRequestError)
    })
})

describe('brave-search is now driveable at the request level', () => {
    // Brave was the ONE provider without an injectable fetch, so its status ladder
    // — the widest of the three — could not be exercised without a live key and a
    // live endpoint. The seam gives every provider the same door.
    const cases = [
        {status: 401, kind: 'auth', match: /rejected the key/},
        {status: 403, kind: 'auth', match: /rejected the key/},
        {status: 429, kind: 'rate-limit', match: /rate limit hit/},
        {status: 503, kind: 'http', match: /HTTP 503/}
    ] as const

    for (const c of cases) {
        test(`HTTP ${c.status} → ${c.kind}`, async () => {
            const fetchImpl: FetchLike = async () => new Response('', {status: c.status})
            const p = braveSearch('q', {apiKey: 'k', fetchImpl})
            await expect(p).rejects.toBeInstanceOf(BraveSearchError)
            await expect(p).rejects.toMatchObject({kind: c.kind})
            await expect(p).rejects.toThrow(c.match)
        })
    }

    test('200 with results parses through', async () => {
        const fetchImpl: FetchLike = async () =>
            new Response(
                JSON.stringify({
                    web: {results: [{title: 't', url: 'https://u/', description: 'd'}]}
                }),
                {status: 200, headers: {'content-type': 'application/json'}}
            )
        expect(await braveSearch('q', {apiKey: 'k', fetchImpl})).toEqual([
            {title: 't', url: 'https://u/', description: 'd'}
        ])
    })
})
