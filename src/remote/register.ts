import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {
    getBridge,
    dispatchRemoteLine,
    dispatchRemoteNewSession,
    makeShimmedCtx,
    interruptAgent,
    registerBridgeCommand,
    registerRemoteOnlyCommand,
    publishNotify
} from './bridge.js'
import {setupEvents} from './events.js'
import {reset, addUserTurn, setHeld, getState} from './session-state.js'
import {html} from './ui.js'
import {qrLines} from './qr.js'
import {startServer, formatAddresses} from './server.js'
import {
    ensureTailscaleServe,
    teardownTailscaleServe,
    planRemoteUrls,
    hostFromResult
} from './tailscale.js'
import type {ServeResult} from './tailscale.js'
import {
    holdInput,
    isRunActive,
    clearHeldInput,
    heldInput,
    setHeldInputListener
} from '../task/mid-run-input.js'
import type {ServerHandle} from './server.js'

// Shared state that persists across jiti re-evaluations on session switches.
// Each /new causes the extension module to be re-loaded by jiti (moduleCache:false),
// but globalThis survives. This keeps the server running and messages flowing.
type Shared = {
    server: ServerHandle | null
    send: ((text: string, opts?: {deliverAs: 'steer' | 'followUp'}) => void) | null
    serveResult: ServeResult | null
}
const _g = globalThis as unknown as Record<string, Shared | undefined>
if (!_g.__piRemote) _g.__piRemote = {server: null, send: null, serveResult: null}

const S = _g.__piRemote!

/**
 * Where a plain (non-slash) browser line goes. Exported so the decision is
 * tested as SHIPPED rather than as a copy — the three branches are the whole of
 * issue #8, and the middle one is the regression.
 */
export function routePlainLine(
    plain: string,
    send: (text: string, opts?: {deliverAs: 'steer' | 'followUp'}) => void
): void {
    addUserTurn(plain)
    // Read the run flag from SessionState, which is the only thing that owns it.
    // A mirror of it here — a module-level `let` plus a getter/setter, set
    // alongside agentStart/agentEnd — would be two sources of truth for one
    // boolean, and they disagree in both directions: SessionState
    // also clears agentRunning in addError and reset, neither of which touched the
    // mirror — so an errored turn or a /new left this branch steering into a turn
    // SessionState already considered finished. And the mirror was a plain module
    // `let` while every other piece of remote state deliberately lives on
    // globalThis to survive jiti re-evaluation, so it silently reset on session
    // switch. Deleting it removed complexity rather than moving it.
    if (getState().agentRunning) {
        // A live turn: steer it (inject into the current generation) so the
        // nudge lands immediately.
        send(plain, {deliverAs: 'steer'})
    } else if (isRunActive()) {
        // Idle, but a task run owns the session — which is most of a run, since
        // the spec phases and every gate are child processes. Sending here opens
        // a SECOND turn beside the run; that is what killed a live run on pi
        // 0.82.1. Hold it for the next task turn instead.
        holdInput(plain)
    } else {
        send(plain)
    }
}

export function registerRemote(pi: ExtensionAPI): void {
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
                    onPlain: plain => routePlainLine(plain, (t, opts) => S.send?.(t, opts))
                })
            },
            wsUrl => html(wsUrl),
            interruptAgent,
            clearHeldInput
        )
        // Hands-off HTTPS: point Tailscale serve at our port so phones get a
        // secure context. Best-effort — any failure degrades to the http URL.
        S.serveResult = await ensureTailscaleServe(S.server.port).catch((): ServeResult => ({
            state: 'unavailable'
        }))
        return S.server
    }

    pi.on('session_start', (_event, ctx) => {
        S.send = (text, opts) => (opts ? pi.sendUserMessage(text, opts) : pi.sendUserMessage(text))
        // A new session (incl. /new and the /task handoff's newSession) means the
        // browser is showing a stale transcript/widgets — wipe the authoritative
        // state and tell connected clients to clear.
        const bridge = getBridge()
        reset()
        setupEvents(pi)
        // Mirror held mid-run input into the browser composer.
        setHeldInputListener(() => setHeld(heldInput(), isRunActive()))
        // Seed a shimmed ctx so commands that don't need newSession (/task-list,
        // /task-cancel, /task-auto-cancel) work immediately from the remote without
        // any terminal interaction. Only overwrite if null or already shimmed —
        // a real command ctx captured from a prior terminal command must survive
        // session_start (it's updated via withSession or registerBridgeCommand,
        // not replaced here).
        if (
            !bridge.currentCtx
            || (bridge.currentCtx as unknown as Record<string, unknown>)['__piRemoteShimmed']
                === true
        ) {
            bridge.currentCtx = makeShimmedCtx(ctx)
        }
        if (getConfig().remote) {
            // Optional feature: a bind failure must never take pi down. Degrade
            // to a one-line warning and keep the agent running without remote.
            void ensureServer().catch(err =>
                ctx.ui.notify(`Remote UI unavailable: ${(err as Error).message}`, 'warning')
            )
        }
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

    // The browser advertises /compact, and pi's TUI intercepts `/compact` before any
    // extension command dispatch — so it can only reach the session through the
    // bridge, via the ctx.compact() action every ExtensionContext carries.
    registerRemoteOnlyCommand('compact', (args, ctx) => {
        const customInstructions = args.trim() || undefined
        ctx.compact({
            ...(customInstructions ? {customInstructions} : {}),
            onComplete: () => publishNotify('Context compacted', 'info'),
            onError: err => publishNotify(`Compaction failed: ${err.message}`, 'error')
        })
        publishNotify('Compacting context…', 'info')
    })

    // Bridge-registered (not pi.registerCommand) so `/remote stop` also works when
    // typed in the browser — the web UI advertises it, and while a /task-auto run
    // holds the host command loop the browser is the only live input surface.
    registerBridgeCommand(pi, 'remote', {
        description: 'Show the remote QR code & URLs.',
        handler: async (args, ctx) => {
            if (!getConfig().remote) {
                ctx.ui.notify('Remote is disabled — enable it in /task-config.', 'info')
                return
            }
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
                const plan = planRemoteUrls(httpPrimary, result, server.port)
                const primaryUrl = plan.primaryUrl
                const qr = await qrLines(primaryUrl)

                const tsHost = hostFromResult(result)
                const addrs = [
                    ...plan.urlLines,
                    ...formatAddresses(server.ips, server.port, tsHost)
                ]
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
                ctx.ui.notify(`Remote UI unavailable: ${(err as Error).message}`, 'error')
            }
        }
    })
}
