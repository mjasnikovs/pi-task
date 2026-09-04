import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {CacheHandle} from './docs-cache.js'
import {
    retrieveChunks as defaultRetrieveChunks,
    PROJECT_RETRIEVE_LIMIT,
    RETRIEVE_CONTENT_BUDGET
} from './docs-retrieve.js'
import type {RetrievedChunk} from './docs-retrieve.js'
import {buildExtractionPrompt} from './abstention.js'
import {chunkDeclarations} from './docs-chunk.js'
import type {DocsCorpus} from './docs-lookup.js'

const DEFAULT_LIMIT = PROJECT_RETRIEVE_LIMIT
const DEFAULT_BUDGET = RETRIEVE_CONTENT_BUDGET

/**
 * Scope value for project-source rows. It sits in the same column as a registry
 * id because these rows share the tables, but it is NOT one: a project is keyed
 * by a hash of its cwd, so no registry could name it.
 */
export const PROJECT_SCOPE = 'project'

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

/**
 * Which source files make up the project.
 *
 * `git ls-files` is the source of truth whenever it answers: it already knows
 * what is tracked and what `.gitignore` excludes, which no hand-rolled walk gets
 * right. `walkTsFiles` is the fallback, and it is reached in TWO cases — no git
 * repo, and a repo where git matched nothing.
 *
 * The two disagree in both directions, so which one ran is observable:
 *   - git honours `.gitignore`; the walk does not, so a repo whose only `.ts`
 *     files are all gitignored falls through and indexes them anyway.
 *   - the walk skips node_modules, .git, dist, build and coverage outright; git
 *     lists whatever those contain unless `.gitignore` says otherwise.
 *
 * Injectable through `projectDocsRaw` because without a seam, ANY test of the
 * project path needs a real temp directory, real files on disk, git installed,
 * and a temp dir that is not itself inside a repo.
 */
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
                entry.isFile()
                && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
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
        .prepare(
            'SELECT content_hash FROM packages WHERE ecosystem = ? AND name = ? AND version = ?'
        )
        .get(PROJECT_SCOPE, name, version) as PackageRow | null
    if (existing) return {hitCache: true, filesIngested: 0, chunksWritten: 0}

    const t0 = Date.now()
    cache.db.exec('BEGIN IMMEDIATE')
    try {
        // Delete by NAME with no version: unlike the package index, a project
        // keeps only its newest max-mtime version, so every older one goes.
        cache.db
            .prepare('DELETE FROM chunks WHERE ecosystem = ? AND name = ?')
            .run(PROJECT_SCOPE, name)
        cache.db
            .prepare('DELETE FROM packages WHERE ecosystem = ? AND name = ?')
            .run(PROJECT_SCOPE, name)

        const insertChunk = cache.db.prepare(
            'INSERT INTO chunks (ecosystem, name, version, file_path, kind, content) VALUES (?, ?, ?, ?, ?, ?)'
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
            const chunks = chunkDeclarations(raw, rel)
            if (!chunks.length) continue
            filesIngested++
            for (const c of chunks) {
                insertChunk.run(PROJECT_SCOPE, name, version, rel, 'dts', c)
                chunksWritten++
            }
        }

        cache.db
            .prepare(
                'INSERT OR REPLACE INTO packages (ecosystem, name, version, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(PROJECT_SCOPE, name, version, version, Date.now())

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
    | {
          kind: 'no_chunks'
          projectName: string
          cacheKey: string
          version: string
          hitCache: boolean
          filesIngested: number
      }
    | {kind: 'error'; projectName: string; message: string}

export function projectDocsRaw(
    cache: CacheHandle,
    cwd: string,
    query: string,
    retrieveChunksFn: typeof defaultRetrieveChunks = defaultRetrieveChunks,
    /** How to enumerate the project's sources. See getProjectFiles. */
    listFiles: (cwd: string) => string[] = getProjectFiles
): ProjectDocsRawResult {
    const projectName = getProjectName(cwd)
    const cacheKey = `project:${cwdKey(cwd)}`

    const files = listFiles(cwd)
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
                .prepare(
                    'SELECT count(*) AS c FROM chunks WHERE ecosystem = ? AND name = ? AND version = ?'
                )
                .get(PROJECT_SCOPE, cacheKey, version) as {c: number} | null
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
            ecosystem: PROJECT_SCOPE,
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

export function buildProjectPrompt(projectName: string, query: string, content: string): string {
    return buildExtractionPrompt({
        kind: 'project',
        subject: "a local project's source code",
        tag: 'project',
        identity: projectName,
        query,
        content
    })
}

/**
 * The PROJECT corpus row: the current repo's own indexed `.ts`/`.tsx` source.
 *
 * The header reads `Per <name> (project source):`, where the package corpus reads
 * `Per <name>@<version>:`. Both are read and cited the same way and mean very
 * different things, so the answer has to say which it came from.
 */
export function projectCorpus(projectName: string): DocsCorpus {
    return {
        id: 'project',
        buildPrompt: (query, content) => buildProjectPrompt(projectName, query, content),
        header: `Per ${projectName} (project source):`,
        abortedMessage: 'Project docs lookup aborted.'
    }
}
