import {test, expect, describe} from 'bun:test'
import {splitAtMatches, chunkDeclarations} from '../../src/workers/docs-chunk.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {openCache} from '../../src/workers/docs-cache.js'
import {ensureIndexed, chunkerFingerprint} from '../../src/workers/docs-index.js'
import {ECOSYSTEMS} from '../../src/workers/docs-ecosystems.js'
import {retrieveChunks} from '../../src/workers/docs-retrieve.js'
import {resolvePackage, type ResolvedPackage} from '../../src/workers/docs-resolve.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

test('ensureIndexed walks tiny-pkg and writes chunks for .d.ts + README', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        const result = ensureIndexed(cache, pkg)
        expect(result.hitCache).toBe(false)
        expect(result.filesIngested).toBeGreaterThanOrEqual(2) // index.d.ts + sub.d.ts + README
        expect(result.chunksWritten).toBeGreaterThan(0)
        expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/)

        const chunks = cache.db
            .prepare(
                "SELECT file_path, kind, content FROM chunks WHERE name = 'tiny-pkg' AND version = '1.0.0' ORDER BY id"
            )
            .all() as {file_path: string; kind: string; content: string}[]
        expect(chunks.length).toBe(result.chunksWritten)
        expect(chunks.some(c => c.kind === 'dts')).toBe(true)
        expect(chunks.some(c => c.kind === 'readme')).toBe(true)
        const dtsChunk = chunks.find(c => c.kind === 'dts')!
        expect(dtsChunk.content.startsWith('// ')).toBe(true)
        const readmeChunk = chunks.find(c => c.kind === 'readme')!
        expect(readmeChunk.content.startsWith('<!-- README:')).toBe(true)
    } finally {
        cache.close()
    }
})

test('ensureIndexed is idempotent on second call (cache hit)', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        ensureIndexed(cache, pkg)
        const second = ensureIndexed(cache, pkg)
        expect(second.hitCache).toBe(true)
        expect(second.filesIngested).toBe(0)
        expect(second.chunksWritten).toBe(0)
    } finally {
        cache.close()
    }
})

test('ensureIndexed re-ingests when content hash changes', () => {
    const cache = openCache(':memory:')
    const tmpPkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-index-test-'))
    try {
        fs.writeFileSync(
            path.join(tmpPkgRoot, 'package.json'),
            JSON.stringify({name: 'mut-pkg', version: '1.0.0', types: 'index.d.ts'})
        )
        fs.writeFileSync(path.join(tmpPkgRoot, 'index.d.ts'), 'export function v1(): void')
        const pkg1: ResolvedPackage = {
            name: 'mut-pkg',
            version: '1.0.0',
            root: tmpPkgRoot,
            ecosystem: 'npm',
            entry: path.join(tmpPkgRoot, 'index.d.ts'),
            readme: null
        }
        const r1 = ensureIndexed(cache, pkg1)
        expect(r1.hitCache).toBe(false)
        const hash1 = r1.contentHash

        fs.writeFileSync(path.join(tmpPkgRoot, 'index.d.ts'), 'export function v2(): void')
        const r2 = ensureIndexed(cache, pkg1)
        expect(r2.hitCache).toBe(false)
        expect(r2.contentHash).not.toBe(hash1)

        const chunks = cache.db
            .prepare("SELECT content FROM chunks WHERE name = 'mut-pkg' AND version = '1.0.0'")
            .all() as {content: string}[]
        expect(chunks.length).toBeGreaterThan(0)
        expect(chunks.some(c => c.content.includes('v1'))).toBe(false)
        expect(chunks.some(c => c.content.includes('v2'))).toBe(true)
    } finally {
        cache.close()
        fs.rmSync(tmpPkgRoot, {recursive: true, force: true})
    }
})

test('ensureIndexed chunks .d.ts on top-level declarations', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        ensureIndexed(cache, pkg)
        const chunks = cache.db
            .prepare(
                "SELECT content FROM chunks WHERE name = 'tiny-pkg' AND kind = 'dts' AND file_path = 'index.d.ts' ORDER BY id"
            )
            .all() as {content: string}[]
        expect(chunks.length).toBeGreaterThanOrEqual(4)
        const joined = chunks.map(c => c.content).join('\n')
        expect(joined).toContain('interface User')
        expect(joined).toContain('function greet')
        expect(joined).toContain('type UserKind')
        expect(joined).toContain('class UserService')
    } finally {
        cache.close()
    }
})

