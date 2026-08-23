import {describe, expect, test} from 'bun:test'
import {CoverageLedger} from './plan-rounds.js'
import type {ScoredPlan} from './coverage-loop.js'

/**
 * The plan phase's subtlest carry-forward decisions, with no temp dir, no fake
 * ctx, no scripted children and no log grep.
 *
 * Before this module, the bonus-round policy was reachable only through
 * `planAuto` and asserted by counting a debug string:
 *
 *     expect(log).toContain('bonus round granted')
 *     expect((log.match(/bonus round granted/g) ?? []).length).toBe(1)
 *
 * — which is exactly what CONTEXT.md's `AutofixLedger` entry indicts: *"The suite
 * could previously only observe this loop through trail strings."*
 */

function plan(over: {
    titles?: string[]
    covered?: number[]
    missing?: string[]
    accounting?: ScoredPlan['accounting']
    suspect?: boolean
}): ScoredPlan {
    return {
        plan: {
            titles: over.titles ?? ['A', 'B'],
            covered: new Set<number>(over.covered ?? []),
            missing: over.missing ?? []
        },
        accounting: over.accounting ?? null,
        suspect: over.suspect ?? false,
        judgeMissing: []
    }
}

const REQS = {cap: 2, hasRequirements: true}

describe('CoverageLedger', () => {
    test('starts holding the seed plan and no rounds spent', () => {
        const seed = plan({titles: ['A']})
        const l = new CoverageLedger(seed, REQS)
        expect(l.best()).toBe(seed)
        expect(l.round()).toBe(0)
        expect(l.mayRetry()).toBe(true)
    })

    test('mayRetry goes false at the cap', () => {
        const l = new CoverageLedger(plan({}), REQS)
        l.startRound()
        expect(l.mayRetry()).toBe(true)
        l.startRound()
        expect(l.mayRetry()).toBe(false)
    })

    test('unresolved names what still is not covered, or null', () => {
        expect(new CoverageLedger(plan({missing: []}), REQS).unresolved()).toBeNull()
        expect(new CoverageLedger(plan({missing: ['tests']}), REQS).unresolved()).toEqual(['tests'])
    })

    // MONOTONE adoption: a retry that drops a requirement the current plan owns is
    // rejected, so coverage can only hold or grow.
    test('a candidate that drops covered ground is rejected and changes nothing', () => {
        const seed = plan({titles: ['A', 'B'], covered: [1, 2], missing: ['tests']})
        const l = new CoverageLedger(seed, REQS)
        const out = l.consider(plan({titles: ['C'], covered: [1], missing: ['tests']}))
        expect(out.adopted).toBe(false)
        expect(l.best()).toBe(seed)
    })

    // THE BUG THE COMMENT DESCRIBES. It used to be two assignments, and the second
    // kept the OLD plan's accounting whenever the candidate's coverage-map child
    // faulted — binding requirements to titles they were never mapped against.
    test('an adopted plan whose coverage-map FAULTED keeps the new (null) accounting', () => {
        const seed = plan({
            titles: ['A'],
            covered: [1],
            missing: ['tests'],
            accounting: {stale: true} as unknown as ScoredPlan['accounting']
        })
        const l = new CoverageLedger(seed, REQS)
        const out = l.consider(
            plan({titles: ['A', 'B'], covered: [1, 2], missing: ['tests'], accounting: null})
        )
        expect(out.adopted).toBe(true)
        expect(l.best().plan.titles).toEqual(['A', 'B'])
        // The whole value moved. The old accounting cannot survive its plan.
        expect(l.best().accounting).toBeNull()
    })

    describe('the bonus round', () => {
        /** Drive to the cap, then offer a candidate that grows AND exposes a new gap. */
        function atCap(seedMissing: string[]) {
            const l = new CoverageLedger(
                plan({titles: ['A'], covered: [1], missing: seedMissing}),
                REQS
            )
            l.startRound()
            l.startRound()
            return l
        }

        test('an adoption at the cap that grows coverage AND exposes a new area grants one', () => {
            const l = atCap(['tests'])
            expect(l.mayRetry()).toBe(false)
            const out = l.consider(
                plan({titles: ['A', 'B'], covered: [1, 2], missing: ['tests', 'docs']})
            )
            expect(out.grantedBonusRound).toBe(true)
            expect(l.mayRetry()).toBe(true)
        })

        test('a SECOND such adoption grants none — the bonus is one-shot', () => {
            const l = atCap(['tests'])
            expect(
                l.consider(plan({covered: [1, 2], missing: ['tests', 'docs']})).grantedBonusRound
            ).toBe(true)
            l.startRound()
            const second = l.consider(
                plan({covered: [1, 2, 3], missing: ['tests', 'docs', 'infra']})
            )
            expect(second.adopted).toBe(true)
            expect(second.grantedBonusRound).toBe(false)
            expect(l.mayRetry()).toBe(false)
        })

        // A flaky judge relabelling the same-shaped plan's gap must not buy a round.
        test('coverage that did not GROW grants none, however the gap is worded', () => {
            const l = atCap(['tests'])
            const out = l.consider(plan({covered: [1], missing: ['tests', 'docs']}))
            expect(out.grantedBonusRound).toBe(false)
        })

        // A gap already present is one we have reprompted against or will.
        test('a re-surfaced gap grants none, even reworded', () => {
            const l = atCap(['no test coverage'])
            const out = l.consider(plan({covered: [1, 2], missing: ['"No Test Coverage!"']}))
            expect(out.adopted).toBe(true)
            expect(out.grantedBonusRound).toBe(false)
        })

        test('an adoption BEFORE the cap grants none — there is a round left anyway', () => {
            const l = new CoverageLedger(plan({covered: [1], missing: ['tests']}), {
                cap: 3,
                hasRequirements: true
            })
            l.startRound()
            const out = l.consider(plan({covered: [1, 2], missing: ['tests', 'docs']}))
            expect(out.grantedBonusRound).toBe(false)
        })

        // Without grounded requirements `missing` is holistic-judge free text that
        // can change every round, so there is no trustworthy grew/new signal.
        test('no grounded requirements ⇒ no bonus round at all', () => {
            const l = new CoverageLedger(plan({covered: [1], missing: ['tests']}), {
                cap: 1,
                hasRequirements: false
            })
            l.startRound()
            const out = l.consider(plan({covered: [1, 2], missing: ['tests', 'docs']}))
            expect(out.grantedBonusRound).toBe(false)
        })

        test('a REJECTED candidate never grants a bonus round', () => {
            const l = atCap(['tests'])
            const out = l.consider(plan({titles: ['C'], covered: [], missing: ['tests', 'docs']}))
            expect(out.adopted).toBe(false)
            expect(out.grantedBonusRound).toBe(false)
            expect(l.mayRetry()).toBe(false)
        })
    })
})
