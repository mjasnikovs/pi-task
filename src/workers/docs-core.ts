import {spawn as defaultSpawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {openCache as defaultOpenCache, type CacheHandle} from './docs-cache.js'
import {ensureIndexed as defaultEnsureIndexed, type IndexResult} from './docs-index.js'
import {
    resolvePackage as defaultResolvePackage,
    ResolveError,
    isDtsFile,
    resolveTypeSource,
    typesPackageName,
    splitRuntimeNamespace,
    type ResolvedPackage
} from './docs-resolve.js'
import {
    retrieveChunks as defaultRetrieveChunks,
    PACKAGE_RETRIEVE_LIMIT,
    RETRIEVE_CONTENT_BUDGET,
    type RetrievedChunk
} from './docs-retrieve.js'
import {npmVersionLookup as defaultNpmVersionLookup, type NpmVersionInfo} from './npm-version.js'
import {runChild, type SpawnFn} from '../shared/child-process.js'
import {runFocusedExtraction} from './focused-extractor.js'
import {buildExtractionPrompt} from './abstention.js'
import {type ExcerptVerification} from '../shared/child-output.js'

const DEFAULT_LIMIT = PACKAGE_RETRIEVE_LIMIT
const DEFAULT_BUDGET = RETRIEVE_CONTENT_BUDGET

const NO_CACHE_HEAD = 25_000
const NO_CACHE_TAIL = 5_000
const NO_CACHE_TOTAL = NO_CACHE_HEAD + NO_CACHE_TAIL
const NO_CACHE_MARKER = '\n\n[...content continues, truncated...]\n\n'

/**
 * Provenance of an auto-installed package's version, so the answer can state
 * what the version is grounded in instead of leaving it buried in tool details.
 * - 'declared-range': install was pinned to the project's own package.json range
 *   (the resolved version therefore matches project intent).
 * - 'npm-latest': nothing in the project declared the dep, so the install fell
 *   back to whatever npm tags `latest` — which may be a newer MAJOR than the
 *   project targets (this is what a scaffolding task hits, and needs a banner).
 */
export interface AutoInstallPin {
    source: 'declared-range' | 'npm-latest'
    range?: string
    /**
     * The package the CALLER asked about — the HEAD of the resolution chain, not
     * its terminal. `bun -> @types/bun -> bun-types` resolves correctly and must
     * keep doing so, but the sentence a banner writes is about `bun`: the project
     * cannot declare `bun-types`, and was never asked about it.
     */
    asked?: string
}

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
          autoInstallPin?: AutoInstallPin
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
          autoInstallPin?: AutoInstallPin
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
          autoInstallPin?: AutoInstallPin
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
    /**
     * The child's answer — EMPTY when `failure` is set. A failed child's stdout is never
     * parsed as an answer (it used to be: `parseChildOutput` returns the whole trimmed
     * stdout when there is no `<answer>` tag, so a crashed child's error dump was handed
     * to phaseAutoAnswer as if it were package documentation).
     */
    answer: string
    excerpt?: string
    excerptVerified?: boolean
    /** Retained evidence for a false `excerptVerified`, diagnosable without re-running. */
    excerptCheck?: ExcerptVerification
    /**
     * Set exactly when the child failed (aborted, or non-zero exit): the standard
     * child-failure message. Callers must treat `answer` as absent when this is present.
     */
    failure?: string
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

const DEP_FIELDS = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies'
] as const

/** A declared value that is a real, installable npm semver range — not a
 *  wildcard (which pins nothing) and not a non-registry protocol (which is not
 *  an `install <pkg>@<range>` target). */
function isUsableRange(range: string): boolean {
    const r = range.trim()
    if (r.length === 0 || r === '*' || r === 'x' || r === 'latest') return false
    if (/^(?:workspace|link|file|git|github|http|https|portal|patch|npm):/i.test(r)) return false
    return true
}

/** What a project's package.json says about one package, whether or not the
 *  value is something the install path could use. */
