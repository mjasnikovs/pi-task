import {test, expect} from 'bun:test'
import {braveSearch, BraveSearchError} from '../../src/workers/brave-search.js'

function mockFetch(responder: (input: Request) => Promise<Response> | Response): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const req =
            typeof input === 'string' ? new Request(input, init)
            : input instanceof URL ? new Request(input.toString(), init)
            : input
        return responder(req)
    }) as typeof fetch
    return () => {
        globalThis.fetch = original
    }
}

test('braveSearch returns mapped results on happy path', async () => {
    const restore = mockFetch(req => {
        expect(req.method).toBe('GET')
        expect(req.url).toContain('q=hello%20world')
        expect(req.headers.get('x-subscription-token')).toBe('test-key')
        return new Response(
            JSON.stringify({
                web: {
                    results: [
                        {title: 'A', url: 'https://a.example/', description: 'aaa'},
                        {title: 'B', url: 'https://b.example/', description: 'bbb'}
                    ]
                }
            }),
            {status: 200, headers: {'content-type': 'application/json'}}
        )
    })
    try {
        const results = await braveSearch('hello world', {apiKey: 'test-key'})
        expect(results).toEqual([
            {title: 'A', url: 'https://a.example/', description: 'aaa'},
            {title: 'B', url: 'https://b.example/', description: 'bbb'}
        ])
    } finally {
        restore()
    }
})

test('braveSearch returns [] when web.results is missing', async () => {
    const restore = mockFetch(
        () => new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
    )
    try {
        const results = await braveSearch('zzz', {apiKey: 'test-key'})
        expect(results).toEqual([])
    } finally {
        restore()
    }
})

test('braveSearch throws on 401', async () => {
    const restore = mockFetch(
        () => new Response('Unauthorized', {status: 401, statusText: 'Unauthorized'})
    )
    try {
        await expect(braveSearch('x', {apiKey: 'bad'})).rejects.toBeInstanceOf(BraveSearchError)
    } finally {
        restore()
    }
})

test('braveSearch respects count cap of 20', async () => {
    const restore = mockFetch(req => {
        expect(req.url).toContain('count=20')
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
    })
    try {
        await braveSearch('x', {apiKey: 'k', count: 999})
    } finally {
        restore()
    }
})
