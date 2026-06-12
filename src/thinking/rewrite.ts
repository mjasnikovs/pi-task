/** Minimal structural view of a thinking content block. Kept structural (rather
 *  than importing pi-ai's `ThinkingContent`) so these helpers stay pure and are
 *  trivially unit-testable with plain objects. */
export interface ThinkingBlock {
    type: 'thinking'
    thinking: string
    thinkingSignature?: string
    redacted?: boolean
}

export interface AssistantMessageLike {
    role?: string
    content?: unknown
}

export interface CompressTarget {
    index: number
    text: string
}

/** Thinking blocks shorter than this aren't worth a model round-trip. */
export const MIN_THINKING_CHARS = 120

/** In `openai-completions` (llama.cpp/local) the "signature" is a field *name*
 *  (`reasoning_content`) the reasoning is replayed under — not a crypto
 *  signature — so rewriting the text is safe. A long, non-sentinel signature is
 *  Anthropic-style extended thinking, where the signature cryptographically
 *  signs the original text and the block feeds the next turn's continuation;
 *  rewriting it would break that, so those blocks are skipped. */
const SENTINEL_SIGNATURES = new Set(['', 'reasoning_content', 'reasoning', 'reasoning_text'])

export function isThinkingBlock(b: unknown): b is ThinkingBlock {
    return (
        typeof b === 'object'
        && b !== null
        && (b as {type?: unknown}).type === 'thinking'
        && typeof (b as {thinking?: unknown}).thinking === 'string'
    )
}

export function isCompressible(b: ThinkingBlock, minChars: number): boolean {
    if (b.redacted) return false
    if (!SENTINEL_SIGNATURES.has(b.thinkingSignature ?? '')) return false
    return b.thinking.trim().length >= minChars
}

/** Compressible thinking blocks of an assistant message, with their positions. */
export function collectCompressible(
    message: AssistantMessageLike,
    minChars: number
): CompressTarget[] {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
    const out: CompressTarget[] = []
    message.content.forEach((b, index) => {
        if (isThinkingBlock(b) && isCompressible(b, minChars)) out.push({index, text: b.thinking})
    })
    return out
}

/** Rebuild an assistant message with compressed text swapped into the given
 *  block indices. The block `type` and `thinkingSignature` are preserved so the
 *  local provider still replays the (now shorter) reasoning, and a replacement is
 *  only applied when it actually shrinks the block. Returns the same object when
 *  nothing changed. */
export function rebuildWithCompressed<T extends AssistantMessageLike>(
    message: T,
    byIndex: ReadonlyMap<number, string>
): T {
    if (byIndex.size === 0 || !Array.isArray(message.content)) return message
    let changed = false
    const content = message.content.map((b, index) => {
        const compressed = byIndex.get(index)
        if (compressed === undefined || !isThinkingBlock(b)) return b
        if (compressed.length >= b.thinking.length) return b
        changed = true
        return {...b, thinking: compressed}
    })
    return changed ? {...message, content} : message
}
