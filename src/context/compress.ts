import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import * as os from 'node:os'
import * as path from 'node:path'
import {CompressionCache} from './cache.js'
import {applyRewrites, selectCandidates, type SelectOptions} from './rewrite.js'

/** Keep the most-recent messages verbatim — recent reasoning is most likely to
 *  be relied on next turn, and compressing it would chase a moving target. */
const KEEP_LAST = 8
/** Only compress sizeable blocks. Validation against the real session corpus
 *  (median thinking block 127 chars) showed small blocks barely shrink yet still
 *  cost ~5-15s on the local model — net-negative. Big blocks compress ~5x. */
const MIN_CHARS = 1500
/** Hard cap so a stuck request can never wedge the background queue. */
const REQUEST_TIMEOUT_MS = 120_000
/** Poll interval while the agent is busy — see the GPU note in `drain`. */
const IDLE_BACKOFF_MS = 750

const PROMPT =
    'Compress this reasoning. Keep every decision/conclusion/constraint/fact relied on later. '
    + 'Drop restated questions, false starts, self-talk. Output only the compressed reasoning. /no_think'

const OPTS: SelectOptions = {keepLast: KEEP_LAST, minChars: MIN_CHARS}

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

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

/** Owns the compression cache and a serial background queue. Persisted on
 *  globalThis so it survives the jiti module re-evaluation that happens on every
 *  `/new` (mirrors the pattern in remote/register.ts). */
class ThinkingCompressor {
    readonly cache: CompressionCache
    private readonly pending: {hash: string; text: string}[] = []
    private readonly inflight = new Set<string>()
    private draining = false
    private model: ModelRef | null = null
    private isIdle: () => boolean = () => true
    private resolveAuth: () => Promise<Auth> = () => Promise.resolve({})
    private auth: Auth | null = null
    private authModelId: string | null = null

    constructor(cacheFile: string) {
        this.cache = new CompressionCache(cacheFile)
    }

    /** Refresh per-call context (model, idleness, auth resolver) from the latest
     *  `context` event. Cheap and synchronous — no blocking work on this path. */
    bind(model: ModelRef, isIdle: () => boolean, resolveAuth: () => Promise<Auth>): void {
        this.model = model
        this.isIdle = isIdle
        this.resolveAuth = resolveAuth
        if (this.authModelId !== model.id) {
            // Model changed — invalidate cached auth so it is re-resolved lazily.
            this.auth = null
            this.authModelId = model.id
        }
    }

    enqueue(hash: string, text: string): void {
        if (this.cache.has(hash) || this.inflight.has(hash)) return
        if (this.pending.some(p => p.hash === hash)) return
        this.pending.push({hash, text})
        void this.drain()
    }

    private async getAuth(): Promise<Auth> {
        if (this.auth) return this.auth
        try {
            this.auth = await this.resolveAuth()
        } catch {
            this.auth = {}
        }
        return this.auth
    }

    private async drain(): Promise<void> {
        if (this.draining) return
        this.draining = true
        try {
            while (this.pending.length > 0) {
                const model = this.model
                if (!model) break
                // The local model is a single-GPU llama.cpp server: a compression
                // request fired mid-turn would queue behind (and stall) the user's
                // turn. So compression only runs while the agent is idle.
                if (!this.isIdle()) {
                    await delay(IDLE_BACKOFF_MS)
                    continue
                }
                const job = this.pending.shift()!
                if (this.cache.has(job.hash)) continue
                this.inflight.add(job.hash)
                try {
                    const compressed = await compressOne(job.text, model, await this.getAuth())
                    // Only cache a genuine shrink; otherwise leave the block verbatim
                    // (a later turn will re-enqueue and retry).
                    if (compressed.length > 0 && compressed.length < job.text.length) {
                        this.cache.set(job.hash, compressed)
                    }
                } catch {
                    // Transient (model busy/down) — drop the job; re-enqueued next turn.
                } finally {
                    this.inflight.delete(job.hash)
                }
            }
        } finally {
            this.draining = false
        }
    }
}

interface CompressorGlobal {
    __piThinkingCompressor?: ThinkingCompressor
}

export function registerContextCompression(pi: ExtensionAPI): void {
    const cacheFile = path.join(
        os.homedir(),
        '.pi',
        'agent',
        'cache',
        'pi-task',
        'thinking-compression.json'
    )
    const g = globalThis as unknown as CompressorGlobal
    const compressor = g.__piThinkingCompressor ?? new ThinkingCompressor(cacheFile)
    g.__piThinkingCompressor = compressor

    pi.on('context', (event, ctx) => {
        const model = ctx.model
        if (!model) return
        compressor.bind(
            {id: model.id, baseUrl: model.baseUrl},
            () => ctx.isIdle(),
            async () => {
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- ctx.model is Model<any>; the registry wants Model<Api>
                const r = await ctx.modelRegistry.getApiKeyAndHeaders(model)
                return r.ok ? {apiKey: r.apiKey, headers: r.headers} : {}
            }
        )

        // Background: ensure every eligible block is queued for one-time compression.
        for (const c of selectCandidates(event.messages, OPTS)) {
            compressor.enqueue(c.hash, c.text)
        }

        // Critical path: apply only what is already cached. Pure + synchronous.
        const {messages, rewritten} = applyRewrites(event.messages, OPTS, h =>
            compressor.cache.get(h)
        )
        if (rewritten === 0) return
        return {messages}
    })
}
