/**
 * batch-test-task — ban the whole-project "write all the tests" task when the
 * DECISIONS channel mandates tests-in-the-same-change.
 *
 * The failure this closes: a plan that contains
 *
 *   one title reading "Write component and page tests — CT tests with
 *   screenshot baselines for all components and pages"
 *
 * — one enormous task that cannot converge, while the very decision carried ON
 * THAT TITLE says the opposite:
 *
 *   "a test lands *as fast as possible* — in the same change — as each new route
 *    or React component/page. No route or component is considered done until its
 *    test exists and passes. Don't batch testing to the end of a milestone."
 *
 * Decompose did not invent the shape: the spec's own §10/§12 structure induced it,
 * and decompose mirrors the spec. So the conflict is SPEC-INTERNAL (the spec's
 * milestone shape vs the spec's own cadence rule), and the decisions channel
 * OVERRIDES the spec doc by definition — the same precedence the task titles
 * already state. Resolve toward the decision; never ask the user.
 *
 * The mechanism is a deterministic post-decompose rewrite (applied on EVERY
 * decompose output, like fidelity reconciliation), plus a conditional prompt rule
 * as the belt. Only the batch-EVERYTHING shape is banned — coverage is never
 * nuked. Which of the two outcomes fires is decided by
 * `groundedCoverage`, not by wording:
 *
 *   • the batch title grounds NO requirement that survives its removal ⇒ every
 *     requirement it touched is owned by some other task, the per-change cadence
 *     already covers the work, and the task is DROPPED;
 *   • it is the ONLY title grounding some requirement(s) ⇒ dropping it would
 *     reduce planned coverage, so it is REPLACED by a scoped sweep that names
 *     exactly those orphaned requirements and points at the spec's own coverage
 *     source ("fill the gaps <that command> reports"), never "test everything".
 *
 * Because the replacement's owned-set is computed from the same groundedCoverage
 * the monotonic adoption guard uses, total planned coverage cannot fall.
 */
import {groundedCoverage} from './coverage-loop.js'

/**
 * Sentences that MANDATE tests landing with the change they cover. Deliberately
 * narrow: a spec that merely REQUIRES tests ("every route has tests") does not
 * ban a batch task — only an explicit cadence/anti-batch directive does.
 */
