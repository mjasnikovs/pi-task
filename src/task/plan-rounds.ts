/**
 * What the PLAN-SHAPING loops record, and the decisions that record makes.
 *
 * `GateTally`'s and `AutofixLedger`'s twin, one phase earlier. CONTEXT.md records
 * that shape twice already: a long loop threading mutable locals by closure, with
 * pure helpers extracted for testability while the ORDERING and CARRY-FORWARD
 * decisions stayed in the caller. `coverPlan` was the third instance — five locals
 * (`planTitles`, `best`, `round`, `roundCap`, `bonusRoundUsed`) plus a
 * snapshot-before-overwrite pair (`priorCovered`, `priorMissing`) that existed
 * ONLY because the bonus-round decision was made downstream from the evidence it
 * needed, so the loop had to save a copy of `best` before replacing it.
 *
 * The last real bug here says the shape out loud, in the loop's own comment:
 * *"As two assignments, the second one keeps the OLD plan's
 * accounting whenever the new plan's coverage-map child faulted
 * (`cand.accounting ?? accounting`) — binding requirements to titles they were
 * never mapped against."* `AutofixLedger`'s indictment, verbatim: the decision was
 * made downstream from the evidence.
 *
 * `consider` closes it by construction rather than by comment. It compares, it
 * replaces the plan WHOLE (titles and accounting together, because they are one
 * value), and it grants the bonus round IN THE SAME CALL that adopts — the way
 * `judge(outcome, edited)` enters the demoted signature in the call that demotes.
 * There is no window in which the snapshot and the replacement can disagree.
 *
 * NO I/O. No `logPlanDebug`, no notify, no child — for the same reason `GateTally`
 * performs none: a record that performs effects cannot be driven by a test that
 * only wants the verdict. The caller trails what the returned decision says.
 */

import {
    decideAdoption,
    normMissingArea,
    type AdoptionDecision,
    type ScoredPlan
} from './coverage-loop.js'

/** What `consider` did with a candidate, and why. */
export interface ConsiderOutcome {
    adopted: boolean
    /** The adoption verdict's own reasoning, for the caller's trail. */
    decision: AdoptionDecision
    /** True when this adoption is what bought the one bonus round. */
    grantedBonusRound: boolean
}

export interface CoverageLedgerOptions {
    /** The round cap before any bonus. */
    cap: number
    /**
     * Are there grounded requirements to judge against?
     *
     * Without them `missing` is pure holistic-judge free text that can change every
     * round, so there is no trustworthy "grew"/"new" signal — which is why the
     * bonus round is requirements-path only.
     */
    hasRequirements: boolean
}

/**
 * The coverage loop's record: the best plan seen, the rounds spent, and the
 * one-shot bonus round.
 *
 * Methods are named for what they MEAN, not for the field they touch.
 */
export class CoverageLedger {
    private _round = 0
    private _cap: number
    private _bonusUsed = false

    constructor(
        private _best: ScoredPlan,
        private readonly _opts: CoverageLedgerOptions
    ) {
        this._cap = _opts.cap
    }

    /** The best-covered plan seen so far — the one that reprompts, and the one that ships. */
    best(): ScoredPlan {
        return this._best
    }

    /** Rounds spent so far. */
    round(): number {
        return this._round
    }

    /** May another reprompt round run? */
    mayRetry(): boolean {
        return this._round < this._cap
    }

    /** Spend a round. Call once per reprompt, before the child runs. */
    startRound(): number {
        return ++this._round
    }

    /** What is still uncovered in the shipping plan, or null when nothing is. */
    unresolved(): string[] | null {
        return this._best.plan.missing.length > 0 ? this._best.plan.missing : null
    }

    /**
     * Judge one candidate against the best plan and, if it wins, adopt it.
     *
     * The bonus-round grant is decided HERE, against the pre-adoption plan this
     * method still holds — not by a caller reading a snapshot it took beforehand.
     * Two guards keep it off generic judge churn: the grounded covered-set must
     * strictly GROW (a flaky judge relabelling the same-shaped plan's gap does not
     * qualify), and the candidate must expose a NEW area (a gap already present is
     * one we have reprompted against or will). Bounded to one, so a judge that
     * flags forever still cannot loop the plan phase.
     */
    consider(cand: ScoredPlan): ConsiderOutcome {
        const decision = decideAdoption(this._best.plan, cand.plan, this._opts.hasRequirements)
        if (!decision.adopt) return {adopted: false, decision, grantedBonusRound: false}

        const priorCovered = this._best.plan.covered.size
        const priorMissing = new Set(this._best.plan.missing.map(normMissingArea))
        // WHOLE, titles and accounting together. They are one value; splitting them
        // is a bug this codebase has already had.
        this._best = cand

        const grant =
            !this._bonusUsed
            && this._round >= this._cap
            && this._opts.hasRequirements
            && cand.plan.covered.size > priorCovered
            && cand.plan.missing.some((m: string) => !priorMissing.has(normMissingArea(m)))
        if (grant) {
            this._bonusUsed = true
            this._cap++
        }
        return {adopted: true, decision, grantedBonusRound: grant}
    }
}

// DECOMPOSE's two retry budgets (`emptyAttempts`, `smallRetryUsed`) are NOT here.
// They look like this shape and are not: that loop keys on `isSuspectPlan`, a
// predicate over the SPEC LENGTH rather than a title-count floor, and its two
// counters already sit inside a nine-line comment explaining why a single counter
// was wrong. Wrapping them in a class that does not model `isSuspectPlan` would
// move the code without concentrating the decision.
