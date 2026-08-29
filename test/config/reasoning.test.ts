import {readFileSync} from 'node:fs'
import {describe, expect, test} from 'bun:test'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {srcPath} from '../test-utils/src-tree.js'
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

describe('every shipped cell is measured or inherit', () => {
    // Cells started all-`inherit` and fill in one live A/B at a time. The
    // invariant that replaced "the table is a no-op" is narrower but is the one
    // that actually matters: a cell may name a level ONLY if the comment beside
    // it records the measurement that chose it. A cell filled from intuition
    // has no comment, so it breaks this test — which is the point.
    const source = readFileSync(srcPath('config', 'reasoning.ts'), 'utf8')

    /** The comment block immediately above a cell, '' when there is none. */
    const commentAbove = (group: string): string => {
        // Two spellings, because a group whose name carries a colon
        // (`research:files`) is written as a QUOTED key. A helper that knew only
        // the bare form returned '' for those four and read every one of them as
        // an uncommented cell.
        const at = Math.max(
            source.indexOf(`\n    ${group}: '`),
            source.indexOf(`\n    '${group}': '`)
        )
        if (at < 0) return ''
        const before = source.slice(0, at).split('\n')
        const out: string[] = []
        for (let i = before.length - 1; i >= 0 && before[i]!.trim().startsWith('//'); i--) {
            out.unshift(before[i]!.trim())
        }
        return out.join(' ')
    }

    /**
     * THE ONE WAY OUT, and it is deliberately loud.
     *
     * A cell may name a level with no A/B behind it only if it SAYS SO in the
     * comment, in these words, and says how to replace itself with a real
     * measurement. The exemption is itself asserted, so a reader who greps for
     * the phrase finds every cell in the table that no run stands behind.
     *
     * It exists because `inherit` cannot express a DECISION. For an unattended
     * child, `inherit` does not defer to a judgement — it defers to whatever
     * settings.json holds, which is the case this table exists to remove. Used
     * once, by `phase`, whose four candidate axes are all dead.
     */
    const DECLARED_UNMEASURED = 'NOT MEASURED. DECIDED BY PRIOR'

    /**
     * THE ONE WAY AN UNMEASURED CELL MAY CITE A TRIAL COUNT.
     *
     * A COST RUN is a real artefact that decides nothing: it spends the same
     * trials on the same trees, but its axis is TERMINATION, so it can report
     * seconds and death rates and no quality reading at all. `research:apis`
     * and `research:context` each have one, and suppressing their numbers to
     * satisfy the rule above would hide evidence the next reader needs.
     *
     * The exemption is deliberately narrow and greppable: the comment must ALSO
     * say, in these words, that the run cannot write the cell. A cell that cites
     * n=NN/arm without that sentence is claiming a measurement it does not have,
     * which is what the rule exists to stop.
     */
    const DECLARED_COST_ONLY = 'CANNOT WRITE THIS CELL'

    test('an unmeasured cell says so in those words, and says how to fix it', () => {
        for (const g of REASONING_GROUPS) {
            const c = commentAbove(g)
            if (!c.includes(DECLARED_UNMEASURED)) continue
            if (!c.includes(DECLARED_COST_ONLY)) {
                expect(c, `${g} declares itself unmeasured but cites a trial count`).not.toMatch(
                    /n=\d+\/arm/
                )
            }
            expect(c, `${g} declares itself unmeasured with no route to a measurement`).toMatch(
                /TO REPLACE THIS WITH A MEASUREMENT/
            )
        }
    })

    test('a cost-run exemption is only ever claimed by an unmeasured cell', () => {
        // The exemption lets a cell carry trial counts. It must never appear on
        // a cell that is claiming to be MEASURED, where it would read as a
        // disclaimer on a real verdict.
        for (const g of REASONING_GROUPS) {
            const c = commentAbove(g)
            if (!c.includes(DECLARED_COST_ONLY)) continue
            expect(
                c,
                `${g} claims the cost-run exemption without declaring itself unmeasured`
            ).toContain(DECLARED_UNMEASURED)
            expect(c, `${g} claims a cost run but does not name it one`).toContain('COST RUN')
        }
    })

    test('a cell that names a level cites its A/B', () => {
        for (const g of REASONING_GROUPS) {
            const cell = DEFAULT_REASONING_TABLE[g]
            if (cell === 'inherit') continue
            const c = commentAbove(g)
            // A cell that declares itself unmeasured is exempt from the
            // citation and held to the rule above instead.
            if (c.includes(DECLARED_UNMEASURED)) continue
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

    test('a config written before the split carries `research` into its four workers', () => {
        // THE MIGRATION. A file saved when `research` was one cell has no
        // `research:*` keys at all. Filling them from the default table would
        // silently overrule the user — those four children are exactly what
        // their `research` setting used to control.
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
     * The whole-table question, which four callers used to answer by writing the
     * same loop. It is `resolveReasoning` for every group and nothing else — that
     * IS the property, because the moment it is anything else the settings menu,
     * the mismatch warning and the custom-mode seeder start disagreeing.
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
