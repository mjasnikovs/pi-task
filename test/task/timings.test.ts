import {describe, expect, test} from 'bun:test'
import {formatMs, formatTimings, mergeTimings, type TimingEntry} from '../../src/task/timings.js'

describe('formatMs', () => {
    test('renders sub-second values in ms', () => {
        expect(formatMs(0)).toBe('0ms')
        expect(formatMs(250)).toBe('250ms')
        expect(formatMs(999)).toBe('999ms')
    })

    test('renders second-and-up values with one decimal', () => {
        expect(formatMs(1000)).toBe('1.0s')
        expect(formatMs(12_345)).toBe('12.3s')
        expect(formatMs(120_000)).toBe('120.0s')
    })

    test('clamps negative values to 0', () => {
        expect(formatMs(-50)).toBe('0ms')
    })
})

describe('formatTimings', () => {
    test('renders top-level phases plus a total row', () => {
        const entries: TimingEntry[] = [
            {label: 'refine', ms: 1200, children: []},
            {label: 'research', ms: 3400, children: []}
        ]
        const out = formatTimings(entries)
        expect(out).toContain('refine')
        expect(out).toContain('research')
        expect(out).toContain('1.2s')
        expect(out).toContain('3.4s')
        expect(out).toMatch(/^total/m)
        expect(out).toContain('4.6s')
    })

    test('renders sub-step children indented under their parent', () => {
        const entries: TimingEntry[] = [
            {
                label: 'research',
                ms: 4000,
                children: [
                    {label: 'workers', ms: 3000, children: []},
                    {label: 'verify-tooling', ms: 1000, children: []}
                ]
            }
        ]
        const out = formatTimings(entries)
        const lines = out.split('\n')
        const researchIdx = lines.findIndex(l => l.startsWith('research'))
        expect(researchIdx).toBeGreaterThanOrEqual(0)
        expect(lines[researchIdx + 1]).toMatch(/^ {2}workers/)
        expect(lines[researchIdx + 2]).toMatch(/^ {2}verify-tooling/)
    })

    test('returns a sentinel when no phases were recorded', () => {
        expect(formatTimings([])).toBe('(no phases recorded)')
    })
})

describe('mergeTimings', () => {
    const phases: TimingEntry[] = [
        {label: 'refine', ms: 1000, children: []},
        {label: 'research', ms: 2000, children: []}
    ]

    test('an empty section becomes attempt 1', () => {
        const out = mergeTimings(null, phases)
        expect(out).toMatch(/^attempt 1$/m)
        expect(out).toContain('refine')
        expect(out).toContain('research')
    })

    // The autofix re-entry: resumed at `phase: done`, it runs no phases at all.
    test("a second attempt APPENDS — the first attempt's phases survive", () => {
        const first = mergeTimings(null, phases)
        const out = mergeTimings(first, [])
        expect(out).toMatch(/^attempt 1$/m)
        expect(out).toMatch(/^attempt 2$/m)
        expect(out).toContain('refine')
        expect(out).toContain('research')
        expect(out).toContain('(no phases recorded)')
        expect(out.indexOf('attempt 1')).toBeLessThan(out.indexOf('attempt 2'))
    })

    test('numbering continues from the last block already there', () => {
        let out = mergeTimings(null, phases)
        for (let i = 0; i < 3; i++) out = mergeTimings(out, phases)
        expect(out).toMatch(/^attempt 4$/m)
        expect(out).not.toMatch(/^attempt 5$/m)
    })

    test('an unlabelled legacy body is adopted as attempt 1, not discarded', () => {
        const out = mergeTimings(formatTimings(phases), [{label: 'grill', ms: 5, children: []}])
        expect(out).toMatch(/^attempt 1$/m)
        expect(out).toMatch(/^attempt 2$/m)
        expect(out).toContain('refine')
        expect(out).toContain('grill')
    })
})
