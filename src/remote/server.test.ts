import {describe, it, expect, afterEach, test} from 'bun:test'
import {startServer} from './server.js'
import type {ServerHandle} from './server.js'
import WebSocket from 'ws'
import {getBridge, answerPrompt} from './bridge.js'

let handle: ServerHandle | null = null

afterEach(() => {
    handle?.stop()
    handle = null
    const b = getBridge()
    b.pending.clear()
    b.activePrompt = null
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

function once(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
        ws.on('message', d => {
            const m = JSON.parse(d.toString())
            if (m.type === type) resolve(m)
        })
    })
}

test('connecting browser receives the active prompt on handshake', async () => {
    const b = getBridge()
    b.activePrompt = {type: 'prompt', id: '42', question: 'Which DB?', allowSkip: false}
    const srv = await startServer(
        () => {},
        () => '<html></html>',
        () => []
    )
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    const prompt = await once(ws, 'prompt')
    expect(prompt.id).toBe('42')
    ws.close()
    srv.stop()
    b.activePrompt = null
})

test('prompt_answer frame resolves the pending prompt', async () => {
    const b = getBridge()
    let resolved: string | undefined = 'UNSET'
    b.pending.set('99', v => (resolved = v))
    const srv = await startServer(
        () => {},
        () => '<html></html>',
        () => []
    )
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({type: 'prompt_answer', id: '99', value: 'sqlite'}))
    await new Promise(r => setTimeout(r, 50))
    expect(resolved).toBe('sqlite')
    ws.close()
    srv.stop()
})

test('plain message is ignored while a prompt is pending', async () => {
    const b = getBridge()
    b.activePrompt = {type: 'prompt', id: '7', question: 'q', allowSkip: false}
    let got = ''
    const srv = await startServer(
        text => (got = text),
        () => '<html></html>',
        () => []
    )
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({type: 'message', text: 'should be dropped'}))
    await new Promise(r => setTimeout(r, 50))
    expect(got).toBe('')
    ws.close()
    srv.stop()
    b.activePrompt = null
})
