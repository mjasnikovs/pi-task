/**
 * The /task-plan interaction loop.
 *
 * Sequential & adaptive, exactly like /task's grill (phases.ts `phaseGrill`) and
 * /task-auto's clarify (auto-orchestrator.ts `planAuto`): ask ONE question at a
 * time, feed every answer back into the next generation call so later questions
 * react to earlier ones, and stop when the model emits NONE. The duplicate
 * backstop (`isDuplicateQuestion` + `DUP_REPROMPT_HINT` + `MAX_DUP_STRIKES`), the
 * markdown handling, the A/B answer-letter mapping and the YOLO policy are the
 * SAME modules those two loops use — none of that is new here.
 *
 * What IS new is the control surface. In grill and clarify the user's only move is
 * to answer the question in front of them. Here three moves are available at every
 * single prompt, in that order of appearance:
 *
 *   ❓ ask the model a question   — the user asks, the model answers (PLAN_ASK)
 *   ✎ answer in your own words    — the free-text card askQuestionBox already
 *                                    appends to every boxed picker; it is not new,
 *                                    it is simply always present here, and it
 *                                    doubles as "state a decision" when the model
 *                                    has nothing to ask
 *   ▶ proceed to execution        — stop planning, hand the decisions to /task
 *                                    (PLAN_PROCEED)
 *
 * The loop is pure with respect to I/O: every side effect (child calls, dialogs,
 * persistence) arrives through {@link PlanSessionDeps}, so the whole interaction
 * is unit-testable without a TUI or a model.
 */

import type {AskSpec} from '../remote/bridge.js'
import {parseClarifyList} from './parsers.js'
import {stripInlineMarkdown} from './inline-markdown.js'
import {isDuplicateQuestion, DUP_REPROMPT_HINT, MAX_DUP_STRIKES} from './question-dedup.js'
import {yoloPickAnswer} from './yolo.js'
import {formatPlanTranscript, type PlanEntry, type AnswerSource} from './plan-io.js'

// ─── Control actions ─────────────────────────────────────────────────────────

/**
 * Sentinel values the picker resolves to when the user takes a control action
 * instead of answering. Deliberately shaped like the existing `USER_CANCELLED`
 * sentinel (child-runner.ts): a value no model answer and no human ever types.
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
 * (it stops when the model emits NONE); this only bounds a model that never
 * does. Matches /task-auto's MAX_CLARIFY_QUESTIONS, for the same reason.
 */
export const MAX_PLAN_QUESTIONS = 8

/**
 * Corrective re-prompt for a question reply that did not follow the format —
 * either nothing parseable at all, or a question with no `SUGGESTED:` line. Same
 * shape and same one-shot budget as GRILL_AUTO_FORMAT_HINT (prompts.ts), which
 * exists because the local model drops a required tag every so often and a
 * silent fallback is worse than one extra call: an unparsed reply reads as "no
 * questions left" and a missing SUGGESTED leaves the picker with nothing to
 * recommend.
 */
export const PLAN_FORMAT_HINT =
    '[SYSTEM NOTE: Your previous reply did NOT follow the required format. Output exactly '
    + 'one numbered question line ("1. **...?** short rationale"), then on the NEXT line a '
    + 'line beginning with "SUGGESTED: " carrying your recommended default — that line is '
    + 'REQUIRED and must never be blank. Add an "ALT: " line only for a binary A-or-B fork. '
    + 'If nothing is left to ask, output the single token NONE and nothing else. No preamble, '
    + 'no analysis, no other text.]'

/** True when the reply is the deliberate "nothing left to ask" sentinel, as
 *  opposed to output the parser simply could not read. */
export function isNoneReply(raw: string): boolean {
    return /^\s*NONE\s*$/m.test(raw)
}

/**
 * Which of the parsed entries is the actual question.
 *
 * parseClarifyList turns EVERY numbered line into an entry, and the local model
 * sometimes writes a numbered analysis note or two before the question it was
 * asked for (measured live: the first numbered line was a note like
 * "1. gateDebugWriter in orchestrator.ts — wraps a raw append function"). Taking
 * entry 0 blindly then shows the note as the question and loses the SUGGESTED
 * line that was attached further down.
 *
 * The SUGGESTED line is the reliable marker of the real question — the prompt
 * requires exactly one, and parseClarifyList attaches it to the entry it follows.
 * So: prefer the first entry that has one; fall back to the first entry when none
 * does, which is the case the format re-prompt then covers.
 */
export function pickQuestion<T extends {suggested?: string}>(parsed: T[]): T | undefined {
    return parsed.find(q => q.suggested !== undefined && q.suggested.length > 0) ?? parsed[0]
}

