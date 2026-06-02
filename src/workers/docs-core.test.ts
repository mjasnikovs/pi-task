import {describe, expect, test} from 'bun:test'
import * as path from 'node:path'
import {docsRaw, docsFocused} from './docs-core.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'
import {openCache} from './docs-cache.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

describe('docsRaw', () => {
    test('returns kind: ok with chunks on a known-good package', async () => {
        const cache = openCache(':memory:')
        const r = await docsRaw({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null
        })
        expect(r.kind).toBe('ok')
        cache.close()
    })

    test('returns kind: error with resolveError invalid_name on bad name', async () => {
        const cache = openCache(':memory:')
        const r = await docsRaw({
            pkg: '../etc/passwd',
            query: 'x',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null
        })
        expect(r.kind).toBe('error')
        if (r.kind === 'error') expect(r.resolveError).toBe('invalid_name')
        cache.close()
    })

    test('returns kind: no_chunks for empty-pkg', async () => {
        const cache = openCache(':memory:')
        const r = await docsRaw({
            pkg: 'empty-pkg',
            query: 'x',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null
        })
        expect(r.kind).toBe('no_chunks')
        cache.close()
    })
})

describe('docsFocused', () => {
    test('returns answer + excerpt parsed from child stdout', async () => {
        const cache = openCache(':memory:')
        const r = await docsFocused({
            pkg: 'tiny-pkg',
            query: 'greet',
            cwd: FIXTURES,
            openCache: () => cache,
            npmVersionLookup: async () => null,
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>greet returns hi</answer>\n<excerpt>greet</excerpt>'
            }))
        })
        expect(r.answer).toBe('greet returns hi')
        expect(r.excerpt).toBe('greet')
        cache.close()
    })

    test('throws on docsRaw error (not_installed package)', async () => {
        const cache = openCache(':memory:')
        await expect(
            docsFocused({
                pkg: 'does-not-exist',
                query: 'x',
                cwd: FIXTURES,
                openCache: () => cache,
                npmVersionLookup: async () => null,
                spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 1, stderr: 'npm 404'}))
            })
        ).rejects.toThrow()
        cache.close()
    })
})
