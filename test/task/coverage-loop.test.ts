import {expect, test, describe} from 'bun:test'
import {
    decideAdoption,
    droppedCoverage,
    groundedCoverage,
    type CoveragePlan
} from '../../src/task/coverage-loop.js'
import {
    accountCoverage,
    ownedRequirementIndices,
    isCrossCuttingRequirement,
    type ReqMapping,
    type RequirementEntry
} from '../../src/task/requirements.js'

// ─── isCrossCuttingRequirement (Fix A) ───────────────────────────────────────
// A requirement no task can OWN — a prohibition or a product-global policy — must
// be classified cross-cutting so it stops driving the coverage loop's regeneration.
// Precision matters: an ordinary ownable feature line must NOT be swept up (that
// would blunt the gate), so both directions are locked here.
describe('isCrossCuttingRequirement', () => {
    test('prohibitions are cross-cutting (no task delivers an absence)', () => {
        for (const q of [
            'the tool must never delete a file without an explicit --apply flag',
            'the library must have no runtime dependencies',
            'credentials must not be written to disk',
            'the parser shall not mutate its input',
            'requests cannot exceed the configured rate limit',
            'neither stdout nor stderr may contain secrets'
        ]) {
            expect(isCrossCuttingRequirement(q)).toBe(true)
        }
    })

    test('product-global policies (scope word + modal) are cross-cutting', () => {
        for (const q of [
            'every stage must emit structured logs throughout the pipeline',
            'error messages must be consistent across the entire CLI',
            'the audit trail must be written app-wide'
        ]) {
            expect(isCrossCuttingRequirement(q)).toBe(true)
        }
    })

    test('ordinary ownable feature statements are NOT cross-cutting', () => {
        for (const q of [
            'the CLI scans a directory tree for duplicate files',
            'a --json flag emits machine-readable output',
            'a summary report lists reclaimed space',
            'malformed records are routed to a dead-letter queue',
            'serializes a Range back to a canonical string',
            'supports IANA timezone-aware ranges',
            'the dashboard lists all uploaded photos' // bare "all", no modal → ownable
        ]) {
            expect(isCrossCuttingRequirement(q)).toBe(false)
        }
    })
})

