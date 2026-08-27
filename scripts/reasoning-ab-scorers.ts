/**
 * THE QUALITY AXIS, one definition per reasoning group, in one place.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three of the five scorers in live-reasoning-group-ab.ts measured a contract
 * that does not exist, and each one was written by hand next to the experiment
 * it scored:
 *
 *   phase     required GOAL && CONSTRAINTS && VERIFY as uppercased substrings.
 *             VERIFY is not a refine section — REFINE_PROMPT names GOAL,
 *             CONSTRAINTS, KNOWN-UNKNOWNS, EXTERNAL-DEPENDENCIES and then
 *             forbids everything else. A compliant answer scored UNUSABLE, and
 *             28 trials were voided. (The three sections it did name are the
 *             COMPOSE contract, validateSpecShape, carried onto the wrong child.)
 *   research  required a line matching /^\s*[-*]\s/ — a bullet. FILES entries
 *             have no bullet: the prompt says "<path>[:<line>]  <purpose>", one
 *             per line. A compliant answer scored UNUSABLE.
 *   gate      hand-wrote its own prompt asking for "PASS or FAIL on its own
 *             line" and matched /\b(PASS|FAIL)\b/ — either word ANYWHERE in
 *             prose. It scored 18/20 vs 19/20: a ceiling, and a scorer at its
 *             ceiling cannot separate two arms however different they are.
 *
 * The harness's own header already said the rule — "Production validators,
 * imported. A harness that reimplements the check measures the harness" — and
 * the file broke it three times. Rules do not enforce themselves; a module does.
 * Every scorer here is a production function, imported.
 *
 * IT IS SPLIT OUT, NOT LEFT IN THE HARNESS, for the same reason the decision
 * ladder was: live-reasoning-group-ab.ts ends in a top-level `await main()`, so
 * importing it to reuse a scorer LAUNCHES A REAL RUN. Without this file the
 * rescorer would have to keep its own copy, and the table could hold cells
 * scored two different ways while looking uniform — which is precisely the bug
 * class above, one level up.
 *
 * Both the live harness and rescore-reasoning-ledger.ts import from here, so a
 * scorer fix rescores every stored trial instead of costing GPU hours again.
 */
import {validateRefineShape} from '../src/task/spec-validation.js'
import {hasAnswerContent} from '../src/workers/pi-worker-core.js'
import {parseVerifyVerdict} from '../src/task/verify-work.js'
import {parseDecomposeList} from '../src/task/auto-io.js'
import {extractTitleSource} from '../src/task/decompose-fidelity.js'

/**
 * `parseVerifyVerdict`'s sentinel for "the child never stated a verdict".
 *
 * It returns a plain `{pass, unobserved?, detail}`, so "no marker at all" and "a
 * FAIL that gave no reason" are told apart only by this string. Depending on a
 * message is a coupling, so `assertVerdictParserContract` breaks the run loudly
 * the day production changes it — rather than silently scoring every
 * verdict-less answer as usable, which is the ceiling this file exists to remove.
 */
export const NO_VERDICT_DETAIL = 'no verdict emitted'

/**
 * Did the verify child state a verdict at all? PASS, FAIL and UNOBSERVED all
 * count; only silence does not.
 *
 * SUPERSEDED FOR THE GATE CELL, and kept because it is still the right
 * TERMINATION check. MEASURED 2026-08-26: 10/10 in both arms. It is a correct
 * scorer at its ceiling — a competent model states a verdict every time — and a
 * saturated axis cannot separate two arms however different they are. That is
 * the same defect that voided the previous 40 rows, one level up: the first
 * scorer was wrong AND saturated, this one is right AND saturated.
 *
 * The old reason for not scoring WHICH verdict came back was sound: the trials
 * replayed recorded specs against one corpus tree that may or may not contain
 * the work, so a FAIL was a fact about the tree, not about the arm. The fix is
 * not to keep scoring shape — it is to stop guessing the tree. See
 * `gateVerdictCorrect` and reasoning-ab-gate-truth.ts.
 */
