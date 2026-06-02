import {Type} from '@sinclair/typebox'
import type {EventEmitter} from 'node:events'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {fetchAndClean as defaultFetchAndClean, FetchAndCleanError} from './html-clean.js'
import {fetchFocused, formatResultText} from './fetch-core.js'
import {textResult} from './shared.js'

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
    pi.registerTool({
        name: 'pi-worker-fetch',
        label: 'Pi Worker Fetch',
        description:
            'Fetch an HTML page, clean it to markdown, and hand it to an isolated '
            + 'child Pi session that extracts ONLY content answering `query`. '
            + 'Returns the focused answer. Use after `pi-worker-search` (or with a '
            + 'known URL) to avoid stuffing raw HTML into the main context.',
        parameters: Params,
        executionMode: 'parallel',

        async execute(
            _toolCallId,
            params,
            signal,
            _onUpdate,
            ctx
        ): Promise<AgentToolResult<FetchDetails>> {
            try {
                new URL(params.url)
            } catch {
                return textResult(`Invalid URL: ${params.url}`, {})
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

                if (result.aborted) {
                    return textResult('Fetch aborted.', {childExitCode: result.childExitCode})
                }
                if (result.childExitCode !== 0) {
                    const tail = result.stderr.trim().slice(-500) || '(no stderr)'
                    return textResult(`Worker exited ${result.childExitCode}.\n${tail}`, {
                        childExitCode: result.childExitCode
                    })
                }

                const text =
                    formatResultText(
                        {answer: result.answer, excerpt: result.excerpt},
                        result.excerptVerified
                    ) || '(no output)'
                return textResult(text, {
                    childExitCode: 0,
                    answer: result.answer,
                    excerpt: result.excerpt,
                    excerptVerified: result.excerptVerified
                })
            } catch (err) {
                if (err instanceof FetchAndCleanError) {
                    return textResult(err.message, {})
                }
                return textResult(
                    `Could not fetch ${params.url}: ${err instanceof Error ? err.message : String(err)}`,
                    {}
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
        }
    })
}
