import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    isSkippedDir,
    isSkippedFile,
    shippedSources,
    stripCommentLines,
    MAX_SCAN_FILES,
    MAX_FILE_BYTES,
    SOURCE_HTML_RE,
    SOURCE_JS_RE
} from './shipped-source.js'
import {TASKS_DIR_NAME} from './task-types.js'

/**
 * These assert the INPUT every run-level closure scan reads.
 *
 * They could not be written before: the walk lived twice as a private
 * `scanCandidates`, and the only door to either was a whole scan over a real
 * tree. `artifact-closure.test.ts` has 28 references to the pure extractors and 5
 * calls to the driver — and no test in the cluster asserted a skip set at all,
 * which is how `bench`/`benchmarks` came to be skipped by one copy and scanned by
 * the other.
 */

function tree(spec: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipped-src-'))
    for (const [rel, body] of Object.entries(spec)) {
        const full = path.join(dir, rel)
        fs.mkdirSync(path.dirname(full), {recursive: true})
        fs.writeFileSync(full, body, 'utf8')
    }
    return dir
}

const JS = {ext: SOURCE_JS_RE}

describe('isSkippedDir', () => {
    test('skips VCS, dep, build, test, doc and bench trees', () => {
        for (const d of [
            '.git',
            'node_modules',
            'dist',
            'build',
            'out',
            'coverage',
            'target',
            'vendor',
            'test',
            'tests',
            '__tests__',
            '__mocks__',
            '__fixtures__',
            'fixtures',
            'e2e',
            'examples',
            'docs',
            'bench',
            'benchmarks'
        ]) {
            expect(isSkippedDir(d)).toBe(true)
        }
    })

    test('skips every dot-directory, not just the named ones', () => {
        expect(isSkippedDir('.next')).toBe(true)
        expect(isSkippedDir('.svelte-kit')).toBe(true)
    })

    // Hardcoding it was part of a five-site literal with no compile link.
    test('the tasks dir is derived from TASKS_DIR_NAME, not retyped', () => {
        expect(isSkippedDir(TASKS_DIR_NAME)).toBe(true)
    })

    test('does not skip ordinary source trees', () => {
        for (const d of ['src', 'app', 'lib', 'server', 'routes', 'components']) {
            expect(isSkippedDir(d)).toBe(false)
        }
    })
})

describe('isSkippedFile', () => {
    test('skips test/spec/stories/bench files and ambient declarations', () => {
        for (const f of [
            'a.test.ts',
            'a.spec.js',
            'Button.stories.tsx',
            'parse.bench.ts',
            'globals.d.ts',
            'globals.d.mts',
            'globals.d.cts'
        ]) {
            expect(isSkippedFile(f)).toBe(true)
        }
    })

    test('does not skip ordinary sources', () => {
        for (const f of ['index.ts', 'server.tsx', 'app.mjs', 'testing.ts', 'latest.ts']) {
            expect(isSkippedFile(f)).toBe(false)
        }
    })
})

describe('shippedSources', () => {
    test('returns authored sources in deterministic order', () => {
        const dir = tree({
            'src/b.ts': '',
            'src/a.ts': '',
            'index.ts': ''
        })
        expect(shippedSources(dir, JS)).toEqual(['index.ts', 'src/a.ts', 'src/b.ts'])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    // The drift itself: one copy skipped these, the other scanned them.
    test('a bench tree and a .bench file are scanned by NO closure scan', () => {
        const dir = tree({
            'bench/hot.ts': '',
            'benchmarks/cold.ts': '',
            'src/parse.bench.ts': '',
            'src/parse.ts': ''
        })
        expect(shippedSources(dir, JS)).toEqual(['src/parse.ts'])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('the tasks dir never reaches a scanner', () => {
        const dir = tree({
            [`${TASKS_DIR_NAME}/TASK_0001.md`]: '',
            [`${TASKS_DIR_NAME}/helper.ts`]: '',
            'src/a.ts': ''
        })
        expect(shippedSources(dir, JS)).toEqual(['src/a.ts'])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('honours the extension set it is given', () => {
        const dir = tree({'index.html': '', 'app.ts': '', 'notes.md': ''})
        expect(shippedSources(dir, JS)).toEqual(['app.ts'])
        expect(shippedSources(dir, {ext: SOURCE_HTML_RE})).toEqual(['index.html'])
        const both = new RegExp(`${SOURCE_JS_RE.source}|${SOURCE_HTML_RE.source}`, 'i')
        expect(shippedSources(dir, {ext: both})).toEqual(['app.ts', 'index.html'])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('excludeRoots drops a produced tree at the ROOT only', () => {
        const dir = tree({
            'public/bundle.js': '',
            'src/public/real.ts': '',
            'src/a.ts': ''
        })
        const roots = new Set(['public'])
        expect(shippedSources(dir, {ext: SOURCE_JS_RE, excludeRoots: roots})).toEqual([
            'src/a.ts',
            'src/public/real.ts'
        ])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('skips a file over the per-file byte cap', () => {
        const dir = tree({'big.ts': 'x'.repeat(MAX_FILE_BYTES + 1), 'small.ts': 'x'})
        expect(shippedSources(dir, JS)).toEqual(['small.ts'])
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('honours the file-count cap', () => {
        const spec: Record<string, string> = {}
        for (let i = 0; i < MAX_SCAN_FILES + 25; i++) {
            spec[`src/f${String(i).padStart(5, '0')}.ts`] = ''
        }
        const dir = tree(spec)
        expect(shippedSources(dir, JS)).toHaveLength(MAX_SCAN_FILES)
        fs.rmSync(dir, {recursive: true, force: true})
    })

    test('an unreadable tree yields nothing rather than throwing', () => {
        expect(shippedSources(path.join(os.tmpdir(), 'no-such-dir-xyz'), JS)).toEqual([])
    })
})

describe('stripCommentLines', () => {
    test('drops whole-line comments and keeps inline ones', () => {
        const src = [
            '// Bun.serve({port: 3000})',
            'const url = "http://a//b"',
            ' * Bun.serve'
        ].join('\n')
        const out = stripCommentLines(src)
        expect(out).not.toContain('// Bun.serve')
        expect(out).toContain('http://a//b')
    })
})
