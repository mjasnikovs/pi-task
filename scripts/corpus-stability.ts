/**
 * Classify each corpus question by how STABLY it fails across repeated live reps.
 *
 * WHY THIS EXISTS — measured, not assumed. On 2026-07-21 the first two reps of
 * live-worker-validity-baseline came back with a near-identical aggregate:
 *
 *     rep 1  valid 61.9%   unclear 46   halluc-warn 43
 *     rep 2  valid 60.5%   unclear 47   halluc-warn 42
 *
 * which reads as a stable measurement. It is not. Underneath, 37 of 210 questions
 * (17.6%) FLIPPED their valid/invalid verdict between those two reps, and the churn is
 * almost entirely one counter: 41 questions flipped `excerptVerified`, exactly 1 flipped
 * `unclear`. The aggregate holds still only because the flips cancel.
 *
 * That distinction decides whether a question may be used as a FIXTURE. A question that
 * fails every rep is a deterministic fixture: put it in an A/B and a change in its
 * outcome is a lever effect. A question that fails half the time is a coin flip, and an
 * A/B built on it will show "improvements" that are resampling noise — the precise
 * failure mode ab-verdict.ts was written to make unmistakable. Aggregate stability cannot
 * tell these apart; only per-question flip rates can.
 *
 * So: `unclear` is nearly deterministic per question and is safe to build fixtures from.
 * `excerptVerified === false` is close to a coin flip on a fifth of the corpus and must
 * NOT be used as a per-question fixture signal — only as an aggregate counter over many
 * reps, which is how PROMPT 2's invariant 2 has to be evaluated.
 *
 * Pure and side-effect free; the CLI at the bottom is the only I/O.
 */

/** One scored (question, rep) observation, as live-worker-validity-baseline records it. */
export interface ResultRow {
    rep: number
    pkg: string
    query: string
    valid?: boolean
    unclear?: boolean
    hallucWarn?: boolean
    caveated?: boolean
    error?: string
}

export type Stability = 'always-valid' | 'always-invalid' | 'unstable'

export interface QuestionStability {
    pkg: string
    query: string
    /** Reps in which this question produced a scoreable answer. */
    reps: number
    invalid: number
    unclear: number
    hallucWarn: number
    /** Fraction of reps whose verdict differs from the question's majority verdict. */
    flipRate: number
    stability: Stability
    /** True iff every rep failed AND failed the same way — the only safe fixture shape. */
    deterministicFixture: boolean
}

const key = (r: {pkg: string; query: string}): string => `${r.pkg}${r.query}`

/** Group rows by question and classify each one's cross-rep behaviour. */
export function classifyStability(rows: ResultRow[]): QuestionStability[] {
    const groups = new Map<string, ResultRow[]>()
    for (const r of rows) {
        if (r.error !== undefined) continue
        const k = key(r)
        const g = groups.get(k)
        if (g) g.push(r)
        else groups.set(k, [r])
    }

    const out: QuestionStability[] = []
    for (const g of groups.values()) {
        const reps = g.length
        const invalid = g.filter(r => r.valid === false).length
        const unclear = g.filter(r => r.unclear === true).length
        const hallucWarn = g.filter(r => r.hallucWarn === true).length

        const majorityInvalid = invalid * 2 > reps
        const minority = majorityInvalid ? reps - invalid : invalid
        const flipRate = reps === 0 ? 0 : minority / reps

        const stability: Stability =
            invalid === 0 ? 'always-valid'
            : invalid === reps ? 'always-invalid'
            : 'unstable'

        // Failing every rep is necessary but not sufficient: the failure MODE must also be
        // constant, or the fixture's own metric moves between reps for free.
        const modeConstant = unclear === reps || hallucWarn === reps
        out.push({
            pkg: g[0].pkg,
            query: g[0].query,
            reps,
            invalid,
            unclear,
            hallucWarn,
            flipRate,
            stability,
            deterministicFixture: stability === 'always-invalid' && modeConstant && reps > 1
        })
    }
    return out.sort((a, b) => b.flipRate - a.flipRate || a.pkg.localeCompare(b.pkg))
}

export interface StabilitySummary {
    questions: number
    reps: number
    alwaysValid: number
    alwaysInvalid: number
    unstable: number
    deterministicFixtures: number
    /** Mean per-question flip rate — the churn the aggregate hides. */
    meanFlipRate: number
    /** Questions whose `unclear` verdict was not constant across reps. */
    unclearChurn: number
    /** Questions whose `excerptVerified` verdict was not constant across reps. */
    hallucChurn: number
}

export function summarize(s: QuestionStability[]): StabilitySummary {
    const reps = s.length === 0 ? 0 : Math.max(...s.map(q => q.reps))
    const churn = (pick: (q: QuestionStability) => number): number =>
        s.filter(q => pick(q) !== 0 && pick(q) !== q.reps).length
    return {
        questions: s.length,
        reps,
        alwaysValid: s.filter(q => q.stability === 'always-valid').length,
        alwaysInvalid: s.filter(q => q.stability === 'always-invalid').length,
        unstable: s.filter(q => q.stability === 'unstable').length,
        deterministicFixtures: s.filter(q => q.deterministicFixture).length,
        meanFlipRate: s.length === 0 ? 0 : s.reduce((a, q) => a + q.flipRate, 0) / s.length,
        unclearChurn: churn(q => q.unclear),
        hallucChurn: churn(q => q.hallucWarn)
    }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

if (import.meta.main) {
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const file =
        process.argv[2]
        ?? path.join(os.homedir(), 'tmp', 'worker-validity-baseline', 'results.json')
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as ResultRow[]
    const s = classifyStability(rows)
    const sum = summarize(s)

    console.log(`corpus-stability — ${file}`)
    console.log(
        `  ${sum.questions} questions x up to ${sum.reps} reps\n`
            + `  always-valid   ${sum.alwaysValid}\n`
            + `  always-invalid ${sum.alwaysInvalid}\n`
            + `  UNSTABLE       ${sum.unstable}  (verdict changed between reps)\n`
            + `  mean per-question flip rate ${(100 * sum.meanFlipRate).toFixed(1)}%`
    )
    console.log(
        `\n  counter churn — questions whose verdict was NOT constant across reps:\n`
            + `    unclear      ${sum.unclearChurn}\n`
            + `    halluc-warn  ${sum.hallucChurn}   <- if high, this counter is not a `
            + `per-question fixture signal`
    )
    console.log(
        `\n  DETERMINISTIC FIXTURE CANDIDATES: ${sum.deterministicFixtures}`
            + ` (fail every rep, same mode every rep)`
    )
    for (const cand of s.filter(x => x.deterministicFixture).slice(0, 25)) {
        const mode = cand.unclear === cand.reps ? 'unclear' : 'halluc-warn'
        console.log(`    [${mode}] ${cand.pkg} :: ${cand.query.slice(0, 88)}`)
    }
    const worst = s.filter(x => x.stability === 'unstable').slice(0, 10)
    if (worst.length > 0) {
        console.log(`\n  MOST UNSTABLE (never use these as fixtures):`)
        for (const q of worst) {
            console.log(
                `    flip=${(100 * q.flipRate).toFixed(0)}% inv=${q.invalid}/${q.reps} `
                    + `hal=${q.hallucWarn} ${q.pkg} :: ${q.query.slice(0, 62)}`
            )
        }
    }
}
