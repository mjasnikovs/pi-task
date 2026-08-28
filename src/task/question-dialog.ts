/**
 * question-dialog — the one-question-at-a-time picker shared by the three places
 * that ask the user to settle a fork: `/task`'s grill phase, `/task-auto`'s
 * clarify loop, and the Plan session.
 *
 * All three do the same thing. Strip markdown for storage and render it for
 * display; decide whether the question is a binary fork; short-circuit under
 * YOLO; build `A: …` / `B: …` cards; call `ui.ask`; treat `undefined` as a
 * cancel; and map the reply back onto an answer — where an empty submit accepts
 * the recommendation, a bare "A"/"B" from a remote user (or the picker's
 * free-text fallback) maps back to the option's full text, and anything else is
 * taken verbatim.
 *
 * The mapping is the load-bearing part. Storing the literal letter "A" leaves the
 * next generation call a dangling reference it cannot decode, so getting it wrong
 * is not cosmetic.
 *
 * It was written three times. The Plan session factored its copy into a pure
 * `resolveAnswer` returning a typed `AnswerSource`, and its own docstring said so
 * out loud — "Mirrors the identical mapping in phaseGrill and planAuto" — but the
 * two mirrors were never converted, and they had already drifted apart in three
 * ways (which of them stamps an accepted recommendation, which has a
 * single-option card branch, which handles a typed reply that equals an option).
 * None was a crash. The next edit to any of them is where the bug lands, which is
 * why they now share this.
 *
 * What stays at the call sites is POLICY, not mechanics: grill's auto-answer and
 * widget line, clarify's plan-shape and triage pre-emption, plan's control
 * actions. Those genuinely differ.
 */

import type {AnswerSource} from './plan-io.js'
import {stripInlineMarkdown} from './inline-markdown.js'
import type {YoloPick} from './yolo.js'

/** One question awaiting an answer, in both the stored and the displayed form. */
export interface PendingQuestion {
    /** Plain text — persisted, and fed back to the model. */
    plain: string
    /** Markdown-rendered — displayed. */
    shown: string
    suggested?: string
    shownSuggested?: string
    alt?: string
    shownAlt?: string
}

/** True when the question is a binary fork rather than a single recommendation. */
export function isTwoOption(p: PendingQuestion): boolean {
    return p.suggested !== undefined && p.alt !== undefined
}

/**
 * The answer cards: the recommendation first (index 0 is the green RECOMMENDED
 * card), the alternative second when the question is a fork. `undefined` — not an
 * empty array — when there is nothing to recommend, because that is what makes
 * `ui.ask` fall back to a bare text prompt instead of an empty picker.
 */
export function buildOptionCards(
    p: PendingQuestion
): Array<{label: string; value: string}> | undefined {
    if (isTwoOption(p)) {
        return [
            {label: `A: ${p.shownSuggested ?? p.suggested!}`, value: p.suggested!},
            {label: `B: ${p.shownAlt ?? p.alt!}`, value: p.alt!}
        ]
    }
    if (p.suggested !== undefined) {
        return [{label: p.shownSuggested ?? p.suggested, value: p.suggested}]
    }
    return undefined
}

/**
 * Map what the picker returned onto the answer that gets recorded, and say WHERE
 * the answer came from.
 *
 * The `source` is returned rather than baked into the string because the three
 * call sites disagree about provenance stamping, and that disagreement is real:
 * `/task-auto`'s clarify transcript marks an accepted recommendation
 * ("… (accepted recommendation)") while grill's does not, because grill's
 * transcript is fed back verbatim into the next grill-gen prompt and the stamp
 * would become model input. Keeping the stamp at the call site makes that a
 * one-line difference you can see instead of a divergence hidden inside two
 * six-branch ladders.
 */
