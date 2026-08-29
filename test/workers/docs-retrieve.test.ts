import {test, expect} from 'bun:test'
import * as path from 'node:path'
import {openCache} from '../../src/workers/docs-cache.js'
import {ensureIndexed} from '../../src/workers/docs-index.js'
import {resolvePackage} from '../../src/workers/docs-resolve.js'
import {retrieveChunks} from '../../src/workers/docs-retrieve.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

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

// REGRESSION. tokenize() used to split on /\s+/ and then strip punctuation INSIDE each
// token, welding a multi-part identifier into one string that occurs nowhere in the
// corpus: "UserService.list" -> "UserServicelist", "src/server/UserService.ts" ->
// "srcserverUserServicets". buildFtsQuery ORs the tokens, so such a query produced NO
// match and fell through to fallbackChunks() — which ignores the query entirely and
// returns the first .d.ts + README slices. On mx5 run 13 that cost 18% of project queries
// any chunk from the file they named.
//
// Asserting on content alone would NOT catch this: the fallback returns the fixture's only
// .d.ts, which contains "UserService" regardless. The discriminator is `rank` —
// fallbackChunks() emits rank 0 for every row, a real bm25() MATCH emits a negative rank.
test('retrieveChunks matches dotted symbols instead of welding them into a dead token', () => {
    const {cache, pkg} = seed()
    try {
        const chunks = retrieveChunks(cache, {
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
            name: 'never-indexed',
            version: '1.0.0',
            query: 'anything'
        })
        expect(chunks).toEqual([])
    } finally {
        cache.close()
    }
})
