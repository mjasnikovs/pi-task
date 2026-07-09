import {Type} from '@sinclair/typebox'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {braveSearch as defaultBraveSearch} from './brave-search.js'
import {search} from './search-core.js'
import {makeWorkerTool} from './shared.js'
import {normalizeQuery} from './research-cache.js'

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
    makeWorkerTool<typeof Params, SearchDetails>(pi, {
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

        async run(params, signal) {
            const result = await search({
                query: params.query,
                count: params.count,
                signal,
                getEnv: internals.getEnv,
                braveSearch: internals.braveSearch
            })

            if (result.kind === 'no_key' || result.kind === 'error') {
                return {text: result.message, details: {resultCount: 0}}
            }

            const {results} = result
            if (results.length === 0) {
                return {text: `No results for: ${params.query}`, details: {resultCount: 0}}
            }

            const lines = results.map(
                (r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.description}`
            )
            return {text: lines.join('\n'), details: {resultCount: results.length}}
        },

        renderCall(args, theme) {
            let text = theme.fg('toolTitle', theme.bold('pi-worker-search '))
            text += theme.fg('accent', args.query)
            if (typeof args.count === 'number') {
                text += theme.fg('dim', ` (count=${args.count})`)
            }
            return new Text(text, 0, 0)
        },

        // Cache search results per run (the same query re-run across sibling tasks hits
        // the live web anew otherwise). Count is part of the key — a larger request is a
        // different result set.
        cacheKey: params => `${normalizeQuery(params.query)}::${params.count ?? ''}`,
        // Only a non-empty result set is worth caching; no-key, error, and empty results
        // (resultCount 0) fall through so a later attempt can succeed.
        cacheable: d => d.resultCount > 0
    })
}
