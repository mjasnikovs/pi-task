import {createServer} from 'node:http'
import {networkInterfaces} from 'node:os'
import {WebSocketServer} from 'ws'
import {addClient, removeClient, sendTo} from './broadcast.js'
import {answerPrompt} from './bridge.js'
import {getState, snapshot} from './session-state.js'
import {isClientMessage} from './protocol.js'
import {swJs} from './sw.js'
import {publicKey, addSubscription, getSubscriptions, logPush} from './push.js'
import type {PushSubscriptionJSON} from './push.js'

export interface LocalIPs {
    /** Tailscale (tailscale0) IPv4 address, if the interface is up. */
    tailscale?: string
    /** First non-internal, non-Tailscale IPv4 address (the LAN address). */
    lan?: string
    /** Address used for the QR code / primary URL: Tailscale, else LAN, else loopback. */
    primary: string
}

export interface AddressLine {
    /** Network label (e.g. 'Tailscale', 'LAN'); empty for the loopback fallback. */
    label: string
    /** Full http:// URL for that address. */
    url: string
}

export interface ServerHandle {
    port: number
    /** Primary address (Tailscale-preferred); the one the QR encodes. */
    ip: string
    /** All resolved addresses, for displaying both Tailscale and LAN URLs. */
    ips: LocalIPs
    stop(): void
    onFirstConnect: (() => void) | null
}

type MessageCallback = (text: string) => void

export function getLocalIPs(nets = networkInterfaces()): LocalIPs {
    // Prefer Tailscale when available.
    let tailscale: string | undefined
    for (const net of nets['tailscale0'] ?? []) {
        if (net.family === 'IPv4') {
            tailscale = net.address
            break
        }
    }
    // LAN = first non-internal IPv4 that isn't the Tailscale interface.
    let lan: string | undefined
    for (const [name, iface] of Object.entries(nets)) {
        if (!iface || name === 'tailscale0') continue
        for (const net of iface) {
            if (net.family === 'IPv4' && !net.internal) {
                lan = net.address
                break
            }
        }
        if (lan) break
    }
    return {tailscale, lan, primary: tailscale ?? lan ?? '127.0.0.1'}
}

/** Build the labeled URL lines shown under the QR code. Both Tailscale and LAN
 *  when present; a single unlabeled primary URL when neither resolves. The
 *  Tailscale line uses the MagicDNS host when known (resolves to the same node,
 *  but is what SSH and webpush certs need), falling back to the raw IP. */
export function formatAddresses(ips: LocalIPs, port: number, tsHost?: string): AddressLine[] {
    const out: AddressLine[] = []
    if (tsHost) out.push({label: 'Tailscale', url: `http://${tsHost}:${port}`})
    else if (ips.tailscale) out.push({label: 'Tailscale', url: `http://${ips.tailscale}:${port}`})
    if (ips.lan) out.push({label: 'LAN', url: `http://${ips.lan}:${port}`})
    if (out.length === 0) out.push({label: '', url: `http://${ips.primary}:${port}`})
    return out
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
    onInterrupt?: () => void
): Promise<ServerHandle> {
    const port = await findPort(8800, 100)
    const ips = getLocalIPs()
    const ip = ips.primary
    const wsUrl = `ws://${ip}:${port}/ws`

    const httpServer = createServer((req, res) => {
        if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
            const body = getHtml(wsUrl)
            res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
            res.end(body)
        } else if (req.method === 'GET' && req.url === '/sw.js') {
            res.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8'})
            res.end(swJs())
        } else if (req.method === 'GET' && req.url === '/push-key') {
            res.writeHead(200, {'Content-Type': 'text/plain; charset=utf-8'})
            res.end(publicKey())
        } else if (req.method === 'POST' && req.url === '/subscribe') {
            const chunks: Buffer[] = []
            req.on('data', c => chunks.push(c as Buffer))
            req.on('end', () => {
                try {
                    const sub = JSON.parse(Buffer.concat(chunks).toString()) as PushSubscriptionJSON
                    if (!sub || typeof sub.endpoint !== 'string') throw new Error('no endpoint')
                    addSubscription(sub)
                    logPush(
                        `subscribe ${new URL(sub.endpoint).host} (total ${getSubscriptions().length})`
                    )
                    res.writeHead(201)
                    res.end('ok')
                } catch {
                    logPush('subscribe REJECTED (malformed body)')
                    res.writeHead(400)
                    res.end('bad subscription')
                }
            })
        } else {
            res.writeHead(404)
            res.end('Not found')
        }
    })

    const wss = new WebSocketServer({server: httpServer, path: '/ws'})

    // Track every accepted TCP socket so stop() can forcibly destroy lingering
    // keep-alive / WebSocket connections. Without this, httpServer.close() only
    // stops accepting new connections and waits for existing ones to drain — an
    // open browser tab never drains, so the listening server and its sockets
    // stay as active event-loop handles forever. In headless print mode the host
    // exits by natural event-loop drain (it sets process.exitCode and returns,
    // with no process.exit()), so these lingering handles keep the pi process
    // alive indefinitely — which blocks `docker stop` / OS shutdown until the
    // SIGKILL grace timeout fires. A/B-proven: terminating clients + destroying
    // sockets here makes the loop drain in ~2ms instead of never.
    const sockets = new Set<import('node:net').Socket>()
    httpServer.on('connection', s => {
        sockets.add(s)
        s.on('close', () => sockets.delete(s))
    })

    const handle: ServerHandle = {
        port,
        ip,
        ips,
        onFirstConnect: null,
        stop() {
            // Terminate WebSocket clients (immediate close, no drain), then
            // destroy any remaining raw sockets, then close the servers so the
            // event loop has no lingering handles holding the process open.
            for (const ws of wss.clients) ws.terminate()
            wss.close()
            for (const s of sockets) s.destroy()
            sockets.clear()
            httpServer.close()
            httpServer.closeAllConnections?.()
        }
    }

    wss.on('connection', ws => {
        addClient(ws)
        handle.onFirstConnect?.()
        handle.onFirstConnect = null
        // One authoritative snapshot — the client replaces its whole view with it.
        sendTo(ws, snapshot())

        ws.on('message', data => {
            let msg: unknown
            try {
                msg = JSON.parse(data.toString())
            } catch {
                return // ignore malformed JSON
            }
            if (!isClientMessage(msg)) return
            if (msg.type === 'interrupt') {
                onInterrupt?.()
                return
            }
            if (msg.type === 'prompt_answer') {
                answerPrompt(msg.id, msg.value)
                return
            }
            // type === 'message': ignore while a prompt is pending (composer is
            // disabled in the browser; this is the server-side guard).
            if (getState().prompt) return
            onMessage(msg.text)
        })

        ws.on('close', () => {
            removeClient(ws)
        })
    })

    await new Promise<void>(resolve => httpServer.listen(port, '0.0.0.0', resolve))

    return handle
}
