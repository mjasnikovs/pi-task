import {spawn as defaultSpawn} from 'node:child_process'
import {Type} from '@sinclair/typebox'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {openCache as defaultOpenCache} from './docs-cache.js'
import {ensureIndexed as defaultEnsureIndexed} from './docs-index.js'
import {resolvePackage as defaultResolvePackage} from './docs-resolve.js'
import {retrieveChunks as defaultRetrieveChunks} from './docs-retrieve.js'
import {docsLookup, type DocsCorpus, type DocsLookup} from './docs-lookup.js'
import {projectCorpus} from './docs-project.js'
import {docsRaw, packageCorpus, buildVersionBanner, type AutoInstallPin} from './docs-core.js'
import type {EcosystemId} from './docs-ecosystems.js'
import {
    npmVersionLookup as defaultNpmVersionLookup,
    formatNpmVersionSection
} from './npm-version.js'
import type {SpawnFn} from '../shared/child-process.js'
import type {FocusedFailure} from './focused-extractor.js'
import {
    childFailureReason,
    makeWorkerTool,
    workerAnswer,
    workerUnavailable,
    type CachePackage,
    type WorkerOutcome
} from './shared.js'
import {isTypeOnlyAnswer} from '../task/type-only-answer.js'
import {logDocsAnswer} from './typeonly-log.js'
import {normalizeQuery} from './research-cache.js'
import {projectDocsRaw} from './docs-project.js'
import {projectDocsBudget, projectDocsBudgetExhausted} from '../task/research-fanout-budget.js'
import {isAbstention} from './abstention.js'
import {groupChildArgs} from '../config/group-args.js'

const RENDER_QUERY_MAX = 100

const Params = Type.Object({
    module: Type.String({
        description:
            'Bare package name (e.g. "zod", "@scope/name", "react/jsx-runtime"), OR "." to look up the current project\'s own source code.'
    }),
    query: Type.String({
        description:
            'What to extract from the docs. The child pi reads ranked chunks and returns ONLY content answering this.'
    }),
    ecosystem: Type.Optional(
        Type.Union([Type.Literal('npm'), Type.Literal('cargo')], {
            description:
                'Which registry to read. Only needed in a repo holding more than one package manifest; otherwise the manifest decides.'
        })
    )
})

interface DocsDetails {
    version?: string
    hitCache?: boolean
    chunksRetrieved?: number
    excerptVerified?: boolean
    childExitCode?: number
    indexingMs?: number
    indexedFiles?: number
    resolveError?:
        'not_installed' | 'invalid_name' | 'unsupported_ecosystem' | 'ambiguous_ecosystem'
    cacheError?: string
    aborted?: boolean
    autoInstalled?: boolean
    installError?: string
    npmLatest?: string
    npmPublishedAt?: string
    versionSource?: 'declared-range' | 'npm-latest'
    declaredRange?: string
    /**
     * The answer restated a declaration for a question that needed usage semantics, so
     * it is UNANSWERED. Set by isTypeOnlyAnswer; read by `docsCacheable` so a non-answer
     * is never memoised and re-served to a later sibling task.
     */
    typeOnly?: boolean
    /** The project-lookup budget for this attempt is spent, so the call was refused
     *  before any work. Only set when PI_TASK_PROJECT_DOCS_BUDGET is configured. */
    budgetSpent?: boolean
}

/**
 * Pull `@see {@link https://…}` pointers out of retrieved .d.ts/README text.
 *
 * When the answer to a type-only lookup is not in the package, it is often at the
 * `@see` URL the excerpt being returned already carries. Surfacing that link costs
 * nothing: the pointer is already in hand.
 *
 * Matches `{@link URL}` and a bare `@link URL`, case-insensitively; strips a trailing
 * `.`/`,`/`;` the surrounding prose added; deduplicates. A bare URL with no `@see` is
 * not a pointer and is not returned.
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

/**
 * The tool result for a focused-extraction child that failed, shared by both docs paths.
 * They differ only in `prefix`: the npm path leads every result, failures included, with
 * its version banner and npm-version header; the project path passes ''.
 *
 * It says UNAVAILABLE, so the cache cannot take it. Writing a non-zero `childExitCode`
 * and letting `docsCacheable` re-derive the verdict would fail on the case it matters
 * most for: node reports a signal kill as `close` with `code === null`, and
 * child-process.ts settles that as `code ?? 0` — so an aborted child carries exit code
 * ZERO and `"Docs lookup aborted."` would be cached for the whole run.
 */
