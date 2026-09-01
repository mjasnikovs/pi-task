/**
 * The seven `think:` rows in /task-config.
 *
 * The row's value is the EFFECTIVE level, not the stored custom table, so in
 * `default` / `on` / `off` the menu shows what each step really runs at rather
 * than a table nothing is reading. That is what makes the measured default
 * discoverable instead of buried in a source file — and it is also the thing
 * that could quietly become a lie, so it is pinned here.
 */
import {describe, expect, test} from 'bun:test'
import {SettingsList} from '@earendil-works/pi-tui'
import type {SettingsListTheme} from '@earendil-works/pi-tui'
import {
    applyGroupModel,
    applyReasoningLevel,
    createSettingsPanel,
    offeredLevels,
    panelItems,
    reasoningItems,
    reasoningRowLabel,
    renderRows,
    syncRows,
    configRows,
    SECTION_ID_PREFIX,
    type ModelCatalog
} from '../../src/config/register.js'

/** The minimum theme SettingsList needs; none of it is asserted on. */
const listTheme = (): SettingsListTheme => ({
    label: t => t,
    value: t => t,
    description: t => t,
    cursor: '> ',
    hint: t => t
})
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {
    DEFAULT_REASONING_TABLE,
    CHILD_GROUPS,
    REASONING_ON_LEVEL,
    REASONING_SETTINGS,
    resolveReasoning
} from '../../src/config/reasoning.js'

const draft = (over: Partial<PiTaskConfig> = {}): PiTaskConfig => ({
    ...DEFAULT_CONFIG,
    reasoningLevels: {...DEFAULT_REASONING_TABLE},
    ...over
})

// No beforeEach/afterEach save-and-restore of the live config singleton: every
// function under test takes its config as an argument, so `draft()` above is the
// only state any of these tests has. Mutating the singleton and putting it back
// still leaves the suite's result depending on what it was to begin with.

describe('reasoningRowLabel', () => {
    /**
     * The four research workers are the only rows in the whole menu whose
     * parent is also a row. Rendered flat they read as four more peers of
     * `research`, which is what this shape exists to stop.
     */
    test('children are branches under their parent, last one cornered', () => {
        expect(reasoningRowLabel('research')).toBe('think: research')
        expect(reasoningRowLabel('research:files')).toBe('   \u251c\u2500 files')
        expect(reasoningRowLabel('research:apis')).toBe('   \u251c\u2500 apis')
        expect(reasoningRowLabel('research:context')).toBe('   \u251c\u2500 context')
        expect(reasoningRowLabel('research:tooling')).toBe('   \u2514\u2500 tooling')
    })

    test('the corner is derived, not hand-kept', () => {
        // Exactly one child per parent may carry the corner, and it must be the
        // LAST one listed. A fifth worker appended to CHILD_GROUPS moves it
        // without anyone editing this file.
        const corners = CHILD_GROUPS.filter(g => reasoningRowLabel(g).includes('\u2514'))
        const children = CHILD_GROUPS.filter(g => g.includes(':'))
        expect(corners).toHaveLength(new Set(children.map(g => g.split(':')[0])).size)
        expect(corners.at(-1)).toBe(children.at(-1))
    })

    test('a parentless group keeps the think: prefix', () => {
        for (const group of CHILD_GROUPS.filter(g => !g.includes(':'))) {
            expect(reasoningRowLabel(group)).toBe(`think: ${group}`)
        }
    })
})

describe('reasoningItems', () => {
    test('the headless one-liner names the group in full', () => {
        // `|`-joined on one line, a branch glyph names no parent. The panel
        // label and the headless label are allowed to differ; only the panel
        // has a row above to hang the branch from.
        for (const row of reasoningItems()) {
            expect(row.headlessLabel).toBe(`think: ${row.id.slice('reason:'.length)}`)
        }
    })

    test('one row per group, in every mode', () => {
        for (const mode of ['default', 'on', 'off', 'custom'] as const) {
            const cfg = draft({reasoningMode: mode})
            const rows = reasoningItems()
            expect(rows).toHaveLength(CHILD_GROUPS.length)
            for (const [i, row] of rows.entries()) {
                expect(row.format(cfg)).toBe(resolveReasoning(CHILD_GROUPS[i]!, cfg))
            }
        }
    })

    test('shows the EFFECTIVE level, not the stored table', () => {
        // In mode `on` the stored table is irrelevant, and a row echoing it
        // would tell the user their run is doing something it is not.
        const cfg = draft({
            reasoningMode: 'on',
            reasoningLevels: {...DEFAULT_REASONING_TABLE, gate: 'off'}
        })
        const gate = reasoningItems().find(r => r.id.endsWith('gate'))!
        expect(gate.format(cfg)).toBe(REASONING_ON_LEVEL)
    })

    test('every offered value is one the config can store', () => {
        for (const row of reasoningItems()) {
            expect(row.values).toEqual([...REASONING_SETTINGS])
            expect(REASONING_SETTINGS).toContain(row.format(draft()) as never)
        }
    })

    test('the rows appear in the panel', () => {
        const ids = panelItems(draft(), [], []).map(i => i.id)
        expect(ids).toContain('reasoningMode')
        for (const g of CHILD_GROUPS) expect(ids).toContain(`reason:${g}`)
    })

    test('every row id is unique', () => {
        const ids = panelItems(draft(), [], []).map(i => i.id)
        expect(new Set(ids).size).toBe(ids.length)
    })
})

