import {describe, expect, test} from 'bun:test'
import {COMMAND_TIMEOUT_OPTIONS, sanitizeRequestTimeoutMs} from './config.js'

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
