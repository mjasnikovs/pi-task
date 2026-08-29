/**
 * A refutation is a DELETION, not an addition.
 *
 * THE LEAD. Refine invented a
 * dependency the design explicitly rules out; the run's own research said so, in
 * writing, in the same file; the composed spec then turned the invention into a
 * capitalised prohibition against the design's own API:
 *
 *:21   refine CONSTRAINTS   "Add only new entries the task requires (e.g.,
 *                              `hono`, `bun-sql`-equivalent, …, `argon2`, …)"
 *:92   research CONTEXT     "Password hashing uses `Bun.password` (built-in
 *                              argon2id) — no external `argon2` or
 *                              `@node-rs/argon2` dependency needed despite the
 *                              task's mention of it."
 *:132  spec CONSTRAINTS     "Do NOT use built-in `Bun.password` for hashing —
 *                              the refined task explicitly requires `argon2`."
 *
 * `argon2@^0.41.0` shipped as a runtime dependency of a repo that never imports
 * it, locked in by a VERIFY assertion, next to a spec telling the next
 * implementer not to use `Bun.sql` — the API the whole data layer is built on.
 *
 * An appended correction loses to the preserved text it contradicts:
 * the correction was APPENDED to research CONTEXT while the wrong text stayed in
 * refine's CONSTRAINTS, and CONSTRAINTS is what the implementer is told is
 * authoritative.
 *
 * THE LEVER. Deterministic detection, then a scoped removal, BEFORE compose sees
 * the refined task. Never a model rewrite: every model-rewrite lever at this seam
 * has resolved contradictions by deleting the AUTHORITATIVE side
 * This pass can only
 * delete a refine-invented token, and can never touch an owned line.
 *
 * The match is lexical, never semantic: a research CONTEXT bullet refutes a
 * refine constraint when it carries one of a closed set of negation-of-need
 * shapes AROUND a backticked token, and that same token appears backticked in a
 * refine CONSTRAINTS line. Both sides are already separate strings in the task
 * file.
 *
 * STEP 0 measured the closed set over
 * every recorded task file in the corpus before any of it was wired.
 */

/** Bare ALL-CAPS section header, the boundary convention used across the
 *  refined prompt and every research section. */
const HEADER = /^[A-Z][A-Z -]*$/

/** A backticked run with no whitespace inside — the only thing this pass will
 *  ever treat as a token. */
const TOKEN = '`[^`\\s]+`'

/** One token, or a list of them joined by `,` / `or` / `and`. */
const TOKEN_LIST = `${TOKEN}(?:(?:\\s*,\\s*|\\s+or\\s+|\\s+and\\s+)${TOKEN})*`

/**
 * The closed negation set. Each pattern anchors the token list INSIDE the
 * negation, so a bullet that names one package negatively and another positively
 * ("no `@node-rs/argon2` dependency — we use `argon2`") can only ever refute the
 * one inside the phrase.
 *
 * Kept deliberately small. `inv-precision` is a FAIL of the whole task on one
 * false drop, so a shape earns its place here only by surviving a hand-read of
 * every corpus hit it produces.
 */
