/**
 * question-dialog — the one-question-at-a-time picker shared by the three places
 * that ask the user to settle a fork: `/task`'s grill phase, `/task-auto`'s
 * clarify loop, and the Plan session.
 *
 * All three do the same thing. Strip markdown for storage and render it for
 * display; decide whether the question is a binary fork; short-circuit under
 * YOLO; build `A: …` / `B: …` cards; call `ui.ask`; treat `undefined` as a
 * cancel; and map the reply back onto an answer — where an empty submit accepts
 * the recommendation, a bare "A"/"B" ON A FORK (from a remote user, or from the
 * picker's free-text fallback) maps back to that option's full text, and anything
 * else is taken verbatim.
 *
 * The mapping is the load-bearing part. The recorded answer is fed back into the
 * next generation call, so storing the literal letter "A" would hand that call a
 * dangling reference it cannot decode.
 *
 * What stays at the call sites is POLICY, not mechanics: grill's auto-answer
 * (`phaseAutoAnswer`) and its widget line, clarify's plan-shape fork and
 * answer-side triage, plan's control actions. Those genuinely differ.
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
 * empty array — when there is nothing to recommend, so a conditional spread of the
 * result leaves the `options` key off the ask spec entirely. Either way the local
 * side falls back to a bare text prompt: bridge.ts boxes only when
 * `options.length > 0`.
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
 * The `source` is returned rather than baked into the string because each
 * transcript owns its own provenance table — `QA_PROVENANCE` (qa-transcript.ts)
 * for grill and clarify, `SOURCE_STAMP` (plan-io.ts) for the plan file — and they
 * disagree. That disagreement is real: clarify marks an accepted recommendation
 * "(accepted recommendation)" while grill marks nothing, because grill's
 * transcript is fed back verbatim into the next grill-gen prompt, where the stamp
 * would become model input rather than the answer.
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
 * two callers genuinely disagree about: grill throws `USER_CANCELLED` into the
 * phase ladder, clarify announces and returns null from the plan.
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
