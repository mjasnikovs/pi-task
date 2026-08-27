import {readFileSync} from 'node:fs'
import {describe, expect, test} from 'bun:test'
import {DEFAULT_CONFIG, type PiTaskConfig} from './config.js'
import {
    DEFAULT_REASONING_TABLE,
    REASONING_GROUPS,
    REASONING_MODES,
    REASONING_ON_LEVEL,
    REASONING_SETTINGS,
    resolveReasoning,
    sanitizeReasoningLevels,
    sanitizeReasoningMode,
    thinkingArgs,
    type GroupSetting,
    type ReasoningGroup
} from './reasoning.js'

const cfgWith = (over: Partial<PiTaskConfig>): PiTaskConfig => ({...DEFAULT_CONFIG, ...over})

/** A table with a distinct, recognisable level per group. */
const distinct = (): Record<ReasoningGroup, GroupSetting> => ({
    research: 'off',
    phase: 'low',
    planning: 'high',
    plan: 'medium',
    gate: 'minimal',
    extraction: 'off',
    implementation: 'high'
})

describe('resolveReasoning', () => {
    test('mode off pins every group to off', () => {
        // Including the groups whose custom table says otherwise: a forcing mode
        // that consulted the table would not be forcing anything.
        const cfg = cfgWith({reasoningMode: 'off', reasoningLevels: distinct()})
        for (const g of REASONING_GROUPS) expect(resolveReasoning(g, cfg)).toBe('off')
    })

    test('mode on pins every group to the one on-level', () => {
        const cfg = cfgWith({reasoningMode: 'on', reasoningLevels: distinct()})
        for (const g of REASONING_GROUPS) expect(resolveReasoning(g, cfg)).toBe(REASONING_ON_LEVEL)
    })

    test('mode default reads the measured table, not the custom one', () => {
        const cfg = cfgWith({reasoningMode: 'default', reasoningLevels: distinct()})
        for (const g of REASONING_GROUPS) {
            expect(resolveReasoning(g, cfg)).toBe(DEFAULT_REASONING_TABLE[g])
        }
    })

    test('mode custom reads the custom table', () => {
        const levels = distinct()
        const cfg = cfgWith({reasoningMode: 'custom', reasoningLevels: levels})
        for (const g of REASONING_GROUPS) expect(resolveReasoning(g, cfg)).toBe(levels[g])
    })
})

describe('every shipped cell is measured or inherit', () => {
    // Cells started all-`inherit` and fill in one live A/B at a time. The
    // invariant that replaced "the table is a no-op" is narrower but is the one
    // that actually matters: a cell may name a level ONLY if the comment beside
    // it records the measurement that chose it. A cell filled from intuition
    // has no comment, so it breaks this test — which is the point.
    const source = readFileSync(new URL('./reasoning.ts', import.meta.url), 'utf8')

    /** The comment block immediately above a cell, '' when there is none. */
    const commentAbove = (group: string): string => {
        const at = source.indexOf(`\n    ${group}: '`)
        if (at < 0) return ''
        const before = source.slice(0, at).split('\n')
        const out: string[] = []
        for (let i = before.length - 1; i >= 0 && before[i]!.trim().startsWith('//'); i--) {
            out.unshift(before[i]!.trim())
        }
        return out.join(' ')
    }

    test('a cell that names a level cites its A/B', () => {
        for (const g of REASONING_GROUPS) {
            const cell = DEFAULT_REASONING_TABLE[g]
            if (cell === 'inherit') continue
            const c = commentAbove(g)
            // The four facts that make a cell auditable: that it was an A/B,
            // on how many trials, against which model file, and — because the
            // harness returns a forced two-way verdict — down which rung. A
            // rung-3 cell is a stated prior, not a finding, and a reader who
            // cannot see that will over-trust it.
            expect(c, `${g} names '${cell}' with no comment`).not.toBe('')
            expect(c, `${g} comment cites no A/B`).toMatch(/A\/B/)
            expect(c, `${g} comment cites no trial count`).toMatch(/n=\d+\/arm/)
            expect(c, `${g} comment names no model file`).toMatch(/\.gguf/)
            expect(c, `${g} comment names no rung`).toMatch(/RUNG [123]|rung [123]/i)
        }
    })

    test('an inherit cell emits no flag, a measured cell emits its level', () => {
        for (const g of REASONING_GROUPS) {
            const cell = DEFAULT_REASONING_TABLE[g]
            const args = thinkingArgs(resolveReasoning(g, DEFAULT_CONFIG))
            expect(args).toEqual(cell === 'inherit' ? [] : ['--thinking', cell])
        }
    })
})

describe('thinkingArgs', () => {
    test('inherit is the empty fragment', () => {
        expect(thinkingArgs('inherit')).toEqual([])
    })

    test('every other setting becomes a --thinking pair', () => {
        for (const s of REASONING_SETTINGS) {
            if (s === 'inherit') continue
            expect(thinkingArgs(s)).toEqual(['--thinking', s])
        }
    })

    test('offers no level pi would send raw to a model with no map', () => {
        // xhigh/max are opt-in in pi: an absent thinkingLevelMap entry means
        // UNSUPPORTED for those two, so pi forwards the string and Qwen3.8's
        // template answers with HTTP 500 instead of clamping.
        expect(REASONING_SETTINGS).not.toContain('xhigh' as GroupSetting)
        expect(REASONING_SETTINGS).not.toContain('max' as GroupSetting)
    })
})

describe('sanitizeReasoningMode', () => {
    test('passes an offered value through', () => {
        for (const m of REASONING_MODES) expect(sanitizeReasoningMode(m)).toBe(m)
    })

    test('falls back to default for anything off-menu', () => {
        for (const hostile of ['CUSTOM', 'inherit', '', 0, true, null, undefined, {}, []]) {
            expect(sanitizeReasoningMode(hostile)).toBe('default')
        }
    })
})

describe('sanitizeReasoningLevels', () => {
    test('passes an offered table through', () => {
        expect(sanitizeReasoningLevels(distinct())).toEqual(distinct())
    })

    test('a missing group is filled from the default table, not left undefined', () => {
        // The whole reason this returns a complete record: a hole would reach
        // resolveReasoning as undefined and every call site would need a
        // fallback of its own.
        const partial = {research: 'off'}
        const out = sanitizeReasoningLevels(partial)
        expect(Object.keys(out).sort()).toEqual([...REASONING_GROUPS].sort())
        expect(out.research).toBe('off')
        expect(out.gate).toBe(DEFAULT_REASONING_TABLE.gate)
    })

    test('an off-menu level falls back per key, keeping the good ones', () => {
        const out = sanitizeReasoningLevels({research: 'medium', gate: 'xhigh', phase: 42})
        expect(out.research).toBe('medium')
        expect(out.gate).toBe(DEFAULT_REASONING_TABLE.gate)
        expect(out.phase).toBe(DEFAULT_REASONING_TABLE.phase)
    })

    test('a group from a future version is dropped, not carried', () => {
        const out = sanitizeReasoningLevels({research: 'low', 'some-new-group': 'high'})
        expect(Object.keys(out).sort()).toEqual([...REASONING_GROUPS].sort())
    })

    test('a non-object yields the complete default table', () => {
        for (const hostile of [null, undefined, 'off', 7, ['off']]) {
            expect(sanitizeReasoningLevels(hostile)).toEqual({...DEFAULT_REASONING_TABLE})
        }
    })
})
