/**
 * Deterministic detector for the laundering shape: a CONTEXT bullet that asserts
 * external API USAGE SEMANTICS under an attribution cue that no EXTERNAL CONTEXT block
 * can actually support.
 *
 * THE SHAPE:
 *
 *   - The `hono` dependency is pinned at `^4.12.31` in package.json, and the external
 *     context confirms `hc<AppType>` pattern with base URL `/api` for same-origin
 *     relative paths works correctly (per Hono RPC docs LIVE data).
 *
 * The `worker:context` row in phases.ts gives that worker `tools: 'read,grep'` and
 * nothing else — no fetch, no docs channel — so a base-URL claim like that one is
 * necessarily from model memory. It then ships into a task's CONSTRAINTS and
 * ACCEPTANCE, the implementation obeys it exactly, and every request goes to the
 * wrong path.
 *
 * WHY THE OBVIOUS TEST DOES NOT WORK. "Flag a bullet whose package has no EXTERNAL
 * CONTEXT block" misses this case: EXTERNAL CONTEXT *did* carry a `### npm: hono` block.
 * That block contains version numbers and nothing else, so it cannot support a claim
 * about what a base URL MEANS — yet it lends the sentence an air of having been checked.
 * That is the whole mechanism: one citable fact, the pinned version, fused in a
 * single sentence with an uncitable one under a shared attribution. The true half
 * launders the false half.
 *
 * So the rule keys on what a block CAN support, mirroring the LIVE-DATA RULE's own
 * taxonomy (RESEARCH_CONTEXT_PROMPT in prompts.ts):
 *   ### npm:      version numbers only            -> cannot source a semantics claim
 *   ### docs:     retrieved package doc/.d.ts     -> CAN source a semantics claim
 *   ### url:      fetched page content            -> CAN source a semantics claim
 *   ### service:  3 search-result SNIPPETS        -> cannot source a semantics claim
 *
 * The `service` exclusion is not a judgement call — it is the LIVE-DATA RULE's own
 * scope. That rule (prompts.ts) makes a service block authoritative for "current
 * API surface, deprecation status, and replacement systems", i.e. versions, status
 * and names. And a service block is only ever a title, a URL and a one-line
 * description per result — see `formatServiceBlock` — so it cannot carry what a
 * parameter MEANS.
 *
 * This matters concretely, and was checked: with a single
 * `### service: Hono RPC client` block as the only external context, the fatal
 * bullet IS flagged. Were `service` treated as source-capable, that subject would
 * match the package `hono` and the bullet would pass — leaving the detector unable
 * to catch the one defect it exists for.
 *
 * A bullet is FLAGGED iff all three hold:
 *   1. it carries an attribution cue ("per... LIVE data", "the external context
 *      confirms", "docs confirm", "per the official docs",...);
 *   2. it asserts API usage semantics — how something is called, what a parameter
 *      means, what a default is, what behaviour results — as opposed to a version
 *      or a status;
 *   3. no `### url:` or `### docs:` block exists for any package the bullet names.
 *
 * All six branches were run against the laundering bullet above. It is FLAGGED with
 * an npm-only block, with a service-only block, and with no external context at
 * all; it is NOT flagged once a `### docs:` or `### url:` block for that package
 * exists. And the same context leaves alone a version claim made under an
 * attribution cue, a semantics claim made with NO cue, and a plain "is pinned at"
 * statement of fact.
 *
 * Pure and side-effect free; also unit-tested in context-attribution.test.ts.
 */

/** A block that actually appears in an EXTERNAL CONTEXT header. */
export interface ContextBlock {
    kind: 'npm' | 'docs' | 'url' | 'service' | 'freshness-skipped'
    /** The block's subject: a package name, a URL, or a service name. */
    subject: string
}

/** Block kinds whose body is retrieved prose/declarations, so they can carry semantics. */
const SOURCE_CAPABLE_KINDS: ReadonlySet<ContextBlock['kind']> = new Set(['docs', 'url'])

export interface AttributionFinding {
    bullet: string
    /** The attribution cue that made this bullet a claim of provenance. */
    cue: string
    /** The semantics marker that made it an API-behaviour claim rather than a version. */
    semantics: string
    /** Packages the bullet names that have no source-capable block. */
    unsourced: string[]
}

/**
 * Phrases by which a bullet claims its content came from somewhere authoritative.
 * Deliberately narrow: each must assert PROVENANCE. "is pinned at" is not a cue — it is
 * an ordinary statement of fact the worker can verify by reading package.json.
 */
const ATTRIBUTION_CUES: RegExp[] = [
    /per\s+[^.,;]{0,60}\bLIVE\s+data\b/i,
    /\bLIVE\s+data\b/i,
    /\bthe\s+external\s+context\s+confirms\b/i,
    /\bexternal\s+context\s+confirms\b/i,
    /\bper\s+the\s+EXTERNAL\s+CONTEXT\b/i,
    /\bthe\s+EXTERNAL\s+CONTEXT\s+(block|documentation)\b/i,
    /\bdocs?\s+confirms?\b/i,
    /\bper\s+the\s+official\s+docs?\b/i,
    /\baccording\s+to\s+(the\s+)?(official\s+)?docs?\b/i,
    /\bthe\s+docs?\s+says?\b/i,
    /\bper\s+[A-Z][\w./-]*\s+docs\b/
]

