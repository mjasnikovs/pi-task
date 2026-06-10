import {describe, it, expect, afterEach} from 'bun:test'
import {startServer} from './server.js'
import type {ServerHandle} from './server.js'
import WebSocket from 'ws'

let handle: ServerHandle | null = null

afterEach(() => {
    handle?.stop()
    handle = null
})

describe('startServer', () => {
    it('starts on a port >= 8800', async () => {
        handle = await startServer(
            () => {},
            wsUrl => `<html>${wsUrl}</html>`,
            () => []
        )
        expect(handle.port).toBeGreaterThanOrEqual(8800)
        expect(handle.port).toBeLessThan(8900)
    })

    it('HTTP GET / serves the HTML with WS url embedded', async () => {
        handle = await startServer(
            () => {},
            wsUrl => `WSURL:${wsUrl}`,
            () => []
        )
        const res = await fetch(`http://127.0.0.1:${handle.port}/`)
        const body = await res.text()
        expect(res.status).toBe(200)
        expect(body).toContain(`WSURL:ws://`)
        expect(body).toContain(`:${handle.port}/ws`)
    })

    it('WebSocket connects and receives history message', async () => {
        const turns = [{role: 'user' as const, text: 'hi', tools: []}]
        handle = await startServer(
            () => {},
            _wsUrl => `<html></html>`,
            () => turns
        )
        const received: unknown[] = []
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws`)
            ws.on('message', data => {
                received.push(JSON.parse(data.toString()))
                ws.close()
                resolve()
            })
            ws.on('error', reject)
            setTimeout(() => reject(new Error('timeout')), 3000)
        })
        expect(received[0]).toMatchObject({type: 'history', turns})
    })

    it('calls onMessage callback with parsed text when browser sends message', async () => {
        const messages: string[] = []
        handle = await startServer(
            text => messages.push(text),
            () => '<html></html>',
            () => []
        )
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(`ws://127.0.0.1:${handle!.port}/ws`)
            ws.on('open', () => {
                ws.send(JSON.stringify({type: 'message', text: 'hello agent'}))
                setTimeout(() => {
                    ws.close()
                    resolve()
                }, 100)
            })
            ws.on('error', reject)
        })
        expect(messages).toContain('hello agent')
    })

    it('stop() closes the server', async () => {
        handle = await startServer(
            () => {},
            () => '<html></html>',
            () => []
        )
        const port = handle.port
        handle.stop()
        handle = null
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    })
})
