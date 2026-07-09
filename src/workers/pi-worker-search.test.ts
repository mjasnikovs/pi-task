import {test, expect} from 'bun:test'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'

import {registerPiWorkerSearch, type PiWorkerSearchInternals} from './pi-worker-search.js'

interface RegisteredTool {
    name: string
    parameters: unknown
    execute: (
        toolCallId: string,
        params: unknown,
        signal?: AbortSignal,
        onUpdate?: unknown,
        ctx?: unknown
    ) => Promise<AgentToolResult<unknown>>
}

function makePi(): {
    registered: RegisteredTool[]
    api: {registerTool: (t: RegisteredTool) => void}
} {
    const registered: RegisteredTool[] = []
    return {
        registered,
        api: {registerTool: (t: RegisteredTool) => registered.push(t)}
    }
}

async function runTool(
    internals: PiWorkerSearchInternals,
    env: Record<string, string | undefined>,
    params: {query: string; count?: number}
): Promise<AgentToolResult<unknown>> {
    const {registered, api} = makePi()
    registerPiWorkerSearch(api as unknown as Parameters<typeof registerPiWorkerSearch>[0], {
        ...internals,
        getEnv: key => env[key]
    })
    const tool = registered[0]
    return tool.execute('id', params, undefined, undefined, {cwd: '/tmp'})
}

test('pi-worker-search returns formatted markdown list', async () => {
    const result = await runTool(
        {
            provider: 'brave',
            braveSearch: () =>
                Promise.resolve([
                    {title: 'Foo', url: 'https://foo.example/', description: 'about foo'},
                    {title: 'Bar', url: 'https://bar.example/', description: 'about bar'}
                ])
        },
        {BRAVE_SEARCH_API_KEY: 'k'},
        {query: 'whatever'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toContain('1. [Foo](https://foo.example/) — about foo')
    expect(text).toContain('2. [Bar](https://bar.example/) — about bar')
})

test('pi-worker-search reports missing API key when brave is selected', async () => {
    const result = await runTool(
        {provider: 'brave', braveSearch: () => Promise.reject(new Error('should not be called'))},
        {},
        {query: 'whatever'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/Brave Search not configured/)
    expect(text).toMatch(/BRAVE_SEARCH_API_KEY/)
})

test('pi-worker-search routes to exa without needing any key', async () => {
    const result = await runTool(
        {
            provider: 'exa',
            exaSearch: () =>
                Promise.resolve([
                    {title: 'Exa hit', url: 'https://exa.example/', description: 'via mcp'}
                ]),
            braveSearch: () => Promise.reject(new Error('wrong provider')),
            ddgSearch: () => Promise.reject(new Error('wrong provider'))
        },
        {},
        {query: 'whatever'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toBe('1. [Exa hit](https://exa.example/) — via mcp')
})

test('pi-worker-search routes to ddg without needing any key', async () => {
    const result = await runTool(
        {
            provider: 'ddg',
            ddgSearch: () =>
                Promise.resolve([
                    {title: 'DDG hit', url: 'https://ddg.example/', description: 'via html'}
                ]),
            braveSearch: () => Promise.reject(new Error('wrong provider')),
            exaSearch: () => Promise.reject(new Error('wrong provider'))
        },
        {},
        {query: 'whatever'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toBe('1. [DDG hit](https://ddg.example/) — via html')
})

test('pi-worker-search surfaces a keyless-provider failure as an error, no silent fallback', async () => {
    const result = await runTool(
        {
            provider: 'exa',
            exaSearch: () => Promise.reject(new Error('Exa MCP error 429: slow down')),
            braveSearch: () => Promise.reject(new Error('must not fall back')),
            ddgSearch: () => Promise.reject(new Error('must not fall back'))
        },
        {BRAVE_SEARCH_API_KEY: 'k'},
        {query: 'x'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toBe('Exa MCP error 429: slow down')
})

test('pi-worker-search reports empty results without erroring', async () => {
    const result = await runTool(
        {provider: 'brave', braveSearch: () => Promise.resolve([])},
        {BRAVE_SEARCH_API_KEY: 'k'},
        {query: 'asdfqwerty'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toBe('No results for: asdfqwerty')
})

test('pi-worker-search returns auth-error message on 401', async () => {
    const result = await runTool(
        {
            provider: 'brave',
            braveSearch: () => {
                // mimic BraveSearchError-shaped object without importing the real one
                const e = new Error(
                    'Brave Search rejected the key (HTTP 401). Check BRAVE_SEARCH_API_KEY.'
                )
                ;(e as Error & {kind: string}).kind = 'auth'
                ;(e as Error & {name: string}).name = 'BraveSearchError'
                throw e
            }
        },
        {BRAVE_SEARCH_API_KEY: 'bad'},
        {query: 'x'}
    )
    const text = (result.content[0] as {type: 'text'; text: string}).text
    expect(text).toMatch(/HTTP 401/)
})
