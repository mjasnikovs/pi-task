/**
 * gate-resolution — what to DO about a verify FAIL, as one ordered decision table.
 *
 * WHY A TABLE. The gate loop used to answer this with three overlapping booleans
 * over five predicates, and then RE-DERIVE the same branches afterwards to name
 * them in the trail. In AUTO_0002 that shape cost: a correct judge ACCEPT
 * overridden by a "rescue" attempt (41 minutes, 16 suppressions shipped, no
 * debt), a spec contradiction that looped three rounds with no exit, and five
 * defects that left the gate with no ledger entry at all. One row per decision in
 * precedence order is the whole policy, and the row that fired NAMES itself — so
 * the durable trail can no longer disagree with the branch that produced it.
 *
 * THERE IS NO RESCUE ACTION. A judge ACCEPT comes from a pass that read the real
 * workspace and ran the real commands; spending an implementation re-run "just in
 * case" overrides that verdict with nothing.
 *
 * Same ordered-data shape as `FAILURE_RULES` (src/workers/worker-failure.ts):
 * first match wins, and row order IS the precedence.
 */
import type {VerifyFailClass} from './verify-work.js'
import type {ResolutionRecommendation} from './verify-resolution.js'
import type {DebtOrigin} from './accept-debt.js'

/**
 * A criterion the task CANNOT meet without an edit its own spec forbids.
 *
 * Both gates that can prove one mint this shape: the bounded lint fix, whose
 * static findings trace to a frozen path, and the resolution judge, through its
 * `VERIFY-RESOLUTION: BLOCKED-BY-FROZEN` marker. It is the one input no re-run
 * and no human ACCEPT-vs-AUTOFIX choice can move — the fix the check demands is
 * the edit the spec denies — so it outranks every other row below.
 */
export interface SpecContradiction {
    /** The acceptance criterion (or static check) that cannot be satisfied. May be
     *  empty when the judge named only the path. */
    criterion: string
    /** The spec-frozen path whose edit is the only way to satisfy it. */
    frozenPath: string
}

/** Everything the decision depends on. Nothing else may enter the table. */
export interface ResolutionInput {
    failClass: VerifyFailClass
    /** What the resolution judge recommended, or the default when it was not consulted. */
    recommend: ResolutionRecommendation
    /** Rule 5c: a spec-required check could not RUN because its tooling is absent. */
    unobserved: boolean
    contradiction: SpecContradiction | null
    /** Unattended AUTOFIX attempts already spent on this task. */
    attempts: number
    /** Nobody can be asked (YOLO mode) — the picker is unreachable. */
    unattended: boolean
}

export type ResolutionRuleId =
    'spec-contradiction' | 'judge-accept' | 'no-autofix-budget' | 'budget-spent' | 'autofix'

/**
 * What the gate loop does next. `debtOrigin` is non-null exactly on `accept`,
 * which is the loop's terminal exit: a defect may not leave the gate without a
 * ledger entry, and the type — not a runtime check — is what enforces it. `ask`
 * and `autofix` carry null because the human's answer (or the next round) names
 * the origin instead.
 */
export type Disposition =
    | {rule: ResolutionRuleId; action: 'autofix'; debtOrigin: null; reason: string}
    | {rule: ResolutionRuleId; action: 'accept'; debtOrigin: DebtOrigin; reason: string}
    | {rule: ResolutionRuleId; action: 'ask'; debtOrigin: null; reason: string}

/** Attempts a class whose defect an implementation re-run can actually move. */
const REATTEMPTABLE_BUDGET = 3

/**
 * How many UNATTENDED implementation re-runs each FAIL class is worth.
 *
 * Zero is a statement, not a disabled feature: an absent tool is not installed by
 * re-running the work that needed it, and a verification pass that could not run
 * is not repaired by changing the code it failed to judge. Spending three turns
 * on either is how a run burns an hour to arrive where round one already was.
 */
export const AUTOFIX_BUDGET: Record<VerifyFailClass, number> = {
    'repo-health': REATTEMPTABLE_BUDGET,
    'static-checks': REATTEMPTABLE_BUDGET,
    'model-verdict': REATTEMPTABLE_BUDGET,
    unobserved: 0,
    'harness-fault': 0
}

/**
 * How many times the /task-auto loop will START one plan entry before abandoning it.
 *
 * Derived, not chosen: one run to reach the gate at all, plus the re-runs the most
 * forgiving fail class is worth inside that run. An entry that comes back for a
 * further attempt has already spent a full autofix budget without converging, and
 * the plan's remaining entries are worth more than its next round. Raising a class
 * budget raises this with it, which is the relationship that should hold.
 */
