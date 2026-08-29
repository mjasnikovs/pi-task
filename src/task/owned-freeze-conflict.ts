/**
 * owned-freeze-conflict — the FIFTH unsatisfiable-pair family:
 * an AUTHORITATIVE owned requirement whose file falls inside a CATEGORY freeze
 * written by the same spec.
 *
 * WHY frozen-conflict.ts does not see it. The owned
 * channel worked: `.pi-tasks/requirements-owned.md` carried the design clause
 * "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static
 * `dist/`." and the composed spec carried it verbatim under CONSTRAINTS, marked
 * AUTHORITATIVE. The same CONSTRAINTS block then said "Do not modify
 * `docker-compose.dev.yml`, …, or any source files outside of `package.json`",
 * and the spec's ACCEPTANCE/VERIFY converted the behavioural half of the clause
 * ("serves `/api` + static `dist/`") into a string-match on `package.json`. The
 * only file that could implement it — `src/server/index.ts` — was frozen. The
 * requirement was structurally unsatisfiable inside its owning task, VERIFY
 * PASSed honestly, and the app shipped with no static route.
 *
 * The existing detector misses this shape twice over (both visible in its own
 * header): its freeze side needs a NAMED path (`pathNamedIn`), and a * freeze names a CATEGORY ("any source files outside of `package.json`"); its
 * statement side must match one of four measured phrasing families, and a plain
 * behavioural claim matches none of them.
 *
 * HIGH-PRECISION BY CONSTRUCTION — the statement side needs no NLP:
 *   - owned requirement lines are MACHINE-MARKED. `appendOwnedConstraints`
 *     stamps every one it appends with "owned requirement from the source
 *     design (AUTHORITATIVE; …)"; when compose folded the quote in by itself
 *     the marker is absent, so the caller may also pass the run's ledger
 *     entries and the quote is matched verbatim against the spec text.
 *   - the requirement names its path literally, so the intersection is lexical.
 *   - category freezes are a small closed lexical set ("any source files
 *     outside of X", "any files other than X", "only X may be modified",
 *     "no files outside X").
 *
 * ── STATUS, 2026-08-05: WIRED — but as a DETACH, not as a rewrite. ──────────
 *
 * `owned-freeze-reassign.ts` consumes this detector at the last spec-producing
 * step (`phases.ts`, right after `appendOwnedConstraints`) and resolves a finding
 * by BOOKKEEPING: the requirement leaves the task that cannot satisfy it and is
 * claimed later by the task whose refined prompt says it writes the frozen file.
 * The quote is never edited, so the deletion failure below cannot recur. A/B-1
 * PASSes on the corpus with five
 * invariants. The rewrite lever recorded below stays REFUTED and unwired.
 *
 * ── The critique-REWRITE seam FAILED its A/B, 2026-08-04. ────────────────────
 *
 * The detector is precise — 1 finding over 58 real composed specs, and it is the
 * true positive (scripts/owned-freeze-conflict-fp-suite.ts, PASS; STEP 0 in
 * scripts/owned-vs-freeze-baserate.ts). What failed is the LEVER built on it,
 * for two independent reasons, both measured:
 *
 *  1. THE SEAM IS BLIND IN PRODUCTION. `appendOwnedConstraints` — the BRACES that
 *     stamp the machine-marked owned bullet this detector keys on — runs AFTER
 *     `critiqueWithFallback`, inside the `critique` step (phases.ts). When
 *     critique runs, the stamped line does not exist yet; compose's own folding
 *     is a PARAPHRASE ("The server watch command must match the contract exactly:
 *     `…` — serves `/api` + static `dist/`"), so neither the stamp nor the
 *     verbatim quote is there to match. Compose drafts carry the clause
 *     semantically but not in a detectable pair, so a critique-time probe
 *     cannot see the shape it was designed for.
 *  2. THE REWRITE RESOLVES IT BY DELETING THE REQUIREMENT. Forced through the
 *     controlled critique seam on a real draft, the pair does disappear — but
 *     about half the time the resolution is to remove the AUTHORITATIVE clause
 *     outright and rationalise it ("this references an existing file; no edits
 *     are required or permitted"), never reassigning it to the task that owns
 *     the file. Behaviour observation in VERIFY is unchanged either way: the
 *     delivered spec still verifies the requirement by grepping `package.json`.
 *
 * Removal of the pair is not satisfaction of the requirement — the same lesson
 * as any delivery metric that counts the symptom. Anything built here
 * next has to act AFTER the braces, where the pair actually exists, and cannot
 * be a model rewrite: the braces are the last spec-producing step.
 *
 * It is a pure text function so the base rate, the FP suite and the live A/B all
 * measure the same object.
 */
