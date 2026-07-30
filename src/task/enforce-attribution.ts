/**
 * enforce-attribution — decide whether an enforce-pass re-verify FAIL can possibly
 * be the ENFORCE COMMIT's fault (mx5 run 18, nexttask 4).
 *
 * The failure class, measured. Run 18's TASK_0024 enforce commit `ee65661` was, in
 * full, one line:
 *
 *     -  setApiError((usersData).error ?? 'Failed to load users')
 *     +  setApiError(usersData.error ?? 'Failed to load users')
 *
 * The differential re-verify then FAILed on `MyListings.spec.tsx:186`, a Playwright
 * CT file `Admin.tsx` cannot reach (CT bundles per story; the import graph never
 * touches it), and the differential reverted the enforce commit anyway. The defect
 * was real and PRE-EXISTING — `getByText('SOLD')` matched two elements because
 * MOCK_LISTINGS already carries a sold row — and the final gate fixed it five
 * minutes later, in the same commit that RE-MADE the identical paren change. Cost:
 * one correct change destroyed, one permanent false verify-FAIL debt written
 * against work that was fine, and the change re-made anyway.
 *
 * The mechanism was not broken; it was asked the wrong question. The root-cause
 * channel (root-cause-repair.ts) attributed against `scope: 'committed'` — the
 * TASK's own commit, which touched `MyListings.tsx` — concluded "this task touched
 * the file", and fell through to the conservative revert. But at THIS seam the
 * differential is deciding whether to discard the ENFORCE COMMIT. The causal
 * question is therefore *"could the enforce diff have caused this?"*, never *"could
 * the task have?"*: reverting the enforce commit can only ever repair damage the
 * enforce commit did.
 *
 * So the filter here is mechanical and one-sided:
 *
 *   - the files the FAIL text NAMES are extracted (paths AND bare basenames — run
 *     18's reason named `MyListings.spec.tsx:186`, which carries no separator and
 *     is invisible to root-cause-repair.ts's path-token regex, a second reason
 *     that incident could not be attributed);
 *   - each is compared against the enforce commit's own file set, by path suffix
 *     and by RELATED STEM (`Admin.tsx` ~ `Admin.spec.tsx` ~ `Admin.stories.tsx`),
 *     so a regression in a touched file's own test still counts as overlap;
 *   - DISJOINT ⇒ keep the edits and route the defect. Anything else — an unknown
 *     enforce diff, a FAIL text naming no file at all, any overlap — reverts,
 *     which is exactly the pre-existing behaviour. Never keep on ignorance.
 *
 * Keeping the edits must not mean losing the finding: the caller still records the
 * debt and still queues the repair. Losing the finding was mx5 run 5's mistake.
 *
 * MEASURED COVERAGE, and it is the honest weakness of this filter. Live, 40 trials
 * against the run-18 tree with a real verify child
 * (`scripts/live-enforce-attribution-ab.ts`):
 *
 *   reachable arm (the enforce edit itself breaks `Admin.tsx`, ground truth REVERT)
 *     20/20 FAILs named a resolvable file, 20/20 decided correctly — tsc prints the
 *     path, so the regression case is fully covered.
 *   disjoint arm (a deterministic failure in `MyListings.spec.tsx`, ground truth KEEP)
 *     only 9/20 FAILs named a file at all. The other 11 named the UNIT — "The
 *     MyListings component test \"edit link navigates…\" fails … expects 4 Edit links"
 *     — with no path and no `.tsx` anywhere. Those 11 fall through to the revert.
 *
 * So this fires on roughly half of live disjoint failures and on the recorded run-18
 * verdict (which did name `MyListings.spec.tsx:186`), and it was NEVER wrong: 29 of
 * 29 extractable decisions matched ground truth across both arms. The arm-level
 * verdict is still FAIL against the pre-registered ≥80%-extractable bar, and the
 * shipped rule is deliberately the conservative half of that trade: a miss costs
 * exactly the behaviour that shipped before, while a false KEEP would ship a real
 * regression. A stem-widened extractor (accept a bare identifier matching a tracked
 * file's stem) reaches 40/40 with 0 errors in the same data and is NOT wired — see
 * VALIDATION-DEBT.md, it resolves prose nouns to files and its FP mode was never
 * exercised.
 */