/**
 * Markers that a bullet is asserting how an API BEHAVES, rather than what version it is.
 * A version/status claim under an attribution is legitimate — that is exactly what the
 * npm block is for — so those must not trip the detector.
 */
const SEMANTICS_MARKERS: RegExp[] = [
    /\bbase\s*URL\b/i,
    /\bdefaults?\s+to\b/i,
    /\bby\s+default\b/i,
    /\bmust\s+be\s+(a\s+)?(relative|absolute)\b/i,
    /\bworks?\s+correctly\b/i,
    /\bbehaves?\b/i,
    /\breturns?\b/i,
    /\baccepts?\b/i,
    /\btakes?\s+(a|an|two|three|the)\b/i,
    /\bis\s+called\s+with\b/i,
    /\bpass(es|ed|ing)?\s+(a|an|the|it)\b/i,
    /\bparameter\b/i,
    /\bargument\b/i,
    /\bsignature\b/i,
    /\bautomatically\b/i,
    /\bsupports?\b/i,
    /\brequires?\b/i,
    /\bresolves?\b/i
]

/** A claim that is ONLY about a version or release status — never a semantics claim. */
const VERSION_ONLY: RegExp[] = [
    /\blatest\s+is\b/i,
    /\bis\s+the\s+latest\b/i,
    /\blive\s+registry\s+shows\b/i,
    /\bnpm\s+latest\b/i,
    /\bversion\s+is\b/i,
    /\bis\s+at\s+version\b/i,
    /\bpinned\s+at\b/i
]

function firstMatch(text: string, patterns: RegExp[]): string | null {
    for (const p of patterns) {
        const m = p.exec(text)
        if (m) return m[0]
    }
    return null
}

/** One bullet plus the line range it occupies, so a rewrite can be surgical. */
export interface BulletSpan {
    /** The bullet's text, continuation lines folded in, marker stripped. */
    text: string
    /** Index of the line carrying the `-`/`*` marker. */
    startLine: number
    /** Index of the last line belonging to this bullet (inclusive). */
    endLine: number
    /** Leading whitespace of the marker line, preserved on rewrite. */
    indent: string
}

/**
 * Split a CONTEXT section into bullets WITH their line ranges. Continuation lines are
 * folded into the bullet above so a hard-wrapped claim is judged as one sentence — which
 * is exactly how the fatal bullet was written.
 */
export function splitBulletSpans(context: string): BulletSpan[] {
    const spans: BulletSpan[] = []
    const lines = context.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trimEnd()
        const marker = /^(\s*)[-*]\s+/.exec(line)
        if (marker) {
            spans.push({
                text: line.slice(marker[0].length).trim(),
                startLine: i,
                endLine: i,
                indent: marker[1]
            })
        } else if (spans.length > 0 && line.trim().length > 0 && !/^#/.test(line)) {
            const last = spans[spans.length - 1]
            last.text += ' ' + line.trim()
            last.endLine = i
        }
    }
    return spans.filter(s => s.text.length > 0)
}

/** Split a CONTEXT section into its bullets, joining hard-wrapped continuation lines. */
export function splitBullets(context: string): string[] {
    return splitBulletSpans(context).map(s => s.text)
}

/** Parse the `### npm:` / `### docs:` / `### url:` / `### service:` blocks out of an EXTERNAL CONTEXT header. */
export function parseContextBlocks(externalContext: string): ContextBlock[] {
    const out: ContextBlock[] = []
    // A version block is headed by its REGISTRY, so `npm` is one of several
    // (`crates.io`, `hackage`). Matching only the fixed words made every non-npm
    // block invisible to the parser.
    const re = /^###\s+([A-Za-z][\w.-]*)\s*:?\s*(.*)$/gim
    let m: RegExpExecArray | null
    while ((m = re.exec(externalContext)) !== null) {
        const kind = m[1].toLowerCase()
        out.push({
            kind: kind === 'freshness-check' ? 'freshness-skipped' : (kind as ContextBlock['kind']),
            subject: m[2].trim()
        })
    }
    return out
}

/**
 * Does any block exist that COULD source a semantics claim about `pkg`? Only retrieved
 * documentation text can: a `### docs:` chunk or a `### url:` page body. An npm block
 * carries versions and nothing else, and a service block carries search-result snippets
 * (see the header note). A url block matches on hostname/path containing the package
 * name, which is how the design's own reference list reads (hono.dev/docs/guides/rpc
 * for `hono`).
 */
