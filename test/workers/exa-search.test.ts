import {expect, test} from 'bun:test'
import {exaSearch, ExaSearchError, type FetchLike} from '../../src/workers/exa-search.js'

function sseBody(rpc: unknown): string {
    return `event: message\ndata: ${JSON.stringify(rpc)}\n\n`
}

function mcpText(blocks: string[]): unknown {
    return {result: {content: [{type: 'text', text: blocks.join('\n\n---\n\n')}]}}
}

function fakeFetch(status: number, body: string): FetchLike {
    return () =>
        Promise.resolve(new Response(body, {status, statusText: status === 200 ? 'OK' : 'ERR'}))
}

test('exaSearch parses SSE-framed Title/URL/Highlights blocks into results', async () => {
    const body = sseBody(
        mcpText([
            'Title: bun:sqlite module\nURL: https://bun.com/reference/bun/sqlite\nPublished: N/A\nAuthor: N/A\nHighlights:\nThe bun:sqlite module is a high-performance driver.',
            'Title: SQLite - Bun\nURL: https://bun.com/docs/runtime/sqlite\nPublished: N/A\nHighlights:\nBun natively implements SQLite3.'
        ])
    )
    const results = await exaSearch('bun sqlite', {fetchImpl: fakeFetch(200, body)})
    expect(results).toEqual([
        {
            title: 'bun:sqlite module',
            url: 'https://bun.com/reference/bun/sqlite',
            description: 'The bun:sqlite module is a high-performance driver.'
        },
        {
            title: 'SQLite - Bun',
            url: 'https://bun.com/docs/runtime/sqlite',
            description: 'Bun natively implements SQLite3.'
        }
    ])
})

test('exaSearch reads Text: content and collapses whitespace into the description', async () => {
    const body = sseBody(
        mcpText(['Title: T\nURL: https://t.example/\nText: line one\n  line   two\n'])
    )
    const results = await exaSearch('q', {fetchImpl: fakeFetch(200, body)})
    expect(results).toEqual([
        {title: 'T', url: 'https://t.example/', description: 'line one line two'}
    ])
})

test('exaSearch accepts a plain-JSON (non-SSE) body', async () => {
    const body = JSON.stringify(mcpText(['Title: T\nURL: https://t.example/\nHighlights:\nd']))
    const results = await exaSearch('q', {fetchImpl: fakeFetch(200, body)})
    expect(results).toHaveLength(1)
    expect(results[0].url).toBe('https://t.example/')
})

test('exaSearch drops blocks without a URL', async () => {
    const body = sseBody(
        mcpText([
            'Title: orphan block with no url line\nHighlights:\ndropped',
            'Title: Real\nURL: https://real.example/\nHighlights:\nkept'
        ])
    )
    const results = await exaSearch('q', {fetchImpl: fakeFetch(200, body)})
    expect(results).toEqual([{title: 'Real', url: 'https://real.example/', description: 'kept'}])
})

test('exaSearch falls back to the url when the title line is empty', async () => {
    const body = sseBody(mcpText(['Title: \nURL: https://only-url.example/']))
    const results = await exaSearch('q', {fetchImpl: fakeFetch(200, body)})
    expect(results).toEqual([
        {title: 'https://only-url.example/', url: 'https://only-url.example/', description: ''}
    ])
})

test('exaSearch caps results at count', async () => {
    const blocks = Array.from(
        {length: 5},
        (_, i) => `Title: T${i}\nURL: https://t${i}.example/\nHighlights:\nd${i}`
    )
    const results = await exaSearch('q', {
        count: 2,
        fetchImpl: fakeFetch(200, sseBody(mcpText(blocks)))
    })
    expect(results.map(r => r.title)).toEqual(['T0', 'T1'])
})

test('exaSearch surfaces a JSON-RPC error as protocol ExaSearchError', async () => {
    const body = sseBody({error: {code: -32000, message: 'rate limited'}})
    expect(exaSearch('q', {fetchImpl: fakeFetch(200, body)})).rejects.toThrow(
        'Exa MCP error -32000: rate limited'
    )
})

test('exaSearch surfaces an isError tool result as protocol error', async () => {
    const body = sseBody({result: {isError: true, content: [{type: 'text', text: 'quota hit'}]}})
    expect(exaSearch('q', {fetchImpl: fakeFetch(200, body)})).rejects.toThrow('quota hit')
})

test('exaSearch maps HTTP failure to http kind', async () => {
    try {
        await exaSearch('q', {fetchImpl: fakeFetch(503, 'nope')})
        expect.unreachable()
    } catch (err) {
        expect(err).toBeInstanceOf(ExaSearchError)
        expect((err as ExaSearchError).kind).toBe('http')
        expect((err as ExaSearchError).status).toBe(503)
    }
})

test('exaSearch maps an unparseable body to protocol kind', async () => {
    try {
        await exaSearch('q', {fetchImpl: fakeFetch(200, 'not json at all')})
        expect.unreachable()
    } catch (err) {
        expect((err as ExaSearchError).kind).toBe('protocol')
    }
})

test('exaSearch sends a keyless JSON-RPC web_search_exa call', async () => {
    let captured: {url: string; init: RequestInit} | null = null
    const fetchImpl: FetchLike = (url, init) => {
        captured = {url, init: init!}
        return Promise.resolve(
            new Response(sseBody(mcpText(['Title: T\nURL: https://t.example/'])), {status: 200})
        )
    }
    await exaSearch('my query', {count: 3, fetchImpl})

    expect(captured!.url).toBe('https://mcp.exa.ai/mcp')
    const headers = captured!.init.headers as Record<string, string>
    expect(Object.keys(headers).some(h => /key|token|auth/i.test(h))).toBe(false)
    const payload = JSON.parse(String(captured!.init.body)) as {
        method: string
        params: {name: string; arguments: {query: string; numResults: number}}
    }
    expect(payload.method).toBe('tools/call')
    expect(payload.params.name).toBe('web_search_exa')
    expect(payload.params.arguments.query).toBe('my query')
    expect(payload.params.arguments.numResults).toBe(3)
})
