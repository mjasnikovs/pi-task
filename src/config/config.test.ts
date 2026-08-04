import {describe, expect, test} from 'bun:test'
import {
    COMMAND_TIMEOUT_OPTIONS,
    DEBUG_LOG_OPTIONS,
    sanitizeDebugLogs,
    sanitizeCommandTimeoutExemptTools,
    sanitizeRequestTimeoutMs,
    sanitizeStreamInactivityMs,
    STREAM_INACTIVITY_OPTIONS
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
