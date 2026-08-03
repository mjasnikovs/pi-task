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
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {describe, expect, test} from 'bun:test'
import {
    scoreLowFanout,
    scoreQuality,
    scoreTimeToAnswer,
    type TrialResult
} from './live-research-fanout-budget-ab.js'
import {checkpointSourceText, isProjectSourcePath} from './run15-fixture-tree.js'
import {channelsFor} from './apis-trajectory.js'
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

describe('scoreLowFanout', () => {
    test('a control invariant with no controls under it is UNMEASURED, not HOLDS', () => {
        // The n=3 run: no control fixture was run at all, the loop found no
        // breaks, and zero breaks printed as "controls unchanged".
        const base = [trial('TASK_0019', {})]
        const treat = [trial('TASK_0019', {})]
        const {lowBreaks, unmeasured} = scoreLowFanout(base, treat)
        expect(lowBreaks).toEqual([])
        expect(unmeasured).toHaveLength(3)
        expect(unmeasured.join('\n')).toContain('TASK_0001 control')
        expect(judge({
            name: 'fixture',
            reps: 3,
            targetShape: 'worker-timeout restart',
            baselineHits: 3,
            treatmentHits: 0,
            invariants: [{label: 'inv-low-fanout-untouched', ok: true}],
            unmeasured
        }).outcome).toBe('ABSTAIN')
    })

    test('a control that ran and broke still FAILS — unmeasured is not an escape', () => {
        const base = [trial('TASK_0003', {apisWallMs: 65_000, entries: 17})]
        const treat = [trial('TASK_0003', {apisWallMs: 200_000, entries: 17})]
        const {lowBreaks, unmeasured} = scoreLowFanout(base, treat)
        expect(lowBreaks.join('; ')).toContain('TASK_0003 wall 65s→200s')
        // The other two controls are still missing, so both channels report.
        expect(unmeasured).toHaveLength(2)
    })

    test('an entry floor and a budget refusal on a control both break it', () => {
        const base = [trial('TASK_0004', {entries: 17})]
        const treat = [trial('TASK_0004', {entries: 12, budgetRefusals: 2})]
        const {lowBreaks} = scoreLowFanout(base, treat)
        expect(lowBreaks.join('; ')).toContain('entries 17.0→12.0')
        expect(lowBreaks.join('; ')).toContain('budget fired 2×')
    })
})

describe('scoreTimeToAnswer', () => {
    test('a baseline pinned at the cap is censored — it cannot set the bar', () => {
        // Verbatim shape of the n=3 run: baseline timed out 3/3 at 3x240s and
        // degraded; the raw means (720s vs 650s) were reported as HOLDS.
        const base = [
            stub('TASK_0020'),
            stub('TASK_0020'),
            trial('TASK_0020', {apisWallMs: 720_000, workerTimeouts: 3, degraded: true})
        ]
        const treat = [trial('TASK_0020', {apisWallMs: 650_000})]
        const {invariant, unmeasured, descriptive} = scoreTimeToAnswer(['TASK_0020'], base, treat)
        expect(invariant.unmeasured).toBe(true)
        expect(unmeasured).toHaveLength(1)
        expect(descriptive.join('\n')).toContain('CENSORED')
        // and it abstains rather than crediting the lever with 720s → 650s
        expect(
            judge({
                name: 'fixture',
                reps: 3,
                targetShape: 'worker-timeout restart',
                baselineHits: 3,
                treatmentHits: 0,
                invariants: [invariant],
                unmeasured
            }).outcome
        ).toBe('ABSTAIN')
    })

    test('conditioning on the trials that ANSWERED is censored too, so it abstains', () => {
        // The v2 shape, and the reason this metric is not "mean over answered
        // trials": baseline answered in exactly the trials that got there in two
        // attempts, so the survivors are its fastest third. Scored that way the
        // progress arm — which answered every trial — read as 390s → 637s WORSE.
        const base = [
            trial('TASK_0017', {apisWallMs: 425_000, workerTimeouts: 1}),
            trial('TASK_0017', {apisWallMs: 375_000, workerTimeouts: 1}),
            stub('TASK_0017')
        ]
        const treat = [
            trial('TASK_0017', {apisWallMs: 482_000}),
            trial('TASK_0017', {apisWallMs: 979_000}),
            trial('TASK_0017', {apisWallMs: 654_000})
        ]
        const {invariant, unmeasured, descriptive} = scoreTimeToAnswer(['TASK_0017'], base, treat)
        expect(invariant.unmeasured).toBe(true)
        expect(unmeasured.join('')).toContain('condition on which trials answered')
        expect(descriptive.join('\n')).toContain('usable answer 2/3')
        expect(descriptive.join('\n')).toContain('usable answer 3/3')
    })

    test('a fixture that answered in EVERY trial of both arms IS compared', () => {
        const base = [
            trial('TASK_0017', {apisWallMs: 500_000, workerTimeouts: 1}),
            trial('TASK_0017', {apisWallMs: 500_000, workerTimeouts: 1})
        ]
        const treat = [
            trial('TASK_0017', {apisWallMs: 300_000}),
            trial('TASK_0017', {apisWallMs: 300_000})
        ]
        const {invariant, unmeasured} = scoreTimeToAnswer(['TASK_0017'], base, treat)
        expect(unmeasured).toEqual([])
        expect(invariant.unmeasured).toBeUndefined()
        expect(invariant.ok).toBe(true)
        expect(invariant.detail).toContain('500s → 300s')
    })

    test('a treatment that is SLOWER on such a fixture breaks it', () => {
        const base = [trial('TASK_0017', {apisWallMs: 300_000})]
        const treat = [trial('TASK_0017', {apisWallMs: 500_000})]
        expect(scoreTimeToAnswer(['TASK_0017'], base, treat).invariant.ok).toBe(false)
    })
})