/** A path-like token: at least one separator, ending in a file name. */
const PATH_TOKEN_RE = /(?:[\w.@~-]+\/)+[\w.@-]+\.\w+/g

/**
 * A bare file name with a code-ish extension. Deliberately extension-gated: an
 * ungated `\w+\.\w+` matches prose ("e.g.", "v1.2"), object access (`usersData.error`
 * — which run 18's own enforce diff contains) and assertion chains
 * (`toBeVisible()`), and every one of those would be a phantom "named file".
 */
const BARE_FILE_RE =
    /\b[\w@-]+(?:\.[\w@-]+)*\.(?:tsx?|jsx?|mtsx?|ctsx?|mjs|cjs|vue|svelte|astro|py|go|rs|rb|java|kt|kts|cs|php|swift|scala|c|h|cc|cpp|hpp|css|scss|sass|less|html?|json|jsonc|ya?ml|toml|sql|sh|bash|zsh|md|mdx|prisma|graphql|gql|proto|lock)\b/g

/** Line/column suffixes and decoration a reason wraps a file name in. */
const TRAILING_POSITION_RE = /:(\d+)(?::(\d+))?$/
/** Suffixes that make a file a sibling of another (test/story/type companions). */
const COMPANION_SUFFIXES = ['.spec', '.test', '.stories', '.story', '.d', '.min']
/** A pathological reason cannot make this scan unbounded. */
const MAX_NAMED = 24

