/**
 * What the PLAN-SHAPING loop records, and the decisions that record makes.
 *
 * `GateTally`'s and `AutofixLedger`'s twin, one phase earlier: the ORDERING and
 * CARRY-FORWARD decisions live in the record, not in the caller's locals.
 *
 * `consider` compares, replaces the plan WHOLE (`ScoredPlan` — titles and
 * accounting together, because they are one value), and grants the bonus round IN
 * THE SAME CALL that adopts — the way `AutofixLedger.judge(outcome, edited)`
 * enters the demoted signature in the call that decides to demote. A caller
 * cannot hold a pre-adoption snapshot that the replacement has already
 * invalidated, because it never takes one.
 *
 * NO I/O. No `logPlanDebug`, no notify, no child — the same reason `GateTally`
 * performs none (it imports two types and nothing else): a record that performs
 * effects cannot be driven by a test that only wants the verdict. The caller
 * trails what the returned decision says.
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
     * Without them `covered` is built by `groundedCoverage` over an EMPTY quote
     * list, so it is empty every round and can never grow — the bonus round's own
     * growth guard could not fire anyway. This flag says so up front instead of
     * relying on that, and keeps the grant on the requirements path.
     */
    hasRequirements: boolean
}

/**
 * The coverage loop's record: the best plan seen, the rounds spent, and the
 * one-shot bonus round.
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
        // WHOLE, titles and accounting together — one assignment, so the two can
        // never come from different rounds.
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

// DECOMPOSE's two retry budgets (`emptyAttempts`, `smallRetryUsed` in
// auto-orchestrator.ts) are NOT here. They look like this shape and are not: that
// loop keys on `isSuspectPlan`, which combines a title-count ceiling with a
// minimum SPEC LENGTH, and its two counters carry their own comment on why a
// single counter was wrong. Wrapping them in a class that does not model
// `isSuspectPlan` would move the code without concentrating the decision.
