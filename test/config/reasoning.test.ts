import {describe, expect, test} from 'bun:test'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {
    effectiveReasoning,
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
} from '../../src/config/reasoning.js'

const cfgWith = (over: Partial<PiTaskConfig>): PiTaskConfig => ({...DEFAULT_CONFIG, ...over})

/** A table with a distinct, recognisable level per group. */
const distinct = (): Record<ReasoningGroup, GroupSetting> => ({
    research: 'off',
    'research:files': 'minimal',
    'research:apis': 'low',
    'research:context': 'high',
    'research:tooling': 'medium',
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

describe('the table and the emitted flag agree', () => {
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
        // xhigh/max are opt-in in pi: pi-ai's getSupportedThinkingLevels offers
        // them only when the model's thinkingLevelMap declares them, so a level
        // listed here that pi does not support would be an unofferable row.
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

    test('a config written before the split carries `research` into its four workers', () => {
        // THE MIGRATION. A config file with no `research:*` keys inherits the
        // `research` value it does carry. Filling those four from the default
        // table instead would silently overrule what the user set.
        const out = sanitizeReasoningLevels({research: 'off', gate: 'high'})
        expect(out['research:files']).toBe('off')
        expect(out['research:apis']).toBe('off')
        expect(out['research:context']).toBe('off')
        expect(out['research:tooling']).toBe('off')
        // And only the research family: everything else still falls to the table.
        expect(out.phase).toBe(DEFAULT_REASONING_TABLE.phase)
    })

    test('an explicit worker level beats the inherited `research` one', () => {
        const out = sanitizeReasoningLevels({research: 'off', 'research:tooling': 'medium'})
        expect(out['research:tooling']).toBe('medium')
        expect(out['research:files']).toBe('off')
    })

    test('with no stored `research` the workers fall to the default table', () => {
        const out = sanitizeReasoningLevels({gate: 'high'})
        for (const g of [
            'research:files',
            'research:apis',
            'research:context',
            'research:tooling'
        ] as const) {
            expect(out[g]).toBe(DEFAULT_REASONING_TABLE[g])
        }
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

describe('effectiveReasoning', () => {
    /**
     * The whole-table question. It is `resolveReasoning` for every group and
     * nothing else — that IS the property, because the moment it is anything
     * else the settings menu, the mismatch warning and the custom-mode seeder
     * start disagreeing.
     */
    test('answers every group, and answers each the way resolveReasoning does', () => {
        for (const mode of REASONING_MODES) {
            const cfg = {...DEFAULT_CONFIG, reasoningMode: mode}
            const table = effectiveReasoning(cfg)
            expect(Object.keys(table).sort()).toEqual([...REASONING_GROUPS].sort())
            for (const group of REASONING_GROUPS) {
                expect(table[group]).toBe(resolveReasoning(group, cfg))
            }
        }
    })

    test('is a fresh object, so a caller cannot write through it into the config', () => {
        // `applyReasoningLevel` seeds custom mode from this. Handing back a live
        // reference would make freezing the table an alias of it.
        const cfg = {...DEFAULT_CONFIG, reasoningLevels: {...DEFAULT_CONFIG.reasoningLevels}}
        const table = effectiveReasoning(cfg)
        table.planning = 'high'
        expect(cfg.reasoningLevels.planning).not.toBe('high')
    })
})
