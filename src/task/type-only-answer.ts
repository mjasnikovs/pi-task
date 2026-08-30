/**
 * Deterministic detector for a pi-worker-docs answer that RESTATES a type signature
 * or declaration for a USAGE question, without ever saying what the API DOES.
 *
 * The shape, in one example. Asked "hc factory function signature base url parameter
 * types", a docs child answers that `hc` "accepts a generic type `T` extending
 * `Hono`… and takes two parameters: `baseUrl` of type `Prefix`". Every clause is
 * type-level: it names the parameter's TYPE, and `Prefix` is itself an opaque type
 * variable, while saying nothing about what `baseUrl` MEANS — is it an origin, or a
 * mount prefix? Escalation to search/fetch never fires, because the answer looks
 * complete: it named the very parameter that was asked about. The caller then fills
 * the semantic gap from memory, and a wrong guess about that one word can kill every
 * request the client makes.
 *
 * The lever: when a docs answer for a usage question is ONLY a signature restatement
 * with no behavioural statement, treat it as UNANSWERED so the caller escalates
 * (follow the `@see` pointer, fetch the spec-cited URL) instead of accepting a type
 * as the answer.
 *
 * ── PRECISION OVER RECALL, deliberately ─────────────────────────────────────────
 * A FALSE POSITIVE (flagging a real answer as type-only) forces a needless
 * escalation and costs a child spawn. A false NEGATIVE merely leaves one borderline
 * answer un-escalated. So three independent gates must ALL hold before an answer is
 * called type-only, and any one failing clears it. That is what keeps a legitimate
 * signature answer to an explicit "give me the type" question out.
 *
 * THE THREE GATES (all required):
 *   1. USAGE QUESTION. The question must seek usage/semantics — "how", "use",
 *      "work", "chain", "example", "call", "rpc", "mean" — or name a usage concept
 *      whose meaning is being sought ("base url"). A question asking only for a
 *      TYPE / SIGNATURE / DEFINITION is legitimately answered by a signature, so it
 *      is NOT gated in. (The `hc` query above is signature-shaped but names "base
 *      url", the concept whose meaning was needed.)
 *   2. NO BEHAVIOURAL CONTENT IN PROSE. The answer must contain no statement of what
 *      the API DOES: no usage verb ("use/call/pass/import"), no runtime-effect verb
 *      ("executes/prepends/enables/wraps"), no concrete example, no semantic meaning
 *      ("means/represents/so pass"), no concrete default VALUE or range ("default of
 *      80", "from 1 to 100"). Any one clears. This scan runs over `proseOf(answer)`,
 *      NOT the raw answer: a verb that is really a method name inside a declaration
 *      ("methods route(url, handler) and use(...handlers)") is an identifier, not
 *      behaviour, and must not clear the answer.
 *   3. SIGNATURE RESTATEMENT. The answer must actually be a declaration restatement —
 *      "of type", "takes N parameters", "accepts", "returns a…", "extends",
 *      "interface", "declare const/function". Without this it is not type-only, it
 *      is just terse prose.
 *
 * An explicit "unclear from this package/page" is NOT type-only — it is the HONEST
 * non-answer, and it is cleared here with a distinct reason so the caller routes it
 * through the existing unclear channel instead.
 *
 * Pure and side-effect free; unit-tested in type-only-answer.test.ts against real text.
 */

import {isAbstention} from '../workers/abstention.js'

/** The verdict, with a human-readable reason for logging and for the escalation channel. */
export interface TypeOnlyVerdict {
    /** True iff the answer restates a signature for a usage question with no behaviour. */
    typeOnly: boolean
    /** Why — names the gate that decided it, quoting the matched marker where useful. */
    reason: string
}

/**
 * Question seeks usage/semantics rather than a bare type. A usage concept whose MEANING is
 * being asked about ("base url") counts, because the F-2 defect is exactly a semantics need
 * dressed in signature words. A question that asks only for the "type"/"signature"/"definition"
 * is deliberately NOT here — a signature answer is responsive to it.
 */
const USAGE_INTENT: RegExp[] = [
    /\bhow\b/i,
    /\buse\b/i,
    /\busing\b/i,
    /\busage\b/i,
    /\bworks?\b/i,
    /\bworking\b/i,
    /\bchain/i,
    /base\s?url/i,
    /\bconnect/i,
    /\brpc\b/i,
    /\bexample/i,
    /\bcall\b/i,
    /\binvoke/i,
    /\bmean/i,
    /\bbehav/i,
    /what\s+does/i,
    /how\s+does/i
]

/**
 * Markers that the answer says what the API DOES — a usage instruction, a runtime effect, a
 * concrete example, a meaning, a concrete default value or range. Deliberately GENEROUS: every
 * extra marker here can only SUPPRESS a flag, which is the safe direction for precision.
 */
