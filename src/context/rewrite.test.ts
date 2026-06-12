import {describe, expect, test} from 'bun:test'
import {hashText} from './cache.js'
import {
    applyRewrites,
    isRewritable,
    isThinkingBlock,
    selectCandidates,
    type Msg,
    type SelectOptions,
    type ThinkingBlock
} from './rewrite.js'

const OPTS: SelectOptions = {keepLast: 2, minChars: 50}
const big = (s: string, n = 60): string => s.repeat(Math.ceil(n / s.length)).slice(0, n)

function think(text: string, extra: Partial<ThinkingBlock> = {}): ThinkingBlock {
    return {type: 'thinking', thinking: text, thinkingSignature: 'reasoning_content', ...extra}
}
function assistant(...content: unknown[]): Msg {
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

describe('isRewritable', () => {
    const min = 50
    test('rewritable: sentinel signature, big enough, not redacted', () => {
        expect(isRewritable(think(big('a')), min)).toBe(true)
        expect(isRewritable(think(big('a'), {thinkingSignature: ''}), min)).toBe(true)
    })
    test('skips blocks below the size threshold', () => {
        expect(isRewritable(think('tiny'), min)).toBe(false)
    })
    test('skips redacted blocks', () => {
        expect(isRewritable(think(big('a'), {redacted: true}), min)).toBe(false)
    })
    test('skips real (crypto) signatures — Anthropic extended thinking', () => {
        const sig = big('Ej8K... opaque base64 signature', 120)
        expect(isRewritable(think(big('a'), {thinkingSignature: sig}), min)).toBe(false)
    })
})

describe('selectCandidates', () => {
    test('only eligible assistant thinking outside the keep-last window', () => {
        const messages: Msg[] = [
            assistant(think(big('a'))), // 0 — eligible
            {role: 'user', content: [{type: 'text', text: 'hi'}]}, // 1
            assistant(think(big('b'))), // 2 — inside keepLast(2) -> kept
            assistant(think(big('c'))) // 3 — inside keepLast -> kept
        ]
        const got = selectCandidates(messages, OPTS)
        expect(got.map(c => c.text)).toEqual([big('a')])
        expect(got[0].hash).toBe(hashText(big('a')))
    })

    test('returns duplicates for repeated reasoning (callers dedupe by hash)', () => {
        const messages: Msg[] = [
            assistant(think(big('dup'))),
            assistant(think(big('dup'))),
            {role: 'user', content: []},
            {role: 'user', content: []}
        ]
        const got = selectCandidates(messages, OPTS)
        expect(got).toHaveLength(2)
        expect(got[0].hash).toBe(got[1].hash)
    })
})

describe('applyRewrites', () => {
    const cache = new Map<string, string>([[hashText(big('a')), 'SHORT']])
    const lookup = (h: string): string | undefined => cache.get(h)

    test('swaps in a cached, shorter compression and keeps signature + type', () => {
        const messages: Msg[] = [
            assistant(think(big('a'))),
            {role: 'user', content: []},
            {role: 'user', content: []}
        ]
        const {messages: out, rewritten} = applyRewrites(messages, OPTS, lookup)
        expect(rewritten).toBe(1)
        const block = (out[0].content as ThinkingBlock[])[0]
        expect(block.thinking).toBe('SHORT')
        expect(block.type).toBe('thinking')
        expect(block.thinkingSignature).toBe('reasoning_content')
    })

    test('leaves uncached blocks verbatim and preserves message identity', () => {
        const messages: Msg[] = [
            assistant(think(big('uncached'))),
            {role: 'user', content: []},
            {role: 'user', content: []}
        ]
        const {messages: out, rewritten} = applyRewrites(messages, OPTS, lookup)
        expect(rewritten).toBe(0)
        expect(out[0]).toBe(messages[0])
    })

    test('never expands: ignores a cached value that is not shorter', () => {
        const longer = new Map([[hashText(big('a')), big('a') + 'EXTRA']])
        const messages: Msg[] = [
            assistant(think(big('a'))),
            {role: 'user', content: []},
            {role: 'user', content: []}
        ]
        const {rewritten} = applyRewrites(messages, OPTS, h => longer.get(h))
        expect(rewritten).toBe(0)
    })

    test('does not touch the keep-last window', () => {
        const messages: Msg[] = [{role: 'user', content: []}, assistant(think(big('a')))]
        const {rewritten} = applyRewrites(messages, OPTS, lookup)
        expect(rewritten).toBe(0)
    })
})