export function resolveAnswer(
    p: PendingQuestion,
    raw: string
): {answer: string; source: AnswerSource} {
    const typed = raw.trim()
    const twoOption = isTwoOption(p)
    if (typed.length === 0 && p.suggested !== undefined) {
        return {answer: p.suggested, source: 'accepted'}
    }
    if (typed.length === 0) return {answer: '(skipped)', source: 'skipped'}
    if (twoOption && /^a[.)]?$/i.test(typed)) return {answer: p.suggested!, source: 'chosen'}
    if (twoOption && /^b[.)]?$/i.test(typed)) return {answer: p.alt!, source: 'chosen'}
    if (p.suggested !== undefined && typed === p.suggested) {
        // Accepting the single green card by pressing it has the same provenance
        // as accepting it by submitting empty. On a FORK, picking one of two is a
        // choice, not an acceptance.
        return {answer: p.suggested, source: twoOption ? 'chosen' : 'accepted'}
    }
    if (p.alt !== undefined) {
        if (typed === p.alt) return {answer: p.alt, source: 'chosen'}
    }
    return {answer: typed, source: 'typed'}
}

/**
 * Everything one adaptive dialog needs to settle ONE question.
 *
 * `ui.ask` is typed structurally rather than as `SessionUI` so this module stays
 * out of the remote bridge's import graph — the only thing it needs is the ask.
 */
export interface SettleQuestionInput {
    ui: {
        ask: (spec: {
            localTitle: string
            displayQuestion: string
            question: string
            recommended?: string
            recommended2?: string
            allowSkip: boolean
            options?: Array<{label: string; value: string}>
        }) => Promise<string | undefined>
    }
    /** Where the settled answer is recorded. */
    transcript: {add: (kind: SettledKind, question: string, answer: string) => void}
    /** The question, plain (persisted / fed back) and rendered (displayed). */
    plain: string
    shown: string
    /** The recommendation and the alternative, as the model wrote them (markdown). */
    suggested?: string
    alt?: string
    /** Render inline markdown for display. */
    render: (md: string) => string
    /**
     * This site's already-decided YOLO outcome. A PARAMETER, not a hook: yolo.ts
     * states why the policy is per-site (grill has an anti-synthesis channel to
     * step aside from, clarify runs before research and has none), and settling a
     * question must not become the place that decides one.
     */
    yolo: YoloPick
    /** Run just before the ask — grill's "awaiting Qn" widget line. */
    onAsk?: () => void
}

/** The provenance kinds settling one question can produce. */
export type SettledKind = 'yolo' | 'yolo-skip' | 'accepted' | 'typed'

/**
 * Settle one question: YOLO short-circuit, cards, ask, record.
 *
 * Returns `'cancelled'` rather than throwing, because that is the one thing the
 * two callers genuinely disagree about — grill throws `USER_CANCELLED` into the
 * phase ladder, clarify announces and returns null from the plan. Everything
 * before it was written out twice at ~50 lines each and had already drifted on
 * `recommended2`, harmless today only because the bridge re-guards it.
 */
export async function settleQuestion(input: SettleQuestionInput): Promise<'settled' | 'cancelled'> {
    const {ui, transcript, plain, shown, render, yolo} = input
    const plainSuggested =
        input.suggested === undefined ? undefined : stripInlineMarkdown(input.suggested)
    const plainAlt = input.alt === undefined ? undefined : stripInlineMarkdown(input.alt)

    if (yolo !== null) {
        // The stamp is a RECORD fact, and which kinds are stamped is the
        // transcript policy's call — never this call site's.
        if (yolo.kind === 'answer') {
            transcript.add('yolo', plain, stripInlineMarkdown(yolo.answer))
        } else {
            transcript.add('yolo-skip', plain, `(skipped — ${yolo.note})`)
        }
        return 'settled'
    }

    const pending: PendingQuestion = {
        plain,
        shown,
        ...(plainSuggested !== undefined && {
            suggested: plainSuggested,
            shownSuggested: render(input.suggested!)
        }),
        ...(plainAlt !== undefined && {alt: plainAlt, shownAlt: render(input.alt!)})
    }
    const options = buildOptionCards(pending)
    input.onAsk?.()
    const a = await ui.ask({
        localTitle: shown,
        displayQuestion: shown,
        question: plain,
        recommended: plainSuggested,
        ...(plainAlt !== undefined && {recommended2: plainAlt}),
        allowSkip: plainSuggested === undefined && plainAlt === undefined,
        ...(options && {options})
    })
    if (a === undefined) return 'cancelled'

    // An accept covers both routes to it: submitting empty, and pressing the
    // single green card.
    const resolved = resolveAnswer(pending, a)
    transcript.add(resolved.source === 'accepted' ? 'accepted' : 'typed', plain, resolved.answer)
    return 'settled'
}
