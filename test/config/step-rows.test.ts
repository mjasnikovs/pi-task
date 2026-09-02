/**
 * The eleven step rows in /task-config — one per child group, carrying BOTH the
 * model that step runs on and the thinking level it runs at.
 *
 * They were two parallel blocks of eleven, and the coupling between them was
 * invisible: choosing a model re-clamps that step's level, but the row that
 * moved was eleven rows away from the row you touched. Everything about the
 * merged shape is pinned here — the composite value, its round trip, and the
 * two-stage picker that makes the clamp something you watch happen.
 *
 * The thinking half is the EFFECTIVE level, not the stored custom table, so in
 * `default` / `on` / `off` the menu shows what each step really runs at rather
 * than a table nothing is reading.
 */
import {describe, expect, test} from 'bun:test'
import {SettingsList} from '@earendil-works/pi-tui'
import type {SettingsListTheme} from '@earendil-works/pi-tui'
import {
    applyReasoningLevel,
    applyStepValue,
    configRows,
    createSettingsPanel,
    formatStepValue,
    panelItems,
    parseStepValue,
    renderRows,
    stepItems,
    stepRowLabel,
    syncRows,
    SECTION_ID_PREFIX,
    type ModelCatalog
} from '../../src/config/register.js'
import {MODEL_INHERIT} from '../../src/config/group-models.js'
import {
    clampToModel,
    effectiveSetting,
    offeredLevels
} from '../../src/shared/reasoning-capability.js'

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
    groupModels: {...DEFAULT_CONFIG.groupModels},
    ...over
})

/** What a row shows for a group under a given config. */
const shown = (group: (typeof CHILD_GROUPS)[number], cfg: PiTaskConfig): string =>
    formatStepValue(cfg.groupModels[group], resolveReasoning(group, cfg))

const NON_REASONING = {reasoning: false}
const FULL = {reasoning: true}
/** Declares xhigh, which this menu excludes on purpose. */
const DECLARES_XHIGH = {reasoning: true, thinkingLevelMap: {xhigh: 'xhigh'}}

const cat = (facts: ModelCatalog['facts'], specs = ['acme/small']): ModelCatalog => ({specs, facts})

/** Two models: one that cannot reason at all, one that can do everything. */
const TWO: ModelCatalog = {
    specs: ['acme/small', 'acme/big'],
    facts: spec =>
        spec === 'acme/small' ? NON_REASONING
        : spec === 'acme/big' ? FULL
        : undefined
}

// No beforeEach/afterEach save-and-restore of the live config singleton: every
// function under test takes its config as an argument, so `draft()` above is the
// only state any of these tests has. Mutating the singleton and putting it back
// still leaves the suite's result depending on what it was to begin with.

describe('stepRowLabel', () => {
    /**
     * The four research workers are the only rows in the whole menu whose
     * parent is also a row. Rendered flat they read as four more peers of
     * `research`, which is what this shape exists to stop.
     */
    test('children are branches under their parent, last one cornered', () => {
        expect(stepRowLabel('research')).toBe('research')
        expect(stepRowLabel('research:files')).toBe('   \u251c\u2500 files')
        expect(stepRowLabel('research:apis')).toBe('   \u251c\u2500 apis')
        expect(stepRowLabel('research:context')).toBe('   \u251c\u2500 context')
        expect(stepRowLabel('research:tooling')).toBe('   \u2514\u2500 tooling')
    })

    test('the corner is derived, not hand-kept', () => {
        // Exactly one child per parent may carry the corner, and it must be the
        // LAST one listed. A fifth worker appended to CHILD_GROUPS moves it
        // without anyone editing this file.
        const corners = CHILD_GROUPS.filter(g => stepRowLabel(g).includes('\u2514'))
        const children = CHILD_GROUPS.filter(g => g.includes(':'))
        expect(corners).toHaveLength(new Set(children.map(g => g.split(':')[0])).size)
        expect(corners.at(-1)).toBe(children.at(-1))
    })

    test('a parentless group is its own bare name', () => {
        // It carried a `think: ` prefix while there were two families to tell
        // apart. With one row per step there is nothing to disambiguate, and the
        // prefix was the widest thing in the column.
        for (const group of CHILD_GROUPS.filter(g => !g.includes(':'))) {
            expect(stepRowLabel(group)).toBe(group)
        }
    })
})

