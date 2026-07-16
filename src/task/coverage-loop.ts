/**
 * coverage-loop — the MONOTONIC replacement rule for /task-auto's decompose
 * coverage gate (mx5 run 12).
 *
 * The failure this closes: the coverage-retry loop regenerated the whole plan on
 * every INCOMPLETE verdict, and adopted the regeneration on nothing but a size
 * floor (`retry.length * 2 >= current.length`). A regeneration is a fresh
 * stochastic roll of the ENTIRE plan, so one that DROPPED a previously-covered
 * feature-area but kept the title count replaced the better plan anyway — and,
 * because the loop shipped whatever the LAST round produced, the dropped area was
 * gone with only a toast. Live: a complete full-stack plan (31 requirements
 * mapped, frontend pages present) was overwritten by a backend-only one and
 * shipped, driven by 3 NEGATIVE requirements no task could ever "own" that kept
 * the verdict INCOMPLETE forever.
 *
 * The rule here makes replacement monotone: coverage can only hold or grow across
 * rounds. A retry is adopted ONLY when it drops no requirement the current plan
 * already owns (its owned-set is a superset). Because adoption is monotone, the
 * working plan at exhaustion is the best-covered one seen — so "ship the working
 * plan" is automatically "ship the best", never "ship the last".
 *
 * Spec-shape-agnostic: the only inputs are title counts and the set of
 * requirement INDICES a task owns (from the host-side coverage map). No feature
 * noun, no web-app assumption. A CLI, a data pipeline, a library, a refactor, a
 * docs task all flow through the same integers.
 */

/** A scored plan candidate — the minimum the adoption rule needs. */
export interface CoveragePlan {
    titles: string[]
    /**
     * Requirement indices a task OWNS (a per-requirement `TASK n` verdict from the
     * coverage map). Empty when the run extracted no requirements — then the rule
     * degrades to the count-floor path below. Cross-cutting requirements are NOT
     * here: they are carried into every task regardless of plan shape, so they
     * cannot be "dropped" by a plan change and must not gate adoption.
     */
    covered: Set<number>
    /**
     * Feature areas still uncovered (holistic-judge areas + unowned requirement
     * quotes). Non-empty ⇒ the plan is incomplete and a retry is reprompted. Used
     * as the regression signal on the no-requirements path.
     */
    missing: string[]
}

// Ubiquitous words that carry no coverage signal: they appear across most task
// titles and requirement quotes, so overlap on them would falsely connect a
// requirement to any plan. Stopped so grounding keys on the DISTINCTIVE nouns
// (json, dead-letter, serialize, symlink…) that actually name a deliverable.
// English function words + generic task verbs + generic project nouns — all
// domain-agnostic (no mx5/web vocabulary).
const COVERAGE_STOPWORDS = new Set([
    // function words
    'the',
    'a',
    'an',
    'and',
    'or',
    'of',
    'to',
    'in',
    'on',
    'for',
    'with',
    'by',
    'at',
    'as',
    'is',
    'are',
    'be',
    'it',
    'its',
    'that',
    'this',
    'from',
    'into',
    'out',
    'up',
    'per',
    'via',
    'not',
    'no',
    'but',
    'if',
    'then',
    'than',
    'so',
    'such',
    'each',
    'any',
    'all',
    'every',
    'when',
    'where',
    'must',
    'should',
    'shall',
    'may',
    'can',
    'will',
    'end',
    'new',
    // generic task verbs
    'add',
    'implement',
    'create',
    'build',
    'scaffold',
    'setup',
    'set',
    'support',
    'handle',
    'apply',
    'use',
    'used',
    'using',
    'make',
    'makes',
    'made',
    'enable',
    'provide',
    'ensure',
    'allow',
    'run',
    'runs',
    'get',
    'gets',
    'define',
    'configure',
    'init',
    'update',
    'manage',
    // generic project nouns
    'cli',
    'tool',
    'app',
    'application',
    'project',
    'feature',
    'task',
    'tasks',
    'user',
    'users',
    'mode',
    'flag',
    'flags',
    'option',
    'options',
    'system',
    'code',
    'thing',
    'things',
    'work'
])

/** Distinctive content tokens of a phrase: lowercased alphanumeric words ≥3 chars,
 *  minus the ubiquitous stopwords. `--json` → `json`, `dead-letter` → `dead`,`letter`.
 *  A single trailing `s` is stripped (len ≥4) so `scan`/`scans`, `file`/`files`,
 *  `serialize`/`serializes` match — plain plural/3rd-person, no full stemmer. */
function contentTokens(s: string): Set<string> {
    const out = new Set<string>()
    for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < 3 || COVERAGE_STOPWORDS.has(raw)) continue
        const w =
            raw.length >= 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw
        out.add(w)
    }
    return out
}

