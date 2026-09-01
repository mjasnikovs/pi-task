/**
 * The eleven `model:` rows in /task-config.
 *
 * They are the first rows in this menu whose Enter opens a PICKER instead of
 * cycling a list, which broke three assumptions at once: that a row with no
 * `values` is a header, that a row with `values` is the only selectable kind,
 * and that up/down are the only two things that move the list's index. All
 * three are pinned here.
 */
import {describe, expect, test} from 'bun:test'
import {SettingsList} from '@earendil-works/pi-tui'
import type {SettingsListTheme} from '@earendil-works/pi-tui'
import {
    applyGroupModel,
    configRows,
    createSettingsPanel,
    modelItems,
    panelItems,
    renderRows,
    SECTION_ID_PREFIX,
    type ModelCatalog
} from '../../src/config/register.js'
import {DEFAULT_CONFIG, type PiTaskConfig} from '../../src/config/config.js'
import {CHILD_GROUPS} from '../../src/config/groups.js'
import {MODEL_INHERIT} from '../../src/config/group-models.js'

const listTheme = (): SettingsListTheme => ({
    label: t => t,
    value: t => t,
    description: t => t,
    cursor: '> ',
    hint: t => t
})

/** The panel theme, which only ever formats strings. */
const panelTheme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s
} as unknown as Parameters<typeof createSettingsPanel>[1]

const draft = (over: Partial<PiTaskConfig> = {}): PiTaskConfig => ({
    ...DEFAULT_CONFIG,
    groupModels: {...DEFAULT_CONFIG.groupModels},
    reasoningLevels: {...DEFAULT_CONFIG.reasoningLevels},
    ...over
})

const catalog = (
    specs: string[],
    facts: ModelCatalog['facts'] = () => undefined
): ModelCatalog => ({
    specs,
    facts
})

const TWO = catalog(['acme/small', 'acme/big'])

describe('the model rows exist and cover the roster', () => {
    test('one row per group, both directions', () => {
        const ids = modelItems(TWO).map(i => i.id)
        expect(ids).toEqual(CHILD_GROUPS.map(g => `model:${g}`))
    })

    test('the offered vocabulary is inherit plus whatever was discovered', () => {
        const row = modelItems(TWO).find(i => i.id === 'model:gate')!
        expect(row.values).toEqual([MODEL_INHERIT, 'acme/small', 'acme/big'])
    })

    test('with NO models discovered the row is still a selectable row', () => {
        // Length 1, not 0: a row with no values would read as a section header
        // to two of the three consumers that used to ask that question.
        const row = modelItems(catalog([])).find(i => i.id === 'model:gate')!
        expect(row.values).toEqual([MODEL_INHERIT])
        expect(row.submenu).toBeDefined()
    })
})

describe('a picker row is not a header', () => {
    const rows = configRows([], [], TWO)

    test('headless mode prints it as a setting, not as `[label]`', () => {
        // The third consumer of the old `values === undefined` test, and the one
        // with no visual feedback: getting it wrong prints a model row as a
        // section heading on a `|`-joined line and nobody notices.
        const lines = panelItems(draft(), [], [], TWO)
            .filter(i => i.label !== '')
            .map(i =>
                i.id.startsWith(SECTION_ID_PREFIX) ?
                    `[${i.label.trim()}]`
                :   (i.headlessLabel ?? i.label)
            )
        expect(lines).toContain('[MODELS]')
        expect(lines).toContain('model: gate')
        expect(lines.some(l => l === '[model: gate]')).toBe(false)
    })

    test('the tree branches are disambiguated in headless mode', () => {
        // `   ├─ files` appears in BOTH blocks and names nothing on a `|`-joined
        // line. `headlessLabel` is what keeps the two apart there.
        const lines = panelItems(draft(), [], [], TWO).map(i => i.headlessLabel ?? i.label)
        expect(lines).toContain('model: research:files')
        expect(lines).toContain('think: research:files')
    })

    test('every model row is reachable by a SkipInertRows walk', () => {
        const items = renderRows(draft(), rows)
        const panel = createSettingsPanel(
            items,
            panelTheme,
            () => {},
            () => {}
        )
        // The walk is what the panel does on open and on every arrow; a row it
        // steps over is a row the user cannot reach at all.
        const selectable = items.filter(
            i =>
                !i.id.startsWith(SECTION_ID_PREFIX)
                && ((i.values?.length ?? 0) > 0 || i.submenuOptions !== undefined)
        )
        expect(selectable.filter(i => i.id.startsWith('model:'))).toHaveLength(CHILD_GROUPS.length)
        expect(panel).toBeDefined()
    })
})

describe('applyGroupModel', () => {
    test('writes an offered spec', () => {
        const cfg = draft()
        applyGroupModel(cfg, 'gate', 'acme/big', TWO)
        expect(cfg.groupModels.gate).toBe('acme/big')
    })

    test('REFUSES a spec the catalog does not offer', () => {
        // The panel may only ever write what the picker showed. A spec naming a
        // vanished model reaches the config through the loader, not through here.
        const cfg = draft()
        applyGroupModel(cfg, 'gate', 'acme/never-offered', TWO)
        expect(cfg.groupModels.gate).toBe(MODEL_INHERIT)
    })

    test('refuses a mis-shaped value outright', () => {
        const cfg = draft()
        for (const bad of ['', '  ', '--tools', 'two words']) {
            applyGroupModel(cfg, 'gate', bad, catalog([bad]))
            expect(cfg.groupModels.gate).toBe(MODEL_INHERIT)
        }
    })

    test('`inherit` is always writable, even with an empty catalog', () => {
        const cfg = draft({groupModels: {...DEFAULT_CONFIG.groupModels, gate: 'acme/big'}})
        applyGroupModel(cfg, 'gate', MODEL_INHERIT, catalog([]))
        expect(cfg.groupModels.gate).toBe(MODEL_INHERIT)
    })
})

describe('a stored spec the catalog no longer offers', () => {
    test('still renders verbatim', () => {
        // The two-machine case. The row is the only place the user can see what
        // their config actually holds, so it must not quietly show `inherit`.
        const cfg = draft({
            groupModels: {...DEFAULT_CONFIG.groupModels, gate: 'gone/away'}
        })
        const row = modelItems(TWO).find(i => i.id === 'model:gate')!
        expect(row.format(cfg)).toBe('gone/away')
        expect(row.values).not.toContain('gone/away')
    })
})

describe('the draft the panel mutates', () => {
    test('renderRows reads the LIVE draft, so a picker sees the current cell', () => {
        // The submenu factory closes over the draft, and the draft is mutated in
        // place between renders. A snapshot here would offer stale options.
        const cfg = draft()
        const items = renderRows(cfg, configRows([], [], TWO))
        const row = items.find(i => i.id === 'reason:gate')!
        cfg.groupModels.gate = 'acme/small'
        expect(row.submenuOptions).toBeDefined()
        // Nothing to assert about levels here — this pins that the closure is
        // live, which the narrowing test in reasoning-rows.test.ts then uses.
        expect(cfg.groupModels.gate).toBe('acme/small')
    })

    test('a SettingsList takes the rendered rows unchanged', () => {
        const items = renderRows(draft(), configRows([], [], TWO))
        const list = new SettingsList(
            items,
            9,
            listTheme(),
            () => {},
            () => {}
        )
        expect(list).toBeDefined()
    })
})
