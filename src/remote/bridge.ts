import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {broadcast as wsBroadcast} from './broadcast.js'
import type {PromptMessage, ServerMessage} from './protocol.js'

export interface BridgeState {
    /** promptId → resolver that settles the remote side of an ask() race. */
    pending: Map<string, (value: string | undefined) => void>
    /** The prompt currently awaiting an answer (replayed to late joiners), or null. */
    activePrompt: PromptMessage | null
    /** Last lines pushed per widget key (replayed to late joiners). */
    activeWidgets: Map<string, string[]>
    nextId: number
    /** Command name → handler, populated as pi-task registers its commands. */
    commands: Map<string, (args: string, ctx: ExtensionCommandContext) => unknown>
    /** Most recent live command context, for remote-initiated dispatch. */
    currentCtx: ExtensionCommandContext | null
    /** Broadcast sink — swapped in tests. */
    broadcast: (msg: ServerMessage) => void
    /** @internal Test-only capture of broadcast messages; empty in production. */
    sent: ServerMessage[]
}

const g = globalThis as unknown as {__piBridge?: BridgeState}

export function getBridge(): BridgeState {
    if (!g.__piBridge) {
        g.__piBridge = {
            pending: new Map(),
            activePrompt: null,
            activeWidgets: new Map(),
            nextId: 0,
            commands: new Map(),
            currentCtx: null,
            broadcast: (msg: ServerMessage) => wsBroadcast(msg),
            sent: []
        }
    }
    return g.__piBridge
}

/** Resolve the remote side of a pending prompt. First call wins; later calls
 *  (duplicate frames, a second browser, local-after-remote) are ignored. */
export function answerPrompt(id: string, value: string | undefined): void {
    const b = getBridge()
    const settle = b.pending.get(id)
    if (!settle) return
    b.pending.delete(id)
    settle(value)
}

export interface AskSpec {
    /** Themed, possibly multi-line title for the local TUI input. */
    localTitle: string
    /** Plain question text for the browser card. */
    question: string
    /** Plain recommended default (prefilled in both surfaces), if any. */
    recommended?: string
    /** Whether the browser card shows a Skip button (answers with empty string). */
    allowSkip: boolean
}

/** Wraps a live command ctx and fans interactions out to local TUI + browsers. */
export class SessionUI {
    constructor(
        private readonly ctx: ExtensionCommandContext,
        private readonly bridge: BridgeState = getBridge()
    ) {}

    get theme(): ExtensionCommandContext['ui']['theme'] {
        return this.ctx.ui.theme
    }

    get hasUI(): boolean {
        return this.ctx.hasUI
    }

    /** Race the local input against a remote answer; first to settle wins. */
    async ask(spec: AskSpec): Promise<string | undefined> {
        const b = this.bridge
        const id = String(b.nextId++)
        const ac = new AbortController()

        const remote = new Promise<string | undefined>(resolve => {
            b.pending.set(id, resolve)
        })

        const prompt: PromptMessage = {
            type: 'prompt',
            id,
            question: spec.question,
            recommended: spec.recommended,
            allowSkip: spec.allowSkip
        }
        b.activePrompt = prompt
        b.broadcast(prompt)

        // Local: resolves to a value/undefined, or undefined on abort. Swallow
        // the rejection some implementations throw on abort so it never leaks.
        const local: Promise<string | undefined> =
            this.ctx.hasUI ?
                this.ctx.ui
                    .input(spec.localTitle, spec.recommended, {signal: ac.signal})
                    .catch(() => undefined)
            :   new Promise<string | undefined>(() => {})

        try {
            const winner = await Promise.race([
                local.then(v => ({from: 'local' as const, v})),
                remote.then(v => ({from: 'remote' as const, v}))
            ])
            if (winner.from === 'remote') ac.abort()
            return winner.v
        } finally {
            b.pending.delete(id)
            b.activePrompt = null
            b.broadcast({type: 'prompt_resolved', id})
        }
    }
}

/** Mirror a status widget to browsers and remember it for late joiners.
 *  `lines === undefined` clears the widget (broadcast as `lines: null`). */
export function publishWidget(key: string, lines: string[] | undefined): void {
    const b = getBridge()
    if (lines === undefined) {
        b.activeWidgets.delete(key)
        b.broadcast({type: 'widget', key, lines: null})
        return
    }
    b.activeWidgets.set(key, lines)
    b.broadcast({type: 'widget', key, lines})
}

export function publishNotify(message: string, level: 'info' | 'warning' | 'error'): void {
    getBridge().broadcast({type: 'notify', message, level})
}

export function publishViewer(title: string, text: string): void {
    getBridge().broadcast({type: 'viewer', title, text})
}

