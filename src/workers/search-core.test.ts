import {expect, test} from 'bun:test'
import {search} from './search-core.js'
import type {SearchResult} from './search-types.js'

const HIT: SearchResult = {title: 'T', url: 'https://t.example/', description: 'd'}
const never = (name: string) => () => Promise.reject(new Error(`${name} must not be called`))

test('search dispatches to the exa provider', async () => {
    const result = await search({
        query: 'q',
        provider: 'exa',
        exaSearch: () => Promise.resolve([HIT]),
        ddgSearch: never('ddg'),
        braveSearch: never('brave'),
        getEnv: () => undefined
    })
    expect(result).toEqual({kind: 'ok', results: [HIT]})
})

test('search dispatches to the ddg provider', async () => {
    const result = await search({
        query: 'q',
        provider: 'ddg',
        ddgSearch: () => Promise.resolve([HIT]),
        exaSearch: never('exa'),
        braveSearch: never('brave'),
        getEnv: () => undefined
    })
    expect(result).toEqual({kind: 'ok', results: [HIT]})
})

test('search dispatches to brave and passes the env key through', async () => {
    let seenKey: string | undefined
    const result = await search({
        query: 'q',
        provider: 'brave',
        braveSearch: (_q, opts) => {
            seenKey = opts.apiKey
            return Promise.resolve([HIT])
        },
        exaSearch: never('exa'),
        ddgSearch: never('ddg'),
        getEnv: k => (k === 'BRAVE_SEARCH_API_KEY' ? 'the-key' : undefined)
    })
    expect(result.kind).toBe('ok')
    expect(seenKey).toBe('the-key')
})

test('search returns no_key only for brave without a key (points at /task-config)', async () => {
    const result = await search({
        query: 'q',
        provider: 'brave',
        braveSearch: never('brave'),
        getEnv: () => undefined
    })
    expect(result.kind).toBe('no_key')
    if (result.kind === 'no_key') expect(result.message).toContain('/task-config')
})

test('search reports a keyless-provider failure as an error, never falls back', async () => {
    const result = await search({
        query: 'q',
        provider: 'exa',
        exaSearch: () => Promise.reject(new Error('Exa MCP error: down')),
        ddgSearch: never('ddg'),
        braveSearch: never('brave'),
        getEnv: k => (k === 'BRAVE_SEARCH_API_KEY' ? 'unused' : undefined)
    })
    expect(result).toEqual({kind: 'error', message: 'Exa MCP error: down'})
})

test('search forwards count and signal to the selected provider', async () => {
    const controller = new AbortController()
    let seen: {count?: number; signal?: AbortSignal} | undefined
    await search({
        query: 'q',
        count: 7,
        signal: controller.signal,
        provider: 'exa',
        exaSearch: (_q, opts) => {
            seen = opts
            return Promise.resolve([])
        }
    })
    expect(seen?.count).toBe(7)
    expect(seen?.signal).toBe(controller.signal)
})
