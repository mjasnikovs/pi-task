/**
 * The A/B decision rule, alone, so it can be tested without a GPU.
 *
 * It lives apart from live-reasoning-group-ab.ts because that file ends in a
 * top-level `await main()`: importing it to check the ladder would LAUNCH a
 * measurement run against the model server. A rule nobody can execute without
 * booting a model is a rule nobody checks, and this one decides what ships.
 */
import {REASONING_ON_LEVEL} from '../src/config/reasoning.js'
import {
    fisherTwoSided,
    mean,
    pairByStimulus,
    pairedPermutationP,
    pct,
    permutationP,
    wilson
} from './ab-stats.js'

/** The two levels every run compares. `inherit` is deliberately not among them. */
export const ARMS = ['off', REASONING_ON_LEVEL] as const
export type Arm = (typeof ARMS)[number]

/**
 * What the two axes are CALLED in this experiment.
 *
 * The axes are the same everywhere — did the child terminate, was its output
 * accepted — but each harness has its own name for them ("usable output" for a
 * research worker, "VERIFY pass" for an implementation turn). The rule must not
 * fork just to relabel a column, so the labels are an argument and the ladder
 * stays one function that both harnesses execute.
 */
export interface AxisLabels {
    /** e.g. 'usable output', 'VERIFY pass' */
    quality: string
    /** e.g. 'non-termination', 'turn died' */
    termination: string
}

const DEFAULT_LABELS: AxisLabels = {quality: 'usable output', termination: 'non-termination'}

export interface ArmStats {
    n: number
    nonTerminating: number
    usable: number
    msOfUsable: number[]
    /**
     * The stimulus each entry of {@link msOfUsable} came from, same order, same
     * length. Supply it whenever the design runs every stimulus once per arm:
     * the clock test then pairs, which is the test that design licenses.
     *
     * OPTIONAL because two harnesses predate it and one design cannot use it —
     * `planning` runs a single fixture ten times, so there is nothing to pair
     * by. Absent, or repeated within an arm, and the clock falls back to the
     * unpaired two-sample test.
     */
    stimuliOfUsable?: readonly string[]
}