const SAME_CHANGE_RE =
    /\bin the same (?:change|commit|pr|patch|diff|task|step)\b|\b(?:do ?n['’]?t|do not|never|no)\s+(?:batch|defer|postpone|save|leave)\b|\bnot\b[^.]{0,60}\bdone until\b[^.]{0,60}\btest/i

/** Any mention of testing — the mandate must be ABOUT tests, not about docs. */
const TEST_WORD_RE = /\btests?\b|\btesting\b|\btest-first\b/i

/**
 * Does the decisions/spec text mandate tests-in-the-same-change?
 *
 * Scans sentence by sentence and requires BOTH signals in the SAME sentence, so
 * a testing section that happens to sit near an unrelated "don't defer" line
 * cannot trigger the ban. `decisions` is checked first and alone is sufficient;
 * the spec is scanned too because a cadence rule is often stated in the body of the
 * doc and only echoed into the decisions channel.
 */
export function mandatesTestsInSameChange(decisions: string, spec = ''): boolean {
    for (const text of [decisions, spec]) {
        for (const sentence of text.split(/(?<=[.!?])\s+|\n{2,}/)) {
            if (TEST_WORD_RE.test(sentence) && SAME_CHANGE_RE.test(sentence)) return true
        }
    }
    return false
}

/** Trailing `[decisions: …]` clauses decompose appends — carried onto the
 *  replacement title verbatim so the rewrite never loses a directive. */
const DECISIONS_CLAUSE_RE = /\s*\[decisions:/i

/**
 * Where decompose's trailing metadata starts. `[source: …]` is included because
 * reconcileTitleSources only strips a WELL-FORMED trailing citation: measured
 * live, the model also emits `[source: "…" [10. Testing]]`, which fails that
 * regex and leaks the QUOTED SPEC LINE into the title. Judging scope on such a
 * title reads the citation's words as the task's own — the cadence quote "…as
 * each new route or React component/page" made a properly scoped
 * "Write route/API tests for auth" look like a batch task (live false positive,
 * rep 1). A citation is provenance, never scope.
 */
const CLAUSE_START_RE = /\s*\[(?:source|decisions)\s*:/i

/** Split a title into the part decompose authored, and the `[decisions: …]` tail
 *  that must survive onto a replacement title. A leaked `[source: …]` remnant is
 *  dropped from both — the sweep does not derive from that line. */
function splitDecisions(title: string): {body: string; tail: string} {
    const clause = CLAUSE_START_RE.exec(title)
    const body = (clause ? title.slice(0, clause.index) : title).trim()
    const decisions = DECISIONS_CLAUSE_RE.exec(title)
    return {body, tail: decisions ? title.slice(decisions.index) : ''}
}

/** How decompose separates a title's head from its detail segments. */
const SEGMENT_SPLIT_RE = /\s+[—–-]\s+|\s*\|\s*/

/** The head of a title: everything before the " — <detail>" separator. */
function head(body: string): string {
    return body.split(SEGMENT_SPLIT_RE)[0]
}

/**
 * Remove double-quoted spans — they are QUOTED SPEC TEXT, never the task's own
 * scope. Measured live: the model frequently appends its citation as a bare
 * quote with no `[source: …]` wrapper ("Write auth route tests — … — "…a test
 * lands as fast as possible — in the same change — as each new route or React
 * component/page.""), and that borrowed "each" made five correctly scoped
 * per-area test tasks read as batch tasks (rep 5). Trading a possible miss (a
 * batch title whose only quantifier sits inside a quote) for never deleting a
 * properly scoped test task: the false positive is far the more expensive error.
 */
function stripQuotedSpans(s: string): string {
    return s.replace(/"[^"]*"/g, ' ').replace(/[“][^”]*[”]/g, ' ')
}

/**
 * Normalize for echo comparison: case, markdown emphasis, backticks and all
 * punctuation collapse away, so a title that reflows a spec line across a newline
 * still matches the spec's own wording.
 */
function normalizeForEcho(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

/**
 * A detail segment shorter than this is not treated as a citation even when it
 * appears in the spec — short phrases ("with screenshot baselines") are shared
 * vocabulary, not provenance, and stripping them would blind the scope check.
 */
const MIN_ECHO_CHARS = 40

/**
 * Drop detail segments that are VERBATIM spec text.
 *
 * Third variant of the same failure, and the one the syntactic defenses miss:
 * measured live, the model appended its
 * citation as BARE PROSE — no quotes, no `[source: …]` wrapper — and then
 * repeated it inside a `[source: "…"]` clause:
 *
 *   "Implement Login page with phone/password form and tests — **Client/UI:**
 *    Playwright `1.61.1` React component tests … — every component/page test
 *    captures a screenshot committed as a baseline. [source: "…"]"
 *
 * `stripQuotedSpans` sees no quotes and `splitDecisions` cuts only at the clause,
 * so the borrowed "every component/page" survived as if it were the task's own
 * scope, and a correctly per-change-scoped Login task was DROPPED — the exact
 * deletion this module exists to avoid.
 *
 * The general rule the two earlier guards were reaching for: text the title shares
 * verbatim with the spec is provenance, whoever failed to mark it as such. So the
 * check is semantic, against the spec, rather than one more citation dialect.
 *
 * The HEAD segment is never stripped: it is the task's own claim of what it
 * delivers, and a batch title that happens to quote the spec must still be caught.
 */
function stripSpecEchoes(body: string, specNorm: string): string {
    if (specNorm === '') return body
    const segments = body.split(SEGMENT_SPLIT_RE)
    if (segments.length < 2) return body
    const kept = segments.filter((seg, i) => {
        if (i === 0) return true
        const norm = normalizeForEcho(seg)
        return norm.length < MIN_ECHO_CHARS || !specNorm.includes(norm)
    })
    return kept.join(' — ')
}

/** A title whose DELIVERABLE is tests: an authoring verb whose object is tests,
 *  with nothing else claimed in between ("Write component and page tests" ✓,
 *  "Add listings CRUD + tests" ✗ — the `+` marks tests as an additive constraint
 *  on a feature task, which is exactly the cadence the decision asks for). */
const TEST_AUTHORING_RE =
    /^\s*(?:(?:write|add|create|implement|author|build|develop|produce|backfill)\b[\w\s,/-]*\b(?:tests?|test suite|test coverage|testing)\b|(?:tests?|testing)\b)/i

/** Enabling/infrastructure work — a runner, a config, fixtures, CI. Those are
 *  NOT batched test authoring; banning them would remove the very thing the
 *  per-change tests need to exist first. */
const TEST_INFRA_RE =
    /\b(?:harness|infrastructure|infra|runner|config|configuration|scaffold|scaffolding|set ?up|fixtures?|helpers?|utilities|utility|ci|pipeline|database|seed)\b/i

/**
 * WHOLE-PROJECT scope: a universal quantifier that governs a PROJECT-LEVEL target
 * ("all components and pages", "every route"), not merely any noun.
 *
 * Both halves are load-bearing, each learned from a live false positive:
 *   - "full"/"complete" are excluded — they routinely scope a single area
 *     ("full login flow");
 *   - the quantifier must reach a project-level plural within ~20 chars, because
 *     "Test PartCard component — ALL badge combinations…" is a one-component task
 *     that a bare-quantifier rule flagged and DROPPED (live rep 3).
 */
const WHOLE_SCOPE_RE =
    /\b(?:all|every|each|entire|whole|comprehensive)\b[\w\s,/-]{0,20}?\b(?:components?|pages?|routes?|endpoints?|screens?|views?|modules?|layers?|files?|features?|app|application|project|codebase|repo|repository|system|surface)\b|\bacross the (?:app|application|project|codebase|repo|repository)\b|\bend[- ]to[- ]end coverage\b/i

/**
 * Indices of titles that are whole-project BATCH test tasks.
 *
 * Three conditions must all hold — the title's deliverable is tests, its scope is
 * the whole project, and it is not test INFRASTRUCTURE. A per-feature task that
 * carries "+ tests" never matches (its head names the feature), which is the
 * point: those are the cadence the decision asks for.
 *
 * `spec` is optional only so the detector stays callable on a bare title list;
 * pass it whenever it is available, or unmarked spec echoes read as scope (see
 * `stripSpecEchoes`).
 */
export function findBatchTestTitles(titles: string[], spec = ''): number[] {
    const specNorm = normalizeForEcho(spec)
    const out: number[] = []
    for (let i = 0; i < titles.length; i++) {
        const {body} = splitDecisions(titles[i])
        const scope = stripSpecEchoes(stripQuotedSpans(body), specNorm)
        const h = head(scope)
        if (!TEST_AUTHORING_RE.test(h)) continue
        if (TEST_INFRA_RE.test(h)) continue
        if (!WHOLE_SCOPE_RE.test(scope)) continue
        out.push(i)
    }
    return out
}

/** Test-runner commands a spec may name as the thing that REPORTS coverage. */
const TEST_COMMAND_RE =
    /\b(?:bun test|npm (?:run )?test|yarn test|pnpm (?:run )?test|npx (?:vitest|jest|playwright test)|playwright test|vitest|jest|pytest|go test|cargo test|mix test|rspec)\b[^`\n]*/i

/**
 * The spec's own coverage source — the command whose report scopes the sweep.
 *
 * Only backticked spans are considered, so the result is a command the spec
 * actually writes down rather than a phrase inferred from prose; a span carrying
 * a coverage flag wins over a plain test run. Falls back to a generic phrase when
 * the spec names no command, which keeps the sweep title well-formed either way.
 */
export function coverageSourceFromSpec(spec: string): string {
    const spans = [...spec.matchAll(/`([^`\n]+)`/g)].map(m => m[1].trim())
    const commands = spans.filter(s => TEST_COMMAND_RE.test(s))
    const withCoverage = commands.find(s => /--coverage|\bcoverage\b/i.test(s))
    return withCoverage ?? commands[0] ?? "the project's own test suite"
}

/**
 * Vocabulary that every testing task and every testing requirement shares, so it
 * carries NO ownership signal here. Without this scrub the bare token "test"
 * connects a screenshot-baseline requirement to "Write auth route tests", and the
 * orphan check goes blind. (Scrubbed locally rather than added to
 * COVERAGE_STOPWORDS: those govern the monotonic adoption guard,
 * where "test" IS a discriminating noun for a plan that has no testing task at
 * all.) Token-level, not regex — `myapp_test` must scrub to `myapp`.
 */
const GENERIC_TEST_TOKENS = new Set([
    'test',
    'tests',
    'testing',
    'tested',
    'spec',
    'specs',
    'suite',
    'suites',
    'coverage',
    'assertion',
    'assertions',
    'case',
    'cases',
    'unit',
    'e2e'
])

/** Drop the generic testing vocabulary, keeping the tokenization coverage-loop
 *  itself uses so the scrubbed text grounds exactly the same way. */
function scrubTestVocabulary(s: string): string {
    return s
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length > 0 && !GENERIC_TEST_TOKENS.has(w))
        .join(' ')
}

/**
 * Requirement indices that lose their owner when the batch titles are removed.
 *
 * Two independent measures, unioned:
 *
 *   1. STRICT (the one that actually fires): generic testing vocabulary scrubbed
 *      from both sides, and a requirement that is ABOUT testing may only be owned
 *      by a title that is about testing — "Implement login page" does not
 *      discharge "every component/page test captures a screenshot".
 *   2. PLAIN groundedCoverage, exactly as the monotonic adoption guard measures
 *      it. This is the belt: whatever that guard would call a drop is an orphan
 *      here too, so the rewrite can never trip the guard it feeds.
 */
function orphanedRequirements(
    quotes: string[],
    titles: string[],
    kept: string[],
    isCrossCutting: (quote: string) => boolean
): number[] {
    const scrubbed = quotes.map(scrubTestVocabulary)
    // Index-aligned cross-cutting lookup: the scrubbed text is not the quote the
    // classifier expects, so map back to the original.
    const crossByScrub = new Map<string, boolean>()
    quotes.forEach((q, i) => crossByScrub.set(scrubbed[i], isCrossCutting(q)))
    const isCrossScrubbed = (s: string): boolean => crossByScrub.get(s) ?? false
    const testish = (t: string): boolean => TEST_WORD_RE.test(t)
    const scrub = (list: string[]): string[] => list.map(scrubTestVocabulary)

    const strictBefore = groundedCoverage(scrubbed, scrub(titles), isCrossScrubbed)
    const strictAfterAll = groundedCoverage(scrubbed, scrub(kept), isCrossScrubbed)
    const strictAfterTest = groundedCoverage(scrubbed, scrub(kept.filter(testish)), isCrossScrubbed)
    const plainBefore = groundedCoverage(quotes, titles, isCrossCutting)
    const plainAfter = groundedCoverage(quotes, kept, isCrossCutting)

    const out: number[] = []
    for (let i = 0; i < quotes.length; i++) {
        const owner = testish(quotes[i]) ? strictAfterTest : strictAfterAll
        const strictLost = strictBefore.has(i) && !owner.has(i)
        const plainLost = plainBefore.has(i) && !plainAfter.has(i)
        if (strictLost || plainLost) out.push(i)
    }
    return out
}

/** How many orphaned requirement quotes the sweep title names, and how long each
 *  may be — a title is a one-line handoff, not a ledger. */
const MAX_SWEEP_QUOTES = 6
const MAX_QUOTE_CHARS = 120

function shorten(q: string): string {
    const s = q.replace(/\s+/g, ' ').trim()
    return s.length <= MAX_QUOTE_CHARS ? s : s.slice(0, MAX_QUOTE_CHARS - 1).trimEnd() + '…'
}

/**
 * The scoped replacement: a gap-filling sweep, bounded by what the coverage
 * source reports and by the requirements that lost their only owner. It states
 * the ban explicitly, because the child that receives this title sees nothing
 * else.
 */
export function buildSweepTitle(orphaned: string[], coverageSource: string): string {
    const named = orphaned.slice(0, MAX_SWEEP_QUOTES).map(q => `"${shorten(q)}"`)
    const more = orphaned.length > named.length ? ` (+${orphaned.length - named.length} more)` : ''
    return (
        `Fill the test-coverage gaps left by the per-change tests — run \`${coverageSource}\`,`
        + ' and add tests ONLY for what it reports uncovered, specifically:'
        + ` ${named.join('; ')}${more}.`
        + ' Do NOT re-test what earlier tasks already covered, and do NOT modify'
        + ' existing test config or existing tests.'
    )
}

export interface BatchTestAction {
    /** Index of the offending title in the INPUT list. */
    index: number
    /** The offending title, verbatim. */
    title: string
    kind: 'dropped' | 'scoped'
    /** The sweep title that replaced it (`kind: 'scoped'` only). */
    replacement?: string
    /** Requirement quotes that no OTHER title grounds — what the sweep must cover. */
    orphaned: string[]
}

export interface BatchTestRewrite {
    titles: string[]
    actions: BatchTestAction[]
}

/**
 * Rewrite a decomposed plan so it carries no whole-project batch test task when
 * the decisions mandate tests-in-the-same-change.
 *
 * No mandate, or no batch title ⇒ the plan is returned untouched (identity), so
 * every non-cadence run behaves exactly as before.
 *
 * With a mandate, ALL batch titles are removed at once before coverage is
 * re-measured — otherwise two batch tasks would each mask the other's orphans and
 * both would look droppable. The orphaned set is then whatever grounded coverage
 * the removal costs; it is non-empty only when no other task's title claims that
 * requirement, and it becomes the sweep's scope. At most ONE sweep is emitted (in
 * the first batch title's position, so plan order is preserved).
 */
export function rewriteBatchTestPlan(
    titles: string[],
    decisions: string,
    spec: string,
    requirementQuotes: string[],
    isCrossCutting: (quote: string) => boolean
): BatchTestRewrite {
    if (!mandatesTestsInSameChange(decisions, spec)) return {titles, actions: []}
    const batch = findBatchTestTitles(titles, spec)
    if (batch.length === 0) return {titles, actions: []}

    const batchSet = new Set(batch)
    const kept = titles.filter((_, i) => !batchSet.has(i))
    const orphaned = orphanedRequirements(requirementQuotes, titles, kept, isCrossCutting).map(
        i => requirementQuotes[i]
    )

    const actions: BatchTestAction[] = []
    const out: string[] = []
    let sweepEmitted = false
    for (let i = 0; i < titles.length; i++) {
        if (!batchSet.has(i)) {
            out.push(titles[i])
            continue
        }
        if (orphaned.length === 0 || sweepEmitted) {
            actions.push({index: i, title: titles[i], kind: 'dropped', orphaned: []})
            continue
        }
        // Carry the offending title's own [decisions: …] clauses onto the sweep —
        // they are user directives and survive the reshaping of the task.
        const {tail} = splitDecisions(titles[i])
        const replacement = buildSweepTitle(orphaned, coverageSourceFromSpec(spec)) + tail
        actions.push({index: i, title: titles[i], kind: 'scoped', replacement, orphaned})
        out.push(replacement)
        sweepEmitted = true
    }
    return {titles: out, actions}
}

/**
 * The decompose-prompt rule (the belt; the host rewrite above is the lever).
 * Emitted ONLY when the decisions mandate the cadence, so ordinary runs see the
 * prompt they always saw. Kept next to the detector so the two cannot drift.
 */
export const DECOMPOSE_NO_BATCH_TESTS_RULE =
    '- The CLARIFICATIONS mandate that tests land in the SAME change as the code they'
    + ' cover. So do NOT emit a task whose job is writing tests for all components /'
    + ' all routes / the whole project — that shape is rejected host-side. Fold each'
    + " test into the task that builds the thing it tests (name it in that task's"
    + ' title), and emit a separate testing task ONLY as a narrowly scoped sweep of'
    + ' gaps a coverage run reports. Test INFRASTRUCTURE (runner, config, fixtures)'
    + ' may still be its own early task.'
