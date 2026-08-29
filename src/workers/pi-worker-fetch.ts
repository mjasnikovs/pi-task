import {Type} from '@sinclair/typebox'
import type {EventEmitter} from 'node:events'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {fetchAndClean as defaultFetchAndClean, FetchAndCleanError} from './html-clean.js'
import {fetchFocused} from './fetch-core.js'
import {formatResultText} from '../shared/child-output.js'
import {childFailureReason, makeWorkerTool, workerAnswer, workerUnavailable} from './shared.js'
import {normalizeQuery} from './research-cache.js'
import {isAbstention} from './abstention.js'

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
                return workerUnavailable(`Invalid URL: ${params.url}`, {}, 'bad-url')
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

                // Child failure is decided and formatted once, inside the focused extractor
                // (workers/focused-extractor.ts) — re-mapping the result back into a
                // ChildOutcome here would just ask formatChildFailure the same question.
                if (result.failure !== undefined) {
                    return workerUnavailable(
                        result.failure,
                        {childExitCode: result.childExitCode},
                        childFailureReason({
                            exitCode: result.childExitCode,
                            aborted: result.aborted
                        })
                    )
                }

                const body =
                    formatResultText(
                        '', // a fetched page answer carries no package header
                        {answer: result.answer, excerpt: result.excerpt},
                        result.excerptVerified
                    ) || '(no output)'
                // The coverage miss is the one outcome that carries an instruction. It goes
                // in the TEXT, not only in details: details are for the harness, and the
                // worker acts on what it reads.
                const text = result.nextStep ? `${body}\n\n${result.nextStep}` : body
                return workerAnswer(text, {
                    childExitCode: 0,
                    answer: result.answer,
                    excerpt: result.excerpt,
                    excerptVerified: result.excerptVerified,
                    coverageMiss: result.coverageMiss,
                    anchoredSection: result.anchoredSection
                })
            } catch (err) {
                if (err instanceof FetchAndCleanError) {
                    return workerUnavailable(err.message, {}, 'fetch-failed')
                }
                return workerUnavailable(
                    `Could not fetch ${params.url}: ${err instanceof Error ? err.message : String(err)}`,
                    {},
                    'fetch-failed'
                )
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
        cacheKey: fetchCacheKey,
        // Only a completed fetch (child exited 0) is a real answer; invalid-URL,
        // fetch failures, and aborts omit childExitCode:0 and fall through.
        // F-2(e), on the fetch channel. A child that ran fine and answered
        // "unclear from this page" exits 0, so caching on process health alone
        // memoised the NON-ANSWER and re-served it to every later sibling task —
        // the same dead-end-paid-many-times shape pi-worker-docs already closed
        // for packages, with escalation unable to re-fire because the miss never
        // recurred. One predicate now covers every corpus (workers/abstention.ts).
        cacheable: fetchCacheable
    })
}

/**
 * The F-2(e) cache rule for the fetch channel, named for the same reason as
 * `docsCacheable`: pi-worker-fetch.test.ts carried a hand-retyped copy driving four
 * tests, which a change to the shipped rule would leave green.
 */
export function fetchCacheable(_d: Pick<FetchDetails, never>, text: string): boolean {
    // Answer QUALITY only — see docsCacheable. `childExitCode === 0` leading this
    // rule is true of an aborted child, so `"Fetch aborted."` would be cached.
    return !isAbstention(text)
}

/** The fetch cache key. URL verbatim (path case can matter), question normalised —
 *  same page, different question is a different answer. */
export function fetchCacheKey(params: {url: string; query: string}): string {
    return `${params.url.trim()}::${normalizeQuery(params.query)}`
}