describe('applyReasoningLevel', () => {
    test('setting a group switches the mode to custom', () => {
        // There is nowhere else a per-group choice can live, so a row that did
        // not switch the mode would be a control with no effect.
        const cfg = draft({reasoningMode: 'default'})
        applyReasoningLevel(cfg, 'gate', 'low')
        expect(cfg.reasoningMode).toBe('custom')
        expect(cfg.reasoningLevels.gate).toBe('low')
    })

    test('leaving a forcing mode PINS every other group to what it was running', () => {
        // THE TRAP THIS EXISTS TO AVOID. In mode `off` every group runs at off.
        // Nudging one row must not silently return the other six to whatever the
        // stored table happened to hold — changing one row changes one row.
        const cfg = draft({
            reasoningMode: 'off',
            reasoningLevels: {...DEFAULT_REASONING_TABLE, research: 'high', phase: 'high'}
        })
        applyReasoningLevel(cfg, 'gate', 'low')
        expect(cfg.reasoningLevels.gate).toBe('low')
        for (const g of CHILD_GROUPS) {
            if (g === 'gate') continue
            expect(resolveReasoning(g, cfg)).toBe('off')
        }
    })

    test('round-trips: what a row shows after a change is what was chosen', () => {
        for (const setting of REASONING_SETTINGS) {
            const cfg = draft({reasoningMode: 'default'})
            applyReasoningLevel(cfg, 'research', setting)
            const row = reasoningItems().find(r => r.id === 'reason:research')!
            expect(row.format(cfg)).toBe(setting)
        }
    })

    test('an off-menu value is ignored, never stored raw', () => {
        const cfg = draft({reasoningMode: 'default'})
        applyReasoningLevel(cfg, 'gate', 'xhigh')
        expect(cfg.reasoningMode).toBe('default')
        expect(cfg.reasoningLevels.gate).toBe(DEFAULT_REASONING_TABLE.gate)
    })

    test('does not mutate the table it was given', () => {
        // The panel edits a draft; sharing the live object would apply
        // half-made choices to children that are already running.
        const levels = {...DEFAULT_REASONING_TABLE}
        const cfg = draft({reasoningMode: 'custom', reasoningLevels: levels})
        applyReasoningLevel(cfg, 'gate', 'low')
        expect(levels.gate).toBe(DEFAULT_REASONING_TABLE.gate)
    })
})

describe('the rows do not go stale (the bug you saw)', () => {
    /**
     * The rows describe EACH OTHER, so one keystroke can make several of them
     * wrong at once. Under mode `off` every group runs at `off`, so a menu showing
     * `reasoning  off` beside seven `think:` rows still reading `inherit` is
     * describing a run that cannot happen.
     *
     * The mechanism: `panelItems` builds each row's `currentValue` from
     * `i.format(cfg)` once, when the panel is built. Only `syncRows` re-asks every
     * row afterwards and writes the answers back.
     */
    test('flipping the mode row updates every think: row', () => {
        const cfg = draft({reasoningMode: 'default'})
        const items = panelItems(cfg, [], [])
        const list = new SettingsList(
            items,
            9,
            listTheme(),
            () => {},
            () => {}
        )

        cfg.reasoningMode = 'off'
        syncRows(cfg, configRows([], []), list)

        for (const g of CHILD_GROUPS) {
            const row = items.find(i => i.id === `reason:${g}`)!
            expect(row.currentValue, `think: ${g}`).toBe('off')
        }
    })

    test('setting one group row updates the mode row and the other six', () => {
        // Cycling a group row flips the mode to custom and pins the rest, so
        // three kinds of row change from one keystroke.
        const cfg = draft({reasoningMode: 'off'})
        const items = panelItems(cfg, [], [])
        const list = new SettingsList(
            items,
            9,
            listTheme(),
            () => {},
            () => {}
        )

        applyReasoningLevel(cfg, 'gate', 'medium')
        syncRows(cfg, configRows([], []), list)

        expect(items.find(i => i.id === 'reasoningMode')!.currentValue).toBe('custom')
        expect(items.find(i => i.id === 'reason:gate')!.currentValue).toBe('medium')
        for (const g of CHILD_GROUPS) {
            if (g === 'gate') continue
            expect(items.find(i => i.id === `reason:${g}`)!.currentValue, g).toBe('off')
        }
    })

    test('no think: row can ever show a level the run will not use', () => {
        // The general property the two cases above are instances of.
        for (const mode of ['default', 'on', 'off', 'custom'] as const) {
            const cfg = draft({reasoningMode: mode})
            const items = panelItems(cfg, [], [])
            const list = new SettingsList(
                items,
                9,
                listTheme(),
                () => {},
                () => {}
            )
            syncRows(cfg, configRows([], []), list)
            for (const g of CHILD_GROUPS) {
                const row = items.find(i => i.id === `reason:${g}`)!
                expect(row.currentValue, `${mode}/${g}`).toBe(resolveReasoning(g, cfg))
            }
        }
    })
})

