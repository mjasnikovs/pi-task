import {test, expect, describe} from 'bun:test'
import {
    demoteUnsourcedAttributions,
    findUnsourcedAttributions,
    parseContextBlocks,
    splitBullets,
    splitBulletSpans
} from '../../src/task/context-attribution.js'

// The bullets below are kept at the length and register a worker actually emits.
// The detector has to separate a laundered claim from a legitimate one inside
// prose of this shape, so a shortened fixture would not exercise it.

const PACKAGES = [
    'hono',
    '@hono/zod-validator',
    'wouter',
    'zod',
    'sharp',
    'react',
    'react-dom',
    '@playwright/experimental-ct-react',
    'bun'
]

/** The laundering shape in one bullet: a citable fact (the pinned version) fused
 *  in one sentence with an uncitable one (what the base URL MEANS), under a
 *  shared attribution cue. The true half launders the false half. */
const FATAL =
    '- The `hono` dependency is pinned at `^4.12.31` in package.json, and the external '
    + 'context confirms `hc<AppType>` pattern with base URL `/api` for same-origin '
    + 'relative paths works correctly (per Hono RPC docs LIVE data).'

/** The EXTERNAL CONTEXT that accompanies it: an npm block and nothing else. Per
 *  the module header's taxonomy a `### npm:` block carries version numbers only,
 *  so it cannot support a claim about what a base URL means. */
const EC_NPM_ONLY = `EXTERNAL CONTEXT
### npm: hono
latest: 4.12.31
recent: 4.12.31, 4.12.30, 4.12.29`

describe('parseContextBlocks', () => {
    test('reads npm, url and service blocks', () => {
        const blocks = parseContextBlocks(
            `EXTERNAL CONTEXT
### npm: hono
latest: 4.12.31

### url: https://hono.dev/docs/guides/rpc
hc takes a base URL...

### service: neon
results...`
        )
        expect(blocks.map(b => b.kind)).toEqual(['npm', 'url', 'service'])
        expect(blocks[1].subject).toBe('https://hono.dev/docs/guides/rpc')
    })

    test('an empty header has no blocks', () => {
        expect(parseContextBlocks('')).toEqual([])
    })
})

describe('splitBullets', () => {
    test('joins hard-wrapped continuation lines into one bullet', () => {
        const bullets = splitBullets('- first bullet\n  continues here\n- second bullet')
        expect(bullets).toEqual(['first bullet continues here', 'second bullet'])
    })
})

describe('findUnsourcedAttributions — the F-1 shape', () => {
    test('FLAGS the fatal TASK_0027 bullet when only an npm block exists', () => {
        const f = findUnsourcedAttributions(FATAL, EC_NPM_ONLY, PACKAGES)
        expect(f).toHaveLength(1)
        expect(f[0].unsourced).toContain('hono')
        // The bullet carries BOTH cues ("the external context confirms" and "per Hono
        // RPC docs LIVE data"); which one is reported first is not part of the contract.
        expect(f[0].cue.toLowerCase()).toMatch(/external context confirms|live data/)
    })

    test('does NOT flag it once a real hono.dev page was actually fetched', () => {
        const ec = `${EC_NPM_ONLY}

### url: https://hono.dev/docs/guides/rpc
The hc client takes a base URL...`
        expect(findUnsourcedAttributions(FATAL, ec, PACKAGES)).toHaveLength(0)
    })

    test('a bullet with no attribution cue is never flagged, however wrong', () => {
        // The same false claim asserted WITHOUT any provenance cue. Out of scope
        // by design: this detector governs laundering, not correctness. Recorded
        // so the boundary reads as deliberate rather than an oversight.
        const noCue =
            '- Auth endpoints use sessionMiddleware + cookie-based auth — the default '
            + '`hc` base URL must be relative (e.g., `/api`) for same-origin cookie sending.'
        expect(findUnsourcedAttributions(noCue, EC_NPM_ONLY, PACKAGES)).toHaveLength(0)
    })
})