function docsFailureResult(
    extraction: FocusedFailure,
    baseDetails: DocsDetails,
    prefix: string
): WorkerOutcome<DocsDetails> {
    return workerUnavailable(
        prefix + extraction.failure,
        {
            ...baseDetails,
            ...(extraction.aborted ? {aborted: true} : {}),
            childExitCode: extraction.exitCode
        },
        childFailureReason({exitCode: extraction.exitCode, aborted: extraction.aborted})
    )
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
    // Project-lookup budget — OFF unless PI_TASK_PROJECT_DOCS_BUDGET is set, and then
    // per-ATTEMPT by construction: the extension is loaded into a fresh pi child on
    // every spawn, so a restarted attempt starts this counter at 0. The budget it
    // enforces is the one the worker was told about in its prompt
    // (projectDocsBudgetNotice). Enforcement without the notice would be a silent
    // tool failure; the notice without enforcement binds nothing.
    let projectLookups = 0
    makeWorkerTool<typeof Params, DocsDetails>(pi, {
        name: 'pi-worker-docs',
        label: 'Pi Worker Docs',
        description:
            'Look up an INSTALLED package and return a focused, version-pinned '
            + 'answer from its type declarations and README, PLUS the latest published '
            + 'version from a live registry call. USE THIS BEFORE ANSWERING any question '
            + 'about how to use a library, what it exports, its types/overloads/config, '
            + 'or the latest published version of a package. Do NOT answer package '
            + 'APIs from memory, do NOT run `npm view`/bash to get a package version, and '
            + 'do NOT web-search for an installed package — this tool is the source of '
            + 'truth and is version-pinned to what is actually installed (training-data '
            + 'versions and APIs are typically months stale).\n'
            + 'SUPPORTED ECOSYSTEMS: npm (package.json), cargo (Cargo.toml). The '
            + 'MANIFEST in the working '
            + 'directory decides which registry a name is looked up in — you do not. If '
            + 'the directory holds none of those manifests, this tool REFUSES and '
            + 'installs nothing; use `pi-worker-search` or `pi-worker-fetch` for that '
            + 'package instead.\n'
            + 'For a non-package framework/runtime version (e.g. Node.js, Ubuntu), use '
            + '`pi-worker-search` instead. If the package is not installed it is '
            + "auto-installed from the project's own registry. The cache lives at "
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
            // Always node:child_process spawn, matching fetch-core and every other
            // worker. `SpawnFn` is the node `(cmd, args, opts)` shape; Bun.spawn takes
            // `([cmd, ...args], opts)` and would throw here.
            const spawn = internals.spawn ?? (defaultSpawn as unknown as SpawnFn)

            // Both arms below run the SAME tail — concatenate, extract, verify,
            // format — through `docsLookup`; only the CORPUS differs. The
            // `extraction` group's level is resolved here so neither the lookup
            // nor the extractor reads ambient config.
            const lookup = (
                corpus: DocsCorpus,
                chunks: ReadonlyArray<{content: string}>
            ): Promise<DocsLookup> =>
                docsLookup({
                    corpus,
                    chunks,
                    query: params.query,
                    cwd: ctx.cwd,
                    signal,
                    spawn,
                    groupArgs: groupChildArgs('extraction')
                })

            // ── Project source lookup ───────────────────────────────────────
            if (params.module === '.') {
                const budget = projectDocsBudget()
                if (budget !== null && ++projectLookups > budget) {
                    // Refused BEFORE any work: the point of the cap is the child
                    // spawn and the model pass this branch would otherwise run.
                    return workerUnavailable(
                        projectDocsBudgetExhausted(budget),
                        {budgetSpent: true},
                        'budget-spent'
                    )
                }
                const openCache = internals.openCache ?? defaultOpenCache
                let cache
                let cacheError: string | undefined
                try {
                    cache = openCache()
                } catch (err) {
                    cacheError = err instanceof Error ? err.message : String(err)
                }

                if (!cache) {
                    return workerUnavailable(
                        `Project docs unavailable: cache open failed (${cacheError}).`,
                        {},
                        'cache-open-failed'
                    )
                }

                const retrieveChunks = internals.retrieveChunks ?? defaultRetrieveChunks
                const projectResult = projectDocsRaw(cache, ctx.cwd, params.query, retrieveChunks)

                if (projectResult.kind === 'error') {
                    return workerUnavailable(
                        `Project docs error: ${projectResult.message}`,
                        {},
                        'project-docs-error'
                    )
                }
                if (projectResult.kind === 'no_chunks') {
                    // The project IS indexed and has nothing — a real answer.
                    return workerAnswer(
                        `Project "${projectResult.projectName}" has no .ts/.tsx files indexed.`,
                        {
                            hitCache: projectResult.hitCache,
                            indexedFiles: projectResult.filesIngested
                        }
                    )
                }

                const {projectName, chunks, hitCache, filesIngested, indexingMs} = projectResult
                const baseDetails: DocsDetails = {
                    hitCache,
                    chunksRetrieved: chunks.length,
                    indexedFiles: filesIngested,
                    indexingMs
                }
                const r = await lookup(projectCorpus(projectName), chunks)
                if (r.kind === 'failed') return docsFailureResult(r.extraction, baseDetails, '')

                const {extraction, excerptVerified: verified, body: text} = r
                // SAME instrumentation channel as the package path below. Both branches
                // record, or "the last docs answer before the worker stopped" is
                // unanswerable whenever the last answer came from the branch that does
                // not log.
                //
                // `typeOnly` is recorded FALSE with an explicit reason rather than by running
                // the detector: this path never applies it, and the record must say what the
                // shipped tool decided, not what it would have decided. Inventing a verdict
                // here would let a firing-rate computed off this sink count answers the lever
                // does not reach.
                logDocsAnswer({
                    module: params.module,
                    query: params.query,
                    answer: extraction.answer,
                    typeOnly: false,
                    reason: 'project-source lookup — the type-only detector is not applied here',
                    excerptVerified: verified,
                    excerptCheck: extraction.excerptCheck,
                    toolText: text
                })
                return workerAnswer(text, {
                    ...baseDetails,
                    excerptVerified: verified
                })
            }

            // ── npm package lookup (existing path) ──────────────────────────
            const rawResult = await docsRaw({
                pkg: params.module,
                query: params.query,
                cwd: ctx.cwd,
                ...(params.ecosystem ? {ecosystem: params.ecosystem} : {}),
                resolvePackage: internals.resolvePackage,
                ensureIndexed: internals.ensureIndexed,
                retrieveChunks: internals.retrieveChunks,
                openCache: internals.openCache,
                spawn,
                npmVersionLookup: internals.npmVersionLookup,
                signal
            })

            const npmHeader =
                rawResult.npmVersion ?
                    `${formatNpmVersionSection(rawResult.npmVersion, rawResult.registryLabel)}\n\n`
                :   ''
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
                    // Carry the pin here as the sibling arms do. Without it a package
                    // that WAS auto-installed and then failed to re-resolve loses its
                    // `versionSource`/`declaredRange`, and the answer cannot say what
                    // version it is grounded in. `docsRaw` sets `autoInstallPin` on
                    // every error return that follows an auto-install.
                    ...pinDetails(rawResult.autoInstallPin),
                    ...npmDetails
                }
                return workerUnavailable(npmHeader + rawResult.message, details, 'docs-error')
            }

            if (rawResult.kind === 'no_chunks') {
                const banner = buildVersionBanner(
                    rawResult.autoInstallPin,
                    rawResult.pkg.name,
                    rawResult.pkg.version,
                    ctx.cwd
                )
                // The package resolved and genuinely ships nothing to read — an
                // answer, and a stable one for this run.
                return workerAnswer(
                    banner
                        + npmHeader
                        + `Package ${rawResult.pkg.name}@${rawResult.pkg.version} has no .d.ts files or README. Use pi-worker to read source directly.`,
                    {
                        version: rawResult.pkg.version,
                        hitCache: rawResult.hitCache,
                        indexedFiles: rawResult.indexedFiles ?? 0,
                        cacheError: rawResult.cacheError,
                        autoInstalled: rawResult.autoInstalled,
                        ...pinDetails(rawResult.autoInstallPin),
                        ...npmDetails
                    }
                )
            }

            const {pkg, chunks, hitCache, indexingMs, cacheError, autoInstalled} = rawResult
            const versionBanner = buildVersionBanner(
                rawResult.autoInstallPin,
                pkg.name,
                pkg.version,
                ctx.cwd
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

            const r = await lookup(packageCorpus(pkg), chunks)
            if (r.kind === 'failed') {
                return docsFailureResult(r.extraction, baseDetails, versionBanner + npmHeader)
            }

            const {extraction, excerptVerified: verified, body, content: concatenated} = r

            // A TYPE-ONLY answer is the dangerous failure. "unclear from this package"
            // is honest and already escalates; a signature is a well-formed, confident,
            // on-topic answer that names the very parameter asked about, so the worker
            // stops asking — and the semantic gap then gets filled from memory.
            //
            // The retrieved type is KEPT (it is real and useful) and an UNANSWERED banner
            // is prepended, naming the gap and — when the excerpt carries one — the `@see`
            // URL that actually documents the semantics. Prompting the escalation beats
            // performing it here: this tool runs in parallel execution mode and cannot
            // cleanly spawn a fetch of its own.
            const typeOnly = isTypeOnlyAnswer(extraction.answer, params.query)
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

            // Off unless PI_TASK_TYPEONLY_LOG names a sink, and side-effect only: nothing
            // below reads it, and every failure inside is swallowed. It records EVERY
            // answer, flagged or not — a log of firings alone would have no denominator to
            // read a rate against. See typeonly-log.ts.
            //
            // It sits AFTER `text` is final, not above `text`'s first assignment,
            // so the record carries what the worker was actually handed, banner and cited
            // excerpt included, not just the child's prose. Position only: logDocsAnswer
            // returns nothing and nothing between the two positions reads it, so the tool's
            // behaviour and its return value are unchanged.
            logDocsAnswer({
                module: params.module,
                query: params.query,
                answer: extraction.answer,
                typeOnly: typeOnly.typeOnly,
                reason: typeOnly.reason,
                excerptVerified: verified,
                excerptCheck: extraction.excerptCheck,
                toolText: text
            })

            return workerAnswer(text, {
                ...baseDetails,
                excerptVerified: verified,
                ...(typeOnly.typeOnly ? {typeOnly: true} : {})
            })
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
        cacheKey: docsCacheKey,
        // Package provenance for per-entry resume invalidation: a docs digest describes
        // one package at one declared version, so a resume drops it only when THAT
        // package moves — an unrelated install no longer discards it. Package names are
        // matched against package.json verbatim (npm names are case-sensitive), unlike
        // the cache key, which normalises for phrasing collisions.
        cachePkg: docsCachePkg,
        // Process health is NOT answer quality, and this rule only judges quality.
        // not-installed, resolve and cache errors, and aborts return `unavailable`, which
        // makeWorkerTool refuses before reaching here. What is left is real answers, and a
        // child that ran fine and answered "unclear from this package" exits 0 — so a rule
        // keyed on exit code would memoise that non-answer and re-serve it as a hit to
        // every later sibling, with nothing left to re-trigger an escalation.
        //
        // `text` is supplied by makeWorkerTool (shared.ts) alongside details, so the
        // content check needs no new plumbing.
        cacheable: docsCacheable
    })
}

