/**
 * NARROWING detection for a grill auto-answer.
 *
 * REFUTED AT STEP 0, 2026-08-05, and therefore NOT WIRED — it lives in `scripts/`,
 * not `src/task/`, and `phaseAutoAnswer` never calls it. Over every recorded run
 * (14,561 task files, 24,522 `(auto)` answers, 220 distinct) it fires exactly ONCE,
 * on the lead it was designed from. See VALIDATION-DEBT.md → RULED OUT, and
 * `scripts/autoanswer-narrowing-baserate.ts` for the measurement. It is kept only so
 * that base rate stays re-runnable.
 *
 * mx5 run 19, TASK_0001. The design's repo-layout tree enumerates the project's
 * environment variables on one line:
 *
 *     ├─ .env    # DATABASE_URL, APP_URL (for invite links), PORT, ADMIN_PHONE, ADMIN_PASSWORD
 *
 * Research read that correctly ("template listing DATABASE_URL, APP_URL, PORT,
 * ADMIN_PHONE, ADMIN_PASSWORD"). Grill then asked whether `.env.example` should
 * carry only `DATABASE_URL` or the whole set, and the AUTO-answer picked the one.
 * The spec writer hardened that into a prohibition, an acceptance criterion and a
 * VERIFY assertion; no later task ever owned `.env.example`; five hours later the
 * run's final gate failed on `bun run seed` and the shipped repo still cannot seed.
 *
 * The lever is NOT a better auto-answer prompt. It is a mechanical veto over the
 * answer the prompt produced:
 *
 *     an auto-answer may not NARROW an enumerated set that the source design states.
 *
 * Mechanically, in four steps, all pure text:
 *
 *   1. SHAPE. The question must offer a restrictive option and an inclusive one —
 *      one side carrying `only`/`just`, the other not. Both sides are parsed into
 *      item lists; their union U is the candidate set. |U| >= MIN_SET_SIZE.
 *   2. CHOICE. The answer's DIRECTIVE clause (everything before the first
 *      subordinating connective — `since`, `because`, `—`, …) is parsed with the
 *      same list parser. That is what the answer actually selects; the rationale
 *      that follows routinely names the very tokens it is REJECTING, so counting
 *      tokens over the whole answer reads run 19's narrowing as a widening.
 *   3. GROUNDING. A single line of the SOURCE DESIGN must contain every token of U
 *      verbatim AND name the question's own SUBJECT. That line, quoted verbatim, is
 *      the superset. A set assembled from the question's own wording is never used —
 *      the question is model-authored and the design is not.
 *
 *      The subject half is not decoration. STEP 0's second hit was "what exact fields
 *      should `c.var.user` carry — only id, role, is_banned or also phone,
 *      display_name?", grounded against `GET /api/admin/users` → all users (id,
 *      phone, display_name, role, is_banned, listing count)` — a DIFFERENT artifact
 *      that merely lists the same columns. The design never enumerates `c.var.user`
 *      (it says only "loads the user onto `c.var.user`"), so there is no superset to
 *      restore and the veto must stay silent. Subjects match across the artifact's
 *      dotted extensions, which is what lets the question's `.env.example` ground on
 *      the design's `.env`.
 *   4. VERDICT. chosen ⊊ U → `narrowing`. chosen ⊇ U → `widening`. No shape →
 *      `not-a-set`. Shape but no grounding line → `undecidable`.
 *
 * Superset-by-default is the safe direction: an extra placeholder in a template is
 * inert, a missing required one is a run-end gate failure.
 *
 * PURE by construction (no fs): callers pass the design text in. `phaseAutoAnswer`
 * resolves it with readReferencedDocs over the raw prompt (`spec: @DESIGN/PROJECT.md`);
 * the STEP 0 / A/B harnesses read the same document out of the corpus.
 */

/** A set smaller than this is not worth a veto and is where the false positives live. */
export const MIN_SET_SIZE = 3

export type NarrowingClass = 'not-a-set' | 'undecidable' | 'widening' | 'narrowing'

