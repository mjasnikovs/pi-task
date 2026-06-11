import {Type} from '@sinclair/typebox'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {braveSearch as defaultBraveSearch} from './brave-search.js'
import {search} from './search-core.js'
import {textResult} from './shared.js'

const Params = Type.Object({
    query: Type.String({description: 'Search query.'}),
    count: Type.Optional(
        Type.Integer({
            minimum: 1,
            maximum: 20,
            description: 'How many results to return (default 10, max 20).'
        })
    )
})

interface SearchDetails {
    resultCount: number
}

export interface PiWorkerSearchInternals {
    braveSearch?: typeof defaultBraveSearch
    getEnv?: (key: string) => string | undefined
}

export function registerPiWorkerSearch(
    pi: ExtensionAPI,
    internals: PiWorkerSearchInternals = {}
): void {
    pi.registerTool({
        name: 'pi-worker-search',
        label: 'Pi Worker Search',
        description:
            'Search the live web via Brave Search. CALL THIS BEFORE ANSWERING any '
            + 'question about current or version-specific external facts: '
            + 'library/framework versions and their APIs, latest releases, recently '
            + 'shipped features, current events, prices, or who currently holds a '
            + 'role. Your built-in knowledge is out of date — do NOT answer such '
            + 'questions from memory and do NOT shell out with bash to guess. Returns '
            + 'a compact markdown list of up to 10 results (title, URL, snippet); then '
            + 'call `pi-worker-fetch` on the URL you want to read. '
            + 'Requires BRAVE_SEARCH_API_KEY env var.',
        parameters: Params,
        executionMode: 'parallel',

        async execute(_toolCallId, params, signal): Promise<AgentToolResult<SearchDetails>> {
            const result = await search({
                query: (params as {query: string}).query,
                count: (params as {count?: number}).count,
                signal,
                getEnv: internals.getEnv,
                braveSearch: internals.braveSearch
            })

            if (result.kind === 'no_key') {
                return textResult(result.message, {resultCount: 0})
            }
            if (result.kind === 'error') {
                return textResult(result.message, {resultCount: 0})
            }

            const {results} = result
            if (results.length === 0) {
                return textResult(`No results for: ${(params as {query: string}).query}`, {
                    resultCount: 0
                })
            }

            const lines = results.map(
                (r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.description}`
            )
            return textResult(lines.join('\n'), {resultCount: results.length})
        },

        renderCall(args, theme) {
            let text = theme.fg('toolTitle', theme.bold('pi-worker-search '))
            text += theme.fg('accent', args.query)
            if (typeof args.count === 'number') {
                text += theme.fg('dim', ` (count=${args.count})`)
            }
            return new Text(text, 0, 0)
        }
    })
}
