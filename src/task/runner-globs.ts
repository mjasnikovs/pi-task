/**
 * runner-globs — deterministic detection of TWO TEST RUNNERS FIGHTING OVER THE SAME
 * FILES, checked as soon as a project declares both rather than discovered at run end.
 *
 * The failure this closes: a project declares both `bun test` and
 * `playwright test`. `bun test` with no arguments scans the whole project tree for
 * `*.test.*` / `*.spec.*`, and Playwright's component/e2e specs ARE `*.spec.tsx`.
 * So `bun test` imports Playwright spec files, which import `@playwright/test`
 * outside a Playwright runner, and the whole suite dies on a module it was never
 * meant to load.
 *
 * Finding that at the final gate is too late: the fix is a one-line config change
 * that can still be sitting uncommitted when the run ends. So the invariant is
 * checked the moment both runners are declared:
 *
 *     if two runners are declared, their file sets must be provably DISJOINT
 *
 * Disjointness has exactly two mechanical forms, and this module accepts either:
 *   - EXCLUSION: the scanning runner is configured to ignore the other's files
 *     (bunfig `[test] pathIgnorePatterns`), or
 *   - NAMING: the other runner's files are named so the scanner never claims them
 *     (Playwright `testMatch` on a suffix outside `*.test.*` / `*.spec.*`, e.g. `.e2e.ts`).
 *
 * Guard direction: UNKNOWN steps aside. A missing/unparseable manifest, one runner
 * only, or a Playwright config whose testMatch cannot be read all return `unknown` —
 * the check may cost time, never work.
 */

export type GlobCollisionStatus = 'collision' | 'disjoint' | 'unknown'

export interface GlobCollisionAssessment {
    status: GlobCollisionStatus
    /** Human- and prompt-readable explanation; '' when there is nothing to say. */
    detail: string
    /** The script names that invoke each runner (for naming the finding). */
    scanningScripts: string[]
    otherScripts: string[]
}

export interface RunnerGlobInputs {
    /** The manifest's `scripts` map. */
    scripts: Record<string, string>
    /** bunfig.toml text, or null when absent. */
    bunfig: string | null
    /** playwright config text (any of the playwright*.config.* files), or null. */
    playwrightConfig: string | null
}

/** `bun test` — the scanning runner: it claims every `*.test.*` / `*.spec.*` it finds. */
const BUN_TEST_RE = /\bbun\s+(?:--\S+\s+)*test\b/
/** `playwright test` (incl. `bunx`/`npx`/`pnpm exec` prefixes). */
const PLAYWRIGHT_RE = /\bplaywright\s+test\b/

/** The suffixes Bun's test runner claims by default. */
const BUN_CLAIMED_SUFFIX_RE = /\.(?:test|spec)\./

/** Scripts that invoke a given runner, by name. */
function scriptsMatching(scripts: Record<string, string>, re: RegExp): string[] {
    return Object.entries(scripts)
        .filter(([, body]) => typeof body === 'string' && re.test(body))
        .map(([name]) => name)
}

/**
 * Bun's declared ignore patterns (`[test] pathIgnorePatterns = [...]`). Returns null
 * when bunfig is absent or the key is not present — absent is not "empty", it is
 * unknown-shaped, and the caller distinguishes them.
 */
export function parsePathIgnorePatterns(bunfig: string | null): string[] | null {
    if (bunfig === null) return null
    const m = /^[ \t]*pathIgnorePatterns[ \t]*=[ \t]*\[([\s\S]*?)\]/m.exec(bunfig)
    if (!m) return null
    return [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1])
}

/**
 * Playwright's `testMatch`, when the config states one. Null when the config
 * states none (or there is no config), in which case the NAMING form cannot be
 * proven and `assessRunnerGlobs` falls through to the exclusion check.
 */
export function parseTestMatch(playwrightConfig: string | null): string[] | null {
    if (playwrightConfig === null) return null
    const m = /\btestMatch\s*:\s*(\[[\s\S]*?\]|['"][^'"]+['"]|\/[^/\n]+\/[gimsuy]*)/.exec(
        playwrightConfig
    )
    if (!m) return null
    const found = [...m[1].matchAll(/["']([^"']+)["']/g)].map(x => x[1])
    return found.length > 0 ? found : [m[1]]
}

