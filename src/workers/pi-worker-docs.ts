import {Type} from '@sinclair/typebox'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {openCache as defaultOpenCache} from './docs-cache.js'
import {ensureIndexed as defaultEnsureIndexed} from './docs-index.js'
import {resolvePackage as defaultResolvePackage} from './docs-resolve.js'
import {retrieveChunks as defaultRetrieveChunks} from './docs-retrieve.js'
import {docsRaw, formatResultText, buildPrompt} from './docs-core.js'
import {
    npmVersionLookup as defaultNpmVersionLookup,
    formatNpmVersionSection
} from './npm-version.js'
import {type SpawnFn, runChild, CHILD_BASE_ARGS} from '../shared/child-process.js'
import {parseChildOutput, isExcerptInContent} from '../shared/child-output.js'
import {getPiInvocation} from '../shared/pi-invocation.js'
import {textResult} from './shared.js'

const CHILD_ARGS = [...CHILD_BASE_ARGS, '--no-tools'] as readonly string[]

const RENDER_QUERY_MAX = 100

const Params = Type.Object({
    module: Type.String({
        description:
            'Bare npm module name (e.g. "zod", "@scope/name", "react/jsx-runtime"). Must be installed in the project\'s node_modules.'
    }),
    query: Type.String({
        description:
            'What to extract from the module\'s docs. The child pi reads ranked chunks and returns ONLY content answering this.'
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
    pi.registerTool({
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
            + 'Good fits:\n'
            + '- "What does library X export?" / "How does function Y work?"\n'
            + '- Confirming generic shapes, overload sets, exported types\n'
            + '- Pulling README configuration prose without burning context on raw markdown\n'
            + '- Checking the current latest published version of a package\n'
            + '\n'
            + 'Skip when:\n'
            + '- You need docs for a specific newer version than what is installed — use pi-worker-fetch on the upstream docs site',
        parameters: Params,
        executionMode: 'parallel',

        async execute(
            _toolCallId,
            params,
            signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<DocsDetails>> {
            const spawn =
                internals.spawn
                ?? (globalThis.Bun !== undefined ?
                    (globalThis.Bun.spawn as unknown as SpawnFn)
                :   ((await import('node:child_process')).spawn as unknown as SpawnFn))

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
                return textResult(npmHeader + rawResult.message, details)
            }

            if (rawResult.kind === 'not_installed') {
                return textResult(
                    npmHeader
                        + `Package "${rawResult.pkg}" is not installed and auto-install failed.`,
                    {resolveError: 'not_installed' as const, ...npmDetails}
                )
            }

            if (rawResult.kind === 'no_chunks') {
                return textResult(
                    npmHeader
                        + `Package ${rawResult.pkg.name}@${rawResult.pkg.version} has no .d.ts files or README. Use pi-worker to read source directly.`,
                    {
                        version: rawResult.pkg.version,
                        hitCache: rawResult.hitCache,
                        indexedFiles: rawResult.indexedFiles ?? 0,
                        cacheError: rawResult.cacheError,
                        autoInstalled: rawResult.autoInstalled,
                        ...npmDetails
                    }
                )
            }

            // kind === 'ok'
            const {pkg, chunks, hitCache, indexingMs, cacheError, autoInstalled} = rawResult
            const baseDetails: DocsDetails = {
                version: pkg.version,
                hitCache,
                chunksRetrieved: chunks.length,
                indexingMs,
                cacheError,
                autoInstalled,
                ...npmDetails
            }

            const concatenated = chunks.map(c => c.content).join('\n\n')
            const prompt = buildPrompt(pkg, params.query, concatenated)
            const invocation = getPiInvocation([...CHILD_ARGS, prompt])
            const child = await runChild(spawn, invocation, ctx.cwd, signal)

            if (child.aborted) {
                return textResult(npmHeader + 'Docs lookup aborted.', {
                    ...baseDetails,
                    aborted: true,
                    childExitCode: child.exitCode
                })
            }
            if (child.exitCode !== 0) {
                const tail = child.stderr.trim().slice(-500) || '(no stderr)'
                return textResult(npmHeader + `Worker exited ${child.exitCode}.\n${tail}`, {
                    ...baseDetails,
                    childExitCode: child.exitCode
                })
            }

            const parsed = parseChildOutput(child.stdout)
            const verified =
                parsed.excerpt ? isExcerptInContent(parsed.excerpt, concatenated) : undefined
            const text = npmHeader + formatResultText(pkg, parsed, verified)
            return textResult(text, {
                ...baseDetails,
                childExitCode: 0,
                excerptVerified: verified
            })
        },

        renderCall(args, theme) {
            const query = args.query.replace(/\s+/g, ' ').trim()
            const truncated =
                query.length > RENDER_QUERY_MAX ? `${query.slice(0, RENDER_QUERY_MAX - 1)}…` : query
            let text = theme.fg('toolTitle', theme.bold('pi-worker-docs '))
            text += theme.fg('accent', args.module)
            text += `\n${theme.fg('dim', `  query: ${truncated}`)}`
            return new Text(text, 0, 0)
        }
    })
}