describe('the menu is divided into titled sections', () => {
    /** Titled headers only — the blank rows between sections carry the same id. */
    const headers = (): string[] =>
        panelItems(draft(), [], [])
            .filter(i => i.id.startsWith(SECTION_ID_PREFIX) && i.label !== '')
            .map(i => i.label)

    test('every non-header row sits under a header', () => {
        let seenHeader = false
        for (const row of panelItems(draft(), [], [])) {
            if (row.id.startsWith(SECTION_ID_PREFIX)) seenHeader = true
            else expect(seenHeader, `${row.id} appears before any header`).toBe(true)
        }
    })

    test('a header is inert — no values means Enter cannot cycle it', () => {
        // This is the whole mechanism. If a header ever gained `values`,
        // pressing Enter on it would call onChange with a section id.
        for (const row of panelItems(draft(), [], [])) {
            if (row.id.startsWith(SECTION_ID_PREFIX)) expect(row.values).toBeUndefined()
            else expect(row.values?.length ?? 0).toBeGreaterThan(0)
        }
    })

    test('an empty section prints no header', () => {
        // Nothing installed ⇒ no extension rows ⇒ the heading would sit alone.
        expect(headers().some(h => h.includes('CHILD EXTENSIONS'))).toBe(false)
        const withExt = panelItems(draft(), [{path: '/x.js', label: 'x', origin: 'user'}], [])
        expect(
            withExt
                .filter(i => i.id.startsWith(SECTION_ID_PREFIX))
                .map(i => i.label)
                .join()
        ).toContain('CHILD EXTENSIONS')
    })

    test('a blank row separates the sections, and never opens the menu', () => {
        const rows = panelItems(draft(), [], [])
        const gaps = rows.filter(i => i.label === '')
        // One per boundary — never before the first section, which would put a
        // blank line under the title where the frame already leaves one.
        expect(gaps).toHaveLength(headers().length - 1)
        expect(rows[0]!.label).not.toBe('')
        for (const gap of gaps) expect(gap.values).toBeUndefined()
        // Each one sits directly above a heading, not adrift among the rows.
        const labels = rows.map(i => i.label)
        labels.forEach((label, i) => {
            if (label === '') expect(headers()).toContain(labels[i + 1]!)
        })
    })

    test('timeouts is the last section', () => {
        // The longest block (it grows with the host's tool list) and the least
        // often changed, so it sits below everything short.
        expect(headers().at(-1)).toBe('TIMEOUTS')
    })

    test('the reasoning mode and its seven groups are in one section', () => {
        const rows = panelItems(draft(), [], []).map(i => i.id)
        const start = rows.indexOf('reasoningMode')
        const nextHeader = rows.findIndex((id, i) => i > start && id.startsWith(SECTION_ID_PREFIX))
        const block = rows.slice(start, nextHeader)
        for (const g of CHILD_GROUPS) expect(block).toContain(`reason:${g}`)
    })
})

// ─── narrowing, and the re-clamp that has to come with it ────────────────────

const NON_REASONING = {reasoning: false}
const FULL = {reasoning: true}
/** Declares xhigh, which this menu excludes on purpose. */
const DECLARES_XHIGH = {reasoning: true, thinkingLevelMap: {xhigh: 'xhigh'}}

const cat = (facts: ModelCatalog['facts'], specs = ['acme/small']): ModelCatalog => ({specs, facts})

