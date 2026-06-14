/**
 * Output parsers for the pi-task pipeline.
 *
 * Pure functions that parse raw model output into structured data.
 */

import {MAX_GRILL_QUESTIONS} from './phases.js'

// ─── Types ───────────────────────────────────────────────────────────────────

export type AutoAnswer =
    | {kind: 'answered'; text: string; raw: string}
    | {kind: 'unknown'; suggested?: string; alt?: string; raw: string}

/** One /task-auto clarify question with its model-recommended default answer. */
export interface ClarifyQuestion {
    question: string
    suggested?: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const GRILL_LINE_RE = /^\s*\d+[.)]\s+(.+)$/
export const SUGGESTED_LINE_RE = /^\s*SUGGESTED:\s*(.*)$/i

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

/** Split a question line's text into the question and any inline SUGGESTED default. */
function splitInlineSuggested(text: string): ClarifyQuestion {
    const m = INLINE_SUGGESTED_RE.exec(text)
    if (!m) return {question: text.trim()}
    const question = text.slice(0, m.index).trim()
    const suggested = text.slice(m.index + m[0].length).trim()
    return suggested.length > 0 ? {question, suggested} : {question}
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
        }
    }
    return out
}

// ─── Auto-answer parser ──────────────────────────────────────────────────────

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
            raw
        }
    }
    if (lines.length > 0) return {kind: 'unknown', suggested: lines[0], raw}
    return {kind: 'unknown', raw}
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
