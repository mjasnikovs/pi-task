/**
 * Output parsers for the pi-task pipeline.
 *
 * Pure functions that parse raw model output into structured data.
 */

import {MAX_GRILL_QUESTIONS} from './phases.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * WHY an auto-answer came back `unknown` — the producers are otherwise
 * indistinguishable at the call site, and they are NOT equivalent: only
 * 'api-synthesis' marks a recommendation a machine must never take (see
 * task/yolo.ts). Mechanical tag, never a text pattern-match:
 *   - 'model-unknown' — the child itself emitted UNKNOWN (or the parser salvaged a
 *     bare recommendation): a genuine open fork carrying a best-effort suggestion.
 *   - 'api-synthesis' — the answer was ANSWERED, then DEMOTED because it names an
 *     API identifier absent from the research and the question, in a namespace the
 *     research covers. `Bun.mkdirSync` is the shape: bun-types declares no such
 *     member, but an answer naming it reads as authoritative and can reach both
 *     requirements and the VERIFY block. The suggestion rides along for a HUMAN
 *     to judge.
 *   - 'integration' — an integration/build-wiring unknown no fetched doc grounded;
 *     a wrong guess is a structural landmine, so the model's answer is offered as
 *     a recommendation instead of being taken silently.
 *   - 'threw' — the child failed; there is no recommendation at all.
 */
export type AutoAnswerUnknownReason = 'model-unknown' | 'api-synthesis' | 'integration' | 'threw'

export type AutoAnswer =
    | {kind: 'answered'; text: string; raw: string}
    | {
          kind: 'unknown'
          suggested?: string
          alt?: string
          raw: string
          reason?: AutoAnswerUnknownReason
      }

/** One /task-auto clarify question with its model-recommended default answer. */
export interface ClarifyQuestion {
    question: string
    suggested?: string
    /** Secondary option for a binary "A or B?" fork; mirrors grill's ALT line. */
    alt?: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const GRILL_LINE_RE = /^\s*\d+[.)]\s+(.+)$/
export const SUGGESTED_LINE_RE = /^\s*SUGGESTED:\s*(.*)$/i
export const ALT_LINE_RE = /^\s*ALT:\s*(.*)$/i

// ─── Grill questions parser ──────────────────────────────────────────────────

// The grill-gen prompt instructs the worker to emit the literal token `NONE`
// when it has zero questions, so the runner's empty-output guard can still
// distinguish "intentional silence" from a silent child crash.
export function parseGrillQuestions(raw: string): string[] {
    if (/^\s*NONE\s*$/m.test(raw)) return []
    const out: string[] = []
    for (const line of raw.split('\n')) {
        const m = GRILL_LINE_RE.exec(line)
        if (m) out.push(m[1].trim())
        if (out.length >= MAX_GRILL_QUESTIONS) break
    }
    return out
}

// ─── Clarify (/task-auto) parser ─────────────────────────────────────────────

// Matches a "SUGGESTED:" marker anywhere in a string (not just line-start), so
// we can recover a recommendation the model wrote inline on the question line
// (e.g. "1. ...so this must be resolved. SUGGESTED: use polling.") rather than
// on its own line.
const INLINE_SUGGESTED_RE = /\bSUGGESTED:\s*/i
const INLINE_ALT_RE = /\bALT:\s*/i

/**
 * Split a question line's text into the question, any inline SUGGESTED default,
 * and any inline ALT secondary option (the model may write both on one line:
 * "1. A or B? SUGGESTED: A ALT: B").
 */
function splitInlineSuggested(text: string): ClarifyQuestion {
    const m = INLINE_SUGGESTED_RE.exec(text)
    if (!m) return {question: text.trim()}
    const question = text.slice(0, m.index).trim()
    let rest = text.slice(m.index + m[0].length)
    let alt: string | undefined
    const altM = INLINE_ALT_RE.exec(rest)
    if (altM) {
        const altText = rest.slice(altM.index + altM[0].length).trim()
        if (altText.length > 0) alt = altText
        rest = rest.slice(0, altM.index)
    }
    const suggested = rest.trim()
    return {
        question,
        ...(suggested.length > 0 && {suggested}),
        ...(alt !== undefined && {alt})
    }
}

