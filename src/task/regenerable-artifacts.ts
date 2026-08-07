/**
 * The one place that knows which repo paths are regenerable machine OUTPUT.
 *
 * This module exists because the knowledge was in exactly one module and two
 * others needed it (mx5 run 20). `git-state-guard.ts` knew `test-results/` was
 * regenerable and used it for VERDICT decisions only; `write-guard.ts`'s deletion
 * guard did not, so it rejected two whole fix attempts over three Playwright
 * failure screenshots — taking each attempt's real `src/client/api.test.tsx`
 * repair with them — and `auto-commit.ts` did not, so its blind `git add -A` is
 * how the screenshots became tracked in the first place. Three modules, one fact,
 * shared with neither of the two that needed it. Import from here; do not copy.
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
 * MEASURED over 269 git work trees under ~/hub, ~/tmp, ~/.cache
 * (`scripts/tracked-artifact-baserate.ts`, 2026-08-07):
 *
 *     trees tracking any artifact path      33   (33 of 33 have .pi-tasks)
 *     test-results/                         33 trees / 33 files
 *     .last-run.json                        33 trees / 33 files  ← the SAME 33 files
 *     dist/, build/, .next/, .turbo/, .svelte-kit/, playwright-report/,
 *     coverage/, .nyc_output/, *.tsbuildinfo      0 trees
 *
 * So `test-results/` and `.last-run.json` are exempt on MEASUREMENT — they are the
 * only artifact paths this corpus tracks at all, and the one real episode is
 * exactly a tracked `test-results/` deletion. `playwright-report/`, `coverage/`,
 * `.nyc_output/` and `*.tsbuildinfo` are exempt BY CONSTRUCTION with zero corpus
 * evidence either way: none of the four has a hand-authored form, so there is no
 * version of them that is a deliverable. `dist/` and its family have exactly the
 * hand-authored form the other six lack — a published package's `dist/` IS the
 * shipped artifact — and with 0 tracked instances here the exemption would never
 * fire anyway, so it would buy nothing while carrying that risk.
 *
 * 32 of the 33 trees are one A/B harness's delivery trees built from a single mx5
 * DESIGN/PROJECT.md: 32 independent RUNS of one project shape, which is evidence
 * of reproducibility and not of breadth. The 33rd is mx5 itself.
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

/** Human-readable form of the exempt list, for trail lines and pathspecs. */
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
