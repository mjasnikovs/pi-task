import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {CacheHandle} from './docs-cache.js'
import {isDtsFile, type ResolvedPackage} from './docs-resolve.js'
import {chunkDeclarations, chunkReadme} from './docs-chunk.js'

const ZERO_SEP = Buffer.from([0])

export interface IndexResult {
    hitCache: boolean
    filesIngested: number
    chunksWritten: number
    contentHash: string
}

interface CollectedFiles {
    dts: string[]
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

function computeContentHash(pkg: ResolvedPackage): string {
    const hash = createHash('sha256')
    hash.update(Buffer.from(`${pkg.name}@${pkg.version}`, 'utf8'))
    hash.update(ZERO_SEP)
    if (pkg.entryDts && fs.existsSync(pkg.entryDts)) {
        hash.update(fs.readFileSync(pkg.entryDts))
    }
    hash.update(ZERO_SEP)
    if (pkg.readme && fs.existsSync(pkg.readme)) {
        hash.update(fs.readFileSync(pkg.readme))
    }
    return hash.digest('hex')
}

function walkDts(root: string): string[] {
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
            if (entry.name === 'node_modules') continue
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
                else if (stat.isFile() && isDtsFile(realPath)) out.push(realPath)
                continue
            }
            if (entry.isDirectory()) stack.push(full)
            else if (entry.isFile() && isDtsFile(entry.name)) out.push(full)
        }
    }
    return out.sort()
}

function collectFiles(pkg: ResolvedPackage): CollectedFiles {
    return {
        dts: walkDts(pkg.root),
        readme: pkg.readme
    }
}

function ingestBody(cache: CacheHandle, pkg: ResolvedPackage, contentHash: string): IngestResult {
    const inside = cache.db
        .prepare('SELECT content_hash FROM packages WHERE name = ? AND version = ?')
        .get(pkg.name, pkg.version) as PackageRow | null
    if (inside && inside.content_hash === contentHash) {
        return {hitCache: true, filesIngested: 0, chunksWritten: 0}
    }
    cache.db.prepare('DELETE FROM chunks WHERE name = ? AND version = ?').run(pkg.name, pkg.version)
    const files = collectFiles(pkg)
    let chunksWritten = 0
    let filesIngested = 0
    const insertChunk = cache.db.prepare(
        'INSERT INTO chunks (name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?)'
    )
    for (const abs of files.dts) {
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
        const chunks = chunkDeclarations(raw, rel)
        if (!chunks.length) continue
        filesIngested++
        for (const c of chunks) {
            insertChunk.run(pkg.name, pkg.version, rel, 'dts', c)
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
                insertChunk.run(pkg.name, pkg.version, rel, 'readme', c)
                chunksWritten++
            }
        }
    }
    cache.db
        .prepare(
            'INSERT OR REPLACE INTO packages (name, version, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
        )
        .run(pkg.name, pkg.version, contentHash, Date.now())
    return {hitCache: false, filesIngested, chunksWritten}
}

export function ensureIndexed(cache: CacheHandle, pkg: ResolvedPackage): IndexResult {
    const contentHash = computeContentHash(pkg)
    const existing = cache.db
        .prepare('SELECT content_hash FROM packages WHERE name = ? AND version = ?')
        .get(pkg.name, pkg.version) as PackageRow | null
    if (existing && existing.content_hash === contentHash) {
        return {hitCache: true, filesIngested: 0, chunksWritten: 0, contentHash}
    }

    cache.db.exec('BEGIN IMMEDIATE')
    let result: IngestResult
    try {
        result = ingestBody(cache, pkg, contentHash)
        cache.db.exec('COMMIT')
    } catch (err) {
        cache.db.exec('ROLLBACK')
        throw err
    }
    return {...result, contentHash}
}
