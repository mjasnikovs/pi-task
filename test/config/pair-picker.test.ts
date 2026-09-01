/**
 * The two-step picker a step row opens on Enter.
 *
 * It exists because `SelectList` alone cannot do this job: its `handleInput`
 * matches four keys and DROPS the rest, so it can never fill its own
 * `setFilter`, and `Container` has no `handleInput` at all. Both are pinned
 * below, because both are the kind of thing a later refactor "simplifies" back
 * into a bare SelectList.
 *
 * The other half of the job is the coupling: stage two offers only what the
 * model chosen in stage one can honour, and OPENS on the level that will really
 * run. That is what makes a clamp something you watch happen rather than
 * discover afterwards.
 */
import {describe, expect, test} from 'bun:test'
import {PairPicker, type PairOptions} from '../../src/config/option-picker.js'

/** The picker only ever asks the theme to format a string. */
const theme = {
    fg: (_c: string, s: string) => s,
    bold: (s: string) => s
} as unknown as ConstructorParameters<typeof PairPicker>[2]

const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'

/** Two models: `zeta/large` cannot think, so it offers a shorter stage two. */
const OPTIONS: PairOptions = {
    first: [
        {value: 'inherit', label: 'inherit'},
        {value: 'acme/small', label: 'acme/small'},
        {value: 'zeta/large', label: 'zeta/large'}
    ],
    second: spec =>
        spec === 'zeta/large' ?
            {
                options: [
                    {value: 'inherit', label: 'inherit'},
                    {value: 'off', label: 'off'}
                ],
                preselect: 'off'
            }
        :   {
                options: [
                    {value: 'inherit', label: 'inherit'},
                    {value: 'off', label: 'off'},
                    {value: 'medium', label: 'medium'}
                ],
                preselect: 'medium'
            },
    // Level leads, model trails — the real row's shape.
    firstOf: value => value.split(' · ')[1] ?? value,
    join: (model, level) => `${level} · ${model}`
}

function picker(current = 'medium · inherit'): {
    p: PairPicker
    picked: (string | undefined)[]
} {
    const picked: (string | undefined)[] = []
    const p = new PairPicker(OPTIONS, current, theme, v => picked.push(v))
    return {p, picked}
}

describe('PairPicker', () => {
    test('opens on the model the row holds, so Enter Enter changes nothing', () => {
        const {p, picked} = picker('medium · acme/small')
        p.handleInput(ENTER) // accept acme/small
        p.handleInput(ENTER) // accept the level it opened on
        expect(picked).toEqual(['medium · acme/small'])
    })

    test('stage two OPENS on the level that will run, not the one stored', () => {
        // The whole point of the merge. zeta/large cannot do medium, so the
        // cursor is already on `off` and one Enter accepts the clamp.
        const {p, picked} = picker('medium · inherit')
        p.handleInput(DOWN)
        p.handleInput(DOWN) // -> zeta/large
        p.handleInput(ENTER)
        p.handleInput(ENTER)
        expect(picked).toEqual(['off · zeta/large'])
    })

    test('stage two offers only what that model declares', () => {
        // Two options for zeta/large, so two DOWNs wrap back to the first.
        const {p, picked} = picker()
        p.handleInput(DOWN)
        p.handleInput(DOWN)
        p.handleInput(ENTER)
        p.handleInput(DOWN)
        p.handleInput(DOWN)
        p.handleInput(ENTER)
        expect(picked).toEqual(['off · zeta/large'])
    })

    test('a currentValue matching NO option still opens, at the top', () => {
        // The vanished-model case: the row renders a spec the catalog no longer
        // offers, and Enter on it must not throw.
        const {p, picked} = picker('off · gone/away')
        p.handleInput(ENTER)
        p.handleInput(ENTER)
        expect(picked).toEqual(['medium · inherit'])
    })

    test('escape at stage ONE returns undefined', () => {
        const {p, picked} = picker()
        p.handleInput(ESC)
        expect(picked).toEqual([undefined])
    })

    test('escape at stage TWO returns undefined, not a half-answer', () => {
        // A half-answered pair must never reach `done`: the model would be
        // written with a level nobody chose.
        const {p, picked} = picker()
        p.handleInput(DOWN)
        p.handleInput(ENTER)
        p.handleInput(ESC)
        expect(picked).toEqual([undefined])
    })

    test('TYPING filters at BOTH stages — the thing a bare SelectList cannot do', () => {
        // SelectList.handleInput drops every key that is not up/down/enter/esc,
        // so without this component's routing `setFilter` is never called and a
        // 200-model list is arrow-only.
        const {p, picked} = picker()
        for (const ch of 'zeta') p.handleInput(ch)
        p.handleInput(ENTER)
        for (const ch of 'inh') p.handleInput(ch)
        p.handleInput(ENTER)
        expect(picked).toEqual(['inherit · zeta/large'])
    })

    test('renders without a terminal, at both stages', () => {
        const {p} = picker()
        expect(p.render(60).length).toBeGreaterThan(0)
        p.handleInput(ENTER)
        expect(p.render(60).length).toBeGreaterThan(0)
    })
})
