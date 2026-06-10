import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {broadcast} from './broadcast.js'
import {getBridge} from './bridge.js'
import {setupEvents} from './events.js'
import {HistoryBuffer} from './history.js'
import {html} from './ui.js'
import {qrLines} from './qr.js'
import {startServer} from './server.js'
import {isAgentIdle} from './state.js'
import type {ServerHandle} from './server.js'

// Shared state that persists across jiti re-evaluations on session switches.
// Each /new causes the extension module to be re-loaded by jiti (moduleCache:false),
// but globalThis survives. This keeps the server running and messages flowing.
type Shared = {
    server: ServerHandle | null
    send: ((text: string, opts?: {deliverAs: 'followUp'}) => void) | null
    newSession: (() => Promise<{cancelled: boolean}>) | null
}
const _g = globalThis as unknown as Record<string, Shared | undefined>
if (!_g.__piRemote) _g.__piRemote = {server: null, send: null, newSession: null}

const S = _g.__piRemote!

export function registerRemote(pi: ExtensionAPI): void {
    const history = new HistoryBuffer(20)

    function bindNewSession(ctx: ExtensionCommandContext): void {
        S.newSession = () =>
            ctx.newSession({
                // eslint-disable-next-line @typescript-eslint/require-await
                withSession: async newCtx => {
                    // newCtx.sendUserMessage bypasses stale runtime check (returns Promise, discard it)
                    S.send = (text, opts) => {
                        void (opts ?
                            newCtx.sendUserMessage(text, opts)
                        :   newCtx.sendUserMessage(text))
                    }
                    bindNewSession(newCtx)
                }
            })
    }

    pi.on('session_start', (_event, ctx) => {
        // Update shared send with fresh pi on each session (survives /new re-evaluation)
        S.send = (text, opts) => (opts ? pi.sendUserMessage(text, opts) : pi.sendUserMessage(text))
        setupEvents(pi, history, broadcast)
        getBridge().currentCtx = ctx as unknown as ExtensionCommandContext
    })

    pi.on('session_shutdown', (event, _ctx) => {
        if (event.reason === 'quit') {
            if (S.server) {
                S.server.stop()
                S.server = null
            }
            S.send = null
            S.newSession = null
        }
    })

    pi.registerCommand('remote', {
        description: 'Start (or stop) the remote web view',
        handler: async (args, ctx) => {
            if (args.trim() === 'stop') {
                if (S.server) {
                    S.server.stop()
                    S.server = null
                    ctx.ui.setWidget('remote', undefined)
                    ctx.ui.notify('Remote server stopped', 'info')
                } else {
                    ctx.ui.notify('Remote server is not running', 'warning')
                }
                return
            }

            if (S.server) {
                ctx.ui.notify(
                    `Remote already running at http://${S.server.ip}:${S.server.port}`,
                    'info'
                )
                return
            }

            bindNewSession(ctx)

            try {
                S.server = await startServer(
                    text => {
                        if (text.startsWith('/')) {
                            if (text === '/new') {
                                S.newSession?.().catch(() => {})
                            }
                            return
                        }
                        // Persist remote-typed messages: they arrive via sendUserMessage
                        // with source "extension", which the interactive input handler
                        // skips, so record them here for reconnect/history.
                        history.addUserMessage(text)
                        if (isAgentIdle()) {
                            S.send?.(text)
                        } else {
                            S.send?.(text, {deliverAs: 'followUp'})
                        }
                    },
                    wsUrl => html(wsUrl),
                    () => history.getEntries()
                )

                const url = `http://${S.server.ip}:${S.server.port}`
                const lines = await qrLines(url)

                if (ctx.mode === 'tui') {
                    // eslint-disable-next-line no-control-regex -- strip ANSI SGR escapes to measure visible width
                    const stripAnsi = (s: string) => s.replace(/\x1b\[[^m]*m/g, '')
                    const visWidth = lines.reduce((max, l) => Math.max(max, stripAnsi(l).length), 0)
                    const overlayWidth = Math.max(visWidth, url.length + 4, 36)

                    // Fire-and-forget: don't await so the command handler returns immediately
                    // (avoids "Working" lock if user runs /new before dismissing)
                    ctx.ui
                        .custom<void>(
                            (_tui, _theme, _kb, done) => ({
                                focused: false,
                                render: w => {
                                    const c = (s: string, len: number) =>
                                        ' '.repeat(Math.max(0, Math.floor((w - len) / 2))) + s
                                    return [
                                        '',
                                        ...lines.map(l => c(l, visWidth)),
                                        '',
                                        c(url, url.length),
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
                                    S.server!.onFirstConnect = () => h.hide()
                                }
                            }
                        )
                        .catch(() => {})
                }

                ctx.ui.setWidget('remote', [`  Remote: ${url}`, ''])
                ctx.ui.notify(`Remote started at ${url}`, 'info')
            } catch (err) {
                ctx.ui.notify(`Failed to start remote: ${(err as Error).message}`, 'error')
            }
        }
    })
}
