/**
 * test-assembly — deterministic detection of TEST-REBUILT PRODUCTION WIRING, feeding
 * the verify gate's prompt (run-8 F4; third recurrence of the test-the-copy class,
 * runs 3, 4, 8).
 *
 * The failure class: a test file re-constructs wiring that ALSO exists in production
 * — it builds its own app assembly / its own entry point out of the same leaf modules
 * the production entry composes, then tests THAT private copy. The copy can be wired
 * differently from production and stay green while the shipped wiring is broken. Run-8
 * fixture: `test/photos.test.ts` imports the real `authRoutes` + `photosRoutes` leaves,
 * mounts them into its OWN app at a DIFFERENT prefix than the production entry, and
 * runs green end to end — while the shipped upload path is dead because production mounts
 * the same leaf at the wrong prefix. The verify child, judging "do the tests pass",
 * saw green and counted the photos area verified. The seam the test was supposed to
 * cover is exactly the seam it re-implemented away.
 *
 * This is the VERIFY-SIDE complement of the generation-side wiring probe
 * (wiring-claims.ts, item #5) and shares the load-bearing lesson of
 * substitution-probe / skip-escape / wiring-claims: a deterministic finding that NAMES
 * the suspect file is the reliable lever; a bare prompt rule is weak. rule 3b already
 * tells the child to spot-check that self-authored tests exercise the real artifact,
 * but F4 slips through because these tests DO import the real leaf modules — they just
 * bypass the real ASSEMBLY, which rule 3b's "did it import and call the module" check
 * does not catch. This probe supplies the missing concrete fact.
 *
 * THE SIGNAL is pure import-graph SHAPE, zero stack/framework assumptions (no "app",
 * no "route", no "mount", no language runtime): a test file T is flagged when there is
 * a production file E (the assembly/entry) such that
 *   - T does NOT import E (it bypasses the shipped assembly), AND
 *   - T and E both import ≥2 of the SAME leaf modules, where each such leaf is
 *     imported by E and by NO OTHER production file (E is the leaf's SOLE production
 *     composition site).
 * The "E-exclusive leaf" condition is the crisp discriminator that keeps ordinary
 * shared-utility imports out: a test importing an api client + a schema module that
 * every page also imports is NOT re-assembly (those utilities have many production
 * importers); a test importing two route modules that only the server entry composes
 * IS re-assembly. Measured on the run-8 fixture tree: flags exactly the four backend
 * tests that rebuild the server entry's route composition (including the real
 * photos seam bug) and leaves clean the single-leaf direct test, the utility-sharing
 * page test, and the source-grepping test — 0 false positives.
 *
 * Findings are ADVISORY (probe+rule): they mandate the child to exercise the REAL
 * shipped assembly directly before counting the area verified; they never auto-FAIL.
 * A test that re-composes wiring which happens to match production survives once the
 * child drives the real entry; only one whose real assembly is broken gets named.
 */

import {isTestFile} from './substitution-probe.js'

/** A source file the probe reasons over: repo-relative path + its full text. */
export interface RepoFile {
    /** Path relative to the repo root (used verbatim in the finding text). */
    path: string
    /** Full file contents (import statements are parsed out of it). */
    text: string
}

/** One test file that rebuilds a production assembly instead of importing it. */
export interface TestAssemblyFinding {
    /** The test file re-constructing the wiring. */
    testFile: string
    /** The production assembly / entry it bypasses (sole composer of the leaves). */
    assemblyFile: string
    /** The leaf modules (repo-relative, extensionless) the test re-composes. */
    leaves: string[]
}

/** Code file extensions whose relative imports we resolve. Not a stack assumption —
 *  purely which quoted specifiers name a repo file; other languages simply produce
 *  no matches and the whole probe degrades to nothing. */
const CODE_EXT_RE = /\.(?:[cm]?[jt]sx?)$/

/**
 * Static import/re-export declarations: `import … from 'x'`, `import 'x'`,
 * `export … from 'x'`. Anchored to line start (after optional whitespace) so an
 * import-shaped STRING inside an assertion (`expect(src).toContain("import x from
 * '../y'")`, a source-grepping test) is NOT mistaken for a real import — that string
 * is indented behind `expect(`, never at line start.
 */
