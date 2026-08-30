/**
 * GateTally, driven directly. Every recording a gate section would make is written
 * by hand here, so no temp dir and no child process is needed: PASS / FAIL /
 * UNOBSERVED polarity, note ordering, debt attachment, and silent()/blindness()
 * are all decidable from the tally alone. The behaviour oracle for the whole gate
 * stays final-gate.test.ts.
 */
import {describe, expect, test} from 'bun:test'
import {GateTally, unobservedVerdict} from '../../src/task/gate-tally.js'
import type {AcceptDebt} from '../../src/task/accept-debt.js'

const noDebts = {openDebts: [] as AcceptDebt[]}
const debt: AcceptDebt = {taskId: 'TASK_0003', reason: 'verify FAIL: admin page 404s'}

describe('GateTally.verdict — PASS', () => {
    test('observed passes → statics + the ran labels, no unobserved field', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.ran('bun run test')
        t.attempted('bun')
        t.observed()
        t.ran('bun run build')
        const v = t.verdict(noDebts)
        expect(v).toEqual({
            ok: true,
            reason: 'statics + `bun run test`, `bun run build` passed',
            openDebts: []
        })
        expect(v.unobserved).toBeUndefined()
        expect(v.failures).toBeUndefined()
    })

    test('warnings append in order after the pass reason', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.ran('bun run test')
        t.warn('first')
        t.warn('second')
        expect(t.verdict(noDebts).reason).toBe(
            'statics + `bun run test` passed — WARNING: first; WARNING: second'
        )
    })

    test('a boot skip is UNOBSERVED even when the test suite ran (run 18)', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.ran('bun run test')
        t.attempted('bun')
        t.bootUnobserved('boot check: `bun run start` skipped')
        const v = t.verdict(noDebts)
        expect(v.ok).toBe(true)
        expect(v.unobserved).toBe('boot check: `bun run start` skipped')
        expect(v.reason).toBe(
            'boot check: `bun run start` skipped — statics + `bun run test` passed'
        )
    })
})

describe('GateTally.verdict — FAIL', () => {
    test('one failure keeps the exact single-failure wording', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.fail('`bun run test` exited 1 — boom')
        const v = t.verdict(noDebts)
        expect(v.ok).toBe(false)
        expect(v.reason).toBe('`bun run test` exited 1 — boom')
        expect(v.failures).toEqual(['`bun run test` exited 1 — boom'])
        expect(v.observedFailures).toBeUndefined()
        expect(v.unobserved).toBeUndefined()
    })

    test('several failures rank boot/render (rank 0) first, then execution order', () => {
        const t = new GateTally()
        t.fail('static checks: lint')
        t.fail('`bun run test` exited 1')
        t.fail('boot check: `bun run start` could not bind', 0)
        t.fail('dangling artifact: dist/index.html')
        const v = t.verdict(noDebts)
        expect(v.failures).toEqual([
            'boot check: `bun run start` could not bind',
            'static checks: lint',
            '`bun run test` exited 1',
            'dangling artifact: dist/index.html'
        ])
        expect(v.reason).toBe(
            '4 failures (ranked, most load-bearing first):\n'
                + '1. boot check: `bun run start` could not bind\n'
                + '2. static checks: lint\n'
                + '3. `bun run test` exited 1\n'
                + '4. dangling artifact: dist/index.html'
        )
    })

    test('failObserved rides along in observedFailures by exact text identity (19A)', () => {
        const t = new GateTally()
        t.fail('`bun run test` exited 1')
        t.failObserved('boot check: `bun run start` rendered an empty body', 0)
        const v = t.verdict(noDebts)
        expect(v.observedFailures).toEqual(['boot check: `bun run start` rendered an empty body'])
        expect(v.failures?.[0]).toBe(v.observedFailures?.[0])
    })

    test('a failure wins over every UNOBSERVED note — the notes do not leak into a FAIL', () => {
        const t = new GateTally()
        t.bootUnobserved('boot skipped')
        t.configGap('config gap note')
        t.contractNote('inert contract note')
        t.warn('a warning')
        t.fail('static checks: tsc')
        const v = t.verdict(noDebts)
        expect(v.ok).toBe(false)
        expect(v.reason).toBe('static checks: tsc')
        expect(v.unobserved).toBeUndefined()
    })
})

