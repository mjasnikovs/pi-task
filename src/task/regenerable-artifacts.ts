/**
 * The one place that knows which repo paths are regenerable machine OUTPUT.
 *
 * Three call sites need the fact and all three import it from here rather than
 * keeping a copy: `git-state-guard.ts` (verdicts), `write-guard.ts` (whether a
 * deletion rejects the whole fix attempt) and `auto-commit.ts` (what the commit
 * may newly track). Import from here; do not copy.
 *
 * TWO LISTS, and the split between them is the whole point.
 *
 * `REGENERABLE_ARTIFACT_PATTERNS` is the VERDICT list: a gate child that rewrote
 * one of these did not mutate the work under judgement, so its verdict stands.
 * Being wrong here costs a discarded verify.
 *
 * `DELETION_EXEMPT_ARTIFACT_PATTERNS` is the strict SUBSET a fix pass may DELETE
 * without its whole attempt being rejected. Being wrong here destroys a
 * deliverable, so it is narrower, and `dist/`, `build/`, `.next/`, `.turbo/` and
 * `.svelte-kit/` are deliberately NOT in it.
 *
 * The line between the two lists is whether the path has a HAND-AUTHORED form.
 * `test-results/`, `playwright-report/`, `coverage/`, `.nyc_output/`,
 * `.last-run.json` and `*.tsbuildinfo` have none — no version of them is
 * somebody's deliverable — so deleting one can never destroy work. `dist/` and
 * its family do: a published package's `dist/` IS the shipped artifact, so a
 * delete there can.
 */

/** Directory prefixes and file names that are regenerable test/build output. */
export const REGENERABLE_ARTIFACT_PATTERNS: readonly RegExp[] = [
    /^(?:test-results|playwright-report|coverage|\.nyc_output|dist|build|\.next|\.turbo|\.svelte-kit)\//,
    /(?:^|\/)\.last-run\.json$/,
    /\.tsbuildinfo$/
]

/**
 * The strict subset a fix pass may delete, and the pipeline must not newly track.
 *
 * Every entry here is output a test runner rewrites on its next run. Absent from
 * this list, and staying absent: `dist/`, `build/`, `.next/`, `.turbo/`,
 * `.svelte-kit/` — see the header.
 */
export const DELETION_EXEMPT_ARTIFACT_PATTERNS: readonly RegExp[] = [
    /^(?:test-results|playwright-report|coverage|\.nyc_output)\//,
    /(?:^|\/)\.last-run\.json$/,
    /\.tsbuildinfo$/
]

/** Human-readable form of the exempt list. Nothing in this repo reads it today;
 *  the guards go through {@link isDeletionExemptArtifact}. */
export const DELETION_EXEMPT_ARTIFACT_GLOBS: readonly string[] = [
    'test-results/',
    'playwright-report/',
    'coverage/',
    '.nyc_output/',
    '.last-run.json',
    '*.tsbuildinfo'
]

const normalize = (relPath: string): string => relPath.replace(/\\/g, '/')

/** Is this path regenerable machine output, for VERDICT purposes? */
export function isRegenerableArtifact(relPath: string): boolean {
    const p = normalize(relPath)
    return REGENERABLE_ARTIFACT_PATTERNS.some(re => re.test(p))
}

/**
 * May a fix pass DELETE this path without its whole attempt being rejected, and
 * may the pipeline leave it untracked? Narrower than `isRegenerableArtifact` on
 * purpose: build output is excluded because a committed one can be the product.
 */
export function isDeletionExemptArtifact(relPath: string): boolean {
    const p = normalize(relPath)
    return DELETION_EXEMPT_ARTIFACT_PATTERNS.some(re => re.test(p))
}
