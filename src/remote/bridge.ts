import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext
} from '@earendil-works/pi-coding-agent'
import {broadcast as wsBroadcast} from './broadcast.js'
import {pushNotify} from './push.js'
import {setPrompt, clearPrompt, addError} from './session-state.js'
import type {PromptMessage, ServerMessage} from './protocol.js'
import {askQuestionBox} from '../task/question-box.js'

export interface BridgeState {
    /** promptId → resolver that settles the remote side of an ask() race. */
    pending: Map<string, (value: string | undefined) => void>
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
    /** Themed (markdown-rendered) question shown as the boxed picker header.
     *  Falls back to `question` when absent. */
    displayQuestion?: string
    /** Plain question text for the browser card. */
    question: string
    /**
     * Primary recommended option. It is the remote card's "✓ Accept" answer.
     * Locally it is handed to `ctx.ui.input` as the placeholder argument, which
     * pi's interactive input component takes and never reads — so with no
     * `options` the local box opens empty.
     */
    recommended?: string
    /**
     * Instructional copy for the local TUI text input when there is NO
     * recommended option. Local-only, and deliberately absent from the
     * PromptMessage below: on the remote it would render as an acceptable
     * recommendation ("✓ Accept" answering with instructional text). Its one
     * producer is the steer prompt. Like `recommended` it reaches pi as the
     * `input` placeholder, which pi's input component ignores.
     */
    localPlaceholder?: string
    /** Secondary recommended option shown as a second button on the remote. */
    recommended2?: string
    /** Whether the browser card shows a Skip button (answers with empty string). */
    allowSkip: boolean
    /**
     * When set, the local TUI shows a select() picker of these entries instead of
     * a bare text input — one option per line, arrow-key navigable. Each entry's
     * `label` is what the picker displays; its `value` is what ask() resolves to
     * when chosen. A built-in "type a different answer" entry is appended that
     * falls back to a text input, preserving the free-text override. Produced by
     * the two-option grill/clarify fork, whose cards are labelled `A:` and `B:`
     * (buildOptionCards), and by /task-plan's picker. The PromptMessage built in
     * ask() carries no `options` field, so remote browsers never see it and keep
     * rendering recommended/recommended2 as buttons.
     */
    options?: {label: string; value: string}[]
    /**
     * Label for the local picker's trailing free-text card (see
     * {@link AskQuestionBoxSpec.manualLabel}). Ignored without `options`.
     */
    manualLabel?: string
    /**
     * Where the free-text card sits among `options` (see
     * {@link AskQuestionBoxSpec.manualPosition}). Local picker only — remote
     * browsers always render the text box above the action buttons.
     */
    manualPosition?: number
    /**
     * Extra buttons the BROWSER card shows alongside the recommendation, each
     * answering with its own `value`. Unlike `options` — which are answers, and
     * which the remote already covers with the recommended/recommended2 buttons —
     * these are ACTIONS that mean something other than "here is my answer", so
     * the remote cannot express them by any existing field. /task-plan's "ask the
     * model" and "proceed to execution" are the only producers; for every other
     * prompt the list is empty, and the browser's makeActionBtns then appends
     * nothing to the card.
     */
    actions?: {label: string; value: string}[]
}

