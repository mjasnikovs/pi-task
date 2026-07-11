import {test, expect} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {openCache} from './docs-cache.js'
import {ensureIndexed} from './docs-index.js'
import {resolvePackage} from './docs-resolve.js'

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
        const pkg1 = {
            name: 'mut-pkg',
            version: '1.0.0',
            root: tmpPkgRoot,
            entryDts: path.join(tmpPkgRoot, 'index.d.ts'),
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