import {PROHIBITION_RE} from './prohibition-probe.js'
import {pathNamedIn} from './frozen-path-guard.js'
import type {OwnedRequirement} from './requirements.js'

/** A freeze whose scope is a CATEGORY of files, with the paths it carves out. */
export interface CategoryFreeze {
    /** The freeze line, verbatim. */
    constraint: string
    /** The paths the category exempts — everything else is frozen. */
    exempt: string[]
}

/**
 * One unsatisfiable pair, keyed by the REQUIREMENT rather than by the path.
 *
 * Grouping matters for the resolution's size. a a task carries
 * two owned build-contract clauses that between them name three frozen paths;
 * per-path findings would demand three separate ownership grants (and the same
 * pair twice over, because that spec states its freeze in CONSTRAINTS and again
 * in ACCEPTANCE). Per requirement, the rewrite is told which files that one
 * obligation names and grants only what it needs — which is what keeps
 * `inv-no-spec-inflation` satisfiable at all.
 */
export interface OwnedFreezeConflict {
    /** The owned requirement line, verbatim. */
    requirement: string
    /** The files it names that this freeze covers. */
    paths: string[]
    /** The category freeze line, verbatim. */
    constraint: string
    /** The paths that freeze exempts (the resolution has to widen this, or
     *  move the requirement to a task whose scope already includes the file). */
    exempt: string[]
}

/**
 * The machine stamp `appendOwnedConstraints` writes on every owned requirement
 * it appends to CONSTRAINTS. Matching the stamp — not the prose — is what keeps
 * the statement side free of NLP.
 */
const OWNED_MARKER_RE = /owned\s+requirement\s+from\s+the\s+source\s+design/i

/**
 * Modification verbs, shared by the active and passive freeze families. Scoped
 * to modification exactly as `PROHIBITION_RE` is: a "do not CREATE any files
 * other than X" line is a creation ban and freezes no existing file, so it must
 * never be read as a category freeze.
 */
const MOD_VERB = 'modif|touch|edit|chang|alter|rewrit|overwrit'

/**
 * A category noun phrase with an exception: "any source files outside of X",
 * "any existing file other than X", "no files except X". `\w+` slots absorb the
 * qualifiers seen in the corpora (source/existing/other), bounded so the phrase
 * cannot span a whole paragraph.
 */
const CATEGORY_NOUN = String.raw`(?:any|no)\s+(?:\w+\s+){0,3}?files?\b`
const EXCEPT_KEYWORD = String.raw`(?:outside(?:\s+of)?|other\s+than|except(?:\s+for)?|besides|apart\s+from|beyond)`

/**
 * Active family: a modification ban whose object is the category phrase. The
 * tempered gap forbids crossing a creation/addition verb, so the compound line
 * "Do not create any files other than `X` and do not modify `Y`" — where the
 * category belongs to the CREATE half — cannot be mis-read as a category freeze.
 */
const ACTIVE_CATEGORY_RE = new RegExp(
    String.raw`\b(?:do\s+not|do\s+NOT|don'?t|must\s+not|never)\s+(?:${MOD_VERB})\w*\b`
        + String.raw`(?:(?!\b(?:creat|add|introduc|generat)\w*\b)[\s\S]){0,200}?`
        + String.raw`\b${CATEGORY_NOUN}[^\n]{0,40}?\b${EXCEPT_KEYWORD}\b`,
    'i'
)

/**
 * Passive family: "No files other than `package.json` are modified." — a * ACCEPTANCE line, identical in force to the CONSTRAINTS freeze above it.
 */
const PASSIVE_CATEGORY_RE = new RegExp(
    String.raw`\b${CATEGORY_NOUN}[^\n]{0,40}?\b${EXCEPT_KEYWORD}\b`
        + String.raw`[^\n]{0,120}?\b(?:are|is|may|must|should|can|will)\s+(?:be\s+|been\s+)?(?:${MOD_VERB})\w*`,
    'i'
)

/**
 * A SCOPED-OWNERSHIP grant — "You MAY edit `X` ONLY to …/ONLY as far as …" —
 * which is the resolution this detector demands. Whatever else the spec says,
 * the paths named on such a line are editable, so they can never be the frozen
 * side of a pair. Without this the rewrite that grants ownership on a NEW line
 * while leaving the category freeze in place would re-fire forever.
 */
