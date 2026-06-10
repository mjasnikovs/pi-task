import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
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
        const local: Promise<string | undefined> = this.ctx.hasUI ?
            this.ctx.ui.input(spec.localTitle, spec.recommended, {signal: ac.signal}).catch(
                () => undefined
            )
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
