/**
 * Sibling of refuted-constraint.ts, for the other half of the same failure.
 *
 * That pass deletes a refine-invented DEPENDENCY the research says is not needed.
 * This one deletes a refine-invented API or package the research says is
 * DEPRECATED. Defect 14: refine writes an API example into CONSTRAINTS from
 * memory before research runs, research then names that exact form as superseded,
 * and compose prefers the constraint — so the run ships the deprecated call with
 * the correct answer sitting one section above it in the same file.
 *
 * Everything about the sibling's discipline carries over unchanged: the
 * correction is SUBTRACTIVE (an appended one loses to the text it contradicts),
 * the match is lexical, and an owned-requirement line is never touched.
 *
 * Two things are deliberately NOT shared with the sibling, which is why this is a
 * second pass and not a widening of the first:
 *
 *  - it reads research APIS as well as CONTEXT, and two of the three recorded
 *    fires are in APIS;
 *  - its token class admits an UN-BACKTICKED API expression (`z.string().email()`),
 *    which `isPackageToken` refuses on purpose to keep the dependency channel
 *    narrow. Widening that channel to reach this one would loosen it for every
 *    dependency drop.
 */

/** Bare ALL-CAPS section header — same boundary convention as the sibling. */
const HEADER = /^[A-Z][A-Z -]*$/

/**
 * The closed deprecation set, exactly as the base-rate measurement left it.
 *
 * `\breplaced by\b` was in the first pattern set and the measurement REMOVED it:
 * it fired on "`src/shared/index.ts`  Empty file to be replaced by schema.ts
 * exports", a claim about a FILE, and it was the only false positive in 14,171
 * task files. Dropping it loses none of the three true fires.
 */
const DEPRECATION =
    /@?\bdeprecated\b|\bsupersed(?:e|es|ed)\b|\bmerged\s+into\b|\bno\s+longer\s+(?:recommended|supported|maintained)\b/i

/**
 * Where the token's own clause ends. A deprecation marker past one of these is a
 * claim about something else — on "z.email()  … for adminEmail (z.string().email()
 * … is @deprecated)" the opening paren is what stops the leading symbol from
 * inheriting the verdict on the expression inside it.
 *
 * A character window was measured first and rejected: it is flat from 41 to 4,000
 * over 12,568 task files, so the corpus cannot choose one and any value would be
 * a guess. The clause boundary reproduces the same 3 fires with no constant.
 */
const CLAUSE_END = /[;()\u2014\u2013]|\.\s/

/** The owned-requirement stamp requirements.ts writes. Never refutable. */
const OWNED_MARKER = 'owned requirement from the source design'

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*'
const CALL = '\\([^()]*\\)'

/**
 * A call expression: identifiers and calls chained with `.`, requiring at least
 * one of each. `Network.Wai.Test` is a module path and does not qualify;
 * `z.string().email()` does. This is the class the sibling refuses.
 */
const EXPRESSION = new RegExp(`${IDENT}(?:\\.${IDENT}|${CALL})+`, 'g')

/**
 * A package name, narrowed to the compound forms. A bare word (`aeson`, `text`)
 * is excluded: on the leading-symbol rule below it would let any one-word noun in
 * a deprecation sentence reach CONSTRAINTS, and no recorded fire needs it.
 */
const PACKAGE = /^@?[a-z][a-z0-9.]*(?:[-/][a-z0-9.]+)+$/

export type Deprecation = {
    /** The deprecated token, as it must be matched inside the constraint. */
    token: string
    /** Index into the refined prompt's lines. */
    line: number
    /** The refine CONSTRAINTS line, verbatim, before the drop. */
    constraint: string
    /** The research line that deprecates it, verbatim. */
    research: string
    /** `apis-symbol` or `marker-adjacent` — which rule fired. */
    rule: string
}

