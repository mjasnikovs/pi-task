import {describe, expect, test} from 'bun:test'
import {
    collectCompressible,
    isCompressible,
    isThinkingBlock,
    MIN_THINKING_CHARS,
    rebuildWithCompressed,
    type AssistantMessageLike,
    type ThinkingBlock
} from './rewrite.js'

const big = (s: string, n = 200): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)

function think(text: string, extra: Partial<ThinkingBlock> = {}): ThinkingBlock {
    return {type: 'thinking', thinking: text, thinkingSignature: 'reasoning_content', ...extra}
}
function assistant(...content: unknown[]): AssistantMessageLike {
    return {role: 'assistant', content}
}

describe('isThinkingBlock', () => {
    test('accepts a thinking block, rejects others', () => {
        expect(isThinkingBlock(think('x'))).toBe(true)
        expect(isThinkingBlock({type: 'text', text: 'x'})).toBe(false)
        expect(isThinkingBlock({type: 'thinking'})).toBe(false)
        expect(isThinkingBlock(null)).toBe(false)
    })
})

describe('isCompressible', () => {
    const min = MIN_THINKING_CHARS
    test('compressible: sentinel signature, >= 120 chars, not redacted', () => {
        expect(isCompressible(think(big('a')), min)).toBe(true)
        expect(isCompressible(think(big('a'), {thinkingSignature: ''}), min)).toBe(true)
    })
    test('skips blocks under 120 chars', () => {
        expect(isCompressible(think('x'.repeat(119)), min)).toBe(false)
        expect(isCompressible(think('x'.repeat(120)), min)).toBe(true)
    })
    test('skips redacted blocks', () => {
        expect(isCompressible(think(big('a'), {redacted: true}), min)).toBe(false)
    })
    test('skips real (crypto) signatures — Anthropic extended thinking', () => {
        const sig = big('Ej8K opaque base64 signature', 120)
        expect(isCompressible(think(big('a'), {thinkingSignature: sig}), min)).toBe(false)
    })
})

describe('collectCompressible', () => {
    test('returns eligible thinking blocks with their indices, assistant only', () => {
        const msg = assistant(
            {type: 'text', text: 'hi'},
            think(big('a')),
            think('short'),
            think(big('b'))
        )
        expect(collectCompressible(msg, MIN_THINKING_CHARS)).toEqual([
            {index: 1, text: big('a')},
            {index: 3, text: big('b')}
        ])
    })
    test('ignores non-assistant messages', () => {
        expect(
            collectCompressible({role: 'user', content: [think(big('a'))]}, MIN_THINKING_CHARS)
        ).toEqual([])
        expect(
            collectCompressible({role: 'assistant', content: 'str'}, MIN_THINKING_CHARS)
        ).toEqual([])
    })
})

describe('rebuildWithCompressed', () => {
    test('swaps compressed text at the given indices, keeps type + signature', () => {
        const msg = assistant({type: 'text', text: 'hi'}, think(big('a')))
        const out = rebuildWithCompressed(msg, new Map([[1, 'SHORT']]))
        const block = (out.content as ThinkingBlock[])[1]
        expect(block.thinking).toBe('SHORT')
        expect(block.type).toBe('thinking')
        expect(block.thinkingSignature).toBe('reasoning_content')
        expect((out.content as {text?: string}[])[0].text).toBe('hi')
    })
    test('returns same object when nothing to do', () => {
        const msg = assistant(think(big('a')))
        expect(rebuildWithCompressed(msg, new Map())).toBe(msg)
    })
    test('never expands: ignores a replacement that is not shorter', () => {
        const msg = assistant(think(big('a')))
        const out = rebuildWithCompressed(msg, new Map([[0, big('a') + 'EXTRA']]))
        expect(out).toBe(msg)
    })
})