test('ensureIndexed chunks README on H1/H2 headings', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        ensureIndexed(cache, pkg)
        const chunks = cache.db
            .prepare(
                "SELECT content FROM chunks WHERE name = 'tiny-pkg' AND kind = 'readme' ORDER BY id"
            )
            .all() as {content: string}[]
        expect(chunks.length).toBeGreaterThanOrEqual(4)
        expect(chunks[0].content).toContain('# tiny-pkg')
        expect(chunks.some(c => c.content.includes('## Discriminated unions'))).toBe(true)
    } finally {
        cache.close()
    }
})

test('ensureIndexed handles a package with neither .d.ts nor README', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('empty-pkg', FIXTURES)
        const r = ensureIndexed(cache, pkg)
        expect(r.chunksWritten).toBe(0)
        expect(r.filesIngested).toBe(0)
        const row = cache.db
            .prepare("SELECT count(*) AS c FROM packages WHERE name = 'empty-pkg'")
            .get() as {c: number} | null
        expect(row?.c).toBe(1)
        const second = ensureIndexed(cache, pkg)
        expect(second.hitCache).toBe(true)
    } finally {
        cache.close()
    }
})

test('ensureIndexed walks nested .d.ts files (huge-pkg/lib/types.d.ts)', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('huge-pkg', FIXTURES)
        ensureIndexed(cache, pkg)
        const filePaths = (
            cache.db
                .prepare("SELECT DISTINCT file_path FROM chunks WHERE name = 'huge-pkg'")
                .all() as {file_path: string}[]
        ).map(r => r.file_path)
        expect(filePaths).toContain('index.d.ts')
        expect(filePaths).toContain('lib/types.d.ts')
    } finally {
        cache.close()
    }
})

test('a changed surface extractor re-indexes a package that has not moved', () => {
    // What is cached is the extractor's OUTPUT. Hashing only the file bytes meant
    // a build whose extractor changed kept its old chunks forever — name, version
    // and bytes all still matched — so a crate indexed before the braced-`use`
    // fix would answer with `pub use crate::runtime::;` for good.
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        const older = {...ECOSYSTEMS.npm, surface: (s: string) => `// OLDER BUILD\n${s}`}

        const first = ensureIndexed(cache, pkg, older)
        expect(first.hitCache).toBe(false)
        const second = ensureIndexed(cache, pkg, ECOSYSTEMS.npm)
        expect(second.hitCache).toBe(false)
        expect(second.chunksWritten).toBeGreaterThan(0)

        const rows = cache.db
            .prepare("SELECT content FROM chunks WHERE ecosystem = 'npm' AND name = ?")
            .all(pkg.name) as {content: string}[]
        expect(rows.some(r => r.content.includes('OLDER BUILD'))).toBe(false)

        // Same extractor twice is still a cache hit — the gate has not been widened
        // into "always re-index".
        expect(ensureIndexed(cache, pkg, ECOSYSTEMS.npm).hitCache).toBe(true)
    } finally {
        cache.close()
    }
})

test('a changed CHUNKER re-indexes too — the cache holds chunks, not surface', () => {
    // The hash surfaced the entry file but stopped there, so a fix to the split
    // regex left every already-indexed package with the chunks the broken one cut.
    const cache = openCache(':memory:')
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        const older = {...ECOSYSTEMS.npm, declSplitRe: /^export\s+function\s+/m}

        expect(ensureIndexed(cache, pkg, older).hitCache).toBe(false)
        expect(ensureIndexed(cache, pkg, ECOSYSTEMS.npm).hitCache).toBe(false)
        expect(ensureIndexed(cache, pkg, ECOSYSTEMS.npm).hitCache).toBe(true)
    } finally {
        cache.close()
    }
})

