import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {CacheHandle} from './docs-cache.js'
import {type ResolvedPackage} from './docs-resolve.js'
import {chunkDeclarations, chunkReadme} from './docs-chunk.js'
import {ECOSYSTEMS, type EcosystemProfile} from './docs-ecosystems.js'

const ZERO_SEP = Buffer.from([0])

export interface IndexResult {
    hitCache: boolean
    filesIngested: number
    chunksWritten: number
    contentHash: string
}

interface CollectedFiles {
    surface: string[]
    readme: string | null
}

interface PackageRow {
    content_hash: string
}

interface IngestResult {
    hitCache: boolean
    filesIngested: number
    chunksWritten: number
}

/**
 * The gate that decides whether a package needs re-indexing.
 *
 * The entry file goes in SURFACED, not raw. What is cached is the extractor's
 * OUTPUT, so a build whose extractor changed has stale chunks even though every
 * byte on disk is identical — a crate indexed before the braced-`use` fix keeps
 * `pub use crate::runtime::;` forever, because name, version and file bytes all
 * still match. Surfacing here costs one file and makes the hash answer the
 * question actually being asked: would re-reading produce the same chunks?
 *
 * The CHUNKER counts too, for the same reason: the rows are chunks, not surface,
 * so a fix to where a declaration is cut leaves stale rows behind on its own.
 *
 * It is not total. An extractor change that alters only files BELOW the entry
 * goes unnoticed; deleting the cache is still the escape hatch for that.
 */
function computeContentHash(pkg: ResolvedPackage, profile: EcosystemProfile): string {
    const hash = createHash('sha256')
    hash.update(Buffer.from(`${pkg.name}@${pkg.version}`, 'utf8'))
    hash.update(ZERO_SEP)
    hash.update(Buffer.from(`${profile.declSplitRe.source}\u0000${profile.commentPrefix}`, 'utf8'))
    hash.update(ZERO_SEP)
    if (pkg.entry && fs.existsSync(pkg.entry)) {
        try {
            hash.update(Buffer.from(profile.surface(fs.readFileSync(pkg.entry, 'utf8')), 'utf8'))
        } catch {
            hash.update(fs.readFileSync(pkg.entry))
        }
    }
    hash.update(ZERO_SEP)
    if (pkg.readme && fs.existsSync(pkg.readme)) {
        hash.update(fs.readFileSync(pkg.readme))
    }
    return hash.digest('hex')
}

function walkSurface(root: string, profile: EcosystemProfile): string[] {
    const out: string[] = []
    const stack: string[] = [root]
    while (stack.length) {
        const dir = stack.pop()!
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            continue
        }
        for (const entry of entries) {
            if (profile.skipDirs.includes(entry.name)) continue
            const full = path.join(dir, entry.name)
            if (entry.isSymbolicLink()) {
                let realPath: string
                try {
                    realPath = fs.realpathSync(full)
                } catch {
                    continue
                }
                const relReal = path.relative(root, realPath)
                if (relReal.startsWith('..')) continue
                const stat = fs.statSync(realPath)
                if (stat.isDirectory()) stack.push(realPath)
                else if (stat.isFile() && profile.isSurfaceFile(realPath)) out.push(realPath)
                continue
            }
            if (entry.isDirectory()) stack.push(full)
            else if (entry.isFile() && profile.isSurfaceFile(entry.name)) out.push(full)
        }
    }
    return out.sort()
}

function collectFiles(pkg: ResolvedPackage, profile: EcosystemProfile): CollectedFiles {
    return {
        surface: walkSurface(pkg.root, profile),
        readme: pkg.readme
    }
}

function ingestBody(
    cache: CacheHandle,
    pkg: ResolvedPackage,
    profile: EcosystemProfile,
    contentHash: string
): IngestResult {
    const ecosystem = profile.id
    const inside = cache.db
        .prepare(
            'SELECT content_hash FROM packages WHERE ecosystem = ? AND name = ? AND version = ?'
        )
        .get(ecosystem, pkg.name, pkg.version) as PackageRow | null
    if (inside && inside.content_hash === contentHash) {
        return {hitCache: true, filesIngested: 0, chunksWritten: 0}
    }
    cache.db
        .prepare('DELETE FROM chunks WHERE ecosystem = ? AND name = ? AND version = ?')
        .run(ecosystem, pkg.name, pkg.version)
    const files = collectFiles(pkg, profile)
    let chunksWritten = 0
    let filesIngested = 0
    const insertChunk = cache.db.prepare(
        'INSERT INTO chunks (ecosystem, name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const abs of files.surface) {
        // Normalise the separator before storing, so the same package indexes to
        // the same rows whatever built the path. The value is a MODEL-FACING
        // label: chunkDeclarations turns it into the chunk's `// <path>` header,
        // and nothing ever joins it back to the filesystem.
        const rel = path.relative(pkg.root, abs).replace(/\\/g, '/')
        let raw: string
        try {
            raw = fs.readFileSync(abs, 'utf8')
        } catch {
            continue
        }
        const chunks = chunkDeclarations(
            profile.surface(raw),
            rel,
            profile.declSplitRe,
            profile.commentPrefix
        )
        if (!chunks.length) continue
        filesIngested++
        for (const c of chunks) {
            insertChunk.run(ecosystem, pkg.name, pkg.version, rel, 'dts', c)
            chunksWritten++
        }
    }
    if (files.readme) {
        const rel = path.relative(pkg.root, files.readme).replace(/\\/g, '/')
        const raw = fs.readFileSync(files.readme, 'utf8')
        const chunks = chunkReadme(raw)
        if (chunks.length) {
            filesIngested++
            for (const c of chunks) {
                insertChunk.run(ecosystem, pkg.name, pkg.version, rel, 'readme', c)
                chunksWritten++
            }
        }
    }
    cache.db
        .prepare(
            'INSERT OR REPLACE INTO packages (ecosystem, name, version, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run(ecosystem, pkg.name, pkg.version, contentHash, Date.now())
    return {hitCache: false, filesIngested, chunksWritten}
}

export function ensureIndexed(
    cache: CacheHandle,
    pkg: ResolvedPackage,
    profile: EcosystemProfile = ECOSYSTEMS[pkg.ecosystem]
): IndexResult {
    const ecosystem = profile.id
    const contentHash = computeContentHash(pkg, profile)
    const existing = cache.db
        .prepare(
            'SELECT content_hash FROM packages WHERE ecosystem = ? AND name = ? AND version = ?'
        )
        .get(ecosystem, pkg.name, pkg.version) as PackageRow | null
    if (existing && existing.content_hash === contentHash) {
        return {hitCache: true, filesIngested: 0, chunksWritten: 0, contentHash}
    }

    cache.db.exec('BEGIN IMMEDIATE')
    let result: IngestResult
    try {
        result = ingestBody(cache, pkg, profile, contentHash)
        cache.db.exec('COMMIT')
    } catch (err) {
        cache.db.exec('ROLLBACK')
        throw err
    }
    return {...result, contentHash}
}
