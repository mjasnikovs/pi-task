/**
 * Project orientation core — a bounded snapshot of the few files a research worker
 * re-reads cold to learn "what is this project" (the doc the task cites, manifest,
 * config, project rules, domain types, schema, entrypoints, API surface). The four
 * research workers are separate child processes with no shared memory, so without
 * this each one reads the same hot files for itself.
 *
 * This module picks that core from the file inventory (repo-agnostic, by path
 * convention) and reads it ONCE in the parent. The caller folds the block into a
 * prompt: refine gets the manifest/config tiers, and phases.ts prepends the full
 * block to the three EXPLORING research workers — not to TOOLING. It is purely
 * additive: nothing is blocked, so a worker can still read anything it wants;
 * orientation only removes the need to.
 *
 * ELIGIBILITY IS A REGISTRY, not a ladder of regexes: {@link ORIENTATION_RULES} is
 * an ordered list of `{id, tier, match}` rows over an {@link OrientationCandidate},
 * so "does this file orient" and "how fundamental is it" are one row each, and the
 * two facts a path cannot carry on its own — whether the task CITES it, and whether
 * it is VENDORED — are fields on the candidate rather than more pattern-matching.
 *
 * Bounded by design — the snapshot can never overflow the prompt regardless of
 * repo size: a hard total byte budget, a per-file cap so one huge file can't eat
 * it, a candidate cap, and a second budget of the same size that only cited
 * documents may draw on. Files that don't fit are simply not pre-supplied; the worker reads
 * them as before. Selection is the pure, tested core; reading takes an injectable
 * reader so it can be exercised without a repo.
 */

/**
 * Total bytes the emitted orientation block may occupy. This is the real overflow
 * guard: it bounds the block regardless of repo size, and because the snapshot is
 * prepended to each exploring worker it also caps the prefill those workers pay.
 * Selection stops as soon as adding a file would exceed it.
 */
export const ORIENTATION_BYTE_BUDGET = 40 * 1024
/** A single file larger than this is skipped (read by the worker as before). */
export const ORIENTATION_PER_FILE_MAX = 12 * 1024
/**
 * A SECOND purse, spent only on cited documents.
 *
 * A design doc is routinely most of the core budget on its own — the recorded mx5
 * run's is 29 KB of 40 KB — so charging it to the shared purse buys the one file
 * the task cites by dropping five files every task needs. Equal to the core
 * budget, so the block can at most double and the bound stays a stated one.
 */
export const ORIENTATION_CITED_BYTE_BUDGET = ORIENTATION_BYTE_BUDGET
/**
 * Backstop file-count cap — a guard against a pathological repo with hundreds of
 * tiny core files packing the byte budget into noise, NOT a normal-case limit. Set
 * high enough that the byte budget binds first: whenever this cap is what stops
 * selection, budget is left unspent and core files are dropped for no reason.
 */
export const ORIENTATION_MAX_FILES = 40

/**
 * The priority ladder, lowest first. The tiers mirror the questions a worker
 * re-derives on every task: what am I being asked about (the cited doc) → what is
 * this project (manifest) → how is it built (config) → what rules does it set for
 * itself (guidelines) → what is its domain model (types/schema) → where does it
 * start (entrypoints) → what is its surface (api) → what does it say about itself
 * (docs).
 *
 * Named rather than numbered at the call sites: refine asks for "manifest and
 * config", not for "0 and 1", and a tier inserted in the middle must not silently
 * change what refine gets.
 */
export const ORIENTATION_TIERS = {
    cited: 0,
    manifest: 1,
    config: 2,
    guidelines: 3,
    domain: 4,
    entrypoint: 5,
    api: 6,
    docs: 7
} as const

/** Code/config/doc extensions worth pre-reading; everything else is ignored. */
const ORIENTATION_EXTENSIONS = new Set([
    'ts',
    'tsx',
    'js',
    'jsx',
    'mjs',
    'cjs',
    'json',
    'sql',
    'prisma',
    'go',
    'rs',
    'py',
    'rb',
    'java',
    'kt',
    'md',
    'toml',
    'graphql',
    'gql'
])