/**
 * Does the question offer the user a choice between two named alternatives?
 * Deliberately shallow — an "X or Y?" in the question's own clause.
 */
export function looksLikeFork(question: string): boolean {
    return /\bor\b/i.test(question.split('?')[0] ?? '')
}

/**
 * Corrective re-prompt for a fork-shaped question that shipped only ONE option.
 *
 * Measured on the local model (scripts/live-task-plan-step0.ts, 15 reps): the
 * SUGGESTED line is always there, but 10/15 questions named two alternatives and
 * gave only one of them — so the picker showed a single card and the user had to
 * type out the option the model itself had just proposed.
 *
 * The retry quotes the question back because the child is stateless (a fresh
 * process per call, prompt only), so it cannot otherwise know what it just wrote.
 * Validated before wiring (scripts/live-task-plan-fork-alt.ts): 6/6 fires
 * recovered an ALT, and 6/6 re-asked the SAME question rather than changing the
 * subject. It costs one extra child call on the questions where it fires.
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

// ─── Deps ────────────────────────────────────────────────────────────────────

/** The ask spec the session hands to the UI: an {@link AskSpec} plus the picker
 *  entries. Kept structurally identical to what phaseGrill/planAuto build so the
 *  same SessionUI.ask serves all three. */
export type PlanAskSpec = AskSpec & {
    options: {label: string; value: string}[]
    manualLabel: string
    actions: {label: string; value: string}[]
}

export interface PlanSessionDeps {
    /** Run the question-generation child. `hint` is the duplicate reprompt. */
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
    /** Status line while a child runs (the widget's `lastLine`). */
    setStatus?(line: string | undefined): void
    yolo?: boolean
    logDebug?(msg: string): void
}

export type PlanOutcome =
    | {kind: 'proceed'; entries: PlanEntry[]}
    | {kind: 'cancelled'; entries: PlanEntry[]}

// ─── Pending question ────────────────────────────────────────────────────────

interface PendingQuestion {
    /** Plain text — persisted, and fed back to the model. */
    plain: string
    /** Markdown-rendered — displayed. */
    shown: string
    suggested?: string
    shownSuggested?: string
    alt?: string
    shownAlt?: string
}

/**
 * Build the picker for a pending model question: the recommendation first (index
 * 0 is the green RECOMMENDED card), the alternative second when the question is a
 * binary fork, then the two control actions. The free-text card is appended by
 * askQuestionBox itself — that is the "answer in your own words" affordance, and
 * it is the same card grill and clarify already show.
 */
export function buildQuestionSpec(p: PendingQuestion): PlanAskSpec {
    const options: {label: string; value: string}[] = []
    if (p.suggested !== undefined && p.alt !== undefined) {
        options.push({label: `A: ${p.shownSuggested ?? p.suggested}`, value: p.suggested})
        options.push({label: `B: ${p.shownAlt ?? p.alt}`, value: p.alt})
    } else if (p.suggested !== undefined) {
        options.push({label: p.shownSuggested ?? p.suggested, value: p.suggested})
    }
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
        manualLabel: PLAN_ANSWER_LABEL
    }
}

/**
 * Build the picker for the state with NO pending question — the model is out of
 * questions, or the cap/duplicate backstop stopped it. The same three moves are
 * still on offer; only "answer this question" is gone, because there is no
 * question, so the free-text card becomes "add a decision of your own".
 */
export function buildIdleSpec(): PlanAskSpec {
    const actions = [
        {label: PLAN_PROCEED_LABEL, value: PLAN_PROCEED},
        {label: PLAN_ASK_LABEL, value: PLAN_ASK}
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
        manualLabel: PLAN_STATE_LABEL
    }
}

/**
 * Map what the picker returned onto the answer that gets recorded. Mirrors the
 * identical mapping in phaseGrill and planAuto: an empty submit accepts the
 * recommendation, a bare "A"/"B" from a remote user or the free-text fallback maps
 * back to the option's full text, and anything else is taken verbatim.
 */
export function resolveAnswer(
    p: PendingQuestion,
    raw: string
): {answer: string; source: AnswerSource} {
    const typed = raw.trim()
    const twoOption = p.suggested !== undefined && p.alt !== undefined
    if (typed.length === 0 && p.suggested !== undefined) {
        return {answer: p.suggested, source: 'accepted'}
    }
    if (typed.length === 0) return {answer: '(skipped)', source: 'skipped'}
    if (twoOption && /^a[.)]?$/i.test(typed)) return {answer: p.suggested!, source: 'chosen'}
    if (twoOption && /^b[.)]?$/i.test(typed)) return {answer: p.alt!, source: 'chosen'}
    if (p.suggested !== undefined && typed === p.suggested) {
        return {answer: p.suggested, source: twoOption ? 'chosen' : 'accepted'}
    }
    if (p.alt !== undefined && typed === p.alt) return {answer: p.alt, source: 'chosen'}
    return {answer: typed, source: 'typed'}
}

