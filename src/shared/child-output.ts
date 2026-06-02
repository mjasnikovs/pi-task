/**
 * Shared utilities for parsing and formatting child pi output.
 *
 * Used by both fetch-core (web page extraction) and docs-core (npm package
 * docs extraction). The child pi outputs <answer> and <excerpt> XML tags;
 * these functions parse, verify, and format the result.
 */

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

/** Check whether an excerpt appears verbatim in the source content
 *  (whitespace-normalised). Returns false for empty excerpts. */
export function isExcerptInContent(excerpt: string, content: string): boolean {
    if (!excerpt) return false
    return normaliseWhitespace(content).includes(normaliseWhitespace(excerpt))
}

/** Format the child's parsed output with a header and optional excerpt block.
 *  When `verified === false` a warning is prepended. */
export function formatResultText(
    header: string,
    parsed: {answer: string; excerpt?: string},
    verified: boolean | undefined
): string {
    if (!parsed.excerpt) {
        return header ? `${header}\n\n${parsed.answer}` : parsed.answer
    }
    const quote = parsed.excerpt.replace(/\n/g, '\n> ')
    const warning =
        verified === false ?
            'WARNING: cited excerpt not found verbatim in source content — the child pi may have paraphrased or hallucinated.\n\n'
        :   ''
    return `${warning}${header}\n\n${parsed.answer}\n\nSource excerpt:\n> ${quote}`
}