const SCOPED_GRANT_RE = new RegExp(
    String.raw`\b(?:may|can|are\s+allowed\s+to|is\s+allowed\s+to)\s+(?:${MOD_VERB})\w*\b[^\n]{0,80}?\bonly\b`,
    'i'
)

/** "Only `X` may be modified" / "Only `X` is edited". */
const ONLY_CATEGORY_RE = new RegExp(
    String.raw`\bonly\b[^\n]{0,60}?\b(?:may|must|should|can|will|is|are)\s+(?:be\s+)?(?:${MOD_VERB})\w*`,
    'i'
)

/**
 * Backtick-quoted path-shaped tokens in a text, INCLUDING the ones embedded in
 * a backticked command (`bun run --watch src/server/index.ts` is one backtick
 * span; the path inside it is what the requirement is about). Route literals
 * (`/api`) and bare directories survive this filter — the caller decides what
 * to do with them; `findOwnedFreezeConflicts` keeps only files.
 */
export function pathTokensIn(text: string): string[] {
    return tokensWithOrigin(text).map(t => t.path)
}

interface Token {
    path: string
    /** The backtick span it came from held whitespace — i.e. it is an ARGUMENT
     *  of a quoted command, not a file the requirement talks about directly. */
    fromCommand: boolean
}

function tokensWithOrigin(text: string): Token[] {
    const out: Token[] = []
    const seen = new Set<string>()
    for (const m of text.matchAll(/`([^`]+)`/g)) {
        const span = m[1]
        const fromCommand = /\s/.test(span.trim())
        for (const raw of span.split(/[\s,;()"']+/)) {
            const token = raw.trim().replace(/[.,;:]+$/, '')
            if (token.length === 0 || !/^[\w.@~/-]+$/.test(token)) continue
            if (!(token.includes('/') || /\.[A-Za-z0-9]+$/.test(token) || token.startsWith('.'))) {
                continue
            }
            // A leading `/` is a route literal or an absolute path — never a
            // repo-relative source file, and `/api` is named by the very clause
            // that is the true positive, so this one is not hypothetical.
            if (token.startsWith('/')) continue
            const n = token.replace(/^\.\//, '').replace(/\/+$/, '')
            if (n.length === 0 || seen.has(n)) continue
            seen.add(n)
            out.push({path: n, fromCommand})
        }
    }
    return out
}

/**
 * Does the requirement claim anything about the files it names BEYOND quoting a
 * command that mentions them?
 *
 * This is what separates two build-contract clauses of the same shape:
 *
 *   "**Client CSS:** `bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css`"
 *   "**Server:** `bun run --watch src/server/index.ts` — serves `/api` + static `dist/`."
 *
 * The first is satisfied by putting that command in `package.json`; nothing
 * about `src/client/index.css` has to change, so the freeze does not make it
 * impossible. The second attaches a BEHAVIOURAL claim to the quoted file, and
 * that claim can only be satisfied inside the file. Prose outside the backtick
 * spans — minus the label, the anchor tag and the machine marker — is the
 * signal; two words of it are enough.
 */
function hasClaimOutsideCommand(requirement: string): boolean {
    const prose = requirement
        .replace(/`[^`]*`/g, ' ')
        .replace(/—\s*owned\s+requirement\s+from\s+the\s+source\s+design[\s\S]*$/i, ' ')
        .replace(/\[[^\]]*\]/g, ' ')
        .replace(/\*\*[^*]*\*\*/g, ' ')
        .replace(/^[\s\-"']+/, ' ')
    const words = prose.match(/\b[A-Za-z][A-Za-z-]{1,}\b/g) ?? []
    return words.length >= 2
}

/**
 * The clause the exception keyword governs: from the keyword to the first
 * clause break (an em dash, a semicolon, or a sentence end). Everything else on
 * the line — notably the "— all engine modules (`document.ts`, …) must remain
 * untouched" tail of a freeze — is NOT an exemption.
 */
function exemptClause(line: string): string | null {
    const m = new RegExp(String.raw`\b${EXCEPT_KEYWORD}\b`, 'i').exec(line)
    if (!m) return null
    const rest = line.slice(m.index + m[0].length)
    const brk = /\s+[—–]\s+|;|\.\s+[A-Z]|\.$/.exec(rest)
    return brk ? rest.slice(0, brk.index) : rest
}

/**
 * Every CATEGORY freeze in the spec: a modification ban (or its passive/only-
 * form equivalent) scoped to a class of files rather than to named paths. A
 * freeze that only names paths is `frozen-conflict.ts`'s job, not this one.
 */
export function findCategoryFreezes(spec: string | null | undefined): CategoryFreeze[] {
    if (!spec) return []
    const out: CategoryFreeze[] = []
    const seen = new Set<string>()
    for (const raw of spec.split('\n')) {
        const line = raw.trim()
        if (line.length === 0 || seen.has(line)) continue
        const isCategory =
            ACTIVE_CATEGORY_RE.test(line)
            || PASSIVE_CATEGORY_RE.test(line)
            || (ONLY_CATEGORY_RE.test(line) && PROHIBITION_RE.test(line) === false)
        if (!isCategory || SCOPED_GRANT_RE.test(line)) continue
        const clause =
            ONLY_CATEGORY_RE.test(line) && exemptClause(line) === null ? line : exemptClause(line)
        seen.add(line)
        out.push({constraint: line, exempt: clause === null ? [] : pathTokensIn(clause)})
    }
    return out
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

/**
 * Is `p` inside the freeze — i.e. NOT one of the exempted paths, a file under
 * an exempted directory, or the same file spelled shorter?
 *
 * The last clause is load-bearing. A spec can exempt
 * `src/components/Canvas.tsx` while its owned requirement quotes a design's
 * table cell, which says just `Canvas.tsx` — the same file, and the spec is
 * correctly formed. A bare basename is matched against the exempted paths'
 * basenames; a path WITH a directory must match exactly or by prefix, so
 * `src/a/config.ts` never counts as exempted by `src/b/config.ts`.
 */
function insideFreeze(p: string, exempt: string[]): boolean {
    return !exempt.some(
        e =>
            e === p
            || p.startsWith(`${e}/`)
            || pathNamedIn(p, e)
            || (!p.includes('/') && basename(e) === p)
    )
}

/**
 * The spec lines carrying an AUTHORITATIVE owned requirement: the machine-
 * stamped ones, plus — when the run's ledger is supplied — any line carrying an
 * owned quote verbatim (compose folding the quote in itself leaves no stamp).
 */
export function ownedRequirementLines(
    spec: string | null | undefined,
    owned: OwnedRequirement[] = []
): string[] {
    if (!spec) return []
    const quotes = owned.map(o => o.quote.trim()).filter(q => q.length > 0)
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of spec.split('\n')) {
        const line = raw.trim()
        if (line.length === 0 || seen.has(line)) continue
        if (!OWNED_MARKER_RE.test(line) && !quotes.some(q => line.includes(q))) continue
        seen.add(line)
        out.push(line)
    }
    return out
}

export interface OwnedFreezeOptions {
    /** The run's owned-requirement ledger, so belt-folded (unstamped) quotes
     *  count too. Omitted → stamped lines only. */
    owned?: OwnedRequirement[]
    /**
     * Is this repo-relative token an existing SOURCE file of the tree the spec
     * will run against? Supplied by the caller (compose knows its cwd; the
     * usual implementation is "tracked by git" — see `trackedSourceOracle`).
     *
     * Two false-positive classes die here, both observed on real specs:
     * route literals and build outputs (`/api`, `dist/`,
     * `dist/app.css` — named by the very clause that is the true positive, but
     * not files anyone can edit), and files a task is about to CREATE, which a
     * freeze on the existing tree does not block. Omitted → every path-shaped
     * token counts, which is the broad reading.
     */
    isSource?: (p: string) => boolean
}

/**
 * Every unsatisfiable pair in the composed spec: an AUTHORITATIVE owned
 * requirement naming a file that a CATEGORY freeze in the same spec forbids
 * touching. Deterministic, pure text (plus the caller's existence oracle).
 * Empty when the spec froze no category or carries no owned requirement — the
 * ordinary single-`/task` case degrades to a no-op.
 */
export function findOwnedFreezeConflicts(
    spec: string | null | undefined,
    opts: OwnedFreezeOptions = {}
): OwnedFreezeConflict[] {
    if (!spec) return []
    const freezes = findCategoryFreezes(spec)
    if (freezes.length === 0) return []
    // Scoped ownership granted ANYWHERE in the spec settles the file, even when
    // the grant is a line the rewrite added next to an untouched category
    // freeze — otherwise a correctly resolved spec re-fires forever.
    const granted = spec
        .split('\n')
        .filter(l => SCOPED_GRANT_RE.test(l))
        .flatMap(l => pathTokensIn(l))
    const out: OwnedFreezeConflict[] = []
    for (const requirement of ownedRequirementLines(spec, opts.owned)) {
        // An owned requirement that is itself prohibition-shaped restates the
        // freeze side; it can never be the thing the freeze makes impossible.
        if (PROHIBITION_RE.test(requirement)) continue
        const claim = hasClaimOutsideCommand(requirement)
        const named = tokensWithOrigin(requirement)
            .filter(t => claim || !t.fromCommand)
            .map(t => t.path)
            .filter(p => !opts.isSource || opts.isSource(p))
        if (named.length === 0) continue
        // One finding per requirement: the FIRST freeze that covers any of its
        // files. A spec that restates the same freeze under ACCEPTANCE must not
        // double the rewrite's work.
        for (const f of freezes) {
            const paths = named.filter(p => insideFreeze(p, [...f.exempt, ...granted]))
            if (paths.length === 0) continue
            out.push({requirement, paths, constraint: f.constraint, exempt: f.exempt})
            break
        }
    }
    return out
}

/**
 * The measured `isSource` oracle: a token counts only when git tracks it in
 * `cwd`. Tracked ⇒ it exists, it is not a build output, and it is not ignored —
 * exactly the "source file" the category freezes talk about. `git` missing or
 * the tree not a repo ⇒ every token counts (the broad reading), so the detector
 * degrades toward firing rather than toward silent blindness.
 */
export function trackedSourceOracle(
    lsFiles: (p: string) => {stdout: string; exitCode: number}
): (p: string) => boolean {
    const cache = new Map<string, boolean>()
    return p => {
        const hit = cache.get(p)
        if (hit !== undefined) return hit
        const r = lsFiles(p)
        const ok = r.exitCode !== 0 ? true : r.stdout.trim().length > 0
        cache.set(p, ok)
        return ok
    }
}

/**
 * The forced critique-rewrite defect text, in the shape the existing four
 * families use: MANDATORY, self-contained, naming the exact resolutions. Prose
 * surrender and silently dropping the requirement are called out as
 * non-resolutions: narrowing the clause and freezing its file are both ways a
 * rewrite makes the contradiction disappear without satisfying the requirement.
 */
export function ownedFreezeConflictProbeText(conflicts: OwnedFreezeConflict[]): string {
    const items = conflicts.map(
        c =>
            `- the spec carries the AUTHORITATIVE owned requirement `
            + `"${c.requirement.slice(0, 200)}", which names ${c.paths.map(p => `\`${p}\``).join(', ')} — `
            + `and the spec FREEZES ${c.paths.length > 1 ? 'those files' : 'that file'} with a CATEGORY freeze `
            + `("${c.constraint.slice(0, 160)}"`
            + (c.exempt.length > 0 ?
                `, which exempts only ${c.exempt.map(e => `\`${e}\``).join(', ')}`
            :   '')
            + ')'
    )
    return [
        'UNSATISFIABLE-CONSTRAINT FINDING (deterministic; MUST be resolved, it overrides a CLEAN triage):',
        ...items,
        'An owned requirement is AUTHORITATIVE: it comes from the source design and this task',
        'owns it. A category freeze that covers the only file which could satisfy it makes the',
        'requirement structurally impossible INSIDE THIS TASK, and the task will still pass its',
        'own VERIFY — because VERIFY can then only assert strings in the files it is allowed to',
        'touch. Narrowing the requirement to what the unfrozen files can express, or dropping it,',
        'is NOT a resolution.',
        'REWRITE the spec to resolve it in exactly ONE of these two ways:',
        '  (a) SCOPED OWNERSHIP — widen the category freeze for that file only:',
        '      "You MAY edit `<path>` ONLY as far as the owned requirement requires; any other',
        '      change to `<path>` is forbidden." Then make ACCEPTANCE state the requirement\'s',
        '      BEHAVIOUR and make VERIFY exercise that behaviour, not the presence of a string.',
        '  (b) REASSIGN — state that the owned requirement is not satisfiable in this task and',
        "      belongs to the task that owns `<path>`, and remove it from this spec's",
        '      CONSTRAINTS/ACCEPTANCE so it is not falsely claimed as met here.',
        'Never ship both the category freeze and the owned requirement it makes impossible.'
    ].join('\n')
}