/**
 * The cache rule for the docs channel, as a NAMED export rather than an anonymous
 * property of an adapter literal.
 *
 * As a property of the adapter literal it would be reachable only through
 * `registerTool → execute()`, so a test would have to retype the rule and would then
 * assert against its own copy — green even after the shipped rule changed. Exported,
 * the test imports the rule it is checking.
 */
export function docsCacheable(
    d: Pick<DocsDetails, 'typeOnly' | 'excerptVerified'>,
    text: string
): boolean {
    // Answer QUALITY only. Whether there IS an answer is `WorkerOutcome.kind`, and
    // `makeWorkerTool` has already refused an `unavailable` before reaching here —
    // opening this with `childExitCode === 0` memoises an aborted lookup for the
    // whole run, because a signal-killed child satisfies it.
    return d.typeOnly !== true && d.excerptVerified !== false && !isAbstention(text)
}

/** The docs cache key: a package's answer is per (module, question), with the question
 *  lowercased and its whitespace collapsed so phrasing variants share one entry. Returns
 *  null for the project-source `.` lookup, which is never cached — the working tree
 *  mutates as tasks implement.
 *
 *  The ecosystem joins the key only when the caller named one, so the keys of every
 *  call that lets the manifest decide are the ones they always were. */
export function docsCacheKey(params: {
    module: string
    query: string
    ecosystem?: string
}): string | null {
    if (params.module === '.') return null
    const scope = params.ecosystem ? `${params.ecosystem}::` : ''
    return `${scope}${normalizeQuery(params.module)}::${normalizeQuery(params.query)}`
}

/** Package provenance for per-entry resume invalidation: the package ROOT of the
 *  specifier (`hono/client` → `hono`), and undefined for the project-source `.`.
 *
 *  The ecosystem rides along only when the caller named one — an unnamed lookup was
 *  decided by the manifest, and npm is what the cache file reads an absent value as. */
export function docsCachePkg(params: {
    module: string
    ecosystem?: EcosystemId
}): CachePackage | undefined {
    if (params.module === '.') return undefined
    return {
        pkg: packageRootOf(params.module),
        ...(params.ecosystem ? {ecosystem: params.ecosystem} : {})
    }
}
