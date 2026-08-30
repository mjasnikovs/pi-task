/**
 * The /task-plan interaction loop.
 *
 * Sequential and adaptive: ask ONE question at a time, feed the whole transcript
 * back into the next generation call so later questions react to earlier answers,
 * and stop when the model emits NONE. Generation, the question cap and the
 * duplicate backstop live in question-source.ts; the answer cards and the A/B
 * letter mapping in question-dialog.ts; markdown in inline-markdown.ts; the
 * unattended policy in yolo.ts. /task's grill (phases.ts `phaseGrill`) and
 * /task-auto's clarify (auto-orchestrator.ts `planAuto`) drive the same modules.
 *
 * What this loop adds is the control surface. Grill and clarify let the user only
 * answer the question in front of them. Here three moves are on every prompt, in
 * this order of appearance:
 *
 *   ❓ ask the model a question   — the user asks, the model answers (PLAN_ASK)
 *   ✎ answer in your own words    — the free-text card askQuestionBox appends to
 *                                    every boxed picker. It doubles as "state a
 *                                    decision" when the model has nothing to ask.
 *   ▶ proceed to execution        — stop planning, hand the decisions to /task
 *                                    (PLAN_PROCEED). Always the LAST card in the
 *                                    box — it ends the session, so it sits under
 *                                    every move that continues it, including the
 *                                    free-text card (see `manualPosition`).
 *
 * The loop performs no I/O of its own: every side effect (child calls, dialogs,
 * persistence) arrives through {@link PlanSessionDeps}, so the whole interaction
 * is unit-testable without a TUI or a model.
 */

import type {AskSpec} from '../remote/bridge.js'
import {makeQuestionSource, type QuestionRule} from './question-source.js'
import {stripInlineMarkdown} from './inline-markdown.js'
import {yoloPickAnswer} from './yolo.js'
import {formatPlanTranscript, type PlanEntry} from './plan-io.js'
import {buildOptionCards, resolveAnswer, type PendingQuestion} from './question-dialog.js'
export {resolveAnswer} from './question-dialog.js'
export type {PendingQuestion} from './question-dialog.js'

// ─── Control actions ─────────────────────────────────────────────────────────

/**
 * Sentinel values the picker resolves to when the user takes a control action
 * instead of answering. Same shape as `USER_CANCELLED` (child-runner.ts): a
 * value no model answer and no human ever types.
 */
export const PLAN_ASK = '__plan_ask__'
export const PLAN_PROCEED = '__plan_proceed__'

export const PLAN_ASK_LABEL = '❓ Ask the model a question…'
export const PLAN_PROCEED_LABEL = '▶ Proceed to execution (hand off to /task)'
/** Free-text card label while a model question is on screen. */
export const PLAN_ANSWER_LABEL = '✎ Answer in your own words…'
/** …and when there is no question to answer, so the same card reads correctly. */
export const PLAN_STATE_LABEL = '✎ Add a decision of your own…'

/** Header shown once the model has nothing left to ask. */
export const PLAN_NO_QUESTIONS =
    'No further questions — the decisions so far settle how this task is built.'

/**
 * Hard ceiling on model-generated questions for one plan. The loop is open-ended
 * — it stops when the model emits NONE — so this only bounds a model that never
 * does. Same value as /task-auto's MAX_CLARIFY_QUESTIONS.
 */
export const MAX_PLAN_QUESTIONS = 8

/**
 * Corrective re-prompt for a question reply that did not follow the format —
 * either nothing the parser could read, or a question with no `SUGGESTED:` line.
 * Same shape and same one-shot budget as GRILL_AUTO_FORMAT_HINT (prompts.ts).
 *
 * Both failures are silent without it. `makeQuestionSource` answers `exhausted`
 * for a reply it cannot parse, which this loop renders as "no further questions";
 * and a question with no SUGGESTED reaches `buildOptionCards` with nothing to
 * build a card from.
 */
