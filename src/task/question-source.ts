/**
 * Where the NEXT question comes from — the other half of `question-dialog.ts`,
 * which owns the ANSWER side.
 *
 * One state machine: generate → parse → pick the real question → dedupe → spend
 * one corrective re-prompt → yield or exhaust. Two loops drive it, `/task-auto`'s
 * clarify and `/task-plan`, and they use the SAME parser on the SAME prompt format
 * — plan-prompts.ts says `parseClarifyList` parses its output UNCHANGED, and
 * auto-prompts.ts specifies the identical shape.
 *
 * NOT unified here: grill's generation loop. It uses a different parser
 * (`parseGrillQuestions`, which yields bare strings) and has no `SUGGESTED` at
 * generation time at all — grill's recommendation comes from `phaseAutoAnswer`
 * one step later, so every quality rule below is inapplicable to it. Folding it in
 * would mean a generic over the parsed shape with one consumer opting out of the
 * entire rule table: a wider interface for less behaviour.
 */

import {parseClarifyList, type ClarifyQuestion} from './parsers.js'
import {DUP_REPROMPT_HINT, isDuplicateQuestion, MAX_DUP_STRIKES} from './question-dedup.js'
import {stripInlineMarkdown} from './inline-markdown.js'

/**
 * Default cap on distinct questions ONE adaptive dialog may ask. Both live
 * callers pass their own constant of the same value instead
 * (MAX_CLARIFY_QUESTIONS, MAX_PLAN_QUESTIONS); this is what an unset `cap` gets.
 */
export const MAX_DIALOG_QUESTIONS = 8

/** True when the reply is the deliberate "nothing left to ask" sentinel, as
 *  opposed to output the parser simply could not read. */
export function isNoneReply(raw: string): boolean {
    return /^\s*NONE\s*$/m.test(raw)
}

/**
 * Which of the parsed entries is the actual question.
 *
 * `parseClarifyList` turns EVERY numbered line into an entry, and a model that
 * writes a numbered analysis note before the question it was asked for produces
 * more than one. Taking entry 0 blindly then shows the note as the question and
 * loses the SUGGESTED line attached further down. The prompt requires exactly one
 * SUGGESTED, and the parser attaches it to the entry it follows, so preferring the
 * entry that HAS one lands on the real question.
 */
export function pickQuestion<T extends {suggested?: string}>(parsed: T[]): T | undefined {
    return parsed.find(q => q.suggested !== undefined && q.suggested.length > 0) ?? parsed[0]
}

/**
 * One QUALITY rule: a defect in an otherwise-usable question that is worth exactly
 * one corrective re-prompt.
 *
 * `detect` returns the hint to re-prompt with, or null to pass. `repair` is what
 * to do when the SAME defect survives the re-prompt — a question with a bad
 * default still beats no question, so a rule degrades rather than discards.
 */
export interface QuestionRule {
    id: string
    detect: (q: ClarifyQuestion, plain: string) => string | null
    /** Applied only when the defect survived its one re-prompt. */
    repair?: (q: ClarifyQuestion) => ClarifyQuestion
}

export interface QuestionSourceDeps {
    /**
     * Ask the model for the next question. `hint` is the corrective re-prompt to
     * prepend, or null. The caller closes over its own transcript and prompt — the
     * source never builds one.
     */
    generate: (hint: string | null) => Promise<string>
    /** The corrective re-prompt for a reply the parser could not read. */
    formatHint: string
    /** Ordered quality rules. At most ONE fires per question: they share a single
     *  corrective re-prompt, spent by the first rule that detects a defect. */
    rules?: ReadonlyArray<QuestionRule>
    cap?: number
    log?: (msg: string) => void
}

export type NextQuestion =
    | {kind: 'question'; q: ClarifyQuestion; plain: string; index: number}
    | {kind: 'exhausted'; why: 'none' | 'cap' | 'dups' | 'unparseable'}