/** Root manifests — the single highest-signal "what is this project" file. */
const MANIFEST_BASENAMES = new Set([
    'package.json',
    'go.mod',
    'cargo.toml',
    'pyproject.toml',
    'requirements.txt',
    'pom.xml',
    'build.gradle',
    'gemfile',
    'composer.json',
    'deno.json'
])

/** The files a project states its own rules in. */
const GUIDELINE_BASENAMES = new Set(['agents.md', 'claude.md'])

/**
 * Directories whose contents are never this project's own source: vendored
 * dependencies, build output, and the agent's own scaffolding. A dependency's
 * `package.json` is a manifest by basename and `.pi/skills/**` is a wall of
 * markdown — either would outrank the project's real files and eat the budget.
 *
 * A registry rather than one regex so a project can be given more through
 * `.gitignore` and `orientationExclude` (config.ts) without editing a pattern.
 */
export const VENDORED_DIRS: readonly string[] = [
    '.git',
    'node_modules',
    'dist',
    'build',
    'out',
    'vendor',
    'coverage',
    '.pi',
    '.pi-tasks'
]

/** What a rule decides on, beyond the path itself. */
export interface OrientationCandidate {
    path: string
    /** The task prompt names this file (a readable @-mention): its spec document. */
    cited: boolean
    /** Not this project's own source — see {@link VENDORED_DIRS}. */
    vendored: boolean
}

/** One eligibility rule: the tier a matching candidate lands in. */
export interface OrientationRule {
    id: string
    tier: number
    match: (c: OrientationCandidate) => boolean
    /**
     * This row identifies a file by its exact name (or because the task cites
     * it), so {@link ORIENTATION_EXTENSIONS} does not apply. That filter exists to
     * stop a row from GUESSING at a `.png` or a `.lock`; `Gemfile` and
     * `requirements.txt` are not guesses.
     */
    byName?: true
}

function basename(p: string): string {
    const i = p.lastIndexOf('/')
    return i === -1 ? p : p.slice(i + 1)
}

function extension(p: string): string {
    const b = basename(p)
    const i = b.lastIndexOf('.')
    return i === -1 ? '' : b.slice(i + 1).toLowerCase()
}

function depth(p: string): number {
    let n = 0
    for (const c of p) if (c === '/') n++
    return n
}

/**
 * Eligibility, in priority order — FIRST MATCH WINS, and a candidate no row
 * matches is not orientation material and is dropped entirely.
 *
 * The three rejecting rows come first and carry no tier of their own: a vendored
 * file, a test and an absolute path are excluded whatever else they look like.
 * They are rows rather than early returns so the whole policy is one list.
 */
export const ORIENTATION_RULES: ReadonlyArray<OrientationRule> = [
    {
        // The task's own spec document. Highest tier because it is the one file
        // the worker is guaranteed to need and the one it cannot guess the path
        // of — the mx5 run read it 50 times because orientation could not select
        // a `DESIGN/*.md` by convention.
        id: 'cited-spec-doc',
        tier: ORIENTATION_TIERS.cited,
        match: c => c.cited,
        byName: true
    },
    {
        id: 'manifest',
        tier: ORIENTATION_TIERS.manifest,
        match: c => MANIFEST_BASENAMES.has(basename(c.path).toLowerCase()),
        byName: true
    },
    {
        id: 'config',
        tier: ORIENTATION_TIERS.config,
        match: c => {
            const base = basename(c.path).toLowerCase()
            return (
                base === 'tsconfig.json'
                || /\.config\.(ts|js|mjs|cjs|json)$/.test(base)
                || extension(c.path) === 'toml'
            )
        }
    },
    {
        id: 'guidelines',
        tier: ORIENTATION_TIERS.guidelines,
        match: c => GUIDELINE_BASENAMES.has(basename(c.path).toLowerCase()),
        byName: true
    },
    {
        id: 'domain',
        tier: ORIENTATION_TIERS.domain,
        match: c => {
            const lower = c.path.toLowerCase()
            const ext = extension(lower)
            const base = basename(lower)
            return (
                ext === 'sql'
                || ext === 'prisma'
                || ext === 'graphql'
                || ext === 'gql'
                || base.endsWith('.d.ts')
                || lower.split('/').includes('types')
                || base.replace(/\.[^.]+$/, '') === 'types'
                || /schema|zod/.test(lower)
            )
        }
    },
    {
        id: 'entrypoint',
        tier: ORIENTATION_TIERS.entrypoint,
        match: c =>
            ['index', 'main', 'app', 'server', 'mod'].includes(
                basename(c.path)
                    .toLowerCase()
                    .replace(/\.[^.]+$/, '')
            )
    },
    {
        id: 'api',
        tier: ORIENTATION_TIERS.api,
        match: c => {
            const lower = c.path.toLowerCase()
            return /(^|\/)api(\/|s?\.|$)/.test(lower) || lower.split('/').includes('api')
        }
    },
    {
        id: 'readme',
        tier: ORIENTATION_TIERS.docs,
        match: c =>
            basename(c.path)
                .toLowerCase()
                .replace(/\.[^.]+$/, '') === 'readme'
    }
]