const BEHAVIOURAL: RegExp[] = [
    /\buse\b/i,
    /\busing\b/i,
    /\bcall/i,
    /\bpass(es|ed|ing)?\b/i,
    /\bimport/i,
    /\binstantiate/i,
    /\bprovide[sd]?\b/i,
    /\binvoke/i,
    /\bread\b/i,
    /\bwrite\b/i,
    /\bexecut/i,
    /\bsends?\b/i,
    /\bprepend/i,
    /\bappend/i,
    /\bconnect/i,
    /\bhandle/i,
    /\bresolves?\s+to\b/i,
    /\bstarts?\b/i,
    /\bspread/i,
    /\bautomatically\b/i,
    /\breplac/i,
    /\benabl/i,
    /\bdisabl/i,
    /\bwrap/i,
    /\bperform/i,
    /\bmanag/i,
    /\bcontrol/i,
    /\baccess/i,
    /\bcreat/i,
    /\ballow/i,
    /\bcontain/i,
    /\bregister/i,
    /\bmount/i,
    /\bnavigat/i,
    /\btrigger/i,
    /\bappl(y|ies)/i,
    /\bmeans\b/i,
    /\brepresents/i,
    /so\s+pass/i,
    /for\s+setup/i,
    /used\s+to/i,
    /used\s+for/i,
    /in\s+order\s+to/i,
    /for\s+\w+ing\b/i,
    /e\.g\./i,
    /for\s+example/i,
    /default\s+of/i,
    /defaults?\s+to/i,
    /with\s+a\s+default/i,
    /from\s+\d+\s+to\s+\d+/i,
    /when\s+using/i,
    /you\s+can/i,
    /you\s+provide/i,
    /you\s+get/i,
    /gives?\s+access/i,
    /to\s+(enable|perform|run|execute|create|manage|handle)\b/i,
    /\bconfigur/i,
    /\bschema/i,
    /\bvalidat/i
]

/** Markers that the answer is a declaration/signature restatement. */
const SIGNATURE: RegExp[] = [
    /\bof\s+type\b/i,
    /\btakes?\s+(a|an|two|three|one|four)\b/i,
    /\baccepts?\b/i,
    /\breturns?\s+(a|an|`|the|void|Promise|<|\w+<)/i,
    /\bsignature\s+(is|:)/i,
    /\bextends\b/i,
    /\binterface\b/i,
    /\bgeneric\s+type\b/i,
    /\boverload/i,
    /\bparameters?:/i,
    /\bconstructor\s+accepts/i,
    /declare\s+(const|function)/i
]

function firstMatch(text: string, patterns: RegExp[]): string | null {
    for (const p of patterns) {
        const m = p.exec(text)
        if (m) return m[0]
    }
    return null
}

/**
 * Strip signature/declaration fragments so the behavioural scan sees only PROSE.
 *
 * A behavioural verb is a signal ONLY when it is a verb in prose ("the base URL is
 * prepended", "you use X to Y"), NEVER when it is a method/identifier token inside a
 * declaration. Without this, a bare type-only answer like
 *   "It has methods route(url, handler) and use(...handlers)."
 * is wrongly cleared, because `use(...handlers)` matches /\buse\b/ and `handler` matches
 * /handle/. So before scanning for behaviour we remove:
 *   - `name(args)` call fragments, whose args are identifiers, not prose (this is what
 *     carries the method-name verbs);
 *   - `declare const|function|module|class|namespace …` declaration lines.
 * The SIGNATURE gate still runs against the ORIGINAL answer, so stripping never weakens
 * gate 3 — it only prevents an identifier inside a signature from masquerading as prose.
 * Deliberately conservative: it does NOT strip `: Type` annotations or backtick spans,
 * because a colon or backtick often precedes real behavioural prose ("Usage: call …",
 * "`sql` is prepended …"), and removing those would silently drop behaviour and MANUFACTURE
 * false positives — worse than the recall gap this fixes.
 */
export function proseOf(answer: string): string {
    return answer
        .replace(/[\w$][\w$.]*\s*\([^)]*\)/g, ' ')
        .replace(/\bdeclare\s+(const|function|module|class|namespace)\b[^.\n]*/gi, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
}

/**
 * Decide whether a pi-worker-docs `answer` to `question` is type-only — a signature/declaration
 * restatement with no behavioural statement, for a question that needed usage semantics.
 *
 * @param answer   the child's <answer> prose (NOT the version banner or the source excerpt).
 * @param question the query the answer was produced for.
 */
export function isTypeOnlyAnswer(answer: string, question: string): TypeOnlyVerdict {
    const a = answer.trim()
    const q = question.trim()

    if (a.length === 0) {
        return {typeOnly: false, reason: 'empty answer'}
    }
    if (isAbstention(a)) {
        return {
            typeOnly: false,
            reason: 'explicit "unclear" non-answer — routed through the existing unclear/escalation path, not type-only'
        }
    }

    const usage = firstMatch(q, USAGE_INTENT)
    if (usage === null) {
        return {
            typeOnly: false,
            reason: 'question requests a type/signature/definition, not usage semantics — a signature answer is responsive'
        }
    }

    // Scan for behavioural verbs over the PROSE only — a verb that is really a method name
    // inside a signature (`use(...handlers)`) must not read as a statement of behaviour.
    const behavioural = firstMatch(proseOf(a), BEHAVIOURAL)
    if (behavioural !== null) {
        return {
            typeOnly: false,
            reason: `answer states behaviour/usage (matched "${behavioural}") — not type-only`
        }
    }

    const signature = firstMatch(a, SIGNATURE)
    if (signature === null) {
        return {
            typeOnly: false,
            reason: 'answer is not a signature/declaration restatement'
        }
    }

    return {
        typeOnly: true,
        reason: `usage question answered only with a signature/declaration restatement (matched "${signature}") and no behavioural statement`
    }
}
