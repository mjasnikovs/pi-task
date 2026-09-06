import {test, expect, describe} from 'bun:test'
import {
    chunkDeclarations,
    chunkReadme,
    splitAtMatches,
    sliceBytes,
    DECL_SPLIT_RE,
    MAX_CHUNK_BYTES
} from '../../src/workers/docs-chunk.js'
import {CARGO_DECL_SPLIT_RE} from '../../src/workers/eco-cargo.js'

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

    test('a match is never cut in half by a later match INSIDE it', () => {
        // `export\nfunction a` is one declaration whose match spans the newline.
        // Advancing by one re-finds `function` at the next line start; cutting
        // there splits the modifier off the thing it modifies.
        const parts = splitAtMatches('export\nfunction a() {}\n', decl())
        expect(parts.length).toBe(1)
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

describe('an attribute stays with the declaration it decorates', () => {
    // serde 1.0.229 indexed to 448 chunks over 350 distinct bodies. The worst
    // offender was `// src/core/de/value.rs\n#[cfg(any(feature = "std", feature =
    // "alloc"))]` — a file header and a dangling attribute, no declaration, 19
    // byte-identical copies, each one a candidate for the eight-chunk retrieval
    // budget. CARGO_DECL_SPLIT_RE absorbs leading attributes precisely so this
    // cannot happen; splitAtMatches then re-matched the bare `impl` line inside
    // that match and cut between them.
    test('a repeated cargo attribute does not become its own chunk', () => {
        const src = [
            '#[cfg(any(feature = "std", feature = "alloc"))]',
            'impl<E> Foo for Bar<E> {',
            '    fn one(&self) {}',
            '}',
            '#[cfg(any(feature = "std", feature = "alloc"))]',
            'impl<E> Foo for Baz<E> {',
            '    fn two(&self) {}',
            '}'
        ].join('\n')
        const chunks = chunkDeclarations(src, 'src/x.rs', CARGO_DECL_SPLIT_RE, '//')
        expect(chunks.length).toBe(2)
        expect(new Set(chunks).size).toBe(2)
        expect(chunks[0]).toContain('#[cfg(any(feature = "std", feature = "alloc"))]')
        expect(chunks[0]).toContain('impl<E> Foo for Bar<E>')
        expect(chunks[1]).toContain('impl<E> Foo for Baz<E>')
    })
})

// Defect 21. `DECL_SPLIT_RE` alternated `export` WITH `declare` rather than
// allowing both, so `export declare function` — the shape `tsc --declaration`
// emits for a module — never started a chunk. 6,935 such lines in a 4,000-file
// sample, 3,479 of them functions, every one glued into the chunk above it.
describe('a chunk starts at every declaration tsc actually emits', () => {
    const starts = (line: string): boolean => DECL_SPLIT_RE.test(line)

    test('export declare <kind> starts one', () => {
        for (const kind of [
            'function foo(): void;',
            'const x: number;',
            'class C {}',
            'interface I {}',
            'type T = string;',
            'enum E {}',
            'namespace N {}',
            'let y: string;'
        ]) {
            expect(starts(`export declare ${kind}`)).toBe(true)
        }
    })

    test('an abstract class starts one, with or without export', () => {
        expect(starts('export declare abstract class A {}')).toBe(true)
        expect(starts('declare abstract class A {}')).toBe(true)
        expect(starts('export abstract class A {}')).toBe(true)
    })

    test('the forms that already worked still do', () => {
        for (const line of [
            'export function foo(): void;',
            'declare function foo(): void;',
            'export default function f() {}',
            'export async function g(): Promise<void>;',
            'interface Bare {}',
            'declare module "x" {}'
        ]) {
            expect(starts(line)).toBe(true)
        }
    })

    test('prose and imports do not', () => {
        for (const line of [
            'import type { X } from "y";',
            ' * See the docs for more.',
            'export { a, b };',
            'export * from "./x";'
        ]) {
            expect(starts(line)).toBe(false)
        }
    })

    test('the real shape chunks at the declaration, not through it', () => {
        const src = [
            'export type RequestInfo = string | URL | Request;',
            '',
            'export declare function fetch(',
            '    input: RequestInfo,',
            '    init?: RequestInit',
            '): Promise<Response>;'
        ].join('\n')
        const chunks = [...chunkDeclarations(src, 'fetch.d.ts', DECL_SPLIT_RE, '//')]
        expect(chunks.some(c => /^(?:\/\/[^\n]*\n)?export declare function fetch\(/.test(c))).toBe(
            true
        )
    })
})