/** A path that no rule may promote, whatever it looks like. */
function excluded(c: OrientationCandidate): boolean {
    if (c.vendored) return true
    if (c.path.startsWith('/')) return true // absolute path escaped the repo root
    const lower = c.path.toLowerCase()
    return /\.(test|spec)\.[a-z]+$/.test(lower) || /(^|\/)(__tests__|e2e)\//.test(lower)
}

/**
 * Priority tier for an orientation candidate — lower is more fundamental, null
 * for a path that is not orientation material.
 */
export function orientationTier(
    path: string,
    opts: {cited?: boolean; vendored?: boolean} = {}
): number | null {
    const candidate: OrientationCandidate = {
        path,
        cited: opts.cited ?? false,
        vendored: opts.vendored ?? isVendored(path)
    }
    if (excluded(candidate)) return null
    const rule = ORIENTATION_RULES.find(r => r.match(candidate))
    if (!rule) return null
    if (!rule.byName && !ORIENTATION_EXTENSIONS.has(extension(path))) return null
    return rule.tier
}

/**
 * Is this path outside the project's own source? `VENDORED_DIRS` plus whatever
 * `.gitignore` and `orientationExclude` add (see {@link parseIgnorePatterns}).
 */
export function isVendored(path: string, patterns: readonly string[] = []): boolean {
    const segments = path.split('/')
    if (VENDORED_DIRS.some(d => segments.includes(d))) return true
    return patterns.some(p => ignoreMatcher(p)(path))
}

/**
 * The usable patterns in a `.gitignore`.
 *
 * Negations (`!kept.md`) are DROPPED rather than honoured: un-ignoring is a
 * whole-file-order semantics this does not implement, and the inventory a real
 * run orients over is `git ls-files`, which has already applied the real rules.
 * What is left here only has to keep bulk out.
 */
export function parseIgnorePatterns(gitignore: string): string[] {
    return gitignore
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'))
}

const matchers = new Map<string, (path: string) => boolean>()

