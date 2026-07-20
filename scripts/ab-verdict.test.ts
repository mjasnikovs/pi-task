/**
 * The A/B harnesses live in scripts/ and are never shipped in dist, but their
 * verdict logic decides whether every other validation in this repo means
 * anything — so it is tested. `bun run test` covers scripts/ for this file.
 */
import {describe, expect, test} from 'bun:test'
import {EXIT_CODE, judge, judgeArm, type AbSpec, type ArmSpec} from './ab-verdict.js'

const ab = (over: Partial<AbSpec>): AbSpec => ({
    name: 'test-harness',
    reps: 3,
    targetShape: 'a whole-project batch test title',
    baselineHits: 3,
    treatmentHits: 0,
    ...over
})

const arm = (over: Partial<ArmSpec>): ArmSpec => ({
    name: 'test-harness',
    arm: 'treatment',
    reps: 5,
    targetShape: 'an edit to a frozen tsconfig',
    hits: 0,
    witnessed: 5,
    expect: 'none',
    ...over
})

describe('judge — two-armed A/B', () => {
    test('baseline exhibits the shape and treatment removes it ⇒ PASS', () => {
        const v = judge(ab({baselineHits: 3, treatmentHits: 0}))
        expect(v.outcome).toBe('PASS')
        expect(v.lines.join('\n')).toContain('PASS —')
    })

    test('the shape surviving treatment ⇒ FAIL', () => {
        const v = judge(ab({baselineHits: 3, treatmentHits: 2}))
        expect(v.outcome).toBe('FAIL')
        expect(v.lines.join('\n')).toContain('survived the treatment arm')
    })

    // The defect this module exists for: live-batch-test-ab.ts on 2026-07-20
    // reported baseline 0/3, treatment 0/3 and exited 0.
    test('a zero baseline is ABSTAIN, never PASS, even with a perfect treatment column', () => {
        const v = judge(ab({baselineHits: 0, treatmentHits: 0}))
        expect(v.outcome).toBe('ABSTAIN')
        const text = v.lines.join('\n')
        expect(text).toContain('THIS RUN PROVED NOTHING')
        expect(text).toContain('a whole-project batch test title')
        expect(text).not.toContain('PASS —')
    })

    test('ABSTAIN outranks a broken invariant — nothing ran, so nothing can be concluded', () => {
        const v = judge(
            ab({
                baselineHits: 0,
                treatmentHits: 0,
                invariants: [{label: 'coverage held', ok: false}]
            })
        )
        expect(v.outcome).toBe('ABSTAIN')
    })

    test('a broken invariant fails a run that otherwise removed the shape', () => {
        const v = judge(
            ab({invariants: [{label: 'coverage never fell', ok: false, detail: '12 → 9'}]})
        )
        expect(v.outcome).toBe('FAIL')
        expect(v.lines.join('\n')).toContain('coverage never fell')
    })

    test('requireTreatmentZero:false accepts a strict reduction but not a flat line', () => {
        expect(
            judge(ab({baselineHits: 3, treatmentHits: 1, requireTreatmentZero: false})).outcome
        ).toBe('PASS')
        expect(
            judge(ab({baselineHits: 3, treatmentHits: 3, requireTreatmentZero: false})).outcome
        ).toBe('FAIL')
    })

    test('every outcome carries both arm counts, so the banner is auditable', () => {
        const text = judge(ab({baselineHits: 2, treatmentHits: 1})).lines.join('\n')
        expect(text).toContain('BASELINE  produced it: 2/3')
        expect(text).toContain('TREATMENT shipped it:  1/3')
    })
})

describe('judgeArm — one arm per invocation', () => {
    test('a suppressing arm with the precondition witnessed and no hits ⇒ PASS', () => {
        expect(judgeArm(arm({hits: 0, witnessed: 5})).outcome).toBe('PASS')
    })

    // The split-invocation form of the same trap: 0/5 in a treatment arm looks
    // identical whether the guard worked or the shape never arose.
    test('a suppressing arm that never witnessed the precondition ⇒ ABSTAIN', () => {
        const v = judgeArm(arm({hits: 0, witnessed: 0}))
        expect(v.outcome).toBe('ABSTAIN')
        expect(v.lines.join('\n')).toContain('THIS RUN PROVED NOTHING')
    })

    test('a suppressing arm the shape survived ⇒ FAIL', () => {
        expect(judgeArm(arm({hits: 2, witnessed: 5})).outcome).toBe('FAIL')
    })

    test('a baseline arm that witnessed the precondition but never emitted the shape ⇒ FAIL', () => {
        const v = judgeArm(arm({arm: 'baseline', expect: 'some', hits: 0, witnessed: 5}))
        expect(v.outcome).toBe('FAIL')
        expect(v.lines.join('\n')).toContain('cannot serve as a baseline')
    })

    test('a baseline arm with nothing witnessed ⇒ ABSTAIN, not FAIL', () => {
        expect(
            judgeArm(arm({arm: 'baseline', expect: 'some', hits: 0, witnessed: 0})).outcome
        ).toBe('ABSTAIN')
    })
})

describe('exit codes', () => {
    test('ABSTAIN is non-zero and distinct from FAIL', () => {
        expect(EXIT_CODE.PASS).toBe(0)
        expect(EXIT_CODE.FAIL).toBe(1)
        expect(EXIT_CODE.ABSTAIN).toBe(2)
        expect(EXIT_CODE.ABSTAIN).not.toBe(EXIT_CODE.PASS)
    })
})
