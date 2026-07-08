/**
 * Deterministic synthesized-wiring scanner for a composed spec (run-8 F3, gen side).
 *
 * F3 (the dominant run-8 shipped defect): refine/compose invent a "uniform" wiring
 * table — one module → one mount prefix, `/api/<x>` → `<x>Routes` for every module —
 * though the design pins ENDPOINTS, not mounts, and one module's pinned endpoints do
 * NOT all sit under a single prefix (photos: `POST /api/listings/:id/photos` AND
 * `GET/DELETE /api/photos/:id`). Mounting that module at `/api/photos` double-prefixes
 * the upload; consumers follow the pinned paths, assembly follows the invented table,
 * the seam ships broken. See [[contract-registry-f3]] (#4, the verify-side + registry
 * lever) — this is its GENERATION-side complement.
 *
 * A/B-measured on the live 27B (F3 critique trap): the CROSS-SLICE CONTRACTS registry
 * is NECESSARY but the prompt+registry alone is a WEAK catcher (A/B arms 0/8, +registry
 * only 1/8) — the model's attention goes to the obvious VERIFY weakness and it rarely
 * does the path-composition reasoning even with the facts in front of it. The reliable
 * lever is the SAME probe+rule pattern as [[skip-escape-scanner-f2]] / [[verify-
 * substitution-ab]]: a deterministic finding that NAMES the exact synthesized mappings
 * and juxtaposes the verbatim pinned facts, forcing focused reconciliation.
 *
 * This scanner does NOT decide which mapping is wrong — that needs routing-composition
 * knowledge (a forbidden stack assumption). It surfaces every mapping that (a) is not a
 * verbatim substring of the design/registry (so it is INFERRED, not cited) AND (b) touches
 * a pinned cross-slice boundary (an operand appears in the registry) — i.e. it reshapes a
 * shared contract. The 4 coincidentally-correct mappings are surfaced too, but framed as
 * "reconcile each; keep the conforming ones" — the LLM decides, informed. Pure text/
 * substring analysis; no stack, framework, or routing assumptions. Empty registry (single
 * `/task`, or no shared boundary) ⇒ no-op.
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
    /** The offending mapping line, verbatim (trimmed). */
    line: string
    /** Left operand (the mapped-from token, e.g. a mount prefix). */
    from: string
    /** Right operand (the mapped-to token, e.g. a module name). */
    to: string
}

/** Collapse whitespace + lowercase; drop markdown backticks so quoting formatting
 *  differences don't defeat the substring match. Mirrors contracts.ts's normalise. */
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
        // Only a mapping that touches a PINNED shared boundary is an F3 suspect — this
        // is the crisp discriminator that keeps internal-flow prose ("input → output")
        // out. An operand (long enough to be specific) must appear in the registry.
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
 * Render findings as a critique-rewrite defect block (fed into the FOCUS list): the
 * rewrite must reconcile each mapping against the pinned facts and correct only the
 * one(s) that break. Mirrors skipEscapeDefectText's shape.
 */
export function wiringDefectText(findings: WiringClaim[], registry: string): string {
    return wiringProbeText(findings, registry)
}

// An @-file mention in a spec ("@DESIGN/foo.md"), minus trailing prose punctuation.
// Mirrors phantom-imports' mention rules so grounding sees the same source docs.
const MENTION_RE = /(?:^|\s)@([^\s]+)/g
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/**
 * Concatenate the design/spec docs the given texts @-reference (best-effort, readable
 * files only) as extra grounding for findSynthesizedWiring — so a mapping the design
 * states verbatim is treated as CITED, not synthesized. Unreadable/absent mentions are
 * skipped; returns '' when nothing resolves.
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
