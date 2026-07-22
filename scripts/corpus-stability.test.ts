import {test, expect, describe} from 'bun:test'
import {classifyStability, summarize, type ResultRow} from './corpus-stability.js'

const q = (
    rep: number,
    query: string,
    o: {valid?: boolean; unclear?: boolean; hallucWarn?: boolean} = {}
): ResultRow => ({
    rep,
    pkg: 'bun',
    query,
    valid: o.valid ?? true,
    unclear: o.unclear ?? false,
    hallucWarn: o.hallucWarn ?? false
})

describe('classifyStability', () => {
    test('a question valid in every rep is always-valid and not a fixture', () => {
        const s = classifyStability([q(1, 'a'), q(2, 'a'), q(3, 'a')])
        expect(s).toHaveLength(1)
        expect(s[0].stability).toBe('always-valid')
        expect(s[0].flipRate).toBe(0)
        expect(s[0].deterministicFixture).toBe(false)
    })

    test('a question that fails every rep the SAME way is a deterministic fixture', () => {
        const rows = [1, 2, 3, 4].map(r => q(r, 'b', {valid: false, unclear: true}))
        const s = classifyStability(rows)
        expect(s[0].stability).toBe('always-invalid')
        expect(s[0].deterministicFixture).toBe(true)
        expect(s[0].flipRate).toBe(0)
    })

    test('failing every rep by a DIFFERENT mode is NOT a deterministic fixture', () => {
        // Always invalid, but sometimes via `unclear` and sometimes via the excerpt
        // verifier — the fixture's own metric would move between reps for free.
        const s = classifyStability([
            q(1, 'c', {valid: false, unclear: true}),
            q(2, 'c', {valid: false, hallucWarn: true}),
            q(3, 'c', {valid: false, unclear: true}),
            q(4, 'c', {valid: false, hallucWarn: true})
        ])
        expect(s[0].stability).toBe('always-invalid')
        expect(s[0].deterministicFixture).toBe(false)
    })

    test('a coin-flip question is unstable with a flip rate near half', () => {
        const s = classifyStability([
            q(1, 'd', {valid: false, hallucWarn: true}),
            q(2, 'd', {valid: true}),
            q(3, 'd', {valid: false, hallucWarn: true}),
            q(4, 'd', {valid: true})
        ])
        expect(s[0].stability).toBe('unstable')
        expect(s[0].flipRate).toBe(0.5)
        expect(s[0].deterministicFixture).toBe(false)
    })

    test('a single rep can never certify a fixture — reps > 1 is required', () => {
        const s = classifyStability([q(1, 'e', {valid: false, unclear: true})])
        expect(s[0].stability).toBe('always-invalid')
        expect(s[0].deterministicFixture).toBe(false)
    })

    test('errored observations are excluded, not counted as failures', () => {
        const s = classifyStability([
            q(1, 'f', {valid: false, unclear: true}),
            {rep: 2, pkg: 'bun', query: 'f', error: 'spawn failed'},
            q(3, 'f', {valid: false, unclear: true})
        ])
        expect(s[0].reps).toBe(2)
        expect(s[0].invalid).toBe(2)
        expect(s[0].deterministicFixture).toBe(true)
    })

    test('questions are keyed by pkg AND query, so same query on two packages is distinct', () => {
        const s = classifyStability([
            {rep: 1, pkg: 'hono', query: 'same', valid: true},
            {rep: 1, pkg: 'zod', query: 'same', valid: false, unclear: true}
        ])
        expect(s).toHaveLength(2)
    })
})

describe('summarize — the churn the aggregate hides', () => {
    test('reports counter churn separately, which is the whole point', () => {
        // Two questions: one whose `unclear` is constant, one whose halluc flips.
        const rows: ResultRow[] = [
            q(1, 'stable', {valid: false, unclear: true}),
            q(2, 'stable', {valid: false, unclear: true}),
            q(1, 'churny', {valid: false, hallucWarn: true}),
            q(2, 'churny', {valid: true, hallucWarn: false})
        ]
        const sum = summarize(classifyStability(rows))
        expect(sum.questions).toBe(2)
        expect(sum.unclearChurn).toBe(0)
        expect(sum.hallucChurn).toBe(1)
        expect(sum.alwaysInvalid).toBe(1)
        expect(sum.unstable).toBe(1)
        expect(sum.deterministicFixtures).toBe(1)
    })

    test('an empty input summarises to zeroes rather than NaN', () => {
        const sum = summarize(classifyStability([]))
        expect(sum.questions).toBe(0)
        expect(sum.meanFlipRate).toBe(0)
        expect(sum.reps).toBe(0)
    })
})
