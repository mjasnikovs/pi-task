import {test, expect, describe} from 'bun:test'
import {
    chunkDeclarations,
    chunkReadme,
    splitAtMatches,
    sliceBytes,
    DECL_SPLIT_RE,
    MAX_CHUNK_BYTES
} from '../../src/workers/docs-chunk.js'

describe('splitAtMatches', () => {
    const decl = (): RegExp => new RegExp(DECL_SPLIT_RE.source, 'gm')

    test('a declaration keyword OPENS its chunk rather than closing the last one', () => {
        const parts = splitAtMatches('export function a() {}\nexport function b() {}\n', decl())
        expect(parts.length).toBe(2)
        expect(parts[0].startsWith('export function a')).toBe(true)
        expect(parts[1].startsWith('export function b')).toBe(true)
    })

    test('leading text before the first declaration is kept', () => {
        const parts = splitAtMatches('// header comment\nexport const x = 1\n', decl())
        expect(parts[0]).toContain('header comment')
    })

    test('text with no declaration is ONE chunk, never zero', () => {
        expect(splitAtMatches('just prose\n', decl())).toEqual(['just prose\n'])
    })

    test('empty input still yields one part', () => {
        expect(splitAtMatches('', decl())).toEqual([''])
    })

    test('a keyword nested in a longer prefix does not lose the outer declaration', () => {
        // The advance is by ONE character, not by the match length, precisely so
        // `export default async function` is not consumed past its own start.
        const parts = splitAtMatches('export default async function go() {}\n', decl())
        expect(parts.join('')).toBe('export default async function go() {}\n')
    })
})

describe('sliceBytes', () => {
    test('short input passes through whole', () => {
        expect(sliceBytes('abc', 10)).toEqual(['abc'])
    })

    test('slices are all within the cap', () => {
        for (const s of sliceBytes('x'.repeat(1000), 100)) {
            expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(100)
        }
    })

    test('slicing is lossless', () => {
        const src = 'y'.repeat(999)
        expect(sliceBytes(src, 97).join('')).toBe(src)
    })

    test('a multi-byte character is never cut in half', () => {
        // The advance measures the bytes actually CONSUMED, not the cap — a naive
        // cap-sized advance either duplicates or drops the straddling character.
        const src = '€'.repeat(100) // 3 bytes each
        const parts = sliceBytes(src, 10)
        expect(parts.join('')).toBe(src)
        for (const p of parts) expect(p).not.toContain('�')
    })
})

describe('chunkDeclarations', () => {
    test('every chunk is labelled with the file it came from', () => {
        const chunks = chunkDeclarations('export function a() {}\nexport class B {}\n', 'src/a.ts')
        expect(chunks.length).toBe(2)
        for (const c of chunks) expect(c.startsWith('// src/a.ts\n')).toBe(true)
    })

    test('the path label is used EXACTLY as given', () => {
        // It is a model-facing label, never re-joined to the filesystem. The npm
        // path normalises to POSIX before calling; the project path does not.
        expect(chunkDeclarations('export const x = 1', 'src\\win.ts')[0]).toContain(
            '// src\\win.ts'
        )
    })

    test('whitespace-only sections produce no chunk', () => {
        expect(chunkDeclarations('\n\n   \n', 'a.ts')).toEqual([])
    })

    test('a declaration larger than the cap is sliced, not dropped', () => {
        const huge = `export const big = "${'z'.repeat(MAX_CHUNK_BYTES * 2)}"`
        const chunks = chunkDeclarations(huge, 'a.ts')
        expect(chunks.length).toBeGreaterThan(1)
        for (const c of chunks) {
            expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(MAX_CHUNK_BYTES)
        }
    })
})

describe('chunkReadme', () => {
    test('one chunk per top-level section, labelled by heading', () => {
        const chunks = chunkReadme('# Install\nnpm i x\n\n## Usage\nimport x\n')
        expect(chunks.length).toBe(2)
        expect(chunks[0]).toContain('<!-- README: Install -->')
        expect(chunks[1]).toContain('<!-- README: Usage -->')
    })

    test('text before the first heading is labelled (intro)', () => {
        expect(chunkReadme('a badge line\n\n# Install\nnpm i x\n')[0]).toContain(
            '<!-- README: (intro) -->'
        )
    })

    test('deeper headings do not start a new chunk', () => {
        // Only #/## split; ### is section content.
        const chunks = chunkReadme('# API\n### method a\ntext\n### method b\ntext\n')
        expect(chunks.length).toBe(1)
    })

    test('an empty README produces nothing', () => {
        expect(chunkReadme('')).toEqual([])
        expect(chunkReadme('   \n\n')).toEqual([])
    })
})
