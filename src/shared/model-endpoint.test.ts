/**
 * model-endpoint tests — discovery reads a real fixture agent dir; the probe
 * runs against real sockets (a live Bun server, a closed port, a server that
 * never answers), because its whole value is faithfulness to real reachability.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {discoverModelEndpoints, probeModelEndpoints} from './model-endpoint.js'

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
