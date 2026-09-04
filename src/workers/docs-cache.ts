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

/**
 * Bump whenever the shape below changes in a way old rows cannot satisfy. The
 * migration is a DROP and rebuild: this is a derived cache of package sources,
 * so re-indexing costs a walk, and hand-written ALTERs cost a defect class.
 */
const SCHEMA_VERSION = 1

/**
 * `ecosystem` scopes every row to the registry it came from, so `text` on npm and
 * `text` on Hackage are different packages. Project-source rows use their own
 * scope value rather than a registry id.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS packages (
  ecosystem    TEXT NOT NULL DEFAULT 'npm',
  name         TEXT NOT NULL,
  version      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at   INTEGER NOT NULL,
  PRIMARY KEY (ecosystem, name, version)
);

CREATE TABLE IF NOT EXISTS chunks (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ecosystem TEXT NOT NULL DEFAULT 'npm',
  name      TEXT NOT NULL,
  version   TEXT NOT NULL,
  file_path TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('dts','readme')),
  content   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_pkg ON chunks(ecosystem, name, version);

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

// Order matters: the triggers and the FTS index reference `chunks`.
const DROP_SQL = `
DROP TRIGGER IF EXISTS chunks_ai;
DROP TRIGGER IF EXISTS chunks_ad;
DROP TABLE IF EXISTS chunks_fts;
DROP TABLE IF EXISTS chunks;
DROP TABLE IF EXISTS packages;
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
    // A blocking busy handler, not a tuned delay: research children open this
    // cache concurrently, and the loser of the migration lock has to WAIT for the
    // winner's COMMIT rather than throw SQLITE_BUSY on the spot. The bound only
    // stops a wedged handle hanging the worker forever.
    db.exec('PRAGMA busy_timeout = 30000;')
    migrate(db)
    return {
        db,
        close: () => db.close()
    }
}

/**
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an older shape, so the version
 * check has to run BEFORE it or a stale table survives untouched.
 */
function migrate(db: SyncDb): void {
    db.exec('BEGIN IMMEDIATE')
    try {
        const row = db.prepare('PRAGMA user_version').get() as {user_version: number} | null
        // A brand-new database also reads 0, hence DROP ... IF EXISTS.
        if ((row?.user_version ?? 0) < SCHEMA_VERSION) {
            db.exec(DROP_SQL)
            db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
        }
        db.exec(SCHEMA_SQL)
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }
}