describe('GateTally.verdict — UNOBSERVED', () => {
    test('nothing attempted → the zero-discovery note IS the reason (no statics suffix)', () => {
        const t = new GateTally()
        const v = t.verdict(noDebts)
        const note = unobservedVerdict({discovered: 0, observed: 0})
        expect(note).toContain('nothing at all')
        expect(v).toEqual({ok: true, unobserved: note!, reason: note!, openDebts: []})
    })

    test('nothing attempted + inert contract note → note follows the verdict, space-joined', () => {
        const t = new GateTally()
        t.contractNote('launch contract: no manifest to diff against')
        const v = t.verdict(noDebts)
        const expected = `${unobservedVerdict({discovered: 0, observed: 0})} launch contract: no manifest to diff against`
        expect(v.unobserved).toBe(expected)
        expect(v.reason).toBe(expected)
    })

    test('discovered but every attempt skipped → UNOBSERVED with the "not runnable here" suffix', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.attempted('bun')
        const v = t.verdict(noDebts)
        expect(v.ok).toBe(true)
        expect(v.unobserved).toBe(unobservedVerdict({discovered: 2, observed: 0})!)
        expect(v.reason).toBe(
            `${v.unobserved} — statics passed (integration commands not runnable here)`
        )
    })

    test('unobserve() un-counts a config-gap script exactly like a skip', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.unobserve()
        t.configGap('CONFIG GAP: seed needs ADMIN_PHONE')
        const v = t.verdict(noDebts)
        expect(v.ok).toBe(true)
        expect(v.unobserved).toBe(
            `${unobservedVerdict({discovered: 1, observed: 0})} CONFIG GAP: seed needs ADMIN_PHONE`
        )
    })

    test('note ordering: boot note, then the zero-observation verdict, then config gaps, then contract', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.contractNote('CONTRACT')
        t.configGap('GAP-1')
        t.configGap('GAP-2')
        t.bootUnobserved('BOOT')
        const v = t.verdict(noDebts)
        expect(v.unobserved).toBe(
            `BOOT ${unobservedVerdict({discovered: 1, observed: 0})} GAP-1 GAP-2 CONTRACT`
        )
    })

    test('an observed pass silences the zero-observation verdict but not the boot note', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.ran('bun run test')
        t.bootUnobserved(null)
        const v = t.verdict(noDebts)
        expect(v.unobserved).toBeUndefined()
        expect(v.reason).toBe('statics + `bun run test` passed')
    })
})

describe('GateTally.verdict — debts ride on every shape', () => {
    test('PASS carries openDebts + debtNote in their own fields, never in reason', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.observed()
        t.ran('bun run test')
        const v = t.verdict({openDebts: [debt], debtNote: 'DEBT NOTE'})
        expect(v.openDebts).toEqual([debt])
        expect(v.debtNote).toBe('DEBT NOTE')
        expect(v.reason).not.toContain('DEBT NOTE')
    })

    test('FAIL carries them too, and reason stays the mechanical failure (run 11)', () => {
        const t = new GateTally()
        t.fail('`bun run test` exited 1')
        const v = t.verdict({openDebts: [debt], debtNote: 'DEBT NOTE'})
        expect(v.ok).toBe(false)
        expect(v.openDebts).toEqual([debt])
        expect(v.debtNote).toBe('DEBT NOTE')
        expect(v.reason).toBe('`bun run test` exited 1')
    })

    test('the zero-attempt UNOBSERVED shape carries them as well', () => {
        const v = new GateTally().verdict({openDebts: [debt], debtNote: 'DEBT NOTE'})
        expect(v.openDebts).toEqual([debt])
        expect(v.debtNote).toBe('DEBT NOTE')
    })

    test('no debtNote → the field is absent, not empty', () => {
        const v = new GateTally().verdict({openDebts: []})
        expect('debtNote' in v).toBe(false)
    })
})

describe('GateTally — silent() and blindness()', () => {
    test('silent until an attempt or a failure is recorded', () => {
        const t = new GateTally()
        expect(t.silent()).toBe(true)
        t.contractNote('note')
        t.warn('warn')
        expect(t.silent()).toBe(true)
        t.fail('x')
        expect(t.silent()).toBe(false)
        const u = new GateTally()
        u.attempted('bun')
        expect(u.silent()).toBe(false)
    })

    test('blindness fires only when every attempt spawn-failed and names the runner', () => {
        const t = new GateTally()
        t.attempted('bun')
        t.spawnFailure('bun')
        expect(t.blindness(() => false)).toContain('`bun` is not spawnable')
        expect(t.blindness(() => true)).toContain('observability gap: 1')
        t.attempted('bun')
        t.observed()
        expect(t.blindness(() => false)).toBeNull()
    })
})
