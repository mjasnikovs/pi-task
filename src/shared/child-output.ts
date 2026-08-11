/**
 * Shared utilities for parsing and formatting child pi output.
 *
 * Used by both fetch-core (web page extraction) and docs-core (npm package
 * docs extraction). The child pi outputs <answer> and <excerpt> XML tags;
 * these functions parse, verify, and format the result.
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
 * THE excerpt predicate: does this excerpt appear verbatim in the source content
 * (whitespace-normalised)? {@link verifyExcerpt} delegates to it, so there is exactly one
 * definition of "verified" in the codebase.
 *
 * False for an excerpt that is empty OR whitespace-only. The emptiness test is applied to
 * the NORMALISED excerpt, not the raw one: `"   "` is a non-empty string that normalises to
 * `""`, and `content.includes('')` is true for every content — so the raw-string guard let a
 * whitespace-only excerpt "verify" against anything, while `verifyExcerpt` (which tested the
 * normalised length) called the same input unverified. A citation with no characters in it is
 * not evidence, so both now answer false.
 *
 * Unreachable from the shipped extractors — `parseChildOutput` already maps a whitespace-only
 * `<excerpt>` to `undefined` via `.trim() || undefined`, and every call site guards on that —
 * so this is a latent-disagreement fix, not a behaviour change to any recorded verdict.
 */
export function isExcerptInContent(excerpt: string, content: string): boolean {
    const ne = normaliseWhitespace(excerpt)
    if (ne.length === 0) return false
    return normaliseWhitespace(content).includes(ne)
}

/**
 * The same verdict as {@link isExcerptInContent}, PLUS a retained record of what was
 * actually checked — the whitespace-normalised excerpt and a hash+length of the normalised
 * content it was searched in. This is PROMPT-3 item 4: make an `excerptVerified === false`
 * DIAGNOSABLE after the fact, so it can be attributed to fabrication (the excerpt is nowhere
 * near the content) versus a normaliser gap (it is a markdown-escape or entity variant of
 * text that IS present) WITHOUT re-fetching. It deliberately does NOT loosen the verifier:
 * `.verified` IS `isExcerptInContent` — delegated, not re-implemented, so the two cannot
 * drift apart again (they had: a whitespace-only excerpt verified there and failed here).
 * F-3(f) — whether the normaliser needs
 * markdown-escape handling — is left unproven on purpose; you decide that from the retained
 * evidence, not by weakening the one working hallucination detector first.
 */
export interface ExcerptVerification {
    verified: boolean
    /** sha256 of the whitespace-normalised content the excerpt was checked against. */
    contentSha256: string
    /** Length of that normalised content, so a short/empty page is visible at a glance. */
    contentLength: number
    /** The whitespace-normalised excerpt that was searched for. */
    normalisedExcerpt: string
}

export function verifyExcerpt(excerpt: string, content: string): ExcerptVerification {
    const nc = normaliseWhitespace(content)
    const ne = normaliseWhitespace(excerpt)
    return {
        // Delegated on purpose: this struct adds EVIDENCE, never a second opinion.
        verified: isExcerptInContent(excerpt, content),
        contentSha256: createHash('sha256').update(nc).digest('hex'),
        contentLength: nc.length,
        normalisedExcerpt: ne
    }
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
