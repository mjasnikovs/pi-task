import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {broadcast} from './broadcast.js'
import {getBridge, dispatchRemoteLine, dispatchRemoteNewSession, makeShimmedCtx} from './bridge.js'
import {setupEvents} from './events.js'
import {HistoryBuffer} from './history.js'
import {html} from './ui.js'
import {qrLines} from './qr.js'
import {startServer, formatAddresses} from './server.js'
import {ensureTailscaleServe, teardownTailscaleServe, planRemoteUrls} from './tailscale.js'
import type {ServeResult} from './tailscale.js'
import {isAgentIdle} from './state.js'
import type {ServerHandle} from './server.js'

// Shared state that persists across jiti re-evaluations on session switches.
// Each /new causes the extension module to be re-loaded by jiti (moduleCache:false),
// but globalThis survives. This keeps the server running and messages flowing.
type Shared = {
    server: ServerHandle | null
    send: ((text: string, opts?: {deliverAs: 'followUp'}) => void) | null
    serveResult: ServeResult | null
}
const _g = globalThis as unknown as Record<string, Shared | undefined>
if (!_g.__piRemote) _g.__piRemote = {server: null, send: null, serveResult: null}

const S = _g.__piRemote!

export function registerRemote(pi: ExtensionAPI): void {
    const history = new HistoryBuffer(20)

    async function ensureServer(): Promise<ServerHandle> {
        if (S.server) return S.server
        S.server = await startServer(
            text => {
                if (text === '/new') {
                    dispatchRemoteNewSession(newCtx => {
                        S.send = (msg, opts) => {
                            void (opts ?
                                newCtx.sendUserMessage(msg, opts)
                            :   newCtx.sendUserMessage(msg))
                        }
                    })
                    return
                }
                dispatchRemoteLine(text, {
                    onPlain: plain => {
                        history.addUserMessage(plain)
                        if (isAgentIdle()) {
                            S.send?.(plain)
                        } else {
                            S.send?.(plain, {deliverAs: 'followUp'})
                        }
                    }
                })
            },
            wsUrl => html(wsUrl),
            () => history.getEntries()
        )
        // Hands-off HTTPS: point Tailscale serve at our port so phones get a
        // secure context. Best-effort — any failure degrades to the http URL.
        S.serveResult = await ensureTailscaleServe(S.server.port).catch(
            (): ServeResult => ({state: 'unavailable'})
        )
        return S.server
    }

    pi.on('session_start', (_event, ctx) => {
        S.send = (text, opts) => (opts ? pi.sendUserMessage(text, opts) : pi.sendUserMessage(text))
        setupEvents(pi, history, broadcast)
        // Seed a shimmed ctx so commands that don't need newSession (/task-list,
        // /task-cancel, /task-auto-cancel) work immediately from the remote without
        // any terminal interaction. Only overwrite if null or already shimmed —
        // a real command ctx captured from a prior terminal command must survive
        // session_start (it's updated via withSession or registerBridgeCommand,
        // not replaced here).
        const b = getBridge()
        if (
            !b.currentCtx
            || (b.currentCtx as unknown as Record<string, unknown>)['__piRemoteShimmed'] === true
        ) {
            b.currentCtx = makeShimmedCtx(ctx)
        }
        void ensureServer().catch(err =>
            ctx.ui.notify(`Failed to start remote: ${(err as Error).message}`, 'error')
        )
    })

    pi.on('session_shutdown', (event, _ctx) => {
        if (event.reason === 'quit') {
            if (S.server) {
                const port = S.server.port
                S.server.stop()
                S.server = null
                S.serveResult = null
                void teardownTailscaleServe(port).catch(() => {})
            }
            S.send = null
        }
    })

    pi.registerCommand('remote', {
        description: 'Show the remote QR code & URLs (the server is always running)',
        handler: async (args, ctx) => {
            if (args.trim() === 'stop') {
                if (S.server) {
                    const port = S.server.port
                    S.server.stop()
                    S.server = null
                    S.serveResult = null
                    void teardownTailscaleServe(port).catch(() => {})
                    ctx.ui.notify('Remote server stopped', 'info')
                } else {
                    ctx.ui.notify('Remote server is not running', 'warning')
                }
                return
            }

            // Upgrade from shimmed ctx to a real command-capable ctx.
            getBridge().currentCtx = ctx

            try {
                const server = await ensureServer()

                const httpPrimary = `http://${server.ip}:${server.port}`
                const result: ServeResult = S.serveResult ?? {state: 'unavailable'}
                const plan = planRemoteUrls(httpPrimary, result)
                const primaryUrl = plan.primaryUrl
                const qr = await qrLines(primaryUrl)

                const addrs = formatAddresses(server.ips, server.port)
                const labelW = addrs.reduce((m, a) => Math.max(m, a.label.length), 0)
                const addrLines = [
                    ...addrs.map(a => (a.label ? `${a.label.padEnd(labelW)}  ${a.url}` : a.url)),
                    ...plan.hintLines
                ]
                const addrWidth = addrLines.reduce((m, l) => Math.max(m, l.length), 0)

                if (ctx.mode === 'tui') {
                    // eslint-disable-next-line no-control-regex -- strip ANSI SGR escapes to measure visible width
                    const stripAnsi = (s: string) => s.replace(/\x1b\[[^m]*m/g, '')
                    const visWidth = qr.reduce((max, l) => Math.max(max, stripAnsi(l).length), 0)
                    const overlayWidth = Math.max(visWidth, addrWidth + 4, 36)

                    ctx.ui
                        .custom<void>(
                            (_tui, _theme, _kb, done) => ({
                                focused: false,
                                render: w => {
                                    const c = (s: string, len: number) =>
                                        ' '.repeat(Math.max(0, Math.floor((w - len) / 2))) + s
                                    return [
                                        '',
                                        ...qr.map(l => c(l, visWidth)),
                                        '',
                                        ...addrLines.map(l => c(l, addrWidth)),
                                        '',
                                        c('Waiting for connection…', 23),
                                        c('(any key to dismiss)', 20)
                                    ]
                                },
                                handleInput: () => done(undefined),
                                invalidate: () => {},
                                dispose: () => done(undefined)
                            }),
                            {
                                overlay: true,
                                overlayOptions: {width: overlayWidth},
                                onHandle: h => {
                                    server.onFirstConnect = () => h.hide()
                                }
                            }
                        )
                        .catch(() => {})
                }

                ctx.ui.notify(`Remote running at ${primaryUrl}`, 'info')
            } catch (err) {
                ctx.ui.notify(`Failed to start remote: ${(err as Error).message}`, 'error')
            }
        }
    })
}
