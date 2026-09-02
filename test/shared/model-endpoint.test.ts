/**
 * Nothing here is mocked. The saved default is read from a settings.json
 * written into a real temp dir; every probe test runs against a real socket — a
 * live Bun server, a port bound then closed, a server that accepts and never
 * answers.
 *
 * The module's whole value is that it reports what is actually reachable, so a
 * faked transport would test the fake. The url table itself is the session
 * snapshot in config/group-args.ts, set here the way session_start sets it.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    childModelEndpoints,
    defaultModelRef,
    probeChatTemplateCaps,
    probeModelEndpoints
} from '../../src/shared/model-endpoint.js'
import {setModelEndpoints} from '../../src/config/group-args.js'

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

/** An agent dir with any subset of the files pi keeps there. */
function makeDir(files: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-dir-'))
    for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), JSON.stringify(body))
    }
    return dir
}

describe('defaultModelRef', () => {
    test('reads the pair a child will actually resolve', () => {
        const dir = makeDir({
            'settings.json': {defaultProvider: 'local', defaultModel: 'Qwen.gguf', theme: 'dark'}
        })
        expect(defaultModelRef(dir)).toEqual({provider: 'local', id: 'Qwen.gguf'})
    })

    test('a half-written or absent settings.json is undefined, never a partial ref', () => {
        expect(defaultModelRef(makeDir({}))).toBeUndefined()
        expect(
            defaultModelRef(makeDir({'settings.json': {defaultProvider: 'local'}}))
        ).toBeUndefined()
        expect(defaultModelRef(makeDir({'settings.json': {defaultModel: 'x'}}))).toBeUndefined()
        expect(
            defaultModelRef(makeDir({'settings.json': {defaultProvider: '', defaultModel: 'x'}}))
        ).toBeUndefined()
    })
})

describe('childModelEndpoints', () => {
    const LOCAL = 'http://127.0.0.1:8080/v1'
    const CLOUD = 'https://api.example/v1'
    const saved = (): string =>
        makeDir({'settings.json': {defaultProvider: 'local', defaultModel: 'Qwen.gguf'}})
    /** Run `body` against a session snapshot, and always clear it after. */
    const withEndpoints = (entries: Array<[string, string]>, body: () => void): void => {
        setModelEndpoints(new Map(entries))
        try {
            body()
        } finally {
            setModelEndpoints(new Map())
        }
    }

    test('a PINNED child probes ITS OWN backend, not the saved default', () => {
        // The regression this parameter exists for. `--model` means the child is
        // not on the saved default, so reading that default asks about the wrong
        // server — and gets it wrong in both directions.
        const dir = saved()
        withEndpoints(
            [
                ['local/Qwen.gguf', LOCAL],
                ['cloud/kimi', CLOUD]
            ],
            () => {
                expect(childModelEndpoints('cloud/kimi', dir)).toEqual([CLOUD])
                // And the unpinned child still asks about the default.
                expect(childModelEndpoints(undefined, dir)).toEqual([LOCAL])
            }
        )
    })

    test('a built-in provider is probed too — the registry knows its url', () => {
        // The on-disk parser this replaced answered `undefined` for every one of
        // pi-ai's built-in providers, leaving the guard blind exactly there.
        withEndpoints([['anthropic/claude-x', 'https://api.anthropic.com']], () => {
            expect(childModelEndpoints('anthropic/claude-x')).toEqual(['https://api.anthropic.com'])
        })
    })

    test('a model the session did not see probes NOTHING, and so never kills', () => {
        // NOT some other url: probing another provider's server on behalf of
        // this child is the false positive this avoids. An empty list reads as
        // reachable.
        withEndpoints([['local/Qwen.gguf', LOCAL]], () => {
            expect(childModelEndpoints('acme/unknown')).toEqual([])
        })
    })

    test('the default model resolves to exactly one url', () => {
        const dir = saved()
        withEndpoints(
            [
                ['local/Qwen.gguf', LOCAL],
                ['other/x', 'http://10.0.0.2:9000/v1']
            ],
            () => expect(childModelEndpoints(undefined, dir)).toEqual([LOCAL])
        )
    })

    test('no readable default → nothing to probe', () => {
        withEndpoints([['local/Qwen.gguf', LOCAL]], () => {
            expect(childModelEndpoints(undefined, makeDir({}))).toEqual([])
        })
    })

    test('before any session_start the snapshot is empty and the guard never kills', () => {
        expect(childModelEndpoints('local/Qwen.gguf')).toEqual([])
        expect(childModelEndpoints(undefined, saved())).toEqual([])
    })

    test('THE REGRESSION: a dead backend beside a live one is reported dead', async () => {
        const live = Bun.serve({port: 0, fetch: () => new Response('ok')})
        const dead = Bun.serve({port: 0, fetch: () => new Response('x')})
        const deadPort = dead.port
        await dead.stop(true)
        const deadUrl = `http://127.0.0.1:${deadPort}/v1`
        const liveUrl = `http://127.0.0.1:${live.port}/v1`
        const dir = saved()
        setModelEndpoints(
            new Map([
                ['local/Qwen.gguf', deadUrl],
                ['cloud/x', liveUrl]
            ])
        )
        try {
            // What a whole-machine OR would say: `cloud` answers, so the guard
            // disarms itself for a child that will never speak again.
            expect(await probeModelEndpoints([deadUrl, liveUrl], 2_000)).toBe(true)
            // What it asks now, for an unpinned child on the dead default.
            expect(await probeModelEndpoints(childModelEndpoints(undefined, dir), 2_000)).toBe(
                false
            )
            // And a child PINNED to the live provider is not condemned by it.
            expect(await probeModelEndpoints(childModelEndpoints('cloud/x', dir), 2_000)).toBe(true)
        } finally {
            setModelEndpoints(new Map())
            void live.stop(true)
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
