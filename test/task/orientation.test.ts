import {describe, expect, test} from 'bun:test'
import {
    isVendored,
    orientationTier,
    parseIgnorePatterns,
    selectOrientationFiles,
    buildOrientation,
    ORIENTATION_BYTE_BUDGET,
    ORIENTATION_CITED_BYTE_BUDGET,
    ORIENTATION_PER_FILE_MAX,
    ORIENTATION_TIERS
} from '../../src/task/orientation.js'

/** The picks' paths — the ordering assertions are about which files, in what order. */
const picked = (inventory: string[], opts = {}): string[] =>
    selectOrientationFiles(inventory, opts).map(p => p.path)

describe('orientationTier', () => {
    test('ranks cited > manifest > config > guidelines > domain > entrypoint > api > docs', () => {
        expect(orientationTier('DESIGN/PROJECT.md', {cited: true})).toBe(ORIENTATION_TIERS.cited)
        expect(orientationTier('package.json')).toBe(ORIENTATION_TIERS.manifest)
        expect(orientationTier('tsconfig.json')).toBe(ORIENTATION_TIERS.config)
        expect(orientationTier('vite.config.ts')).toBe(ORIENTATION_TIERS.config)
        expect(orientationTier('bunfig.toml')).toBe(ORIENTATION_TIERS.config)
        expect(orientationTier('AGENTS.md')).toBe(ORIENTATION_TIERS.guidelines)
        expect(orientationTier('CLAUDE.md')).toBe(ORIENTATION_TIERS.guidelines)
        expect(orientationTier('src/types/index.ts')).toBe(ORIENTATION_TIERS.domain)
        expect(orientationTier('src/server/db/schema.sql')).toBe(ORIENTATION_TIERS.domain)
        expect(orientationTier('src/server/lib/zod-schemas.ts')).toBe(ORIENTATION_TIERS.domain)
        expect(orientationTier('src/index.ts')).toBe(ORIENTATION_TIERS.entrypoint)
        expect(orientationTier('src/client/app.tsx')).toBe(ORIENTATION_TIERS.entrypoint)
        expect(orientationTier('src/client/lib/api.ts')).toBe(ORIENTATION_TIERS.api)
        expect(orientationTier('README.md')).toBe(ORIENTATION_TIERS.docs)
    })

    test('drops non-orientation source and unknown extensions', () => {
        expect(orientationTier('src/client/pages/Landing.tsx')).toBeNull()
        expect(orientationTier('src/server/middleware/session.ts')).toBeNull()
        expect(orientationTier('logo.png')).toBeNull()
        expect(orientationTier('styles.css')).toBeNull()
    })

    test('a manifest is selected by NAME, whatever its extension', () => {
        // The extension filter exists to stop a rule GUESSING; these are exact names.
        expect(orientationTier('requirements.txt')).toBe(ORIENTATION_TIERS.manifest)
        expect(orientationTier('Gemfile')).toBe(ORIENTATION_TIERS.manifest)
    })

    test('a spec doc qualifies ONLY when the task cites it', () => {
        expect(orientationTier('DESIGN/PROJECT.md')).toBeNull()
        expect(orientationTier('DESIGN/PROJECT.md', {cited: true})).toBe(ORIENTATION_TIERS.cited)
    })

    test('a vendored path never qualifies, however it is named', () => {
        expect(orientationTier('node_modules/hono/package.json')).toBeNull()
        expect(orientationTier('.pi/skills/writing/SKILL.md')).toBeNull()
        expect(orientationTier('.pi/skills/writing/config.toml')).toBeNull()
        // Even a cited file, which otherwise outranks everything.
        expect(orientationTier('node_modules/x/README.md', {cited: true})).toBeNull()
    })
})

