import {describe, it, expect, beforeEach, afterEach, test} from 'bun:test'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {startServer, getLocalIPs, formatAddresses} from './server.js'
import type {ServerHandle} from './server.js'
import WebSocket from 'ws'
import {getBridge} from './bridge.js'
import {reset, setPrompt, setContext, addUserTurn} from './session-state.js'
import {clearSubscriptions, getSubscriptions} from './push.js'

let handle: ServerHandle | null = null

// The /push-key and /subscribe routes persist vapid.json and subscriptions.json
// under data-home; redirect that at a temp dir so the suite never writes to the
// real ~/.local/share.
let xdgDir: string | null = null
let prevXdg: string | undefined
beforeEach(() => {
    prevXdg = process.env.XDG_DATA_HOME
    xdgDir = mkdtempSync(path.join(tmpdir(), 'server-xdg-'))
    process.env.XDG_DATA_HOME = xdgDir
})

afterEach(() => {
    handle?.stop()
    handle = null
    const b = getBridge()
    b.pending.clear()
    reset()
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prevXdg
    if (xdgDir) rmSync(xdgDir, {recursive: true, force: true})
    xdgDir = null
})

describe('getLocalIPs', () => {
    const v4 = (address: string, internal = false) => ({
        address,
        family: 'IPv4' as const,
        internal,
        netmask: '255.255.255.0',
        mac: '00:00:00:00:00:00',
        cidr: null
    })

    it('separates the Tailscale address from the LAN address', () => {
        const ips = getLocalIPs({
            tailscale0: [v4('100.92.14.7')],
            eth0: [v4('192.168.1.42')],
            lo: [v4('127.0.0.1', true)]
        })
        expect(ips.tailscale).toBe('100.92.14.7')
        expect(ips.lan).toBe('192.168.1.42')
        expect(ips.primary).toBe('100.92.14.7')
    })

    it('falls back to LAN as primary when there is no Tailscale interface', () => {
        const ips = getLocalIPs({
            eth0: [v4('192.168.1.42')],
            lo: [v4('127.0.0.1', true)]
        })
        expect(ips.tailscale).toBeUndefined()
        expect(ips.lan).toBe('192.168.1.42')
        expect(ips.primary).toBe('192.168.1.42')
    })

    it('ignores internal interfaces and defaults primary to loopback', () => {
        const ips = getLocalIPs({lo: [v4('127.0.0.1', true)]})
        expect(ips.tailscale).toBeUndefined()
        expect(ips.lan).toBeUndefined()
        expect(ips.primary).toBe('127.0.0.1')
    })

    it('does not treat the Tailscale address as the LAN address', () => {
        const ips = getLocalIPs({tailscale0: [v4('100.92.14.7')]})
        expect(ips.tailscale).toBe('100.92.14.7')
        expect(ips.lan).toBeUndefined()
    })
})

describe('formatAddresses', () => {
    it('labels both Tailscale and LAN full URLs', () => {
        const addrs = formatAddresses(
            {tailscale: '100.92.14.7', lan: '192.168.1.42', primary: '100.92.14.7'},
            8800
        )
        expect(addrs).toEqual([
            {label: 'Tailscale', url: 'http://100.92.14.7:8800'},
            {label: 'LAN', url: 'http://192.168.1.42:8800'}
        ])
    })

    it('emits only the LAN line when Tailscale is absent', () => {
        const addrs = formatAddresses({lan: '192.168.1.42', primary: '192.168.1.42'}, 8800)
        expect(addrs).toEqual([{label: 'LAN', url: 'http://192.168.1.42:8800'}])
    })

    it('falls back to a single unlabeled primary URL when no interfaces resolve', () => {
        const addrs = formatAddresses({primary: '127.0.0.1'}, 8801)
        expect(addrs).toEqual([{label: '', url: 'http://127.0.0.1:8801'}])
    })
})

