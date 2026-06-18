import {describe, expect, test} from 'bun:test'
import {
    orientationTier,
    selectOrientationFiles,
    buildOrientation,
    ORIENTATION_PER_FILE_MAX
} from './orientation.js'

describe('orientationTier', () => {
    test('ranks manifest > config > types/schema > entrypoint > api > docs', () => {
        expect(orientationTier('package.json')).toBe(0)
        expect(orientationTier('tsconfig.json')).toBe(1)
        expect(orientationTier('vite.config.ts')).toBe(1)
        expect(orientationTier('src/types/index.ts')).toBe(2)
        expect(orientationTier('src/server/db/schema.sql')).toBe(2)
        expect(orientationTier('src/server/lib/zod-schemas.ts')).toBe(2)
        expect(orientationTier('src/index.ts')).toBe(3)
        expect(orientationTier('src/client/app.tsx')).toBe(3)
        expect(orientationTier('src/client/lib/api.ts')).toBe(4)
        expect(orientationTier('README.md')).toBe(5)
    })

    test('drops non-orientation source and unknown extensions', () => {
        expect(orientationTier('src/client/pages/Landing.tsx')).toBeNull()
        expect(orientationTier('src/server/middleware/session.ts')).toBeNull()
        expect(orientationTier('logo.png')).toBeNull()
        expect(orientationTier('styles.css')).toBeNull()
    })
})

describe('selectOrientationFiles', () => {
    test('orders by tier, then by depth, then alphabetically', () => {
        const inventory = [
            'src/client/lib/api.ts',
            'README.md',
            'src/types/index.ts',
            'package.json',
            'src/server/index.ts',
            'src/index.ts',
            'tsconfig.json',
            'src/client/pages/Landing.tsx' // dropped
        ]
        expect(selectOrientationFiles(inventory)).toEqual([
            'package.json', // tier 0
            'tsconfig.json', // tier 1
            'src/types/index.ts', // tier 2
            'src/index.ts', // tier 3, depth 1 beats depth 2
            'src/server/index.ts', // tier 3, depth 2
            'src/client/lib/api.ts', // tier 4
            'README.md' // tier 5
        ])
    })

    test('returns nothing for a repo with no orientation files', () => {
        expect(selectOrientationFiles(['a.css', 'b.png', 'notes.txt'])).toEqual([])
    })
})

describe('buildOrientation', () => {
    const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? null

    test('supplies full content of selected files and marks them do-not-re-read', async () => {
        const files = {
            'package.json': '{"name":"x"}',
            'src/types/index.ts': 'export type A = 1'
        }
        const {block, supplied} = await buildOrientation(Object.keys(files), reader(files))
        expect(supplied).toEqual(new Set(['package.json', 'src/types/index.ts']))
        expect(block).toContain('do not re-read')
        expect(block).toContain('--- package.json ---')
        expect(block).toContain('{"name":"x"}')
        expect(block).toContain('export type A = 1')
    })

    test('never exceeds the byte budget — overflow files are skipped, not truncated', async () => {
        // Three 10KB type files; budget only fits two.
        const big = 'x'.repeat(10 * 1024)
        const files = {
            'a/types.ts': big,
            'b/types.ts': big,
            'c/types.ts': big
        }
        const {block, supplied} = await buildOrientation(Object.keys(files), reader(files), {
            byteBudget: 25 * 1024,
            perFileMax: ORIENTATION_PER_FILE_MAX
        })
        expect(supplied.size).toBe(2)
        // The bound is on the *emitted* block (content + fences + wrapper), not
        // just raw content — so it holds no matter how many files are packed in.
        expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(25 * 1024)
        // The two that fit are the deterministically-ranked first two.
        expect([...supplied]).toEqual(['a/types.ts', 'b/types.ts'])
    })

    test('emitted block stays within budget even with many small files (fence overhead counts)', async () => {
        // 200 tiny files would pack the budget into noise — the block must still
        // be bounded by the byte budget, with fence/wrapper bytes included.
        const files: Record<string, string> = {}
        for (let i = 0; i < 200; i++) files[`pkg${i}/tsconfig.json`] = '{"x":1}'
        const {block} = await buildOrientation(Object.keys(files), reader(files), {
            byteBudget: 4 * 1024,
            maxFiles: 1000
        })
        expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(4 * 1024)
    })

    test('skips a single file larger than the per-file cap (worker still reads it)', async () => {
        const files = {'package.json': 'x'.repeat(20 * 1024)}
        const {block, supplied} = await buildOrientation(Object.keys(files), reader(files), {
            perFileMax: 12 * 1024
        })
        expect(supplied.size).toBe(0)
        expect(block).toBe('')
    })

    test('tolerates unreadable/missing files without failing', async () => {
        const {block, supplied} = await buildOrientation(
            ['package.json', 'tsconfig.json'],
            async () => null
        )
        expect(supplied.size).toBe(0)
        expect(block).toBe('')
    })
})