// ─── the project-source grounding channel ────────────────────────────────────

describe('isProjectSourcePath', () => {
    test('committed build output is NOT project source', () => {
        // This is the whole guard. mx5 tracks .playwright-cache/assets/*.js —
        // vendored minified UI bundles containing `Textarea` at every commit.
        expect(isProjectSourcePath('.playwright-cache/assets/index-2axqSmyf.js')).toBe(false)
        expect(isProjectSourcePath('dist/app.js')).toBe(false)
        expect(isProjectSourcePath('build/index.css')).toBe(false)
        expect(isProjectSourcePath('node_modules/wouter/index.js')).toBe(false)
        expect(isProjectSourcePath('src/client/app.js.map')).toBe(false)
        expect(isProjectSourcePath('public/vendor.min.js')).toBe(false)
        expect(isProjectSourcePath('bun.lock')).toBe(false)
    })

    test('agent-owned and prose files are NOT project source either', () => {
        // A task file naming a component the worker must CREATE, or a skill doc
        // listing every shadcn component, would ground symbols the project does
        // not contain.
        expect(isProjectSourcePath('.pi-tasks/TASK_0019.md')).toBe(false)
        expect(isProjectSourcePath('.pi/skills/shadcn/rules/forms.md')).toBe(false)
        expect(isProjectSourcePath('DESIGN/PROJECT.md')).toBe(false)
    })

    test('hand-authored source IS', () => {
        expect(isProjectSourcePath('src/client/components/ui/Textarea.tsx')).toBe(true)
        expect(isProjectSourcePath('src/server/routes/listings.ts')).toBe(true)
        expect(isProjectSourcePath('src/client/index.css')).toBe(true)
        expect(isProjectSourcePath('package.json')).toBe(true)
    })
})

describe('the projectTree channel', () => {
    const corpus = (projectTree: string) => ({
        prompt: '',
        docsProject: '',
        docsPackage: '',
        reads: '',
        projectTree
    })

    test('a symbol in the project source is grounded even if never retrieved', () => {
        // RETRIEVAL-GAP: `$delete` was flagged as a fabrication while sitting in
        // the fixture's own src/client/api.ts:143.
        expect(channelsFor('$delete', corpus('export const api = {$delete}'))).toEqual([
            'project-tree'
        ])
    })

    test('a symbol absent from the project source is STILL a fabrication', () => {
        expect(channelsFor('Textarea', corpus('export function Input() {}'))).toEqual([])
    })

    test('omitting the channel leaves every other scorer untouched', () => {
        const four = {prompt: '', docsProject: '', docsPackage: '', reads: 'Textarea'}
        expect(channelsFor('Textarea', four)).toEqual(['read'])
    })
})

/**
 * THE ANTI-GAMING PROPERTY, on the real trees rather than a fixture of one.
 *
 * `Textarea` is the single fabrication ever observed in this experiment (carry
 * arm, TASK_0019). Its checkpoint has no Textarea component; TASK_0020's does.
 * If the new channel grounds it on TASK_0019, the channel is too wide and the
 * quality guard is dead — so both directions are asserted against ~/hub/mx5
 * itself. Skipped where that evidence repo is not checked out.
 */
const MX5 = path.join(os.homedir(), 'hub', 'mx5')
/** `chore: checkpoint before …` for TASK_0019 and TASK_0020, as recorded in every trial JSON. */
const TASK_0019_TREE = 'e6440894c33be46846b29c4e446b039a8d0e95d3'
const TASK_0020_TREE = '154f02f3ee9090b25c4cc6e1a967dd5627afd61d'

describe.skipIf(!fs.existsSync(MX5))('checkpointSourceText, against the real fixture trees', () => {
    test('Textarea is a fabrication on TASK_0019 and grounded on TASK_0020', () => {
        expect(checkpointSourceText(TASK_0019_TREE)).not.toContain('Textarea')
        expect(checkpointSourceText(TASK_0020_TREE)).toContain('Textarea')
    })

    test('the symbols adjudicated real by hand are grounded', () => {
        const tree = checkpointSourceText(TASK_0020_TREE)
        for (const sym of ['Label', 'Badge', 'useLocation', 'Nav']) expect(tree).toContain(sym)
    })
})