const NEGATIONS: {name: string; re: RegExp; needsDepWord?: true}[] = [
    {
        // "no external `argon2` or `@node-rs/argon2` dependency needed" — THE LEAD
        name: 'no-external-dep-needed',
        re: new RegExp(
            `\\bno\\s+external\\s+(${TOKEN_LIST})\\s+(?:\\w+\\s+){0,2}dependenc(?:y|ies)\\b[^.;]{0,40}?\\b(?:needed|required)\\b`,
            'i'
        )
    },
    {
        // "no `bun-sql` npm package exists"
        name: 'no-package-exists',
        re: new RegExp(
            `\\bno\\s+(${TOKEN_LIST})\\s+(?:npm\\s+)?(?:package|module)\\s+exists\\b`,
            'i'
        )
    },
    {
        // "no `argon2` dependency is needed".
        //
        // The trailing need-negation is NOT optional, and STEP 0 is why. The
        // first cut of this pattern was the bare "no `X` dependency", and it
        // fired 300 times in 306 corpus hits — every one of them on a
        // MANIFEST-STATE bullet that says the exact opposite of a refutation:
        //
        //   "`package.json` currently lists no `hono` or `@hono/zod-validator`
        //    dependencies; they MUST BE ADDED at versions 4.12.27 and 0.8.0"
        //   "`package.json` has … and no `sharp` dependency — MUST ADD `sharp`
        //    as devDependency"
        //
        // Dropping on that signal mutilated real constraints ("use  with the
        // shared `loginSchema`"). "The repo does not have X yet" is a fact about
        // the tree; "X is not needed" is a claim about the task. Only the second
        // one refutes anything.
        name: 'no-dep-needed',
        re: new RegExp(
            `\\bno\\s+(${TOKEN_LIST})\\s+dependenc(?:y|ies)\\s+(?:is\\s+|are\\s+)?(?:needed|required|necessary)\\b`,
            'i'
        )
    },
    // The two shapes below name no dependency noun of their own, so they carry a
    // DEP_WORD guard. STEP 0's near-miss census is the reason: "does not require"
    // appears in 412 corpus CONTEXT bullets, and the shape is overwhelmingly
    // prose about behaviour, not dependencies — "the `GET /api/listings`
    // endpoint does NOT require authentication for the `mine` filter". Token
    // adjacency alone would eventually reach a backticked API expression there.
    {
        // "`argon2` is not needed" / "`argon2` and `sharp` are not required"
        name: 'not-needed',
        re: new RegExp(`(${TOKEN_LIST})\\s+(?:is|are)\\s+not\\s+(?:needed|required)\\b`, 'i'),
        needsDepWord: true
    },
    {
        // "does not require `argon2`"
        name: 'does-not-require',
        re: new RegExp(`\\b(?:does|do)\\s+not\\s+require\\s+(${TOKEN_LIST})`, 'i'),
        needsDepWord: true
    }
]

/** The claim has to be ABOUT a dependency for a dependency to be dropped. */
const DEP_WORD = /\bdependenc(?:y|ies)\b|\bnpm\b|\bpackages?\b|\bdevDependenc(?:y|ies)\b/i

/** The owned-requirement stamp (requirements.ts:813). A line carrying it is a
 *  design-sourced obligation and is NEVER refutable by research — this is the
 *  guard that keeps this pass out of 's failure mode. */
const OWNED_MARKER = 'owned requirement from the source design'

export type Refutation = {
    /** The token as it appears inside the backticks, e.g. `argon2`. */
    token: string
    /** Index into the refined prompt's lines. */
    line: number
    /** The refine CONSTRAINTS line, verbatim, before the drop. */
    constraint: string
    /** The research CONTEXT bullet that refutes it, verbatim. */
    research: string
    /** Which member of the closed negation set fired. */
    pattern: string
}

/** Section body between a bare ALL-CAPS header and the next one (or EOF). */
export function extractCapsSection(text: string, heading: string): string | null {
    const lines = text.split('\n')
    const start = lines.findIndex(l => l.trim() === heading)
    if (start === -1) return null
    const rest = lines.slice(start + 1)
    const end = rest.findIndex(l => HEADER.test(l.trim()) && l.trim().length > 1)
    return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

function tokensIn(span: string): string[] {
    return [...span.matchAll(/`([^`\s]+)`/g)].map(m => m[1])
}

/**
 * Does this look like a package/module name at all? Refutations are about
 * DEPENDENCIES; a backticked prose fragment, a path, or an API expression is not
 * one, and dropping it from a constraint would be a semantic edit.
 */
function isPackageToken(tok: string): boolean {
    if (tok.length > 64) return false
    if (!/^@?[a-z0-9][a-z0-9._/-]*$/i.test(tok)) return false
    // `Bun.password`, `p.dependencies` — dotted API expressions, not packages.
    if (/^[A-Z]/.test(tok)) return false
    return true
}

/** Every research CONTEXT bullet, one entry per bullet (continuations joined). */
function bullets(section: string): string[] {
    const out: string[] = []
    for (const raw of section.split('\n')) {
        const line = raw.trimEnd()
        if (!line.trim()) continue
        if (/^\s*[-*]\s+/.test(line)) out.push(line.trim())
        else if (out.length > 0) out[out.length - 1] += ` ${line.trim()}`
    }
    return out.length > 0 ? out : section.split('\n').filter(l => l.trim())
}

/**
 * Find every (refine constraint line, research refutation bullet, shared token)
 * triple. `refined` is the refined prompt, `research` the research output; both
 * are the exact strings compose is handed.
 */
export function detectRefutations(refined: string, research: string): Refutation[] {
    const constraintsBody = extractCapsSection(refined, 'CONSTRAINTS')
    const contextBody = extractCapsSection(research, 'CONTEXT')
    if (constraintsBody === null || contextBody === null) return []

    // Refuted token → the bullet that refuted it, and the pattern that fired.
    const refuted = new Map<string, {research: string; pattern: string}>()
    for (const bullet of bullets(contextBody)) {
        for (const {name, re, needsDepWord} of NEGATIONS) {
            const m = re.exec(bullet)
            if (!m) continue
            if (needsDepWord && !DEP_WORD.test(bullet)) continue
            for (const tok of tokensIn(m[1])) {
                if (!isPackageToken(tok)) continue
                if (!refuted.has(tok)) refuted.set(tok, {research: bullet, pattern: name})
            }
        }
    }
    if (refuted.size === 0) return []

    const lines = refined.split('\n')
    const constraintStart = lines.findIndex(l => l.trim() === 'CONSTRAINTS')
    const out: Refutation[] = []
    for (let i = constraintStart + 1; i < lines.length; i++) {
        const line = lines[i]
        if (HEADER.test(line.trim()) && line.trim().length > 1) break
        if (line.includes(OWNED_MARKER)) continue
        for (const [tok, src] of refuted) {
            if (!new RegExp(`\`${escapeRe(tok)}\``).test(line)) continue
            out.push({
                token: tok,
                line: i,
                constraint: line,
                research: src.research,
                pattern: src.pattern
            })
        }
    }
    return out
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Delete one token from a constraint line: the backticked span, any word-suffix
 * glued to it (`` `bun-sql` ``-equivalent), and ONE adjacent list separator —
 * the preceding one where there is one, so the list keeps its shape.
 *
 * Returns null when nothing but boilerplate would be left, which the caller
 * turns into a whole-line drop. Never rephrases, never adds a character.
 */
