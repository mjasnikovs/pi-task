/**
 * `spec-urls.ts` imports nothing and issues no request: it extracts, ranks and
 * renders URLs as prompt text. These tests cover that text. Whether a worker
 * then fetches a page is not observable from here.
 */
import {test, expect, describe} from 'bun:test'
import {
    extractSpecUrls,
    packageTokens,
    urlDocumentsPackage,
    rankSpecUrls,
    buildSpecUrlBlock,
    mentionedPackages,
    MAX_SPEC_URLS
} from '../../src/task/spec-urls.js'

/** A design-shaped reference list: documentation URLs for the packages below. */
const DESIGN_URLS = [
    'https://bun.com/docs/api/file-io',
    'https://bun.com/docs/api/hashing',
    'https://bun.com/docs/bundler',
    'https://bun.com/docs/cli/test',
    'https://bun.com/docs/runtime/sql',
    'https://github.com/honojs/middleware/tree/main/packages/zod-validator',
    'https://github.com/molefrog/wouter#readme',
    'https://hono.dev/docs/',
    'https://hono.dev/docs/guides/best-practices',
    'https://hono.dev/docs/guides/rpc',
    'https://hono.dev/docs/guides/testing',
    'https://hono.dev/examples/grouping-routes-rpc',
    'https://playwright.dev/docs/test-components',
    'https://playwright.dev/docs/test-snapshots',
    'https://react.dev/reference/react',
    'https://sharp.pixelplumbing.com/api-operation/',
    'https://tailwindcss.com/docs/installation',
    'https://tailwindcss.com/docs/installation/tailwind-cli',
    'https://ui.shadcn.com/docs',
    'https://ui.shadcn.com/docs/tailwind-v4',
    'https://zod.dev/'
]

/** A dependency list in manifest order — rankSpecUrls treats earlier as higher. */
const MX5_MANIFEST = [
    '@radix-ui/react-dialog',
    '@radix-ui/react-select',
    '@hono/zod-validator',
    'better-sqlite3',
    'hono',
    'pg',
    'react',
    'react-dom',
    'sharp',
    'wouter',
    '@tailwindcss/cli',
    'eslint',
    'prettier',
    'tailwindcss',
    'typescript'
]

describe('extractSpecUrls', () => {
    test('pulls every cited URL out of a design-shaped reference list', () => {
        const text = `§13 References\n- RPC: https://hono.dev/docs/guides/rpc\n- SQL: https://bun.com/docs/runtime/sql\n`
        expect(extractSpecUrls(text)).toEqual([
            'https://hono.dev/docs/guides/rpc',
            'https://bun.com/docs/runtime/sql'
        ])
    })

    test('drops the trailing sentence period but keeps a #fragment', () => {
        // The `#fragment` is part of the citation: strip it and the block names the
        // whole page instead of the anchor that was cited.
        const got = extractSpecUrls('see https://github.com/molefrog/wouter#readme.')
        expect(got).toEqual(['https://github.com/molefrog/wouter#readme'])
    })

    test('drops localhost and placeholder hosts — a dev URL is not documentation', () => {
        // A localhost URL in a task is the run's own dev server, not a page to read.
        const text =
            'curl http://localhost:3000/api/auth/login and http://127.0.0.1:3911/admin '
            + 'and https://example.com/thing and https://hono.dev/docs/guides/rpc'
        expect(extractSpecUrls(text)).toEqual(['https://hono.dev/docs/guides/rpc'])
    })

    test('dedupes — hono.dev/docs/guides/rpc is cited twice in the real design', () => {
        const text = 'https://hono.dev/docs/guides/rpc … again https://hono.dev/docs/guides/rpc'
        expect(extractSpecUrls(text)).toHaveLength(1)
    })
})

describe('packageTokens', () => {
    test('splits scopes, subpaths and hyphens', () => {
        expect(packageTokens('hono/client').sort()).toEqual(['client', 'hono'])
        expect(packageTokens('@hono/zod-validator').sort()).toEqual([
            'hono',
            'validator',
            'zod',
            'zod-validator'
        ])
    })

    test('never associates project source', () => {
        expect(packageTokens('.')).toEqual([])
    })

    test('drops segments of two characters or fewer', () => {
        expect(packageTokens('pg')).toEqual([])
    })

    test('keeps three-letter names — `zod` has a real cited page and must not be dropped', () => {
        expect(packageTokens('zod')).toEqual(['zod'])
        expect(urlDocumentsPackage('https://zod.dev/', 'zod')).toBe(true)
    })
})

