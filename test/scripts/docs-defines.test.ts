/**
 * The defining-chunk metric, pinned on the two shapes that broke its first cut:
 * a MEMBER (`issues` on a ZodError) is never a top-level head, and a name that
 * merely appears in a body is a use, not a definition.
 */
import {test, expect, describe} from 'bun:test'
import {definesSymbol, mcnemar, compare} from '../../scripts/docs-defines.js'

const chunk = (content: string): {content: string} => ({content})

describe('definesSymbol', () => {
    test('an npm chunk whose head names the symbol defines it', () => {
        expect(
            definesSymbol(
                [chunk('// dist/index.d.ts\nexport declare function safeParse(): void;')],
                'npm',
                'safeParse'
            )
        ).toBe(true)
    })

    test('a chunk that only USES the symbol does not', () => {
        // The saturated metric this one exists to replace would call this a hit.
        expect(
            definesSymbol(
                [
                    chunk(
                        '// dist/index.d.ts\nexport declare const x: ReturnType<typeof safeParse>;'
                    )
                ],
                'npm',
                'safeParse'
            )
        ).toBe(false)
    })

    test('a MEMBER counts, because two ground-truth symbols are members', () => {
        expect(
            definesSymbol(
                [
                    chunk(
                        '// dist/index.d.ts\nexport interface ZodError {\n    issues: ZodIssue[];\n}'
                    )
                ],
                'npm',
                'issues'
            )
        ).toBe(true)
        expect(
            definesSymbol(
                [
                    chunk(
                        '// dist/hono.d.ts\ninterface Context {\n    json(data: unknown, status?: number): Response;\n}'
                    )
                ],
                'npm',
                'json'
            )
        ).toBe(true)
    })

    test('cargo reads a Rust item head, through its attributes', () => {
        expect(
            definesSymbol(
                [chunk('// src/net/tcp/listener.rs\n#[derive(Debug)]\npub struct TcpListener {}')],
                'cargo',
                'TcpListener'
            )
        ).toBe(true)
        expect(
            definesSymbol(
                [chunk('// src/lib.rs\npub use tokio::net::TcpListener;')],
                'cargo',
                'TcpListener'
            )
        ).toBe(false)
    })

    test('hackage reads a signature or a data head', () => {
        expect(
            definesSymbol(
                [chunk('-- Web/Scotty.hs\nscotty :: Port -> ScottyM () -> IO ()')],
                'hackage',
                'scotty'
            )
        ).toBe(true)
        expect(
            definesSymbol(
                [chunk('-- Data/Aeson.hs\nclass FromJSON a where')],
                'hackage',
                'FromJSON'
            )
        ).toBe(true)
        expect(
            definesSymbol(
                [chunk('-- Web/Scotty.hs\n-- | Run a scotty application.')],
                'hackage',
                'scotty'
            )
        ).toBe(false)
    })

    test('the leading path comment is not the head', () => {
        // `-- Web/Scotty.hs` is the indexer's own line. Reading it as content is
        // how the package name reached ~100% document frequency (defect 22).
        expect(
            definesSymbol(
                [chunk('-- Web/Scotty/Internal/Types.hs\nnewtype ScottyT m a = ScottyT ()')],
                'hackage',
                'Types'
            )
        ).toBe(false)
    })
})

describe('mcnemar', () => {
    test('no discordant pairs is p = 1', () => {
        expect(mcnemar(0, 0)).toBe(1)
    })

    test('the defect 21 numbers reproduce', () => {
        expect(mcnemar(2, 20)).toBeCloseTo(1.211e-4, 7)
    })

    test('the retrieve-limit numbers reproduce, and are not significant', () => {
        expect(mcnemar(0, 3)).toBeCloseTo(0.25, 6)
    })

    test('it is symmetric — the caller reads the direction', () => {
        expect(mcnemar(3, 0)).toBe(mcnemar(0, 3))
    })
})

describe('compare', () => {
    const row = (symbol: string, defines: boolean) => ({
        source: 'ts.jsonl',
        module: 'zod',
        query: `about ${symbol}`,
        symbol,
        ecosystem: 'npm' as const,
        chunks: 8,
        bytes: 100,
        defines,
        mentions: true
    })

    test('pairs on (source, module, query, symbol) and reports both directions', () => {
        const out = compare(
            [row('safeParse', true), row('issues', false)],
            [row('safeParse', false), row('issues', true)]
        )
        expect(out).toContain('only-A 1')
        expect(out).toContain('only-B 1')
        expect(out).toContain('defines  A 1/2   B 1/2')
    })

    test('a row missing from the second arm is skipped, never counted as a loss', () => {
        expect(
            compare([row('safeParse', true), row('issues', true)], [row('safeParse', true)])
        ).toContain('pairs 1')
    })
})
