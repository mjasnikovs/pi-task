import {Type} from '@sinclair/typebox'
import type {EventEmitter} from 'node:events'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {fetchAndClean as defaultFetchAndClean, FetchAndCleanError} from './html-clean.js'
import {fetchFocused, formatResultText} from './fetch-core.js'
import {formatChildFailure, makeWorkerTool} from './shared.js'
import {normalizeQuery} from './research-cache.js'

const RENDER_QUERY_MAX = 100

const Params = Type.Object({
    url: Type.String({description: 'URL to fetch. Must be http or https.'}),
    query: Type.String({
        description:
            'What to extract from the page. The child pi reads the page and returns ONLY content answering this.'
    })
})

interface FetchDetails {
    childExitCode?: number
    answer?: string
    excerpt?: string
    excerptVerified?: boolean
}

interface ProcLike extends EventEmitter {
    stdout: EventEmitter | null
    stderr: EventEmitter | null
    killed: boolean
    kill(signal: string): boolean | void
}

type SpawnFn = (
    command: string,
    args: ReadonlyArray<string>,
    options: {cwd: string; shell: boolean; stdio: ['ignore', 'pipe', 'pipe']}
) => ProcLike

export interface PiWorkerFetchInternals {
    fetchAndClean?: typeof defaultFetchAndClean
    spawn?: SpawnFn
}

export function registerPiWorkerFetch(
    pi: ExtensionAPI,
    internals: PiWorkerFetchInternals = {}
): void {
    makeWorkerTool<typeof Params, FetchDetails>(pi, {
        name: 'pi-worker-fetch',
        label: 'Pi Worker Fetch',
        description:
            'Fetch a web page or text resource (HTML, markdown, plain text, JSON, '
            + 'XML/feeds), clean HTML to markdown, and hand it to an isolated child '
            + 'Pi session that extracts ONLY content answering `query`. Returns the '
            + 'focused answer.\n'
            + 'REACH FOR THIS when you need to know how an external library, tool, '
            + 'plugin, framework, or service is CONFIGURED, WIRED, or INTEGRATED and '
            + 'the installed-package docs (pi-worker-docs) do not cover it: fetch its '
            + 'README or official documentation page and extract the setup/wiring you '
            + 'need, instead of guessing. Do NOT guess integration or configuration '
            + 'details from memory — fetch the authoritative page. Also use it to read '
            + 'any known URL, or after `pi-worker-search` to read a result, without '
            + 'stuffing raw content into the main context.',
        parameters: Params,

        async run(params, signal, ctx) {
            try {
                new URL(params.url)
            } catch {
                return {text: `Invalid URL: ${params.url}`, details: {}}
            }

            try {
                const result = await fetchFocused({
                    url: params.url,
                    query: params.query,
                    cwd: ctx.cwd,
                    signal,
                    fetchAndClean: internals.fetchAndClean,
                    spawn: internals.spawn as Parameters<typeof fetchFocused>[0]['spawn']
                })

                const failure = formatChildFailure(
                    {
                        aborted: result.aborted,
                        exitCode: result.childExitCode,
                        stderr: result.stderr
                    },
                    'Fetch aborted.'
                )
                if (failure !== null) {
                    return {text: failure, details: {childExitCode: result.childExitCode}}
                }

                const text =
                    formatResultText(
                        {answer: result.answer, excerpt: result.excerpt},
                        result.excerptVerified
                    ) || '(no output)'
                return {
                    text,
                    details: {
                        childExitCode: 0,
                        answer: result.answer,
                        excerpt: result.excerpt,
                        excerptVerified: result.excerptVerified
                    }
                }
            } catch (err) {
                if (err instanceof FetchAndCleanError) {
                    return {text: err.message, details: {}}
                }
                return {
                    text: `Could not fetch ${params.url}: ${err instanceof Error ? err.message : String(err)}`,
                    details: {}
                }
            }
        },

        renderCall(args, theme) {
            const query = args.query.replace(/\s+/g, ' ').trim()
            const truncatedQuery =
                query.length > RENDER_QUERY_MAX ? `${query.slice(0, RENDER_QUERY_MAX - 1)}…` : query
            let text = theme.fg('toolTitle', theme.bold('pi-worker-fetch '))
            text += theme.fg('accent', args.url)
            text += `\n${theme.fg('dim', `  query: ${truncatedQuery}`)}`
            return new Text(text, 0, 0)
        },

        // Cache fetch answers per run (the same page re-fetched across sibling tasks
        // otherwise). The URL is kept verbatim (path case can matter); the query is
        // normalised. Both parts key the entry — same page, different question is a
        // different answer.
        cacheKey: params => `${params.url.trim()}::${normalizeQuery(params.query)}`,
        // Only a completed fetch (child exited 0) is a real answer; invalid-URL,
        // fetch failures, and aborts omit childExitCode:0 and fall through.
        cacheable: d => d.childExitCode === 0
    })
}