describe('urlDocumentsPackage', () => {
    test('matches on the host: hono.dev documents hono', () => {
        expect(urlDocumentsPackage('https://hono.dev/docs/guides/rpc', 'hono')).toBe(true)
        expect(urlDocumentsPackage('https://bun.com/docs/runtime/sql', 'hono')).toBe(false)
    })

    test('matches on the PATH too — the two associations a host-only rule loses', () => {
        expect(urlDocumentsPackage('https://github.com/molefrog/wouter#readme', 'wouter')).toBe(
            true
        )
        expect(
            urlDocumentsPackage(
                'https://github.com/honojs/middleware/tree/main/packages/zod-validator',
                '@hono/zod-validator'
            )
        ).toBe(true)
    })

    test('a malformed URL is not associated with anything rather than throwing', () => {
        expect(urlDocumentsPackage('not a url', 'hono')).toBe(false)
    })
})

describe('rankSpecUrls', () => {
    test('keeps only URLs documenting a supplied package', () => {
        const ranked = rankSpecUrls(DESIGN_URLS, ['wouter'])
        expect(ranked.map(r => r.url)).toEqual(['https://github.com/molefrog/wouter#readme'])
    })

    test('earlier packages outrank later ones', () => {
        const ranked = rankSpecUrls(DESIGN_URLS, ['react', 'hono'])
        expect(ranked[0].url).toBe('https://react.dev/reference/react')
        expect(ranked.some(r => r.url === 'https://hono.dev/docs/guides/rpc')).toBe(true)
        const reversed = rankSpecUrls(DESIGN_URLS, ['hono', 'react'])
        expect(reversed[0].url.startsWith('https://hono.dev/')).toBe(true)
    })

    test(`caps the list at ${MAX_SPEC_URLS} — the whole reference list is prefill, not help`, () => {
        expect(rankSpecUrls(DESIGN_URLS, MX5_MANIFEST).length).toBeLessThanOrEqual(MAX_SPEC_URLS)
    })

    test('a package the design cites nothing for contributes nothing', () => {
        expect(rankSpecUrls(DESIGN_URLS, ['better-sqlite3'])).toEqual([])
    })
})

describe('mentionedPackages', () => {
    test('finds the package the task is actually about', () => {
        const refined =
            'Create `src/client/api.ts` — instantiate a typed Hono RPC client via `hc<AppType>` '
            + 'importing from `hono/client`.'
        expect(mentionedPackages(refined, MX5_MANIFEST)).toContain('hono')
    })

    test('word-boundary matched: `react` in `react-dom` is not a mention of `react`', () => {
        expect(mentionedPackages('uses react-dom only', ['react'])).toEqual([])
        expect(mentionedPackages('uses react-dom only', ['react-dom'])).toEqual(['react-dom'])
    })

    test('a package absent from the task text is not returned', () => {
        expect(mentionedPackages('a task about the router', MX5_MANIFEST)).not.toContain('sharp')
    })
})

describe('buildSpecUrlBlock', () => {
    const TASK_27_PKGS = ['hono', 'react']
    const TASK_28_PKGS = ['wouter', 'react']

    test('TASK_0027: names the page that would have prevented the fatal bug', () => {
        const block = buildSpecUrlBlock(DESIGN_URLS, TASK_27_PKGS)
        expect(block).toContain('https://hono.dev/docs/guides/rpc')
        expect(block).toContain('SPEC-CITED DOCUMENTATION')
    })

    test('TASK_0028: a different library and different pages — not a single-case fit', () => {
        const block = buildSpecUrlBlock(DESIGN_URLS, TASK_28_PKGS)
        expect(block).toContain('https://github.com/molefrog/wouter#readme')
        expect(block).toContain('https://react.dev/reference/react')
        // A task about the router must not be handed the image-processing reference.
        expect(block).not.toContain('sharp.pixelplumbing.com')
    })

    test('says in terms that the list is NOT exclusive — PROMPT 4 invariant 3', () => {
        // Ranking cited pages first must not read as "only these pages". The block
        // says so in words the worker sees.
        const block = buildSpecUrlBlock(DESIGN_URLS, TASK_27_PKGS)
        expect(block).toMatch(/NOT AN ALLOW-LIST/)
        expect(block).toMatch(/pi-worker-search/)
    })

    test('empty when the design cites nothing for anything this task uses', () => {
        expect(buildSpecUrlBlock(DESIGN_URLS, ['better-sqlite3'])).toBe('')
        expect(buildSpecUrlBlock([], TASK_27_PKGS)).toBe('')
        expect(buildSpecUrlBlock(DESIGN_URLS, [])).toBe('')
    })

    test('the A/B baseline surgery target is reachable: a non-empty input yields a block', () => {
        expect(
            buildSpecUrlBlock(['https://hono.dev/docs/guides/rpc'], ['hono']).length
        ).toBeGreaterThan(0)
    })
})
