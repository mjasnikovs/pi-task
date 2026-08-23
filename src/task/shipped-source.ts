/**
 * What counts as SHIPPED SOURCE — the input every run-level closure scan reads.
 *
 * `CLOSURE_SCANS` (final-gate.ts) deepened the DRIVER of these scans: the fault
 * isolation, the rank, the stage. It did not unify their INPUT, and the copies
 * had drifted.
 *
 *  - `scanCandidates` existed twice, near-byte-identical — `serve-entry.ts` and
 *    `artifact-closure.ts` — same `readdirSync().sort()` → `statSync` → recurse,
 *    same 3000-file cap, same 400 KB per-file cap, same dot-dir rule.
 *  - The skip sets had diverged: serve-entry carried `bench|benchmarks` and
 *    `*.bench.*`; artifact-closure did not, so a dangling artifact reference in a
 *    benchmark file was a run-level finding while the same file was invisible to
 *    the sibling scan. Nothing in either file acknowledged the other.
 *  - The same extension regex was declared twice under two names (`SCAN_RE`,
 *    `SCAN_JS_RE`), and `stripCommentLines` was byte-identical in both.
 *  - `.pi-tasks` was hardcoded into both skip sets rather than derived from
 *    `TASKS_DIR_NAME`.
 *
 * The locality proof is in the suites: `artifact-closure.test.ts` has 28
 * references to the pure extractors and 5 calls to the driver, and NO test in the
 * cluster asserted a skip set at all. That is the shape recorded under
 * `resolveTypeSource` — pure functions extracted for testability while the real
 * logic stayed in how they are CALLED.
 *
 * NOT unified here: `env-template-closure.ts`. It asks a different question —
 * which TRACKED files could read an env var, including `.py`/`.go`, including
 * tests — and answering it over this walk would silently change which env
 * findings a run produces. Its comment rule is not this one either: it is a
 * per-line predicate that also treats `#` as a comment opener, which it must,
 * and which would be wrong for JS/TS. Recorded as a real divergence rather than
 * harmonised; changing it is an env-policy change with its own A/B.
 */

import {readdirSync, statSync} from 'node:fs'
import * as path from 'node:path'
import {TASKS_DIR_NAME} from './task-types.js'

/**
 * Directories never scanned: VCS/dep trees, build output (bundled copies of the
 * same sources), and test/fixture/example/doc/bench trees — a test that stands up
 * a throwaway listener is not the app's launch, a doc snippet is not code, and a
 * benchmark references fixture paths freely.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
    '.git',
    'node_modules',
    TASKS_DIR_NAME,
    'dist',
    'build',
    'out',
    'coverage',
    'target',
    'vendor',
    '__pycache__',
    '.venv',
    'venv',
    'tmp',
    'test',
    'tests',
    '__tests__',
    '__mocks__',
    '__fixtures__',
    'fixtures',
    'e2e',
    'examples',
    'example',
    'docs',
    'doc',
    'bench',
    'benchmarks'
])

const SKIP_FILE_RE = /\.(?:test|spec|stories|bench)\.[a-z]+$|\.d\.[mc]?ts$/i

/** Authored JS/TS. The one declaration — it was two constants under two names. */
export const SOURCE_JS_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i

/** Markup a produced artifact can be referenced from. */
export const SOURCE_HTML_RE = /\.html?$/i

/** Bounds. A scan is a gate step, not a search: it must terminate on any tree. */
export const MAX_SCAN_FILES = 3000
export const MAX_FILE_BYTES = 400_000

/** Is this directory NAME (not path) one no closure scan descends into? */
export function isSkippedDir(name: string): boolean {
    return name.startsWith('.') || SKIP_DIRS.has(name)
}

/** Is this file NAME one no closure scan reads? */
export function isSkippedFile(name: string): boolean {
    return SKIP_FILE_RE.test(name)
}

export interface ShippedSourceOptions {
    /** Which extensions this scan reads. */
    ext: RegExp
    /**
     * Extra ROOT-LEVEL directory names to exclude. artifact-closure's own: a
     * produced output tree re-referencing its own chunks is noise, and which dirs
     * are produced is discovered per run, so it cannot live in the static set.
     */
    excludeRoots?: ReadonlySet<string>
}

/**
 * Walk `cwd` for shipped sources — bounded, deterministic order, never throws.
 *
 * Unreadable directories and unstattable entries are skipped rather than fatal:
 * a closure scan runs against whatever tree the implementation left behind.
 */
export function shippedSources(cwd: string, opts: ShippedSourceOptions): string[] {
    const out: string[] = []
    const walk = (rel: string): void => {
        if (out.length >= MAX_SCAN_FILES) return
        let entries: string[]
        try {
            entries = readdirSync(path.join(cwd, rel)).sort()
        } catch {
            return
        }
        for (const name of entries) {
            if (out.length >= MAX_SCAN_FILES) return
            const relPath = rel === '' ? name : `${rel}/${name}`
            let st
            try {
                st = statSync(path.join(cwd, relPath))
            } catch {
                continue
            }
            if (st.isDirectory()) {
                if (isSkippedDir(name)) continue
                if (rel === '' && opts.excludeRoots?.has(name)) continue
                walk(relPath)
            } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
                if (isSkippedFile(name)) continue
                if (opts.ext.test(name)) out.push(relPath)
            }
        }
    }
    walk('')
    return out
}

/**
 * Strip comment-only lines. A `Bun.serve` quoted in a comment is not a bind, a
 * commented-out catch-all is not a route, and a path in a comment is not a
 * runtime read. Inline comments are left alone — strings may contain `//`.
 */
export function stripCommentLines(src: string): string {
    return src
        .split('\n')
        .filter(l => !/^\s*(?:\/\/|\*|\/\*)/.test(l))
        .join('\n')
}
