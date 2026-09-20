/**
 * Does an auto-answer hand a breakage to someone who does not exist?
 *
 * MEASURED (mx5-n TASK_0004, 2026-09-17): "flag the test/migrate.test.ts breakage
 * as a known issue for the test owner". Nothing in a /task-auto run owns a test:
 * the answer was stamped `(auto)`, verify passed the task with the suite red, and
 * four tasks later an unsatisfiable spec looped until the runaway guard fired.
 *
 * This is the deterministic backstop behind the prompt's GREEN-SUITE CHECK: a
 * model that ignores the rule still cannot promote a deferral into a decision.
 * The phrases are the ones a model reaches for when it wants to defer, not the
 * word "test" — "add a test later" is a plan, not a deferral.
 *
 * SCOPE IS GRAMMATICAL, never a character count. A negation cancels a phrase only
 * inside the phrase's own clause: "rather than flag it as a known issue" rejects
 * the phrase, and "without touching the test file, accepting that it fails" does
 * not. "Known issue", "follow-up" and "a later step" also name legitimate plans —
 * an upstream bug, a scope cut — so they count only in a clause about a check.
 */

/** A test, or a static check that the same clause calls broken. */
const TEST_NOUN = /\b(?:tests?|suites?|assertions?)\b/i
const BUILD_NOUN = /\b(?:lint|linter|typecheck|build|ci)\b/i
const FAILURE = /\b(?:fail\w*|red|broken|breaks?|breakage|errors?)\b/i

/** Before a phrase in its clause: the phrase is rejected. */
const NOT_A_DECISION =
    /\b(?:not|never|no|don't|do not|doesn't|does not|rather than|instead of|isn't|is not|without|avoid|avoiding)\b/i

/**
 * A modal cancels a phrase only where the sentence poses an option for it to
 * weigh: "IF NOT EXISTS would still leave the test failing" describes what a
 * rejected option does. A bare hedge does not — "I would flag it as a known
 * issue" is the decision, and treating every modal as hypothetical let the guard
 * be rephrased away.
 */
const MODAL = /\b(?:would|could|might)\b/i
const HYPOTHETICAL = /\b(?:if|unless|either|whether|option|alternative|otherwise)\b/i

/** Where one clause ends and the next begins. A semicolon joins clauses of ONE
 *  thought, so the breakage a clause defers may sit in the other half. */
const CLAUSE_BOUNDARY =
    /[,:;()]|\s[—–-]\s|\b(?:and|but|so|then|while|whereas|although|though|because|since|however)\b/gi

const SENTENCE_BOUNDARY = /[.!?](?=\s|$)|\n/

interface DeferralPhrase {
    re: RegExp
    /** alone — the phrase is a deferral by itself; check — only in a clause about a
     *  check; breakage — only in a sentence that says a check fails. */
    needs: 'alone' | 'check' | 'breakage'
}

const PHRASES: readonly DeferralPhrase[] = [
    {re: /\b(?:test|suite)[- ]owners?\b/i, needs: 'alone'},
    {
        re: /\bflag(?:s|ged|ging)?\b.*?\b(?:as\s+(?:an?\s+|the\s+)?(?:known|owned)\b|for\s+(?:whoever|later|a\s+later)\b)/i,
        needs: 'alone'
    },
    {
        re: /\bleav(?:e|es|ing)\b.*?\b(?:tests?|suites?|assertions?|lint|build|checks?|ci)\b.*?\b(?:failing|red|broken|as[- ]is)\b/i,
        needs: 'alone'
    },
    {
        re: /\bskip(?:s|ping)?\s+(?:updating|fixing|adjusting|changing|touching)\b.*?\b(?:tests?|suites?|assertions?)\b/i,
        needs: 'alone'
    },
    {re: /\baccept(?:s|ed|ing)?\b.*?\b(?:fail\w*|red|broken)\b/i, needs: 'check'},
    // Handing the work to an unnamed someone is the deferral itself, whatever the
    // clause is about; bare `whoever` below still needs a check to be one.
    {re: /\bwhoever\s+(?:owns|revisits|maintains|touches)\b/i, needs: 'alone'},
    {re: /\bownership\s+(?:belongs|lies|rests)\s+(?:to|with)\b/i, needs: 'alone'},
    {re: /\bwhoever\b/i, needs: 'check'},
    {re: /\bowned\s+(?:by|follow[- ]?up)\b/i, needs: 'check'},
    {re: /\bleft\s+for\b/i, needs: 'check'},
    {re: /\bknown[- ]issues?\b/i, needs: 'check'},
    {re: /\bfollow[- ]?ups?\b/i, needs: 'check'},
    {
        re: /\b(?:a|the|another|some)\s+(?:later|future|subsequent|separate)\s+(?:step|task|change|pr)\b/i,
        needs: 'check'
    },
    {re: /\bdefer(?:s|red|ring)?\b/i, needs: 'check'},
    {re: /\bout\s+of\s+scope\b/i, needs: 'check'},
    {
        re: /\b(?:that|this|which|it|they|those)\s+(?:is|are|remains?)\s+out\s+of\s+scope\b/i,
        needs: 'breakage'
    }
]

function aboutACheck(text: string): boolean {
    return TEST_NOUN.test(text) || (BUILD_NOUN.test(text) && FAILURE.test(text))
}

/**
 * Parenthetical asides go, and a code span keeps its words but loses the
 * punctuation that would split a clause in two: `toEqual([{filename: X}])` is
 * one token of the sentence around it, not three clauses.
 */
function prose(answer: string): string {
    let text = answer.replace(/`([^`]*)`/g, (_m, code: string) =>
        code.replace(/[,;:()[\]{}]/g, ' ')
    )
    let before: string
    do {
        before = text
        text = text.replace(/\([^()]*\)/g, ' ')
    } while (text !== before)
    return text
}

function clauses(sentence: string): string[] {
    return sentence.split(CLAUSE_BOUNDARY).filter(c => c.trim().length > 0)
}

export function defersBreakage(answer: string): boolean {
    for (const sentence of prose(answer).split(SENTENCE_BOUNDARY)) {
        const sentenceBreaks = aboutACheck(sentence) && FAILURE.test(sentence)
        for (const clause of clauses(sentence)) {
            for (const {re, needs} of PHRASES) {
                const hit = re.exec(clause)
                if (!hit) continue
                const before = clause.slice(0, hit.index)
                if (NOT_A_DECISION.test(before)) continue
                if (MODAL.test(before) && HYPOTHETICAL.test(sentence)) continue
                if (needs === 'check' && !aboutACheck(clause)) continue
                if (needs === 'breakage' && !sentenceBreaks) continue
                return true
            }
        }
    }
    return false
}

/** The one re-ask a deferring answer gets before it is surfaced instead of promoted. */
export function deferredBreakageReaskHint(answer: string): string {
    return (
        '[SYSTEM NOTE: Your previous answer deferred a breakage to someone who does not '
        + `exist — "${answer.replace(/\s+/g, ' ').slice(0, 160)}". No later step owns a `
        + 'failing test, lint, or build; each one inherits it and is told not to touch it. '
        + 'Re-run the GREEN-SUITE CHECK: answer with the option that keeps the suite green, '
        + 'naming the test file this task must also update. Output ONLY the tagged lines.]'
    )
}
