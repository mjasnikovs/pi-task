/**
 * The run-end resolution loop's record, driven directly.
 *
 * Before this existed the same state was six closure-threaded locals inside a
 * ~235-line loop, and the only way to observe a decision was to run the whole
 * stage over a temp task dir and match a TRAIL STRING
 * (`startsWith('final-gate: check DEMOTED')`). The demotion rule in particular
 * was applied downstream from the evidence it judges — the shape
 * `final-gate-progress.ts`'s own comment names as the mx5 run-21 defect, which
 * shipped a product whose every page was blank as a `completed` run.
 */
import {describe, expect, test} from 'bun:test'
import {AutofixLedger} from './autofix-ledger.js'

const RED = 'boot check: `bun run start` listens on :3000 but GET / responded 404'
const OTHER = '`bun run test` exited 1 — 1 CT test failed'

describe('AutofixLedger — the bound', () => {
    test('the card is offered until the budget is spent, then withdrawn', () => {
        const l = new AutofixLedger(3)
        for (let i = 1; i <= 3; i++) {
            expect(l.canAutofix()).toBe(true)
            expect(l.attempt()).toBe(i)
        }
        expect(l.canAutofix()).toBe(false)
        expect(l.attempts()).toBe(3)
    })
})

describe('AutofixLedger — the demotion decision', () => {
    test('one identical failure is not enough: the FIRST attempt has nothing to match', () => {
        const l = new AutofixLedger(3)
        expect(l.judge({reason: RED, failures: [RED]}, true).demoted).toBe(false)
        expect(l.hasDemotions()).toBe(false)
    })

    test('the same failure across two tree-changing attempts IS demoted, with a debt reason', () => {
        const l = new AutofixLedger(3)
        l.judge({reason: RED, failures: [RED]}, true)
        const v = l.judge({reason: RED, failures: [RED]}, true)
        expect(v.demoted).toBe(true)
        expect(v.detail).toBe(RED)
        expect(v.debtReason).toContain('UNOBSERVED')
        expect(v.debtReason).toContain('unfalsifiable')
        expect(l.demotedCount()).toBe(1)
    })

    test('an attempt that did NOT change the tree says nothing about falsifiability', () => {
        const l = new AutofixLedger(3)
        l.judge({reason: RED, failures: [RED]}, true)
        expect(l.judge({reason: RED, failures: [RED]}, false).demoted).toBe(false)
    })

    test('a failure a PROBE OBSERVED is never demoted, however often it repeats', () => {
        // nexttask 19A, and the run-21 defect: a deterministic un-fixed defect emits
        // an IDENTICAL failure by definition, so string equality reads
        // reproducibility as evidence against the instrument. A probe that LOOKED
        // overrules that, and the check now sits with the evidence rather than
        // downstream of it.
        const l = new AutofixLedger(3)
        const outcome = {reason: RED, failures: [RED], observedFailures: [RED]}
        l.judge(outcome, true)
        expect(l.judge(outcome, true).demoted).toBe(false)
        expect(l.judge(outcome, true).demoted).toBe(false)
        expect(l.hasDemotions()).toBe(false)
    })

    test('a demotion ENDS the chain — it cannot cascade into a second', () => {
        const l = new AutofixLedger(4)
        l.judge({reason: RED, failures: [RED]}, true)
        expect(l.judge({reason: RED, failures: [RED]}, true).demoted).toBe(true)
        // With RED demoted the next attempt ranks OTHER first, and there is no
        // previous signature left for it to match.
        expect(l.judge({reason: OTHER, failures: [OTHER]}, true).demoted).toBe(false)
        expect(l.demotedCount()).toBe(1)
    })

    test('a different failure each time is progress, never a demotion', () => {
        const l = new AutofixLedger(3)
        expect(l.judge({reason: RED, failures: [RED]}, true).demoted).toBe(false)
        expect(l.judge({reason: OTHER, failures: [OTHER]}, true).demoted).toBe(false)
        expect(l.hasDemotions()).toBe(false)
    })
})

describe('AutofixLedger — what still has to pass', () => {
    test('a demoted signature no longer counts against the gate', () => {
        const l = new AutofixLedger(3)
        l.judge({reason: RED, failures: [RED, OTHER]}, true)
        l.judge({reason: RED, failures: [RED, OTHER]}, true)
        expect(l.remaining({reason: RED, failures: [RED, OTHER]})).toEqual([OTHER])
    })

    test('nothing left ⇒ converged carrying the demotion as debt', () => {
        const l = new AutofixLedger(3)
        l.judge({reason: RED, failures: [RED]}, true)
        l.judge({reason: RED, failures: [RED]}, true)
        expect(l.remaining({reason: RED, failures: [RED]})).toEqual([])
    })

    test('an outcome naming no list degrades to its single reason', () => {
        const l = new AutofixLedger(3)
        expect(l.remaining({reason: RED})).toEqual([RED])
        expect(l.remaining(undefined)).toBeUndefined()
    })
})

describe('AutofixLedger — writes, stranded work and the commit gate', () => {
    test('gitignored writes ACCUMULATE across attempts and de-duplicate', () => {
        // A `.env` written by a failed attempt is still on disk for the next one,
        // and that attempt's own before/after diff cannot see it (mx5 run 19).
        const l = new AutofixLedger(3)
        l.wroteIgnored(['.env'])
        l.wroteIgnored(['.env', 'dist/app.js'])
        l.wroteIgnored(undefined)
        l.wroteIgnored([])
        expect(l.ignoredWrites()).toEqual(['.env', 'dist/app.js'])
    })

    test('stranded work is REPLACED each attempt, not accumulated', () => {
        const l = new AutofixLedger(3)
        l.setStranded(['src/a.ts', 'src/b.ts'])
        l.setStranded(['src/c.ts'])
        expect(l.stranded()).toEqual(['src/c.ts'])
    })

    test('rejected edits in the tree close the commit gate permanently', () => {
        // The cheat guard is never weakened to ease committing (mx5 run 14 item 2b).
        const l = new AutofixLedger(3)
        expect(l.mayCommitTree()).toBe(true)
        l.rejectedEditsRemain()
        expect(l.mayCommitTree()).toBe(false)
        l.setStranded(['src/a.ts'])
        expect(l.mayCommitTree()).toBe(false)
    })
})
