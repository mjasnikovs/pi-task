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
 */
const DEFERRAL_PHRASES: readonly RegExp[] = [
    /\bknown[- ]issue\b/i,
    /\b(?:test|suite|file|module)[- ]owner\b/i,
    /\bwhoever\s+(?:owns|revisits|maintains|touches)\b/i,
    /\bowned by\s+(?:whoever|the\s+\w+\s+owner|a\s+later\s+(?:step|task))/i,
    /\b(?:a|the)\s+later\s+(?:step|task)\s+(?:will|should|can|to)\s+(?:fix|revisit|update|repair|address)/i,
    /\bleave\s+(?:the\s+)?(?:test|tests|suite|failure|breakage)\s+(?:failing|red|broken|as[- ]is)\b/i,
    /\baccept(?:ing)?\s+(?:that\s+)?.{0,60}?\b(?:test|tests|suite|assertions?|lint|build)\b.{0,80}?\b(?:fail|failing|red|broken)\b/i,
    /\bflag(?:ged|ging)?\s+(?:it\s+|this\s+|the\s+\S+\s+)?(?:as\s+)?(?:a\s+)?(?:known|for\s+(?:the|a|whoever))/i,
    /\b(?:owned|as the owned|as a)\s+follow-?up\b/i,
    /\bleft\s+for\s+(?:whoever|the\s+\w+\s+owner)\b/i,
    /\bownership\s+belongs\s+to\b/i
]

/** "do NOT defer", "not a deferral to a test owner", "rather than flag it" — the
 *  phrase is named to reject it. MEASURED: a treatment answer did exactly that. */
const NEGATION_BEFORE =
    /\b(?:not|never|no|don't|do not|rather than|instead of|isn't|is not|without)\b[^.;]{0,40}$/i

export function defersBreakage(answer: string): boolean {
    return DEFERRAL_PHRASES.some(re => {
        const m = new RegExp(re.source, re.flags + (re.flags.includes('g') ? '' : 'g'))
        for (const hit of answer.matchAll(m)) {
            const before = answer.slice(Math.max(0, hit.index - 60), hit.index)
            if (!NEGATION_BEFORE.test(before)) return true
        }
        return false
    })
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