describe('stepItems', () => {
    test('the headless one-liner names the group in full', () => {
        // `|`-joined on one line, a branch glyph names no parent. The panel
        // label and the headless label are allowed to differ; only the panel
        // has a row above to hang the branch from.
        for (const row of stepItems()) {
            expect(row.headlessLabel).toBe(`step: ${row.id.slice('step:'.length)}`)
        }
    })

    test('one row per group, in every mode', () => {
        for (const mode of ['default', 'on', 'off', 'custom'] as const) {
            const cfg = draft({reasoningMode: mode})
            const rows = stepItems()
            expect(rows).toHaveLength(CHILD_GROUPS.length)
            for (const [i, row] of rows.entries()) {
                expect(row.format(cfg)).toBe(shown(CHILD_GROUPS[i]!, cfg))
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
        const gate = stepItems().find(r => r.id.endsWith('gate'))!
        expect(gate.format(cfg)).toBe(formatStepValue(MODEL_INHERIT, REASONING_ON_LEVEL))
    })

    test('the row shows BOTH halves, always', () => {
        // One shape per row, so the value column scans and a single word never
        // has to be guessed at. A doubly-inherited step still prints both.
        const cfg = draft()
        const plan = stepItems().find(r => r.id === 'step:plan')!
        expect(plan.format(cfg)).toBe('inherit · inherit')
        const research = stepItems().find(r => r.id === 'step:research')!
        expect(research.format(cfg)).toBe('medium · inherit')
    })

    test('the model half is VERBATIM even when the catalog no longer offers it', () => {
        // The two-machine case. The row is the only place the user can see what
        // their config actually holds, so it must not quietly show `inherit`.
        const cfg = draft({
            groupModels: {...DEFAULT_CONFIG.groupModels, gate: 'gone/away'}
        })
        const gate = stepItems(TWO).find(r => r.id === 'step:gate')!
        expect(gate.format(cfg)).toBe('off · gone/away')
        expect(gate.values).not.toContain('off · gone/away')
    })

    test('values is the LEGAL cross product, and nothing renders it', () => {
        // Only the round-trip property reads `values`; the picker offers two
        // short lists. Building it from `offeredLevels` rather than the full
        // ladder is what makes that property true — a pair the model cannot
        // honour would be clamped by `apply` and would not round-trip.
        const gate = stepItems(TWO).find(r => r.id === 'step:gate')!
        expect(gate.values).toEqual([
            ...offeredLevels(undefined).map(l => formatStepValue(MODEL_INHERIT, l)),
            ...offeredLevels(NON_REASONING).map(l => formatStepValue('acme/small', l)),
            ...offeredLevels(FULL).map(l => formatStepValue('acme/big', l))
        ])
        // acme/small does not reason, so it contributes exactly two pairs.
        expect(gate.values!.filter(v => v.endsWith('acme/small'))).toEqual([
            'inherit · acme/small',
            'off · acme/small'
        ])
    })

    test('with NO models discovered the row is still a real row', () => {
        // Six entries, not zero: a row with no values would read as a section
        // header to two of the three consumers that ask that question.
        const gate = stepItems().find(r => r.id === 'step:gate')!
        expect(gate.values).toHaveLength(REASONING_SETTINGS.length)
        expect(gate.picker).toBeDefined()
    })

    test('the rows appear in the panel', () => {
        const ids = panelItems(draft(), [], []).map(i => i.id)
        expect(ids).toContain('reasoningMode')
        for (const g of CHILD_GROUPS) expect(ids).toContain(`step:${g}`)
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
            const row = stepItems().find(r => r.id === 'step:research')!
            expect(row.format(cfg)).toBe(formatStepValue(MODEL_INHERIT, setting))
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
     * `reasoning  off` beside eleven step rows still reading `inherit` is
     * describing a run that cannot happen.
     *
     * The mechanism: `panelItems` builds each row's `currentValue` from
     * `i.format(cfg)` once, when the panel is built. Only `syncRows` re-asks every
     * row afterwards and writes the answers back.
     */
    test('flipping the mode row updates every step row', () => {
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
            const row = items.find(i => i.id === `step:${g}`)!
            expect(row.currentValue, g).toBe(shown(g, cfg))
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
        expect(items.find(i => i.id === 'step:gate')!.currentValue).toBe('medium · inherit')
        for (const g of CHILD_GROUPS) {
            if (g === 'gate') continue
            expect(items.find(i => i.id === `step:${g}`)!.currentValue, g).toBe('off · inherit')
        }
    })

    test('no step row can ever show a level the run will not use', () => {
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
                const row = items.find(i => i.id === `step:${g}`)!
                expect(row.currentValue, `${mode}/${g}`).toBe(shown(g, cfg))
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

    test('the profile row sits in its OWN section, above the steps', () => {
        // It is a GLOBAL override, and under the steps heading it read as a
        // twelfth step called `reasoning`. Its own heading is what says so.
        const rows = panelItems(draft(), [], []).map(i => i.id)
        const mode = rows.indexOf('reasoningMode')
        const firstStep = rows.findIndex(id => id.startsWith('step:'))
        expect(mode).toBeGreaterThan(-1)
        expect(firstStep).toBeGreaterThan(mode)
        // A blank row and a HEADING sit between them, so they read as two
        // blocks. `sectionGap` carries the same prefix, so the heading is the
        // one that is not a gap.
        const between = rows.slice(mode + 1, firstStep)
        const headings = between.filter(
            id => id.startsWith(SECTION_ID_PREFIX) && !id.startsWith(`${SECTION_ID_PREFIX}gap:`)
        )
        expect(headings).toHaveLength(1)
    })

    test('the eleven steps are one contiguous block', () => {
        const rows = panelItems(draft(), [], []).map(i => i.id)
        const first = rows.findIndex(id => id.startsWith('step:'))
        const block = rows.slice(first, first + CHILD_GROUPS.length)
        for (const g of CHILD_GROUPS) expect(block).toContain(`step:${g}`)
    })
})

// ─── narrowing, and the re-clamp that has to come with it ────────────────────

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

    test('stage two is built at ENTER-time, from the LIVE draft', () => {
        // `values` is static and computed once. The narrowing depends on a cell
        // the user changes while the panel is open, so a snapshot would offer
        // levels the chosen model erases.
        const row = stepItems(TWO).find(i => i.id === 'step:gate')!
        const cfg = draft()
        expect(
            row.picker!(cfg)
                .second('acme/big')
                .options.map(o => o.value)
        ).toEqual([...REASONING_SETTINGS])
        expect(
            row.picker!(cfg)
                .second('acme/small')
                .options.map(o => o.value)
        ).toEqual(['inherit', 'off'])
    })

    test('stage one opens on the model the row currently holds', () => {
        const row = stepItems(TWO).find(i => i.id === 'step:gate')!
        const p = row.picker!(draft())
        expect(p.first.map(o => o.value)).toEqual([MODEL_INHERIT, 'acme/small', 'acme/big'])
        expect(p.firstOf('medium · acme/big')).toBe('acme/big')
        // A stored spec the catalog no longer offers still opens the picker.
        expect(p.firstOf('off · gone/away')).toBe('gone/away')
    })

    test('stage two OPENS on the level that will actually run, and says why', () => {
        // This is the coupling made visible. The shipped table runs `planning`
        // at medium; acme/small cannot, so the cursor is already on `off` and
        // the reason is beside it.
        const row = stepItems(TWO).find(i => i.id === 'step:planning')!
        const cfg = draft()
        expect(resolveReasoning('planning', cfg)).toBe('medium')
        const stage = row.picker!(cfg).second('acme/small')
        expect(stage.preselect).toBe('off')
        expect(stage.options.find(o => o.value === 'off')?.description).toBe(
            'acme/small cannot do medium'
        )
    })

    test('a model that CAN honour the level opens on it, with no explanation', () => {
        const row = stepItems(TWO).find(i => i.id === 'step:planning')!
        const stage = row.picker!(draft()).second('acme/big')
        expect(stage.preselect).toBe('medium')
        expect(stage.options.find(o => o.value === 'medium')?.description).toBeUndefined()
    })
})

describe('the composite value round-trips', () => {
    test('format and parse are inverse over the whole cross product', () => {
        const row = stepItems(TWO).find(i => i.id === 'step:gate')!
        for (const value of row.values!) {
            const pair = parseStepValue(value)!
            expect(formatStepValue(pair.spec, pair.level)).toBe(value)
        }
    })

    test('splitting takes the FIRST separator, so a model id may hold one', () => {
        // The level LEADS and is a closed set; a `provider/id` conceivably holds
        // a separator of its own. Splitting on the last would hand the model
        // half a level.
        expect(parseStepValue('medium · a/b · c')).toEqual({
            spec: 'a/b · c',
            level: 'medium'
        })
    })

    test('anything not of that shape parses to nothing', () => {
        expect(parseStepValue('acme/big')).toBeUndefined()
        expect(parseStepValue('acme/big · nonsense')).toBeUndefined()
        expect(parseStepValue('· medium')).toBeUndefined()
        expect(parseStepValue('')).toBeUndefined()
    })
})

describe('applyStepValue writes BOTH halves, or neither', () => {
    test('a legal pair writes the model and the level together', () => {
        // Atomically, because the round-trip property starts from a FRESH config
        // every iteration: writing one half would leave the other at its default.
        const cfg = draft()
        applyStepValue(cfg, 'gate', 'high · acme/big', TWO)
        expect(cfg.groupModels.gate).toBe('acme/big')
        expect(resolveReasoning('gate', cfg)).toBe('high')
    })

    test('a level the new model cannot honour is CLAMPED, not frozen', () => {
        // Narrowing the picker alone would freeze a lie into a cell it has just
        // made unconfigurable. The picker never offers this pair, but `values`
        // is built when the panel opens and a registry can move underneath it.
        const cfg = draft({reasoningMode: 'custom'})
        cfg.reasoningLevels = {...cfg.reasoningLevels, gate: 'high'}
        applyStepValue(cfg, 'gate', 'high · acme/small', TWO)
        expect(cfg.groupModels.gate).toBe('acme/small')
        expect(resolveReasoning('gate', cfg)).toBe('off')
    })

    test('the clamp fires in mode `on`, where the STORED cell says nothing', () => {
        // resolveReasoning is the only place the four modes are read; in `on`
        // every group runs at medium whatever the table holds. Comparing the
        // stored cell would see no clamp and stay silent about a real lie.
        const cfg = draft({reasoningMode: 'on'})
        expect(resolveReasoning('gate', cfg)).toBe(REASONING_ON_LEVEL)
        applyStepValue(cfg, 'gate', 'medium · acme/small', TWO)
        expect(resolveReasoning('gate', cfg)).toBe('off')
    })

    test('a pair the config ALREADY runs does not flip the mode to custom', () => {
        // applyReasoningLevel freezes the whole table on the way to custom, so
        // re-picking what is already in force must not do that as a side effect.
        const cfg = draft({reasoningMode: 'default'})
        applyStepValue(cfg, 'gate', formatStepValue('acme/big', 'off'), TWO)
        expect(cfg.groupModels.gate).toBe('acme/big')
        expect(cfg.reasoningMode).toBe('default')
    })

    test('REFUSES a model the catalog does not offer', () => {
        // The panel may only ever write what the picker showed. A spec naming a
        // vanished model reaches the config through the loader, not through here.
        const cfg = draft()
        applyStepValue(cfg, 'gate', 'off · acme/never-offered', TWO)
        expect(cfg.groupModels.gate).toBe(MODEL_INHERIT)
    })

    test('a mis-shaped value writes NEITHER half', () => {
        const cfg = draft({reasoningMode: 'custom'})
        cfg.reasoningLevels = {...cfg.reasoningLevels, gate: 'high'}
        for (const bad of ['', 'acme/big', 'acme/big · nonsense', 'off · --tools']) {
            applyStepValue(cfg, 'gate', bad, TWO)
            expect(cfg.groupModels.gate).toBe(MODEL_INHERIT)
            expect(resolveReasoning('gate', cfg)).toBe('high')
        }
    })

    test('`inherit` on either half is always writable', () => {
        const cfg = draft()
        applyStepValue(cfg, 'gate', formatStepValue(MODEL_INHERIT, 'high'), TWO)
        expect(cfg.groupModels.gate).toBe(MODEL_INHERIT)
        expect(resolveReasoning('gate', cfg)).toBe('high')
    })
})

describe('a picker suspends the inert-row walk', () => {
    test('one arrow press inside a picker reaches it exactly once', () => {
        // SkipInertRows replays the key ONCE PER ROW IT SKIPS, and SettingsList
        // forwards everything to an open submenu. So the row that proves this
        // has to be the LAST of its section: after `step: implementation` come a
        // gap and the UNATTENDED header, so one press would arrive THREE times
        // and pick the wrong model. A row with a selectable neighbour cannot
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
        const steps = selectable.findIndex(i => i.id === 'step:implementation')
        for (let i = 0; i < steps; i++) panel.handleInput('\x1b[B')
        panel.handleInput('\r') // open stage one, on `inherit`
        panel.handleInput('\x1b[B') // one press: `inherit` -> acme/a
        panel.handleInput('\r') // choose the model, open stage two
        panel.handleInput('\r') // accept the level it opened on
        // Stage one option 0 is `inherit`; one press lands on option 1. Three
        // presses land on `acme/c`, which is what an unsuspended walk produces.
        // Stage two opened on `off`, which is what the shipped table runs.
        expect(written).toEqual([['step:implementation', 'off · acme/a']])
    })

    test('escape at stage TWO writes nothing at all', () => {
        // A half-answered pair must never reach `done`. Escape cancels the whole
        // interaction, model included.
        const catalog = cat(() => FULL, ['acme/a', 'acme/b'])
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
        const steps = selectable.findIndex(i => i.id === 'step:implementation')
        for (let i = 0; i < steps; i++) panel.handleInput('\x1b[B')
        panel.handleInput('\r')
        panel.handleInput('\x1b[B')
        panel.handleInput('\r') // now in stage two
        panel.handleInput('\x1b') // escape
        expect(written).toEqual([])
    })
})

describe('a picker row is not a header', () => {
    test('headless mode prints it as a setting, not as `[label]`', () => {
        // The third consumer of the old `values === undefined` test, and the one
        // with no visual feedback: getting it wrong prints a step row as a
        // section heading on a `|`-joined line and nobody notices.
        const lines = panelItems(draft(), [], [], TWO)
            .filter(i => i.label !== '')
            .map(i =>
                i.id.startsWith(SECTION_ID_PREFIX) ?
                    `[${i.label.trim()}]`
                :   (i.headlessLabel ?? i.label)
            )
        expect(lines).toContain('[STEPS]')
        expect(lines).toContain('step: gate')
        expect(lines.some(l => l === '[step: gate]')).toBe(false)
        // The `models` block is gone, not renamed.
        expect(lines.some(l => l.startsWith('[MODELS'))).toBe(false)
    })

    test('the tree branches are named in full on the headless line', () => {
        // `   ├─ files` names no parent on a `|`-joined line. `headlessLabel` is
        // what keeps it meaningful there.
        const lines = panelItems(draft(), [], [], TWO).map(i => i.headlessLabel ?? i.label)
        expect(lines).toContain('step: research:files')
    })

    test('every step row is reachable by a SkipInertRows walk', () => {
        // A row the walk steps over is a row the user cannot reach at all.
        const items = renderRows(draft(), configRows([], [], TWO))
        const selectable = items.filter(
            i =>
                !i.id.startsWith(SECTION_ID_PREFIX)
                && ((i.values?.length ?? 0) > 0 || i.pickerOptions !== undefined)
        )
        expect(selectable.filter(i => i.id.startsWith('step:'))).toHaveLength(CHILD_GROUPS.length)
    })
})

describe('the draft the panel mutates', () => {
    test('renderRows closes over the LIVE draft, so a picker sees the current cell', () => {
        // The picker factory runs at Enter-time and must see a model chosen
        // since the panel opened. A snapshot here would offer stale levels.
        const cfg = draft()
        const items = renderRows(cfg, configRows([], [], TWO))
        const row = items.find(i => i.id === 'step:gate')!
        cfg.groupModels = {...cfg.groupModels, gate: 'acme/small'}
        expect(
            row.pickerOptions!()
                .second('acme/small')
                .options.map(o => o.value)
        ).toEqual(['inherit', 'off'])
    })
})

describe('a model the catalog cannot offer survives being opened', () => {
    /**
     * THE REGRESSION THE MERGE INTRODUCED. With two rows you could nudge the
     * level without touching the model. With one row you cannot, so opening a
     * step just to change its level used to rewrite the model to `inherit` —
     * `FilterList` falls back to index 0 when the preselect matches nothing.
     *
     * That would erase a spec set on the user's other machine, which the loader,
     * `format` and the startup hint all go out of their way to preserve.
     */
    const heldElsewhere = (): PiTaskConfig =>
        draft({groupModels: {...DEFAULT_CONFIG.groupModels, gate: 'gone/away'}})

    test('stage one keeps it, at the head, marked', () => {
        const cfg = heldElsewhere()
        const p = stepItems(TWO).find(i => i.id === 'step:gate')!.picker!(cfg)
        expect(p.first[0]!.value).toBe('gone/away')
        expect(p.first[0]!.description).toMatch(/not available/i)
        expect(p.firstOf(shown('gate', cfg))).toBe('gone/away')
    })

    test('it is NOT offered when the catalog does have it', () => {
        const cfg = draft({groupModels: {...DEFAULT_CONFIG.groupModels, gate: 'acme/big'}})
        const p = stepItems(TWO).find(i => i.id === 'step:gate')!.picker!(cfg)
        expect(p.first.filter(o => o.value === 'acme/big')).toHaveLength(1)
        expect(p.first[0]!.value).toBe(MODEL_INHERIT)
    })

    test('applyStepValue accepts the spec the cell ALREADY holds', () => {
        const cfg = heldElsewhere()
        applyStepValue(cfg, 'gate', formatStepValue('gone/away', 'medium'), TWO)
        expect(cfg.groupModels.gate).toBe('gone/away')
        expect(resolveReasoning('gate', cfg)).toBe('medium')
    })

    test('but still refuses a DIFFERENT spec the catalog does not offer', () => {
        const cfg = heldElsewhere()
        applyStepValue(cfg, 'gate', formatStepValue('other/ghost', 'medium'), TWO)
        expect(cfg.groupModels.gate).toBe('gone/away')
    })

    test('end to end: changing only the level keeps the model', () => {
        // Driven through the real panel, because the bug lived in the wiring
        // between the row, the picker and the write — not in any one of them.
        const cfg = heldElsewhere()
        const written: Array<[string, string]> = []
        const items = renderRows(cfg, configRows([], [], TWO))
        const panel = createSettingsPanel(
            items,
            {fg: (_c: string, t: string) => t, bold: (t: string) => t} as never,
            (id, value) => written.push([id, value]),
            () => {}
        )
        const selectable = items.filter(i => !i.id.startsWith(SECTION_ID_PREFIX))
        const steps = selectable.findIndex(i => i.id === 'step:gate')
        for (let i = 0; i < steps; i++) panel.handleInput('\x1b[B')
        panel.handleInput('\r') // stage one, opening on `gone/away`
        panel.handleInput('\r') // keep it
        panel.handleInput('\x1b[B') // move the LEVEL only
        panel.handleInput('\r')
        // The LEVEL moved, which is what was asked for. The MODEL did not.
        expect(written).toEqual([['step:gate', formatStepValue('gone/away', 'minimal')]])
    })
})

describe('the clamp stays inside the menu vocabulary', () => {
    test('a model whose clamp lands on xhigh still opens on an OFFERED level', () => {
        // `clampToModel` walks UP and knows the whole ladder, so `high` on a
        // model declaring `{high: null, xhigh: 'x'}` clamps to `xhigh` — which
        // `offeredLevels` excludes on purpose. Stage two would then open on
        // `inherit`, a materially different setting, with the explanation
        // attached to no row at all.
        const odd = {reasoning: true, thinkingLevelMap: {high: null, xhigh: 'x'}}
        const catalog: ModelCatalog = {specs: ['acme/odd'], facts: () => odd}
        const cfg = draft({reasoningMode: 'custom'})
        cfg.reasoningLevels = {...cfg.reasoningLevels, gate: 'high'}
        const stage = stepItems(catalog).find(i => i.id === 'step:gate')!.picker!(cfg).second(
            'acme/odd'
        )
        // The raw clamp escapes the menu; the preselect must not.
        expect(clampToModel(odd, 'high')).toBe('xhigh')
        expect(offeredLevels(odd)).not.toContain('xhigh' as never)
        expect(stage.options.map(o => o.value)).toContain(stage.preselect)
        expect(stage.preselect).toBe('medium')
        // And the reason is on the row the cursor is actually on.
        expect(stage.options.find(o => o.value === stage.preselect)?.description).toBe(
            'acme/odd cannot do high'
        )
    })

    test('the WRITER stores exactly what the picker preselects', () => {
        // The two used to be separate copies of the clamp, and only the picker
        // re-projected into the menu. On a model whose clamp lands on `xhigh`
        // the picker showed `medium` while the writer stored `xhigh` — a value
        // no row can render.
        const odd = {reasoning: true, thinkingLevelMap: {high: null, xhigh: 'x'}}
        const catalog: ModelCatalog = {specs: ['acme/odd'], facts: () => odd}
        const cfg = draft({reasoningMode: 'custom'})
        cfg.reasoningLevels = {...cfg.reasoningLevels, gate: 'high'}
        const stage = stepItems(catalog).find(i => i.id === 'step:gate')!.picker!(cfg).second(
            'acme/odd'
        )
        applyStepValue(cfg, 'gate', formatStepValue('acme/odd', 'high'), catalog)
        expect(stage.preselect).toBe(resolveReasoning('gate', cfg))
        expect(REASONING_SETTINGS.includes(resolveReasoning('gate', cfg))).toBe(true)
    })

    test('effectiveSetting: inherit and an unknown model pass through', () => {
        expect(effectiveSetting(undefined, 'high')).toBe('high')
        expect(effectiveSetting(NON_REASONING, 'inherit')).toBe('inherit')
        expect(effectiveSetting(NON_REASONING, 'high')).toBe('off')
    })
})
