/**
 * Project orientation core — a bounded snapshot of the few files a research worker
 * re-reads cold to learn "what is this project" (manifest, config, domain types,
 * schema, entrypoints, API surface). The four research workers are separate child
 * processes with no shared memory, so without this each one reads the same hot
 * files for itself.
 *
 * This module picks that core from the file inventory (repo-agnostic, by path
 * convention) and reads it ONCE in the parent. The caller folds the block into a
 * prompt: refine gets a tier-0/1 subset, and phases.ts prepends the full block to
 * the two READ-HEAVY research workers (`worker:files`, `worker:apis`) — not to all
 * four. It is purely additive: nothing is blocked, so a worker can still read
 * anything it wants; orientation only removes the need to.
 *
 * Bounded by design — the snapshot can never overflow the prompt regardless of
 * repo size: a hard total byte budget, a per-file cap (one huge file can't eat
 * the budget), and a candidate cap. Files that don't fit are simply not
 * pre-supplied; the worker reads them as before. Selection is the pure, tested
 * core; reading takes an injectable reader so it can be exercised without a repo.
 */

/**
 * Total bytes the emitted orientation block may occupy. This is the real overflow
 * guard: it bounds the block regardless of repo size, and because the snapshot is
 * prepended to each read-heavy worker it also caps the prefill those workers pay.
 * Selection stops as soon as adding a file would exceed it.
 */
export const ORIENTATION_BYTE_BUDGET = 40 * 1024
/** A single file larger than this is skipped (read by the worker as before). */
export const ORIENTATION_PER_FILE_MAX = 12 * 1024
/**
 * Backstop file-count cap — a guard against a pathological repo with hundreds of
 * tiny core files packing the byte budget into noise, NOT a normal-case limit. Set
 * high enough that the byte budget binds first: whenever this cap is what stops
 * selection, budget is left unspent and core files are dropped for no reason.
 */
export const ORIENTATION_MAX_FILES = 40

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
 * Priority tier for an orientation candidate — lower is more fundamental. The
 * tiers mirror the questions a worker re-derives on every task: what is this
 * project (manifest) → how is it built (config) → what is its domain model
 * (types/schema) → where does it start (entrypoints) → what is its surface (api)
 * → what does it say about itself (docs). Returns null for paths that aren't
 * orientation material, so they're dropped entirely.
 */
export function orientationTier(path: string): number | null {
    const lower = path.toLowerCase()
    // Never orient on vendored/build output or tests: a dependency's package.json
    // is tier 0 by basename and a `*.test.ts` under `src/types/` is tier 2, so
    // either would outrank the project's own files and eat the budget. A
    // git-ls-files inventory won't list these anyway; this is belt-and-braces.
    if (/(^|\/)(node_modules|dist|build|out|vendor|\.git|coverage)\//.test(lower)) return null
    if (/\.(test|spec)\.[a-z]+$/.test(lower) || /(^|\/)(__tests__|e2e)\//.test(lower)) return null
    if (path.startsWith('/')) return null // absolute path escaped the repo root
    const base = basename(lower)
    const ext = extension(lower)
    if (MANIFEST_BASENAMES.has(base)) return 0
    if (!ORIENTATION_EXTENSIONS.has(ext)) return null
    if (base === 'tsconfig.json' || /\.config\.(ts|js|mjs|cjs|json)$/.test(base)) return 1
    const segs = lower.split('/')
    const stem = base.replace(/\.[^.]+$/, '')
    if (
        ext === 'sql'
        || ext === 'prisma'
        || ext === 'graphql'
        || ext === 'gql'
        || base.endsWith('.d.ts')
        || segs.includes('types')
        || stem === 'types'
        || /schema|zod/.test(lower)
    )
        return 2
    if (['index', 'main', 'app', 'server', 'mod'].includes(stem)) return 3
    if (/(^|\/)api(\/|s?\.|$)/.test(lower) || segs.includes('api')) return 4
    if (stem === 'readme') return 5
    return null
}

/**
 * Rank inventory paths into orientation priority order: by tier, then shallower
 * paths first (a root entrypoint beats a deeply-nested one), then alphabetical
 * for a fully deterministic order. Non-orientation paths are dropped. The result
 * is the *candidate* order; the byte budget is applied later when reading.
 */
export function selectOrientationFiles(inventoryPaths: string[]): string[] {
    return inventoryPaths
        .map(p => ({p, tier: orientationTier(p)}))
        .filter((x): x is {p: string; tier: number} => x.tier !== null)
        .sort((a, b) => a.tier - b.tier || depth(a.p) - depth(b.p) || (a.p < b.p ? -1 : 1))
        .map(x => x.p)
}

export interface OrientationResult {
    /** Formatted PROJECT ORIENTATION block to prepend to the worker header, or ''. */
    block: string
    /** Resolved-relative paths whose full content was pre-supplied in the block. */
    supplied: Set<string>
}

/**
 * Read the orientation core within the byte budget and format it as a header
 * block. `readFile` returns a file's text or null (missing/unreadable/binary) —
 * a null or over-cap file is skipped, not fatal. Greedy in priority order: take
 * each file whose content fits the per-file cap and the remaining total budget;
 * skip the rest. Returns an empty block (and empty set) when nothing qualifies,
 * so the caller falls back to today's behavior.
 */
export async function buildOrientation(
    inventoryPaths: string[],
    readFile: (path: string) => Promise<string | null>,
    opts: {byteBudget?: number; perFileMax?: number; maxFiles?: number} = {}
): Promise<OrientationResult> {
    const byteBudget = opts.byteBudget ?? ORIENTATION_BYTE_BUDGET
    const perFileMax = opts.perFileMax ?? ORIENTATION_PER_FILE_MAX
    const maxFiles = opts.maxFiles ?? ORIENTATION_MAX_FILES

    const candidates = selectOrientationFiles(inventoryPaths).slice(0, maxFiles * 4)
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

    for (const path of candidates) {
        if (supplied.size >= maxFiles) break
        const text = await readFile(path)
        if (text === null) continue
        if (Buffer.byteLength(text, 'utf8') > perFileMax) continue
        const piece = `--- ${path} ---\n${text.replace(/\n+$/, '')}`
        // Each piece after the first is preceded by the `\n\n` join separator.
        const pieceBytes = Buffer.byteLength(piece, 'utf8') + (parts.length > 0 ? 2 : 0)
        if (used + pieceBytes > byteBudget) continue
        used += pieceBytes
        supplied.add(path)
        parts.push(piece)
    }

    if (parts.length === 0) return {block: '', supplied}
    return {block: HEADER + parts.join('\n\n') + TRAILER, supplied}
}