/** A `.gitignore`-style pattern as a predicate, compiled once per pattern. */
function ignoreMatcher(pattern: string): (path: string) => boolean {
    const cached = matchers.get(pattern)
    if (cached) return cached
    const anchored = pattern.startsWith('/')
    const body = pattern.replace(/^\//, '').replace(/\/$/, '')
    const source = body
        .split('/')
        .map(seg =>
            seg
                .split('*')
                .map(part => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&'))
                .join('[^/]*')
                // `**` survives the split above as two `[^/]*` around an empty
                // part; a directory wildcard has to cross separators.
                .replace(/\[\^\/\]\*\[\^\/\]\*/g, '.*')
        )
        .join('/')
    // A pattern matches the path itself or anything under it, and — unless it is
    // anchored to the repo root — at any depth, which is gitignore's own rule.
    const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${source}(?:/.*)?$`)
    const fn = (path: string): boolean => re.test(path)
    matchers.set(pattern, fn)
    return fn
}

/** One selected file and the tier it was selected at. */
export interface OrientationPick {
    path: string
    tier: number
}

export interface OrientationSelectOptions {
    /** Paths the task prompt cites — its spec documents. */
    cited?: readonly string[]
    /** `.gitignore` lines plus `orientationExclude`, on top of `VENDORED_DIRS`. */
    excludePatterns?: readonly string[]
}

/**
 * Rank inventory paths into orientation priority order: by tier, then shallower
 * paths first (a root entrypoint beats a deeply-nested one), then alphabetical
 * for a fully deterministic order. Non-orientation paths are dropped. The result
 * is the *candidate* order; the byte budget is applied later when reading.
 */
export function selectOrientationFiles(
    inventoryPaths: string[],
    opts: OrientationSelectOptions = {}
): OrientationPick[] {
    const cited = new Set(opts.cited ?? [])
    return inventoryPaths
        .map(p => ({
            path: p,
            tier: orientationTier(p, {
                cited: cited.has(p),
                vendored: isVendored(p, opts.excludePatterns ?? [])
            })
        }))
        .filter((x): x is OrientationPick => x.tier !== null)
        .sort(
            (a, b) => a.tier - b.tier || depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1)
        )
}

export interface OrientationResult {
    /** Formatted PROJECT ORIENTATION block to prepend to the worker header, or ''. */
    block: string
    /** Resolved-relative paths whose full content was pre-supplied in the block. */
    supplied: Set<string>
}

export interface OrientationBuildOptions extends OrientationSelectOptions {
    byteBudget?: number
    /** The separate purse cited documents are charged to — see
     *  {@link ORIENTATION_CITED_BYTE_BUDGET}. */
    citedByteBudget?: number
    perFileMax?: number
    maxFiles?: number
}

/**
 * Read the orientation core within the byte budget and format it as a header
 * block. `readFile` returns a file's text or null (missing/unreadable/binary) —
 * a null or over-cap file is skipped, not fatal. Greedy in priority order: take
 * each file whose content fits its tier's per-file cap and the remaining total
 * budget; skip the rest. Returns an empty block (and empty set) when nothing
 * qualifies, so the caller falls back to today's behavior.
 */
export async function buildOrientation(
    inventoryPaths: string[],
    readFile: (path: string) => Promise<string | null>,
    opts: OrientationBuildOptions = {}
): Promise<OrientationResult> {
    const byteBudget = opts.byteBudget ?? ORIENTATION_BYTE_BUDGET
    const citedBudget = opts.citedByteBudget ?? ORIENTATION_CITED_BYTE_BUDGET
    const perFileMax = opts.perFileMax ?? ORIENTATION_PER_FILE_MAX
    const maxFiles = opts.maxFiles ?? ORIENTATION_MAX_FILES
    // The cited doc is the file the task is ABOUT, and a design document is
    // routinely larger than the cap that keeps one incidental file from eating
    // the budget. Skipping it is the failure this tier exists to fix, so it is
    // bounded by its own purse instead.
    const cited = (tier: number): boolean => tier === ORIENTATION_TIERS.cited
    const perFileMaxFor = (tier: number): number => (cited(tier) ? citedBudget : perFileMax)

    const candidates = selectOrientationFiles(inventoryPaths, opts).slice(0, maxFiles * 4)
    const supplied = new Set<string>()
    const parts: string[] = []
    // Budget the *emitted* block, not just the raw content: the per-file fence
    // (`--- path ---\n` + the `\n\n` join) and the fixed wrapper add up across many
    // files, so a content-only budget lets the block overrun. Seeding `used` with
    // the wrapper makes `Buffer.byteLength(block) <= byteBudget` an invariant.
    const HEADER =
        `PROJECT ORIENTATION (full contents of the project's core files — `
        + `already provided, do not re-read these)\n`
    const TRAILER = '\n\n'
    let used = Buffer.byteLength(HEADER + TRAILER, 'utf8')
    let usedCited = 0

    for (const {path, tier} of candidates) {
        if (supplied.size >= maxFiles) break
        const text = await readFile(path)
        if (text === null) continue
        if (Buffer.byteLength(text, 'utf8') > perFileMaxFor(tier)) continue
        const piece = `--- ${path} ---\n${text.replace(/\n+$/, '')}`
        // Each piece after the first is preceded by the `\n\n` join separator.
        const pieceBytes = Buffer.byteLength(piece, 'utf8') + (parts.length > 0 ? 2 : 0)
        if (cited(tier)) {
            if (usedCited + pieceBytes > citedBudget) continue
            usedCited += pieceBytes
        } else {
            if (used + pieceBytes > byteBudget) continue
            used += pieceBytes
        }
        supplied.add(path)
        parts.push(piece)
    }

    if (parts.length === 0) return {block: '', supplied}
    return {block: HEADER + parts.join('\n\n') + TRAILER, supplied}
}