describe('findUnsourcedAttributions — legitimate bullets must NOT be flagged', () => {
    test('TASK_0012: a pure VERSION claim under an attribution is what npm blocks are for', () => {
        const b =
            '- `@hono/zod-validator` is at version `^0.9.0` in `package.json`; external '
            + 'context confirms latest is `0.9.0`.'
        expect(findUnsourcedAttributions(b, EC_NPM_ONLY, PACKAGES)).toHaveLength(0)
    })

    test('TASK_0031: a version-comparison bullet under an attribution', () => {
        const b =
            '- `@playwright/experimental-ct-react` is pinned at `^1.61.1` in devDependencies; '
            + 'the external context confirms latest is 2.0.1 for npm package but the project '
            + 'uses Playwright 1.61.1.'
        expect(findUnsourcedAttributions(b, EC_NPM_ONLY, PACKAGES)).toHaveLength(0)
    })

    // Note WHY this one passes. Not the service block — a service block is only a
    // title, URL and one-line description per result, so it cannot source usage
    // semantics (see the module header's taxonomy). It passes because it is a
    // VERSION claim carrying a single incidental semantics word ("supports"),
    // which the version-only heuristic lets through.
    test('TASK_0010: a version claim with one incidental semantics word is not flagged', () => {
        const b =
            '- Hono v4.x (project uses `^4.12.31`, live registry shows latest 4.12.31) '
            + 'supports `c.req.ip()` per the EXTERNAL CONTEXT service block documentation.'
        const ec = `${EC_NPM_ONLY}

### service: hono
c.req.ip() returns the client address`
        expect(findUnsourcedAttributions(b, ec, PACKAGES)).toHaveLength(0)
    })

    test('TASK_0007: a Bun.password bullet naming no attribution cue at all', () => {
        const b =
            '- The external context confirms `Bun.password.hash` accepts an options object '
            + 'form `{algorithm: "argon2id", memoryCost, timeCost}` but the spec pins the '
            + 'simpler two-arg form.'
        // This one DOES carry a cue and IS a semantics claim about bun with no url/service
        // block — so it is a true positive of the same class, not a false positive.
        const f = findUnsourcedAttributions(b, EC_NPM_ONLY, PACKAGES)
        expect(f).toHaveLength(1)
        expect(f[0].unsourced).toContain('bun')
    })

    test('an ordinary architectural bullet about project source is never flagged', () => {
        const b =
            '- `AppType` is exported from `src/index.ts` as `export type AppType = typeof app`, '
            + 'where `app` mounts route groups under `/api/auth` and `/api/invites`.'
        expect(findUnsourcedAttributions(b, EC_NPM_ONLY, PACKAGES)).toHaveLength(0)
    })

    test('an empty CONTEXT yields nothing', () => {
        expect(findUnsourcedAttributions('', EC_NPM_ONLY, PACKAGES)).toEqual([])
    })
})

describe('which EXTERNAL CONTEXT blocks can source a semantics claim', () => {
    // A service block named after the package is the near-miss that matters: if
    // one counted as a source, "Hono RPC client" would match the package `hono`
    // and the fatal bullet above would pass. It must not, because a service block
    // carries snippets, not semantics.
    test('a ### service block does NOT source a usage-semantics claim', () => {
        const ec = `${EC_NPM_ONLY}

### service: Hono RPC client
Query: Hono RPC client hono/client hc<AppType> typed client guide
- **RPC - Hono** — https://hono.dev/docs/guides/rpc
  The RPC feature allows sharing of API specifications.`
        const f = findUnsourcedAttributions(FATAL, ec, PACKAGES)
        expect(f).toHaveLength(1)
        expect(f[0].unsourced).toContain('hono')
    })

    test('a ### docs block DOES source it — that body is retrieved package documentation', () => {
        const ec = `${EC_NPM_ONLY}

### docs: hono
hc(baseUrl) creates a typed client rooted at the given URL...`
        expect(findUnsourcedAttributions(FATAL, ec, PACKAGES)).toHaveLength(0)
    })

    test('parseContextBlocks reads the ### docs kind external-context.ts actually emits', () => {
        expect(parseContextBlocks('### docs: hono\nbody').map(b => b.kind)).toEqual(['docs'])
    })
})

