/**
 * The quality half of the research fan-out A/B, which has now been wrong twice.
 *
 * Run 1: it compared ABSOLUTE ungrounded counts, so a section that grew tripped
 * the guard for being bigger. Run 2 (n=3, fixed instrument): the baseline timed
 * out 12/12 and FIVE of those trials shipped a one-entry stub with zero symbols
 * — a 0.0% fabrication rate that nothing can beat. Both times the invariant
 * reported a clean number over data that could not support one.
 *
 * These cases pin the shape of the data, not the verdict of any arm.
 */
import {describe, expect, test} from 'bun:test'
import {scoreQuality, type TrialResult} from './live-research-fanout-budget-ab.js'
import {judge} from './ab-verdict.js'

const trial = (taskId: string, over: Partial<TrialResult>): TrialResult =>
    ({
        arm: 'baseline',
        taskId,
        trial: 0,
        commit: 'abc1234',
        workerTimeouts: 0,
        attempts: 1,
        restartReasons: [],
        apisWallMs: 400_000,
        phaseWallMs: 400_000,
        projectLookups: 30,
        retrievalCalls: 30,
        packageLookups: 0,
        budgetRefusals: 0,
        degraded: false,
        salvaged: false,
        entries: 30,
        withSignature: 29,
        symbols: 35,
        ungroundedSymbols: 0,
        synthesizedApis: 0,
        apisSection: '',
        ...over
    }) as TrialResult

/** The stub a degraded worker actually shipped: one line, no API symbols. */
const stub = (taskId: string): TrialResult =>
    trial(taskId, {degraded: true, entries: 1, withSignature: 1, symbols: 0, ungroundedSymbols: 0})

describe('scoreQuality', () => {
    test('a zero-symbol baseline cannot be beaten, so it is UNSCORABLE not clean', () => {
        // Verbatim shape of progress-arm TASK_0021: baseline degraded to a stub on
        // all three trials; the treatment wrote 28 entries with one real-but-
        // unretrieved symbol and was scored as a regression against it.
        const base = [stub('TASK_0021'), stub('TASK_0021'), stub('TASK_0021')]
        const treat = [
            trial('TASK_0021', {entries: 36, withSignature: 33, symbols: 82, ungroundedSymbols: 1}),
            trial('TASK_0021', {entries: 25, withSignature: 24, symbols: 36})
        ]
        const {qualityBreaks, unscorable} = scoreQuality(['TASK_0021'], base, treat)
        expect(qualityBreaks).toEqual([])
        expect(unscorable).toHaveLength(1)
        expect(unscorable[0]).toContain('TASK_0021 grounding')
    })

    test('unscorable ABSTAINS the verdict — it must never read as a pass', () => {
        const v = judge({
            name: 'fixture',
            reps: 3,
            targetShape: 'worker-timeout restart',
            baselineHits: 3,
            treatmentHits: 0,
            invariants: [{label: 'inv-quality-not-worse', ok: true}],
            unmeasured: ['TASK_0021 grounding: 0/3 baseline trial(s) produced a section with symbols']
        })
        expect(v.outcome).toBe('ABSTAIN')
        expect(v.lines.join('\n')).toContain('NO EVIDENCE UNDER IT')
    })

    test('a MEASURED break still fails, even alongside an unscorable fixture', () => {
        const v = judge({
            name: 'fixture',
            reps: 3,
            targetShape: 'worker-timeout restart',
            baselineHits: 3,
            treatmentHits: 0,
            invariants: [{label: 'inv-quality-not-worse', ok: false}],
            unmeasured: ['TASK_0021 grounding: nothing to compare']
        })
        expect(v.outcome).toBe('FAIL')
    })

    test('a treatment that ships MORE empty sections breaks the invariant', () => {
        // The gaming route the filter opens: drop your own stubs out of the
        // comparison and the survivors look clean.
        const base = [trial('TASK_0020', {}), trial('TASK_0020', {})]
        const treat = [trial('TASK_0020', {}), stub('TASK_0020')]
        const {qualityBreaks} = scoreQuality(['TASK_0020'], base, treat)
        expect(qualityBreaks.join('; ')).toContain('empty sections 0/2→1/2')
    })

    test('signature coverage is still absolute, over ALL trials', () => {
        // A treatment answering less must not hide behind the scorable filter.
        const base = [trial('TASK_0017', {withSignature: 30})]
        const treat = [trial('TASK_0017', {withSignature: 12})]
        const {qualityBreaks} = scoreQuality(['TASK_0017'], base, treat)
        expect(qualityBreaks.join('; ')).toContain('signatures 30.0→12.0')
    })

    test('with symbols on both sides the rate comparison still bites', () => {
        const base = [trial('TASK_0019', {symbols: 40, ungroundedSymbols: 1})]
        const treat = [trial('TASK_0019', {symbols: 40, ungroundedSymbols: 8})]
        const {qualityBreaks, unscorable} = scoreQuality(['TASK_0019'], base, treat)
        expect(unscorable).toEqual([])
        expect(qualityBreaks.join('; ')).toContain('ungrounded 2.5%→20.0%')
    })
})
