/**
 * The picker a /task-config row opens on Enter.
 *
 * It exists because `SelectList` alone cannot do this job: its `handleInput`
 * matches four keys and DROPS the rest, so it can never fill its own
 * `setFilter`, and `Container` has no `handleInput` at all. Both of those are
 * pinned below, because both are the kind of thing a later refactor "simplifies"
 * back into a bare SelectList.
 */
import {describe, expect, test} from 'bun:test'
import {OptionPicker} from '../../src/config/option-picker.js'

/** The picker only ever asks the theme to format a string. */
const theme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s
} as unknown as ConstructorParameters<typeof OptionPicker>[2]

const OPTIONS = [
    {value: 'inherit', label: 'inherit'},
    {value: 'acme/small', label: 'acme/small'},
    {value: 'zeta/large', label: 'zeta/large'}
]

const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'

function picker(current = 'inherit'): {p: OptionPicker; picked: (string | undefined)[]} {
    const picked: (string | undefined)[] = []
    const p = new OptionPicker(OPTIONS, current, theme, v => picked.push(v))
    return {p, picked}
}

describe('OptionPicker', () => {
    test('opens on the current value, so Enter alone changes nothing', () => {
        const {p, picked} = picker('zeta/large')
        p.handleInput(ENTER)
        expect(picked).toEqual(['zeta/large'])
    })

    test('a currentValue matching NO option still opens, at the top', () => {
        // The vanished-model case: the row renders a spec the catalog no longer
        // offers, and Enter on it must not throw.
        const {p, picked} = picker('gone/away')
        p.handleInput(ENTER)
        expect(picked).toEqual(['inherit'])
    })

    test('arrows move the selection', () => {
        const {p, picked} = picker('inherit')
        p.handleInput(DOWN)
        p.handleInput(ENTER)
        expect(picked).toEqual(['acme/small'])
    })

    test('escape returns undefined, which the panel writes nowhere', () => {
        const {p, picked} = picker()
        p.handleInput(ESC)
        expect(picked).toEqual([undefined])
    })

    test('TYPING filters — the thing a bare SelectList cannot do', () => {
        // SelectList.handleInput drops every key that is not up/down/enter/esc,
        // so without this component's routing `setFilter` is never called and a
        // 200-model list is arrow-only.
        const {p, picked} = picker()
        for (const ch of 'zeta') p.handleInput(ch)
        p.handleInput(ENTER)
        expect(picked).toEqual(['zeta/large'])
    })

    test('renders without a terminal', () => {
        const {p} = picker()
        expect(p.render(60).length).toBeGreaterThan(0)
    })
})