describe('one name, two registries', () => {
    // The bug this whole table exists for: `aeson`, `tokio`, `text` and `base` are
    // all real npm packages AND real Rust/Haskell ones. Live, npm's `tokio` is a
    // web scraper and npm's `aeson` loads JSON properties files — nothing to do
    // with the packages a Rust or Haskell user means.
    function sameNameIn(
        ecosystem: 'npm' | 'cargo',
        fixture: string,
        root: string
    ): ResolvedPackage {
        return {
            ecosystem,
            name: 'collides',
            version: '1.0.0',
            root,
            entry: fixture,
            readme: null
        }
    }

    test('the same name in two registries indexes to separate rows', () => {
        const cache = openCache(':memory:')
        try {
            const npmPkg = sameNameIn(
                'npm',
                path.join(FIXTURES, 'node_modules', 'tiny-pkg', 'index.d.ts'),
                path.join(FIXTURES, 'node_modules', 'tiny-pkg')
            )
            const cargoRoot = path.join(
                FIXTURES,
                'cargo-home',
                'registry',
                'src',
                'index.crates.io-0000000000000000',
                'tiny-crate-0.1.0'
            )
            const cargoPkg = sameNameIn('cargo', path.join(cargoRoot, 'src', 'lib.rs'), cargoRoot)

            expect(ensureIndexed(cache, npmPkg, ECOSYSTEMS.npm).chunksWritten).toBeGreaterThan(0)
            // Indexing the second must NOT be read as a re-index of the first.
            const second = ensureIndexed(cache, cargoPkg, ECOSYSTEMS.cargo)
            expect(second.hitCache).toBe(false)
            expect(second.chunksWritten).toBeGreaterThan(0)

            const perEcosystem = cache.db
                .prepare(
                    'SELECT ecosystem, count(*) AS n FROM chunks WHERE name = ? GROUP BY ecosystem ORDER BY ecosystem'
                )
                .all('collides') as {ecosystem: string; n: number}[]
            expect(perEcosystem.map(r => r.ecosystem)).toEqual(['cargo', 'npm'])
            expect(perEcosystem.every(r => r.n > 0)).toBe(true)

            // And retrieval only ever sees its own registry's rows.
            const fromNpm = retrieveChunks(cache, {
                ecosystem: 'npm',
                name: 'collides',
                version: '1.0.0',
                query: 'greet'
            })
            const fromCargo = retrieveChunks(cache, {
                ecosystem: 'cargo',
                name: 'collides',
                version: '1.0.0',
                query: 'greet'
            })
            expect(fromNpm.length).toBeGreaterThan(0)
            expect(fromCargo.length).toBeGreaterThan(0)
            expect(fromNpm.some(c => c.content.includes('pub fn greet'))).toBe(false)
            expect(fromCargo.some(c => c.content.includes('pub fn greet'))).toBe(true)
        } finally {
            cache.close()
        }
    })

    test('re-indexing one registry leaves the other registry untouched', () => {
        const cache = openCache(':memory:')
        try {
            const root = path.join(FIXTURES, 'node_modules', 'tiny-pkg')
            const entry = path.join(root, 'index.d.ts')
            const npmPkg = sameNameIn('npm', entry, root)
            const cargoRoot = path.join(
                FIXTURES,
                'cargo-home',
                'registry',
                'src',
                'index.crates.io-0000000000000000',
                'tiny-crate-0.1.0'
            )
            const cargoPkg = sameNameIn('cargo', path.join(cargoRoot, 'src', 'lib.rs'), cargoRoot)
            ensureIndexed(cache, npmPkg, ECOSYSTEMS.npm)
            const cargoBefore = ensureIndexed(cache, cargoPkg, ECOSYSTEMS.cargo).chunksWritten

            // Force the npm side to re-ingest; its DELETE must be registry-scoped.
            ensureIndexed(cache, npmPkg, {
                ...ECOSYSTEMS.npm,
                surface: (s: string) => `// CHANGED\n${s}`
            })

            const cargoAfter = cache.db
                .prepare("SELECT count(*) AS n FROM chunks WHERE ecosystem = 'cargo' AND name = ?")
                .get('collides') as {n: number}
            expect(cargoAfter.n).toBe(cargoBefore)
        } finally {
            cache.close()
        }
    })
})

