import {describe, expect, test} from 'bun:test'
import {
    appendHandoff,
    formatHandoff,
    parseHandoff,
    specHash,
    summariseFixContext,
    type HandoffRecord
} from '../../src/task/handoff.js'
import type {FixContext} from '../../src/task/fix-context.js'
import type {Disposition} from '../../src/task/gate-resolution.js'

const AUTOFIX: Disposition = {
    rule: 'autofix',
    action: 'autofix',
    debtOrigin: null,
    reason: 'autofix recommended, unattended 1/3'
}

const fix: FixContext = {
    outcome: {ok: false, failClass: 'static-checks', reason: 'lint exited 1'},
    disposition: AUTOFIX,
    probes: {suppressionWidening: ['src/api.ts — 16 net-new `@ts-expect-error`'], prohibition: []},
    attempt: 2,
    contradiction: {criterion: 'lint passes', frozenPath: 'src/frozen.ts'}
}

describe('specHash', () => {
    test('the same spec hashes the same, a changed one does not', () => {
        expect(specHash('a spec')).toBe(specHash('a spec'))
        expect(specHash('a spec')).not.toBe(specHash('a spec '))
    })
})

describe('formatHandoff / parseHandoff', () => {
    const fresh: HandoffRecord = {
        attempt: 1,
        specHash: 'deadbeef1234',
        delivered: 'fresh',
        at: '2026-09-16T00:00:00.000Z'
    }

    test('a fresh delivery round-trips', () => {
        expect(parseHandoff(formatHandoff(fresh))).toEqual([fresh])
    })

    test('a re-attempt carries the gate decision that paid for it', () => {
        const record: HandoffRecord = {
            ...fresh,
            attempt: 2,
            delivered: 'reattempt',
            fixContext: summariseFixContext(fix)
        }
        const [back] = parseHandoff(formatHandoff(record))
        expect(back).toEqual(record)
        // An empty probe channel is not a finding.
        expect(back.fixContext?.probes).toEqual(['suppressionWidening'])
        expect(back.fixContext?.failClass).toBe('static-checks')
        expect(back.fixContext?.frozenPath).toBe('src/frozen.ts')
    })

    test('records APPEND — every delivery is still there afterwards', () => {
        let body = appendHandoff(null, fresh)
        body = appendHandoff(body, {...fresh, attempt: 2, delivered: 'reattempt'})
        body = appendHandoff(body, {...fresh, attempt: 3, specHash: 'cafe0000abcd'})
        const records = parseHandoff(body)
        expect(records.map(r => r.attempt)).toEqual([1, 2, 3])
        expect(records.map(r => r.delivered)).toEqual(['fresh', 'reattempt', 'fresh'])
        expect(records[2].specHash).toBe('cafe0000abcd')
    })

    test('the single-timestamp legacy section counts as one delivery', () => {
        const legacy = 'handoff_at: 2026-01-01T00:00:00.000Z'
        expect(parseHandoff(legacy)).toEqual([
            {attempt: 1, specHash: '', delivered: 'fresh', at: '2026-01-01T00:00:00.000Z'}
        ])
        expect(parseHandoff(appendHandoff(legacy, {...fresh, attempt: 2}))).toHaveLength(2)
    })

    test('an absent section has no records', () => {
        expect(parseHandoff(null)).toEqual([])
        expect(parseHandoff('   ')).toEqual([])
    })
})