/**
 * A deep module over a state machine that was five mutable locals per site.
 *
 * The interface is one method. Behind it: the cap, the duplicate backstop and its
 * strike budget, the NONE-vs-unparseable distinction, `pickQuestion`, the one-shot
 * budget shared by every quality rule, and the hint precedence between a format
 * re-prompt and a duplicate re-prompt.
 */
export function makeQuestionSource(deps: QuestionSourceDeps): {
    next: () => Promise<NextQuestion>
    asked: () => ReadonlyArray<string>
    reopen: () => void
} {
    const cap = deps.cap ?? MAX_DIALOG_QUESTIONS
    const rules = deps.rules ?? []
    const asked: string[] = []
    let dupStrikes = 0
    let dupHint: string | null = null
    // The one-shot budget is per QUESTION, not per dialog: a fresh draw starts
    // with every rule available again. `hint` being non-null is also what spends
    // it — a rule may not fire while another rule's re-prompt is in flight, which
    // is what stops two rules ping-ponging a stateless child forever.
    let hint: string | null = null

    async function next(): Promise<NextQuestion> {
        for (;;) {
            if (asked.length >= cap) {
                deps.log?.(`question cap (${cap}) reached`)
                return {kind: 'exhausted', why: 'cap'}
            }
            const raw = await deps.generate(hint ?? dupHint)
            const parsed = parseClarifyList(raw)
            if (parsed.length === 0) {
                // `[]` means BOTH "deliberate NONE" and "could not parse". Ending
                // the dialog on the second would decompose the feature with zero
                // clarifications because of one formatting slip.
                if (!isNoneReply(raw) && hint === null) {
                    deps.log?.('unparseable question reply — one format re-prompt')
                    hint = deps.formatHint
                    continue
                }
                // A SECOND unreadable reply is not a NONE: the caller is told
                // 'unparseable', so nothing writes "model has no further
                // questions" on a run that produced two malformed replies.
                if (!isNoneReply(raw)) {
                    deps.log?.('second unparseable reply — giving up on this draw')
                    hint = null
                    return {kind: 'exhausted', why: 'unparseable'}
                }
                deps.log?.('model has no further questions (NONE)')
                hint = null
                return {kind: 'exhausted', why: 'none'}
            }
            let picked = pickQuestion(parsed)!
            const plain = stripInlineMarkdown(picked.question)
            // The duplicate backstop runs BEFORE any quality re-prompt: a question
            // about to be discarded as a re-ask must not first buy itself an extra
            // child call to be polished.
            if (isDuplicateQuestion(asked, plain)) {
                dupStrikes++
                deps.log?.(`duplicate question, strike ${dupStrikes}/${MAX_DUP_STRIKES}`)
                hint = null
                if (dupStrikes >= MAX_DUP_STRIKES) return {kind: 'exhausted', why: 'dups'}
                dupHint = DUP_REPROMPT_HINT
                continue
            }
            let reprompted = false
            for (const rule of rules) {
                const h = rule.detect(picked, plain)
                if (h === null) continue
                if (hint === null) {
                    deps.log?.(`${rule.id} — one re-prompt`)
                    hint = h
                    reprompted = true
                    break
                }
                // Survived its re-prompt: degrade rather than discard.
                if (rule.repair) {
                    deps.log?.(`${rule.id} — survived the re-prompt, repaired`)
                    picked = rule.repair(picked)
                }
            }
            if (reprompted) continue
            hint = null
            dupStrikes = 0
            dupHint = null
            asked.push(plain)
            return {kind: 'question', q: picked, plain, index: asked.length}
        }
    }

    /**
     * Clear the DUP strike budget after the caller supplies new context.
     *
     * `/task-plan` lets the user ask the model a question or state a decision
     * mid-session; that is new context, so a generator that had struck out may now
     * have something novel.
     */
    function reopen(): void {
        dupStrikes = 0
        dupHint = null
    }

    return {next, asked: () => asked, reopen}
}
