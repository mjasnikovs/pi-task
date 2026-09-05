import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {CacheHandle} from './docs-cache.js'
import {type ResolvedPackage} from './docs-resolve.js'
import {chunkDeclarations, chunkReadme, splitAtMatches} from './docs-chunk.js'
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
 * so a fix to where a declaration is cut leaves stale rows behind on its own. So
 * does WHICH FILES are read: dropping a package's duplicate `.d.cts` twins
 * changes the rows without changing a byte on disk.
 *
 * It is not total. An extractor change that alters only files BELOW the entry
 * goes unnoticed; deleting the cache is still the escape hatch for that.
 */
/**
 * The chunker's own source, so a cut-point fix invalidates every cached package.
 *
 * `declSplitRe.source` alone does not do it: the attribute-orphaning bug was in
 * `splitAtMatches`, not in any profile's regex, so the fingerprint sat still while
 * the rows it describes changed. A package indexed before that fix keeps its
 * dangling `#[cfg(...)]` chunks forever, and the hash is the only thing that would
 * have said so.
 */
export function chunkerFingerprint(): string {
    return `${String(splitAtMatches)}\u0000${String(chunkDeclarations)}\u0000${String(chunkReadme)}`
}

function computeContentHash(pkg: ResolvedPackage, profile: EcosystemProfile): string {
    const hash = createHash('sha256')
    hash.update(Buffer.from(`${pkg.name}@${pkg.version}`, 'utf8'))
    hash.update(ZERO_SEP)
    hash.update(Buffer.from(`${profile.declSplitRe.source}\u0000${profile.commentPrefix}`, 'utf8'))
    hash.update(ZERO_SEP)
    hash.update(Buffer.from(chunkerFingerprint(), 'utf8'))
    hash.update(ZERO_SEP)
    // Source text, the same trick as `declSplitRe.source`: the fingerprint moves
    // whenever the selection rule does, with nothing to remember to bump.
    hash.update(
        Buffer.from(
            `${String(profile.isSurfaceFile)}\u0000${String(dropParallelDeclarations)}`
                + `\u0000${String(dropDeadMajors)}`,
            'utf8'
        )
    )
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

/**
 * Drop a `.d.cts` / `.d.mts` that sits beside a `.d.ts` of the same name.
 *
 * Modern npm packages ship parallel declarations for ESM and CJS: the same API
 * written twice. zod 4.5.4 indexed to 2565 chunks over 1215 distinct bodies,
 * 1280 of them from `.d.cts`; hono, which ships none, had 704 distinct of 708.
 * The cost is the eight-chunk retrieval budget — half of it can go to text the
 * reader already has.
 *
 * The sibling test, not a blanket ban on the extensions: a package shipping only
 * `.d.cts` still has to be readable, and all 123 of zod's had a `.d.ts` twin.
 */
function dropParallelDeclarations(files: string[]): string[] {
    const esm = new Set(
        files.filter(f => f.endsWith('.d.ts')).map(f => f.slice(0, -'.d.ts'.length))
    )
    return files.filter(f => {
        const base = /\.d\.[cm]ts$/.exec(f) ? f.slice(0, -'.d.cts'.length) : null
        return base === null || !esm.has(base)
    })
}

/**
 * Drop a top-level `vN/` directory holding a major the package is no longer on.
 *
 * zod@4.5.4 ships `v3/` for back-compat, and 414 of its 2565 chunks came from
 * it. Nothing downstream can separate them: same identifiers, same package, same
 * version banner, and the file path is not a ranking signal. An answer went out
 * under `Per zod@4.5.4:` carrying v3's `email(message?): ZodString` — wrong
 * parameter, wrong return, and silent about the `@deprecated` line sitting
 * directly above the real declaration.
 *
 * Only a MISMATCHING major goes. `v4/` under 4.5.4 is the current API and is
 * most of the package; a package whose only content lives under `v1/` keeps it.
 */
function dropDeadMajors(files: string[], root: string, version: string): string[] {
    const major = /^(\d+)\./.exec(version)?.[1]
    if (major === undefined) return files
    const kept = files.filter(abs => {
        const top = path.relative(root, abs).replace(/\\/g, '/').split('/')[0]
        const dir = /^v(\d+)$/.exec(top)
        return dir === null || dir[1] === major
    })
    // A package whose whole surface lives under a `vN/` that does not match its
    // own version is not shipping a dead major — it is shipping its API there.
    return kept.length > 0 ? kept : files
}

function collectFiles(pkg: ResolvedPackage, profile: EcosystemProfile): CollectedFiles {
    const walked = walkSurface(pkg.root, profile)
    const surface = dropDeadMajors(walked, pkg.root, pkg.version)
    return {
        surface: profile.id === 'npm' ? dropParallelDeclarations(surface) : surface,
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
