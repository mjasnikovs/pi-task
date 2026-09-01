import {test, expect, describe} from 'bun:test'
import {ITEMS, configRows, panelItems} from '../../src/config/register.js'
import {DEFAULT_CONFIG} from '../../src/config/config.js'
import type {PiTaskConfig} from '../../src/config/config.js'

const fresh = (): PiTaskConfig => structuredClone(DEFAULT_CONFIG)

describe('every setting formats and parses its OWN value', () => {
    // The round trip, driven off the ROW rather than off a dispatcher. Split
    // across a format ladder and a parse ladder, neither fails to compile when a
    // setting is missing from one of them: the format gap renders
    // `String(cfg[id])` and the parse gap writes a boolean into an enum field.
    // `handleTaskConfig` is not exported, so the dispatcher cannot be driven
    // directly — every row's own `format`/`apply` pair can.
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
    // A generic parse arm coerces anything to a boolean. A row must instead either
    // IGNORE a label it does not recognise — searchProvider and the two ms
    // settings leave the field untouched — or SANITISE it to a real one —
    // reasoningMode and debugLogs fall back to their default. Never store it.
    // Either way the field still renders as something the panel offers.
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
    // The exact damage a generic boolean parse arm would do to an enum row.
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

/**
 * The same properties, over EVERY row this session shows — the eleven reasoning
 * groups plus one row per live tool and per installed extension.
 *
 * Those three families are the ones a prefix ladder would leave out: they are
 * BUILT at call time rather than listed in ITEMS, so none of the properties above
 * reaches them.
 */
describe('every DISCOVERED row obeys the same contract', () => {
    const tools = [
        {name: 'bash', origin: 'built in'},
        {name: 'fable_loop', origin: 'discovered (/x/fable/index.js)'}
    ]
    const installed = [
        {path: '/x/pi-lmstudio/index.ts', label: 'pi-lmstudio', origin: 'npm:pi-lmstudio (user)'}
    ]
    const rows = configRows(installed, tools)

    test('the discovered families are actually in there', () => {
        // Guards against a vacuous suite: every assertion below iterates `rows`.
        for (const prefix of ['step:', 'tool:', 'ext:']) {
            expect(
                rows.some(r => r.id.startsWith(prefix)),
                prefix
            ).toBe(true)
        }
    })

    test('format(apply(cfg, v)) === v for every offered value of every row', () => {
        for (const item of rows) {
            for (const value of item.values ?? ['on', 'off']) {
                const cfg = fresh()
                item.apply(cfg, value)
                expect(item.format(cfg), `${item.id} := ${value}`).toBe(value)
            }
        }
    })

    test('a value the panel never offers can never become the stored value', () => {
        for (const item of rows) {
            const offered = item.values ?? ['on', 'off']
            const cfg = fresh()
            item.apply(cfg, 'not-an-offered-value')
            expect(offered, item.id).toContain(item.format(cfg))
        }
    })

    test('the default config renders as an offered value for every row', () => {
        const cfg = fresh()
        for (const item of rows) {
            expect(item.values ?? ['on', 'off'], item.id).toContain(item.format(cfg))
        }
    })

    test('ids are unique across every family', () => {
        // The onChange lookup is now one `rows.find(r => r.id === id)`, so a
        // collision between a fixed row and a discovered one would silently
        // dispatch to whichever came first.
        const ids = rows.map(i => i.id)
        expect(new Set(ids).size).toBe(ids.length)
    })

    test('every row belongs to a section the menu actually renders', () => {
        const shown = new Set(panelItems(fresh(), installed, tools).map(i => i.id))
        for (const item of rows) expect(shown, item.id).toContain(item.id)
    })
})

describe('the step rows round-trip over a REAL cross product', () => {
    /**
     * The properties above run against `configRows`' default catalog, where the
     * only offerable model is `inherit` — six values per step row. That never
     * exercises the composite itself.
     *
     * Here the cross product is real: two models, one of which cannot reason, so
     * `values` holds three different shapes and `apply` must write both halves
     * atomically from a fresh config every time.
     */
    const catalog = {
        specs: ['acme/small', 'acme/big'],
        facts: (spec: string) =>
            spec === 'acme/small' ? {reasoning: false}
            : spec === 'acme/big' ? {reasoning: true}
            : undefined
    }
    const rows = configRows([], [], catalog).filter(r => r.id.startsWith('step:'))

    test('there are step rows to quantify over', () => {
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.some(r => r.values!.some(v => v.endsWith('acme/small')))).toBe(true)
    })

    test('format(apply(cfg, v)) === v for every legal pair', () => {
        for (const item of rows) {
            for (const value of item.values!) {
                const cfg = fresh()
                item.apply(cfg, value)
                expect(item.format(cfg), `${item.id} := ${value}`).toBe(value)
            }
        }
    })

    test('no two legal pairs render identically', () => {
        for (const item of rows) {
            expect(new Set(item.values).size, item.id).toBe(item.values!.length)
        }
    })

    test('a pair the model cannot honour is not offered in the first place', () => {
        // If it were, `apply` would clamp it and the round trip above would fail.
        // That is the whole reason `values` is built from `offeredLevels`.
        for (const item of rows) {
            const forSmall = item.values!.filter(v => v.endsWith(' acme/small'))
            expect(forSmall, item.id).toEqual(['inherit · acme/small', 'off · acme/small'])
        }
    })
})