export interface NarrowingResult {
    cls: NarrowingClass
    /** The two option sides parsed out of the question (empty when `not-a-set`). */
    restrictive: string[]
    inclusive: string[]
    /** restrictive ∪ inclusive, in question order. */
    union: string[]
    /** Union tokens the answer's directive clause keeps. */
    chosen: string[]
    /** union \ chosen — what the answer dropped. Non-empty only on `narrowing`. */
    missing: string[]
    /** The design line that enumerates the union, VERBATIM. '' unless grounded. */
    quote: string
    /** 1-based line number of `quote` in the design text. 0 unless grounded. */
    quoteLine: number
    /** The artifact the question is about, as named in the question. */
    subjects: string[]
}

const EMPTY: Omit<NarrowingResult, 'cls'> = {
    restrictive: [],
    inclusive: [],
    union: [],
    chosen: [],
    missing: [],
    quote: '',
    quoteLine: 0,
    subjects: []
}

// ─── item lists ──────────────────────────────────────────────────────────────

// Words that carry no set membership. Leading runs of these are stripped from a
// list part, so "also phone" yields `phone` and "the other spec-listed vars" yields
// nothing. Deliberately small: a word not listed here simply makes its part
// multi-word, and multi-word parts are dropped, which fails CLOSED (no veto).
const CONNECTIVES = new Set([
    'a',
    'aditionally',
    'additionally',
    'all',
    'also',
    'an',
    'and',
    'any',
    'as',
    'both',
    'each',
    'either',
    'entire',
    'every',
    'full',
    'include',
    'included',
    'includes',
    'including',
    'its',
    'just',
    'only',
    'or',
    'other',
    'plus',
    'return',
    'returns',
    'the',
    'their',
    'them',
    'well',
    'with'
])

// Abbreviations a model writes INSIDE a list ("(e.g., { id, display_name })"). They
// are identifier-shaped by accident and were the first STEP 0 hand-read correction.
const NOISE = new Set(['e.g', 'eg', 'i.e', 'ie', 'etc', 'ex', 'cf', 'vs'])

/** Identifier-shaped: one word that could name a variable, field, file or flag. */
function isItem(s: string): boolean {
    if (s.length === 0 || s.length > 64) return false
    if (!/^[A-Za-z_.$@/][A-Za-z0-9_.$@/-]*$/.test(s)) return false
    if (!/[A-Za-z]/.test(s)) return false
    const lower = s.toLowerCase()
    return !CONNECTIVES.has(lower) && !NOISE.has(lower)
}

/** Strip the decoration a model puts around a list item: quotes, backticks, brackets,
 *  colons, and the `<>` of an HTML tag. */
