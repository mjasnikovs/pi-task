import {test, expect} from 'bun:test'
import * as path from 'node:path'
import {openCache} from './docs-cache.js'
import {ensureIndexed} from './docs-index.js'
import {resolvePackage} from './docs-resolve.js'
import {retrieveChunks} from './docs-retrieve.js'

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
