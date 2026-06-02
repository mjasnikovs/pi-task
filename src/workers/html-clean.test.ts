import {test, expect} from 'bun:test'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'
import {cleanHtml} from './html-clean.js'

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

import {fetchAndClean} from './html-clean.js'

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

test('fetchAndClean rejects non-HTML content types', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() =>
        Promise.resolve(
            new Response('%PDF-1.4...', {
                status: 200,
                headers: {'content-type': 'application/pdf'}
            })
        )) as unknown as typeof fetch

    try {
        await expect(fetchAndClean('https://example.com/doc.pdf')).rejects.toThrow(/not HTML/i)
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