export function emittedVerdict(text: string): boolean {
    const v = parseVerifyVerdict(text)
    return v.pass || v.unobserved === true || v.detail !== NO_VERDICT_DETAIL
}

/** Which verdict the child stated. Now SCORED for gate — see gateVerdictCorrect. */
export function verdictWord(text: string): string {
    const v = parseVerifyVerdict(text)
    return (
        v.pass ? 'PASS'
        : v.unobserved === true ? 'UNOBSERVED'
        : v.detail === NO_VERDICT_DETAIL ? 'NONE'
        : 'FAIL'
    )
}

/**
 * Fail before the first GPU second if the imported parser stopped meaning what
 * `emittedVerdict` reads into it. All four cases are load-bearing: the first is
 * the one whose misreading produces a ceiling, and the last three are the three
 * markers production can emit.
 */
export function verdictParserContractProblem(): string | null {
    const cases: [string, boolean, string][] = [
        ['nothing here', false, 'NONE'],
        ['WORK-VERIFIED: PASS', true, 'PASS'],
        ['WORK-VERIFIED: FAIL the button does nothing', true, 'FAIL'],
        ['WORK-VERIFIED: UNOBSERVED no browser on this box', true, 'UNOBSERVED']
    ]
    for (const [text, want, word] of cases) {
        const got = emittedVerdict(text)
        const gotWord = verdictWord(text)
        if (got !== want || gotWord !== word) {
            return (
                `parseVerifyVerdict no longer means what the gate scorer reads into it:`
                + ` ${JSON.stringify(text)} scored emitted=${got} word=${gotWord},`
                + ` expected emitted=${want} word=${word}`
            )
        }
    }
    return null
}

/**
 * The quality axis per group: given the child's OUTPUT TEXT, is it usable?
 *
 * Text-only by design, and that is what makes a stored trial rescorable — every
 * one of these can be re-run over a ledger's `output` field years later. It is
 * also why `implementation` is absent: that group's outcome is an EXECUTED
 * VERIFY block against a real tree (live-implementation-thinking-ab.ts), which
 * no amount of stored text can reproduce. Its ledger is the stronger artefact,
 * not the weaker one.
 *
 * `plan` is absent because /task-plan never ran in the recorded corpus.
 */
export const GROUP_SCORERS: Readonly<Record<string, (text: string) => boolean>> = {
    // Production's own refine shape check — the four bare ALL-CAPS headings that
    // extractCapsSection, scopedToolingGoal, deriveTitle and extractEnrichTargets
    // each look for, and each silently degrade without.
    phase: text => validateRefineShape(text) === null,
    // Production's own test for "does this look like a research worker's answer":
    // >=2 lines of `name<gap>description`, which IS the FILES entry shape.
    // pi-worker-core uses it to decide whether a salvaged partial is an answer.
    research: hasAnswerContent,
    // TERMINATION ONLY. Saturated as a quality axis (10/10 both arms, 2026-08-26)
    // — the gate cell is scored by gateVerdictCorrect against a known tree.
    gate: emittedVerdict,
    // SHAPE ONLY, and kept for the record rather than used: this is the scorer
    // that read 10/10 in BOTH arms. See planningPlanFaithful for the axis the
    // planning cell is actually decided on.
    planning: text => parseDecomposeList(text).length >= 2,
    // fetch-core and docs-core both gate on the child succeeding AND a non-empty
    // `answer`; both carry `excerptVerified` as metadata, not as a gate. A failed
    // extraction stores no answer, so non-empty text is exactly that pair.
    extraction: text => text.trim().length > 0
}