/** Section body between a bare ALL-CAPS header and the next one (or EOF). */
function capsSection(text: string, heading: string): string | null {
    const lines = text.split('\n')
    const start = lines.findIndex(l => l.trim() === heading)
    if (start === -1) return null
    const rest = lines.slice(start + 1)
    const end = rest.findIndex(l => HEADER.test(l.trim()) && l.trim().length > 1)
    return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** One entry per bullet or per `symbol  description` row; continuations joined. */
function entries(section: string): string[] {
    const out: string[] = []
    for (const raw of section.split('\n')) {
        const line = raw.trimEnd()
        if (!line.trim()) continue
        if (/^\s*[-*]\s+/.test(line) || !/^\s/.test(line)) out.push(line.trim())
        else if (out.length > 0) out[out.length - 1] += ` ${line.trim()}`
        else out.push(line.trim())
    }
    return out
}

function stripTicks(s: string): string {
    return s.replace(/`/g, '')
}

/**
 * Every expression on the line whose deprecation marker sits in the same clause,
 * ahead of it. Forward-only: "X is deprecated, use Y" must not indict Y, and Y is
 * always on the far side of the marker.
 */
function markerAdjacent(line: string): string[] {
    const flat = stripTicks(line)
    const out: string[] = []
    for (const m of flat.matchAll(EXPRESSION)) {
        const tok = m[0]
        if (!tok.includes('.') || !tok.includes('(')) continue
        const rest = flat.slice(m.index + tok.length)
        const stop = CLAUSE_END.exec(rest)
        const tail = stop ? rest.slice(0, stop.index) : rest
        if (DEPRECATION.test(tail) && !out.includes(tok)) out.push(tok)
    }
    return out
}

/**
 * An APIS row is `symbol  description`, so the row's leading symbol is what the
 * row is ABOUT. Used only when no expression sits next to the marker: on
 * "z.email()  … (z.string().email() … is @deprecated)" the leading symbol is the
 * replacement, not the casualty, and the adjacent expression is the truth.
 */
function apisSymbol(line: string): string | null {
    const m = /^(\S+)\s\s+\S/.exec(stripTicks(line))
    if (!m) return null
    const tok = m[1]
    if (PACKAGE.test(tok)) return tok
    if (tok.includes('.') && tok.includes('(')) return tok
    return null
}

/** The tokens one research line deprecates, or an empty list. */
export function deprecatedTokens(line: string): string[] {
    if (!DEPRECATION.test(stripTicks(line))) return []
    const adjacent = markerAdjacent(line)
    if (adjacent.length > 0) return adjacent
    const symbol = apisSymbol(line)
    return symbol === null ? [] : [symbol]
}

/**
 * Find every (constraint line, research line, deprecated token) triple. `refined`
 * is the refined prompt and `research` the research output — the exact strings
 * compose is handed.
 */
export function detectDeprecations(refined: string, research: string): Deprecation[] {
    const constraintsBody = capsSection(refined, 'CONSTRAINTS')
    if (constraintsBody === null) return []

    const deprecated = new Map<string, {research: string; rule: string}>()
    for (const heading of ['APIS', 'CONTEXT']) {
        const body = capsSection(research, heading)
        if (body === null) continue
        for (const line of entries(body)) {
            const adjacent = markerAdjacent(line)
            const rule = adjacent.length > 0 ? 'marker-adjacent' : 'apis-symbol'
            for (const tok of deprecatedTokens(line)) {
                if (!deprecated.has(tok)) deprecated.set(tok, {research: line, rule})
            }
        }
    }
    if (deprecated.size === 0) return []

    const lines = refined.split('\n')
    const start = lines.findIndex(l => l.trim() === 'CONSTRAINTS')
    const out: Deprecation[] = []
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i]
        if (HEADER.test(line.trim()) && line.trim().length > 1) break
        if (line.includes(OWNED_MARKER)) continue
        for (const [tok, src] of deprecated) {
            if (!stripTicks(line).includes(tok)) continue
            out.push({
                token: tok,
                line: i,
                constraint: line,
                research: src.research,
                rule: src.rule
            })
        }
    }
    return out
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Delete one token from a constraint line, backticked or bare, plus one adjacent
 * list separator. Then collapse the wreckage the deletion left: an emptied
 * `(e.g. )`, doubled spaces, a space stranded before punctuation.
 *
 * Every step removes characters and adds none, so the result stays a character
 * subsequence of the input — the invariant the whole approach rests on.
 *
 * The example-parenthetical collapse requires a literal `e.g.`/`i.e.` rather than
 * matching any emptied `()`. A bare `\(\s*\)` also matches the call parens inside
 * `z.string()` elsewhere on the same line, which would silently corrupt a
 * constraint this pass is not even firing on.
 *
 * Returns null when nothing but boilerplate is left, which the caller turns into
 * a whole-line drop.
 */
export function dropExpression(line: string, token: string): string | null {
    const tokRe = new RegExp('`?' + escapeRe(token) + '`?', 'g')
    let next = line
    for (;;) {
        const m = tokRe.exec(next)
        if (!m) break
        const start = m.index
        const end = start + m[0].length
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
    // Leading whitespace is held out of the collapse: it is a nested bullet's
    // markdown level, not a gap this deletion opened.
    const indent = /^\s*/.exec(next)?.[0] ?? ''
    next =
        indent
        + next
            .slice(indent.length)
            .replace(/\s*\((?:\s*e\.g\.,?|\s*i\.e\.,?)\s*\)/gi, '')
            .replace(/ {2,}/g, ' ')
            .replace(/ +([.,;:)])/g, '$1')
    const carcass = next.replace(/^\s*[-*]\s*/, '').replace(/[\s,.;:()]/g, '')
    return carcass.length === 0 ? null : next
}

export type DeprecationResult = {
    refined: string
    trail: string[]
    deprecations: Deprecation[]
}

/** Apply every detected deprecation to the refined prompt. Purely subtractive. */
export function applyDeprecations(refined: string, research: string): DeprecationResult {
    const deprecations = detectDeprecations(refined, research)
    if (deprecations.length === 0) return {refined, trail: [], deprecations}

    const lines = refined.split('\n')
    const dropped = new Set<number>()
    const trail: string[] = []
    for (const d of deprecations) {
        const next = dropExpression(lines[d.line], d.token)
        const what =
            next === null ?
                `dropped the whole CONSTRAINTS line for '${d.token}'`
            :   `dropped '${d.token}' from CONSTRAINTS`
        if (next === null) dropped.add(d.line)
        else lines[d.line] = next
        trail.push(
            `constraint deprecated by research — ${what}`
                + ` | constraint: "${d.constraint.trim()}" | research: "${d.research.trim()}"`
        )
    }
    return {refined: lines.filter((_l, i) => !dropped.has(i)).join('\n'), trail, deprecations}
}