describe('the thinking picker narrows to what the model can honour', () => {
    test('a reasoning:false model offers only inherit and off', () => {
        expect(offeredLevels(NON_REASONING)).toEqual(['inherit', 'off'])
    })

    test("an unknown model offers everything — today's behaviour", () => {
        expect(offeredLevels(undefined)).toEqual([...REASONING_SETTINGS])
    })

    test('a model declaring xhigh does NOT smuggle xhigh into this menu', () => {
        // supportedThinkingLevels returns the whole ladder. REASONING_SETTINGS
        // excludes xhigh/max on purpose, because pi's own UI may not offer them.
        expect(offeredLevels(DECLARES_XHIGH)).toEqual([...REASONING_SETTINGS])
        expect(offeredLevels(DECLARES_XHIGH)).not.toContain('xhigh')
    })

    test('the submenu is built at ENTER-time, from the LIVE draft', () => {
        // `values` is static and computed once. The narrowing depends on a cell
        // the user changes while the panel is open, so a snapshot would offer
        // levels the chosen model erases.
        const catalog = cat(spec => (spec === 'acme/small' ? NON_REASONING : FULL))
        const row = reasoningItems(catalog).find(i => i.id === 'reason:gate')!
        const cfg = draft()
        expect(row.submenu!(cfg).map(o => o.value)).toEqual([...REASONING_SETTINGS])
        cfg.groupModels = {...cfg.groupModels, gate: 'acme/small'}
        expect(row.submenu!(cfg).map(o => o.value)).toEqual(['inherit', 'off'])
    })
})

describe("choosing a model re-clamps that group's level in the same write", () => {
    test('a level the new model cannot honour is moved, not frozen', () => {
        // Narrowing the picker alone would freeze a lie into a cell it has just
        // made unconfigurable.
        const cfg = draft({reasoningMode: 'custom'})
        cfg.reasoningLevels = {...cfg.reasoningLevels, gate: 'high'}
        applyGroupModel(
            cfg,
            'gate',
            'acme/small',
            cat(() => NON_REASONING)
        )
        expect(resolveReasoning('gate', cfg)).toBe('off')
    })

    test('it fires in mode `on`, where the STORED cell says nothing', () => {
        // resolveReasoning is the only place the four modes are read; in `on`
        // every group runs at medium whatever the table holds. Comparing the
        // stored cell would see no clamp and stay silent about a real lie.
        const cfg = draft({reasoningMode: 'on'})
        expect(resolveReasoning('gate', cfg)).toBe(REASONING_ON_LEVEL)
        applyGroupModel(
            cfg,
            'gate',
            'acme/small',
            cat(() => NON_REASONING)
        )
        expect(resolveReasoning('gate', cfg)).toBe('off')
    })

    test('a fully-capable model does NOT gratuitously flip the mode to custom', () => {
        const cfg = draft({reasoningMode: 'default'})
        applyGroupModel(
            cfg,
            'gate',
            'acme/small',
            cat(() => FULL)
        )
        expect(cfg.reasoningMode).toBe('default')
    })

    test('an unresolvable model leaves the level alone', () => {
        const cfg = draft({reasoningMode: 'default'})
        applyGroupModel(
            cfg,
            'gate',
            'acme/small',
            cat(() => undefined)
        )
        expect(cfg.reasoningMode).toBe('default')
        expect(cfg.groupModels.gate).toBe('acme/small')
    })
})

describe('a submenu suspends the inert-row walk', () => {
    test('one arrow press inside a picker reaches it exactly once', () => {
        // SkipInertRows replays the key ONCE PER ROW IT SKIPS, and SettingsList
        // forwards everything to an open submenu. So the row that proves this
        // has to be the LAST of its section: after `model: implementation` come a
        // gap and the `reasoning` header, so one press would arrive THREE times
        // and pick the wrong option. A row with a selectable neighbour cannot
        // show the bug at all.
        const catalog = cat(() => FULL, ['acme/a', 'acme/b', 'acme/c', 'acme/d'])
        const cfg = draft()
        const written: Array<[string, string]> = []
        const items = renderRows(cfg, configRows([], [], catalog))
        const panel = createSettingsPanel(
            items,
            {fg: (_c: string, t: string) => t, bold: (t: string) => t} as never,
            (id, value) => written.push([id, value]),
            () => {}
        )
        const selectable = items.filter(i => !i.id.startsWith(SECTION_ID_PREFIX))
        const steps = selectable.findIndex(i => i.id === 'model:implementation')
        for (let i = 0; i < steps; i++) panel.handleInput('\x1b[B')
        panel.handleInput('\r')
        panel.handleInput('\x1b[B')
        panel.handleInput('\r')
        // Option 0 is `inherit`; one press lands on option 1. Three presses land
        // on `acme/c`, which is what an unsuspended walk produces.
        expect(written).toEqual([['model:implementation', 'acme/a']])
    })
})