// ─── decideAdoption (Fix B/C) ─────────────────────────────────────────────────
describe('decideAdoption', () => {
    const plan = (titles: number, covered: number[], missing: string[] = []): CoveragePlan => ({
        titles: Array.from({length: titles}, (_, i) => `t${i}`),
        covered: new Set(covered),
        missing
    })

    test('rejects a retry that drops an owned requirement (non-superset)', () => {
        const d = decideAdoption(plan(2, [0, 1]), plan(2, [0, 2]), true)
        expect(d.adopt).toBe(false)
        expect(d.dropped).toEqual([1])
    })

    test('adopts a strict superset (real improvement is not frozen out)', () => {
        const d = decideAdoption(plan(2, [0, 1]), plan(3, [0, 1, 2]), true)
        expect(d.adopt).toBe(true)
        expect(d.dropped).toEqual([])
    })

    test('adopts an equal owned-set at equal size (side-grade allowed)', () => {
        expect(decideAdoption(plan(3, [0, 1]), plan(3, [0, 1]), true).adopt).toBe(true)
    })

    test('adopts an equal owned-set in FEWER titles (the smaller plan wins)', () => {
        // Bounded by the collapse floor above: a retry under HALF the current
        // title count is still the degenerate flake and is rejected on that rule,
        // so "smallest among equals" only ranges down to half.
        expect(decideAdoption(plan(9, [0, 1]), plan(5, [0, 1]), true).adopt).toBe(true)
        expect(decideAdoption(plan(9, [0, 1]), plan(4, [0, 1]), true).reason).toContain(
            'collapse floor'
        )
    })

    // ── the zero-gain growth tiebreak ────────────────────────────────────────
    // mx5 2026-07-28 went 26 → 32 → 60 titles with the owned-set pinned at 27 in
    // all three rounds, both retries adopted as "preserves owned coverage". The
    // old rule could not object: past the drop check the retry's owned-set is a
    // superset, and groundedCoverage is monotone in the title set while the
    // reprompt explicitly asks for a superset of the previous titles.
    test('rejects growth that buys no new coverage', () => {
        const d = decideAdoption(plan(26, [0, 1, 2]), plan(60, [0, 1, 2]), true)
        expect(d.adopt).toBe(false)
        expect(d.reason).toContain('no coverage gain')
        expect(d.reason).toContain('+34 titles')
        expect(d.dropped).toEqual([])
    })

    test('growth that DOES buy coverage is still adopted', () => {
        expect(decideAdoption(plan(26, [0, 1]), plan(60, [0, 1, 2]), true).adopt).toBe(true)
    })

    test('the tiebreak can never decline a strictly better plan', () => {
        // Structural, not statistical: the clause is reachable only when the retry
        // covers NO MORE than the current plan. Any strict gain adopts at any size
        // the collapse floor allows (>= half the current count).
        for (const size of [2, 5, 40, 400]) {
            expect(decideAdoption(plan(4, [0]), plan(size, [0, 1]), true).adopt).toBe(true)
        }
    })

    test('the tiebreak is off without a requirement signal', () => {
        // No owned-set to compare, so size alone must never reject — the
        // no-requirements path keeps its count-floor + missing-area rule.
        expect(decideAdoption(plan(3, [], ['a']), plan(30, [], ['a']), false).adopt).toBe(true)
    })

    test('collapse floor still rejects the one-task degenerate retry', () => {
        const d = decideAdoption(plan(4, [0, 1, 2]), plan(1, [0, 1, 2, 3]), true)
        expect(d.adopt).toBe(false)
        expect(d.reason).toContain('collapse floor')
    })

    test('empty retry is rejected', () => {
        expect(decideAdoption(plan(3, [0]), plan(0, []), true).adopt).toBe(false)
    })

    test('no-requirements path: count floor + no missing-area regression', () => {
        // Superset check is inert (no owned reqs), so the count floor and the
        // uncovered-area count decide — a retry that leaves MORE uncovered is refused.
        expect(decideAdoption(plan(3, [], ['a']), plan(3, [], ['a']), false).adopt).toBe(true)
        expect(decideAdoption(plan(3, [], ['a']), plan(3, [], ['a', 'b']), false).adopt).toBe(false)
        expect(decideAdoption(plan(3, [], ['a']), plan(1, [], []), false).adopt).toBe(false)
    })
})

// ─── A/B harness: baseline reproduces the drop, treatment prevents it ─────────
//
// The failure class (spec-agnostic): a coverage-retry regenerates the WHOLE plan,
// drops a feature-area the current plan already covered, and — because the loop
// adopts on a size floor alone and ships the last round — the covered area is lost.
// Un-ownable NEGATIVE/GLOBAL requirements keep the verdict INCOMPLETE, so the loop
// keeps regenerating and rolling that dice.
//
// This drives the SAME fixtures through the OLD algorithm (baseline: last-wins +
// size floor, negatives counted as uncovered) and the NEW one (treatment:
// monotonic adoption via the shipping decideAdoption + negatives classified
// cross-cutting via the shipping accountCoverage). Three NON-web archetypes prove
// the fix is the class, not a web-app special case.

interface AreaReq {
    quote: string
    /** The feature-area a task owns to satisfy it; null ⇒ un-ownable (negative/global). */
    area: string | null
}
interface FixturePlan {
    titles: string[]
    /** The feature-areas this plan's tasks cover. */
    areas: Set<string>
}
interface Archetype {
    name: string
    reqs: AreaReq[]
    /** rounds[0] = initial decompose; rounds[1..] = successive regenerations. */
    rounds: FixturePlan[]
    /** The area the initial plan covers that the regeneration drops. */
    droppedArea: string
}

