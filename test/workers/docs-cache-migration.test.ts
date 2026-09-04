import {test, expect} from 'bun:test'
import {Database} from 'bun:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {openCache} from '../../src/workers/docs-cache.js'
import {ensureIndexed} from '../../src/workers/docs-index.js'
import {resolvePackage} from '../../src/workers/docs-resolve.js'

const FIXTURES = path.resolve(__dirname, '__fixtures__')

// The pre-ecosystem schema, copied verbatim rather than imported: the point of
// these tests is that a database written by the OLD code opens under the new.
const V0_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS packages (
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);

CREATE TABLE IF NOT EXISTS chunks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  version   TEXT NOT NULL,
  file_path TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('dts','readme')),
  content   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_pkg ON chunks(name, version);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  content='chunks',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
`

// `:memory:` cannot be reopened, and reopening is the whole scenario.
function tempDbPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-cache-mig-'))
    return path.join(dir, 'docs.sqlite')
}

function writeV0Db(file: string): void {
    const db = new Database(file)
    db.exec(V0_SCHEMA_SQL)
    db.prepare(
        'INSERT INTO packages (name, version, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
    ).run('stale-pkg', '1.0.0', 'deadbeef', 1)
    db.prepare(
        'INSERT INTO chunks (name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?)'
    ).run('stale-pkg', '1.0.0', 'index.d.ts', 'dts', 'export declare const stale: number')
    db.close()
}

test('openCache migrates a pre-ecosystem database and drops its rows', () => {
    const file = tempDbPath()
    writeV0Db(file)

    const cache = openCache(file)
    try {
        const version = cache.db.prepare('PRAGMA user_version').get() as {user_version: number}
        expect(version.user_version).toBe(1)

        const cols = cache.db.prepare('PRAGMA table_info(chunks)').all() as {name: string}[]
        expect(cols.map(c => c.name)).toContain('ecosystem')

        const rows = cache.db.prepare('SELECT count(*) AS c FROM packages').get() as {c: number}
        expect(rows.c).toBe(0)
        const chunkRows = cache.db.prepare('SELECT count(*) AS c FROM chunks').get() as {c: number}
        expect(chunkRows.c).toBe(0)
        const ftsRows = cache.db.prepare('SELECT count(*) AS c FROM chunks_fts').get() as {
            c: number
        }
        expect(ftsRows.c).toBe(0)
    } finally {
        cache.close()
    }
})

test('a migrated database re-indexes a package into the npm scope', () => {
    const file = tempDbPath()
    writeV0Db(file)

    const cache = openCache(file)
    try {
        const pkg = resolvePackage('tiny-pkg', FIXTURES)
        const result = ensureIndexed(cache, pkg)
        expect(result.hitCache).toBe(false)
        expect(result.chunksWritten).toBeGreaterThan(0)

        const row = cache.db
            .prepare("SELECT count(*) AS c FROM chunks WHERE ecosystem = 'npm' AND name = ?")
            .get(pkg.name) as {c: number}
        expect(row.c).toBe(result.chunksWritten)
    } finally {
        cache.close()
    }
})

test('a second handle on the same file finds the migration already done', () => {
    const file = tempDbPath()
    writeV0Db(file)

    const first = openCache(file)
    let second: ReturnType<typeof openCache> | undefined
    try {
        expect(() => {
            second = openCache(file)
        }).not.toThrow()
        const version = second!.db.prepare('PRAGMA user_version').get() as {user_version: number}
        expect(version.user_version).toBe(1)
    } finally {
        second?.close()
        first.close()
    }
})

test('openCache leaves an already-migrated database and its rows alone', () => {
    const file = tempDbPath()
    const first = openCache(file)
    const pkg = resolvePackage('tiny-pkg', FIXTURES)
    const written = ensureIndexed(first, pkg).chunksWritten
    first.close()

    const second = openCache(file)
    try {
        const row = second.db
            .prepare("SELECT count(*) AS c FROM chunks WHERE ecosystem = 'npm' AND name = ?")
            .get(pkg.name) as {c: number}
        expect(row.c).toBe(written)
    } finally {
        second.close()
    }
})
