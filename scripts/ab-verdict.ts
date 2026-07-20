/**
 * Shared verdict layer for the live/replay A/B harnesses.
 *
 * WHY THIS EXISTS. On 2026-07-20 scripts/live-batch-test-ab.ts reported
 *
 *     BASELINE  batch test task shipped: 0/3
 *     TREATMENT batch test task shipped: 0/3
 *
 * and exited 0. Both columns are zero because the BASELINE arm never produced the
 * shape the lever targets — so the lever was never exercised and the run proved
 * nothing. Read at a glance, those zeros look like a pass. They are the opposite:
 * they are the absence of evidence, presented in the same shape as evidence.
 *
 * The fix is a THIRD outcome. A boolean pass/fail cannot express "the experiment
 * did not run", so it has to lie in one direction or the other — a false pass
 * (what happened) or a false fail (which readers learn to ignore). Hence:
 *
 *     PASS     baseline produced the shape, treatment removed it.       exit 0
 *     FAIL     baseline produced the shape, treatment did NOT remove it. exit 1
 *     ABSTAIN  baseline produced nothing to remove — no experiment ran.  exit 2
 *
 * ABSTAIN exits NON-ZERO on purpose. An abstaining harness must never be
 * mistakable for a passing one, by a human skimming or by CI.
 */

export type Outcome = 'PASS' | 'FAIL' | 'ABSTAIN'

/** Exit codes are distinct so a caller can tell "proved nothing" from "proved it broken". */
export const EXIT_CODE: Record<Outcome, number> = {PASS: 0, FAIL: 1, ABSTAIN: 2}

/** A side condition that must hold for the run to count as a pass (e.g. "coverage never fell"). */
export interface Invariant {
    label: string
    ok: boolean
    detail?: string
}

/** A two-armed A/B where both arms run in the same process, so counts are directly comparable. */
export interface AbSpec {
    /** Harness name, for the banner. */
    name: string
    /** Reps/trials attempted per arm — the denominator. */
    reps: number
    /**
     * Plain-English description of the shape the BASELINE arm is supposed to emit.
     * Printed verbatim on ABSTAIN, because "what was supposed to happen and didn't"
     * is the only actionable thing an abstaining run can tell you.
     */
    targetShape: string
    /** Reps in which the baseline arm produced the target shape. Zero ⇒ ABSTAIN. */
    baselineHits: number
    /** Reps in which the target shape SURVIVED the treatment arm. */
    treatmentHits: number
    /**
     * Treatment must drive the shape to zero (default). Set false for levers that
     * only reduce it, in which case any strict reduction passes.
     */
    requireTreatmentZero?: boolean
    invariants?: Invariant[]
}

/**
 * A single arm of a harness that runs one arm per invocation (mode argv), where the
 * two arms cannot see each other's counts.
 *
 * Such an arm cannot render a full verdict alone, and pretending otherwise is how
 * the original defect got in: a treatment arm reporting 0/5 looks like a win whether
 * the guard suppressed the shape or the shape never arose. So an arm must report what
 * it WITNESSED — the reps in which the lever's precondition actually occurred — and a
 * treatment arm with nothing witnessed ABSTAINs exactly like an empty baseline.
 */
export interface ArmSpec {
    name: string
    /** Which arm this invocation ran, e.g. 'baseline' | 'treatment'. */
    arm: string
    reps: number
    targetShape: string
    /** Reps in which the target shape was observed in THIS arm. */
    hits: number
    /**
     * Reps in which the lever's precondition was observed — the setup that gives the
     * arm something to act on. For a baseline arm this is normally the same as `hits`.
     * Zero ⇒ ABSTAIN, whichever arm this is.
     */
    witnessed: number
    /** 'some' for the arm that should exhibit the shape, 'none' for the arm that should suppress it. */
    expect: 'some' | 'none'
    invariants?: Invariant[]
}

function invariantLines(invariants: Invariant[]): string[] {
    return invariants.map(
        i => `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`
    )
}

function abstainBanner(targetShape: string, arm: string): string[] {
    return [
        '',
        '*** ABSTAIN — THIS RUN PROVED NOTHING ***',
        `The ${arm} never produced: ${targetShape}`,
        'The mechanism under test was therefore never exercised. A zero in the',
        'treatment column here is the ABSENCE of the bad shape, not evidence that',
        'the guard removed it. Do NOT read this run as a pass.',
        'Fix the fixture or pin the arm with a recording, then re-run.'
    ]
}

