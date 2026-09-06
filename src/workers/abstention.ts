/**
 * ABSTENTION — the explicit non-answer a focused-extractor child writes when the
 * content it was given cannot answer the question, and the one place both halves
 * of that contract live.
 *
 * WHY ONE MODULE. The sentinel has two halves that MUST agree: the sentence a
 * prompt instructs the child to emit, and the predicate that later recognises it.
 * Held apart, each corpus grows its own phrasing and its own regex, and a regex
 * that names only some of the corpora scores the rest as real answers — silently,
 * because a non-answer is well-formed output. Here `buildExtractionPrompt` and
 * `ABSTENTION_RE` are both built from `NOUNS`, so a new corpus is one row in that
 * table and cannot be half-wired.
 *
 * The consumers split two ways. It must not be SCORED as an answer
 * (typeonly-log.ts, task/type-only-answer.ts) and it must not be CACHED as one
 * (`docsCacheable` in pi-worker-docs.ts, `fetchCacheable` in pi-worker-fetch.ts) —
 * a non-answer exits 0 like any other, so a cache keyed on exit code alone
 * memoises the dead end and re-serves it to every later sibling.
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
 * A SUBSTRING match, unlike fetch-core's separate `not covered by this page`
 * sentinel, which is anchored. The instructions differ, so the matchers must. The
 * "not covered" rule asks for a partial answer that NAMES what is missing, so a
 * sourced answer legitimately contains the phrase and only an anchored match keeps
 * it from being filed as a coverage miss. Rule 4 below asks for this sentinel
 * INSTEAD of an answer, so nothing sourced can contain it, and a substring match
 * still catches a child that wraps the sentence in an explanation.
 */
const ABSTENTION_RE = new RegExp(
    `unclear\\s+from\\s+this\\s+(${Object.values(NOUNS).join('|')})\\b`,
    'i'
)

/** True when the child declined to answer rather than answering. See the header
 *  for the two decisions this drives. */
export function isAbstention(text: string): boolean {
    return ABSTENTION_RE.test(text)
}

/**
 * The extraction prompt every corpus shares — docs-core.ts and docs-project.ts
 * both build theirs here, differing only in the nouns this signature takes.
 *
 * Rule 4 interpolates `abstentionSentence`, so the sentence the child is told to
 * write is by construction the sentence `isAbstention` looks for. Typing the words
 * instead is what lets the two drift.
 *
 * `subject` is the prose noun ("npm package", "local project's source code");
 * `tag` names both the identity element and the content element, and the two must
 * match because rules 1, 2 and 4 all refer to `<{tag}-content>`.
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
        + `   A question with several parts: answer the parts <${tag}-content> covers, and name\n`
        + `   the parts it does not. Use rule 4's sentence alone only when it covers no part.\n`
        + `5. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<${tag}>${opts.identity}</${tag}>\n`
        + `<question>${opts.query}</question>\n`
        + `<${tag}-content>\n${opts.content}\n</${tag}-content>\n`
    )
}
