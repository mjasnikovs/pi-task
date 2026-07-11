/**
 * user-directives — deterministic extraction of the imperative tool/method
 * directives a user writes into a raw task prompt, so a downstream rewrite (refine)
 * cannot silently drop them.
 *
 * The failure this closes (mx5 run 9, validated): the raw prompt was
 *   "Research Playwright best practices VIA WEB SEARCH — focus on E2E testing…"
 * Refine rewrote the task well in every other respect (it correctly killed a wrong
 * "Next.js" framing) but the "via web search" instruction vanished from the refined
 * spec entirely — and the whole 2-run session then made ZERO pi-worker-search and
 * ZERO pi-worker-fetch calls. A user who explicitly asks for web search must get
 * web search; the model's paraphrase is not allowed to quietly demote it to
 * "research from local files".
 *
 * The mechanism is the lever, the prompt is the belt: refine is HANDED the
 * directives as a MUST-PRESERVE block (prompt), and — because a weak model still
 * drops them some fraction of the time — the refined text is deterministically
 * re-checked afterwards and the directive is APPENDED verbatim if it went missing
 * (mechanism). Extraction is conservative: only concrete tool/method directives
 * (web search, fetch <url>) are recognised, and a negated mention ("do NOT use web
 * search") is ignored, so a prompt that never asked for a tool gets nothing added.
 */

export type UserDirectiveKind = 'web-search' | 'fetch-url'

export interface UserDirective {
    kind: UserDirectiveKind
    /** The canonical MUST line threaded into refine and appended as a backstop. */
    must: string
    /** Regexes that, if ANY matches the refined text, prove the directive survived. */
    survives: RegExp[]
}

/** ~24 chars of lead-in before a match, scanned for a negation that flips intent. */
const NEGATION = /\b(?:no|not|never|without|don'?t|do not|avoid|skip)\b[^.?!]{0,24}$/i

function isNegated(text: string, matchIndex: number): boolean {
    return NEGATION.test(text.slice(Math.max(0, matchIndex - 40), matchIndex))
}

// "web search", "search the web/internet", "search online" — the concrete
// external-research directive. Kept tight so ordinary prose ("search the codebase",
// "search for the function") never trips it: the object must be web/internet/online.
const WEB_SEARCH_RE =
    /\bweb[-\s]*search(?:es|ing)?\b|\bsearch(?:es|ing)?\s+(?:the\s+|on\s+the\s+|across\s+the\s+)?(?:web|internet|online)\b|\bsearch\s+online\b/i

// "fetch https://…" / "fetch the page at https://…" — an explicit fetch directive
// naming a URL. The URL is captured so it can be preserved verbatim.
const FETCH_URL_RE = /\bfetch(?:es|ing)?\b[^.\n]{0,40}?(https?:\/\/[^\s)>"']+)/i

const WEB_SEARCH_SURVIVES = [
    /\bweb[-\s]*search/i,
    /\bsearch(?:es|ing)?\s+(?:the\s+|on\s+the\s+|across\s+the\s+)?(?:web|internet|online)\b/i,
    /\bsearch\s+online\b/i,
    /pi-worker-search/i
]

/**
 * The imperative tool/method directives present in a raw user prompt. Deterministic
 * and side-effect free. Deduped by kind (a prompt that says "web search" twice yields
 * one directive). Empty when the prompt names no concrete tool directive.
 */
export function extractUserDirectives(raw: string): UserDirective[] {
    const out: UserDirective[] = []

    const ws = WEB_SEARCH_RE.exec(raw)
    if (ws && !isNegated(raw, ws.index)) {
        out.push({
            kind: 'web-search',
            must: 'MUST use live web search (via pi-worker-search) — the user explicitly asked to search the web. Do NOT restrict this task to local files or pi-worker-docs only; external web research is a required part of the deliverable.',
            survives: WEB_SEARCH_SURVIVES
        })
    }

    const fu = FETCH_URL_RE.exec(raw)
    if (fu && !isNegated(raw, fu.index)) {
        const url = fu[1]
        out.push({
            kind: 'fetch-url',
            must: `MUST fetch ${url} (via pi-worker-fetch) — the user explicitly asked to fetch this URL; keep it named in the spec.`,
            survives: [/pi-worker-fetch/i, new RegExp(escapeRegExp(url), 'i'), /\bfetch\b/i]
        })
    }

    return out
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Does the refined text still carry `directive`? True when ANY survives-regex hits. */
export function directiveSurvives(refined: string, directive: UserDirective): boolean {
    return directive.survives.some(re => re.test(refined))
}

/**
 * The MUST-PRESERVE block threaded into the refine prompt (the belt). Empty string
 * when there are no directives, so refine is unchanged on an ordinary prompt.
 */
export function preserveDirectivesBlock(directives: UserDirective[]): string {
    if (directives.length === 0) return ''
    const lines = directives.map(d => `- ${d.must}`).join('\n')
    return (
        'USER TOOL DIRECTIVES — MUST PRESERVE (the raw task explicitly names how to do the '
        + 'work; carry each into GOAL/CONSTRAINTS verbatim in intent — never drop or soften '
        + `it to a local-only paraphrase):\n${lines}`
    )
}

/**
 * Backstop (the lever): if the refined spec dropped a directive, append it under a
 * CONSTRAINTS-adjacent header so downstream phases still see it. Returns the possibly
 * amended text and the list of directives that had to be force-appended (for logging).
 */
export function enforceDirectives(
    refined: string,
    directives: UserDirective[]
): {text: string; appended: UserDirective[]} {
    const appended = directives.filter(d => !directiveSurvives(refined, d))
    if (appended.length === 0) return {text: refined, appended}
    const block = appended.map(d => `- ${d.must}`).join('\n')
    const text = `${refined.trimEnd()}\n\nUSER TOOL DIRECTIVES (preserved from the raw prompt):\n${block}\n`
    return {text, appended}
}
