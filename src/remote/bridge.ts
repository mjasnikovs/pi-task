import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext
} from '@earendil-works/pi-coding-agent'
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

// ─── Shimmed ctx ─────────────────────────────────────────────────────────────

const SHIMMED_MARKER = '__piRemoteShimmed'

/**
 * Wraps an event-scoped ExtensionContext so it can be used as a command ctx
 * for commands that don't need newSession (e.g. /task-resume, /task-list,
 * /task-cancel, /task-auto-cancel).
 *
 * - waitForIdle: polls ctx.isIdle() instead of the real runtime hook.
 * - newSession: throws a clear error so /task, /task-auto, /task-auto-resume
 *   show a helpful message rather than a confusing TypeError.
 *
 * The shim is replaced by a real ExtensionCommandContext the first time the
 * user runs any /task* or /remote command in the terminal.
 */
export function makeShimmedCtx(ctx: ExtensionContext): ExtensionCommandContext {
    const shim = Object.create(ctx) as ExtensionCommandContext
    ;(shim as unknown as Record<string, unknown>)[SHIMMED_MARKER] = true
    shim.waitForIdle = async () => {
        while (!ctx.isIdle()) {
            await new Promise<void>(r => setTimeout(r, 100))
        }
    }
    // newSession is not available from an event ctx. Return a function that
    // throws a clear message so the error toast is actionable.
    ;(shim as unknown as {newSession: () => never}).newSession = (): never => {
        throw new Error(
            'Run /remote in the terminal once to enable /task, /task-auto, and /new from remote.'
        )
    }
    return shim
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
 *  command-capable ctx (currentCtx) at call time. If only a shimmed ctx is
 *  available, the newSession shim throws a clear error. */
type NewSessionOptions = NonNullable<Parameters<ExtensionCommandContext['newSession']>[0]>
type ReplacedSessionContext = Parameters<NonNullable<NewSessionOptions['withSession']>>[0]

export function dispatchRemoteNewSession(rebind: (ctx: ReplacedSessionContext) => void): void {
    const b = getBridge()
    const ctx = b.currentCtx
    if (!ctx) {
        publishNotify('No session context available — restart pi and try again.', 'warning')
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
        // Shouldn't happen after session_start seeds a shimmed ctx, but guard anyway.
        publishNotify(`/${name}: no session context yet — restart pi.`, 'warning')
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
