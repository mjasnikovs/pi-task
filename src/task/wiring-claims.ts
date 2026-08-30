/**
 * Deterministic synthesized-wiring scanner for a composed spec, wired as the
 * `synthesized-wiring` critique probe.
 *
 * The failure it catches: a spec states a "uniform" wiring table — one module to one
 * mount prefix, `/api/<x>` → `<x>Routes` — while the design pins ENDPOINTS, not
 * mounts. When a module's pinned endpoints do NOT all sit under a single prefix
 * (`POST /api/listings/:id/photos` AND `GET /api/photos/:id`), mounting it at
 * `/api/photos` double-prefixes the upload. Consumers follow the pinned paths,
 * assembly follows the invented table, and the seam ships broken.
 *
 * This scanner does NOT decide which mapping is wrong — that needs routing-composition
 * knowledge, which would be a stack assumption. It surfaces every mapping that (a) is
 * not a verbatim substring of the design or registry, so it is INFERRED rather than
 * cited, AND (b) touches a pinned cross-slice boundary, meaning an operand appears in
 * the registry. Conforming mappings are surfaced too, framed as "reconcile each; keep
 * the conforming ones" — the model decides, informed. Pure text and substring analysis;
 * no stack, framework, or routing assumptions. An empty registry (a single `/task`, or
 * a design pinning no shared boundary) is a no-op.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Mapping arrows a wiring/mount table uses across notations. A colon is deliberately
 *  NOT an arrow — it matches endpoint params (`/photos/:id`), section headers, and prose,
 *  which would drown the signal. */
const ARROW = '(?:→|->|=>|⇒|↦)'
/** A `left <arrow> right` mapping on one line, tolerating a leading list bullet. */
const MAPPING_LINE_RE = new RegExp(`^[ \\t]*[-*]?[ \\t]*(.+?)[ \\t]*${ARROW}[ \\t]*(.+?)[ \\t]*$`)
/** An operand shorter than this is too generic to anchor a boundary match. */
const MIN_OPERAND_LENGTH = 4

export interface WiringClaim {
    /** The offending mapping line, trimmed and minus any leading list bullet.
     *  Backticks are KEPT here — only `from`/`to` have them stripped. */
    line: string
    /** Left operand (the mapped-from token, e.g. a mount prefix), backticks stripped. */
    from: string
    /** Right operand (the mapped-to token, e.g. a module name), backticks stripped. */
    to: string
}

/** Collapse whitespace + lowercase, and drop markdown backticks so a spec that
 *  quotes `/api/photos` still matches a design that writes it bare. That backtick
 *  strip is the one thing this does beyond contracts.ts's `normalise`. */
function normalise(s: string): string {
    return s.replace(/`/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Find synthesized wiring mappings in `spec`: `A <arrow> B` lines whose whole mapping
 * is NOT a verbatim substring of `grounding` (design ∪ registry) yet an operand appears
 * in `registry` (so it reshapes a pinned cross-slice boundary). Returns [] when the
 * registry is empty (no shared contracts to reshape) — the whole check is a no-op then.
 */
export function findSynthesizedWiring(
    spec: string,
    grounding: string,
    registry: string
): WiringClaim[] {
    if (registry.trim().length === 0) return []
    const groundHay = normalise(grounding + '\n' + registry)
    const regHay = normalise(registry)
    const found: WiringClaim[] = []
    const seen = new Set<string>()
    for (const rawLine of spec.split('\n')) {
        const m = MAPPING_LINE_RE.exec(rawLine)
        if (!m) continue
        const from = m[1].trim()
        const to = m[2].trim()
        const line = rawLine.replace(/^[ \t]*[-*][ \t]*/, '').trim()
        const key = normalise(line)
        if (key.length === 0 || seen.has(key)) continue
        // Cited, not synthesized: the whole mapping appears verbatim in the source.
        if (groundHay.includes(key)) continue
        // Only a mapping that touches a PINNED shared boundary is a suspect. That is
        // the discriminator keeping internal-flow prose ("input → output") out: an
        // operand, long enough to be specific, must appear in the registry.
        const touchesBoundary = [from, to].some(op => {
            const n = normalise(op)
            return n.length >= MIN_OPERAND_LENGTH && regHay.includes(n)
        })
        if (!touchesBoundary) continue
        seen.add(key)
        found.push({line, from: from.replace(/`/g, ''), to: to.replace(/`/g, '')})
    }
    return found
}

/**
 * Render findings as the critique probe (probe+rule pattern): NAME the inferred
 * mappings and juxtapose the verbatim pinned facts, then instruct focused
 * reconciliation. Deliberately does NOT accuse a specific mapping — the model decides
 * which (if any) fails to reproduce a pinned fact. Empty findings ⇒ '' (no block).
 */
export function wiringProbeText(findings: WiringClaim[], registry: string): string {
    if (findings.length === 0) return ''
    return [
        'SYNTHESIZED WIRING (deterministic finding) — the spec states these connect-the-',
        'modules mappings that are NOT quoted verbatim from the design (they are INFERRED,',
        'not cited) and that touch a pinned cross-slice boundary:',
        ...findings.map((f, i) => `  ${i + 1}. ${f.line}`),
        'The design pins these interface FACTS instead (verbatim, authoritative):',
        ...registry
            .trim()
            .split('\n')
            .filter(l => l.trim().length > 0)
            .map(l => `  - ${l.trim()}`),
        'For EACH mapping above, confirm it REPRODUCES the pinned facts EXACTLY. A module',
        'whose pinned facts do NOT all sit under the single prefix it is mapped to CANNOT be',
        'wired that way without breaking a path — that is a SEAM BUG: name the mapping and the',
        'pinned fact it fails to produce. KEEP every mapping that does reproduce its facts; do',
        'NOT alter a conforming one. If a boundary detail is genuinely unpinned, leave it',
        'unspecified rather than inventing a mapping.'
    ].join('\n')
}

/**
 * The same text under the name the critique-rewrite defect path uses. One rendering
 * serves both readers, so the probe the model sees and the defect the rewrite is
 * handed can never drift apart.
 */
export function wiringDefectText(findings: WiringClaim[], registry: string): string {
    return wiringProbeText(findings, registry)
}

// An @-file mention in a spec ("@DESIGN/foo.md"), minus trailing prose punctuation.
// Byte-identical to auto-orchestrator.ts's pair, so grounding resolves the same
// mentions the planner already resolved. `@` must follow start-of-string or
// whitespace, so "mail@DESIGN.md" is not a mention.
const MENTION_RE = /(?:^|\s)@([^\s]+)/g
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/**
 * Concatenate the design/spec docs the given texts @-reference (best-effort, readable
 * files only) as extra grounding for findSynthesizedWiring — so a mapping the design
 * states verbatim is treated as CITED, not synthesized. Each path is read once across
 * all texts; unreadable or absent mentions are skipped; returns '' when nothing
 * resolves.
 */
export function readReferencedDocs(cwd: string, ...texts: string[]): string {
    const seen = new Set<string>()
    const parts: string[] = []
    for (const text of texts) {
        for (const m of text.matchAll(MENTION_RE)) {
            const rel = m[1].replace(MENTION_TRAILING_PUNCT, '')
            if (rel === '' || seen.has(rel)) continue
            seen.add(rel)
            try {
                parts.push(fs.readFileSync(path.resolve(cwd, rel), 'utf8'))
            } catch {
                // not a readable file — skip
            }
        }
    }
    return parts.join('\n')
}