export interface Declaration {
    /** The dependency-map KEY the declaration was found under. */
    pkg: string
    /** Its value, trimmed — `^1.2.0`, `latest`, `workspace:*`. */
    value: string
    /** False for dist-tags, wildcards and non-registry protocols. */
    usable: boolean
}

/**
 * The names a declaration for `asked` can honestly live under, nearest first:
 * the package itself, its DefinitelyTyped package, and the terminal the type
 * resolution chain landed on. A project that uses Bun declares `@types/bun`, not
 * `bun`; asking only about the terminal `bun-types` finds nothing at all, which
 * is how 35 of run 20's 48 banners came to report on a package nobody asked
 * about.
 */
export function declarationChain(asked: string, resolved?: string): string[] {
    const out = [asked]
    const types = typesPackageName(asked)
    if (types && !out.includes(types)) out.push(types)
    if (resolved && !out.includes(resolved)) out.push(resolved)
    return out
}

/**
 * The first declaration for any name in `names`, searching the four standard
 * dependency maps of `cwd`'s package.json. A USABLE declaration always wins;
 * only if none of the names has one does an unusable declaration (a dist-tag or
 * a non-registry protocol) come back, so the caller can tell "declared as
 * `latest`" apart from "not declared at all" — two different facts that used to
 * produce the same sentence. Returns null when no name appears anywhere, or the
 * package.json is missing or unparseable. Best-effort; never throws.
 */
export function findDeclaration(names: string[], cwd: string): Declaration | null {
    let json: Record<string, unknown>
    try {
        json = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<
            string,
            unknown
        >
    } catch {
        return null
    }
    let unusable: Declaration | null = null
    for (const name of names) {
        for (const field of DEP_FIELDS) {
            const map = json[field]
            if (!map || typeof map !== 'object') continue
            const range = (map as Record<string, unknown>)[name]
            if (typeof range !== 'string') continue
            const value = range.trim()
            if (isUsableRange(value)) return {pkg: name, value, usable: true}
            unusable ??= {pkg: name, value, usable: false}
        }
    }
    return unusable
}

/**
 * The version range a project DECLARES for `parentPkg` in its package.json under
 * `cwd`. Lets a not-yet-installed scaffolding dependency be documented against
 * the major the project intends, instead of whatever npm currently tags
 * `latest`. Returns null — caller falls back to latest — when the dep is
 * undeclared, the package.json is missing/unreadable, or the declared value is
 * not a usable range.
 *
 * This is the INSTALL target and takes one name deliberately: `npm install
 * <parentPkg>@<range>` must use the range declared for `parentPkg` itself.
 * `@types/bun`'s range is not `bun`'s. The banner's wider, chain-aware question
 * is `findDeclaration`; keeping them apart is what stops a wording fix from
 * silently changing what gets installed.
 */
export function findDeclaredRange(parentPkg: string, cwd: string): string | null {
    const found = findDeclaration([parentPkg], cwd)
    return found?.usable === true ? found.value : null
}

/**
 * One-line version-provenance banner that LEADS a docs answer for a package the
 * worker had to auto-install (not yet present in node_modules — every
 * scaffolding task). Surfaces the version the answer is grounded in directly in
 * the prose the impl model reads, rather than burying it in tool `details`.
 * Empty string when there was no auto-install (already-installed packages need
 * no banner — their version is the project's own).
 *
 * `resolved` is the package the types were finally read from — the TERMINAL of
 * the redirect chain. The banner names `pin.asked`, the package the caller asked
 * about, and mentions the terminal only as provenance: a project can declare
 * `bun`, and cannot declare `bun-types`, so a sentence about what package.json
 * does or does not say has to be a sentence about `bun`.
 */
