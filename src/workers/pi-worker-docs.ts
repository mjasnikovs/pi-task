import {Type} from '@sinclair/typebox'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {openCache as defaultOpenCache} from './docs-cache.js'
import {ensureIndexed as defaultEnsureIndexed} from './docs-index.js'
import {resolvePackage as defaultResolvePackage} from './docs-resolve.js'
import {retrieveChunks as defaultRetrieveChunks} from './docs-retrieve.js'
import {
    docsRaw,
    formatResultText,
    buildPrompt,
    buildVersionBanner,
    type AutoInstallPin
} from './docs-core.js'
import {
    npmVersionLookup as defaultNpmVersionLookup,
    formatNpmVersionSection
} from './npm-version.js'
import {type SpawnFn, runChild} from '../shared/child-process.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {parseChildOutput, isExcerptInContent} from '../shared/child-output.js'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {formatChildFailure, makeWorkerTool} from './shared.js'
import {isTypeOnlyAnswer} from '../task/type-only-answer.js'
import {normalizeQuery} from './research-cache.js'
import {projectDocsRaw, buildProjectPrompt} from './docs-project.js'

const childArgs = (): string[] => [...childBaseArgs(), '--no-tools']

const RENDER_QUERY_MAX = 100

const Params = Type.Object({
    module: Type.String({
        description:
            'Bare npm module name (e.g. "zod", "@scope/name", "react/jsx-runtime"), OR "." to look up the current project\'s own source code. npm packages must be installed in node_modules.'
    }),
    query: Type.String({
        description:
            'What to extract from the docs. The child pi reads ranked chunks and returns ONLY content answering this.'
    })
})

interface DocsDetails {
    version?: string
    hitCache?: boolean
    chunksRetrieved?: number
    excerptVerified?: boolean
    childExitCode?: number
    indexingMs?: number
    indexedFiles?: number
    resolveError?: 'not_installed' | 'invalid_name'
    cacheError?: string
    aborted?: boolean
    autoInstalled?: boolean
    installError?: string
    npmLatest?: string
    npmPublishedAt?: string
    versionSource?: 'declared-range' | 'npm-latest'
    declaredRange?: string
    /**
     * The answer restated a declaration for a question that needed usage semantics, so it
     * is UNANSWERED (F-2). Set by isTypeOnlyAnswer; read by `cacheable` so a non-answer is
     * never memoised and re-served to a later sibling task.
     */
    typeOnly?: boolean
}

/**
 * Pull `@see {@link https://…}` pointers out of retrieved .d.ts/README text.
 *
 * F-2(d): the answer to a type-only lookup usually is not in the package at all — it lives
 * at the `@see` URL that the very excerpt being returned already carries. In run 15,
 * hono.dev appeared in cache values ONLY inside these JSDoc links, and was never fetched.
 * Surfacing the link is therefore free: the pointer is already in hand.
 */
export function extractSeeUrls(content: string): string[] {
    const out: string[] = []
    const re = /@see\s*\{?\s*@?link\s+(https?:\/\/[^}\s)]+)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(content)) !== null) {
        const url = m[1].replace(/[.,;]+$/, '')
        if (!out.includes(url)) out.push(url)
    }
    return out
}

/**
 * The package NAME a module specifier belongs to — `hono/client` → `hono`,
 * `@scope/name/sub` → `@scope/name`. The cache stores this (not the raw specifier) as an
 * entry's package provenance, so a subpath lookup is matched against package.json's key
 * and invalidated with its package rather than living forever unmatched.
 */
