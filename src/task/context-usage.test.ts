import {test, expect, describe} from 'bun:test'
import {getParentContextWindow, resolveContextUsage} from './context-usage.js'

describe('getParentContextWindow', () => {
    test('reads model.contextWindow when present', () => {
        const ctx = {model: {contextWindow: 200_000}} as never
        expect(getParentContextWindow(ctx)).toBe(200_000)
    })

    test('falls back to 0 when the model does not expose it', () => {
        expect(getParentContextWindow({} as never)).toBe(0)
        expect(getParentContextWindow({model: {}} as never)).toBe(0)
    })
})

describe('resolveContextUsage', () => {
    test('uses the snapshot window and derives percent against it', () => {
        const out = resolveContextUsage(
            {tokens: 5000, contextWindow: 10_000, percent: 0},
            undefined,
            0
        )
        expect(out).toEqual({tokens: 5000, contextWindow: 10_000, percent: 50})
    })

    test('falls back to the previous window when the snapshot omits one', () => {
        const prev = {tokens: 1000, contextWindow: 8000, percent: 12.5}
        const out = resolveContextUsage({tokens: 4000, contextWindow: 0, percent: 0}, prev, 0)
        expect(out).toEqual({tokens: 4000, contextWindow: 8000, percent: 50})
    })

    test('falls back to the parent window when neither snapshot nor prev has one', () => {
        const out = resolveContextUsage(
            {tokens: 2000, contextWindow: 0, percent: 0},
            undefined,
            20_000
        )
        expect(out).toEqual({tokens: 2000, contextWindow: 20_000, percent: 10})
    })

    test('caps percent at 100 when tokens exceed the window', () => {
        const out = resolveContextUsage(
            {tokens: 30_000, contextWindow: 10_000, percent: 0},
            undefined,
            0
        )
        expect(out.percent).toBe(100)
    })

    test('keeps the reported percent when no window is known anywhere', () => {
        const out = resolveContextUsage({tokens: 1234, contextWindow: 0, percent: 42}, undefined, 0)
        expect(out).toEqual({tokens: 1234, contextWindow: 0, percent: 42})
    })
})
