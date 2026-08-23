import {describe, expect, test} from 'bun:test'
import {
    COMMAND_TIMEOUT_OPTIONS,
    DEBUG_LOG_OPTIONS,
    sanitizeDebugLogs,
    sanitizeCommandTimeoutExemptTools,
    sanitizeRequestTimeoutMs,
    sanitizeStreamInactivityMs,
    STREAM_INACTIVITY_OPTIONS,
    CONFIG_LOADERS,
    DEFAULT_CONFIG,
    loadConfig,
    type PiTaskConfig
} from './config.js'

describe('sanitizeCommandTimeoutExemptTools', () => {
    test('keeps unique non-empty tool names', () => {
        expect(
            sanitizeCommandTimeoutExemptTools(['fable_loop', ' fable_loop ', 'durable_job', '', 42])
        ).toEqual(['fable_loop', 'durable_job'])
    })

    test('rejects non-arrays and entries that are not tool names', () => {
        for (const bad of [undefined, null, 'fable_loop', {}, 1]) {
            expect(sanitizeCommandTimeoutExemptTools(bad)).toEqual([])
        }
        expect(sanitizeCommandTimeoutExemptTools(['has spaces', 'slash/name', '-bad'])).toEqual([])
    })
})

describe('COMMAND_TIMEOUT_OPTIONS', () => {
    test('offers 5/10/15/30 min plus off, with off stored as 0', () => {
        expect(COMMAND_TIMEOUT_OPTIONS.map(o => o.label)).toEqual([
            '5 min',
            '10 min',
            '15 min',
            '30 min',
            'off'
        ])
        expect(COMMAND_TIMEOUT_OPTIONS.find(o => o.label === 'off')!.ms).toBe(0)
        expect(COMMAND_TIMEOUT_OPTIONS.find(o => o.label === '15 min')!.ms).toBe(900_000)
    })
})

describe('sanitizeRequestTimeoutMs', () => {
    test('passes through an offered value', () => {
        expect(sanitizeRequestTimeoutMs(300_000)).toBe(300_000)
        expect(sanitizeRequestTimeoutMs(0)).toBe(0)
    })

    test('falls back to the 15 min default for anything off-menu', () => {
        for (const bad of [undefined, null, 'off', 12_345, -1, NaN, {}, 60 * 60_000]) {
            expect(sanitizeRequestTimeoutMs(bad)).toBe(900_000)
        }
    })
})

describe('STREAM_INACTIVITY_OPTIONS', () => {
    test('offers 5/10/20/30 min plus off, with off stored as 0', () => {
        expect(STREAM_INACTIVITY_OPTIONS.map(o => o.label)).toEqual([
            '5 min',
            '10 min',
            '20 min',
            '30 min',
            'off'
        ])
        expect(STREAM_INACTIVITY_OPTIONS.find(o => o.label === 'off')!.ms).toBe(0)
    })

    // The one value that must not drift: a 60-120s ceiling would kill every long
    // prompt-processing pass on a local backend (mx5 run 14 gray area). Asserted
    // through the sanitizer, not getConfig, so a developer's own config file
    // cannot flip the test.
    test('defaults to 10 minutes — generous enough for local first-token latency', () => {
        expect(sanitizeStreamInactivityMs('bogus')).toBe(600_000)
        expect(STREAM_INACTIVITY_OPTIONS.find(o => o.label === '10 min')!.ms).toBe(600_000)
    })
})

describe('sanitizeStreamInactivityMs', () => {
    test('passes through an offered value', () => {
        expect(sanitizeStreamInactivityMs(300_000)).toBe(300_000)
        expect(sanitizeStreamInactivityMs(0)).toBe(0)
    })

    test('falls back to the 10 min default for anything off-menu', () => {
        for (const bad of [undefined, null, 'off', 90_000, -1, NaN, {}]) {
            expect(sanitizeStreamInactivityMs(bad)).toBe(600_000)
        }
    })
})

describe('DEBUG_LOG_OPTIONS', () => {
    test('offers off/events/full, quietest first', () => {
        expect([...DEBUG_LOG_OPTIONS]).toEqual(['off', 'events', 'full'])
    })
})