/** Playwright's `testDir`, when stated (used to explain the collision concretely). */
export function parseTestDir(playwrightConfig: string | null): string | null {
    if (playwrightConfig === null) return null
    const m = /\btestDir\s*:\s*['"]([^'"]+)['"]/.exec(playwrightConfig)
    return m ? m[1].replace(/^\.\//, '').replace(/\/+$/, '') : null
}

/**
 * Does an ignore pattern plausibly cover Playwright's spec files? Deliberately
 * generous — this decides whether to STAY SILENT, and a guard that may only cost
 * time should resolve ambiguity toward silence. A pattern naming a `spec`/`test`
 * suffix, or the Playwright testDir, counts.
 */
function ignoreCoversSpecs(patterns: string[], testDir: string | null): boolean {
    return patterns.some(p => {
        if (BUN_CLAIMED_SUFFIX_RE.test(p) || /\bspec\b|\btest\b/.test(p)) return true
        return testDir !== null && testDir.length > 0 && p.includes(testDir)
    })
}

/**
 * Assess whether the declared runners can collide. See the module doc for the
 * invariant and the two accepted forms of disjointness.
 */
export function assessRunnerGlobs(input: RunnerGlobInputs): GlobCollisionAssessment {
    const scripts = input.scripts ?? {}
    const scanningScripts = scriptsMatching(scripts, BUN_TEST_RE)
    const otherScripts = scriptsMatching(scripts, PLAYWRIGHT_RE)
    const base = {scanningScripts, otherScripts}
    // Only one runner (or none) — nothing to collide.
    if (scanningScripts.length === 0 || otherScripts.length === 0) {
        return {status: 'unknown', detail: '', ...base}
    }
    // NAMING form: Playwright's own testMatch keeps its files outside Bun's claim.
    const testMatch = parseTestMatch(input.playwrightConfig)
    if (testMatch !== null && !testMatch.some(p => BUN_CLAIMED_SUFFIX_RE.test(p))) {
        return {
            status: 'disjoint',
            detail:
                `playwright testMatch (${testMatch.join(', ')}) names files outside bun test's `
                + `\`*.test.*\` / \`*.spec.*\` claim — the two runners cannot pick up each other's files`,
            ...base
        }
    }
    // EXCLUSION form: bun is told to ignore them.
    const ignore = parsePathIgnorePatterns(input.bunfig)
    const testDir = parseTestDir(input.playwrightConfig)
    if (ignore !== null && ignoreCoversSpecs(ignore, testDir)) {
        return {
            status: 'disjoint',
            detail:
                `bunfig [test] pathIgnorePatterns (${ignore.join(', ')}) excludes the playwright `
                + `spec files from bun test's scan`,
            ...base
        }
    }
    // Both declared, neither form of disjointness present.
    return {
        status: 'collision',
        detail:
            `\`${scanningScripts.join('`, `')}\` runs bun test, which scans the whole project for `
            + '`*.test.*` / `*.spec.*`, and `'
            + otherScripts.join('`, `')
            + '` runs playwright, whose specs use those same suffixes'
            + (testDir ? ` (testDir: ${testDir})` : '')
            + '. bun test will import the playwright specs and die on `@playwright/test` outside '
            + 'its runner. Declare disjoint file sets: add a bunfig.toml `[test] '
            + 'pathIgnorePatterns` entry excluding the playwright specs, or give them a suffix '
            + 'bun does not claim (e.g. `*.e2e.ts` via playwright `testMatch`)',
        ...base
    }
}

/**
 * Verify-child prompt lines for a collision. Empty for any non-collision status —
 * the caller emits no block.
 */
export function runnerGlobVerifyFindings(a: GlobCollisionAssessment): string[] {
    return a.status === 'collision' ? [a.detail] : []
}

/**
 * A plan-time contract line: the invariant, recorded so slices that add a runner
 * inherit it instead of rediscovering the collision. Empty when not applicable.
 */
export function runnerGlobContractLine(a: GlobCollisionAssessment): string {
    if (a.scanningScripts.length === 0 || a.otherScripts.length === 0) return ''
    return (
        `Test-runner file sets MUST be disjoint: \`${a.scanningScripts.join('`, `')}\` (bun test, `
        + `scans \`*.test.*\`/\`*.spec.*\` project-wide) and \`${a.otherScripts.join('`, `')}\` `
        + `(playwright) must not claim the same files — enforce via bunfig \`[test] `
        + `pathIgnorePatterns\` or a playwright \`testMatch\` suffix bun does not scan.`
    )
}
