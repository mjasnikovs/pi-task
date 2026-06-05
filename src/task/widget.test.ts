import {describe, expect, test} from 'bun:test'
import {
    buildAutoLoaderLines,
    formatContextDetail,
    WIDGET_LAST_LINE_MAX,
    type AutoLoaderState
} from './widget.js'

describe('buildAutoLoaderLines', () => {
    const base: AutoLoaderState = {
        title: 'Add dark mode',
        step: 'clarify',
        stepNum: 1,
        stepTotal: 2,
        startedAt: Date.now()
    }

    test('renders the same /task-style block: head + planning step/elapsed', () => {
        const lines = buildAutoLoaderLines(base)
        expect(lines).toHaveLength(2)
        expect(lines[0]).toBe('/task-auto · Add dark mode')
        expect(lines[1]).toContain('planning 1/2 clarify · ')
    })

    test('appends the latest child output line as a muted ↳ trailer', () => {
        const lines = buildAutoLoaderLines({...base, lastLine: 'reading src/index.ts'})
        expect(lines).toHaveLength(3)
        expect(lines[2]).toBe('↳ reading src/index.ts')
    })

    test('truncates an over-long child output line', () => {
        const long = 'x'.repeat(WIDGET_LAST_LINE_MAX + 50)
        const lines = buildAutoLoaderLines({...base, lastLine: long})
        expect(lines[2].length).toBeLessThanOrEqual(WIDGET_LAST_LINE_MAX + 2) // "↳ " prefix
        expect(lines[2].endsWith('…')).toBe(true)
    })

    test('shows context usage with a bar when a window is known', () => {
        const lines = buildAutoLoaderLines({
            ...base,
            contextUsage: {tokens: 12_000, contextWindow: 200_000, percent: 6}
        })
        expect(lines[1]).toContain('12k/200k')
    })
})

describe('formatContextDetail', () => {
    test('renders tokens/window with a progress bar', () => {
        expect(formatContextDetail({tokens: 12_000, contextWindow: 200_000, percent: 6})).toContain(
            '12k/200k'
        )
    })

    test('renders bare token count when window is unknown', () => {
        expect(formatContextDetail({tokens: 1500, contextWindow: 0, percent: 0})).toBe('1.5k')
    })

    test('returns null when there is nothing to show', () => {
        expect(formatContextDetail({tokens: 0, contextWindow: 0, percent: 0})).toBeNull()
    })
})