/**
 * THE GATE QUALITY AXIS: did the child reach the RIGHT verdict?
 *
 * `truth` is the verdict the tree makes correct, established with no model in
 * the loop — the task's own VERIFY script is executed in that exact tree, and
 * the trial exists only if it fails on the before-tree and passes on the
 * after-tree (reasoning-ab-gate-truth.ts). So `PASS` on a before-tree is not a
 * judgement call, it is wrong.
 *
 * UNOBSERVED and silence both score wrong, deliberately. On a screened tree the
 * evidence is present and executable — the harness just executed it — so
 * declining to reach a verdict is a failure to do the job, not an honest
 * abstention. That is also production's position: runWorkVerification retries a
 * verdict-less answer rather than accepting it.
 *
 * Both degenerate strategies score 50%: the stimuli are balanced by
 * construction, so always-PASS and always-FAIL are worth exactly the same as a
 * coin. Neither the ceiling nor the floor is reachable without actually reading
 * the tree.
 *
 * Takes the truth as an ARGUMENT rather than reading a tree, so a stored trial
 * stays rescorable: the ledger row carries `truth`, and rescore-reasoning-ledger
 * can re-derive this verdict from text years later with no corpus at all.
 */
export function gateVerdictCorrect(text: string, truth: string): boolean {
    return verdictWord(text) === truth
}

/** How many `[source: "…"]` clauses a title carries, grounded or not. */
function countSourceClauses(title: string): number {
    return (title.match(/\[source:\s*"/gi) ?? []).length
}

/**
 * THE PLANNING QUALITY AXIS: is every citation the plan makes REAL?
 *
 * WHY NOT THE SHAPE CHECK. `parseDecomposeList(text).length >= 2` read 10/10 in
 * both arms — a bar a competent model clears every time, and a boolean at its
 * ceiling carries no information. Same death as gate's and phase's first
 * scorers. See [[ab-shape-axis-saturates]].
 *
 * WHAT REPLACES IT. The decompose prompt requires each derived title to end with
 * `[source: "<spec line copied VERBATIM>"]`, and production ALREADY adjudicates
 * those host-side: `extractTitleSource` keeps a citation only if it really is in
 * the document and silently drops the rest, because a plan built on an invented
 * requirement is worse than one built on none. So the axis is production's own
 * verdict, with no model in the loop and nothing hand-written here:
 *
 *     a plan is FAITHFUL when it lists >= 2 titles AND EVERY source clause it
 *     emitted — counted in the raw text — comes back grounded.
 *
 * Counting the clauses in the RAW TITLE rather than trusting the peel is the
 * load-bearing half. A malformed clause (a missing closing quote, measured live:
 * `[source: "…`hc<AppType>`)]`) stops the peel, and a scorer that counted only
 * what it managed to peel would score the clauses BEFORE the break as a clean
 * sweep. It read 10/10 for medium that way; the honest number is 8/10. A
 * malformed citation is not a harmless slip either — reconcileTitleSources
 * leaves it embedded, and the title is all a downstream /task run ever sees.
 *
 * SCREENED BOTH WAYS BEFORE USE, offline, over the 20 recorded decompose runs
 * in ab-grouplab/ledger-planning.jsonl and the committed mx5 fixture:
 *   CEILING  real spec lines, quoted as a model quotes them (markup dropped):
 *            257/257 ground. The check does not lose against a known-good answer.
 *   FLOOR    the same lines with ONE content word altered: 0/228 ground. It is
 *            not a check that says yes to everything either.
 *   HEADROOM off 6/10 vs medium 8/10 (Fisher p=0.6285). NOT a result — n=10/arm
 *            cannot resolve a gap that size. What it establishes is that the
 *            axis is ALIVE: neither arm sits at the ceiling or the floor, which
 *            is exactly what the shape check could not say.
 *
 * Finding that headroom took fixing two bugs in the adjudicator first — a greedy
 * `[source: …]` regex that glued multiple clauses into one fabricated
 * superstring, and grounding that counted markdown markup as content. Together
 * they cost production 154 grounded citations where 242 were available, and 17
 * constraint restorations where 50 were. See decompose-fidelity.ts.
 *
 * `sourceDoc` is the expanded feature text the child was actually shown
 * (`featureForModel`), which is what production grounds against too. It is a
 * committed fixture, so a stored trial stays rescorable with no corpus.
 */
export function planningPlanFaithful(text: string, sourceDoc: string): boolean {
    const titles = parseDecomposeList(text)
    if (titles.length < 2) return false
    for (const t of titles) {
        if (extractTitleSource(t, sourceDoc).sources.length !== countSourceClauses(t)) return false
    }
    return true
}