// Parses the /task-auto clarify output: a numbered question list where each
// question carries a "SUGGESTED: <default>" recommendation — either on its own
// line below the question, or inline at the end of the question line. The first
// SUGGESTED for a question wins; later ones are ignored. The literal token NONE
// (its own line) means "no clarification needed" → [].
//
// Question/suggested text is returned VERBATIM (markdown intact). Inline
// markdown is rendered for display / stripped for storage at the call site via
// the helpers in inline-markdown.ts.
export function parseClarifyList(raw: string): ClarifyQuestion[] {
    if (/^\s*NONE\s*$/m.test(raw)) return []
    const out: ClarifyQuestion[] = []
    for (const line of raw.split('\n')) {
        const q = GRILL_LINE_RE.exec(line)
        if (q) {
            if (out.length >= MAX_GRILL_QUESTIONS) break
            out.push(splitInlineSuggested(q[1].trim()))
            continue
        }
        const s = SUGGESTED_LINE_RE.exec(line)
        if (s && out.length > 0) {
            const suggested = s[1].trim()
            const last = out[out.length - 1]
            if (suggested.length > 0 && last.suggested === undefined) {
                last.suggested = suggested
            }
            continue
        }
        const altLine = ALT_LINE_RE.exec(line)
        if (altLine && out.length > 0) {
            const alt = altLine[1].trim()
            const last = out[out.length - 1]
            if (alt.length > 0 && last.alt === undefined) {
                last.alt = alt
            }
        }
    }
    return out
}

// ─── Auto-answer parser ──────────────────────────────────────────────────────

// Did the model use one of the required output tags (ANSWER/UNKNOWN/ALT,
// tolerating the same ANSWER misspellings parseAutoAnswer accepts)? When no tag
// is present the model ignored the format and wrote free-form prose, so the
// caller reprompts instead of trusting parseAutoAnswer's lenient salvage.
const AUTO_ANSWER_TAG_RE = /^\s*(AN[SW]{1,3}E?R|UNKNOWN|ALT)\s*:/im
export function autoAnswerHasTag(raw: string): boolean {
    return AUTO_ANSWER_TAG_RE.test(raw)
}

export function parseAutoAnswer(raw: string): AutoAnswer {
    const lines = raw
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
    let suggested: string | undefined
    let alt: string | undefined
    let sawUnknown = false
    for (let i = 0; i < lines.length; i++) {
        const t = lines[i]
        const a = /^AN[SW]{1,3}E?R:\s*(.+)$/i.exec(t)
        if (a) return {kind: 'answered', text: a[1].trim(), raw}
        if (!sawUnknown) {
            const u = /^UNKNOWN:\s*(.*)$/i.exec(t)
            if (u) {
                sawUnknown = true
                const inline = u[1].trim()
                if (inline.length > 0) {
                    suggested = inline
                } else {
                    const next = lines[i + 1]
                    if (next && !/^ALT:/i.test(next)) suggested = next
                }
                continue
            }
        }
        if (alt === undefined) {
            const altM = /^ALT:\s*(.+)$/i.exec(t)
            if (altM) alt = altM[1].trim()
        }
    }
    if (sawUnknown || suggested !== undefined || alt !== undefined) {
        return {
            kind: 'unknown',
            ...(suggested !== undefined && {suggested}),
            ...(alt !== undefined && {alt}),
            raw,
            reason: 'model-unknown'
        }
    }
    // Last-resort salvage: the model emitted no tag at all. Take the first line
    // that reads like an answer, NOT a preamble — a trailing colon marks a
    // heading ("Here's the analysis:") that introduces prose rather than
    // recommending anything. Surfacing such a line as the recommendation is the
    // "wrong format" the user sees; better to offer no default and let them
    // answer than to pre-fill a meaningless preamble.
    const salvaged = lines.find(l => !l.endsWith(':'))
    if (salvaged) return {kind: 'unknown', suggested: salvaged, raw, reason: 'model-unknown'}
    return {kind: 'unknown', raw, reason: 'model-unknown'}
}

