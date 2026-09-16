/**
 * spec-model — the composed spec as a VALUE, and the one parser that produces it.
 *
 * The spec travelled as an opaque blob: the verify child got a string, the
 * resolution judge got the same string, the prohibition probe re-scanned it line
 * by line with its own regex, and the frozen-path guard re-scanned it again
 * through that. Nothing could ask the spec a question — least of all "where did
 * this constraint come from" — so a constraint a grill auto-answer invented was
 * indistinguishable from one the user wrote, and both gates held it unwaivable
 * (0043).
 *
 * So the spec parses once, here, into a value whose constraints carry their
 * PROVENANCE, and `constraint-policy.ts` turns that provenance into the weight
 * both gates render. This module knows nothing about gates, prompts or git: it
 * turns text into a shape.
 *
 * NOT this module's job: `extractCapsSection` (refuted-constraint.ts). That reads
 * the REFINED PROMPT, a different document with a different grammar, written
 * before any spec exists.
 */
import type {QaKind} from './qa-transcript.js'

/**
 * Where one constraint came from.
 *
 * A `QaKind` means the composer traced it to that numbered Q&A answer. `spec`
 * means the composer traced it to the refined task itself. `derived` is the
 * honest default for an untagged constraint — the composer wrote it and named no
 * source, which is a weaker claim than either of the other two, and the policy
 * table treats it as such.
 */
export type ConstraintProvenance = QaKind | 'spec' | 'derived'

export interface Constraint {
    /** The constraint text, with the provenance tag removed. */
    text: string
    provenance: ConstraintProvenance
}

export interface Spec {
    goal: string
    constraints: Constraint[]
    acceptance: string[]
    /** The VERIFY section verbatim, fence and all — `spec-validation.ts` owns
     *  what counts as a runnable block inside it. */
    verify: string
}

/** The tag COMPOSE_PROMPT asks for: `[from: Q3]`, or `[from: spec]`. */
const FROM_TAG_RE = /\[from:\s*(Q(\d+)|spec)\s*\]/i

/** Resolves a `Q<n>` tag to the kind of the answer that numbered question got. */
export type QaResolver = (questionNumber: number) => QaKind | null

const SECTION_RE = /^\s*(GOAL|CONSTRAINTS|ACCEPTANCE|VERIFY)\b\s*:?\s*$/i
const BULLET_RE = /^\s*[-*]\s+(.*)$/

type SectionName = 'GOAL' | 'CONSTRAINTS' | 'ACCEPTANCE' | 'VERIFY'

/**
 * Split a `## spec` section's text into its four parts. A section the spec never
 * opened is an empty string; the four are independent, so a malformed spec
 * degrades one part rather than the whole value.
 */
function splitSections(section: string): Record<SectionName, string[]> {
    const out: Record<SectionName, string[]> = {
        GOAL: [],
        CONSTRAINTS: [],
        ACCEPTANCE: [],
        VERIFY: []
    }
    let current: SectionName | null = null
    for (const line of section.split('\n')) {
        const header = SECTION_RE.exec(line)
        if (header) {
            current = header[1].toUpperCase() as SectionName
            continue
        }
        if (current) out[current].push(line)
    }
    return out
}

/**
 * Bullet list → one entry per bullet, with wrapped continuation lines folded back
 * onto the bullet they belong to.
 *
 * Folding is not cosmetic: real specs wrap a constraint over four lines, and the
 * prohibition probe reads "the line carrying the ban" — split, the ban and the
 * path it names land in different entries and the probe sees neither.
 */
function parseBullets(lines: string[]): string[] {
    const out: string[] = []
    for (const line of lines) {
        const bullet = BULLET_RE.exec(line)
        if (bullet) {
            out.push(bullet[1].trim())
            continue
        }
        const text = line.trim()
        if (text.length === 0 || out.length === 0) continue
        out[out.length - 1] = `${out[out.length - 1]}\n${text}`
    }
    return out
}

/**
 * Read one bullet's `[from:]` tag. An unresolvable `Q<n>` — the transcript is
 * shorter than the number, or there is no transcript at all — is `derived`, not
 * an invented kind: a tag naming an answer nobody can produce proves nothing
 * about the constraint's origin.
 */
function readProvenance(text: string, resolve: QaResolver | undefined): Constraint {
    const tag = FROM_TAG_RE.exec(text)
    if (!tag) return {text, provenance: 'derived'}
    const stripped = text
        .replace(FROM_TAG_RE, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    if (tag[2] === undefined) return {text: stripped, provenance: 'spec'}
    const kind = resolve?.(Number(tag[2])) ?? null
    return {text: stripped, provenance: kind ?? 'derived'}
}

/**
 * Parse a composed spec into its value. The SINGLE parser: `extractSpecForVerification`,
 * `extractProhibitions` and (through the latter) `frozenPathsFromSpec` all read
 * this shape, so "what the spec says" cannot mean two things in two gates.
 *
 * Total — any text parses. A spec missing a section yields that section empty,
 * which is what the callers already handle (no constraints ⇒ nothing forbidden).
 */
export function parseSpec(section: string, resolve?: QaResolver): Spec {
    const parts = splitSections(section)
    return {
        goal: parts.GOAL.join('\n').trim(),
        constraints: parseBullets(parts.CONSTRAINTS).map(t => readProvenance(t, resolve)),
        acceptance: parseBullets(parts.ACCEPTANCE),
        verify: parts.VERIFY.join('\n').trim()
    }
}

/**
 * Render a parsed spec back to the four-section text the composer emits. Its
 * point is the round-trip: `parseSpec(formatSpec(s))` equals `s`, which is what
 * makes the parser answerable to 21 real specs rather than to its own tests.
 * Provenance rides back out as the same `[from:]` tag, except for `derived`,
 * whose absence IS its spelling.
 */
export function formatSpec(spec: Spec): string {
    const tag = (c: Constraint): string =>
        c.provenance === 'derived' ? ''
        : c.provenance === 'spec' ? ' [from: spec]'
        : ` [from: ${c.provenance}]`
    return [
        'GOAL',
        spec.goal,
        '',
        'CONSTRAINTS',
        ...spec.constraints.map(c => `- ${c.text}${tag(c)}`),
        '',
        'ACCEPTANCE',
        ...spec.acceptance.map(a => `- ${a}`),
        '',
        'VERIFY:',
        spec.verify
    ].join('\n')
}

/**
 * Slice the delivered spec out of a task file body: everything under `## spec`
 * down to the next `## ` heading (a `### ` subheading stays inside). Null when
 * the section is absent or blank — a task that never reached compose, which the
 * verify gate treats as nothing to verify.
 */
export function sliceSpecSection(taskBody: string): string | null {
    const lines = taskBody.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
        if (/^##\s+spec\s*$/i.test(lines[i])) {
            start = i + 1
            break
        }
    }
    if (start === -1) return null
    let end = lines.length
    for (let i = start; i < lines.length; i++) {
        if (/^##\s+\S/.test(lines[i])) {
            end = i
            break
        }
    }
    const spec = lines.slice(start, end).join('\n').trim()
    return spec.length > 0 ? spec : null
}
