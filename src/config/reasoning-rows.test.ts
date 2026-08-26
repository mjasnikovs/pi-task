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
    applyReasoningLevel,
    panelItems,
    reasoningItems,
    refreshReasoningRows,
    SECTION_ID_PREFIX
} from './register.js'

/** The minimum theme SettingsList needs; none of it is asserted on. */
const listTheme = (): SettingsListTheme => ({
    label: t => t,
    value: t => t,
    description: t => t,
    cursor: '> ',
    hint: t => t
})
import {DEFAULT_CONFIG, type PiTaskConfig} from './config.js'
import {
    DEFAULT_REASONING_TABLE,
    REASONING_GROUPS,
    REASONING_ON_LEVEL,
    REASONING_SETTINGS,
    resolveReasoning
} from './reasoning.js'

const draft = (over: Partial<PiTaskConfig> = {}): PiTaskConfig => ({
    ...DEFAULT_CONFIG,
    reasoningLevels: {...DEFAULT_REASONING_TABLE},
    ...over
})

// No beforeEach/afterEach save-and-restore of the live config singleton: every
// function under test takes its config as an argument, so `draft()` above is the
// only state any of these tests has. Mutating the singleton and putting it back
// still leaves the suite's result depending on what it was to begin with.

describe('reasoningItems', () => {
    test('one row per group, in every mode', () => {
        for (const mode of ['default', 'on', 'off', 'custom'] as const) {
            const rows = reasoningItems(draft({reasoningMode: mode}))
            expect(rows).toHaveLength(REASONING_GROUPS.length)
        }
    })

    test('shows the EFFECTIVE level, not the stored table', () => {
        // In mode `on` the stored table is irrelevant, and a row echoing it
        // would tell the user their run is doing something it is not.
        const cfg = draft({
            reasoningMode: 'on',
            reasoningLevels: {...DEFAULT_REASONING_TABLE, gate: 'off'}
        })
        const gate = reasoningItems(cfg).find(r => r.id.endsWith('gate'))!
        expect(gate.currentValue).toBe(REASONING_ON_LEVEL)
    })

    test('every offered value is one the config can store', () => {
        for (const row of reasoningItems(draft())) {
            expect(row.values).toEqual([...REASONING_SETTINGS])
            expect(REASONING_SETTINGS).toContain(row.currentValue as never)
        }
    })

    test('the rows appear in the panel', () => {
        const ids = panelItems(draft(), [], []).map(i => i.id)
        expect(ids).toContain('reasoningMode')
        for (const g of REASONING_GROUPS) expect(ids).toContain(`reason:${g}`)
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
        for (const g of REASONING_GROUPS) {
            if (g === 'gate') continue
            expect(resolveReasoning(g, cfg)).toBe('off')
        }
    })

    test('round-trips: what a row shows after a change is what was chosen', () => {
        for (const setting of REASONING_SETTINGS) {
            const cfg = draft({reasoningMode: 'default'})
            applyReasoningLevel(cfg, 'research', setting)
            const row = reasoningItems(cfg).find(r => r.id === 'reason:research')!
            expect(row.currentValue).toBe(setting)
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
     * REGRESSION. The menu showed `reasoning  off` beside seven `think:` rows
     * still reading `inherit`. Under mode `off` every group runs at `off`, so
     * those seven lines were describing a run that could not happen.
     *
     * Cause: `panelItems` snapshots `currentValue` when the panel is built, and
     * the mode row changes what every group row means. Nothing wrote them back.
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
        refreshReasoningRows(cfg, list)

        for (const g of REASONING_GROUPS) {
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
        refreshReasoningRows(cfg, list)

        expect(items.find(i => i.id === 'reasoningMode')!.currentValue).toBe('custom')
        expect(items.find(i => i.id === 'reason:gate')!.currentValue).toBe('medium')
        for (const g of REASONING_GROUPS) {
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
            refreshReasoningRows(cfg, list)
            for (const g of REASONING_GROUPS) {
                const row = items.find(i => i.id === `reason:${g}`)!
                expect(row.currentValue, `${mode}/${g}`).toBe(resolveReasoning(g, cfg))
            }
        }
    })
})

describe('the menu is divided into titled sections', () => {
    const headers = (): string[] =>
        panelItems(draft(), [], [])
            .filter(i => i.id.startsWith(SECTION_ID_PREFIX))
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
        expect(headers().some(h => h.includes('child extensions'))).toBe(false)
        const withExt = panelItems(draft(), [{path: '/x.js', label: 'x', origin: 'user'}], [])
        expect(
            withExt
                .filter(i => i.id.startsWith(SECTION_ID_PREFIX))
                .map(i => i.label)
                .join()
        ).toContain('child extensions')
    })

    test('the reasoning mode and its seven groups are in one section', () => {
        const rows = panelItems(draft(), [], []).map(i => i.id)
        const start = rows.indexOf('reasoningMode')
        const nextHeader = rows.findIndex((id, i) => i > start && id.startsWith(SECTION_ID_PREFIX))
        const block = rows.slice(start, nextHeader)
        for (const g of REASONING_GROUPS) expect(block).toContain(`reason:${g}`)
    })
})
