import {expect, test} from 'bun:test'
import {ddgSearch, DdgSearchError, parseDdgHtml} from './ddg-search.js'
import type {FetchLike} from './exa-search.js'

/** Mirrors the real html.duckduckgo.com markup (see the result__a/result__snippet shape). */
function resultRow(opts: {href: string; title: string; snippet: string; ad?: boolean}): string {
    return `
      <div class="result results_links results_links_deep web-result ${opts.ad ? 'result--ad' : ''}">
        <div class="links_main links_deep result__body">
          <h2 class="result__title">
            <a rel="nofollow" class="result__a" href="${opts.href}">${opts.title}</a>
          </h2>
          <a class="result__snippet" href="${opts.href}">${opts.snippet}</a>
        </div>
      </div>`
}

const page = (rows: string[]): string =>
    `<html><body><div id="links" class="results">${rows.join('\n')}</div></body></html>`

const wrapped = (dest: string): string =>
    `//duckduckgo.com/l/?uddg=${encodeURIComponent(dest)}&rut=abc123`

test('parseDdgHtml unwraps the uddg redirect and reads title + snippet', () => {
    const html = page([
        resultRow({
            href: wrapped('https://bun.com/docs/runtime/sqlite'),
            title: 'SQLite - Bun',
            snippet: 'Bun natively implements a <b>SQLite3</b> driver.'
        })
    ])
    expect(parseDdgHtml(html)).toEqual([
        {
            title: 'SQLite - Bun',
            url: 'https://bun.com/docs/runtime/sqlite',
            description: 'Bun natively implements a SQLite3 driver.'
        }
    ])
})

test('parseDdgHtml skips ad rows and links that stay on duckduckgo.com', () => {
    const html = page([
        resultRow({
            href: wrapped('https://ads.example/buy'),
            title: 'Sponsored',
            snippet: 'buy now',
            ad: true
        }),
        resultRow({
            // ad click-tracker without a uddg destination
            href: '//duckduckgo.com/y.js?ad_provider=x',
            title: 'Tracker',
            snippet: 'n/a'
        }),
        resultRow({
            href: wrapped('https://real.example/'),
            title: 'Real',
            snippet: 'organic hit'
        })
    ])
    expect(parseDdgHtml(html)).toEqual([
        {title: 'Real', url: 'https://real.example/', description: 'organic hit'}
    ])
})

test('parseDdgHtml collapses whitespace in titles and snippets', () => {
    const html = page([
        resultRow({
            href: wrapped('https://x.example/'),
            title: '  Multi\n   word   title ',
            snippet: 'first\n  second   third'
        })
    ])
    const [r] = parseDdgHtml(html)
    expect(r.title).toBe('Multi word title')
    expect(r.description).toBe('first second third')
})

test('parseDdgHtml returns [] for a page without results (bot-challenge page)', () => {
    expect(parseDdgHtml('<html><body><div class="anomaly-modal"></div></body></html>')).toEqual([])
})

test('ddgSearch caps results at count', async () => {
    const rows = Array.from({length: 5}, (_, i) =>
        resultRow({href: wrapped(`https://r${i}.example/`), title: `R${i}`, snippet: `s${i}`})
    )
    const fetchImpl: FetchLike = () => Promise.resolve(new Response(page(rows), {status: 200}))
    const results = await ddgSearch('q', {count: 2, fetchImpl})
    expect(results.map(r => r.title)).toEqual(['R0', 'R1'])
})

test('ddgSearch sends the query keyless with a browser user-agent', async () => {
    let captured: {url: string; init: RequestInit} | null = null
    const fetchImpl: FetchLike = (url, init) => {
        captured = {url, init: init!}
        return Promise.resolve(new Response(page([]), {status: 200}))
    }
    await ddgSearch('bun sqlite api', {fetchImpl})

    expect(captured!.url).toBe('https://html.duckduckgo.com/html/?q=bun%20sqlite%20api')
    const headers = captured!.init.headers as Record<string, string>
    expect(headers['user-agent']).toContain('Mozilla/5.0')
    expect(Object.keys(headers).some(h => /key|token|auth/i.test(h))).toBe(false)
})

test('ddgSearch maps 403/429 to rate-limit kind', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(new Response('blocked', {status: 429}))
    try {
        await ddgSearch('q', {fetchImpl})
        expect.unreachable()
    } catch (err) {
        expect(err).toBeInstanceOf(DdgSearchError)
        expect((err as DdgSearchError).kind).toBe('rate-limit')
    }
})

test('ddgSearch maps other HTTP failures to http kind', async () => {
    const fetchImpl: FetchLike = () =>
        Promise.resolve(new Response('down', {status: 500, statusText: 'ERR'}))
    try {
        await ddgSearch('q', {fetchImpl})
        expect.unreachable()
    } catch (err) {
        expect((err as DdgSearchError).kind).toBe('http')
        expect((err as DdgSearchError).status).toBe(500)
    }
})
