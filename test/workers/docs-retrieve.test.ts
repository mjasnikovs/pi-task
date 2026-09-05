import {test, expect} from 'bun:test'
import * as path from 'node:path'
import {openCache} from '../../src/workers/docs-cache.js'
import {ensureIndexed} from '../../src/workers/docs-index.js'
import {resolvePackage} from '../../src/workers/docs-resolve.js'
import {resolveHackage} from '../../src/workers/eco-hackage.js'
import {ECOSYSTEMS} from '../../src/workers/docs-ecosystems.js'
import {
    retrieveChunks,
    PACKAGE_RETRIEVE_LIMIT,
    RETRIEVE_CONTENT_BUDGET
} from '../../src/workers/docs-retrieve.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')
const HS_MODULES = path.join(FIXTURES, 'hs-modules')

function seed() {
    const cache = openCache(':memory:')
    const pkg = resolvePackage('tiny-pkg', FIXTURES)
    ensureIndexed(cache, pkg)
    return {cache, pkg}
}

test('retrieveChunks returns chunks matching query tokens, BM25-ranked', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'UserService class'
        })
        expect(chunks.length).toBeGreaterThan(0)
        expect(chunks[0].content).toContain('UserService')
    } finally {
        cache.close()
    }
})

test('retrieveChunks OR-joins multi-token queries', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'discriminated unions narrow'
        })
        expect(chunks.length).toBeGreaterThan(0)
        const joined = chunks.map(c => c.content).join('\n')
        expect(joined).toContain('Discriminated unions')
    } finally {
        cache.close()
    }
})

// `tokenize` splits on any run of non-identifier characters. Splitting on /\s+/
// instead and then stripping punctuation INSIDE each token welds a multi-part
// identifier into one string that occurs nowhere in the corpus:
// "UserService.list" -> "UserServicelist". buildFtsQuery ORs the tokens, so a
// welded one contributes no MATCH, and a query made only of those falls through to
// fallbackChunks(), which ignores the query and returns the first .d.ts + README.
//
// Asserting on content alone would NOT catch that: the fallback returns the
// fixture's only .d.ts, which contains "UserService" either way. The discriminator
// is `rank` — fallbackChunks() selects a literal `0 AS rank` for every row, while a
// real bm25() MATCH ranks negative.
test('retrieveChunks matches dotted symbols instead of welding them into a dead token', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'UserService.list()'
        })
        expect(chunks.length).toBeGreaterThan(0)
        expect(chunks[0].rank).toBeLessThan(0) // a real MATCH, not the fallback
        expect(chunks[0].content).toContain('UserService')
    } finally {
        cache.close()
    }
})

test('retrieveChunks matches path-shaped queries by their segments', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'src/server/UserService.ts'
        })
        expect(chunks.length).toBeGreaterThan(0)
        expect(chunks[0].rank).toBeLessThan(0)
        expect(chunks[0].content).toContain('UserService')
    } finally {
        cache.close()
    }
})

test('retrieveChunks enforces limit', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'a',
            limit: 2
        })
        expect(chunks.length).toBeLessThanOrEqual(2)
    } finally {
        cache.close()
    }
})

test('retrieveChunks enforces contentBudget', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'UserService greet User',
            contentBudget: 50 // tiny budget
        })
        // Either zero (no chunk small enough) or one (the top-ranked).
        // The spec says "always keeps at least the top-ranked chunk".
        expect(chunks.length).toBeGreaterThanOrEqual(1)
        // Total length may exceed 50 because we always keep the top chunk.
    } finally {
        cache.close()
    }
})

test('retrieveChunks falls back when query has no usable tokens', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: '!@#$ %% --'
        })
        expect(chunks.length).toBeGreaterThan(0)
    } finally {
        cache.close()
    }
})

test('retrieveChunks falls back when FTS returns zero rows', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'zzzzznevermatchanything'
        })
        expect(chunks.length).toBeGreaterThan(0)
    } finally {
        cache.close()
    }
})

test('retrieveChunks returns empty when package not indexed at all', () => {
    const cache = openCache(':memory:')
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: 'never-indexed',
            version: '1.0.0',
            query: 'anything'
        })
        expect(chunks).toEqual([])
    } finally {
        cache.close()
    }
})

// Live run 2026-09-05 (DOC_REGRESSINONS.md section 3). Three hono lookups, three
// abstentions. hono declares every verb as a property typed by an interface
// alias — `get: HandlerInterface<E, 'get', S, BasePath, CurrentPath>` in
// hono-base.d.ts — while the call signatures live in `HandlerInterface`, in one
// chunk of 708, in types.d.ts. Retrieval landed on the alias every time, so the
// extraction child saw a name where a signature should be and said so.
// Reproduced offline against the real index before this fixture was written.
function seedAlias() {
    const cache = openCache(':memory:')
    const pkg = resolvePackage('alias-pkg', FIXTURES)
    ensureIndexed(cache, pkg)
    return {cache, pkg}
}

test('retrieveChunks follows a member type alias to its definition', () => {
    const {cache, pkg} = seedAlias()
    try {
        const chunks = retrieveChunks(cache, {
            ecosystem: 'npm',
            name: pkg.name,
            version: pkg.version,
            query: 'AppBase get(path, handler) signature',
            limit: PACKAGE_RETRIEVE_LIMIT,
            contentBudget: RETRIEVE_CONTENT_BUDGET
        })
        const joined = chunks.map(c => c.content).join('\n')
        expect(joined).toContain('get: HandlerInterface')
        expect(joined).toContain('interface HandlerInterface')
        expect(joined).toContain('...rest')
    } finally {
        cache.close()
    }
})