const STATIC_IMPORT_RE = /^[ \t]*(?:import|export)\s+(?:[^'"\n]*\sfrom\s+)?['"]([^'"]+)['"]/gm
/** Dynamic `import('x')` / `require('x')` calls (the call-paren form is unlikely to
 *  appear inside an assertion string, so matching anywhere is safe enough). */
const CALL_IMPORT_RE = /(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Strip a code extension and a trailing `/index` so `./a`, `./a.ts`, and
 *  `./a/index.ts` all collapse to the same module id. */
function stripToModuleId(p: string): string {
    return p.replace(CODE_EXT_RE, '').replace(/\/index$/, '')
}

/** Normalise a POSIX-style relative path (resolve `.`/`..` segments) without touching
 *  the filesystem — the analysis is pure text shape. */
function normalisePosix(p: string): string {
    const segments: string[] = []
    for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue
        if (seg === '..') segments.pop()
        else segments.push(seg)
    }
    return segments.join('/')
}

/** The importing file's OWN module id (path minus extension / `/index`). */
export function moduleIdOf(filePath: string): string {
    return stripToModuleId(filePath)
}

/**
 * The set of repo-relative, extensionless module ids that `text` imports via RELATIVE
 * specifiers (a specifier starting with `.`). Bare/external specifiers (`hono`,
 * `bun:sql`, `node:fs`) are ignored — they never name a repo file, so they cannot be
 * a re-composed production leaf. Resolution is pure path arithmetic against the
 * importer's directory; the filesystem is never touched.
 */
export function relativeImports(filePath: string, text: string): string[] {
    const dir = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
    const ids = new Set<string>()
    for (const re of [STATIC_IMPORT_RE, CALL_IMPORT_RE]) {
        re.lastIndex = 0
        for (let m = re.exec(text); m !== null; m = re.exec(text)) {
            const spec = m[1]
            if (!spec.startsWith('.')) continue
            ids.add(stripToModuleId(normalisePosix(`${dir}/${spec}`)))
        }
    }
    return [...ids]
}

/**
 * Find test files that rebuild a production assembly. `changedTestFiles` are the
 * task's own authored/changed test files (path + text); `productionFiles` are the
 * repo's non-test source files (path + text) used to build the import graph and the
 * per-leaf production in-degree. Returns one finding per re-assembling test, sorted
 * for determinism. Empty when no test re-composes an E-exclusive leaf set.
 */
export function findTestRebuiltAssemblies(
    changedTestFiles: RepoFile[],
    productionFiles: RepoFile[]
): TestAssemblyFinding[] {
    // Only genuine production (non-test) files can be the bypassed assembly.
    const prod = productionFiles.filter(f => !isTestFile(f.path))
    const prodImports = new Map<string, Set<string>>()
    const inDegree = new Map<string, number>()
    for (const f of prod) {
        const imps = relativeImports(f.path, f.text)
        prodImports.set(f.path, new Set(imps))
        for (const m of imps) inDegree.set(m, (inDegree.get(m) ?? 0) + 1)
    }

    const findings: TestAssemblyFinding[] = []
    for (const t of [...changedTestFiles].sort((a, b) => a.path.localeCompare(b.path))) {
        if (!isTestFile(t.path)) continue
        const tImports = new Set(relativeImports(t.path, t.text))
        if (tImports.size < 2) continue
        let best: TestAssemblyFinding | null = null
        for (const e of [...prod].sort((a, b) => a.path.localeCompare(b.path))) {
            if (e.path === t.path) continue
            // The test imports the real assembly → it is exercising the shipped wiring,
            // not a copy. Good citizen, never flagged.
            if (tImports.has(moduleIdOf(e.path))) continue
            const eImports = prodImports.get(e.path)!
            // Leaves E is the SOLE production composer of, that this test re-imports.
            const leaves = [...tImports].filter(m => eImports.has(m) && inDegree.get(m) === 1)
            if (leaves.length >= 2 && (best === null || leaves.length > best.leaves.length)) {
                best = {testFile: t.path, assemblyFile: e.path, leaves: leaves.sort()}
            }
        }
        if (best) findings.push(best)
    }
    return findings
}

/**
 * Render findings as verify-child prompt lines (probe+rule pattern — the concrete
 * finding that makes the rule fire reliably). One line per re-assembling test naming
 * the test, the shipped assembly it bypasses, and the re-composed leaves. Empty
 * findings → empty array (caller emits no block).
 */
export function testAssemblyVerifyFindings(findings: TestAssemblyFinding[]): string[] {
    return findings.map(
        f =>
            `${f.testFile} imports and re-composes ${f.leaves.length} leaf module(s) `
            + `(${f.leaves.join(', ')}) that ${f.assemblyFile} is the ONLY production file to `
            + `compose, yet it never imports ${f.assemblyFile} — it builds its OWN assembly of `
            + `those leaves instead of exercising the shipped one`
    )
}