describe('splitBulletSpans', () => {
    test('reports the line range and indent of each bullet', () => {
        const spans = splitBulletSpans('intro\n  - first\n    wrapped\n- second')
        expect(spans.map(s => [s.text, s.startLine, s.endLine, s.indent])).toEqual([
            ['first wrapped', 1, 2, '  '],
            ['second', 3, 3, '']
        ])
    })
})

describe('demoteUnsourcedAttributions — the shipped gate', () => {
    test('rewrites the fatal bullet as an open question and leaves the rest byte-identical', () => {
        const context = [
            '- `AppType` is exported from `src/index.ts` as `export type AppType = typeof app`.',
            FATAL.replace(/^- /, '- '),
            '- Session cookies are HttpOnly and SameSite=Lax.'
        ].join('\n')

        const r = demoteUnsourcedAttributions(context, EC_NPM_ONLY, PACKAGES)
        expect(r.demoted).toHaveLength(1)

        const before = context.split('\n')
        const after = r.text.split('\n')
        // INVARIANT: the bullet count does not collapse — one bullet in, one bullet out.
        expect(after.filter(l => /^\s*- /.test(l))).toHaveLength(3)
        expect(after).toHaveLength(before.length)
        // The two legitimate bullets are untouched.
        expect(after[0]).toBe(before[0])
        expect(after[2]).toBe(before[2])
        // The flagged one is now an open question with its attribution stripped.
        expect(after[1]).toContain('OPEN QUESTION')
        expect(after[1]).toContain('hono')
        expect(after[1]).not.toMatch(/LIVE data/i)
        expect(after[1]).not.toMatch(/external context confirms/i)
        // The observation survives — it is demoted, not deleted.
        expect(after[1]).toContain('base URL')
    })

    test('the rewrite is idempotent — a demoted bullet is never flagged again', () => {
        const once = demoteUnsourcedAttributions(FATAL, EC_NPM_ONLY, PACKAGES)
        const twice = demoteUnsourcedAttributions(once.text, EC_NPM_ONLY, PACKAGES)
        expect(twice.demoted).toEqual([])
        expect(twice.text).toBe(once.text)
    })

    test('a hard-wrapped flagged bullet collapses to one line and keeps the neighbours', () => {
        const context =
            '- `hono` is pinned at `^4.12.31` in package.json, and the external context\n'
            + '  confirms `hc<AppType>` takes a base URL of `/api` and works correctly.\n'
            + '- unrelated bullet'
        const r = demoteUnsourcedAttributions(context, EC_NPM_ONLY, PACKAGES)
        expect(r.demoted).toHaveLength(1)
        expect(r.text.split('\n').filter(l => l.trim().length > 0)).toHaveLength(2)
        expect(r.text).toContain('- unrelated bullet')
    })

    test('an empty CONTEXT is returned untouched — a silent worker must not throw', () => {
        expect(demoteUnsourcedAttributions('', EC_NPM_ONLY, PACKAGES)).toEqual({
            text: '',
            demoted: []
        })
    })

    test('a section with nothing to flag is returned byte-identical', () => {
        const clean = '- `AppType` is exported from `src/index.ts`.\n- Two bullets, no cues.'
        expect(demoteUnsourcedAttributions(clean, EC_NPM_ONLY, PACKAGES).text).toBe(clean)
    })

    test('an empty package list disables the gate rather than guessing', () => {
        expect(demoteUnsourcedAttributions(FATAL, EC_NPM_ONLY, []).demoted).toEqual([])
    })
})