/** Judge a two-armed, single-process A/B. Returns the outcome and the lines to print. */
export function judge(spec: AbSpec): {outcome: Outcome; lines: string[]} {
    const invariants = spec.invariants ?? []
    const lines = [
        '',
        `=== VERDICT: ${spec.name} ===`,
        `  target shape: ${spec.targetShape}`,
        `  BASELINE  produced it: ${spec.baselineHits}/${spec.reps}`,
        `  TREATMENT shipped it:  ${spec.treatmentHits}/${spec.reps}`,
        ...invariantLines(invariants)
    ]

    if (spec.baselineHits === 0) {
        return {outcome: 'ABSTAIN', lines: [...lines, ...abstainBanner(spec.targetShape, 'baseline arm')]}
    }

    const broken = invariants.filter(i => !i.ok)
    const removed =
        spec.requireTreatmentZero === false ?
            spec.treatmentHits < spec.baselineHits
        :   spec.treatmentHits === 0

    if (!removed) {
        return {
            outcome: 'FAIL',
            lines: [
                ...lines,
                '',
                `FAIL — the baseline shape survived the treatment arm `
                    + `(${spec.treatmentHits}/${spec.reps}). The lever did not do its job.`
            ]
        }
    }
    if (broken.length > 0) {
        return {
            outcome: 'FAIL',
            lines: [
                ...lines,
                '',
                `FAIL — the lever removed the shape but broke ${broken.length} invariant(s): `
                    + broken.map(i => i.label).join('; ')
            ]
        }
    }
    return {
        outcome: 'PASS',
        lines: [
            ...lines,
            '',
            `PASS — baseline exhibited the shape ${spec.baselineHits}/${spec.reps} time(s) `
                + `and the treatment arm removed it.`
        ]
    }
}

/** Judge one arm of a harness that runs a single arm per invocation. */
export function judgeArm(spec: ArmSpec): {outcome: Outcome; lines: string[]} {
    const invariants = spec.invariants ?? []
    const lines = [
        '',
        `=== VERDICT: ${spec.name} [arm: ${spec.arm}] ===`,
        `  target shape: ${spec.targetShape}`,
        `  observed: ${spec.hits}/${spec.reps}   precondition witnessed: ${spec.witnessed}/${spec.reps}`,
        `  this arm expects: ${spec.expect === 'some' ? 'the shape to appear' : 'the shape to be suppressed'}`,
        ...invariantLines(invariants)
    ]

    if (spec.witnessed === 0) {
        return {
            outcome: 'ABSTAIN',
            lines: [...lines, ...abstainBanner(spec.targetShape, `${spec.arm} arm's precondition`)]
        }
    }

    const met = spec.expect === 'some' ? spec.hits > 0 : spec.hits === 0
    const broken = invariants.filter(i => !i.ok)
    if (!met) {
        return {
            outcome: 'FAIL',
            lines: [
                ...lines,
                '',
                spec.expect === 'some' ?
                    `FAIL — the precondition occurred ${spec.witnessed}/${spec.reps} time(s) but the `
                        + `shape never appeared. This arm cannot serve as a baseline.`
                :   `FAIL — the shape survived suppression in ${spec.hits}/${spec.reps} rep(s).`
            ]
        }
    }
    if (broken.length > 0) {
        return {
            outcome: 'FAIL',
            lines: [...lines, '', `FAIL — invariant(s) broken: ${broken.map(i => i.label).join('; ')}`]
        }
    }
    return {outcome: 'PASS', lines: [...lines, '', `PASS — arm "${spec.arm}" behaved as specified.`]}
}

/**
 * Print the verdict and set the process exit code. Harnesses should call this as the
 * last thing they do; it is deliberately the only sanctioned way for one of these
 * scripts to finish, so that "printed some numbers and exited 0" stops being possible.
 */
export function report(v: {outcome: Outcome; lines: string[]}): Outcome {
    for (const l of v.lines) console.log(l)
    process.exitCode = EXIT_CODE[v.outcome]
    return v.outcome
}

/** Convenience: judge a two-armed A/B and report it in one call. */
export function reportAb(spec: AbSpec): Outcome {
    return report(judge(spec))
}

/** Convenience: judge one arm and report it in one call. */
export function reportArm(spec: ArmSpec): Outcome {
    return report(judgeArm(spec))
}
