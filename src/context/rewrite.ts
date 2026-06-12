import {hashText} from './cache.js'

/** Minimal structural view of a thinking content block. We avoid importing the
 *  exact pi-ai `ThinkingContent` type so these helpers stay pure and trivially
 *  unit-testable with plain objects. */
export interface ThinkingBlock {
    type: 'thinking'
    thinking: string
    thinkingSignature?: string
    redacted?: boolean
}

/** Minimal structural view of an AgentMessage. `AgentMessage[]` is assignable
 *  to `Msg[]`, so the `context` handler passes pi's real messages straight in. */
export interface Msg {
    role?: string
    content?: unknown
}

export interface Candidate {
    hash: string
    text: string
}

export interface SelectOptions {
    /** Number of most-recent messages to leave completely untouched. */
    keepLast: number
    /** Minimum trimmed thinking length worth compressing. */
    minChars: number
}

/** In `openai-completions` (llama.cpp/local), the "signature" is a field *name*
 *  (`reasoning_content`) the prior reasoning is replayed under — not a crypto
 *  signature — so rewriting the text is safe. A long, non-sentinel signature
 *  means Anthropic-style extended thinking, where the signature cryptographically
 *  signs the original text; rewriting it would be rejected, so we skip those. */
const SENTINEL_SIGNATURES = new Set(['', 'reasoning_content', 'reasoning', 'reasoning_text'])

export function isThinkingBlock(b: unknown): b is ThinkingBlock {
    return (
        typeof b === 'object'
        && b !== null
        && (b as {type?: unknown}).type === 'thinking'
        && typeof (b as {thinking?: unknown}).thinking === 'string'
    )
}

export function isRewritable(b: ThinkingBlock, minChars: number): boolean {
    if (b.redacted) return false
    if (!SENTINEL_SIGNATURES.has(b.thinkingSignature ?? '')) return false
    return b.thinking.trim().length >= minChars
}

/** Eligible thinking blocks older than the keep-last window. May contain
 *  duplicates (the same reasoning across turns) — callers dedupe by hash. */
export function selectCandidates(messages: readonly Msg[], opts: SelectOptions): Candidate[] {
    const cutoff = messages.length - opts.keepLast
    const out: Candidate[] = []
    for (let i = 0; i < cutoff; i++) {
        const m = messages[i]
        if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
        for (const b of m.content) {
            if (isThinkingBlock(b) && isRewritable(b, opts.minChars)) {
                out.push({hash: hashText(b.thinking), text: b.thinking})
            }
        }
    }
    return out
}

/** Return a copy of `messages` with cached compressions swapped into eligible
 *  thinking blocks. Unchanged messages keep their identity. `thinkingSignature`
 *  and block `type` are preserved so the local provider still replays the (now
 *  shorter) reasoning. A compression is only applied when it actually shrinks
 *  the block, so this can never expand context. */
export function applyRewrites<T extends Msg>(
    messages: readonly T[],
    opts: SelectOptions,
    lookup: (hash: string) => string | undefined
): {messages: T[]; rewritten: number} {
    const cutoff = messages.length - opts.keepLast
    let rewritten = 0
    const out = messages.map((m, i) => {
        if (i >= cutoff || m.role !== 'assistant' || !Array.isArray(m.content)) return m
        let changed = false
        const content = m.content.map(b => {
            if (!isThinkingBlock(b) || !isRewritable(b, opts.minChars)) return b
            const compressed = lookup(hashText(b.thinking))
            if (compressed === undefined || compressed.length >= b.thinking.length) return b
            changed = true
            rewritten++
            return {...b, thinking: compressed}
        })
        return changed ? ({...m, content} as T) : m
    })
    return {messages: out, rewritten}
}