describe('parallel ESM/CJS declarations index once', () => {
    // Live run 2026-09-05 (DOC_REGRESSINONS.md section 2). zod: 2565 chunks,
    // 1215 distinct BODIES, 1280 of them from `.d.cts`. hono ships no `.d.cts`
    // and has 704/708 distinct, which is what makes the cause unambiguous.
    // The cost is the top-8 retrieval budget: a package indexed twice can spend
    // two of its eight slots on the same text.
    // Bodies, not rows — the chunker prepends a `// <path>` header, so counting
    // distinct `content` finds no duplication at all.
    function bodiesOf(cache: ReturnType<typeof openCache>, pkg: ResolvedPackage): string[] {
        const rows = cache.db
            .prepare('SELECT content FROM chunks WHERE ecosystem = ? AND name = ? AND version = ?')
            .all('npm', pkg.name, pkg.version) as Array<{content: string}>
        return rows.map(r => r.content.replace(/^\/\/ .*\n/, ''))
    }

    test('a package shipping index.d.ts AND index.d.cts writes each declaration once', () => {
        const cache = openCache(':memory:')
        try {
            const pkg = resolvePackage('dual-decl-pkg', FIXTURES)
            ensureIndexed(cache, pkg)
            const bodies = bodiesOf(cache, pkg)
            expect(bodies.length).toBe(new Set(bodies).size)
            expect(bodies.join('\n')).toContain('parseUnique')
        } finally {
            cache.close()
        }
    })

    test('a package shipping ONLY .d.cts still indexes', () => {
        const cache = openCache(':memory:')
        try {
            const pkg = resolvePackage('cts-only-pkg', FIXTURES)
            const result = ensureIndexed(cache, pkg)
            expect(result.chunksWritten).toBeGreaterThan(0)
            expect(bodiesOf(cache, pkg).join('\n')).toContain('onlyCommonJs')
        } finally {
            cache.close()
        }
    })
})

describe('a back-compat major directory is not indexed', () => {
    // Live run 2026-09-05 (DOC_REGRESSINONS.md section 1). zod@4.5.4 ships a
    // `v3/` directory for back-compat and 414 of its 2565 chunks came from it.
    // BM25 cannot tell them apart — same identifiers, same package, and the path
    // is not a ranking signal. An answer shipped v3's
    // `email(message?): ZodString` under a `Per zod@4.5.4:` header, dropping the
    // `@deprecated Use z.email() instead` line directly above the real one.
    test('chunks come from the current major only', () => {
        const cache = openCache(':memory:')
        try {
            const pkg = resolvePackage('oldmajor-pkg', FIXTURES)
            ensureIndexed(cache, pkg)
            const rows = cache.db
                .prepare('SELECT file_path, content FROM chunks WHERE name = ?')
                .all(pkg.name) as Array<{file_path: string; content: string}>
            expect(rows.length).toBeGreaterThan(0)
            expect(rows.filter(r => r.file_path.startsWith('v3/'))).toEqual([])
            const joined = rows.map(r => r.content).join('\n')
            expect(joined).toContain('CheckEmailParams')
            expect(joined).not.toContain('ErrMessage')
        } finally {
            cache.close()
        }
    })

    test('a package whose whole surface lives under vN keeps it', () => {
        const cache = openCache(':memory:')
        try {
            const pkg = resolvePackage('vdir-only-pkg', FIXTURES)
            ensureIndexed(cache, pkg)
            const rows = cache.db
                .prepare('SELECT content FROM chunks WHERE name = ?')
                .all(pkg.name) as Array<{content: string}>
            expect(rows.map(r => r.content).join('\n')).toContain('onlyUnderV1')
        } finally {
            cache.close()
        }
    })
})

test('the content hash covers the CHUNKER, not just the split regex', () => {
    // The attribute-orphaning bug lived in splitAtMatches. Fixing it changed
    // every cargo package's rows and moved no profile regex, so the fingerprint
    // would have said "unchanged" and every cached package would have kept its
    // dangling `#[cfg(...)]` chunks.
    const fp = chunkerFingerprint()
    expect(fp).toContain(String(splitAtMatches))
    expect(fp).toContain(String(chunkDeclarations))
})
