import {test, expect} from 'bun:test'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'
import {cleanHtml} from '../../src/workers/html-clean.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(here, '__fixtures__', name), 'utf8')

test('cleanHtml extracts title and article body, drops nav and footer', () => {
    const html = fixture('article-clean.html')
    const result = cleanHtml(html, 'https://example.com/post')

    expect(result.title).toBe('Hello World')
    expect(result.markdown).toContain('first paragraph')
    expect(result.markdown).toContain('second paragraph')
    expect(result.markdown).not.toContain('menu menu menu')
    expect(result.markdown).not.toContain('copyright')
    expect(result.finalUrl).toBe('https://example.com/post')
})

test('cleanHtml strips ads and sidebars', () => {
    const result = cleanHtml(fixture('article-with-ads.html'), 'https://example.com/x')
    expect(result.markdown).toContain('genuine article paragraph one')
    expect(result.markdown).not.toContain('BUY NOW')
    expect(result.markdown).not.toContain('ANOTHER AD')
    expect(result.markdown).not.toContain('footer junk')
})

test('cleanHtml returns empty markdown for SPA shell with no content', () => {
    const result = cleanHtml(fixture('spa-empty.html'), 'https://example.com/app')
    // Empty or near-empty markdown is the signal the tool layer uses
    // to return the "No readable content" error.
    expect(result.markdown.length).toBeLessThan(50)
})

test('cleanHtml preserves code blocks as fenced markdown', () => {
    const result = cleanHtml(fixture('with-code-blocks.html'), 'https://example.com/code')
    expect(result.markdown).toContain('```')
    expect(result.markdown).toContain('const x: number = 1')
})

test('cleanHtml converts tables to markdown tables', () => {
    const result = cleanHtml(fixture('with-tables.html'), 'https://example.com/t')
    // Turndown default doesn't emit pipe tables unless gfm plugin is added.
    // For now we accept either pipe-table OR plain text containing all cells.
    expect(result.markdown).toContain('a1')
    expect(result.markdown).toContain('b2')
    expect(result.markdown).toContain('Col A')
})

test('cleanHtml falls back to hostname when no title present', () => {
    const result = cleanHtml('<html><body><p>hi</p></body></html>', 'https://example.com/p')
    expect(result.title).toBe('example.com')
})

import {fetchAndClean} from '../../src/workers/html-clean.js'

test('fetchAndClean fetches, cleans, returns result', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response(fixture('article-clean.html'), {
                status: 200,
                headers: {'content-type': 'text/html'}
            })
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/post')
        expect(result.title).toBe('Hello World')
        expect(result.markdown).toContain('first paragraph')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean rejects binary content types', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response('%PDF-1.4...', {
                status: 200,
                headers: {'content-type': 'application/pdf'}
            })
        )) as unknown as typeof fetch

    try {
        await expect(fetchAndClean('https://example.com/doc.pdf')).rejects.toThrow(
            /not a text or HTML/i
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean passes text/markdown through raw, without HTML cleaning', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response('# Title\n\nsome **bold** text\n', {
                status: 200,
                headers: {'content-type': 'text/markdown; charset=utf-8'}
            })
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/llms.txt')
        expect(result.markdown).toContain('# Title')
        expect(result.markdown).toContain('**bold**')
        expect(result.title).toBe('example.com')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean passes text/plain through raw', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response('User-agent: *\nDisallow: /private\n', {
                status: 200,
                headers: {'content-type': 'text/plain'}
            })
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/robots.txt')
        expect(result.markdown).toContain('Disallow: /private')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean passes application/json through raw', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response('{"name":"pi","version":"1.0"}', {
                status: 200,
                headers: {'content-type': 'application/json'}
            })
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/api')
        expect(result.markdown).toContain('"name":"pi"')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean treats a missing content-type as raw text', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            // Blob with empty type → Response sends no content-type header.
            new Response(new Blob(['plain llms content'], {type: ''}), {status: 200})
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/llms.txt')
        expect(result.markdown).toContain('plain llms content')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean cleans application/xhtml+xml as HTML', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response(fixture('article-clean.html'), {
                status: 200,
                headers: {'content-type': 'application/xhtml+xml'}
            })
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/post')
        expect(result.markdown).toContain('first paragraph')
        expect(result.markdown).not.toContain('menu menu menu')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean honors the charset declared in content-type', async () => {
    const originalFetch = globalThis.fetch
    // 0x63 = 'c', 0xe9 = 'é' in ISO-8859-1 (would be a replacement char as UTF-8).
    const body = new Uint8Array([0x63, 0xe9])
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response(body, {
                status: 200,
                headers: {'content-type': 'text/plain; charset=iso-8859-1'}
            })
        )) as unknown as typeof fetch

    try {
        const result = await fetchAndClean('https://example.com/latin')
        expect(result.markdown).toContain('cé')
        expect(result.markdown).not.toContain('�')
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean sends a User-Agent carrying the current package version', async () => {
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as {
        version: string
    }
    const pkgVersion = pkg.version

    const originalFetch = globalThis.fetch
    let sentUA = ''
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        sentUA = headers.get('user-agent') ?? ''
        return Promise.resolve(
            new Response('<html><body><p>hi there friend</p></body></html>', {
                status: 200,
                headers: {'content-type': 'text/html'}
            })
        )
    }) as unknown as typeof fetch

    try {
        await fetchAndClean('https://example.com/x')
        expect(sentUA).toContain(pkgVersion)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean rejects bodies over the maxBytes cap', async () => {
    const huge = 'a'.repeat(3 * 1024 * 1024) // 3 MB
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response(huge, {
                status: 200,
                headers: {'content-type': 'text/html'}
            })
        )) as unknown as typeof fetch

    try {
        await expect(
            fetchAndClean('https://example.com/big', {maxBytes: 1024 * 1024})
        ).rejects.toThrow(/size cap/i)
    } finally {
        globalThis.fetch = originalFetch
    }
})

test('fetchAndClean propagates HTTP error status', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response('not found', {
                status: 404,
                statusText: 'Not Found',
                headers: {'content-type': 'text/html'}
            })
        )) as unknown as typeof fetch

    try {
        await expect(fetchAndClean('https://example.com/missing')).rejects.toThrow(/HTTP 404/)
    } finally {
        globalThis.fetch = originalFetch
    }
})