export function decide(
    off: ArmStats,
    on: ArmStats,
    alpha = 0.05,
    labels: AxisLabels = DEFAULT_LABELS
): {winner: Arm; rung: 1 | 2 | 3; saturated: boolean; lines: string[]} {
    const {quality: Q, termination: T} = labels
    const lines: string[] = []
    const pTerm = fisherTwoSided(
        off.nonTerminating,
        off.n - off.nonTerminating,
        on.nonTerminating,
        on.n - on.nonTerminating
    )
    const pUsable = fisherTwoSided(off.usable, off.n - off.usable, on.usable, on.n - on.usable)
    // THE CLOCK TEST MUST MATCH THE DESIGN. Every reasoning group except
    // `planning` runs each stimulus once per arm, and on those the stimulus
    // swamps the arm: the same gate child is ~25s on a before-tree and
    // 100-500s on an after-tree. Pooling the arms hides the arm effect inside
    // that spread. Where both arms name their stimuli and neither repeats one,
    // pair; otherwise say so and use the unpaired test.
    const paired =
        off.stimuliOfUsable && on.stimuliOfUsable ?
            pairByStimulus(
                off.stimuliOfUsable,
                off.msOfUsable,
                on.stimuliOfUsable,
                on.msOfUsable
            )
        :   null
    const pSpeed =
        paired ? pairedPermutationP(paired.a, paired.b) : (
            permutationP(off.msOfUsable, on.msOfUsable)
        )
    const speedBasis =
        paired ? `paired, ${paired.a.length} matched stimuli` : 'unpaired, arms pooled'
    const offMs = off.msOfUsable.length > 0 ? Math.round(mean(off.msOfUsable)) : 0
    const onMs = on.msOfUsable.length > 0 ? Math.round(mean(on.msOfUsable)) : 0

    lines.push(
        `  ${T.padEnd(16)} off ${off.nonTerminating}/${off.n} (${pct(off.nonTerminating, off.n)})`
            + `  vs  ${REASONING_ON_LEVEL} ${on.nonTerminating}/${on.n}`
            + ` (${pct(on.nonTerminating, on.n)})   p=${pTerm.toFixed(4)}`
    )
    lines.push(
        `  ${Q.padEnd(16)} off ${off.usable}/${off.n} (${pct(off.usable, off.n)})`
            + `  vs  ${REASONING_ON_LEVEL} ${on.usable}/${on.n} (${pct(on.usable, on.n)})`
            + `   p=${pUsable.toFixed(4)}`
    )
    lines.push(
        `  wall clock       off ${offMs}ms  vs  ${REASONING_ON_LEVEL} ${onMs}ms`
            + `   p=${pSpeed.toFixed(4)}  (${speedBasis}; decisive only at rung 2)`
    )
    const [lo, hi] = wilson(off.usable, off.n)
    lines.push(`  off ${Q} 95% CI [${lo.toFixed(2)}, ${hi.toFixed(2)}]`)

    // Computed before rung 1 so every return can report it. Rung 1 can never
    // fire on a saturated axis — equal counts cannot be significantly unequal —
    // so hoisting it changes no verdict, only what the caller is told.
    const qualitySaturated =
        (off.usable === off.n && on.usable === on.n) || (off.usable === 0 && on.usable === 0)

    // RUNG 1 — a significant loss on either quality axis ends it, whatever the
    // clock says. Symmetric on purpose: `off` losing is not privileged over
    // `medium` losing, so neither level gets a free pass from the ladder's shape.
    const termWorse = pTerm < alpha && off.nonTerminating > on.nonTerminating
    const usableWorse = pUsable < alpha && off.usable < on.usable
    if (termWorse || usableWorse) {
        const why =
            termWorse && usableWorse ? `${T} and ${Q}`
            : termWorse ? T
            : Q
        lines.push(`  → ${REASONING_ON_LEVEL} (rung 1): off is significantly worse on ${why}.`)
        return {winner: REASONING_ON_LEVEL as Arm, rung: 1, saturated: qualitySaturated, lines}
    }
    const termBetter = pTerm < alpha && off.nonTerminating < on.nonTerminating
    const usableBetter = pUsable < alpha && off.usable > on.usable
    if (termBetter || usableBetter) {
        const why =
            termBetter && usableBetter ? `${T} and ${Q}`
            : termBetter ? T
            : Q
        lines.push(`  → off (rung 1): ${REASONING_ON_LEVEL} is significantly worse on ${why}.`)
        return {winner: 'off', rung: 1, saturated: qualitySaturated, lines}
    }

    // A SATURATED QUALITY AXIS BLOCKS RUNG 2. Rung 2 reads "quality is level, so
    // the clock decides", and that sentence is only true if quality was
    // MEASURED level. When both arms sit at the scorer's ceiling the axis had no
    // headroom to separate them with, so "level" is an absence of measurement
    // wearing the clothes of a null result — the failure BLOCKER 3 voided four
    // cells for. Promoting the clock there ships whichever arm is cheaper to
    // run, which is not the same question.
    //
    // This is not hypothetical. `research` on 2026-08-26 scored 10/10 vs 10/10
    // on "every path named is real" and medium was 1.65x faster (paired,
    // p=0.0215) — rung 2 for medium. But the axis is precision-only: off named
    // 119 real paths to medium's 70, more in 9 of 10 tasks and never fewer.
    // Medium is faster because it says less, and the scorer cannot see that.
    if (qualitySaturated) {
        lines.push(
            `  ! ${Q} is SATURATED — off ${off.usable}/${off.n} and`
                + ` ${REASONING_ON_LEVEL} ${on.usable}/${on.n} both sit at the scorer's`
                + ' limit, so the axis could not have separated the arms however'
                + ' different they are. The clock is barred from deciding: a cheaper'
                + ' arm may simply be doing less of a job this scorer does not weigh.'
        )
    }

    // RUNG 2 — quality is level, so the clock is now the only evidence left and
    // it decides. It does NOT get to overrule rung 1: a faster arm that answers
    // worse has already lost above.
    // The DIRECTION must come from the same data the p-value came from. An
    // arithmetic mean is decided by the slowest trial in the arm, so a paired
    // test can be significant while the means point the other way.
    const offFaster =
        paired ?
            paired.a.filter((x, i) => x < paired.b[i]!).length > paired.a.length / 2
        :   offMs < onMs
    if (!qualitySaturated && pSpeed < alpha && offMs !== onMs) {
        const faster = offFaster ? 'off' : (REASONING_ON_LEVEL as Arm)
        lines.push(`  → ${faster} (rung 2): quality is level and ${faster} is significantly faster.`)
        return {winner: faster, rung: 2, saturated: qualitySaturated, lines}
    }

    // RUNG 3 — nothing measurable separates the arms. This is NOT a measured win
    // for `off`; it is a stated prior standing in for evidence that does not
    // exist. Thinking that buys no quality and no time is tokens spent for
    // nothing, so the cheaper level carries the cell. The caller prints the rung
    // so this can never be read back as a result the data supports.
    lines.push(
        qualitySaturated ?
            '  → off (rung 3, PRIOR NOT EVIDENCE, ON A SATURATED AXIS): the quality'
                + ' axis measured nothing here, so this run did not weigh the arms at'
                + ' all. Off is the standing prior, not a reading. DO NOT WRITE A CELL'
                + ' FROM THIS — find an axis with headroom first.'
        :   '  → off (rung 3, PRIOR NOT EVIDENCE): neither quality axis nor the clock'
                + ' separates the arms. Off carries it because thinking that buys nothing'
                + ' measurable is not worth its tokens — the data did not choose this.'
    )
    return {winner: 'off', rung: 3, saturated: qualitySaturated, lines}
}
