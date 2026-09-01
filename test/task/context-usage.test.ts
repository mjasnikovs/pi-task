import {test, expect, describe} from 'bun:test'
import {
    contextWindowForGroup,
    getParentContextWindow,
    resolveContextUsage
} from '../../src/task/context-usage.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'

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

describe('contextWindowForGroup', () => {
    /**
     * This number arms `StallDetector`'s churn rule, and its two error
     * directions are NOT symmetric. Too large fires late — degraded, and the
     * no-new-ground rule still covers it. Too small fires EARLY and kills a
     * healthy child. Every case below leans that way on purpose.
     */
    const ctx = (parent: number, models: Record<string, number> = {}) => ({
        model: {contextWindow: parent},
        modelRegistry: {
            find: (p: string, i: string) =>
                models[`${p}/${i}`] === undefined ? undefined : {contextWindow: models[`${p}/${i}`]}
        }
    })
    const cfg = (spec: string): PiTaskConfig => ({
        ...DEFAULT_CONFIG,
        groupModels: {...DEFAULT_CONFIG.groupModels, gate: spec}
    })

    test('`inherit` is byte-identical to the parent window', () => {
        expect(contextWindowForGroup(ctx(120_000), 'gate', cfg('inherit'))).toBe(120_000)
    })

    test('a resolved model uses its OWN window, larger or smaller', () => {
        const c = ctx(8_000, {'acme/big': 200_000, 'acme/small': 4_000})
        expect(contextWindowForGroup(c, 'gate', cfg('acme/big'))).toBe(200_000)
        expect(contextWindowForGroup(c, 'gate', cfg('acme/small'))).toBe(4_000)
    })

    test('it is NEVER min(parent, group)', () => {
        // A big-context research model under a small host model is the real
        // false positive this exists to stop. Taking the minimum would import
        // that danger deliberately.
        const c = ctx(8_000, {'acme/big': 200_000})
        expect(contextWindowForGroup(c, 'gate', cfg('acme/big'))).toBe(200_000)
    })

    test('an unresolvable spec falls back to the parent', () => {
        expect(contextWindowForGroup(ctx(64_000), 'gate', cfg('acme/gone'))).toBe(64_000)
    })

    test('a model declaring NO window falls back to the parent', () => {
        const c = ctx(64_000, {'acme/quiet': 0})
        expect(contextWindowForGroup(c, 'gate', cfg('acme/quiet'))).toBe(64_000)
    })

    test('no registry at all falls back to the parent', () => {
        expect(contextWindowForGroup({model: {contextWindow: 32_000}}, 'gate', cfg('a/b'))).toBe(
            32_000
        )
    })
})