export const PLAN_FORMAT_HINT =
    '[SYSTEM NOTE: Your previous reply did NOT follow the required format. Output exactly '
    + 'one numbered question line ("1. **...?** short rationale"), then on the NEXT line a '
    + 'line beginning with "SUGGESTED: " carrying your recommended default — that line is '
    + 'REQUIRED and must never be blank. Add an "ALT: " line only for a binary A-or-B fork. '
    + 'If nothing is left to ask, output the single token NONE and nothing else. No preamble, '
    + 'no analysis, no other text.]'

export {isNoneReply, pickQuestion} from './question-source.js'

/**
 * Does the question offer the user a choice between two named alternatives?
 * Deliberately shallow: an `or` anywhere before the first question mark.
 */
export function looksLikeFork(question: string): boolean {
    return /\bor\b/i.test(question.split('?')[0] ?? '')
}

/**
 * Does the recommended default DEFER the decision instead of making one?
 *
 * A deferral is not an answer, and the one place it can never be one is here: the
 * user IS present during planning, so "ask the user" is a null move — that IS the
 * question. An accepted recommendation is a `decision` entry, so it rides into
 * /task's handoff inside the block `buildHandoffPrompt` (plan-io.ts) labels
 * authoritative — addressed to a run where no user exists.
 *
 * Every pattern is anchored to the START of the default, which keeps it off
 * legitimate product behaviour: "prompt the user to confirm deletion" decides
 * something and does not match; "ask the user which report" decides nothing and
 * does.
 */
