/**
 * ABSTENTION — the explicit non-answer a focused-extractor child writes when the
 * content it was given cannot answer the question, and the one place both halves
 * of that contract live.
 *
 * Why one module. The sentinel has two halves that MUST agree: the sentence a
 * prompt instructs the child to emit, and the predicate that later recognises it.
 * They used to be independent. Three prompts wrote three phrasings — two of them
 * as bare string literals buried in a template — and four regexes matched
 * different subsets of the three:
 *
 *   pi-worker-docs   /unclear from this package/i          (package only)
 *   typeonly-log     /unclear from this (package|project)/i (no page)
 *   type-only-answer /unclear from this (package|page)/i    (no project)
 *   pi-worker-fetch  no check at all
 *
 * That already cost one bug, recorded in typeonly-log: matching only the first
 * silently scored every PROJECT abstention as a valid answer. The fix went into
 * that one regex; the other three never learned.
 *
 * And it was still live on the fetch channel. pi-worker-docs documents F-2(e) at
 * length — an "unclear" non-answer exits 0, so it was memoised into the research
 * cache and re-served to every sibling task (52 of a cached entries were
 * "unclear" with hitCache true), one dead end paid for many times, with
 * escalation unable to re-fire because the miss never recurred. `pi-worker-fetch`
 * cached on `childExitCode === 0` alone, so "unclear from this page" reproduced
 * exactly that failure on pages instead of packages.
 *
 * With emitter and matcher reading one table, a fourth corpus is one row and
 * cannot be half-wired.
 */

/** The content a focused extractor was pointed at. One row per corpus. */
export type AbstentionKind = 'package' | 'project' | 'page'

/**
 * The noun each corpus calls itself IN THE PROMPT. The sentinel is built from
 * this, so the sentence a child is told to write and the sentence the host looks
 * for cannot drift apart.
 */
const NOUNS: Record<AbstentionKind, string> = {
    package: 'package',
    project: 'project',
    page: 'page'
}

/**
 * The exact sentence to instruct a child to emit. Prompt builders must
 * interpolate this rather than typing the words, or the matcher below stops
 * describing what the prompts actually ask for.
 */
export function abstentionSentence(kind: AbstentionKind): string {
    return `unclear from this ${NOUNS[kind]}`
}

/**
 * Matches any corpus's abstention. Built from the same table the prompts read, so
 * adding a corpus cannot leave a matcher behind.
 *
 * Deliberately a SUBSTRING match, unlike fetch-core's separate
 * `not covered by this page` sentinel, which is anchored. The two differ because
 * the instructions differ: the "not covered" rule asks for a partial answer that
 * NAMES what is missing, so a sourced answer can legitimately contain the phrase
 * and an anchored match is required to avoid filing it as a coverage miss. The
 * abstention rule asks for the sentinel INSTEAD of an answer, and models wrap it
 * ("Unclear from this package — the README does not mention it."), so anchoring
 * here would miss the real non-answers this exists to catch.
 */
const ABSTENTION_RE = new RegExp(
    `unclear\\s+from\\s+this\\s+(${Object.values(NOUNS).join('|')})\\b`,
    'i'
)

/**
 * True when the child declined to answer rather than answering.
 *
 * Callers use this for two different decisions and both matter: it must not be
 * SCORED as an answer (typeonly-log, type-only-answer), and it must not be
 * CACHED as one (pi-worker-docs, pi-worker-fetch) — a memoised non-answer is
 * re-served to every later sibling and permanently suppresses escalation.
 */
export function isAbstention(text: string): boolean {
    return ABSTENTION_RE.test(text)
}

/**
 * The extraction prompt every corpus shares.
 *
 * Rules 1–5 were word-for-word identical in the npm and project prompt builders,
 * differing only in the four nouns this signature takes — and one of those, the
 * abstention sentence in rule 4, was a bare literal that the matchers above then
 * had to guess at. Building the prompt from the same table that recognises its
 * output is the whole point: rule 4 tells the child to write EXACTLY the sentence
 * `isAbstention` looks for, by construction.
 *
 * `subject` is the prose noun ("npm package", "local project's source code");
 * `tag` names both the identity element and the content element, which must match
 * because rules 1, 2 and 4 all refer to `<{tag}-content>`.
 */
export function buildExtractionPrompt(opts: {
    kind: AbstentionKind
    subject: string
    tag: string
    /** What goes inside `<{tag}>` — `hono@4.6.3`, or a project name. */
    identity: string
    query: string
    content: string
}): string {
    const {tag} = opts
    return (
        `You answer one question about ${opts.subject}, using only the provided content.\n`
        + `\n`
        + `Rules:\n`
        + `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <${tag}-content>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <${tag}-content>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Prefer type signatures, function declarations, and code blocks as evidence over prose.\n`
        + `4. If the answer is unclear, ambiguous, or absent from <${tag}-content>, write exactly:\n`
        + `   <answer>${abstentionSentence(opts.kind)}</answer> and put the closest related text in <excerpt>.\n`
        + `   Do not guess.\n`
        + `5. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<${tag}>${opts.identity}</${tag}>\n`
        + `<question>${opts.query}</question>\n`
        + `<${tag}-content>\n${opts.content}\n</${tag}-content>\n`
    )
}