const MAX_ROUNDS = 2

// Deterministic coverage-map: a task owns a requirement iff the plan covers its
// area; un-ownable requirements always map NONE (no task can own them). Mirrors
// what the model's per-requirement map produces, minus the stochasticity.
function mapPlan(reqs: AreaReq[], p: FixturePlan): ReqMapping[] {
    return reqs.map(r => (r.area && p.areas.has(r.area) ? {kind: 'task', task: 1} : {kind: 'none'}))
}

function scorePlan(
    reqs: AreaReq[],
    p: FixturePlan,
    mode: 'baseline' | 'treatment'
): {covered: Set<number>; missing: string[]} {
    const mappings = mapPlan(reqs, p)
    const entries: RequirementEntry[] = reqs.map(r => ({quote: r.quote, anchor: ''}))
    // The monotonic guard's owned-set: TREATMENT grounds it in requirement↔title
    // overlap (the shipping function, model-independent); BASELINE used the model's
    // TASK verdicts (here the accurate area-map — the baseline's drop comes from
    // last-wins, not over-crediting, which the groundedCoverage tests cover).
    const covered =
        mode === 'treatment' ?
            groundedCoverage(
                reqs.map(r => r.quote),
                p.titles,
                isCrossCuttingRequirement
            )
        :   ownedRequirementIndices(mappings)
    const missing =
        mode === 'treatment' ?
            // Shipping code path: negatives/globals land in cross-cutting, not unmapped.
            accountCoverage(entries, mappings).unmapped.map(e => `"${e.quote}"`)
            // Old behaviour: EVERY NONE (including un-ownable ones) is "missing".
        :   mappings.flatMap((m, i) => (m.kind === 'none' ? [`"${entries[i].quote}"`] : []))
    return {covered, missing}
}

const planAt = (a: Archetype, i: number): FixturePlan => a.rounds[Math.min(i, a.rounds.length - 1)]

/** OLD algorithm: re-judge current, regenerate on any missing, overwrite on the
 *  size floor alone, ship the LAST plan. */
function runBaseline(a: Archetype): FixturePlan {
    let curIdx = 0
    for (let round = 0; round < MAX_ROUNDS; round++) {
        const cur = scorePlan(a.reqs, planAt(a, curIdx), 'baseline')
        if (cur.missing.length === 0) break
        const cand = planAt(a, round + 1)
        if (cand.titles.length > 0 && cand.titles.length * 2 >= planAt(a, curIdx).titles.length) {
            curIdx = round + 1 // last-wins overwrite, coverage unchecked
        }
    }
    return planAt(a, curIdx)
}

/** NEW algorithm: monotonic adoption (shipping decideAdoption) + cross-cutting
 *  classification, ship the best (== the monotone working plan). */
function runTreatment(a: Archetype): FixturePlan {
    let bestIdx = 0
    let best = scorePlan(a.reqs, planAt(a, 0), 'treatment')
    let round = 0
    for (;;) {
        if (best.missing.length === 0) break
        if (round >= MAX_ROUNDS) break
        round++
        const cand = planAt(a, round)
        const candScore = scorePlan(a.reqs, cand, 'treatment')
        const decision = decideAdoption(
            {titles: planAt(a, bestIdx).titles, covered: best.covered, missing: best.missing},
            {titles: cand.titles, covered: candScore.covered, missing: candScore.missing},
            true
        )
        if (decision.adopt) {
            bestIdx = round
            best = candScore
        }
    }
    return planAt(a, bestIdx)
}

/** Does the shipped plan still OWN a task for `area`? Grounded (the real check). */
function ownsArea(a: Archetype, shipped: FixturePlan, area: string): boolean {
    const owned = groundedCoverage(
        a.reqs.map(r => r.quote),
        shipped.titles,
        isCrossCuttingRequirement
    )
    return a.reqs.some((r, i) => r.area === area && owned.has(i))
}