function cleanPart(part: string): string {
    return part
        .replace(/[`'"{}<>]/g, '')
        .replace(/^[\s\-–—:;.]+/, '')
        .replace(/[\s:;.,?!]+$/, '')
        .trim()
}

/** A part is an item iff, after dropping leading connectives, exactly one word remains. */
function partToItem(part: string): string | null {
    const words = cleanPart(part).split(/\s+/).filter(Boolean)
    let i = 0
    while (i < words.length && CONNECTIVES.has(words[i].toLowerCase())) i++
    const rest = words.slice(i)
    if (rest.length !== 1) return null
    const tok = rest[0].replace(/[,]+$/, '')
    return isItem(tok) ? tok : null
}

// `/` is NOT a separator: it is a path character far more often than a list one, and
// splitting on it turned `src/server/seed.ts` into the "items" `src`, `server`,
// `seed.ts` — STEP 0's second hand-read correction.
function splitList(text: string): string[] {
    return text
        .split(/,|;|\band\b|\bor\b|\||•/i)
        .map(s => s.trim())
        .filter(Boolean)
}

function bracketGroups(text: string): string[] {
    const out: string[] = []
    for (const m of text.matchAll(/[({[]([^)}\]]*)[)}\]]/g)) out.push(m[1])
    return out
}

function stripBrackets(text: string): string {
    return text.replace(/[({[][^)}\]]*[)}\]]/g, ' ')
}

/**
 * The item list a clause states. Every bracketed group is a candidate list and so
 * is the clause with its brackets removed; the candidate yielding the most items
 * wins. That is what reads run 19's "the other spec-listed vars (APP_URL, PORT,
 * ADMIN_PHONE, ADMIN_PASSWORD) even though they belong to later steps" as four
 * items and not as the prose around them.
 */
export function extractItems(clause: string): string[] {
    let best: string[] = []
    for (const cand of [...bracketGroups(clause), stripBrackets(clause)]) {
        const items: string[] = []
        for (const part of splitList(cand)) {
            const it = partToItem(part)
            if (it !== null && !items.includes(it)) items.push(it)
        }
        if (items.length > best.length) best = items
    }
    return best
}

// ─── question shape ──────────────────────────────────────────────────────────

const RESTRICTIVE_RE = /\b(only|just|solely)\b/i
// Where the INCLUSIVE side starts listing. Same job as RESTRICTIVE_RE's marker:
// everything before it is the question's framing prose, and framing prose glued to
// the first item ("should it also include x, y") makes that item multi-word and
// silently drops it.
const INCLUSIVE_RE = /\b(also|as well as|in addition to|along with|plus|all of|both)\b/i

/** Drop the framing prose ahead of a clause's list marker; keep the marker itself
 *  (it is a CONNECTIVE, so partToItem strips it off the first item). */
function fromMarker(clause: string, re: RegExp): string {
    const m = re.exec(clause)
    return m ? clause.slice(m.index) : clause
}

/**
 * Split a question into its two option clauses at the top-level `, or` / ` or `
 * that separates them, and label the one carrying `only`/`just` restrictive.
 * Returns null when the question is not a two-option set selection.
 */
function optionSides(question: string): {restrictive: string; inclusive: string} | null {
    // The option region ends at the question mark; trailing prose after it is
    // rationale, not options.
    const q = question.replace(/\s+/g, ' ').trim()
    const cuts: number[] = []
    let depth = 0
    for (let i = 0; i < q.length; i++) {
        const c = q[i]
        if (c === '(' || c === '[' || c === '{') depth++
        else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1)
        else if (depth === 0 && /\s/.test(c) && /^or\b/i.test(q.slice(i + 1))) cuts.push(i)
    }
    for (const cut of cuts) {
        const left = q.slice(0, cut)
        const right = q.slice(cut + 1).replace(/^or\b/i, '')
        const lr = RESTRICTIVE_RE.test(left)
        const rr = RESTRICTIVE_RE.test(right)
        // Exactly one side may be the restrictive one; `only … or only …` is a
        // choice between two closed sets, not a narrowing question.
        if (lr === rr) continue
        const [r, i2] = lr ? [left, right] : [right, left]
        return {
            restrictive: fromMarker(r, RESTRICTIVE_RE),
            inclusive: fromMarker(i2, INCLUSIVE_RE)
        }
    }
    return null
}

// ─── answer directive ────────────────────────────────────────────────────────

// Where an answer stops stating its choice and starts justifying it. Everything
// from here on routinely names the tokens being REJECTED ("… since APP_URL, PORT,
// ADMIN_PHONE, ADMIN_PASSWORD belong to later steps") and must not count as chosen.
const RATIONALE_RE =
    /\s(?:—|–|--|because|since|as the|so that|which|while|given that|matching|per the|the task|the spec|the constraint|the design|keeping|avoiding)\b|\s—|\s;\s/i

export function answerDirective(answer: string): string {
    const a = answer
        .replace(/\s*\((?:auto|YOLO)\)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
    const m = RATIONALE_RE.exec(a)
    return m ? a.slice(0, m.index).trim() : a
}

// ─── design grounding ────────────────────────────────────────────────────────

function containsToken(line: string, token: string): boolean {
    let from = 0
    for (;;) {
        const i = line.indexOf(token, from)
        if (i < 0) return false
        const before = i === 0 ? '' : line[i - 1]
        const after = line[i + token.length] ?? ''
        const wordish = (c: string) => c !== '' && /[A-Za-z0-9_]/.test(c)
        if (!wordish(before) && !wordish(after)) return true
        from = i + 1
    }
}

// An artifact name inside a question: backticked, or carrying a `.` or `/` (a file,
// a dotted member, a route). Bare English words are never subjects.
const SUBJECT_RE =
    /`([^`]+)`|(\.[A-Za-z][\w$-]*(?:\.[\w$-]+)*)|(\b[A-Za-z_$][\w$-]*(?:[./][\w$-]+)+\b)|(\/[\w$./:-]+)/g

/** What the question is ABOUT, minus the set it is choosing over. */
export function questionSubjects(question: string, union: string[]): string[] {
    const out: string[] = []
    for (const m of question.matchAll(SUBJECT_RE)) {
        const t = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/[.,;:?!]+$/, '')
        if (t.length < 4 || union.includes(t) || out.includes(t)) continue
        if (!/[A-Za-z]/.test(t)) continue
        out.push(t)
    }
    return out
}

/** Do two artifact names denote the same thing, allowing dotted extensions in either
 *  direction (`.env` ↔ `.env.example`, `db.ts` ↔ `db`)? */
function sameArtifact(a: string, b: string): boolean {
    return a === b || a.startsWith(b + '.') || b.startsWith(a + '.')
}

function lineNamesSubject(line: string, subjects: string[]): boolean {
    const lineTokens: string[] = []
    for (const m of line.matchAll(SUBJECT_RE)) {
        const t = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim().replace(/[.,;:?!]+$/, '')
        if (t.length >= 4) lineTokens.push(t)
    }
    return subjects.some(s => lineTokens.some(t => sameArtifact(s, t)))
}

/**
 * The first design line enumerating EVERY token of `union` AND naming the question's
 * subject. Verbatim, whole-token matches only — a superset the design does not
 * literally state is not a superset, and a line about a different artifact is not
 * this artifact's enumeration.
 */
export function groundingLine(
    design: string,
    union: string[],
    subjects: string[]
): {quote: string; line: number} {
    if (union.length < MIN_SET_SIZE || subjects.length === 0) return {quote: '', line: 0}
    const lines = design.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const l = lines[i]
        if (l.trim().length === 0) continue
        if (!union.every(t => containsToken(l, t))) continue
        if (!lineNamesSubject(l, subjects)) continue
        return {quote: l.trim(), line: i + 1}
    }
    return {quote: '', line: 0}
}

// ─── verdict ─────────────────────────────────────────────────────────────────

export function classifyAnswerNarrowing(
    question: string,
    answer: string,
    design: string
): NarrowingResult {
    const sides = optionSides(question)
    if (sides === null) return {cls: 'not-a-set', ...EMPTY}
    const restrictive = extractItems(sides.restrictive)
    const inclusive = extractItems(sides.inclusive)
    const union: string[] = []
    for (const t of [...restrictive, ...inclusive]) if (!union.includes(t)) union.push(t)
    if (union.length < MIN_SET_SIZE) return {cls: 'not-a-set', ...EMPTY}
    // Both sides must actually differ; "A, B, C or A, B, C" is not a selection.
    if (restrictive.length === 0 || restrictive.length === union.length) {
        return {cls: 'not-a-set', ...EMPTY}
    }

    const directive = answerDirective(answer)
    const chosen = union.filter(t => containsToken(directive, t))
    const missing = union.filter(t => !chosen.includes(t))
    const subjects = questionSubjects(question, union)
    const {quote, line} = groundingLine(design, union, subjects)
    const base = {restrictive, inclusive, union, chosen, missing, quote, quoteLine: line, subjects}
    if (quote === '') return {cls: 'undecidable', ...base, quote: '', quoteLine: 0}
    return {cls: missing.length === 0 ? 'widening' : 'narrowing', ...base}
}

/**
 * The answer the veto substitutes: the design's own enumeration, with the design
 * line carried verbatim so every downstream artifact that quotes it stays grounded.
 */
export function supersetAnswer(result: NarrowingResult): string {
    return (
        `include all of ${result.union.join(', ')} — the source design enumerates them `
        + `together: "${result.quote}"`
    )
}