interface BridgeCommandDef {
    description: string
    handler: (args: string, ctx: ExtensionCommandContext) => unknown
    // pass-through for any other registerCommand options
    [k: string]: unknown
}

/** Register a command with pi AND record it in the bridge so remote slash lines
 *  can invoke it. Use in place of pi.registerCommand for task commands. */
export function registerBridgeCommand(pi: ExtensionAPI, name: string, def: BridgeCommandDef): void {
    const b = getBridge()
    const wrapped: BridgeCommandDef = {
        ...def,
        handler: (args: string, ctx: ExtensionCommandContext) => {
            b.currentCtx = ctx // keep latest live ctx for remote dispatch
            return def.handler(args, ctx)
        }
    }
    b.commands.set(name, wrapped.handler)
    pi.registerCommand(name, wrapped as never)
}

/** Start a new session in response to a remote `/new`. Reads the freshest
 *  command-capable ctx (currentCtx) at call time and mirrors dispatchRemoteLine's
 *  guards: a missing, non-command, or stale ctx toasts instead of crashing.
 *
 *  The crash this prevents: a captured ctx goes stale after a *local* /new (a
 *  replacement we don't initiate, so we never get a withSession to rebind), and
 *  ctx.newSession() then throws *synchronously* from assertActive — a sync throw
 *  that a bare `.catch()` on the result would miss. `rebind` runs as withSession
 *  with the fresh post-replacement ctx. */
/** The richer context the runtime passes to a `newSession` withSession callback
 *  (it carries sendUserMessage, unlike a plain command ctx). Derived from the
 *  newSession signature since the package root doesn't re-export the type. */
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext['newSession']>[0]>
type ReplacedSessionContext = Parameters<NonNullable<NewSessionOptions['withSession']>>[0]

export function dispatchRemoteNewSession(rebind: (ctx: ReplacedSessionContext) => void): void {
    const b = getBridge()
    const ctx = b.currentCtx
    if (!ctx) {
        publishNotify('Start a session before running /new remotely.', 'warning')
        return
    }
    // A bare event-scoped ctx lacks newSession; a stale command ctx still has it
    // but throws on call — the try/catch below covers that case.
    if (typeof (ctx as {waitForIdle?: unknown}).waitForIdle !== 'function') {
        publishNotify(
            'Session changed locally — run any task command in the terminal once to re-enable remote /new.',
            'warning'
        )
        return
    }
    const toastErr = (err: unknown) =>
        publishNotify(`/new failed: ${(err as Error).message}`, 'error')
    try {
        const result = ctx.newSession({
            // eslint-disable-next-line @typescript-eslint/require-await
            withSession: async newCtx => {
                b.currentCtx = newCtx
                rebind(newCtx)
            }
        })
        if (result instanceof Promise) result.catch(toastErr)
    } catch (err) {
        toastErr(err)
    }
}

/** Handle one line typed in a browser. Returns true if it was consumed as a
 *  slash command (registered or unknown); false if it's a plain chat line that
 *  the caller should forward via onPlain. */
export function dispatchRemoteLine(text: string, opts: {onPlain: (text: string) => void}): boolean {
    const b = getBridge()
    if (!text.startsWith('/')) {
        opts.onPlain(text)
        return false
    }
    const space = text.indexOf(' ')
    const name = (space === -1 ? text.slice(1) : text.slice(1, space)).trim()
    const args = space === -1 ? '' : text.slice(space + 1).trim()
    const handler = b.commands.get(name)
    if (!handler) {
        publishNotify(`Unknown command: /${name}`, 'warning')
        return true
    }
    if (!b.currentCtx) {
        publishNotify('Start a session before running commands remotely.', 'warning')
        return true
    }
    // Command handlers need a command-capable ctx (waitForIdle/newSession). A bare
    // event-scoped ExtensionContext lacks those; if currentCtx is one (e.g. nothing
    // command-capable has been captured yet), toast instead of throwing a TypeError.
    if (typeof (b.currentCtx as {waitForIdle?: unknown}).waitForIdle !== 'function') {
        publishNotify(
            'Session changed locally — run any task command in the terminal once to re-enable remote commands.',
            'warning'
        )
        return true
    }
    // Invoke synchronously so the call happens immediately, but surface both
    // sync throws and async rejections from the (often async) command handler
    // as a toast instead of crashing or becoming an unhandled rejection.
    const toastErr = (err: unknown) =>
        publishNotify(`/${name} failed: ${(err as Error).message}`, 'error')
    try {
        const result = handler(args, b.currentCtx)
        if (result instanceof Promise) result.catch(toastErr)
    } catch (err) {
        toastErr(err)
    }
    return true
}