describe('sanitizeDebugLogs', () => {
    test('passes through an offered level', () => {
        for (const level of DEBUG_LOG_OPTIONS) expect(sanitizeDebugLogs(level)).toBe(level)
    })

    /**
     * The load-bearing assertion, and the reason this knob is not a boolean: the
     * guard/verdict markers are the only record that a git-state restore or a
     * write-capable child's deletion happened, and a debug log cannot be recovered
     * after the run. A nonsense stored value must degrade to KEEPING them.
     * Asserted through the sanitizer rather than getConfig so a developer's own
     * ~/.config/pi-task/config.json cannot flip the test.
     */
    test('falls back to events — never off — for anything off-menu', () => {
        for (const bad of [undefined, null, true, false, 'on', 'verbose', 1, 0, {}, []]) {
            expect(sanitizeDebugLogs(bad)).toBe('events')
        }
    })
})

// ─── loadConfig: the whole table, not one key at a time ──────────────────────
//
// Every sanitizer above is covered in isolation. What had no coverage at all was
// the COMPOSITION — which keys the load block ran a sanitizer over, and what the
// trailing spread did to the ones it skipped. These are that test, and they are
// possible because `loadConfig` is a pure function rather than a module-eval
// block reading the developer's own ~/.config/pi-task/config.json.

describe('loadConfig', () => {
    test('a missing file-shape yields the shipped defaults', () => {
        // `{...DEFAULT_CONFIG, ...'ab'}` used to produce numeric index keys.
        for (const bad of [undefined, null, 'ab', 42, true, []]) {
            expect(loadConfig(bad)).toEqual(DEFAULT_CONFIG)
        }
    })

    test('an empty object yields the shipped defaults', () => {
        expect(loadConfig({})).toEqual(DEFAULT_CONFIG)
    })

    test('every key has a loader — the table covers PiTaskConfig exactly', () => {
        expect(Object.keys(CONFIG_LOADERS).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort())
    })

    test('round-trips a stored config through JSON unchanged', () => {
        const stored: PiTaskConfig = {
            ...DEFAULT_CONFIG,
            remote: false,
            autoCommit: false,
            yoloMode: true,
            searchProvider: 'ddg',
            extensionWhitelist: ['/home/u/.pi/ext/a.ts'],
            requestTimeoutMs: 5 * 60_000,
            commandTimeoutExemptTools: ['fable_loop'],
            streamInactivityMs: 0,
            debugLogs: 'full'
        }
        expect(loadConfig(JSON.parse(JSON.stringify(stored)))).toEqual(stored)
    })

    // The class the ladder covered for exactly one of eight keys. `yoloMode`'s
    // guard comment — "a hand-edited `"false"` is a truthy string" — was true
    // verbatim of the other seven, and none of them had it.
    test('a hostile value on ANY boolean falls back to its default, not to truthiness', () => {
        const booleans = (Object.keys(DEFAULT_CONFIG) as Array<keyof PiTaskConfig>).filter(
            k => typeof DEFAULT_CONFIG[k] === 'boolean'
        )
        expect(booleans).toHaveLength(8)
        for (const key of booleans) {
            for (const bad of ['false', 'off', 'true', 0, 1, null, {}, []]) {
                expect(loadConfig({[key]: bad})[key]).toBe(DEFAULT_CONFIG[key])
            }
        }
    })

    test('a real boolean is honoured on every boolean key', () => {
        const booleans = (Object.keys(DEFAULT_CONFIG) as Array<keyof PiTaskConfig>).filter(
            k => typeof DEFAULT_CONFIG[k] === 'boolean'
        )
        for (const key of booleans) {
            expect(loadConfig({[key]: true})[key]).toBe(true)
            expect(loadConfig({[key]: false})[key]).toBe(false)
        }
    })

    test('an unknown search provider never reaches the dispatch switch', () => {
        expect(loadConfig({searchProvider: 'kagi'}).searchProvider).toBe(
            DEFAULT_CONFIG.searchProvider
        )
        expect(loadConfig({searchProvider: 'ddg'}).searchProvider).toBe('ddg')
    })

    test('keys the table does not know are dropped, not carried into the config', () => {
        const out = loadConfig({remote: false, someRemovedSetting: 'ghost'}) as unknown as Record<
            string,
            unknown
        >
        expect(out.remote).toBe(false)
        expect('someRemovedSetting' in out).toBe(false)
    })
})