// ─── The loop ────────────────────────────────────────────────────────────────

/** Copy for the dialog that collects the user's own question. */
export const ASK_TITLE = 'Ask the model'
export const ASK_QUESTION =
    'What do you want to ask about this task? The answer is recorded as a note; it does not decide anything by itself.'

export async function runPlanSession(deps: PlanSessionDeps): Promise<PlanOutcome> {
    const entries: PlanEntry[] = []
    const asked: string[] = []
    const render = (s: string): string => deps.renderMarkdown?.(s) ?? s
    let dupStrikes = 0
    let dupHint: string | null = null
    /** Set for exactly one corrective re-prompt after a malformed reply. */
    let formatHint: string | null = null
    /** The model has nothing (more) to ask: NONE, the cap, or the dup backstop. */
    let exhausted = false
    let pending: PendingQuestion | null = null

    const commit = async (entry: PlanEntry): Promise<void> => {
        entries.push(entry)
        await deps.onEntries?.(entries)
    }

    for (;;) {
        if (pending === null && !exhausted) {
            if (asked.length >= MAX_PLAN_QUESTIONS) {
                deps.logDebug?.(`plan: question cap (${MAX_PLAN_QUESTIONS}) reached`)
                exhausted = true
                continue
            }
            deps.setStatus?.(`thinking of question ${asked.length + 1}…`)
            const raw = await deps.generateQuestion(
                formatPlanTranscript(entries),
                formatHint ?? dupHint
            )
            deps.setStatus?.(undefined)
            const parsed = parseClarifyList(raw)
            // parseClarifyList returns [] both for a deliberate NONE and for
            // output it could not parse at all — treating the second as "no
            // questions left" would end the planning session on a formatting
            // slip. Tell them apart, and give a malformed reply exactly one
            // corrective re-prompt (the same one-shot recovery the grill
            // auto-answer does with GRILL_AUTO_FORMAT_HINT).
            if (parsed.length === 0) {
                if (!isNoneReply(raw) && formatHint === null) {
                    deps.logDebug?.('plan: unparseable question reply — one format re-prompt')
                    formatHint = PLAN_FORMAT_HINT
                    continue
                }
                deps.logDebug?.('plan: model has no further questions (NONE)')
                formatHint = null
                exhausted = true
                continue
            }
            const picked = pickQuestion(parsed)!
            const {question, suggested, alt} = picked
            const plain = stripInlineMarkdown(question)
            // The duplicate backstop runs BEFORE either quality re-prompt: a
            // question that is about to be discarded as a re-ask must not first
            // buy itself an extra child call to be polished.
            if (isDuplicateQuestion(asked, plain)) {
                dupStrikes++
                deps.logDebug?.(`plan: duplicate question, strike ${dupStrikes}/${MAX_DUP_STRIKES}`)
                formatHint = null
                if (dupStrikes >= MAX_DUP_STRIKES) {
                    exhausted = true
                    continue
                }
                dupHint = DUP_REPROMPT_HINT
                continue
            }
            // A question with no SUGGESTED line leaves the picker with nothing to
            // recommend, which is the one thing the prompt says must never happen.
            // One-shot recovery; if it still comes back bare we show the question
            // anyway — a question with no default beats no question.
            if (suggested === undefined && formatHint === null) {
                deps.logDebug?.('plan: question had no SUGGESTED — one format re-prompt')
                formatHint = PLAN_FORMAT_HINT
                continue
            }
            // A question that offers a choice but ships one option leaves the
            // user typing out the alternative the model just named. Same one-shot
            // budget, quoting the question back so the (stateless) child re-asks
            // this one instead of a new one.
            if (alt === undefined && formatHint === null && looksLikeFork(plain)) {
                deps.logDebug?.('plan: fork-shaped question with no ALT — one re-prompt')
                formatHint = planForkHint(plain)
                continue
            }
            formatHint = null
            dupStrikes = 0
            dupHint = null
            asked.push(plain)
            pending = {
                plain,
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
                dupStrikes = 0
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
                dupStrikes = 0
            }
            continue
        }

        const {answer, source} = resolveAnswer(pending, chosen)
        await commit({kind: 'decision', question: pending.plain, answer, source})
        pending = null
    }
}