const ARCHETYPES: Archetype[] = [
    {
        // 1) CLI tool.
        name: 'file-deduplication CLI',
        droppedArea: 'json-output',
        reqs: [
            {quote: 'the CLI scans a directory tree for duplicate files', area: 'scan'},
            {quote: 'a --json flag emits machine-readable output', area: 'json-output'},
            {quote: 'a summary report lists reclaimed space', area: 'report'},
            {
                quote: 'the tool must never delete a file without an explicit --apply flag',
                area: null
            }
        ],
        rounds: [
            {
                titles: ['Scan for duplicates', 'Add --json output'],
                areas: new Set(['scan', 'json-output'])
            },
            {titles: ['Scan for duplicates', 'Summary report'], areas: new Set(['scan', 'report'])},
            {titles: ['Scan for duplicates', 'Summary report'], areas: new Set(['scan', 'report'])}
        ]
    },
    {
        // 2) Data pipeline / ETL.
        name: 'streaming ETL pipeline',
        droppedArea: 'dead-letter',
        reqs: [
            {quote: 'records are ingested from the source topic', area: 'ingest'},
            {quote: 'malformed records are routed to a dead-letter queue', area: 'dead-letter'},
            {quote: 'pipeline throughput is exported as metrics', area: 'metrics'},
            {quote: 'every stage must emit structured logs throughout the pipeline', area: null}
        ],
        rounds: [
            {
                titles: ['Ingest stage', 'Dead-letter routing'],
                areas: new Set(['ingest', 'dead-letter'])
            },
            {titles: ['Ingest stage', 'Metrics export'], areas: new Set(['ingest', 'metrics'])},
            {titles: ['Ingest stage', 'Metrics export'], areas: new Set(['ingest', 'metrics'])}
        ]
    },
    {
        // 3) Library.
        name: 'date-range parsing library',
        droppedArea: 'serialize',
        reqs: [
            {quote: 'parses ISO-8601 date ranges into a Range object', area: 'parse'},
            {quote: 'serializes a Range back to a canonical string', area: 'serialize'},
            {quote: 'supports IANA timezone-aware ranges', area: 'timezone'},
            {quote: 'the library must have no runtime dependencies', area: null}
        ],
        rounds: [
            {titles: ['Parse ranges', 'Serialize ranges'], areas: new Set(['parse', 'serialize'])},
            {titles: ['Parse ranges', 'Timezone support'], areas: new Set(['parse', 'timezone'])},
            {titles: ['Parse ranges', 'Timezone support'], areas: new Set(['parse', 'timezone'])}
        ]
    }
]

test('A/B: monotonic coverage loop — baseline drops the covered area, treatment keeps it', () => {
    let baselineKept = 0
    let treatmentKept = 0
    for (const a of ARCHETYPES) {
        if (ownsArea(a, runBaseline(a), a.droppedArea)) baselineKept++
        if (ownsArea(a, runTreatment(a), a.droppedArea)) treatmentKept++
    }
    // Explicit before/after counts (also the paste-able A/B result).

    console.log(
        `[A/B coverage-loop] area retained — baseline ${baselineKept}/${ARCHETYPES.length}`
            + ` → treatment ${treatmentKept}/${ARCHETYPES.length}`
    )
    // BASELINE reproduces the regression on every archetype; TREATMENT prevents it.
    expect(baselineKept).toBe(0)
    expect(treatmentKept).toBe(ARCHETYPES.length)
})