export function dropToken(line: string, token: string): string | null {
    const tokRe = new RegExp(`\`${escapeRe(token)}\`[A-Za-z0-9-]*`, 'g')
    let next = line
    for (;;) {
        const m = tokRe.exec(next)
        if (!m) break
        const start = m.index
        const end = start + m[0].length
        // Prefer eating the separator BEFORE the token; fall back to the one
        // after it (first element of a list).
        const before = next.slice(0, start)
        const sepBefore = /(?:,\s*|\s+or\s+|\s+and\s+)$/.exec(before)
        if (sepBefore) {
            next = next.slice(0, start - sepBefore[0].length) + next.slice(end)
        } else {
            const sepAfter = /^(?:\s*,\s*|\s+or\s+|\s+and\s+)/.exec(next.slice(end))
            next = before + next.slice(end + (sepAfter ? sepAfter[0].length : 0))
        }
        tokRe.lastIndex = 0
    }
    if (next === line) return line
    // An emptied list ("(e.g., )") or an emptied bullet is a whole-line drop.
    const carcass = next
        .replace(/^\s*[-*]\s*/, '')
        .replace(/\(\s*e\.g\.,?\s*\)/gi, '')
        .replace(/[\s,.;:()]/g, '')
    if (carcass.length === 0) return null
    return next
}

export type RefutationResult = {
    /** The refined prompt with every refuted token deleted. */
    refined: string
    /** One trail line per drop, both source lines quoted. */
    trail: string[]
    refutations: Refutation[]
}

/**
 * Apply every detected refutation to the refined prompt. Purely subtractive: the
 * result is always a character subsequence of the input (`inv-no-line-invention`).
 */
export function applyRefutations(refined: string, research: string): RefutationResult {
    const refutations = detectRefutations(refined, research)
    if (refutations.length === 0) return {refined, trail: [], refutations}

    const lines = refined.split('\n')
    const dropped = new Set<number>()
    const trail: string[] = []
    for (const r of refutations) {
        const current = lines[r.line]
        const next = dropToken(current, r.token)
        if (next === null) {
            dropped.add(r.line)
            trail.push(
                `constraint refuted by research — dropped the whole CONSTRAINTS line for '${r.token}'`
                    + ` | constraint: "${r.constraint.trim()}" | research: "${r.research.trim()}"`
            )
        } else {
            lines[r.line] = next
            trail.push(
                `constraint refuted by research — dropped '${r.token}' from CONSTRAINTS`
                    + ` | constraint: "${r.constraint.trim()}" | research: "${r.research.trim()}"`
            )
        }
    }
    const kept = lines.filter((_l, i) => !dropped.has(i))
    return {refined: kept.join('\n'), trail, refutations}
}
