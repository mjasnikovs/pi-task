import {createRequire} from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// The synchronous SQLite surface this module uses, and the whole of it. Both
// backends satisfy it as written: bun:sqlite's `Database` and node:sqlite's
// `DatabaseSync` return the same shapes from get/all/run over the schema below,
// FTS5 triggers and CHECK constraints included.
export interface SyncStatement {
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
    run(...args: unknown[]): unknown
}

export interface SyncDb {
    exec(sql: string): void
    prepare(sql: string): SyncStatement
    close(): void
}

export interface CacheHandle {
    db: SyncDb
    close(): void
}

const SCHEMA_SQL = `
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

const req = createRequire(import.meta.url)

// Branch on the RUNTIME, not on a try/catch: each builtin exists in exactly one
// of them. Requiring `bun:sqlite` under node throws MODULE_NOT_FOUND, and
// `node:sqlite` under bun throws ERR_UNKNOWN_BUILTIN_MODULE. `createRequire`
// keeps both specifiers out of the static import graph, so neither bundler nor
// type-checker has to resolve the one that is absent.
function openDb(dbPath: string): SyncDb {
    if (typeof (globalThis as Record<string, unknown>).Bun !== 'undefined') {
        const {Database} = req('bun:sqlite') as typeof import('bun:sqlite')
        return new Database(dbPath) as unknown as SyncDb
    }
    const {DatabaseSync} = req('node:sqlite') as typeof import('node:sqlite')
    return new DatabaseSync(dbPath) as unknown as SyncDb
}

export function defaultCachePath(): string {
    const base = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache')
    return path.join(base, 'pi-worker', 'docs.sqlite')
}

export function openCache(dbPath?: string): CacheHandle {
    const resolved = dbPath ?? defaultCachePath()
    if (resolved !== ':memory:') {
        fs.mkdirSync(path.dirname(resolved), {recursive: true})
    }
    const db = openDb(resolved)
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec(SCHEMA_SQL)
    return {
        db,
        close: () => db.close()
    }
}