test('A/B: a genuine SUPERSET regeneration is still adopted under treatment', () => {
    // Guards against over-correction: the monotonic rule must reject drops, not
    // freeze the first plan. Here the retry ADDS the missing area and drops nothing.
    const a: Archetype = {
        name: 'CLI — improving retry',
        droppedArea: 'report',
        reqs: ARCHETYPES[0].reqs,
        rounds: [
            {titles: ['Scan', 'Add --json output'], areas: new Set(['scan', 'json-output'])},
            {
                titles: ['Scan', 'Add --json output', 'Summary report'],
                areas: new Set(['scan', 'json-output', 'report'])
            }
        ]
    }
    const shipped = runTreatment(a)
    expect(ownsArea(a, shipped, 'report')).toBe(true) // improvement adopted
    expect(ownsArea(a, shipped, 'json-output')).toBe(true) // and nothing dropped
})

// ─── groundedCoverage — the model-independent owned-set (live-A/B-driven) ─────
//
// The live A/B (Qwen3.6-27B) exposed that the coverage-map model OVER-CREDITS
// ownership: it mapped a "--json output" requirement to a generic "scaffold +
// argument parser" task, so a plan with no --json task still reported owning it,
// and the monotonic guard — trusting those TASK numbers — dropped the area anyway
// (treatment held only 1/5). groundedCoverage takes the drop-signal off the model
// and onto requirement↔title token overlap, which the model cannot inflate.
const noCross = () => false
describe('groundedCoverage', () => {
    test('a requirement is covered only when a TITLE shares a distinctive token', () => {
        const quotes = [
            'a --json flag makes it emit machine-readable output',
            'a summary report prints total reclaimed space'
        ]
        const covered = groundedCoverage(
            quotes,
            ['Add the --json machine-readable output mode', 'Read ignore filters'],
            noCross
        )
        expect(covered.has(0)).toBe(true) // "json"/"output" appear in a title
        expect(covered.has(1)).toBe(false) // no title mentions report/reclaimed/space
    })

    test('REGRESSION (live over-crediting): a plan with no --json task does NOT own it', () => {
        // The exact failure: the model maps "--json" → the scaffold/parser task, so
        // ownedRequirementIndices would say owned. groundedCoverage must not — no
        // title carries a --json/machine-readable token.
        const quotes = [
            'a --json flag makes it emit machine-readable output instead of the human table'
        ]
        const dropPlan = [
            'Scaffold the dedupe CLI entrypoint and argument parser',
            'Implement content-hash scanning to group duplicate files',
            'Print a summary report of total reclaimed space'
        ]
        expect(groundedCoverage(quotes, dropPlan, noCross).has(0)).toBe(false)
        // …and the plan that DOES have the task owns it — so the guard sees the drop.
        const goodPlan = ['Scaffold CLI', 'Add the --json machine-readable output mode']
        expect(groundedCoverage(quotes, goodPlan, noCross).has(0)).toBe(true)
    })

    test('plural/verb-s normalization: scan/scans, file/files, serialize/serializes match', () => {
        expect(
            groundedCoverage(
                ['scans a directory for files'],
                ['Scan directory, list file'],
                noCross
            ).has(0)
        ).toBe(true)
        expect(
            groundedCoverage(['serializes a Range'], ['Range serialize step'], noCross).has(0)
        ).toBe(true)
    })

    test('cross-cutting requirements are excluded (plan-independent, cannot be dropped)', () => {
        const quotes = ['all output must be plain ASCII with no colour codes']
        // Even though a title mentions ASCII, a cross-cutting req is never in the set.
        expect(groundedCoverage(quotes, ['Render ASCII table'], () => true).size).toBe(0)
    })

    test('ubiquitous words alone do not manufacture coverage', () => {
        // Overlap only on stopwords (the/a/cli/add/mode…) must NOT count as covered.
        expect(groundedCoverage(['the CLI adds a mode'], ['Build the CLI app'], noCross).size).toBe(
            0
        )
    })
})

describe('droppedCoverage', () => {
    test('reports exactly the indices lost', () => {
        expect(droppedCoverage(new Set([0, 1, 2]), new Set([0, 2]))).toEqual([1])
        expect(droppedCoverage(new Set([0, 1]), new Set([0, 1, 5]))).toEqual([])
    })
})
