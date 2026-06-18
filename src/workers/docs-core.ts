import {spawn as defaultSpawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {openCache as defaultOpenCache, type CacheHandle} from './docs-cache.js'
import {ensureIndexed as defaultEnsureIndexed, type IndexResult} from './docs-index.js'
import {
    resolvePackage as defaultResolvePackage,
    ResolveError,
    detectTypesRedirect,
    typesPackageName,
    hasTypeFiles,
    isDtsFile,
    type ResolvedPackage
} from './docs-resolve.js'
import {retrieveChunks as defaultRetrieveChunks, type RetrievedChunk} from './docs-retrieve.js'
import {npmVersionLookup as defaultNpmVersionLookup, type NpmVersionInfo} from './npm-version.js'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {CHILD_BASE_ARGS, runChild, type SpawnFn} from '../shared/child-process.js'
import {
    parseChildOutput,
    isExcerptInContent,
    formatResultText as formatResultTextShared
} from '../shared/child-output.js'

const DEFAULT_LIMIT = 8
const DEFAULT_BUDGET = 24_000

const NO_CACHE_HEAD = 25_000
const NO_CACHE_TAIL = 5_000
const NO_CACHE_TOTAL = NO_CACHE_HEAD + NO_CACHE_TAIL
const NO_CACHE_MARKER = '\n\n[...content continues, truncated...]\n\n'

const CHILD_ARGS = [...CHILD_BASE_ARGS, '--no-tools'] as readonly string[]

export type DocsRawResult =
    | {
          kind: 'ok'
          pkg: ResolvedPackage
          chunks: RetrievedChunk[]
          hitCache: boolean
          indexingMs?: number
          indexedFiles?: number
          cacheError?: string
          autoInstalled?: boolean
          npmVersion?: NpmVersionInfo | null
      }
    | {kind: 'not_installed'; pkg: string; npmVersion?: NpmVersionInfo | null}
    | {
          kind: 'no_chunks'
          pkg: ResolvedPackage
          hitCache: boolean
          indexedFiles?: number
          cacheError?: string
          autoInstalled?: boolean
          npmVersion?: NpmVersionInfo | null
      }
    | {
          kind: 'error'
          message: string
          resolveError?: 'not_installed' | 'invalid_name'
          installError?: string
          version?: string
          hitCache?: boolean
          cacheError?: string
          autoInstalled?: boolean
          npmVersion?: NpmVersionInfo | null
      }

export interface DocsRawInput {
    pkg: string
    query: string
    cwd: string
    autoInstall?: boolean
    // optional injection hooks for tests:
    resolvePackage?: typeof defaultResolvePackage
    ensureIndexed?: typeof defaultEnsureIndexed
    retrieveChunks?: typeof defaultRetrieveChunks
    openCache?: typeof defaultOpenCache
    spawn?: SpawnFn
    npmVersionLookup?: typeof defaultNpmVersionLookup
    signal?: AbortSignal
}

export interface DocsFocusedResult {
    answer: string
    excerpt?: string
    excerptVerified?: boolean
    pkg: ResolvedPackage
    version: string
    exitCode: number
    aborted: boolean
    stderr: string
    hitCache?: boolean
    indexingMs?: number
    indexedFiles?: number
    chunksRetrieved?: number
    cacheError?: string
    autoInstalled?: boolean
    npmVersion?: NpmVersionInfo | null
}

export type DocsFocusedInput = DocsRawInput

export function extractParentPackage(moduleName: string): string {
    if (moduleName.startsWith('@')) {
        const parts = moduleName.split('/')
        return `${parts[0]}/${parts[1]}`
    }
    return moduleName.split('/')[0]
}

export function getDocsModulesDir(): string {
    const base = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache')
    return path.join(base, 'pi-worker', 'docs-modules')
}

export function ensureDocsModulesDir(dir: string): void {
    fs.mkdirSync(dir, {recursive: true})
    const pkgPath = path.join(dir, 'package.json')
    if (!fs.existsSync(pkgPath)) {
        fs.writeFileSync(pkgPath, '{"name":"pi-worker-docs-modules","private":true}\n', 'utf8')
    }
}

export async function runAutoInstall(
    spawn: SpawnFn,
    packageName: string,
    signal: AbortSignal | undefined
): Promise<{success: boolean; installDir: string; stderr: string}> {
    const installDir = getDocsModulesDir()
    ensureDocsModulesDir(installDir)
    const result = await runChild(
        spawn,
        {
            command: 'npm',
            args: ['install', '--no-audit', '--no-fund', '--loglevel=error', packageName]
        },
        installDir,
        signal,
        {mode: 'text', discardStdout: true}
    )
    return {success: result.exitCode === 0 && !result.aborted, installDir, stderr: result.stderr}
}

/** Resolve `name` from cwd; on `not_installed`, auto-install it and resolve from
 *  the install dir. Returns null on any failure (caller keeps its fallback). */
async function tryResolveOrInstall(
    name: string,
    cwd: string,
    spawn: SpawnFn,
    resolvePackage: typeof defaultResolvePackage,
    signal: AbortSignal | undefined
): Promise<ResolvedPackage | null> {
    try {
        return resolvePackage(name, cwd)
    } catch (err) {
        if (!(err instanceof ResolveError) || err.kind !== 'not_installed') return null
        const install = await runAutoInstall(spawn, extractParentPackage(name), signal)
        if (!install.success) return null
        try {
            return resolvePackage(name, install.installDir)
        } catch {
            return null
        }
    }
}

/** Follow the @types/<name> + triple-slash `<reference types>` redirect chain
 *  from a package that ships no usable types of its own to the one that actually
 *  holds the declarations (e.g. bun -> @types/bun -> bun-types). Bounded to a few
 *  hops; returns the original package if no better source is found. */
async function resolveTypeSource(
    pkg: ResolvedPackage,
    requested: string,
    cwd: string,
    spawn: SpawnFn,
    resolvePackage: typeof defaultResolvePackage,
    signal: AbortSignal | undefined
): Promise<ResolvedPackage> {
    const visited = new Set<string>([pkg.name, extractParentPackage(requested)])
    let cur = pkg
    for (let depth = 0; depth < 3; depth++) {
        let next = detectTypesRedirect(cur)
        if (next && visited.has(next)) next = null
        if (!next && !hasTypeFiles(cur.root)) {
            const types = typesPackageName(cur.name)
            if (types && !visited.has(types)) next = types
        }
        if (!next) break
        visited.add(next)
        const resolved = await tryResolveOrInstall(next, cwd, spawn, resolvePackage, signal)
        if (!resolved) break
        cur = resolved
    }
    return cur
}

export async function docsRaw(input: DocsRawInput): Promise<DocsRawResult> {
    const resolvePackage = input.resolvePackage ?? defaultResolvePackage
    const ensureIndexed = input.ensureIndexed ?? defaultEnsureIndexed
    const retrieveChunks = input.retrieveChunks ?? defaultRetrieveChunks
    const openCache = input.openCache ?? defaultOpenCache
    const spawn = input.spawn ?? (defaultSpawn as unknown as SpawnFn)
    const npmVersionLookup = input.npmVersionLookup ?? defaultNpmVersionLookup

    // Fire the npm registry lookup in parallel with resolve/index/retrieve.
    // It returns null on any failure, so it never blocks the local pipeline.
    const npmVersionPromise = npmVersionLookup(extractParentPackage(input.pkg), {
        signal: input.signal
    }).catch<NpmVersionInfo | null>(() => null)

    // Step 1: resolve package
    let pkg: ResolvedPackage
    let autoInstalled = false
    try {
        pkg = resolvePackage(input.pkg, input.cwd)
    } catch (firstErr) {
        if (firstErr instanceof ResolveError && firstErr.kind === 'not_installed') {
            // auto-install
            const parentPkg = extractParentPackage(input.pkg)
            const installResult = await runAutoInstall(spawn, parentPkg, undefined)
            if (!installResult.success) {
                return {
                    kind: 'error',
                    message: `Package "${parentPkg}" is not installed and auto-install failed.\n${installResult.stderr}`,
                    resolveError: 'not_installed',
                    installError: installResult.stderr,
                    npmVersion: await npmVersionPromise
                }
            }
            autoInstalled = true
            try {
                pkg = resolvePackage(input.pkg, installResult.installDir)
            } catch (retryErr) {
                if (retryErr instanceof ResolveError) {
                    return {
                        kind: 'error',
                        message: retryErr.message,
                        resolveError: retryErr.kind,
                        autoInstalled,
                        npmVersion: await npmVersionPromise
                    }
                }
                return {
                    kind: 'error',
                    message: `Could not resolve "${input.pkg}" after install: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
                    autoInstalled,
                    npmVersion: await npmVersionPromise
                }
            }
        } else if (firstErr instanceof ResolveError) {
            return {
                kind: 'error',
                message: firstErr.message,
                resolveError: firstErr.kind,
                npmVersion: await npmVersionPromise
            }
        } else {
            return {
                kind: 'error',
                message: `Could not resolve "${input.pkg}": ${firstErr instanceof Error ? firstErr.message : String(firstErr)}`,
                npmVersion: await npmVersionPromise
            }
        }
    }

    // Step 1b: if the resolved package ships no usable type declarations (e.g.
    // the `bun` runtime launcher, which is just a binary + install README), or is
    // a pure `@types/<name>` redirect stub, follow the conventional
    // @types/<name> + triple-slash `<reference types>` chain to the package that
    // actually holds the declarations (e.g. bun -> @types/bun -> bun-types).
    // Best-effort: any failure leaves the original resolution untouched.
    pkg = await resolveTypeSource(pkg, input.pkg, input.cwd, spawn, resolvePackage, input.signal)

    // Step 2: open cache
    let cache: CacheHandle | null = null
    let cacheError: string | undefined
    try {
        cache = openCache()
    } catch (err) {
        cacheError = err instanceof Error ? err.message : String(err)
    }

    const result =
        cache ?
            docsRawCached(cache, pkg, input.query, ensureIndexed, retrieveChunks, autoInstalled)
        :   docsRawUncached(pkg, cacheError ?? 'unknown cache error', autoInstalled)
    result.npmVersion = await npmVersionPromise
    return result
}

function docsRawCached(
    cache: CacheHandle,
    pkg: ResolvedPackage,
    query: string,
    ensureIndexed: typeof defaultEnsureIndexed,
    retrieveChunks: typeof defaultRetrieveChunks,
    autoInstalled: boolean
): DocsRawResult {
    let indexResult: IndexResult
    const t0 = Date.now()
    try {
        indexResult = ensureIndexed(cache, pkg)
    } catch (err) {
        return {
            kind: 'error',
            message: `Indexing failed for ${pkg.name}@${pkg.version}: ${err instanceof Error ? err.message : String(err)}`,
            version: pkg.version
        }
    }
    const indexingMs = indexResult.hitCache ? undefined : Date.now() - t0

    const chunkCount =
        (
            cache.db
                .prepare('SELECT count(*) AS c FROM chunks WHERE name = ? AND version = ?')
                .get(pkg.name, pkg.version) as {c: number} | null
        )?.c ?? 0
    if (chunkCount === 0) {
        return {
            kind: 'no_chunks',
            pkg,
            hitCache: indexResult.hitCache,
            indexedFiles: 0,
            autoInstalled: autoInstalled ? true : undefined
        }
    }

    let chunks: RetrievedChunk[]
    try {
        chunks = retrieveChunks(cache, {
            name: pkg.name,
            version: pkg.version,
            query,
            limit: DEFAULT_LIMIT,
            contentBudget: DEFAULT_BUDGET
        })
    } catch (err) {
        return {
            kind: 'error',
            message: `Retrieval failed for ${pkg.name}@${pkg.version}: ${err instanceof Error ? err.message : String(err)}`,
            version: pkg.version,
            hitCache: indexResult.hitCache
        }
    }

    if (chunks.length === 0) {
        return {
            kind: 'no_chunks',
            pkg,
            hitCache: indexResult.hitCache,
            autoInstalled: autoInstalled ? true : undefined
        }
    }

    return {
        kind: 'ok',
        pkg,
        chunks,
        hitCache: indexResult.hitCache,
        indexingMs,
        autoInstalled: autoInstalled ? true : undefined
    }
}

function docsRawUncached(
    pkg: ResolvedPackage,
    cacheError: string,
    autoInstalled: boolean
): DocsRawResult {
    const parts: string[] = []
    const dtsFiles = walkDtsAlpha(pkg.root)
    const entryFirst =
        pkg.entryDts ? [pkg.entryDts, ...dtsFiles.filter(f => f !== pkg.entryDts)] : dtsFiles
    for (const abs of entryFirst) {
        let raw: string
        try {
            raw = fs.readFileSync(abs, 'utf8')
        } catch {
            continue
        }
        const rel = path.relative(pkg.root, abs)
        parts.push(`// ${rel}\n${raw}`)
    }
    if (pkg.readme) {
        const rel = path.relative(pkg.root, pkg.readme)
        try {
            const raw = fs.readFileSync(pkg.readme, 'utf8')
            parts.push(`<!-- README: ${rel} -->\n${raw}`)
        } catch {
            // skip
        }
    }
    const joined = parts.join('\n\n')
    if (joined.length === 0) {
        return {
            kind: 'no_chunks',
            pkg,
            hitCache: false,
            indexedFiles: 0,
            cacheError,
            autoInstalled: autoInstalled ? true : undefined
        }
    }
    const truncated = truncateHeadTail(joined)
    const chunks: RetrievedChunk[] = [
        {filePath: '<no-cache>', kind: 'dts', content: truncated, rank: 0}
    ]
    return {
        kind: 'ok',
        pkg,
        chunks,
        hitCache: false,
        cacheError,
        autoInstalled: autoInstalled ? true : undefined
    }
}

function walkDtsAlpha(root: string): string[] {
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
            if (entry.isDirectory()) stack.push(full)
            else if (entry.isFile() && isDtsFile(entry.name)) out.push(full)
        }
    }
    return out.sort()
}

function truncateHeadTail(s: string): string {
    if (s.length <= NO_CACHE_TOTAL) return s
    return s.slice(0, NO_CACHE_HEAD) + NO_CACHE_MARKER + s.slice(s.length - NO_CACHE_TAIL)
}

export async function docsFocused(input: DocsFocusedInput): Promise<DocsFocusedResult> {
    const spawn = input.spawn ?? (defaultSpawn as unknown as SpawnFn)
    const rawResult = await docsRaw(input)

    if (rawResult.kind === 'error') {
        throw new Error(rawResult.message)
    }
    if (rawResult.kind === 'not_installed') {
        throw new Error(`Package "${rawResult.pkg}" is not installed`)
    }
    if (rawResult.kind === 'no_chunks') {
        throw new Error(
            `Package ${rawResult.pkg.name}@${rawResult.pkg.version} has no .d.ts files or README.`
        )
    }

    const {pkg, chunks, hitCache, indexingMs} = rawResult
    const concatenated = chunks.map(c => c.content).join('\n\n')
    const prompt = buildPrompt(pkg, input.query, concatenated)
    const invocation = getPiInvocation([...CHILD_ARGS, prompt])
    const child = await runChild(spawn, invocation, input.cwd, input.signal)

    const parsed = parseChildOutput(child.stdout)
    const excerptVerified =
        parsed.excerpt ? isExcerptInContent(parsed.excerpt, concatenated) : undefined

    return {
        answer: parsed.answer,
        excerpt: parsed.excerpt,
        excerptVerified,
        pkg,
        version: pkg.version,
        exitCode: child.exitCode,
        aborted: child.aborted,
        stderr: child.stderr,
        hitCache,
        indexingMs,
        chunksRetrieved: chunks.length,
        autoInstalled: rawResult.autoInstalled,
        npmVersion: rawResult.npmVersion
    }
}

export function buildPrompt(pkg: ResolvedPackage, query: string, content: string): string {
    return (
        `You answer one question about an npm package, using only the provided content.\n`
        + `\n`
        + `Rules:\n`
        + `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <package-content>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <package-content>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Prefer type signatures, function declarations, and code blocks as evidence over prose.\n`
        + `4. If the answer is unclear, ambiguous, or absent from <package-content>, write exactly:\n`
        + `   <answer>unclear from this package</answer> and put the closest related text in <excerpt>.\n`
        + `   Do not guess.\n`
        + `5. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<package>${pkg.name}@${pkg.version}</package>\n`
        + `<question>${query}</question>\n`
        + `<package-content>\n${content}\n</package-content>\n`
    )
}

// ─── Backward-compatible wrappers (thin — delegates to shared/) ─────────────

/** Thin wrapper so existing callers using the pkg-based signature still work. */
export function formatResultText(
    pkg: ResolvedPackage,
    parsed: {answer: string; excerpt?: string},
    verified: boolean | undefined
): string {
    return formatResultTextShared(`Per ${pkg.name}@${pkg.version}:`, parsed, verified)
}
