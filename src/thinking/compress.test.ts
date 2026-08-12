/**
 * registerThinkingCompression — the message_end hook that rewrites long
 * thinking blocks in place.
 *
 * The hook is the only surface: everything below drives it through a fake
 * ExtensionAPI and asserts on (a) what it returns to the runtime, (b) what it
 * put on the status line, and (c) what it sent to the model endpoint. The
 * status line matters as much as the rewrite — a compression that silently
 * runs for 30s with no footer reads as a hang.
 */

import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {getConfig} from '../config/config.js'
import {registerThinkingCompression} from './compress.js'
import type {AssistantMessageLike, ThinkingBlock} from './rewrite.js'

type Handler = (
    event: {message: unknown},
    ctx: unknown
) => Promise<{message: unknown} | undefined> | undefined

const big = (s: string, n = 200): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)

function think(text: string): ThinkingBlock {
    return {type: 'thinking', thinking: text, thinkingSignature: 'reasoning_content'}
}
function assistant(...content: unknown[]): AssistantMessageLike {
    return {role: 'assistant', content}
}

/** Capture the message_end handler the extension registers. */
function registerAndCapture(): Handler {
    let captured: Handler | undefined
    const pi = {
        on: (event: string, handler: Handler) => {
            if (event === 'message_end') captured = handler
        }
    }
    registerThinkingCompression(pi as never)
    if (!captured) throw new Error('registerThinkingCompression did not hook message_end')
    return captured
}

interface FakeCtxOpts {
    model?: {id: string; baseUrl: string} | null
    auth?: {ok: true; apiKey?: string; headers?: Record<string, string>} | {ok: false}
    authThrows?: boolean
}

function fakeCtx(opts: FakeCtxOpts = {}): {ctx: unknown; statuses: Array<string | undefined>} {
    const statuses: Array<string | undefined> = []
    const model = opts.model === undefined ? {id: 'local/qwen', baseUrl: 'http://x/v1'} : opts.model
    const ctx = {
        ui: {
            setStatus: (_key: string, text?: string) => {
                statuses.push(text)
            }
        },
        model,
        modelRegistry: {
            getApiKeyAndHeaders: async () => {
                if (opts.authThrows) throw new Error('registry down')
                return opts.auth ?? {ok: false}
            }
        }
    }
    return {ctx, statuses}
}

interface Sent {
    url: string
    headers: Record<string, string>
    body: {model: string; messages: {role: string; content: string}[]; temperature: number}
}

/** Swap globalThis.fetch, recording every request. Returns the log + restore. */
function mockFetch(responder: (n: number) => Response | Promise<Response>): {
    sent: Sent[]
    restore: () => void
} {
    const original = globalThis.fetch
    const sent: Sent[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({
            url: String(input),
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: JSON.parse(String(init?.body)) as Sent['body']
        })
        return responder(sent.length - 1)
    }) as typeof fetch
    return {
        sent,
        restore: () => {
            globalThis.fetch = original
        }
    }
}

const okJson = (content: string): Response =>
    new Response(JSON.stringify({choices: [{message: {content}}]}), {
        status: 200,
        headers: {'content-type': 'application/json'}
    })

const thinkingOf = (message: unknown, i: number): string =>
    ((message as AssistantMessageLike).content as ThinkingBlock[])[i].thinking!

let restoreFetch: (() => void) | undefined
let originalFlag: boolean

beforeEach(() => {
    originalFlag = getConfig().compressReasoning
    getConfig().compressReasoning = true
})
afterEach(() => {
    getConfig().compressReasoning = originalFlag
    restoreFetch?.()
    restoreFetch = undefined
})

describe('registerThinkingCompression — gates that must not call the model', () => {
    test('does nothing when compressReasoning is off', async () => {
        getConfig().compressReasoning = false
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx()

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
        expect(sent).toHaveLength(0)
        expect(statuses).toEqual([])
    })

    test('does nothing when the message has no compressible block', async () => {
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx()

        expect(await handler({message: assistant(think('too short'))}, ctx)).toBeUndefined()
        expect(sent).toHaveLength(0)
        expect(statuses).toEqual([])
    })

    test('does nothing when the session has no model', async () => {
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx({model: null})

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
        expect(sent).toHaveLength(0)
        expect(statuses).toEqual([])
    })
})

