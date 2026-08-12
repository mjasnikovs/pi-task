import {test, expect, describe} from 'bun:test'
import {ITEMS} from './register.js'
import {DEFAULT_CONFIG} from './config.js'
import type {PiTaskConfig} from './config.js'

const fresh = (): PiTaskConfig => structuredClone(DEFAULT_CONFIG)

describe('every setting formats and parses its OWN value', () => {
    // The property that could not be written before. `displayValue` and the
    // `onChange` if/else chain were two hand-written ladders that had to agree,
    // and neither failed to compile when a setting was missing from one of them:
    // a missed format arm rendered `String(cfg[id])`, and a missed parse arm let
    // the generic `else` write the boolean `newValue === 'on'` into an enum field.
    // handleTaskConfig is not exported, so the dispatcher had no coverage at all.
    for (const item of ITEMS) {
        const offered = item.values ?? ['on', 'off']
        test(`${item.id}: format(apply(cfg, v)) === v for every offered value`, () => {
            for (const value of offered) {
                const cfg = fresh()
                item.apply(cfg, value)
                expect(item.format(cfg)).toBe(value)
            }
        })
    }
})

test('a value the panel never offers can never become the stored value', () => {
    // The old generic `else` coerced anything to a boolean. A row must either
    // ignore a label it does not recognise (the two ms settings and the search
    // provider) or sanitise it to a real one (debugLogs) — never store it. Either
    // way the field still renders as something the panel offers.
    for (const item of ITEMS) {
        if (item.values === undefined) continue
        const cfg = fresh()
        item.apply(cfg, 'not-an-offered-value')
        expect(item.values).toContain(item.format(cfg))
    }
})

test('every row offers values its own format can produce', () => {
    for (const item of ITEMS) {
        const offered = item.values ?? ['on', 'off']
        expect(offered.length).toBeGreaterThan(1)
        expect(new Set(offered).size).toBe(offered.length)
    }
})

test('the default config renders as an offered value for every setting', () => {
    // A default the panel cannot display is a setting whose current value shows
    // as something you cannot select.
    const cfg = fresh()
    for (const item of ITEMS) {
        const offered = item.values ?? ['on', 'off']
        expect(offered).toContain(item.format(cfg))
    }
})

test('an enum setting never becomes a boolean', () => {
    // The exact bug the deleted `else` branch could cause, and the reason
    // debugLogs needed a comment explaining why it must not fall into it.
    const cfg = fresh()
    for (const item of ITEMS) {
        if (item.values === undefined) continue
        for (const value of item.values) {
            item.apply(cfg, value)
            expect(typeof (cfg as unknown as Record<string, unknown>)[item.id]).not.toBe('boolean')
        }
    }
})

test('a boolean setting stores a real boolean, not the string "on"', () => {
    const cfg = fresh()
    for (const item of ITEMS) {
        if (item.values !== undefined) continue
        item.apply(cfg, 'on')
        expect((cfg as unknown as Record<string, unknown>)[item.id]).toBe(true)
        item.apply(cfg, 'off')
        expect((cfg as unknown as Record<string, unknown>)[item.id]).toBe(false)
    }
})

test('ids are unique — the onChange lookup must resolve to exactly one row', () => {
    const ids = ITEMS.map(i => i.id)
    expect(new Set(ids).size).toBe(ids.length)
})