export const ENTRY_ATTEMPT_BUDGET = 1 + Math.max(...Object.values(AUTOFIX_BUDGET))

/** The budget in force, honouring an UNOBSERVED flag on any class. */
export function autofixBudget(i: Pick<ResolutionInput, 'failClass' | 'unobserved'>): number {
    return i.unobserved ? 0 : AUTOFIX_BUDGET[i.failClass]
}

export function contradictionReason(c: SpecContradiction): string {
    const criterion = c.criterion.trim()
    return (
        `spec contradiction — \`${c.frozenPath}\` is frozen by this task's spec and `
        + `${criterion.length > 0 ? criterion : 'the failing check'} cannot be satisfied `
        + 'without editing it; no re-run under the same freeze converges'
    )
}

/**
 * The two ends of the ladder that are NOT an autofix: ask a human, or — when
 * there is no human — accept and write the defect down under the origin that says
 * a machine decided.
 */
function terminal(i: ResolutionInput, rule: ResolutionRuleId, reason: string): Disposition {
    return i.unattended ?
            {rule, action: 'accept', debtOrigin: 'yolo-accepted', reason}
        :   {rule, action: 'ask', debtOrigin: null, reason}
}

function noBudgetReason(i: ResolutionInput): string {
    return i.unobserved || i.failClass === 'unobserved' ?
            'verify UNOBSERVED — the spec-required check could not run (tooling absent) and an '
                + 'unattended re-run cannot provision it'
        :   'the verification pass itself could not run — re-running the implementation cannot '
                + 'fix a harness fault'
}

/**
 * The ordered ladder. FIRST MATCH WINS, and this order is the only statement of
 * the policy:
 *
 *  1. `spec-contradiction` — the fix the check demands is the edit the spec
 *     forbids. First, because every row below would otherwise spend a budget,
 *     a human's attention or both on a loop that cannot converge (0053 ran three
 *     rounds past this exact fact).
 *  2. `judge-accept` — before any budget arithmetic, because that arithmetic is
 *     precisely what used to override a correct ACCEPT with a rescue attempt.
 *  3. `no-autofix-budget` — a class worth zero attempts. Its own row, not folded
 *     into the one below, because a budget that was never offered must not be
 *     reported as one that was spent.
 *  4. `budget-spent` — consecutive unattended attempts that all still FAIL. A
 *     person breaks the loop, or (unattended) it terminates with a debt.
 *  5. `autofix` — unconditional, so the table is total.
 */
export const RESOLUTION_RULES: ReadonlyArray<{
    id: ResolutionRuleId
    match: (i: ResolutionInput) => Disposition | null
}> = [
    {
        id: 'spec-contradiction',
        match: i =>
            i.contradiction === null ?
                null
            :   {
                    rule: 'spec-contradiction',
                    action: 'accept',
                    debtOrigin: 'spec-contradiction',
                    reason: contradictionReason(i.contradiction)
                }
    },
    {
        id: 'judge-accept',
        match: i =>
            i.recommend === 'accept' ?
                terminal(
                    i,
                    'judge-accept',
                    `judge recommended ACCEPT after investigating the workspace (autofix budget `
                        + `${i.attempts}/${autofixBudget(i)})`
                )
            :   null
    },
    {
        id: 'no-autofix-budget',
        match: i =>
            autofixBudget(i) === 0 ? terminal(i, 'no-autofix-budget', noBudgetReason(i)) : null
    },
    {
        id: 'budget-spent',
        match: i =>
            i.attempts >= autofixBudget(i) ?
                terminal(
                    i,
                    'budget-spent',
                    `autofix budget spent (${i.attempts}/${autofixBudget(i)})`
                )
            :   null
    },
    {
        id: 'autofix',
        match: i => ({
            rule: 'autofix',
            action: 'autofix',
            debtOrigin: null,
            reason: `autofix recommended, unattended ${i.attempts + 1}/${autofixBudget(i)}`
        })
    }
]

export function resolveDisposition(i: ResolutionInput): Disposition {
    for (const rule of RESOLUTION_RULES) {
        const d = rule.match(i)
        if (d !== null) return d
    }
    // Unreachable while the last row is unconditional; a reordering that breaks
    // that fails loudly here instead of returning undefined into the gate loop.
    throw new Error('RESOLUTION_RULES must end in an unconditional row')
}