export function isDeferralSuggestion(suggested: string): boolean {
    const s = suggested.trim().replace(/^["'`*_\s]+/, '')
    return (
        /^(ask|clarify|confirm|check|discuss|decide)\b[^.]{0,60}\b(with |from |the )?user\b/i.test(
            s
        )
        || /^(wait|hold off|hold|defer|postpone|pause|park)\b/i.test(s)
        || /^(tbd|to be (determined|decided|defined|specified))\b/i.test(s)
        || /^(pending|awaiting|await)\b/i.test(s)
        || /^leave (it|this|that)?\s*(to|for|open|undecided|unspecified)\b/i.test(s)
        || /^the user (must|should|needs? to|has to|will)\b/i.test(s)
        || /^(do not|don'?t|no)\b[^.]{0,40}\b(proceed|implement|build|start|write|decide)\b/i.test(
            s
        )
    )
}

/**
 * Corrective re-prompt for a default that deferred the decision. Quotes the
 * question and the default back, because the child is a fresh process carrying
 * only its prompt and cannot otherwise know what it just recommended.
 */
export function planDecisiveHint(question: string, suggested: string): string {
    return (
        '[SYSTEM NOTE: Your previous reply asked this question:\n'
        + `"${question}"\n`
        + `and recommended: "${suggested}"\n`
        + 'That recommendation DEFERS the decision instead of making one — it tells the user to '
        + 'ask, clarify, wait, or leave it open. The user is answering this question RIGHT NOW, so '
        + '"find out from the user" is not an answer, it is the question you just asked. Ask the '
        + 'SAME question again — do not change the subject — and this time make SUGGESTED a '
        + 'concrete choice that could be implemented as written, naming real things from the repo. '
        + 'If the question is a genuine A-or-B fork, add the ALT line too. Nothing else.]'
    )
}

/**
 * Corrective re-prompt for a fork-shaped question that shipped only ONE option.
 * With no ALT, `buildOptionCards` emits a single card, so the user has to type
 * out the alternative the model itself just named.
 *
 * The retry quotes the question back because the child is a fresh process
 * carrying only its prompt, so it cannot otherwise know what it just wrote. It
 * costs one extra child call on the questions where it fires.
 */
export function planForkHint(question: string): string {
    return (
        '[SYSTEM NOTE: Your previous reply asked this question:\n'
        + `"${question}"\n`
        + 'That question offers the user a choice between two alternatives, but you gave only '
        + 'one SUGGESTED line, so the user is shown a single option and has to type the other '
        + 'one out by hand. Ask the SAME question again — do not change the subject — and this '
        + 'time emit BOTH lines:\nSUGGESTED: <the option you recommend>\nALT: <the other option>\n'
        + 'Nothing else.]'
    )
}

/**
 * A default that DEFERS decides nothing, and an accepted deferral reaches the
 * consumer dressed as an authoritative decision.
 *
 * Its own constant because it is the one rule BOTH tables below hold, shared by
 * reference so the compiler links them.
 */
const DEFERRAL_RULE: QuestionRule = {
    id: 'SUGGESTED deferred the decision',
    detect: (q, plain) =>
        q.suggested !== undefined && isDeferralSuggestion(q.suggested) ?
            planDecisiveHint(plain, q.suggested)
        :   null,
    // When only the recommendation defers, the ALT is still a real commitment:
    // promote it so the question keeps a usable default. With no ALT the default
    // is dropped, `buildOptionCards` returns undefined, and `resolveAnswer` maps
    // an empty submit to '(skipped)' rather than to a decision the user never
    // made.
    repair: q => {
        const {alt: _alt, suggested: _suggested, ...rest} = q
        return q.alt !== undefined ? {...rest, suggested: q.alt} : {...rest}
    }
}

/**
 * PLAN's quality rules, in order.
 *
 * The corrective-re-prompt budget is per QUESTION and shared across the whole
 * table (question-source.ts): at most one rule fires per draw, and a defect that
 * survives its re-prompt DEGRADES through `repair` rather than discarding the
 * question — a weak default still beats no question. Each hint quotes the
 * question back, because the child is a fresh process carrying only its prompt.
 *
 * Only {@link CLARIFY_QUALITY_RULES} is shared with `/task-auto`, and only the
 * deferral rule is in it. The other two cost an extra child call every time they
 * fire.
 */
export const PLAN_QUALITY_RULES: ReadonlyArray<QuestionRule> = [
    {
        // A question with no SUGGESTED leaves the picker with nothing to
        // recommend, which is the one thing the prompt says must never happen.
        id: 'no SUGGESTED',
        detect: q => (q.suggested === undefined ? PLAN_FORMAT_HINT : null)
    },
    DEFERRAL_RULE,
    {
        // A fork-shaped question that ships one option leaves the user typing out
        // the alternative the model itself just named.
        id: 'fork-shaped question with no ALT',
        detect: (q, plain) =>
            q.alt === undefined && q.suggested !== undefined && looksLikeFork(plain) ?
                planForkHint(plain)
            :   null
    }
]

/**
 * The deferral rule alone — the one clarify shares.
 *
 * Clarify's answers ride into the decompose prompt and the AUTO file with the
 * same authority /task-plan's decisions ride into the handoff, so an accepted
 * "clarify with the user before proceeding" lands there as an instruction too.
 *
 * It is also the only one of the three that costs nothing on the happy path: a
 * decisive default never triggers it.
 */
export const CLARIFY_QUALITY_RULES: ReadonlyArray<QuestionRule> = [DEFERRAL_RULE]

// ─── Deps ────────────────────────────────────────────────────────────────────

/** The ask spec the session hands to the UI: an {@link AskSpec} whose optional
 *  picker fields are all required here. The same SessionUI.ask serves grill,
 *  clarify and this loop. */
export type PlanAskSpec = AskSpec & {
    options: {label: string; value: string}[]
    manualLabel: string
    manualPosition: number
    actions: {label: string; value: string}[]
}

export interface PlanSessionDeps {
    /** Run the question-generation child. `hint` is whatever corrective
     *  re-prompt question-source.ts chose, or null. */
    generateQuestion(priorQA: string, hint: string | null): Promise<string>
    /** Run the child that answers a question the USER asked. */
    answerUserQuestion(priorQA: string, question: string): Promise<string>
    /** Show the picker; resolves to a value, a control sentinel, or undefined
     *  when the user dismissed it. */
    ask(spec: PlanAskSpec): Promise<string | undefined>
    /** Collect free text (the user's own question). undefined = cancelled. */
    promptText(title: string, question: string): Promise<string | undefined>
    /** Display the model's answer to the user's question. */
    showAnswer(question: string, answer: string): void | Promise<void>
    /** Called after every transcript change, for persistence. */
    onEntries?(entries: readonly PlanEntry[]): void | Promise<void>
    /** Theme-aware markdown renderer for displayed text; identity when absent. */
    renderMarkdown?(text: string): string
    /** Status line while a child runs. */
    setStatus?(line: string | undefined): void
    yolo?: boolean
    logDebug?(msg: string): void
}

export type PlanOutcome =
    {kind: 'proceed'; entries: PlanEntry[]} | {kind: 'cancelled'; entries: PlanEntry[]}

// ─── Pending question ────────────────────────────────────────────────────────

/**
 * Build the picker for a pending model question: the recommendation first (index
 * 0 is the green RECOMMENDED card), the alternative second when the question is a
 * binary fork, then the two control actions. The free-text card is supplied by
 * askQuestionBox itself — that is the "answer in your own words" affordance, and
 * it is the same card grill and clarify already show — placed just above the
 * trailing "proceed to execution" card so proceed stays last.
 */
export function buildQuestionSpec(p: PendingQuestion): PlanAskSpec {
    const options = buildOptionCards(p) ?? []
    const actions = [
        {label: PLAN_ASK_LABEL, value: PLAN_ASK},
        {label: PLAN_PROCEED_LABEL, value: PLAN_PROCEED}
    ]
    return {
        localTitle: p.shown,
        displayQuestion: p.shown,
        question: p.plain,
        ...(p.suggested !== undefined && {recommended: p.suggested}),
        ...(p.alt !== undefined && {recommended2: p.alt}),
        // The picker always offers a way out (the control actions and the
        // free-text card), so a Skip button would only add a fourth way to say
        // nothing. An unanswered question is recorded by submitting empty text.
        allowSkip: false,
        options: [...options, ...actions],
        actions,
        manualLabel: PLAN_ANSWER_LABEL,
        // The free-text card goes ABOVE "proceed to execution" — proceed ends the
        // session, so it is the last card in the box, under every other move.
        manualPosition: options.length + actions.length - 1
    }
}

/**
 * Build the picker for the state with NO pending question — the model is out of
 * questions, or the cap/duplicate backstop stopped it. The same three moves are
 * still on offer; only "answer this question" is gone, because there is no
 * question, so the free-text card becomes "add a decision of your own".
 * Proceed stays last here, as it is under a question: handing off to /task ends
 * planning, so it never sits where a reflexive first-item press can hit it.
 */
export function buildIdleSpec(): PlanAskSpec {
    const actions = [
        {label: PLAN_ASK_LABEL, value: PLAN_ASK},
        {label: PLAN_PROCEED_LABEL, value: PLAN_PROCEED}
    ]
    return {
        localTitle: PLAN_NO_QUESTIONS,
        displayQuestion: PLAN_NO_QUESTIONS,
        question: PLAN_NO_QUESTIONS,
        // No `recommended`: on the remote card that field IS the accept button,
        // and "proceed" is an action, not an answer. Remote therefore renders the
        // text box plus these two action buttons.
        allowSkip: false,
        options: actions,
        actions,
        manualLabel: PLAN_STATE_LABEL,
        manualPosition: actions.length - 1
    }
}

// ─── The loop ────────────────────────────────────────────────────────────────

/** Copy for the dialog that collects the user's own question. */
export const ASK_TITLE = 'Ask the model'
export const ASK_QUESTION =
    'What do you want to ask about this task? The answer is recorded as a note; it does not decide anything by itself.'

export async function runPlanSession(deps: PlanSessionDeps): Promise<PlanOutcome> {
    const entries: PlanEntry[] = []
    const render = (s: string): string => deps.renderMarkdown?.(s) ?? s
    /** The model has nothing (more) to ask — any `exhausted` draw: NONE, the
     *  cap, the duplicate backstop, or a reply the parser could not read. */
    let exhausted = false
    let pending: PendingQuestion | null = null

    const commit = async (entry: PlanEntry): Promise<void> => {
        entries.push(entry)
        await deps.onEntries?.(entries)
    }

    const questions = makeQuestionSource({
        generate: hint => deps.generateQuestion(formatPlanTranscript(entries), hint),
        formatHint: PLAN_FORMAT_HINT,
        rules: PLAN_QUALITY_RULES,
        cap: MAX_PLAN_QUESTIONS,
        log: msg => deps.logDebug?.(`plan: ${msg}`)
    })

    for (;;) {
        if (pending === null && !exhausted) {
            deps.setStatus?.(`thinking of question ${questions.asked().length + 1}…`)
            const drawn = await questions.next()
            deps.setStatus?.(undefined)
            if (drawn.kind === 'exhausted') {
                exhausted = true
                continue
            }
            const {question, suggested, alt} = drawn.q
            pending = {
                plain: drawn.plain,
                shown: render(question),
                ...(suggested !== undefined && {
                    suggested: stripInlineMarkdown(suggested),
                    shownSuggested: render(suggested)
                }),
                ...(alt !== undefined && {
                    alt: stripInlineMarkdown(alt),
                    shownAlt: render(alt)
                })
            }
        }

        // YOLO: take the recommendation without ever building the prompt (which is
        // also what suppresses its notification — see yolo.ts). With no question
        // left there is nothing to take and nobody to press "proceed", so the run
        // proceeds on its own; that is the whole contract of the mode.
        if (deps.yolo) {
            if (pending === null) {
                deps.logDebug?.('plan: YOLO — proceeding to execution')
                return {kind: 'proceed', entries}
            }
            const pick = yoloPickAnswer(true, {
                ...(pending.suggested !== undefined && {suggested: pending.suggested}),
                ...(pending.alt !== undefined && {alt: pending.alt})
            })
            const answer =
                pick?.kind === 'answer' ? pick.answer : `(skipped — ${pick?.note ?? 'no option'})`
            await commit({kind: 'decision', question: pending.plain, answer, source: 'yolo'})
            pending = null
            continue
        }

        const chosen = await deps.ask(
            pending === null ? buildIdleSpec() : buildQuestionSpec(pending)
        )

        if (chosen === undefined) return {kind: 'cancelled', entries}
        if (chosen === PLAN_PROCEED) return {kind: 'proceed', entries}

        if (chosen === PLAN_ASK) {
            const q = await deps.promptText(ASK_TITLE, ASK_QUESTION)
            if (q === undefined || q.trim().length === 0) continue // changed their mind
            deps.setStatus?.('answering your question…')
            let answer: string
            try {
                answer = (
                    await deps.answerUserQuestion(formatPlanTranscript(entries), q.trim())
                ).trim()
            } catch (err) {
                // A failed answer must not cost the user their plan: report it in
                // place of the answer and stay in the loop.
                answer = `(could not answer: ${err instanceof Error ? err.message : String(err)})`
            }
            deps.setStatus?.(undefined)
            await deps.showAnswer(q.trim(), answer)
            await commit({kind: 'note', question: q.trim(), answer})
            // The user's question and its answer are new context, so a model that
            // had run out of questions may now have one. Re-open the generator.
            if (exhausted) {
                exhausted = false
                questions.reopen()
            }
            continue // the pending question, if any, is still unanswered
        }

        if (pending === null) {
            // Free text with no question on screen: a decision the user states
            // unprompted. An empty submit means "nothing to add" — stay put rather
            // than record a blank line.
            const text = chosen.trim()
            if (text.length === 0) continue
            await commit({kind: 'stated', text})
            if (exhausted) {
                exhausted = false
                questions.reopen()
            }
            continue
        }

        const {answer, source} = resolveAnswer(pending, chosen)
        await commit({kind: 'decision', question: pending.plain, answer, source})
        pending = null
    }
}
