import {createServer} from 'node:http'
import {networkInterfaces} from 'node:os'
import {WebSocketServer} from 'ws'
import {addClient, removeClient, clientCount, broadcast, sendTo} from './broadcast.js'
import type {Turn} from './history.js'
import {getBridge, answerPrompt} from './bridge.js'
import {isClientMessage} from './protocol.js'

export interface ServerHandle {
    port: number
    ip: string
    stop(): void
    onFirstConnect: (() => void) | null
}

type MessageCallback = (text: string) => void

function getLocalIP(): string {
    const nets = networkInterfaces()
    // Prefer Tailscale when available
    for (const net of nets['tailscale0'] ?? []) {
        if (net.family === 'IPv4') return net.address
    }
    for (const iface of Object.values(nets)) {
        if (!iface) continue
        for (const net of iface) {
            if (net.family === 'IPv4' && !net.internal) return net.address
        }
    }
    return '127.0.0.1'
}

async function tryBind(port: number): Promise<boolean> {
    return new Promise(resolve => {
        const s = createServer()
        s.listen(port, '0.0.0.0', () => {
            s.close(() => resolve(true))
        })
        s.on('error', () => resolve(false))
    })
}

async function findPort(start: number, max: number): Promise<number> {
    for (let p = start; p < start + max; p++) {
        if (await tryBind(p)) return p
    }
    throw new Error(`No free port found in range ${start}–${start + max - 1}`)
}

export async function startServer(
    onMessage: MessageCallback,
    getHtml: (wsUrl: string) => string,
    getHistory: () => Turn[]
): Promise<ServerHandle> {
    const port = await findPort(8800, 100)
    const ip = getLocalIP()
    const wsUrl = `ws://${ip}:${port}/ws`

    const httpServer = createServer((req, res) => {
        if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
            const body = getHtml(wsUrl)
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
            res.end(body)
        } else {
            res.writeHead(404)
            res.end('Not found')
        }
    })

    const wss = new WebSocketServer({server: httpServer, path: '/ws'})

    const handle: ServerHandle = {
        port,
        ip,
        onFirstConnect: null,
        stop() {
            wss.close()
            httpServer.close()
        }
    }

    wss.on('connection', ws => {
        addClient(ws)
        handle.onFirstConnect?.()
        handle.onFirstConnect = null
        sendTo(ws, {type: 'history', turns: getHistory()})
        const bridge = getBridge()
        for (const [key, lines] of bridge.activeWidgets) {
            sendTo(ws, {type: 'widget', key, lines})
        }
        if (bridge.activePrompt) sendTo(ws, bridge.activePrompt)
        broadcast({type: 'client_count', count: clientCount()})

        ws.on('message', data => {
            let msg: unknown
            try {
                msg = JSON.parse(data.toString())
            } catch {
                return // ignore malformed JSON
            }
            if (!isClientMessage(msg)) return
            if (msg.type === 'prompt_answer') {
                answerPrompt(msg.id, msg.value)
                return
            }
            // type === 'message': ignore while a prompt is pending (composer is
            // disabled in the browser; this is the server-side guard).
            if (getBridge().activePrompt) return
            onMessage(msg.text)
        })

        ws.on('close', () => {
            removeClient(ws)
            broadcast({type: 'client_count', count: clientCount()})
        })
    })

    await new Promise<void>(resolve => httpServer.listen(port, '0.0.0.0', resolve))

    return handle
}
