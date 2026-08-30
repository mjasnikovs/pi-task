import {Type} from '@sinclair/typebox'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {Text} from '@earendil-works/pi-tui'
import {getConfig} from '../config/config.js'
import type {braveSearch as defaultBraveSearch} from './brave-search.js'
import type {ddgSearch as defaultDdgSearch} from './ddg-search.js'
import type {exaSearch as defaultExaSearch} from './exa-search.js'
import type {SearchProvider} from './search-types.js'
import {search} from './search-core.js'
import {makeWorkerTool, workerAnswer, workerUnavailable} from './shared.js'
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
    exaSearch?: typeof defaultExaSearch
    ddgSearch?: typeof defaultDdgSearch
    provider?: SearchProvider
    getEnv?: (key: string) => string | undefined
}

export function registerPiWorkerSearch(
    pi: ExtensionAPI,
    internals: PiWorkerSearchInternals = {}
): void {
    const provider = (): SearchProvider => internals.provider ?? getConfig().searchProvider

    makeWorkerTool<typeof Params, SearchDetails>(pi, {
        name: 'pi-worker-search',
        label: 'Pi Worker Search',
        description:
            'Search the live web. CALL THIS BEFORE ANSWERING any '
            + 'question about current or version-specific external facts: '
            + 'library/framework versions and their APIs, latest releases, recently '
            + 'shipped features, current events, prices, or who currently holds a '
            + 'role. Your built-in knowledge is out of date — do NOT answer such '
            + 'questions from memory and do NOT shell out with bash to guess. Returns '
            + 'a compact markdown list of up to 10 results (title, URL, snippet); then '
            + 'call `pi-worker-fetch` on the URL you want to read.',
        parameters: Params,

        async run(params, signal) {
            const result = await search({
                query: params.query,
                count: params.count,
                signal,
                provider: internals.provider,
                getEnv: internals.getEnv,
                braveSearch: internals.braveSearch,
                exaSearch: internals.exaSearch,
                ddgSearch: internals.ddgSearch
            })

            if (result.kind === 'no_key' || result.kind === 'error') {
                return workerUnavailable(result.message, {resultCount: 0}, result.kind)
            }

            const {results} = result
            // Zero results IS an answer: the search ran and the web has nothing, so it
            // comes back as `workerAnswer` with resultCount 0. Only a search that could
            // not run — no key, or an engine error — is `unavailable`.
            if (results.length === 0) {
                return workerAnswer(`No results for: ${params.query}`, {resultCount: 0})
            }

            const lines = results.map(
                (r, i) => `${i + 1}. [${r.title}](${r.url}) — ${r.description}`
            )
            return workerAnswer(lines.join('\n'), {resultCount: results.length})
        },

        renderCall(args, theme) {
            let text = theme.fg('toolTitle', theme.bold('pi-worker-search '))
            text += theme.fg('accent', args.query)
            if (typeof args.count === 'number') {
                text += theme.fg('dim', ` (count=${args.count})`)
            }
            return new Text(text, 0, 0)
        },

        // Cache search results per run, or the same query re-run by a sibling task hits
        // the live web again. Three parts key the entry: the PROVIDER, because two
        // engines' result sets for one query are different answers and must not serve
        // for each other; the query, lowercased and whitespace-collapsed by
        // `normalizeQuery` so phrasing variants share an entry; and the COUNT, because a
        // larger request is a different result set.
        cacheKey: params => `${provider()}::${normalizeQuery(params.query)}::${params.count ?? ''}`,
        // Only a non-empty result set is worth caching. An empty one falls through so a
        // later attempt can succeed; no-key and engine errors never reach this at all,
        // since makeWorkerTool refuses to store an `unavailable` outcome.
        cacheable: d => d.resultCount > 0
    })
}
