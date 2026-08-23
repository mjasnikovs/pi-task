/**
 * Where the NEXT question comes from — the other half of `question-dialog.ts`.
 *
 * `question-dialog.ts` unified the ANSWER side of the adaptive dialogs (the picker
 * cards, the reply mapping) and its own docstring makes the argument for doing so:
 * *"It was written three times… the two mirrors were never converted, and they had
 * already drifted apart in three ways… The next edit to any of them is where the
 * bug lands."* The QUESTION side — generate → parse → pick the real question →
 * dedupe → spend one corrective re-prompt → yield or exhaust — was left behind,
 * and it had drifted between the two loops that use the SAME parser on the SAME
 * prompt format (`plan-prompts.ts` says `parseClarifyList` parses it "UNCHANGED";
 * `auto-prompts.ts` specifies the identical shape).
 *
 * The five drifts, all in clarify's favour of being wrong:
 *
 *  1. **Which entry is the question.** `parseClarifyList` pushes an entry for
 *     EVERY numbered line, and the local model writes numbered analysis notes
 *     before the question it was asked for (measured live). `pickQuestion` prefers
 *     the first entry carrying a `SUGGESTED:` line; clarify took `parsed[0]`
 *     blindly, showing the note as the question and losing the recommendation
 *     attached further down.
 *  2. **NONE vs unparseable.** The parser returns `[]` for both. Clarify's
 *     `if (parsed.length === 0) break` ended the whole clarify — and decomposed the
 *     feature with ZERO clarifications — on a formatting slip.
 *  3. **A re-typed sentinel.** `isNoneReply`'s regex was a byte-identical second
 *     copy of the parser's own.
 *  4. **Missing SUGGESTED** bought one corrective re-prompt in plan and none in
 *     clarify, so clarify showed a card-less question.
 *  5. **The deferral guard.** It exists because an accepted "clarify with the user
 *     before proceeding" rode into `/task`'s handoff AS AN AUTHORITATIVE DECISION
 *     and produced a task whose VERIFY asserted no source file had changed.
 *     Clarify's answers ride into the decompose prompt and the AUTO file with
 *     exactly the same authority, and had no guard.
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
 * The cap on distinct questions ONE adaptive dialog may ask.
 *
 * Clarify and plan each declared their own `8`, linked only by a comment saying
 * "matches /task-auto's MAX_CLARIFY_QUESTIONS, for the same reason". They bound
 * the same thing for the same reason; this is that reason, once.
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
 * `parseClarifyList` turns EVERY numbered line into an entry, and the local model
 * sometimes writes a numbered analysis note or two before the question it was
 * asked for (measured live: the first numbered line was a note like
 * "1. gateDebugWriter in orchestrator.ts — wraps a raw append function"). Taking
 * entry 0 blindly then shows the note as the question and loses the SUGGESTED line
 * attached further down. The prompt requires exactly one SUGGESTED, and the parser
 * attaches it to the entry it follows.
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
    /** Ordered quality rules; each may fire at most once per question. */
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
                // the dialog on the second is how a formatting slip becomes a
                // feature decomposed with zero clarifications.
                if (!isNoneReply(raw) && hint === null) {
                    deps.log?.('unparseable question reply — one format re-prompt')
                    hint = deps.formatHint
                    continue
                }
                // A SECOND unreadable reply is not a NONE. Recording it as one is
                // the very conflation this module exists to end — it would put
                // "model has no further questions" on the trail for a run where
                // the model produced two malformed replies.
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
     * have something novel. The plan loop reset its own `dupStrikes` at two sites
     * for exactly this; the budget lives here now, so the reset has to.
     */
    function reopen(): void {
        dupStrikes = 0
        dupHint = null
    }

    return {next, asked: () => asked, reopen}
}
