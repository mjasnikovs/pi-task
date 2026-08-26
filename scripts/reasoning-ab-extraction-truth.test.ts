/**
 * The extraction group's stimulus source, tested without a corpus and without a
 * GPU.
 *
 * `extractionStimuli` itself needs an installed package tree to index, so what
 * is pinned here is the part that decides WHICH queries exist — the cache-key
 * parse. A wrong parse does not fail loudly: it silently yields fewer stimuli,
 * or a package name with the question glued onto it, and the run measures
 * whatever survived.
 */
import {describe, expect, test} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {recordedDocsQueries} from './reasoning-ab-extraction-truth.js'

const NUL = String.fromCharCode(0)

function cacheFile(entries: Record<string, unknown>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-truth-'))
    const file = path.join(dir, 'research-cache.json')
    fs.writeFileSync(file, JSON.stringify({runId: 'x', entries}))
    return file
}

describe('recordedDocsQueries', () => {
    test('splits the key into package and question', () => {
        const f = cacheFile({[`pi-worker-docs${NUL}zod::main exports: z object`]: {text: 'a'}})
        expect(recordedDocsQueries(f)).toEqual([{pkg: 'zod', query: 'main exports: z object'}])
    })

    test('a package name containing a slash survives', () => {
        // `hono/cookie` and `react-dom/client` are both really in the corpus.
        const f = cacheFile({[`pi-worker-docs${NUL}hono/cookie::getCookie signature`]: {}})
        expect(recordedDocsQueries(f)).toEqual([
            {pkg: 'hono/cookie', query: 'getCookie signature'}
        ])
    })

    test('a question containing :: does not move the split', () => {
        // The FIRST `::` is the separator; a later one belongs to the question.
        const f = cacheFile({[`pi-worker-docs${NUL}bun::Bun::spawn stdio`]: {}})
        expect(recordedDocsQueries(f)).toEqual([{pkg: 'bun', query: 'Bun::spawn stdio'}])
    })

    test('fetch and search entries are not docs queries', () => {
        // The same cache holds 36 fetch and 6 search entries. Taking those would
        // hand the docs prompt builder a URL as a package name.
        const f = cacheFile({
            [`pi-worker-docs${NUL}zod::a`]: {},
            [`pi-worker-fetch${NUL}https://example.com::b`]: {},
            [`pi-worker-search${NUL}how to c::c`]: {}
        })
        expect(recordedDocsQueries(f).map(q => q.pkg)).toEqual(['zod'])
    })

    test('the same pair asked twice is one stimulus', () => {
        // Keys are unique in the file, so the dedup guards the case where two
        // tools write the same pair — counting it twice would weight it twice
        // inside an arm.
        const f = cacheFile({
            [`pi-worker-docs${NUL}zod::a`]: {},
            [`pi-worker-docs${NUL}hono::a`]: {}
        })
        expect(recordedDocsQueries(f)).toHaveLength(2)
    })

    test('a key with no :: is skipped rather than guessed at', () => {
        const f = cacheFile({[`pi-worker-docs${NUL}zod`]: {}, [`pi-worker-docs${NUL}hono::a`]: {}})
        expect(recordedDocsQueries(f).map(q => q.pkg)).toEqual(['hono'])
    })

    test('an empty package or question is skipped', () => {
        const f = cacheFile({
            [`pi-worker-docs${NUL}::a`]: {},
            [`pi-worker-docs${NUL}zod::`]: {},
            [`pi-worker-docs${NUL}hono::a`]: {}
        })
        expect(recordedDocsQueries(f).map(q => q.pkg)).toEqual(['hono'])
    })

    test('a cache with no entries key reads as empty, not as a crash', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-truth-'))
        const file = path.join(dir, 'c.json')
        fs.writeFileSync(file, JSON.stringify({runId: 'x'}))
        expect(recordedDocsQueries(file)).toEqual([])
    })
})