export function buildVersionBanner(
    pin: AutoInstallPin | undefined,
    resolved: string,
    version: string,
    cwd: string
): string {
    if (!pin) return ''
    const asked = pin.asked ?? resolved
    const grounded = resolved !== asked ? ` The types this answer reads come from ${resolved}.` : ''
    if (pin.source === 'declared-range') {
        return (
            `[VERSION] "${asked}" resolved to this project's declared range `
            + `${pin.range} (installed v${version}); the answer below is pinned to that `
            + `version.${grounded}\n\n`
        )
    }
    // The install fell back to npm latest. A usable declaration can still exist
    // further along the chain (`@types/<name>`) — it did not pin THIS install, so
    // the banner reports it as provenance, not as a pin.
    const decl = findDeclaration(declarationChain(asked, resolved), cwd)
    // Declared, but as a dist-tag or a non-registry protocol. That is NOT the
    // same fact as undeclared: the project did say what it wants, `latest` is
    // exactly what this answer is grounded in, and so there is no other major to
    // confirm and nothing to hold as unverified. Only the SENTENCE splits —
    // `isUsableRange` still rejects the value and the install path still cannot
    // use it as an `install <pkg>@<range>` target.
    if (decl && !decl.usable) {
        const where = decl.pkg === asked ? '' : ` only through ${decl.pkg},`
        return (
            `[VERSION] "${asked}" is declared in this project's package.json${where} as `
            + `\`${decl.value}\` — a moving tag, not a pinned range — so this answer is based `
            + `on npm latest (v${version}), which is what that declaration resolves to `
            + `today.${grounded}\n\n`
        )
    }
    // A usable range on the ASKED name with an npm-latest pin means package.json
    // gained the declaration between the install and this sentence. Rare, but the
    // alternative wording would flatly contradict itself.
    if (decl?.usable === true && decl.pkg === asked) {
        return (
            `[VERSION — verify] "${asked}" is declared as ${decl.value}, but this answer is `
            + `based on npm latest (v${version}) — the install was not pinned to that range. `
            + `Confirm the version you intend before relying on an API that differs across `
            + `majors.${grounded}\n\n`
        )
    }
    const via =
        decl?.usable === true ? ` — only its types are, as ${decl.pkg} ${decl.value} —` : ','
    return (
        `[VERSION — verify] "${asked}" is not declared in this project's package.json${via} `
        + `so this answer is based on npm latest (v${version}). Your project may target a `
        + `different MAJOR — confirm the version you intend to install and treat any API that `
        + `differs across majors as unverified until you check it against that version.${grounded}\n\n`
    )
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

/**
 * Options rather than a positional tail: `signal` and `versionRange` sat adjacent,
 * and reaching the range meant writing `undefined` into the signal slot — which is
 * exactly how the primary acquisition path lost its abort signal while the hop path
 * kept it.
 */
export interface AutoInstallOptions {
    signal?: AbortSignal | undefined
    versionRange?: string | undefined
}

export async function runAutoInstall(
    spawn: SpawnFn,
    packageName: string,
    opts: AutoInstallOptions = {}
): Promise<{success: boolean; installDir: string; stderr: string}> {
    const {signal, versionRange} = opts
    const installDir = getDocsModulesDir()
    ensureDocsModulesDir(installDir)
    // `shell: false` in runChild, so a `^`/`~`/space in the range stays a single
    // literal arg — no glob/expansion risk from `<pkg>@<range>`.
    const target = versionRange ? `${packageName}@${versionRange}` : packageName
    // `--ignore-scripts` is not optional here. The package NAME is model-chosen —
    // it comes out of a worker's question, or out of a `/// <reference types="X" />`
    // line in someone else's declaration file — so a hallucinated or typosquatted
    // name would otherwise run its preinstall/postinstall as the user. This cache
    // has already run install hooks for `node`, `argon2`, `onnxruntime-node` and
    // `sharp`, next to fetched names like `app.ts`, `pkg.json` and `tsconfig.json`.
    // Nothing is lost: the docs worker only ever READS `.d.ts` files and the README
    // out of the installed tree, and those ship in the tarball.
    const result = await runChild(
        spawn,
        {
            command: 'npm',
            args: [
                'install',
                '--ignore-scripts',
                '--no-audit',
                '--no-fund',
                '--loglevel=error',
                target
            ]
        },
        installDir,
        signal,
        {mode: 'text', discardStdout: true}
    )
    return {success: result.exitCode === 0 && !result.aborted, installDir, stderr: result.stderr}
}

/** What acquiring one package produced, or the stage at which it failed. */
export type AcquireOutcome =
    | {ok: true; pkg: ResolvedPackage; autoInstalled: boolean; pin?: AutoInstallPin}
    | {ok: false; stage: 'resolve'; err: unknown}
    | {ok: false; stage: 'install'; stderr: string; pin: AutoInstallPin; asked: string}
    | {ok: false; stage: 'reresolve'; err: unknown; pin: AutoInstallPin}

export interface AcquireInput {
    /** The specifier to resolve. May be a subpath (`pkg/sub`) — the INSTALL always
     *  targets its parent package. */
    name: string
    cwd: string
    spawn: SpawnFn
    resolvePackage: typeof defaultResolvePackage
    signal: AbortSignal | undefined
}

/**
 * Get a package onto disk and resolved: resolve from `cwd`, and on
 * `not_installed` install it — at the range the PROJECT declares when it declares
 * one — then resolve again from the install dir.
 *
 * One statement of the ladder, for both callers. It was written twice: inline in
 * `docsRaw` for the requested package, and in `tryResolveOrInstall` for each hop
 * of the type-redirect chain — and the copies had drifted on all three things
 * that matter.
 *
 *  - The abort signal. The hop copy passed it; the primary copy passed a bare
 *    `undefined` placeholder to reach the fourth positional, while
 *    `DocsRawInput.signal` was honoured on either side of that call. So a user
 *    cancel during the MAIN `npm install` of a model-chosen package was not
 *    delivered. `runAutoInstall` takes an options object now, so a hole like that
 *    cannot be typed.
 *  - The version pin. `findDeclaredRange` had exactly one call site — the primary
 *    copy. The hop copy installed `latest` unconditionally, on the hop most likely
 *    to be the declared one: `declarationChain` exists precisely because "a
 *    project that uses Bun declares `@types/bun`, not `bun`".
 *  - The provenance. `autoInstalled`/`autoInstallPin` were locals of `docsRaw`, so
 *    a package acquired only through a hop reported neither and got no version
 *    banner.
 *
 * CONTEXT.md records the redirect WALK as unified (`resolveTypeSource`) and its
 * `resolveHop` seam as "the one thing its two call sites disagree about". They
 * should disagree only about WHETHER to install, never about HOW.
 */
export async function acquirePackage(input: AcquireInput): Promise<AcquireOutcome> {
    const {name, cwd, spawn, resolvePackage, signal} = input
    try {
        return {ok: true, pkg: resolvePackage(name, cwd), autoInstalled: false}
    } catch (firstErr) {
        if (!(firstErr instanceof ResolveError) || firstErr.kind !== 'not_installed') {
            return {ok: false, stage: 'resolve', err: firstErr}
        }
        // Auto-install — but FIRST honour the version the project intends. If the
        // dep is declared in the project's package.json, install that range so a
        // scaffolding answer is grounded in the project's major, not whatever npm
        // currently tags `latest`.
        const asked = extractParentPackage(name)
        const declaredRange = findDeclaredRange(asked, cwd)
        const pin: AutoInstallPin =
            declaredRange ?
                {source: 'declared-range', range: declaredRange, asked}
            :   {source: 'npm-latest', asked}
        const install = await runAutoInstall(spawn, asked, {
            signal,
            versionRange: declaredRange ?? undefined
        })
        if (!install.success) {
            return {ok: false, stage: 'install', stderr: install.stderr, pin, asked}
        }
        try {
            return {
                ok: true,
                pkg: resolvePackage(name, install.installDir),
                autoInstalled: true,
                pin
            }
        } catch (retryErr) {
            return {ok: false, stage: 'reresolve', err: retryErr, pin}
        }
    }
}

/** Resolve `name` from cwd; on `not_installed`, auto-install it and resolve from
 *  the install dir. Returns null on any failure (caller keeps its fallback). */
async function tryResolveOrInstall(
    name: string,
    cwd: string,
    spawn: SpawnFn,
    resolvePackage: typeof defaultResolvePackage,
    signal: AbortSignal | undefined,
    onAcquired?: (pin: AutoInstallPin | undefined) => void
): Promise<ResolvedPackage | null> {
    const got = await acquirePackage({name, cwd, spawn, resolvePackage, signal})
    if (!got.ok) return null
    if (got.autoInstalled) onAcquired?.(got.pin)
    return got.pkg
}

/** The docs pipeline's adapter over the shared redirect walk (docs-resolve.ts):
 *  hops resolve through the auto-installing lookup, so a declaration package that is
 *  declared but not yet on disk is fetched rather than abandoned. */
async function resolveTypeSourceForDocs(
    pkg: ResolvedPackage,
    requested: string,
    cwd: string,
    spawn: SpawnFn,
    resolvePackage: typeof defaultResolvePackage,
    signal: AbortSignal | undefined
): Promise<{pkg: ResolvedPackage; installed: boolean; pin?: AutoInstallPin}> {
    // A package acquired ONLY through a hop used to report neither `autoInstalled`
    // nor a pin, so `pi-worker-docs` emitted no version banner for it — while the
    // banner's own text ("only its types are, as `@types/bun` `^1.2`") claims a
    // range as provenance. Report the last hop that actually installed.
    let installed = false
    let pin: AutoInstallPin | undefined
    const out = await resolveTypeSource(pkg, extractParentPackage(requested), next =>
        tryResolveOrInstall(next, cwd, spawn, resolvePackage, signal, hopPin => {
            installed = true
            pin = hopPin
        })
    )
    return pin ? {pkg: out, installed, pin} : {pkg: out, installed}
}

export async function docsRaw(input: DocsRawInput): Promise<DocsRawResult> {
    const resolvePackage = input.resolvePackage ?? defaultResolvePackage
    const ensureIndexed = input.ensureIndexed ?? defaultEnsureIndexed
    const retrieveChunks = input.retrieveChunks ?? defaultRetrieveChunks
    const openCache = input.openCache ?? defaultOpenCache
    const spawn = input.spawn ?? (defaultSpawn as unknown as SpawnFn)
    const npmVersionLookup = input.npmVersionLookup ?? defaultNpmVersionLookup

    // A runtime builtin specifier (`bun:sql`, `node:fs`) is typed by the runtime's
    // own types package, not a literal package of that colon-name — so resolve the
    // runtime instead. This is what turns a `bun:sql` lookup into Bun's real SQL
    // surface (`declare module "bun"` → `const sql: SQL`) rather than an
    // `invalid_name` error, and it lets the docs tool disprove a phantom submodule.
    const requested = splitRuntimeNamespace(input.pkg)?.runtime ?? input.pkg

    // Fire the npm registry lookup in parallel with resolve/index/retrieve.
    // It returns null on any failure, so it never blocks the local pipeline.
    const npmVersionPromise = npmVersionLookup(extractParentPackage(requested), {
        signal: input.signal
    }).catch<NpmVersionInfo | null>(() => null)

    // Step 1: acquire the package — resolve, or install-at-the-declared-range and
    // resolve again. The ladder is `acquirePackage`; this maps its stages onto the
    // rich error results the docs tool reports. `input.signal` now reaches the
    // install, which it never did while the range was a fourth positional.
    const got = await acquirePackage({
        name: requested,
        cwd: input.cwd,
        spawn,
        resolvePackage,
        signal: input.signal
    })
    if (!got.ok) {
        if (got.stage === 'install') {
            return {
                kind: 'error',
                message: `Package "${got.asked}" is not installed and auto-install failed.\n${got.stderr}`,
                resolveError: 'not_installed',
                installError: got.stderr,
                autoInstallPin: got.pin,
                npmVersion: await npmVersionPromise
            }
        }
        if (got.stage === 'reresolve') {
            if (got.err instanceof ResolveError) {
                return {
                    kind: 'error',
                    message: got.err.message,
                    resolveError: got.err.kind,
                    autoInstalled: true,
                    autoInstallPin: got.pin,
                    npmVersion: await npmVersionPromise
                }
            }
            return {
                kind: 'error',
                message: `Could not resolve "${input.pkg}" after install: ${got.err instanceof Error ? got.err.message : String(got.err)}`,
                autoInstalled: true,
                autoInstallPin: got.pin,
                npmVersion: await npmVersionPromise
            }
        }
        if (got.err instanceof ResolveError) {
            return {
                kind: 'error',
                message: got.err.message,
                resolveError: got.err.kind,
                npmVersion: await npmVersionPromise
            }
        }
        return {
            kind: 'error',
            message: `Could not resolve "${input.pkg}": ${got.err instanceof Error ? got.err.message : String(got.err)}`,
            npmVersion: await npmVersionPromise
        }
    }
    let pkg: ResolvedPackage = got.pkg
    let autoInstalled = got.autoInstalled
    let autoInstallPin: AutoInstallPin | undefined = got.pin

    // Step 1b: if the resolved package ships no usable type declarations (e.g.
    // the `bun` runtime launcher, which is just a binary + install README), or is
    // a pure `@types/<name>` redirect stub, follow the conventional
    // @types/<name> + triple-slash `<reference types>` chain to the package that
    // actually holds the declarations (e.g. bun -> @types/bun -> bun-types).
    // Best-effort: any failure leaves the original resolution untouched.
    const viaTypes = await resolveTypeSourceForDocs(
        pkg,
        requested,
        input.cwd,
        spawn,
        resolvePackage,
        input.signal
    )
    pkg = viaTypes.pkg
    if (viaTypes.installed) {
        autoInstalled = true
        autoInstallPin ??= viaTypes.pin
    }

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
    if (autoInstallPin && result.kind !== 'not_installed') result.autoInstallPin = autoInstallPin
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
    const extraction = await runFocusedExtraction({
        prompt: buildPrompt(pkg, input.query, concatenated),
        // Exactly what went into the prompt — this path prompts with the whole concatenation,
        // so the verify target and the prompt content are the same text.
        verifyAgainst: concatenated,
        cwd: input.cwd,
        signal: input.signal,
        spawn,
        abortedMessage: 'Docs lookup aborted.'
    })

    const base = {
        pkg,
        version: pkg.version,
        exitCode: extraction.exitCode,
        aborted: extraction.aborted,
        stderr: extraction.stderr,
        hitCache,
        indexingMs,
        chunksRetrieved: chunks.length,
        autoInstalled: rawResult.autoInstalled,
        npmVersion: rawResult.npmVersion
    }

    // A failed child yields NO answer. The caller (phaseAutoAnswer) gates on `answer` being
    // non-empty, so an empty one keeps a dead child's output out of the spec entirely;
    // `failure` carries the reason for anyone who wants to report it.
    if (!extraction.ok) return {answer: '', failure: extraction.failure, ...base}

    return {
        answer: extraction.answer,
        excerpt: extraction.excerpt,
        excerptVerified: extraction.excerptVerified,
        excerptCheck: extraction.excerptCheck,
        ...base
    }
}

export function buildPrompt(pkg: ResolvedPackage, query: string, content: string): string {
    return buildExtractionPrompt({
        kind: 'package',
        subject: 'an npm package',
        tag: 'package',
        identity: `${pkg.name}@${pkg.version}`,
        query,
        content
    })
}

// ─── Backward-compatible wrappers (thin — delegates to shared/) ─────────────

/** Thin wrapper so existing callers using the pkg-based signature still work. */
/**
 * The provenance header a docs answer carries. Takes the HEADER, not a package:
 * the whole body is one string, and the project-source path — which has no
 * package — used to fabricate a `ResolvedPackage`
 * (`{name, version: 'local', root, entryDts: null, readme: null}`) purely to make
 * this call compile, with three of the five fields existing only for that.
 */

/** The header for an npm package answer. */
export function packageHeader(pkg: ResolvedPackage): string {
    return `Per ${pkg.name}@${pkg.version}:`
}
