import {test, expect, describe} from 'bun:test'
import {npmVersionLookup, formatNpmVersionSection} from '../../src/workers/npm-version.js'

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

describe('npmVersionLookup', () => {
    test('returns latest, recent versions, and publishedAt on success', async () => {
        const restore = mockFetch(req => {
            expect(req.url).toBe('https://registry.npmjs.org/react')
            return new Response(
                JSON.stringify({
                    'dist-tags': {latest: '19.0.0'},
                    versions: {
                        '18.0.0': {},
                        '18.1.0': {},
                        '18.2.0': {},
                        '18.3.0': {},
                        '18.3.1': {},
                        '19.0.0': {}
                    },
                    time: {'19.0.0': '2026-04-10T00:00:00.000Z'}
                }),
                {status: 200, headers: {'content-type': 'application/json'}}
            )
        })
        try {
            const info = await npmVersionLookup('react')
            expect(info).not.toBeNull()
            expect(info?.pkg).toBe('react')
            expect(info?.latest).toBe('19.0.0')
            expect(info?.recent[0]).toBe('19.0.0')
            expect(info?.recent).toContain('18.3.1')
            expect(info?.publishedAt).toBe('2026-04-10T00:00:00.000Z')
        } finally {
            restore()
        }
    })

    test('encodes scoped packages correctly', async () => {
        const seen: string[] = []
        const restore = mockFetch(req => {
            seen.push(req.url)
            return new Response(
                JSON.stringify({'dist-tags': {latest: '1.0.0'}, versions: {'1.0.0': {}}}),
                {status: 200, headers: {'content-type': 'application/json'}}
            )
        })
        try {
            await npmVersionLookup('@types/node')
            expect(seen[0]).toBe('https://registry.npmjs.org/%40types/node')
        } finally {
            restore()
        }
    })

    test('returns null on 404', async () => {
        const restore = mockFetch(() => new Response('Not found', {status: 404}))
        try {
            const info = await npmVersionLookup('nonexistent-pkg-xyz')
            expect(info).toBeNull()
        } finally {
            restore()
        }
    })

    test('returns null on network failure', async () => {
        const restore = mockFetch(() => {
            throw new Error('ENOTFOUND')
        })
        try {
            const info = await npmVersionLookup('react')
            expect(info).toBeNull()
        } finally {
            restore()
        }
    })

    test('returns null when response is malformed JSON', async () => {
        const restore = mockFetch(
            () =>
                new Response('not json', {
                    status: 200,
                    headers: {'content-type': 'application/json'}
                })
        )
        try {
            const info = await npmVersionLookup('react')
            expect(info).toBeNull()
        } finally {
            restore()
        }
    })

    test('returns null when dist-tags.latest is missing', async () => {
        const restore = mockFetch(
            () =>
                new Response(JSON.stringify({versions: {'1.0.0': {}}}), {
                    status: 200,
                    headers: {'content-type': 'application/json'}
                })
        )
        try {
            const info = await npmVersionLookup('react')
            expect(info).toBeNull()
        } finally {
            restore()
        }
    })

    test('rejects invalid package names without making a request', async () => {
        let called = false
        const restore = mockFetch(() => {
            called = true
            return new Response('{}', {status: 200})
        })
        try {
            expect(await npmVersionLookup('')).toBeNull()
            expect(await npmVersionLookup('.bad')).toBeNull()
            expect(await npmVersionLookup('has space')).toBeNull()
            expect(called).toBe(false)
        } finally {
            restore()
        }
    })

    test('a user cancel THROWS — it is not a missing version', async () => {
        // This module was the copy of the request ritual that never grew a
        // `userAborted` flag, so a cancelled lookup returned `null`, exactly like a
        // registry that is down. Every caller wraps this in `.catch(() => null)`, so
        // the degraded answer is unchanged — what changed is that a caller CAN now
        // tell the two apart.
        const controller = new AbortController()
        controller.abort()
        const restore = mockFetch(req => {
            expect(req.signal.aborted).toBe(true)
            throw new Error('aborted')
        })
        try {
            await expect(npmVersionLookup('react', {signal: controller.signal})).rejects.toThrow(
                /aborted/i
            )
        } finally {
            restore()
        }
    })

    test('a network failure is still a null — the registry being down is not a cancel', async () => {
        const restore = mockFetch(() => {
            throw new Error('ECONNREFUSED')
        })
        try {
            expect(await npmVersionLookup('react')).toBeNull()
        } finally {
            restore()
        }
    })

    test('respects custom registry option', async () => {
        const seen: string[] = []
        const restore = mockFetch(req => {
            seen.push(req.url)
            return new Response(
                JSON.stringify({'dist-tags': {latest: '1.0.0'}, versions: {'1.0.0': {}}}),
                {status: 200, headers: {'content-type': 'application/json'}}
            )
        })
        try {
            await npmVersionLookup('react', {registry: 'https://my-mirror.example'})
            expect(seen[0]).toBe('https://my-mirror.example/react')
        } finally {
            restore()
        }
    })
})

describe('formatNpmVersionSection', () => {
    test('formats a complete info block', () => {
        const out = formatNpmVersionSection({
            pkg: 'react',
            latest: '19.0.0',
            recent: ['19.0.0', '18.3.1', '18.3.0'],
            publishedAt: '2026-04-10T00:00:00.000Z'
        })
        expect(out).toContain('### npm: react')
        expect(out).toContain('latest: 19.0.0 (published 2026-04-10)')
        expect(out).toContain('recent: 19.0.0, 18.3.1, 18.3.0')
    })

    test('omits publish date when not provided', () => {
        const out = formatNpmVersionSection({
            pkg: 'react',
            latest: '19.0.0',
            recent: ['19.0.0']
        })
        expect(out).toContain('latest: 19.0.0\n')
        expect(out).not.toContain('published')
    })

    test('omits recent line when empty', () => {
        const out = formatNpmVersionSection({pkg: 'react', latest: '19.0.0', recent: []})
        expect(out).not.toContain('recent:')
    })
})