function hasSourceCapableBlock(pkg: string, blocks: ContextBlock[]): boolean {
    const base = pkg
        .replace(/^@[^/]+\//, '')
        .replace(/^@/, '')
        .toLowerCase()
    return blocks.some(b => {
        if (!SOURCE_CAPABLE_KINDS.has(b.kind)) return false
        const s = b.subject.toLowerCase()
        return s.includes(base) || s.includes(pkg.toLowerCase())
    })
}

/**
 * Find bullets that assert external API semantics under an attribution no available
 * block can support.
 *
 * @param context          the emitted CONTEXT section text
 * @param externalContext  the EXTERNAL CONTEXT header actually passed to that worker
 * @param packages         dependency names to look for in a bullet (from package.json)
 */
export function findUnsourcedAttributions(
    context: string,
    externalContext: string,
    packages: string[]
): AttributionFinding[] {
    const blocks = parseContextBlocks(externalContext)
    const findings: AttributionFinding[] = []

    for (const bullet of splitBullets(context)) {
        const cue = firstMatch(bullet, ATTRIBUTION_CUES)
        if (cue === null) continue

        const semantics = firstMatch(bullet, SEMANTICS_MARKERS)
        if (semantics === null) continue

        // A bullet that ONLY talks about versions is legitimately sourced by an npm
        // block, even though "supports"/"is" may look like a semantics marker.
        const versionOnly = firstMatch(bullet, VERSION_ONLY) !== null
        const semanticsBeyondVersion = SEMANTICS_MARKERS.filter(p => p.test(bullet)).length
        if (versionOnly && semanticsBeyondVersion <= 1) continue

        const named = packages.filter(p => {
            const base = p.replace(/^@[^/]+\//, '')
            return (
                new RegExp(`\\b${escapeRegExp(p)}\\b`, 'i').test(bullet)
                || new RegExp(`\\b${escapeRegExp(base)}\\b`, 'i').test(bullet)
            )
        })
        if (named.length === 0) continue

        const unsourced = named.filter(p => !hasSourceCapableBlock(p, blocks))
        if (unsourced.length === 0) continue

        findings.push({bullet, cue, semantics, unsourced})
    }
    return findings
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Strip every attribution cue from a bullet. Applied repeatedly because one sentence can
 * carry two overlapping cues (the fatal bullet carried "the external context confirms"
 * AND "per Hono RPC docs LIVE data"), and because removing one can expose another.
 */
function stripAttributionCues(bullet: string): string {
    let out = bullet
    for (let pass = 0; pass < 4 && firstMatch(out, ATTRIBUTION_CUES) !== null; pass++) {
        for (const p of ATTRIBUTION_CUES) {
            out = out.replace(
                new RegExp(p.source, p.flags.includes('g') ? p.flags : p.flags + 'g'),
                ''
            )
        }
    }
    return out
        .replace(/\(\s*[),.;]?\s*\)/g, '')
        .replace(/\s+([.,;:)])/g, '$1')
        .replace(/,\s*([.;])/g, '$1')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .replace(/^[,;.\s]+/, '')
}

/** The result of demoting the flagged bullets out of a CONTEXT section. */
export interface DemotedContext {
    /** The CONTEXT text with every flagged bullet rewritten as an open question. */
    text: string
    /** What was demoted, in emission order. Empty means the section was untouched. */
    demoted: AttributionFinding[]
}

/**
 * Rewrite every bullet that findUnsourcedAttributions flags into an OPEN QUESTION, in
 * place, leaving every other byte of the section alone.
 *
 * DEMOTE, DO NOT DELETE. PROMPT 1 allows either, and its invariant is that neither the
 * bullet count nor the count of legitimately-sourced bullets may collapse — "a worker
 * silenced into saying nothing is a regression, not a fix". Demotion satisfies that
 * mechanically: one flagged bullet becomes exactly one bullet, so the count is invariant,
 * and the observation survives for the grill to ask about instead of reaching compose as
 * fact. The attribution cue is removed, which is what makes the claim stop reading as
 * sourced — and it also makes the rewrite idempotent, since the cue was condition (i).
 *
 * @param context          the emitted CONTEXT section text
 * @param externalContext  the EXTERNAL CONTEXT header actually passed to that worker
 * @param packages         dependency names to look for in a bullet (from package.json)
 */
export function demoteUnsourcedAttributions(
    context: string,
    externalContext: string,
    packages: string[]
): DemotedContext {
    const demoted = findUnsourcedAttributions(context, externalContext, packages)
    if (demoted.length === 0) return {text: context, demoted: []}

    const byText = new Map(demoted.map(f => [f.bullet, f]))
    const lines = context.split('\n')
    const out: string[] = []
    let cursor = 0
    for (const span of splitBulletSpans(context)) {
        const finding = byText.get(span.text)
        if (!finding) continue
        out.push(...lines.slice(cursor, span.startLine))
        const stripped = stripAttributionCues(span.text)
        // If a cue somehow survives four stripping passes the claim is dropped outright
        // rather than re-emitted still wearing its attribution.
        const body = firstMatch(stripped, ATTRIBUTION_CUES) === null ? stripped : ''
        out.push(
            `${span.indent}- OPEN QUESTION (unsourced API-semantics claim about `
                + `${finding.unsourced.join(', ')} — worker:context has no documentation tool `
                + `and no retrieved block supports it; do NOT treat as fact)`
                + (body.length > 0 ? `: ${body}` : '')
        )
        cursor = span.endLine + 1
    }
    out.push(...lines.slice(cursor))
    return {text: out.join('\n'), demoted}
}