export function packageRootOf(module: string): string {
    const parts = module.trim().split('/')
    return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

function pinDetails(pin?: AutoInstallPin): Pick<DocsDetails, 'versionSource' | 'declaredRange'> {
    return pin ? {versionSource: pin.source, declaredRange: pin.range} : {}
}

export interface PiWorkerDocsInternals {
    resolvePackage?: typeof defaultResolvePackage
    ensureIndexed?: typeof defaultEnsureIndexed
    retrieveChunks?: typeof defaultRetrieveChunks
    openCache?: typeof defaultOpenCache
    spawn?: SpawnFn
    npmVersionLookup?: typeof defaultNpmVersionLookup
}

export function registerPiWorkerDocs(
    pi: ExtensionAPI,
    internals: PiWorkerDocsInternals = {}
): void {
    makeWorkerTool<typeof Params, DocsDetails>(pi, {
        name: 'pi-worker-docs',
        label: 'Pi Worker Docs',
        description:
            'Look up an INSTALLED npm package and return a focused, version-pinned '
            + 'answer from its .d.ts types and README, PLUS the latest published version '
            + 'from a live npm registry call. USE THIS BEFORE ANSWERING any question '
            + 'about how to use a library, what it exports, its types/overloads/config, '
            + 'or the latest published version of an npm package. Do NOT answer package '
            + 'APIs from memory, do NOT run `npm view`/bash to get a package version, and '
            + 'do NOT web-search for an installed package — this tool is the source of '
            + 'truth and is version-pinned to what is actually installed (training-data '
            + 'versions and APIs are typically months stale).\n'
            + 'For a non-package framework/runtime version (e.g. Node.js, Ubuntu), use '
            + '`pi-worker-search` instead. If the package is not installed it is '
            + 'auto-installed via bun add or npm install. The cache lives at '
            + '~/.cache/pi-worker/docs.sqlite, keyed by exact installed version; the '
            + 'registry lookup is best-effort and silently absent when offline.\n'
            + '\n'
            + 'Pass module: "." to look up the CURRENT PROJECT\'S OWN SOURCE CODE instead '
            + 'of an npm package. USE THIS when asked about what a function, class, type, '
            + 'or module in this project does or exports — e.g. "what does orchestrator.ts '
            + 'export?", "how does the requireAuth middleware work?", "what props does '
            + 'ListingCard accept?". The project source is indexed from git-tracked .ts/.tsx '
            + 'files and cached by max file mtime — always reflects the current state of '
            + 'the working tree.\n'
            + '\n'
            + 'Good fits:\n'
            + '- "What does library X export?" / "How does function Y work?"\n'
            + '- Confirming generic shapes, overload sets, exported types\n'
            + '- Pulling README configuration prose without burning context on raw markdown\n'
            + '- Checking the current latest published version of a package\n'
            + '- "What does src/X.ts export?" / "How does this project\'s Y function work?"\n'
            + '\n'
            + 'Skip when:\n'
            + '- You need docs for a specific newer version than what is installed — use pi-worker-fetch on the upstream docs site',
        parameters: Params,

        async run(params, signal, ctx) {
            const spawn =
                internals.spawn
                ?? (globalThis.Bun !== undefined ?
                    (globalThis.Bun.spawn as unknown as SpawnFn)
                :   ((await import('node:child_process')).spawn as unknown as SpawnFn))

            // ── Project source lookup ───────────────────────────────────────
            if (params.module === '.') {
                const openCache = internals.openCache ?? defaultOpenCache
                let cache
                let cacheError: string | undefined
                try {
                    cache = openCache()
                } catch (err) {
                    cacheError = err instanceof Error ? err.message : String(err)
                }

                if (!cache) {
                    return {
                        text: `Project docs unavailable: cache open failed (${cacheError}).`,
                        details: {}
                    }
                }

                const retrieveChunks = internals.retrieveChunks ?? defaultRetrieveChunks
                const projectResult = projectDocsRaw(cache, ctx.cwd, params.query, retrieveChunks)

                if (projectResult.kind === 'error') {
                    return {text: `Project docs error: ${projectResult.message}`, details: {}}
                }
                if (projectResult.kind === 'no_chunks') {
                    return {
                        text: `Project "${projectResult.projectName}" has no .ts/.tsx files indexed.`,
                        details: {
                            hitCache: projectResult.hitCache,
                            indexedFiles: projectResult.filesIngested
                        }
                    }
                }

                const {projectName, chunks, hitCache, filesIngested, indexingMs} = projectResult
                const baseDetails: DocsDetails = {
                    hitCache,
                    chunksRetrieved: chunks.length,
                    indexedFiles: filesIngested,
                    indexingMs
                }
                const concatenated = chunks.map(c => c.content).join('\n\n')
                const prompt = buildProjectPrompt(projectName, params.query, concatenated)
                const invocation = getPiInvocation(childArgs(), prompt)
                const child = await runChild(spawn, invocation, ctx.cwd, signal)

                const failure = formatChildFailure(child, 'Project docs lookup aborted.')
                if (failure !== null) {
                    return {
                        text: failure,
                        details: {
                            ...baseDetails,
                            ...(child.aborted ? {aborted: true} : {}),
                            childExitCode: child.exitCode
                        }
                    }
                }

                const parsed = parseChildOutput(child.stdout)
                const verified =
                    parsed.excerpt ? isExcerptInContent(parsed.excerpt, concatenated) : undefined
                const text = formatResultText(
                    {
                        name: projectName,
                        version: 'local',
                        root: ctx.cwd,
                        entryDts: null,
                        readme: null
                    },
                    parsed,
                    verified
                )
                return {
                    text,
                    details: {
                        ...baseDetails,
                        childExitCode: 0,
                        excerptVerified: verified
                    }
                }
            }

            // ── npm package lookup (existing path) ──────────────────────────
            const rawResult = await docsRaw({
                pkg: params.module,
                query: params.query,
                cwd: ctx.cwd,
                resolvePackage: internals.resolvePackage,
                ensureIndexed: internals.ensureIndexed,
                retrieveChunks: internals.retrieveChunks,
                openCache: internals.openCache,
                spawn,
                npmVersionLookup: internals.npmVersionLookup,
                signal
            })

            const npmHeader =
                rawResult.npmVersion ? `${formatNpmVersionSection(rawResult.npmVersion)}\n\n` : ''
            const npmDetails =
                rawResult.npmVersion ?
                    {
                        npmLatest: rawResult.npmVersion.latest,
                        npmPublishedAt: rawResult.npmVersion.publishedAt
                    }
                :   {}

            if (rawResult.kind === 'error') {
                const details: DocsDetails = {
                    resolveError: rawResult.resolveError,
                    installError: rawResult.installError,
                    version: rawResult.version,
                    hitCache: rawResult.hitCache,
                    cacheError: rawResult.cacheError,
                    autoInstalled: rawResult.autoInstalled,
                    ...npmDetails
                }
                return {text: npmHeader + rawResult.message, details}
            }

            if (rawResult.kind === 'not_installed') {
                return {
                    text:
                        npmHeader
                        + `Package "${rawResult.pkg}" is not installed and auto-install failed.`,
                    details: {resolveError: 'not_installed' as const, ...npmDetails}
                }
            }

            if (rawResult.kind === 'no_chunks') {
                const banner = buildVersionBanner(
                    rawResult.autoInstallPin,
                    rawResult.pkg.name,
                    rawResult.pkg.version
                )
                return {
                    text:
                        banner
                        + npmHeader
                        + `Package ${rawResult.pkg.name}@${rawResult.pkg.version} has no .d.ts files or README. Use pi-worker to read source directly.`,
                    details: {
                        version: rawResult.pkg.version,
                        hitCache: rawResult.hitCache,
                        indexedFiles: rawResult.indexedFiles ?? 0,
                        cacheError: rawResult.cacheError,
                        autoInstalled: rawResult.autoInstalled,
                        ...pinDetails(rawResult.autoInstallPin),
                        ...npmDetails
                    }
                }
            }

            // kind === 'ok'
            const {pkg, chunks, hitCache, indexingMs, cacheError, autoInstalled} = rawResult
            const versionBanner = buildVersionBanner(
                rawResult.autoInstallPin,
                pkg.name,
                pkg.version
            )
            const baseDetails: DocsDetails = {
                version: pkg.version,
                hitCache,
                chunksRetrieved: chunks.length,
                indexingMs,
                cacheError,
                autoInstalled,
                ...pinDetails(rawResult.autoInstallPin),
                ...npmDetails
            }

            const concatenated = chunks.map(c => c.content).join('\n\n')
            const prompt = buildPrompt(pkg, params.query, concatenated)
            const invocation = getPiInvocation(childArgs(), prompt)
            const child = await runChild(spawn, invocation, ctx.cwd, signal)

            const failure = formatChildFailure(child, 'Docs lookup aborted.')
            if (failure !== null) {
                return {
                    text: versionBanner + npmHeader + failure,
                    details: {
                        ...baseDetails,
                        ...(child.aborted ? {aborted: true} : {}),
                        childExitCode: child.exitCode
                    }
                }
            }

            const parsed = parseChildOutput(child.stdout)
            const verified =
                parsed.excerpt ? isExcerptInContent(parsed.excerpt, concatenated) : undefined
            const body = formatResultText(pkg, parsed, verified)

            // F-2: a TYPE-ONLY answer is the dangerous failure. "unclear from this package"
            // is honest and already escalates; a signature is a well-formed, confident,
            // on-topic answer that names the very parameter asked about, so the worker
            // stops — and worker:context then fills the semantic gap from memory (F-1).
            // Measured: 14 of 17 live reps terminated on exactly this shape.
            //
            // The retrieved type is KEPT (it is real and useful) and an UNANSWERED banner
            // is prepended, naming the gap and — when the excerpt carries one — the `@see`
            // URL that actually documents the semantics. That pointer is free: F-2(d) found
            // hono.dev present in run-15 cache values ONLY inside these JSDoc links, never
            // fetched. Prompting the escalation beats performing it here: this tool runs in
            // parallel execution mode and cannot cleanly spawn a fetch of its own.
            const typeOnly = isTypeOnlyAnswer(parsed.answer, params.query)
            let text = versionBanner + npmHeader + body
            if (typeOnly.typeOnly) {
                const seeUrls = extractSeeUrls(concatenated)
                text =
                    versionBanner
                    + npmHeader
                    + 'UNANSWERED — TYPE-ONLY: the package gave a declaration, not the '
                    + 'usage semantics this question needs. A signature says what the '
                    + 'parameter IS, not what it MEANS. Do NOT answer from memory and do '
                    + 'NOT treat the type below as the answer.\n'
                    + (seeUrls.length > 0 ?
                        `NEXT STEP: the retrieved excerpt itself cites documentation — `
                        + `fetch ${seeUrls[0]} (pi-worker-fetch) and re-ask this same `
                        + `question.\n`
                    :   'NEXT STEP: use pi-worker-search / pi-worker-fetch for the official '
                        + 'documentation of this API, then re-ask this same question.\n')
                    + '\nThe declaration that WAS retrieved (context only, not the answer):\n'
                    + body
            }

            return {
                text,
                details: {
                    ...baseDetails,
                    childExitCode: 0,
                    excerptVerified: verified,
                    ...(typeOnly.typeOnly ? {typeOnly: true} : {})
                }
            }
        },

        renderCall(args, theme) {
            const query = args.query.replace(/\s+/g, ' ').trim()
            const truncated =
                query.length > RENDER_QUERY_MAX ? `${query.slice(0, RENDER_QUERY_MAX - 1)}…` : query
            const label = args.module === '.' ? 'project' : args.module
            let text = theme.fg('toolTitle', theme.bold('pi-worker-docs '))
            text += theme.fg('accent', label)
            text += `\n${theme.fg('dim', `  query: ${truncated}`)}`
            return new Text(text, 0, 0)
        },

        // Cache npm-package answers per run (a package's installed types/README + latest
        // version do not change within a run). A project-source `.` lookup is NOT cached:
        // the working tree mutates as tasks implement, so its answer can go stale mid-run
        // (the docs SQLite index already keys those on file mtime).
        cacheKey: params =>
            params.module === '.' ?
                null
            :   `${normalizeQuery(params.module)}::${normalizeQuery(params.query)}`,
        // Package provenance for per-entry resume invalidation: a docs digest describes
        // one package at one declared version, so a resume drops it only when THAT
        // package moves — an unrelated install no longer discards it. Package names are
        // matched against package.json verbatim (npm names are case-sensitive), unlike
        // the cache key, which normalises for phrasing collisions.
        cachePkg: params => (params.module === '.' ? undefined : packageRootOf(params.module)),
        // Only a completed lookup (child exited 0) is a real answer; not-installed,
        // no-chunks, resolve/cache errors, and aborts omit childExitCode:0 and fall
        // through to a live retry next time.
        //
        // F-2(e): process health is NOT answer quality. A child that ran fine and answered
        // "unclear from this package" exits 0, so the NON-ANSWER was memoised and re-served
        // as a cache hit to every later sibling task — 52 of run 15's cached entries were
        // "unclear" with hitCache true. One dead end, paid for many times, and escalation
        // could never re-fire because the miss never recurred. So a non-answer is now never
        // stored: the next task that asks pays for a real lookup and can escalate.
        //
        // `text` is supplied by makeWorkerTool (shared.ts) alongside details, so the
        // content check needs no new plumbing.
        cacheable: (d, text) =>
            d.childExitCode === 0
            && d.typeOnly !== true
            && d.excerptVerified !== false
            && !/unclear from this package/i.test(text)
    })
}
