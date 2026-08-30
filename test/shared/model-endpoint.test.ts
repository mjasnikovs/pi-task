/**
 * Nothing here is mocked. Discovery reads a models.json written into a real
 * temp dir; every probe test runs against a real socket — a live Bun server, a
 * port bound then closed, a server that accepts and never answers.
 *
 * The module's whole value is that it reports what is actually reachable, so a
 * faked transport would test the fake.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    discoverModelEndpoints,
    probeChatTemplateCaps,
    probeModelEndpoints
} from '../../src/shared/model-endpoint.js'

function makeAgentDir(modelsJson?: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-dir-'))
    if (modelsJson !== undefined) {
        fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify(modelsJson))
    }
    return dir
}

describe('discoverModelEndpoints', () => {
    test('collects every provider baseUrl, deduplicated', () => {
        const dir = makeAgentDir({
            providers: {
                a: {baseUrl: 'http://127.0.0.1:8080/v1'},
                b: {baseUrl: 'http://127.0.0.1:8080/v1'},
                c: {baseUrl: 'http://10.0.0.2:9000/v1'},
                d: {api: 'openai-completions'}
            }
        })
        expect(discoverModelEndpoints(dir)).toEqual([
            'http://127.0.0.1:8080/v1',
            'http://10.0.0.2:9000/v1'
        ])
    })

    test('missing file, malformed json, or no providers → empty', () => {
        expect(discoverModelEndpoints(makeAgentDir())).toEqual([])
        const dir = makeAgentDir()
        fs.writeFileSync(path.join(dir, 'models.json'), 'not json')
        expect(discoverModelEndpoints(dir)).toEqual([])
        expect(discoverModelEndpoints(makeAgentDir({providers: {}}))).toEqual([])
    })
})

describe('probeModelEndpoints', () => {
    test('nothing to probe → reachable (never license a kill blind)', async () => {
        expect(await probeModelEndpoints([])).toBe(true)
    })

    test('a live server is reachable even when the path 404s', async () => {
        const srv = Bun.serve({port: 0, fetch: () => new Response('no', {status: 404})})
        try {
            expect(await probeModelEndpoints([`http://127.0.0.1:${srv.port}/v1`])).toBe(true)
        } finally {
            void srv.stop(true)
        }
    })

    test('a closed port is unreachable', async () => {
        // Bind then close to get a port that is definitely free.
        const srv = Bun.serve({port: 0, fetch: () => new Response('x')})
        const port = srv.port
        await srv.stop(true)
        expect(await probeModelEndpoints([`http://127.0.0.1:${port}/v1`], 2_000)).toBe(false)
    })

    test('a server that never answers is unreachable (hang = dead)', async () => {
        const srv = Bun.serve({
            port: 0,
            fetch: () => new Promise<Response>(() => {})
        })
        try {
            expect(await probeModelEndpoints([`http://127.0.0.1:${srv.port}/v1`], 300)).toBe(false)
        } finally {
            void srv.stop(true)
        }
    })

    test('one live endpoint among dead ones → reachable', async () => {
        const srv = Bun.serve({port: 0, fetch: () => new Response('ok')})
        const dead = Bun.serve({port: 0, fetch: () => new Response('x')})
        const deadPort = dead.port
        await dead.stop(true)
        try {
            expect(
                await probeModelEndpoints(
                    [`http://127.0.0.1:${deadPort}/v1`, `http://127.0.0.1:${srv.port}/v1`],
                    2_000
                )
            ).toBe(true)
        } finally {
            void srv.stop(true)
        }
    })
})

describe('probeChatTemplateCaps', () => {
    /** The shape llama-server's /props really returns: `build_info`, `model_path`,
     *  `chat_template` and `chat_template_caps` are all top-level keys on it. */
    const PROPS = (caps: Record<string, boolean>, template: string): string =>
        JSON.stringify({
            build_info: 'b10618-1efd800e9',
            model_path: '/models/some.gguf',
            chat_template: template,
            chat_template_caps: caps
        })

    test('reads the capability flags and the template', async () => {
        const srv = Bun.serve({
            port: 0,
            fetch: req =>
                new URL(req.url).pathname === '/props' ?
                    new Response(
                        PROPS(
                            {supports_reasoning_effort: true, supports_preserve_reasoning: true},
                            '{%- if enable_thinking is defined %}'
                        )
                    )
                :   new Response('nope', {status: 404})
        })
        try {
            const caps = await probeChatTemplateCaps(`http://127.0.0.1:${srv.port}`)
            expect(caps).toEqual({
                supportsReasoningEffort: true,
                supportsPreserveReasoning: true,
                mentionsEnableThinking: true
            })
        } finally {
            void srv.stop(true)
        }
    })

    test('a /v1 base URL still reaches /props, not /v1/props', async () => {
        // /props lives at the SERVER ROOT while a configured llama.cpp baseUrl
        // carries the OpenAI-compatible /v1 prefix, so the request must not
        // inherit it. `seen` is what proves it: the probe hit /props and nothing
        // else. A /v1/props would 404 and report `null`, losing the better
        // signal silently instead of failing visibly.
        const seen: string[] = []
        const srv = Bun.serve({
            port: 0,
            fetch: req => {
                const p = new URL(req.url).pathname
                seen.push(p)
                return p === '/props' ?
                        new Response(PROPS({supports_reasoning_effort: false}, ''))
                    :   new Response('nope', {status: 404})
            }
        })
        try {
            const caps = await probeChatTemplateCaps(`http://127.0.0.1:${srv.port}/v1`)
            expect(seen).toEqual(['/props'])
            expect(caps?.supportsReasoningEffort).toBe(false)
        } finally {
            void srv.stop(true)
        }
    })

    test('a template with no enable_thinking reports the model cannot switch', async () => {
        const srv = Bun.serve({
            port: 0,
            fetch: () => new Response(PROPS({supports_reasoning_effort: false}, '{{ bos_token }}'))
        })
        try {
            const caps = await probeChatTemplateCaps(`http://127.0.0.1:${srv.port}`)
            expect(caps?.mentionsEnableThinking).toBe(false)
        } finally {
            void srv.stop(true)
        }
    })

    test('null — never a throw — for every backend that is not llama.cpp', async () => {
        // `null` is a first-class result, not an error. Three ways a non-llama.cpp
        // server says "no /props here" — 404, a non-JSON 200, and JSON without a
        // `chat_template_caps` — all have to land on it, so the caller degrades to
        // the models.json view instead of warning about a server it could not read.
        const notFound = Bun.serve({port: 0, fetch: () => new Response('x', {status: 404})})
        const notJson = Bun.serve({port: 0, fetch: () => new Response('<html>')})
        const noCaps = Bun.serve({port: 0, fetch: () => new Response(JSON.stringify({a: 1}))})
        try {
            expect(await probeChatTemplateCaps(`http://127.0.0.1:${notFound.port}`)).toBeNull()
            expect(await probeChatTemplateCaps(`http://127.0.0.1:${notJson.port}`)).toBeNull()
            expect(await probeChatTemplateCaps(`http://127.0.0.1:${noCaps.port}`)).toBeNull()
        } finally {
            void notFound.stop(true)
            void notJson.stop(true)
            void noCaps.stop(true)
        }
    })

    test('null for an unreachable endpoint, without hanging the caller', async () => {
        const srv = Bun.serve({port: 0, fetch: () => new Response('x')})
        const port = srv.port
        // AWAITED, not voided. Run against a server that is still listening, this
        // probe also returns null — the body `x` is not JSON — so the assertion
        // below PASSES either way. Only awaiting the stop makes it test closure.
        await srv.stop(true)
        expect(await probeChatTemplateCaps(`http://127.0.0.1:${port}`, 500)).toBeNull()
    })
})
