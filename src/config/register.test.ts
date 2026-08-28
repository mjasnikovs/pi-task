import {describe, expect, test} from 'bun:test'
import {getConfig} from './config.js'
import {
    applyExtensionToggle,
    applyToolToggle,
    createSettingsPanel,
    extensionItems,
    panelItems,
    settingsBodyHeight,
    toolItems
} from './register.js'

/** Enough of the host theme for the panel to render into plain strings. */
const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text
} as never

/** Renders the panel with the cursor moved down `steps` rows. */
function renderPanel(steps: number): string[] {
    const panel = createSettingsPanel(
        panelItems(getConfig(), []),
        plainTheme,
        () => {},
        () => {}
    )
    for (let i = 0; i < steps; i++) panel.handleInput('\x1b[B')
    return panel.render(68)
}

describe('extensionItems', () => {
    const installed = [
        {path: '/x/pi-lmstudio/index.ts', label: 'pi-lmstudio', origin: 'npm:pi-lmstudio (user)'},
        {path: '/y/theme.ts', label: 'theme', origin: 'discovered (user)'}
    ]

    test('one on/off toggle per installed extension, current state from the whitelist', () => {
        const cfg = {...getConfig(), extensionWhitelist: ['/x/pi-lmstudio/index.ts']}
        const items = extensionItems(installed)
        expect(items).toHaveLength(2)
        expect(items[0]!.id).toBe('ext:/x/pi-lmstudio/index.ts')
        expect(items[0]!.label).toBe('ext: pi-lmstudio')
        expect(items[0]!.format(cfg)).toBe('on')
        expect(items[1]!.format(cfg)).toBe('off')
        expect(items[0]!.values).toEqual(['on', 'off'])
    })

    test('description carries provenance and the trust caveat', () => {
        const items = extensionItems(installed)
        expect(items[0]!.description).toContain('npm:pi-lmstudio (user)')
        expect(items[0]!.description).toContain('trust')
    })
})

/** The row the cursor is on, stripped of the frame and the cursor itself. */
function selectedRow(steps: number): string {
    const line = renderPanel(steps).find(l => l.includes('❯'))
    return (line ?? '').replace(/^[│\s]*❯\s/, '').trimEnd()
}

describe('the cursor steps over the section decoration', () => {
    test('the menu opens on a setting, not on the first heading', () => {
        // The first row of the list is a header. Left alone, SettingsList opens
        // with the cursor parked on it and no description to show.
        expect(selectedRow(0)).toContain('remote control')
    })

    test('no heading and no blank row is ever the selected row', () => {
        const rows = panelItems(getConfig(), [], []).length
        // Once round the list and a little past, in both directions.
        for (let steps = 0; steps <= rows + 2; steps++) {
            const row = selectedRow(steps)
            // Every real row shows a value; a header and a gap show nothing.
            expect(row, `after ${steps} steps`).toMatch(/(● on|○ off|\S+ +\S)/)
            expect(row.trim(), `after ${steps} steps`).not.toBe('')
            expect(row, `after ${steps} steps`).not.toMatch(/^[A-Z][A-Z ]+$/)
        }
    })

    test('up from the first setting wraps to the last one, not to the frame', () => {
        const panel = createSettingsPanel(
            panelItems(getConfig(), [], []),
            plainTheme,
            () => {},
            () => {}
        )
        panel.handleInput('\x1b[A')
        const line = panel.render(68).find(l => l.includes('❯')) ?? ''
        expect(line).toContain('stuck reply retry')
    })
})

