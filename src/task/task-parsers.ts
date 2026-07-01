/**
 * Task file parsing and formatting.
 *
 * Pure functions for parsing YAML front matter, extracting sections, and
 * normalising task IDs. No I/O.
 */

import {PHASE_INDEX, type TaskFrontMatter} from './task-types.js'

const FRONT_MATTER_KEYS: (keyof TaskFrontMatter)[] = [
    'id',
    'state',
    'phase',
    'created_at',
    'updated_at',
    'title',
    'label',
    'reason'
]

// ─── Front matter ────────────────────────────────────────────────────────────

export function emitFrontMatter(fm: TaskFrontMatter): string {
    const lines = ['---']
    for (const k of FRONT_MATTER_KEYS) {
        const v = fm[k]
        if (v === undefined || v === '') {
            // Optional fields are omitted entirely when empty rather than emitted
            // as a blank `key:` line.
            if (k === 'reason' || k === 'label') continue
        }
        lines.push(`${k}: ${typeof v === 'string' ? v : String(v)}`)
    }
    lines.push('---')
    return lines.join('\n')
}

export function parseFrontMatter(content: string): TaskFrontMatter | null {
    // `\r?\n` throughout so a CRLF/Windows task file parses too. Reads normally
    // pass through readTextFile (which normalizes to LF), but tolerating CRLF at
    // the parser itself is the safety net for any read site that forgets to —
    // exactly the class of miss that shipped in 0.17.8. See shared/fs-text.ts.
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content)
    if (!m) return null
    const obj: Record<string, string> = {}
    for (const line of m[1].split(/\r?\n/)) {
        const kv = /^([a-z_]+):\s*(.*)$/.exec(line)
        if (kv) obj[kv[1]] = kv[2]
    }
    if (!obj.id || !obj.state || !obj.phase || !obj.created_at) return null
    if ((PHASE_INDEX as Record<string, number>)[obj.phase] === undefined) {
        return null
    }
    return {
        id: obj.id,
        state: obj.state as TaskFrontMatter['state'],
        phase: obj.phase as TaskFrontMatter['phase'],
        created_at: obj.created_at,
        updated_at: obj.updated_at ?? obj.created_at,
        title: obj.title ?? '',
        label: obj.label || undefined,
        reason: obj.reason || undefined
    }
}

// ─── Section helpers ─────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function sectionRegex(heading: string): RegExp {
    // Group 1 captures ONLY the heading line — `[ \t]*\n`, not `\s*\n`. A greedy
    // `\s*` swallows every blank line after the heading into the capture, and
    // setTaskSection re-emits that capture verbatim plus one more `\n`, so each
    // rewrite grew the gap by a blank line (the "big empty gap" under `## tasks`
    // after a long /task-auto run). Keeping blanks in group 2 lets the `.trim()`
    // every reader already applies collapse them, which also self-heals files
    // that already accumulated the gap.
    // `[ \t]*\r?\n` on the heading line so a CRLF file still matches the section
    // (belt-and-suspenders alongside read-boundary normalization; see fs-text.ts).
    return new RegExp(
        `(^## ${escapeRegex(heading)}[ \\t]*\\r?\\n)([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
        'm'
    )
}

export function extractSection(body: string, heading: string): string | null {
    const m = sectionRegex(heading).exec(body)
    return m ? m[2].trim() : null
}

// ─── Task ID helpers ─────────────────────────────────────────────────────────

export function normaliseTaskId(input: string): string {
    const trimmed = input.trim()
    if (/^TASK_\d{4,}$/.test(trimmed)) return trimmed
    if (/^\d+$/.test(trimmed)) return `TASK_${trimmed.padStart(4, '0')}`
    return trimmed
}