// ─── Verify tooling output parser ────────────────────────────────────────────

export function parseVerifyToolingOutput(output: string): {
    verified: string[]
    rejected: Array<{cmd: string; reason: string}>
} {
    const verified: string[] = []
    const rejected: Array<{cmd: string; reason: string}> = []
    let section: 'verified' | 'rejected' | null = null
    for (const raw of output.split('\n')) {
        const line = raw.trim()
        if (line === 'VERIFIED') {
            section = 'verified'
            continue
        }
        if (line === 'REJECTED') {
            section = 'rejected'
            continue
        }
        if (!line) continue
        // Lines look like: "  <cmd>  <evidence/reason>"
        const match = line.match(/^(\S.*?)\s{2,}(.+)$/)
        if (!match) continue
        const [, cmd, detail] = match
        if (section === 'verified') verified.push(cmd.trim())
        else if (section === 'rejected') rejected.push({cmd: cmd.trim(), reason: detail.trim()})
    }
    return {verified, rejected}
}

// ─── Title derivation ────────────────────────────────────────────────────────

export function deriveTitle(refined: string): string {
    const stripBold = (s: string) => s.replace(/^\*+|\*+$/g, '').trim()
    const lines = refined.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const stripped = stripBold(lines[i].trim().replace(/^#+\s+/, ''))
        if (/^GOAL\s*:?\s*$/i.test(stripped)) {
            for (let j = i + 1; j < lines.length; j++) {
                const line = lines[j].trim()
                if (line.length === 0) continue
                const headerCheck = stripBold(line.replace(/^#+\s+/, ''))
                if (/^(CONSTRAINTS|KNOWN-UNKNOWNS)\s*:?\s*$/i.test(headerCheck)) break
                return line
            }
            break
        }
    }
    for (const raw of lines) {
        let line = raw.trim()
        if (line.length === 0) continue
        line = stripBold(line.replace(/^#+\s+/, '')).replace(/^GOAL\s*:?\s*/i, '')
        if (line.length === 0) continue
        return line
    }
    return '(untitled)'
}

// ─── Display label ───────────────────────────────────────────────────────────
//
// `title` is stored in full: `deriveTitle` returns the GOAL line whole, however
// long it is, and nothing clamps it on the way to disk. These helpers shrink it
// for status surfaces (widget head, /task list) WITHOUT touching what is stored —
// the pipeline always reads the full title. A model-compressed `label`
// is preferred when present (see title-label.ts); otherwise we fall back to a
// deterministic, word-boundary truncation so a label-less task still reads
// cleanly.

/** Max characters shown for a task's display label. */
export const LABEL_MAX = 72

/**
 * Collapse whitespace and clamp `s` to `max` chars, cutting on a word boundary
 * (when one falls reasonably late) and appending an ellipsis. Returns the
 * collapsed string unchanged when it already fits.
 */
export function truncateLabel(s: string, max = LABEL_MAX): string {
    const flat = s.replace(/\s+/g, ' ').trim()
    if (flat.length <= max) return flat
    const slice = flat.slice(0, max - 1)
    const lastSpace = slice.lastIndexOf(' ')
    const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice
    return cut.trimEnd() + '…'
}

/**
 * The string to show for a task: the stored short `label` when present,
 * otherwise a truncation of the full `title`. Both paths are clamped to
 * LABEL_MAX so a hand-edited or legacy over-long label can't blow up a line.
 */
export function titleForDisplay(task: {title: string; label?: string}): string {
    const label = task.label?.trim()
    if (label) return truncateLabel(label)
    return truncateLabel(task.title)
}
