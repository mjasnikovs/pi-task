/**
 * autofix-ledger — what the run-end RESOLUTION LOOP records, and the decisions
 * that record makes.
 *
 * The same deepening `GateTally` already proved one altitude down. That replaced
 * twelve mutable locals threaded through ~400 lines of `runFinalIntegrationGate`
 * by closure; this replaces six threaded through ~235 lines of
 * `runFinalGateStage` — the attempt count, the accumulated gitignored writes, the
 * stranded sub-fixes, the previous failure signature, the demoted set, and the
 * rejected-edits flag.
 *
 * The reason is not tidiness. `final-gate-progress.ts` holds five pure functions,
 * each called from exactly ONE site inside that loop — extracted for testability
 * while the decisions about ORDERING and CARRY-FORWARD stayed in the caller. That
 * is precisely the shape `isNonProgress`'s own comment indicts:
 *
 *   > The fix is NOT a better string pattern — the bug is that the decision was
 *   > made downstream from the evidence.
 *
 * mx5 run 21 shipped a product whose every page was blank as a `completed` run
 * through that gap. Here the evidence and the decision sit in one module, and the
 * loop body reads as picker → apply → record.
 *
 * What is NOT here: anything that talks to the user, writes a ledger file, or
 * commits. The loop keeps those, the same way `GateTally` keeps no I/O — a record
 * that performs effects cannot be driven by a test that only wants the verdict.
 */

import {
    applyDemotions,
    isNonProgress,
    normalizeFailureDetail,
    rankedFirstFailure,
    unobservedDebtReason
} from './final-gate-progress.js'

/** The gate-outcome fields this record reads. Structural, so a caller can hand it
 *  a `FinalGateOutcome` without this module importing the gate. */
export interface AutofixOutcomeView {
    reason: string
    failures?: string[]
    observedFailures?: string[]
}

/** What the loop should do about this attempt's ranked-first failure. */
export interface AttemptVerdict {
    /** The ranked-first failure, trimmed; null when the outcome names none. */
    detail: string | null
    /**
     * True ⇒ this check is unfalsifiable here: the attempt edited the tree, the
     * gate re-ran, and returned the same first failure as the previous one — and
     * no probe OBSERVED it. Already recorded as demoted when true.
     */
    demoted: boolean
    /** The debt reason to carry, present exactly when `demoted`. */
    debtReason?: string
}

export class AutofixLedger {
    /** Autofix attempts made in this loop, including the one in flight. */
    private _attempts = 0
    /**
     * Gitignored paths the fix passes have written so far. ACCUMULATED across
     * attempts: a `.env` written by a failed attempt is still on disk for the next
     * one, and that attempt's own before/after diff cannot see it (mx5 run 19).
     */
    private _ignoredWritten: string[] = []
    /** Sub-fixes a non-converging attempt left uncommitted. REPLACED each attempt. */
    private _stranded: string[] = []
    /** The previous attempt's normalized ranked-first failure. */
    private _prevFailSig: string | null = null
    /** Signatures already carried as debt; a re-run reporting them does not re-fail. */
    private readonly _demoted = new Set<string>()
    /**
     * A write-guard rejected an attempt whose edits could NOT be discarded, so
     * REJECTED edits are sitting in the tree and the terminal paths must not commit
     * what they find there (mx5 run 14 item 2b — the cheat guard is never weakened
     * to ease committing).
     */
    private _rejectedEditsInTree = false

    constructor(private readonly _budget: number) {}

    // ─── Record ──────────────────────────────────────────────────────────────

    /** One autofix attempt is starting. */
    attempt(): number {
        return ++this._attempts
    }

    /** Are there attempts left? Drives whether the picker offers the card at all. */
    canAutofix(): boolean {
        return this._attempts < this._budget
    }

    attempts(): number {
        return this._attempts
    }

    /** Gitignored paths this attempt wrote. Accumulated, de-duplicated, order kept. */
    wroteIgnored(paths: readonly string[] | undefined): void {
        if (!paths || paths.length === 0) return
        for (const p of paths) if (!this._ignoredWritten.includes(p)) this._ignoredWritten.push(p)
    }

    ignoredWrites(): readonly string[] {
        return this._ignoredWritten
    }

    /** The uncommitted sub-fixes as of now. Replaces, never accumulates. */
    setStranded(paths: readonly string[]): void {
        this._stranded = [...paths]
    }

    stranded(): readonly string[] {
        return this._stranded
    }

    /** A guard rejected an attempt and its edits are still in the tree. */
    rejectedEditsRemain(): void {
        this._rejectedEditsInTree = true
    }

    /**
     * May a terminal path commit what is in the working tree?
     *
     * False once a guard has rejected an attempt without discarding its edits.
     * This is the ONE question the flag exists to answer, and it is asked at three
     * terminal sites — as a method rather than a bare boolean read at each.
     */
    mayCommitTree(): boolean {
        return !this._rejectedEditsInTree
    }

    // ─── Decide ──────────────────────────────────────────────────────────────

    /**
     * Judge this attempt's gate outcome, and record what the judgement implies.
     *
     * `edited` is the caller's fact — did this attempt change the tree and survive
     * the guards. The observed/non-progress rule and the signature carry-forward
     * are this module's, so they cannot be applied in the wrong order or skipped:
     * a demoted signature is entered into the set and the previous-signature chain
     * is broken in the SAME call that decides to demote.
     */
    judge(outcome: AutofixOutcomeView | undefined, edited: boolean): AttemptVerdict {
        const detail = rankedFirstFailure({
            ...(outcome ? {reason: outcome.reason} : {}),
            ...(outcome?.failures ? {failures: outcome.failures} : {})
        })
        // Whether a PROBE OBSERVED this failure, read off the SAME outcome the
        // failure came from — exact text identity, never a second string pattern.
        const observed = outcome?.observedFailures?.includes(detail ?? '') === true
        if (
            detail !== null
            && isNonProgress({
                previousSignature: this._prevFailSig,
                currentDetail: detail,
                edited,
                observed
            })
        ) {
            this._demoted.add(normalizeFailureDetail(detail))
            // A demotion ends the chain: the next attempt has no previous signature
            // to match, so one demotion cannot cascade into a second.
            this._prevFailSig = null
            return {detail, demoted: true, debtReason: unobservedDebtReason(detail)}
        }
        this._prevFailSig = detail !== null ? normalizeFailureDetail(detail) : null
        return {detail, demoted: false}
    }

    demotedCount(): number {
        return this._demoted.size
    }

    /**
     * What still has to pass for the gate to converge: this outcome's failures with
     * every already-demoted signature dropped. An EMPTY array means converged
     * carrying the demotions as debt; `undefined` means the outcome named no list
     * and there is nothing to reason about.
     */
    remaining(outcome: AutofixOutcomeView | undefined): string[] | undefined {
        const failures = outcome?.failures ?? (outcome ? [outcome.reason] : undefined)
        if (failures === undefined) return undefined
        return applyDemotions(failures, this._demoted)
    }

    /** Has anything been demoted? Only then can a run converge on the remainder. */
    hasDemotions(): boolean {
        return this._demoted.size > 0
    }
}