/** A read-only display fanned out to both surfaces by {@link SessionUI.show}. */
export interface ShowSpec {
    /** Title for the local terminal editor. */
    localTitle: string
    /** Full text the local editor opens with. */
    localText: string
    /** Card header on the browser. Plain text. */
    question: string
    /** Card body on the browser, markdown-rendered in the panel. */
    body: string
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
        return this.race(
            id => ({
                type: 'prompt',
                id,
                question: spec.question,
                recommended: spec.recommended,
                ...(spec.recommended2 !== undefined && {recommended2: spec.recommended2}),
                ...(spec.actions !== undefined
                    && spec.actions.length > 0 && {actions: spec.actions}),
                allowSkip: spec.allowSkip
            }),
            spec.question,
            signal => this.askLocal(spec, signal)
        )
    }

    /**
     * Show text that only needs dismissing. Locally that is the terminal editor;
     * remotely it is a dismiss-only prompt card, and it has to be a prompt rather
     * than a `viewer` because only the prompt slot is in the reconnect snapshot
     * and only a prompt can settle the caller from the browser.
     *
     * pi's `ui.editor` takes no AbortSignal, so a remote dismissal cannot close
     * the terminal editor the way a remote answer aborts a local ask. It is left
     * open and whatever it eventually returns is discarded — the run has moved on.
     */
    async show(spec: ShowSpec): Promise<void> {
        await this.race(
            id => ({
                type: 'prompt',
                id,
                question: spec.question,
                recommended: spec.body,
                dismissOnly: true,
                allowSkip: false
            }),
            spec.question,
            () => this.ctx.ui.editor(spec.localTitle, spec.localText)
        )
    }

    /**
     * The shared half of ask() and show(): publish one prompt card, open the
     * local dialog beside it, and take whichever settles first.
     */
    private async race(
        build: (id: string) => PromptMessage,
        pushBody: string,
        local: (signal: AbortSignal) => Promise<string | undefined>
    ): Promise<string | undefined> {
        const b = this.bridge
        const id = String(b.nextId++)
        const ac = new AbortController()

        const remote = new Promise<string | undefined>(resolve => {
            b.pending.set(id, resolve)
        })

        setPrompt(build(id))
        // Reaches a backgrounded/suspended phone, which the in-page UI can't. The
        // service worker drops the banner if a window is visible+focused (sw.ts),
        // so we always push and let delivery-time visibility decide.
        void pushNotify('pi needs your input', pushBody, 'pi-prompt').catch(() => {})

        // Local: resolves to a value, or to undefined on cancel or abort. The
        // catch is belt-and-braces — a rejection here would surface as an
        // unhandled one rather than as a lost race.
        const localSide: Promise<string | undefined> =
            this.ctx.hasUI ?
                local(ac.signal).catch(() => undefined)
            :   new Promise<string | undefined>(() => {})

        try {
            const winner = await Promise.race([
                localSide.then(v => ({from: 'local' as const, v})),
                remote.then(v => ({from: 'remote' as const, v}))
            ])
            if (winner.from === 'remote') ac.abort()
            return winner.v
        } finally {
            b.pending.delete(id)
            clearPrompt(id)
        }
    }

    /**
     * The local-TUI half of ask(). With `spec.options` it renders the boxed
     * picker (each answer in its own bounding box, the first/recommended one
     * tinted green) plus a trailing "type a different answer" entry that drops to
     * a text input; the chosen entry's `value` is returned. Without options it
     * falls back to a single text input. Cancelling either dialog (or an abort
     * when the remote wins the race) resolves to undefined.
     */
    private async askLocal(spec: AskSpec, signal: AbortSignal): Promise<string | undefined> {
        const opts = spec.options
        if (opts && opts.length > 0) {
            return askQuestionBox(this.ctx, {
                question: spec.displayQuestion ?? spec.question,
                inputTitle: spec.localTitle,
                options: opts.map((o, i) => ({
                    label: o.label,
                    value: o.value,
                    recommended: i === 0
                })),
                ...(spec.manualLabel !== undefined && {manualLabel: spec.manualLabel}),
                ...(spec.manualPosition !== undefined && {manualPosition: spec.manualPosition}),
                signal
            })
        }
        return this.ctx.ui.input(spec.localTitle, spec.recommended ?? spec.localPlaceholder, {
            signal
        })
    }
}

export function publishNotify(message: string, level: 'info' | 'warning' | 'error'): void {
    getBridge().broadcast({type: 'notify', message, level})
}

/**
 * Abort the running agent turn — the browser Stop button. `abort()` lives on the
 * base ExtensionContext ("Abort the current agent operation") so it works for a
 * host chat turn, a /task phase turn, or a /task-auto run alike. The shimmed ctx
 * inherits it from the real event ctx via its prototype, so this is safe even
 * before the user has run a command in the terminal. No-op when nothing is running.
 */
export function interruptAgent(): void {
    getBridge().currentCtx?.abort()
}

/**
 * Mirror a task lifecycle notice (the kind pi-task shows on the terminal via
 * ctx.ui.notify) to connected remote viewers. Task failures and other
 * ctx.ui.notify calls bypass the host agent's event stream — the only thing
 * events.ts mirrors — so without this the remote view shows nothing when a task
 * fails completely even though the terminal flashes red.
 *
 * An 'error' becomes a PERSISTENT red bubble in the transcript (addError) so it
 * survives a reconnect, matching the terminal's red text; 'warning'/'info' are a
 * transient toast since they don't need to linger.
 */
export function publishLifecycleNotice(message: string, level: 'info' | 'warning' | 'error'): void {
    if (level === 'error') addError(message)
    else publishNotify(message, level)
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

/** Record a command that exists ONLY on the remote bridge — no pi.registerCommand.
 *  For browser-side equivalents of things the terminal already handles natively
 *  (e.g. /compact, which pi's TUI intercepts before extension dispatch, so a real
 *  pi command of that name could never fire and would only duplicate the entry in
 *  the terminal's autocomplete). */
export function registerRemoteOnlyCommand(
    name: string,
    handler: (args: string, ctx: ExtensionCommandContext) => unknown
): void {
    getBridge().commands.set(name, handler)
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