/**
 * DETERMINISTIC owned-set for the monotonic guard — grounded in requirement↔title
 * token overlap, NOT the coverage-map model's `TASK n` verdict.
 *
 * Why this exists (live A/B, Qwen3.6-27B, mx5-shaped CLI spec): the model
 * over-credits ownership — it mapped a "--json output" requirement to a generic
 * "scaffold + argument parser" task, so a plan with NO --json task still reported
 * owning it. A guard that trusts those numbers is blind to the very drop it must
 * catch (treatment held only 1/5 trials). Grounding coverage in whether a task
 * TITLE actually shares a distinctive token with the requirement makes the
 * drop-signal independent of the model's rubber-stamp (treatment → 5/5).
 *
 * A requirement is "covered" when some title shares a DISTINCTIVE token with it —
 * distinctive meaning the token is not shared across more than half the ownable
 * requirements. Without that corpus filter a common object-noun repeated in every
 * requirement (e.g. "range" in a date-range library, present in parse/serialize/
 * timezone alike) would connect a serialize-requirement to a timezone task and
 * hide the drop. Cross-cutting requirements are excluded (carried into every task
 * regardless of plan shape, so they can neither be owned nor dropped).
 *
 * Errs toward UNDER-counting coverage (a reworded title with no shared distinctive
 * noun reads as uncovered), which only makes the guard MORE conservative — it
 * never manufactures coverage that would hide a drop. Index-aligned with `quotes`.
 */
export function groundedCoverage(
    quotes: string[],
    titles: string[],
    isCrossCutting: (quote: string) => boolean
): Set<number> {
    const ownable = quotes
        .map((q, i) => ({q, i, tokens: contentTokens(q)}))
        .filter(x => !isCrossCutting(x.q))
    // Document frequency across the OWNABLE requirements: a token shared by more
    // than half of them carries no discriminating signal for this run.
    const df = new Map<string, number>()
    for (const r of ownable) for (const w of r.tokens) df.set(w, (df.get(w) ?? 0) + 1)
    const maxDF = Math.max(1, Math.floor(ownable.length / 2))

    const titleTokens = new Set<string>()
    for (const t of titles) for (const w of contentTokens(t)) titleTokens.add(w)

    const covered = new Set<number>()
    for (const r of ownable) {
        for (const w of r.tokens) {
            if ((df.get(w) ?? 0) <= maxDF && titleTokens.has(w)) {
                covered.add(r.i)
                break
            }
        }
    }
    return covered
}

/** Requirement indices the current plan owns that the retry does NOT — the drops
 *  that make a retry non-monotone. Empty ⇒ the retry is a superset (safe). */
export function droppedCoverage(current: Set<number>, retry: Set<number>): number[] {
    const out: number[] = []
    for (const i of current) if (!retry.has(i)) out.push(i)
    return out
}

export interface AdoptionDecision {
    adopt: boolean
    reason: string
    /** Owned-requirement indices the retry would drop (for the debug trail). */
    dropped: number[]
}

/**
 * Whether a coverage-retry should REPLACE the current plan.
 *
 *   1. Collapse floor (unchanged): an empty retry, or one under half the current
 *      title count, is the one-task degenerate flake this gate exists for — reject.
 *   2. WITH requirement signal: reject any retry that drops a requirement the
 *      current plan already owns (non-superset owned-set). This is the monotone
 *      guarantee; it holds regardless of how the un-ownable requirements were
 *      classified, so it backstops the cross-cutting classifier completely.
 *   3. WITHOUT requirement signal: fall back to the count floor, and additionally
 *      refuse a retry that leaves MORE areas uncovered than the current plan — so
 *      the no-requirements path also ships the best, not the last.
 */
export function decideAdoption(
    current: CoveragePlan,
    retry: CoveragePlan,
    hasRequirements: boolean
): AdoptionDecision {
    if (retry.titles.length === 0) return {adopt: false, reason: 'empty retry', dropped: []}
    if (retry.titles.length * 2 < current.titles.length) {
        return {
            adopt: false,
            reason: `collapse floor (${retry.titles.length} vs ${current.titles.length} titles)`,
            dropped: []
        }
    }
    if (hasRequirements) {
        const dropped = droppedCoverage(current.covered, retry.covered)
        if (dropped.length > 0) {
            return {
                adopt: false,
                reason: `would drop ${dropped.length} owned requirement(s)`,
                dropped
            }
        }
        return {adopt: true, reason: 'preserves owned coverage', dropped: []}
    }
    if (retry.missing.length > current.missing.length) {
        return {
            adopt: false,
            reason: `more uncovered areas (${retry.missing.length} vs ${current.missing.length})`,
            dropped: []
        }
    }
    return {adopt: true, reason: 'count floor met, no coverage regression', dropped: []}
}
