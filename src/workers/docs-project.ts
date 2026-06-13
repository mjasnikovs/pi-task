import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {CacheHandle} from './docs-cache.js'
import {retrieveChunks as defaultRetrieveChunks} from './docs-retrieve.js'
import type {RetrievedChunk} from './docs-retrieve.js'

const MAX_CHUNK_BYTES = 8 * 1024
const DEFAULT_LIMIT = 50
const DEFAULT_BUDGET = 24_000

const DECL_SPLIT_RE =
    /^(?:export\s+|declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|namespace|module|const|let|var|enum)\s+/m

export function getProjectName(cwd: string): string {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
            name?: string
        }
        if (pkg.name) return pkg.name
    } catch {}
    return path.basename(cwd)
}

export function cwdKey(cwd: string): string {
    return createHash('sha256').update(cwd).digest('hex').slice(0, 8)
}

export function getProjectFiles(cwd: string): string[] {
    try {
        const result = spawnSync(
            'git',
            ['ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.tsx'],
            {cwd, encoding: 'utf8', timeout: 5000}
        )
        if (result.status === 0 && result.stdout?.trim()) {
            return result.stdout
                .trim()
                .split('\n')
                .filter(Boolean)
                .map(f => path.join(cwd, f))
        }
    } catch {}
    return walkTsFiles(cwd)
}

function walkTsFiles(root: string): string[] {
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage'])
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
            if (SKIP.has(entry.name)) continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) stack.push(full)
            else if (
                entry.isFile() &&
                (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
            ) {
                out.push(full)
            }
        }
    }
    return out.sort()
}

export function getMaxMtime(files: string[]): string {
    let max = 0
    for (const f of files) {
        try {
            const {mtimeMs} = fs.statSync(f)
            if (mtimeMs > max) max = mtimeMs
        } catch {}
    }
    return String(Math.floor(max))
}

function chunkTs(content: string, relPath: string): string[] {
    const splits = splitAtMatches(content, new RegExp(DECL_SPLIT_RE.source, 'gm'))
    const chunks: string[] = []
    for (const part of splits) {
        const trimmed = part.trim()
        if (!trimmed) continue
        const prefixed = `// ${relPath}\n${trimmed}`
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

interface PackageRow {
    content_hash: string
}

export interface ProjectIndexResult {
    hitCache: boolean
    filesIngested: number
    chunksWritten: number
    indexingMs?: number
}

export function ensureProjectIndexed(
    cache: CacheHandle,
    name: string,
    version: string,
    files: string[],
    cwd: string
): ProjectIndexResult {
    const existing = cache.db
        .prepare('SELECT content_hash FROM packages WHERE name = ? AND version = ?')
        .get(name, version) as PackageRow | null
    if (existing) return {hitCache: true, filesIngested: 0, chunksWritten: 0}

    const t0 = Date.now()
    cache.db.exec('BEGIN IMMEDIATE')
    try {
        // Clear all old versions of this project
        cache.db.prepare('DELETE FROM chunks WHERE name = ?').run(name)
        cache.db.prepare('DELETE FROM packages WHERE name = ?').run(name)

        const insertChunk = cache.db.prepare(
            'INSERT INTO chunks (name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?)'
        )
        let filesIngested = 0
        let chunksWritten = 0

        for (const abs of files) {
            let raw: string
            try {
                raw = fs.readFileSync(abs, 'utf8')
            } catch {
                continue
            }
            const rel = path.relative(cwd, abs)
            const chunks = chunkTs(raw, rel)
            if (!chunks.length) continue
            filesIngested++
            for (const c of chunks) {
                insertChunk.run(name, version, rel, 'dts', c)
                chunksWritten++
            }
        }

        cache.db
            .prepare(
                'INSERT OR REPLACE INTO packages (name, version, content_hash, indexed_at) VALUES (?, ?, ?, ?)'
            )
            .run(name, version, version, Date.now())

        cache.db.exec('COMMIT')
        return {hitCache: false, filesIngested, chunksWritten, indexingMs: Date.now() - t0}
    } catch (err) {
        cache.db.exec('ROLLBACK')
        throw err
    }
}

export type ProjectDocsRawResult =
    | {
          kind: 'ok'
          projectName: string
          cacheKey: string
          version: string
          chunks: RetrievedChunk[]
          hitCache: boolean
          filesIngested: number
          chunksWritten: number
          indexingMs?: number
      }
    | {kind: 'no_chunks'; projectName: string; cacheKey: string; version: string; hitCache: boolean; filesIngested: number}
    | {kind: 'error'; projectName: string; message: string}

export function projectDocsRaw(
    cache: CacheHandle,
    cwd: string,
    query: string,
    retrieveChunksFn: typeof defaultRetrieveChunks = defaultRetrieveChunks
): ProjectDocsRawResult {
    const projectName = getProjectName(cwd)
    const cacheKey = `project:${cwdKey(cwd)}`

    const files = getProjectFiles(cwd)
    const version = getMaxMtime(files)

    let indexResult: ProjectIndexResult
    try {
        indexResult = ensureProjectIndexed(cache, cacheKey, version, files, cwd)
    } catch (err) {
        return {
            kind: 'error',
            projectName,
            message: `Indexing failed: ${err instanceof Error ? err.message : String(err)}`
        }
    }

    const chunkCount =
        (
            cache.db
                .prepare('SELECT count(*) AS c FROM chunks WHERE name = ? AND version = ?')
                .get(cacheKey, version) as {c: number} | null
        )?.c ?? 0

    if (chunkCount === 0) {
        return {
            kind: 'no_chunks',
            projectName,
            cacheKey,
            version,
            hitCache: indexResult.hitCache,
            filesIngested: indexResult.filesIngested
        }
    }

    let chunks: RetrievedChunk[]
    try {
        chunks = retrieveChunksFn(cache, {
            name: cacheKey,
            version,
            query,
            limit: DEFAULT_LIMIT,
            contentBudget: DEFAULT_BUDGET
        })
    } catch (err) {
        return {
            kind: 'error',
            projectName,
            message: `Retrieval failed: ${err instanceof Error ? err.message : String(err)}`
        }
    }

    if (chunks.length === 0) {
        return {
            kind: 'no_chunks',
            projectName,
            cacheKey,
            version,
            hitCache: indexResult.hitCache,
            filesIngested: indexResult.filesIngested
        }
    }

    return {
        kind: 'ok',
        projectName,
        cacheKey,
        version,
        chunks,
        hitCache: indexResult.hitCache,
        filesIngested: indexResult.filesIngested,
        chunksWritten: indexResult.chunksWritten,
        indexingMs: indexResult.indexingMs
    }
}

export function buildProjectPrompt(
    projectName: string,
    query: string,
    content: string
): string {
    return (
        `You answer one question about a local project's source code, using only the provided content.\n`
        + `\n`
        + `Rules:\n`
        + `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <project-content>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <project-content>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Prefer type signatures, function declarations, and code blocks as evidence over prose.\n`
        + `4. If the answer is unclear, ambiguous, or absent from <project-content>, write exactly:\n`
        + `   <answer>unclear from this project</answer> and put the closest related text in <excerpt>.\n`
        + `   Do not guess.\n`
        + `5. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<project>${projectName}</project>\n`
        + `<question>${query}</question>\n`
        + `<project-content>\n${content}\n</project-content>\n`
    )
}
