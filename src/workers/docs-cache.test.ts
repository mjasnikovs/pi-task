import {test, expect} from 'bun:test'
import {openCache, defaultCachePath} from './docs-cache.js'

test('openCache(":memory:") creates an in-memory DB with bootstrapped schema', () => {
    const cache = openCache(':memory:')
    try {
        const tables = cache.db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name"
            )
            .all() as {name: string}[]
        const names = tables.map(t => t.name)
        expect(names).toContain('packages')
        expect(names).toContain('chunks')
        expect(names).toContain('chunks_fts')
        expect(names).toContain('chunks_ai')
        expect(names).toContain('chunks_ad')
    } finally {
        cache.close()
    }
})

test('openCache(":memory:") is idempotent on re-open of the same path', () => {
    const cache1 = openCache(':memory:')
    expect(() => {
        cache1.close()
    }).not.toThrow()
    const cache2 = openCache(':memory:')
    cache2.close()
})

test('insert into chunks fires the FTS5 trigger', () => {
    const cache = openCache(':memory:')
    try {
        cache.db
            .prepare(
                'INSERT INTO chunks (name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?)'
            )
            .run('p', '1.0.0', 'a.d.ts', 'dts', 'hello world')
        const row = cache.db.prepare('SELECT count(*) AS c FROM chunks_fts').get() as {
            c: number
        } | null
        expect(row?.c).toBe(1)
    } finally {
        cache.close()
    }
})

test('delete from chunks fires the FTS5 delete trigger', () => {
    const cache = openCache(':memory:')
    try {
        cache.db
            .prepare(
                'INSERT INTO chunks (name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?)'
            )
            .run('p', '1.0.0', 'a.d.ts', 'dts', 'hello')
        cache.db.prepare('DELETE FROM chunks WHERE name = ?').run('p')
        const row = cache.db.prepare('SELECT count(*) AS c FROM chunks_fts').get() as {
            c: number
        } | null
        expect(row?.c).toBe(0)
    } finally {
        cache.close()
    }
})

test('defaultCachePath() ends with pi-worker/docs.sqlite', () => {
    // defaultCachePath is a real filesystem path (native separators on Windows);
    // normalize before the POSIX-style suffix check.
    const p = defaultCachePath().replace(/\\/g, '/')
    expect(p.endsWith('/pi-worker/docs.sqlite')).toBe(true)
})
