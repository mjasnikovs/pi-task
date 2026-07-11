import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {CacheHandle} from './docs-cache.js'
import {isDtsFile, type ResolvedPackage} from './docs-resolve.js'

const MAX_CHUNK_BYTES = 8 * 1024
const ZERO_SEP = Buffer.from([0])

const DECL_SPLIT_RE =
    /^(?:export\s+|declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|namespace|module|const|let|var|enum)\s+/m
const README_SPLIT_RE = /^#{1,2} /m

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

function chunkDts(content: string, relPath: string): string[] {
    const splits = splitAtMatches(content, new RegExp(DECL_SPLIT_RE.source, 'gm'))
    const chunks: string[] = []
    for (const part of splits) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const prefixed = `// ${relPath}\n${trimmed}`
        if (Buffer.byteLength(prefixed, 'utf8') > MAX_CHUNK_BYTES) {
            for (const slice of sliceBytes(prefixed, MAX_CHUNK_BYTES)) {
                chunks.push(slice)
            }
        } else {
            chunks.push(prefixed)
        }
    }
    return chunks
}

function chunkReadme(content: string): string[] {
    const splits = splitAtMatches(content, new RegExp(README_SPLIT_RE.source, 'gm'))
    const chunks: string[] = []
    for (const part of splits) {
        const trimmed = part.replace(/\s+$/, '')
        if (!trimmed) continue
        const headingMatch = /^(#{1,2}) (.+)$/m.exec(trimmed)
        const heading = headingMatch ? headingMatch[2] : '(intro)'
        const prefixed = `<!-- README: ${heading} -->\n${trimmed}`
        if (Buffer.byteLength(prefixed, 'utf8') > MAX_CHUNK_BYTES) {
            for (const slice of sliceBytes(prefixed, MAX_CHUNK_BYTES)) chunks.push(slice)
        } else {
            chunks.push(prefixed)
        }
    }
    return chunks
}

function splitAtMatches(text: string, re: RegExp): string[] {
    const parts: string[] = []
    let lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
        if (m.index > lastIndex) parts.push(text.slice(lastIndex, m.index))
        lastIndex = m.index
        re.lastIndex = m.index + 1
    }
    if (lastIndex < text.length) parts.push(text.slice(lastIndex))
    return parts.length ? parts : [text]
}

function sliceBytes(s: string, maxBytes: number): string[] {
    const out: string[] = []
    let buf = Buffer.from(s, 'utf8')
    while (buf.length > maxBytes) {
        const slice = buf.subarray(0, maxBytes).toString('utf8')
        out.push(slice)
        buf = buf.subarray(Buffer.byteLength(slice, 'utf8'))
    }
    if (buf.length) out.push(buf.toString('utf8'))
    return out
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
        // Store the file identifier POSIX-style so indexed docs are identical
        // across platforms (this value is a model-facing label, never re-joined
        // to the filesystem — node reads forward slashes fine on Windows too).
        const rel = path.relative(pkg.root, abs).replace(/\\/g, '/')
        let raw: string
        try {
            raw = fs.readFileSync(abs, 'utf8')
        } catch {
            continue
        }
        const chunks = chunkDts(raw, rel)
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