describe('settings panel layout', () => {
    test('the box keeps one height as the selection (and its description) changes', () => {
        const heights = [0, 4, 9, 10, 11].map(steps => renderPanel(steps).length)
        expect(new Set(heights).size).toBe(1)
    })

    test('the selected label sits in the same column as the unselected ones', () => {
        // A one-cell cursor would pull the selected label a column left of
        // every other row.
        const lines = renderPanel(3)
        const selected = lines.find(l => l.includes('verify work'))
        const unselected = lines.find(l => l.includes('project tour'))
        expect(selected).toBeDefined()
        expect(unselected).toBeDefined()
        expect(selected!.indexOf('verify work')).toBe(unselected!.indexOf('project tour'))
    })

    test('the tallest description still fits inside the padded height', () => {
        const descriptions = panelItems(getConfig(), []).map(i => i.description)
        // The body floor must cover the tallest description, or the box grows
        // for that one item and the frame jumps again.
        expect(settingsBodyHeight(descriptions, 9, 60)).toBeGreaterThanOrEqual(
            settingsBodyHeight([descriptions[0]!], 9, 60)
        )
        expect(renderPanel(10).length).toBe(renderPanel(0).length)
    })
})

describe('setting descriptions', () => {
    const descriptions = panelItems(getConfig(), []).map(i => i.description)

    test('no internal shorthand a user has no way to decode', () => {
        for (const d of descriptions) {
            expect(d).not.toMatch(/mx5|E-EXCLUSIVE|pipeline’s digest|VERIFY block/i)
        }
    })
})

describe('toolItems', () => {
    const tools = [
        {name: 'bash', origin: 'built in'},
        {name: 'fable_loop', origin: 'discovered (/x/fable/index.js)'}
    ]

    test('one toggle per live tool; ON is guarded, and the config stores the exemptions', () => {
        const cfg = {...getConfig(), commandTimeoutExemptTools: ['fable_loop']}
        const items = toolItems(tools)
        expect(items).toHaveLength(2)
        expect(items[0]!.id).toBe('tool:bash')
        expect(items[0]!.label).toBe('watch: bash')
        expect(items[0]!.format(cfg)).toBe('on')
        expect(items[1]!.format(cfg)).toBe('off')
    })

    test('an empty exemption list guards everything — the default cannot unguard bash', () => {
        const cfg = {...getConfig(), commandTimeoutExemptTools: []}
        expect(toolItems(tools).map(i => i.format(cfg))).toEqual(['on', 'on'])
    })

    test('description names the owner and states what turning it off costs', () => {
        const items = toolItems(tools)
        expect(items[1]!.description).toContain('/x/fable/index.js')
        expect(items[1]!.description).toContain('never be caught')
    })

    test('rows join the menu, and a config with no live tools adds none', () => {
        const ids = panelItems(getConfig(), [], tools).map(i => i.id)
        expect(ids).toContain('tool:bash')
        expect(panelItems(getConfig(), []).some(i => i.id.startsWith('tool:'))).toBe(false)
    })
})

describe('applyToolToggle', () => {
    test('off exempts once, on re-guards; both idempotent', () => {
        let ex: string[] = []
        ex = applyToolToggle(ex, 'fable_loop', false)
        ex = applyToolToggle(ex, 'fable_loop', false)
        expect(ex).toEqual(['fable_loop'])
        ex = applyToolToggle(ex, 'fable_loop', true)
        ex = applyToolToggle(ex, 'fable_loop', true)
        expect(ex).toEqual([])
    })

    test('toggling one tool leaves the others exempt', () => {
        expect(applyToolToggle(['a', 'b'], 'a', true)).toEqual(['b'])
    })
})

describe('applyExtensionToggle', () => {
    test('on adds once, off removes; both idempotent', () => {
        let wl: string[] = []
        wl = applyExtensionToggle(wl, '/a.ts', true)
        wl = applyExtensionToggle(wl, '/a.ts', true)
        expect(wl).toEqual(['/a.ts'])
        wl = applyExtensionToggle(wl, '/a.ts', false)
        wl = applyExtensionToggle(wl, '/a.ts', false)
        expect(wl).toEqual([])
    })

    test('toggling one entry leaves the others alone', () => {
        const wl = applyExtensionToggle(['/a.ts', '/b.ts'], '/a.ts', false)
        expect(wl).toEqual(['/b.ts'])
    })
})
