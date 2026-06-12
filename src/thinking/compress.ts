import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent'
import {getConfig} from '../config/config.js'
import {
    collectCompressible,
    MIN_THINKING_CHARS,
    rebuildWithCompressed,
    type AssistantMessageLike
} from './rewrite.js'

/** Hard cap so a stuck model request can never wedge a turn. */
const REQUEST_TIMEOUT_MS = 120_000
const STATUS_KEY = 'pi-task-thinking'
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const PROMPT =
    'Compress this reasoning. Keep every decision/conclusion/constraint/fact relied on later. '
    + 'Drop restated questions, false starts, self-talk. Output only the compressed reasoning. /no_think'

interface ModelRef {
    id: string
    baseUrl: string
}
interface Auth {
    apiKey?: string
    headers?: Record<string, string>
}

async function compressOne(text: string, model: ModelRef, auth: Auth): Promise<string> {
    const headers: Record<string, string> = {'Content-Type': 'application/json', ...auth.headers}
    if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`
    const res = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: model.id,
            messages: [{role: 'user', content: `${PROMPT}\n\n---\n\n${text}`}],
            temperature: 0,
            stream: false
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!res.ok) throw new Error(`compress HTTP ${res.status}`)
    const data = (await res.json()) as {choices?: {message?: {content?: string}}[]}
    const raw = data.choices?.[0]?.message?.content ?? ''
    return raw.replaceAll('<think>', '').replaceAll('</think>', '').trim()
}

/** Animated footer loader. Safe in any mode — `setStatus` is a no-op outside the
 *  TUI. Each tick reports which block is compressing and its size. */
class Loader {
    private timer: ReturnType<typeof setInterval> | null = null
    private frame = 0
    constructor(private readonly ui: ExtensionContext['ui']) {}

    start(label: () => string): void {
        this.stop()
        const tick = () => {
            this.ui.setStatus(STATUS_KEY, `${SPINNER[this.frame % SPINNER.length]} ${label()}`)
            this.frame++
        }
        tick()
        this.timer = setInterval(tick, 120)
    }

    /** Show a final, non-animated line, then clear it after a short beat. */
    finish(text: string | undefined): void {
        this.stop()
        this.ui.setStatus(STATUS_KEY, text)
        if (text !== undefined) {
            setTimeout(() => this.ui.setStatus(STATUS_KEY, undefined), 4000)
        }
    }

    private stop(): void {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }
}

async function resolveAuth(
    ctx: ExtensionContext,
    model: NonNullable<ExtensionContext['model']>
): Promise<Auth> {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- ctx.model is Model<any>; the registry wants Model<Api>
        const r = await ctx.modelRegistry.getApiKeyAndHeaders(model)
        return r.ok ? {apiKey: r.apiKey, headers: r.headers} : {}
    } catch {
        return {}
    }
}

const pct = (from: number, to: number): number => Math.round((100 * (from - to)) / from)

export function registerThinkingCompression(pi: ExtensionAPI): void {
    pi.on('message_end', async (event, ctx) => {
        if (!getConfig().compressReasoning) return
        const message = event.message as AssistantMessageLike
        const targets = collectCompressible(message, MIN_THINKING_CHARS)
        if (targets.length === 0) return
        const model = ctx.model
        if (!model) return

        const loader = new Loader(ctx.ui)
        const auth = await resolveAuth(ctx, model)
        const modelRef: ModelRef = {id: model.id, baseUrl: model.baseUrl}
        const replacements = new Map<number, string>()
        let origTotal = 0
        let newTotal = 0

        for (let i = 0; i < targets.length; i++) {
            const t = targets[i]
            const n = i + 1
            loader.start(() =>
                targets.length > 1 ?
                    `compressing reasoning ${n}/${targets.length} (${t.text.length}c)…`
                :   `compressing reasoning (${t.text.length}c)…`
            )
            try {
                const compressed = await compressOne(t.text, modelRef, auth)
                if (compressed.length > 0 && compressed.length < t.text.length) {
                    replacements.set(t.index, compressed)
                    origTotal += t.text.length
                    newTotal += compressed.length
                }
            } catch {
                // Leave this block verbatim; move on to the next.
            }
        }

        if (replacements.size === 0) {
            loader.finish(undefined)
            return
        }
        loader.finish(`✓ reasoning ${origTotal}→${newTotal}c (−${pct(origTotal, newTotal)}%)`)
        // Cast back to the concrete AgentMessage type: the helpers work on a
        // structural view, but the rewrite only swaps thinking-block text.
        return {message: rebuildWithCompressed(message, replacements) as typeof event.message}
    })
}