describe('isVendored', () => {
    test('the shipped registry covers dependencies, build output and agent scaffolding', () => {
        expect(isVendored('node_modules/zod/index.d.ts')).toBe(true)
        expect(isVendored('dist/index.js')).toBe(true)
        expect(isVendored('.pi/skills/x/SKILL.md')).toBe(true)
        expect(isVendored('src/index.ts')).toBe(false)
    })

    test('.gitignore patterns and the config list add to it', () => {
        const patterns = parseIgnorePatterns(
            '# comment\n\ngenerated/\n*.snap\n!kept.snap\n/only-root\n'
        )
        expect(patterns).toEqual(['generated/', '*.snap', '/only-root'])
        expect(isVendored('docs/generated/api.md', patterns)).toBe(true)
        expect(isVendored('test/x.snap', patterns)).toBe(true)
        expect(isVendored('only-root/a.ts', patterns)).toBe(true)
        expect(isVendored('nested/only-root/a.ts', patterns)).toBe(false)
        expect(isVendored('src/index.ts', patterns)).toBe(false)
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
            'AGENTS.md',
            'DESIGN/PROJECT.md',
            'src/client/pages/Landing.tsx' // dropped
        ]
        expect(picked(inventory, {cited: ['DESIGN/PROJECT.md']})).toEqual([
            'DESIGN/PROJECT.md', // cited
            'package.json', // manifest
            'tsconfig.json', // config
            'AGENTS.md', // guidelines
            'src/types/index.ts', // domain
            'src/index.ts', // entrypoint, depth 1 beats depth 2
            'src/server/index.ts', // entrypoint, depth 2
            'src/client/lib/api.ts', // api
            'README.md' // docs
        ])
    })

    test('returns nothing for a repo with no orientation files', () => {
        expect(picked(['a.css', 'b.png', 'notes.txt'])).toEqual([])
    })

    test('the exclusion patterns drop a tracked directory the registry does not know', () => {
        const inventory = ['package.json', 'fixtures/types/index.ts']
        expect(picked(inventory)).toEqual(['package.json', 'fixtures/types/index.ts'])
        expect(picked(inventory, {excludePatterns: ['fixtures/']})).toEqual(['package.json'])
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
        // buildOrientation seeds its running total with the header and trailer and
        // adds each piece's fence bytes, so the bound is on the EMITTED block, not
        // on raw content — it holds however many files are packed in.
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

    test('the cited spec doc is supplied even though it exceeds the per-file cap', async () => {
        // The failure this tier fixes: a 20KB design doc dropped by the cap that
        // exists to stop ONE incidental file eating the budget, then read by every
        // worker instead. It is still bounded — by the total budget, which it is
        // first in line for.
        const files = {
            'DESIGN/PROJECT.md': 'D'.repeat(20 * 1024),
            'package.json': '{"name":"x"}'
        }
        const {block, supplied} = await buildOrientation(Object.keys(files), reader(files), {
            cited: ['DESIGN/PROJECT.md']
        })
        expect(supplied.has('DESIGN/PROJECT.md')).toBe(true)
        expect(supplied.has('package.json')).toBe(true)
        expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(
            ORIENTATION_BYTE_BUDGET + ORIENTATION_CITED_BYTE_BUDGET
        )

        const uncited = await buildOrientation(Object.keys(files), reader(files))
        expect(uncited.supplied.has('DESIGN/PROJECT.md')).toBe(false)
    })

    test('a cited doc past its own budget is skipped, not truncated', async () => {
        const files = {'DESIGN/PROJECT.md': 'D'.repeat(64 * 1024), 'package.json': '{}'}
        const {supplied} = await buildOrientation(Object.keys(files), reader(files), {
            cited: ['DESIGN/PROJECT.md']
        })
        expect(supplied.has('DESIGN/PROJECT.md')).toBe(false)
        expect(supplied.has('package.json')).toBe(true)
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

describe('the cited purse does not starve the core', () => {
    const reader = (files: Record<string, string>) => async (p: string) => files[p] ?? null

    test('a design doc most of the core budget wide still leaves room for the manifest tiers', async () => {
        // The mx5 doc is 29KB of a 40KB core budget: charged to the shared purse it
        // bought one cited file by dropping five the workers read on every task.
        const files: Record<string, string> = {
            'DESIGN/PROJECT.md': 'D'.repeat(29 * 1024),
            'package.json': 'P'.repeat(4 * 1024),
            'tsconfig.json': 'T'.repeat(4 * 1024),
            'src/types/index.ts': 'Y'.repeat(8 * 1024),
            'src/index.ts': 'I'.repeat(8 * 1024),
            'src/client/lib/api.ts': 'A'.repeat(8 * 1024)
        }
        const {supplied} = await buildOrientation(Object.keys(files), reader(files), {
            cited: ['DESIGN/PROJECT.md']
        })
        expect([...supplied].sort()).toEqual(Object.keys(files).sort())
    })
})