describe('startServer', () => {
    it('starts on a port >= 8800', async () => {
        handle = await startServer(
            () => {},
            wsUrl => `<html>${wsUrl}</html>`
        )
        expect(handle.port).toBeGreaterThanOrEqual(8800)
        expect(handle.port).toBeLessThan(8900)
    })

    it('HTTP GET / serves the HTML with WS url embedded', async () => {
        handle = await startServer(
            () => {},
            wsUrl => `WSURL:${wsUrl}`
        )
        const res = await fetch(`http://127.0.0.1:${handle.port}/`)
        const body = await res.text()
        expect(res.status).toBe(200)
        expect(body).toContain(`WSURL:ws://`)
        expect(body).toContain(`:${handle.port}/ws`)
    })

    it('WebSocket connects and receives a snapshot reflecting the transcript', async () => {
        addUserTurn('hi')
        handle = await startServer(
            () => {},
            _wsUrl => `<html></html>`
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
        expect(received[0]).toMatchObject({
            type: 'snapshot',
            turns: [{role: 'user', text: 'hi'}]
        })
    })

    it('calls onMessage callback with parsed text when browser sends message', async () => {
        const messages: string[] = []
        handle = await startServer(
            text => messages.push(text),
            () => '<html></html>'
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
            () => '<html></html>'
        )
        const port = handle.port
        handle.stop()
        handle = null
        await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow()
    })

    it('GET /sw.js serves the service worker as JavaScript', async () => {
        handle = await startServer(
            () => {},
            () => '<html></html>'
        )
        const res = await fetch(`http://127.0.0.1:${handle.port}/sw.js`)
        expect(res.status).toBe(200)
        expect(res.headers.get('content-type')).toContain('javascript')
        const body = await res.text()
        expect(body).toContain('push')
        expect(body).toContain('showNotification')
    })

    it('GET /push-key returns the VAPID public key', async () => {
        handle = await startServer(
            () => {},
            () => '<html></html>'
        )
        const res = await fetch(`http://127.0.0.1:${handle.port}/push-key`)
        expect(res.status).toBe(200)
        const key = await res.text()
        expect(key.length).toBeGreaterThan(20)
    })

    it('POST /subscribe stores the subscription and returns 201', async () => {
        clearSubscriptions()
        handle = await startServer(
            () => {},
            () => '<html></html>'
        )
        const subscription = {
            endpoint: 'https://push.example/abc',
            keys: {p256dh: 'p', auth: 'a'}
        }
        const res = await fetch(`http://127.0.0.1:${handle.port}/subscribe`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(subscription)
        })
        expect(res.status).toBe(201)
        expect(getSubscriptions().map(s => s.endpoint)).toContain('https://push.example/abc')
    })

    it('POST /subscribe rejects a malformed body with 400', async () => {
        handle = await startServer(
            () => {},
            () => '<html></html>'
        )
        const res = await fetch(`http://127.0.0.1:${handle.port}/subscribe`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: 'not json{'
        })
        expect(res.status).toBe(400)
    })
})

function once(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
        ws.on('message', d => {
            const m = JSON.parse(d.toString()) as Record<string, unknown>
            if (m.type === type) resolve(m)
        })
    })
}

test('the connect snapshot carries the active prompt', async () => {
    setPrompt({type: 'prompt', id: '42', question: 'Which DB?', allowSkip: false})
    const srv = await startServer(
        () => {},
        () => '<html></html>'
    )
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    const snap = await once(ws, 'snapshot')
    expect((snap.prompt as {id: string}).id).toBe('42')
    ws.close()
    srv.stop()
    reset()
})

test('the connect snapshot carries the last context usage', async () => {
    setContext({tokens: 12000, contextWindow: 100000, percent: 12})
    const srv = await startServer(
        () => {},
        () => '<html></html>'
    )
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    const snap = await once(ws, 'snapshot')
    expect(snap.context).toEqual({tokens: 12000, contextWindow: 100000, percent: 12})
    ws.close()
    srv.stop()
    reset()
})

test('prompt_answer frame resolves the pending prompt', async () => {
    const b = getBridge()
    let resolved: string | undefined = 'UNSET'
    b.pending.set('99', v => (resolved = v))
    const srv = await startServer(
        () => {},
        () => '<html></html>'
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
    setPrompt({type: 'prompt', id: '7', question: 'q', allowSkip: false})
    let got = ''
    const srv = await startServer(
        text => (got = text),
        () => '<html></html>'
    )
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`)
    await new Promise(r => ws.on('open', r))
    ws.send(JSON.stringify({type: 'message', text: 'should be dropped'}))
    await new Promise(r => setTimeout(r, 50))
    expect(got).toBe('')
    ws.close()
    srv.stop()
    reset()
})