/** Strip `./`, leading slashes and surrounding whitespace. */
function normalisePath(p: string): string {
    return p.replace(/^\.\//, '').replace(/^\/+/, '').trim()
}

/** The last path segment of a repo-relative path. */
function basename(p: string): string {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
}

/**
 * The comparable stem of a file name: the base name with its extension and any
 * companion suffix removed, lowercased. `src/client/pages/Admin.tsx`,
 * `Admin.spec.tsx` and `Admin.stories.tsx` all reduce to `admin`, which is what
 * makes "the enforce diff broke that file's own test" count as an overlap rather
 * than a disjoint (and therefore keepable) failure.
 */
export function fileStem(p: string): string {
    let name = basename(normalisePath(p))
    const dot = name.lastIndexOf('.')
    if (dot > 0) name = name.slice(0, dot)
    for (const suffix of COMPANION_SUFFIXES) {
        if (name.toLowerCase().endsWith(suffix)) {
            name = name.slice(0, name.length - suffix.length)
            break
        }
    }
    return name.toLowerCase()
}

/**
 * Every file a FAIL text names, de-duplicated, in first-seen order. Both shapes
 * count: `src/server/routes/photos.ts` (path) and `MyListings.spec.tsx:186` (bare
 * name plus a line number). An empty result is the signal that NOTHING can be
 * attributed — the caller must then revert, never keep.
 */
export function extractFailingFiles(text: string): string[] {
    if (text.trim().length === 0) return []
    const out: string[] = []
    const seen = new Set<string>()
    const add = (raw: string): void => {
        const cleaned = normalisePath(raw.replace(TRAILING_POSITION_RE, ''))
        if (cleaned.length === 0) return
        const key = cleaned.toLowerCase()
        if (seen.has(key)) return
        seen.add(key)
        if (out.length < MAX_NAMED) out.push(cleaned)
    }
    // Paths first so `src/a/B.ts` is recorded as the path, not as the bare `B.ts`
    // its own tail also matches.
    const covered: Array<[number, number]> = []
    for (const m of text.matchAll(PATH_TOKEN_RE)) {
        covered.push([m.index!, m.index! + m[0].length])
        add(withPosition(text, m.index! + m[0].length, m[0]))
    }
    for (const m of text.matchAll(BARE_FILE_RE)) {
        const start = m.index!
        if (covered.some(([s, e]) => start >= s && start < e)) continue
        add(withPosition(text, start + m[0].length, m[0]))
    }
    return out
}

/** Re-attach a `:line[:col]` suffix that follows a match, so it can be stripped
 *  uniformly (and so `a.ts:1` and `a.ts` collapse to one named file). */
function withPosition(text: string, end: number, token: string): string {
    const m = /^:\d+(?::\d+)?/.exec(text.slice(end))
    return m ? token + m[0] : token
}

/** Two repo-relative paths that denote the same file (suffix-compared). */
function samePath(a: string, b: string): boolean {
    const x = normalisePath(a).toLowerCase()
    const y = normalisePath(b).toLowerCase()
    return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`)
}

/**
 * Resolve a named file to a tracked repo path when the repo file list makes it
 * unambiguous. `MyListings.spec.tsx` → `src/client/pages/MyListings.spec.tsx`, so
 * the KEEP path can ask provenance about it and queue a real repair task. An
 * ambiguous name (two tracked files share it) resolves to null: guessing which one
 * the failure meant would put a wrong file in a repair task's title.
 */
export function resolveNamedFile(named: string, repoFiles: string[] | null): string | null {
    if (!repoFiles || repoFiles.length === 0) return null
    const matches = repoFiles.filter(f => samePath(f, named))
    if (matches.length === 1) return normalisePath(matches[0]!)
    // Exact-path hit wins over the suffix fan-out (a repo may track both
    // `a/x.ts` and `b/a/x.ts`).
    const exact = repoFiles.filter(
        f => normalisePath(f).toLowerCase() === normalisePath(named).toLowerCase()
    )
    return exact.length === 1 ? normalisePath(exact[0]!) : null
}

export interface EnforceAttributionInput {
    /** The differential re-verify's FAIL reason, verbatim. */
    failReason: string
    /**
     * Repo-relative paths the ENFORCE COMMIT changed. `null` means unknown (git
     * unavailable) and forces the pre-existing revert — inconclusive is never
     * evidence for keeping a possible regression.
     */
    enforceTouched: string[] | null
    /** Tracked repo paths, for resolving bare file names. Optional; absent only
     *  costs resolution, never changes the keep/revert verdict. */
    repoFiles?: string[] | null
}

/** Why the differential decided as it did — verbatim into the gate trail. */
export type EnforceAttributionWhy =
    | 'enforce-diff-unknown'
    | 'no-file-named'
    | 'named-file-in-enforce-diff'
    | 'disjoint-from-enforce-diff'

export interface EnforceAttribution {
    /** `keep` only on positive mechanical evidence that enforce cannot be at fault. */
    verdict: 'keep' | 'revert'
    why: EnforceAttributionWhy
    /** Files the FAIL text named (resolved to repo paths where unambiguous). */
    named: string[]
    /** The enforce commit's own file set, as compared against (for the trail). */
    enforceDiff: string[]
    /** On `revert`: the named file that overlaps the enforce diff. */
    overlap?: {named: string; enforce: string}
    /** On `keep`: the file to blame the defect on (the first named file). */
    file?: string
}

/**
 * Could the ENFORCE COMMIT have caused this FAIL? `keep` iff the failure names at
 * least one file and NO named file is the enforce diff's, or a companion of one.
 * Every unknown returns `revert`, i.e. exactly the behaviour that shipped before
 * this filter existed.
 */
export function attributeEnforceFailure(input: EnforceAttributionInput): EnforceAttribution {
    const enforce = (input.enforceTouched ?? []).map(normalisePath).filter(f => f.length > 0)
    if (input.enforceTouched === null || enforce.length === 0) {
        return {verdict: 'revert', why: 'enforce-diff-unknown', named: [], enforceDiff: enforce}
    }
    const raw = extractFailingFiles(input.failReason)
    const named = raw.map(n => resolveNamedFile(n, input.repoFiles ?? null) ?? n)
    if (named.length === 0)
        return {verdict: 'revert', why: 'no-file-named', named, enforceDiff: enforce}
    for (const n of named) {
        const hit = enforce.find(e => samePath(e, n) || fileStem(e) === fileStem(n))
        if (hit) {
            return {
                verdict: 'revert',
                why: 'named-file-in-enforce-diff',
                named,
                enforceDiff: enforce,
                overlap: {named: n, enforce: hit}
            }
        }
    }
    return {
        verdict: 'keep',
        why: 'disjoint-from-enforce-diff',
        named,
        enforceDiff: enforce,
        file: named[0]
    }
}