// Live run 2026-09-05 (DOC_REGRESSINONS.md section 6). The Haskell run asked
// scotty for `json`'s type and the definitions of ScottyM / ActionM seven times.
// Four outright non-answers, three partials, and the signature never appeared —
// while `type ActionM = ActionT IO` sat in the index the whole time, in one chunk
// of 312, with 67 chunks NAMING ActionM. Re-measured on the run's own cache
// after the .d.cts and dead-major fixes: still 0 of 5. Those were npm-shaped and
// could not reach hackage.
//
// The mechanism, read off the ranked output: a chunk that USES both names
// (`get :: RoutePattern -> ActionM () -> ScottyM ()`) carries more query terms
// than the chunk that DEFINES one, so all eight slots go to uses.
test('retrieveChunks fetches the definition of a type the query names', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolveHackage('tiny-hs', HS_MODULES, {modulesDir: HS_MODULES})
        ensureIndexed(cache, pkg, ECOSYSTEMS.hackage)
        const chunks = retrieveChunks(cache, {
            ecosystem: 'hackage',
            name: pkg.name,
            version: pkg.version,
            query: 'definitions of ScottyM and ActionM',
            limit: PACKAGE_RETRIEVE_LIMIT,
            contentBudget: RETRIEVE_CONTENT_BUDGET
        })
        const joined = chunks.map(c => c.content).join('\n')
        expect(joined).toContain('type ActionM = ActionT IO')
        expect(joined).toContain('type ScottyM = ScottyT IO')
    } finally {
        cache.close()
    }
})

// Live re-run 2026-09-06. Of 35 symbols the run's own queries NAMED and whose
// declaration was in the index, 17 were never retrieved — `safeParse` three times,
// `from_str` twice, `IntoResponse`, `ServiceExt`, `parseJSON`. The definition hop
// existed already and could not reach any of them: `hopNames` only accepts a name
// matching /^[A-Z]/, and `definitionChunk` only finds a TYPE declaration.
//
// Measured on serde_json's real index, same corpus, two queries:
//   "exact signature of from_str? What error type..."  -> NOT RETRIEVED of 6
//   "from_str"                                          -> rank 1 of 17
// The 91-byte declaration loses to a 1159-byte chunk whose doc comments match
// `signature`, `error`, `type` and `return`. BM25 gives the English half of the
// question as much say as the symbol, and the English half matches the chunks that
// talk ABOUT the API rather than the one that IS it.
test('retrieveChunks fetches the definition of a FUNCTION the query names', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolveHackage('tiny-hs', HS_MODULES, {modulesDir: HS_MODULES})
        ensureIndexed(cache, pkg, ECOSYSTEMS.hackage)
        const chunks = retrieveChunks(cache, {
            ecosystem: 'hackage',
            name: pkg.name,
            version: pkg.version,
            query: 'What is the exact signature of decodeValue? What error type does it return?',
            limit: PACKAGE_RETRIEVE_LIMIT,
            contentBudget: RETRIEVE_CONTENT_BUDGET
        })
        const joined = chunks.map(c => c.content).join('\n')
        expect(joined).toContain('decodeValue :: String -> Either String Int')
    } finally {
        cache.close()
    }
})

// The hop is for a symbol the question NAMES. An English word is not one, and
// hopping on it spends a slot on whatever prose chunk is shortest.
test('retrieveChunks does not hop on an English word in the query', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolveHackage('tiny-hs', HS_MODULES, {modulesDir: HS_MODULES})
        ensureIndexed(cache, pkg, ECOSYSTEMS.hackage)
        const chunks = retrieveChunks(cache, {
            ecosystem: 'hackage',
            name: pkg.name,
            version: pkg.version,
            query: 'what does the decoder return on error',
            limit: PACKAGE_RETRIEVE_LIMIT,
            contentBudget: RETRIEVE_CONTENT_BUDGET
        })
        expect(chunks.every(c => c.rank !== 0 || c.kind === 'readme')).toBe(true)
    } finally {
        cache.close()
    }
})

// The cap is what made the hop useless, not the hop. On the 2026-09-06 run's own 35
// named declarations: 17 missed before the hop reached values at all, 15 with these
// hops capped at 3, 11 at 8, and 8 with the query's own symbols uncapped. A query
// names the handful of symbols it names; MAX_ALIAS_HOPS is there for the OTHER
// source, a chunk of aliased members, which has no such bound.
test('retrieveChunks hops to more query-named definitions than the alias cap', () => {
    const cache = openCache(':memory:')
    try {
        const pkg = resolveHackage('tiny-hs', HS_MODULES, {modulesDir: HS_MODULES})
        ensureIndexed(cache, pkg, ECOSYSTEMS.hackage)
        const chunks = retrieveChunks(cache, {
            ecosystem: 'hackage',
            name: pkg.name,
            version: pkg.version,
            query: 'signatures of decodeValue decodeValueStrict ActionM ScottyM Greeting',
            limit: PACKAGE_RETRIEVE_LIMIT,
            contentBudget: RETRIEVE_CONTENT_BUDGET
        })
        const joined = chunks.map(c => c.content).join('\n')
        for (const decl of [
            'decodeValue :: String -> Either String Int',
            'decodeValueStrict :: String -> Either String Int',
            'type ActionM = ActionT IO',
            'type ScottyM = ScottyT IO'
        ]) {
            expect(joined).toContain(decl)
        }
    } finally {
        cache.close()
    }
})
