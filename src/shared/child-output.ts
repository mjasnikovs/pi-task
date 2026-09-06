/**
 * Shared utilities for parsing and formatting child pi output.
 *
 * An extraction child is prompted to answer inside `<answer>` and cite inside
 * `<excerpt>` — the rule blocks that ask for it live in fetch-core and
 * abstention. These functions parse those tags, check the citation against the
 * source it was drawn from, and format the result.
 */
import {createHash} from 'node:crypto'

export function parseChildOutput(stdout: string): {answer: string; excerpt?: string} {
    const trimmed = stdout.trim()
    const answerMatch = /<answer>([\s\S]*?)<\/answer>/i.exec(trimmed)
    const excerptMatch = /<excerpt>([\s\S]*?)<\/excerpt>/i.exec(trimmed)
    if (!answerMatch) return {answer: trimmed}
    return {
        answer: answerMatch[1].trim(),
        excerpt: excerptMatch?.[1].trim() || undefined
    }
}

export function normaliseWhitespace(s: string): string {
    return s.replace(/\s+/g, ' ').trim()
}

/**
 * THE excerpt predicate: does this excerpt appear verbatim in the source content,
 * whitespace-normalised? {@link verifyExcerpt} delegates to it, and
 * `normaliseWhitespace` has no caller outside this file, so the codebase holds
 * exactly one definition of "verified".
 *
 * The emptiness test runs on the NORMALISED excerpt, not the raw one, and the
 * distinction is load-bearing. `"   "` has length 3 but normalises to `""`, and
 * `content.includes("")` is true for every content — so a raw-length guard would
 * let a whitespace-only citation verify against anything at all. A citation with
 * no characters in it is not evidence.
 *
 * The shipped extractor cannot reach that input: `parseChildOutput` maps a
 * whitespace-only `<excerpt>` to `undefined` via `.trim() || undefined`, and its
 * one call site tests `parsed.excerpt` before calling in. This guard is what
 * keeps the predicate honest if a second call site appears.
 */
export function isExcerptInContent(excerpt: string, content: string): boolean {
    const ne = normaliseWhitespace(excerpt)
    if (ne.length === 0) return false
    return normaliseWhitespace(content).includes(ne)
}

/**
 * The same verdict as {@link isExcerptInContent}, PLUS a retained record of what was
 * actually checked: the whitespace-normalised excerpt, and a sha256 and length of the
 * normalised content it was searched in.
 *
 * The retained fields make a `verified === false` diagnosable without re-fetching the
 * source. They separate fabrication (the excerpt is nowhere near the content) from a
 * normaliser gap (it is an escape or entity variant of text that IS present), and the
 * content hash says whether two verdicts were even looking at the same page.
 *
 * Adding evidence is the whole change: the verdict itself is not loosened.
 */
export interface ExcerptVerification {
    verified: boolean
    /** sha256 of the whitespace-normalised content the excerpt was checked against. */
    contentSha256: string
    /** Length of that normalised content, so a short/empty page is visible at a glance. */
    contentLength: number
    /** The whitespace-normalised excerpt that was searched for. */
    normalisedExcerpt: string
    /**
     * How many verbatim spans of the source the excerpt is made of — 1 when it
     * verified, more when the child stitched it. Over every unverified excerpt in
     * five live runs it ran 2 to 11, with nothing missing.
     */
    verbatimSpans: number
    /** Words in no span of the source at all. This, not `verified`, is what a
     *  fabrication looks like. */
    absent: string[]
}

/**
 * Tokens that are not source text and not evidence of invention either: the
 * child's own elision marks, and the provenance tag the PROMPT gave it.
 *
 * `buildExtractionPrompt` wraps the identity as `<package>aeson@2.2.5.1</package>`,
 * and re-run 5 caught a child quoting that back inside an otherwise verbatim
 * excerpt — the only absent word in 24 unverified excerpts across three runs. A
 * complete lowercase element is the whole rule; `Vec<String>` does not start with
 * `<` and `<T>` has no closing tag, so neither is excused.
 */
const ELISION = /^(?:\.{3}|\u2026|\/\/\s*\.{3})$/
const PROMPT_TAG = /^<([a-z_]+)>[^<]*<\/\1>$/

/**
 * Cover the excerpt with the longest runs the source actually contains, greedily.
 *
 * `verified` asks whether the excerpt is ONE such run. This asks what it is made
 * of, which is the difference between a quote assembled from four real places and
 * a quote with a word nobody wrote. The warning needs the second question; it had
 * only ever asked the first.
 */
function coverBySource(
    normalisedExcerpt: string,
    normalisedContent: string
): {
    verbatimSpans: number
    absent: string[]
} {
    const words = normalisedExcerpt.length === 0 ? [] : normalisedExcerpt.split(' ')
    const absent: string[] = []
    let verbatimSpans = 0
    let i = 0
    while (i < words.length) {
        let run = 0
        while (
            i + run < words.length
            && normalisedContent.includes(words.slice(i, i + run + 1).join(' '))
        ) {
            run++
        }
        if (run === 0) {
            if (!ELISION.test(words[i]) && !PROMPT_TAG.test(words[i])) absent.push(words[i])
            i++
        } else {
            verbatimSpans++
            i += run
        }
    }
    return {verbatimSpans, absent}
}

export function verifyExcerpt(excerpt: string, content: string): ExcerptVerification {
    const nc = normaliseWhitespace(content)
    const ne = normaliseWhitespace(excerpt)
    return {
        // Delegated on purpose: this struct adds EVIDENCE, never a second opinion.
        verified: isExcerptInContent(excerpt, content),
        contentSha256: createHash('sha256').update(nc).digest('hex'),
        contentLength: nc.length,
        normalisedExcerpt: ne,
        ...coverBySource(ne, nc)
    }
}

/**
 * Format the child's parsed output with a header and optional excerpt block.
 *
 * The note is prepended only on the excerpt path, and only when something was
 * actually checked. With no excerpt the function returns before it is built, and
 * an undefined verification — nothing was checked — prints nothing either. So a
 * note means "checked", never "not checked".
 *
 * Two different findings, because they mean different things to the worker that
 * reads this. An excerpt the source does not contain a word of is a possible
 * fabrication. An excerpt assembled from several real spans is a stitched quote,
 * which is what the extraction prompt produces — and calling that a possible
 * hallucination was wrong on 21 of 21 measured cases, on a fifth of every run's
 * answers. See "Defect 18" in DOC_REGRESSINONS.md.
 */
export function formatResultText(
    header: string,
    parsed: {answer: string; excerpt?: string},
    check: ExcerptVerification | undefined
): string {
    if (!parsed.excerpt) {
        return header ? `${header}\n\n${parsed.answer}` : parsed.answer
    }
    const quote = parsed.excerpt.replace(/\n/g, '\n> ')
    let note = ''
    if (check && !check.verified) {
        note =
            check.absent.length > 0 ?
                'WARNING: cited excerpt not found verbatim in source content — the child pi may have paraphrased or hallucinated.\n\n'
            :   `NOTE: cited excerpt is stitched from ${check.verbatimSpans} separate spans of the source; every span is verbatim.\n\n`
    }
    return `${note}${header}\n\n${parsed.answer}\n\nSource excerpt:\n> ${quote}`
}