describe('registerThinkingCompression — the request it sends', () => {
    test('posts to <baseUrl>/chat/completions at temperature 0 with the block appended', async () => {
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        await handler({message: assistant(think(big('a')))}, ctx)

        expect(sent).toHaveLength(1)
        expect(sent[0].url).toBe('http://x/v1/chat/completions')
        expect(sent[0].body.model).toBe('local/qwen')
        expect(sent[0].body.temperature).toBe(0)
        expect(sent[0].body.messages).toHaveLength(1)
        expect(sent[0].body.messages[0].content.endsWith(`---\n\n${big('a')}`)).toBe(true)
        expect(sent[0].headers['Content-Type']).toBe('application/json')
    })

    test('carries the registry api key as a bearer token and merges its headers', async () => {
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx({
            auth: {ok: true, apiKey: 'sk-test', headers: {'x-tenant': 'acme'}}
        })

        await handler({message: assistant(think(big('a')))}, ctx)

        expect(sent[0].headers.Authorization).toBe('Bearer sk-test')
        expect(sent[0].headers['x-tenant']).toBe('acme')
    })

    test('still compresses when the registry throws — auth degrades to none', async () => {
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx({authThrows: true})

        const out = await handler({message: assistant(think(big('a')))}, ctx)

        expect(sent[0].headers.Authorization).toBeUndefined()
        expect(thinkingOf(out!.message, 0)).toBe('SHORT')
    })
})

describe('registerThinkingCompression — rewriting', () => {
    test('replaces the block and reports the saving on the status line', async () => {
        const {restore} = mockFetch(() => okJson('x'.repeat(50)))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx()

        const out = await handler({message: assistant(think(big('a')))}, ctx)

        expect(thinkingOf(out!.message, 0)).toBe('x'.repeat(50))
        expect(statuses.at(-1)).toBe('✓ reasoning 200→50c (−75%)')
    })

    test('strips <think> wrappers a reasoning model echoes back', async () => {
        const {restore} = mockFetch(() => okJson('<think>tidy</think>'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        const out = await handler({message: assistant(think(big('a')))}, ctx)

        expect(thinkingOf(out!.message, 0)).toBe('tidy')
    })

    test('leaves other content blocks untouched', async () => {
        const {restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        const out = await handler(
            {message: assistant({type: 'text', text: 'answer'}, think(big('a')))},
            ctx
        )

        const content = (out!.message as AssistantMessageLike).content as {text?: string}[]
        expect(content[0].text).toBe('answer')
        expect(thinkingOf(out!.message, 1)).toBe('SHORT')
    })

    test('numbers the status line per block when several are compressed', async () => {
        const {sent, restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx()

        const out = await handler({message: assistant(think(big('a')), think(big('b', 300)))}, ctx)

        expect(sent).toHaveLength(2)
        expect(statuses.some(s => s?.includes('compressing reasoning 1/2 (200c)…'))).toBe(true)
        expect(statuses.some(s => s?.includes('compressing reasoning 2/2 (300c)…'))).toBe(true)
        expect(statuses.at(-1)).toBe('✓ reasoning 500→10c (−98%)')
        expect(thinkingOf(out!.message, 1)).toBe('SHORT')
    })

    test('omits the counter when there is a single block', async () => {
        const {restore} = mockFetch(() => okJson('SHORT'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx()

        await handler({message: assistant(think(big('a')))}, ctx)

        expect(statuses.some(s => s?.includes('compressing reasoning (200c)…'))).toBe(true)
        expect(statuses.some(s => s?.includes('1/1'))).toBe(false)
    })
})

describe('registerThinkingCompression — when compression yields nothing', () => {
    test('an HTTP error leaves the block verbatim and clears the status', async () => {
        const {restore} = mockFetch(() => new Response('boom', {status: 500}))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx, statuses} = fakeCtx()

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
        expect(statuses.at(-1)).toBeUndefined()
    })

    test('a thrown fetch leaves the block verbatim', async () => {
        const original = globalThis.fetch
        globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch
        restoreFetch = () => {
            globalThis.fetch = original
        }
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
    })

    test('a reply that is not shorter is discarded', async () => {
        const {restore} = mockFetch(() => okJson(big('a') + 'EXTRA'))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
    })

    test('an empty reply is discarded', async () => {
        const {restore} = mockFetch(() => okJson('   '))
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
    })

    test('a malformed body is discarded, not thrown', async () => {
        const {restore} = mockFetch(
            () =>
                new Response(JSON.stringify({}), {
                    status: 200,
                    headers: {'content-type': 'application/json'}
                })
        )
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        expect(await handler({message: assistant(think(big('a')))}, ctx)).toBeUndefined()
    })

    test('one failed block does not stop the next one', async () => {
        const {sent, restore} = mockFetch(n =>
            n === 0 ? new Response('boom', {status: 500}) : okJson('SHORT')
        )
        restoreFetch = restore
        const handler = registerAndCapture()
        const {ctx} = fakeCtx()

        const out = await handler({message: assistant(think(big('a')), think(big('b', 300)))}, ctx)

        expect(sent).toHaveLength(2)
        expect(thinkingOf(out!.message, 0)).toBe(big('a'))
        expect(thinkingOf(out!.message, 1)).toBe('SHORT')
    })
})
