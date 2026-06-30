/**
 * External-context enrichment — extract packages / URLs / services from the
 * refined spec, fan out to docs / fetch / search workers, and assemble the
 * `EXTERNAL CONTEXT` block the research phase prepends to every worker prompt.
 *
 * Split out of phases.ts so the research phase reads as "gather context → run
 * probes → assemble", and so this fan-out has its own test surface separate
 * from the four research workers. `enrichment.ts` stays a pure parser; the I/O
 * lives here.
 */

import {docsRaw} from '../workers/docs-core.js'
import {fetchRaw} from '../workers/fetch-core.js'
import {formatNpmVersionSection, npmVersionLookup} from '../workers/npm-version.js'
import {search as defaultSearch} from '../workers/search-core.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'
import {extractEnrichTargets} from './enrichment.js'
import {formatServiceBlock, formatFreshnessSkippedBlock} from './service-blocks.js'
import type {PhaseDeps} from './child-runner.js'

/** Injectable workers so enrichment is testable without spawning real lookups. */
export interface ExternalContextDeps {
    docsRaw?: typeof docsRaw
    fetchRaw?: typeof fetchRaw
    searchFn?: (input: SearchCoreInput) => Promise<SearchCoreResult>
    npmVersionLookup?: typeof npmVersionLookup
}

type GatherDeps = Pick<PhaseDeps, 'cwd' | 'signal' | 'recordSubStep'>

/**
 * Returns the `EXTERNAL CONTEXT\n…\n\n` block for the refined spec, or `''` when
 * there is nothing to enrich (no targets, or every lookup failed).
 */
export async function gatherExternalContext(
    refined: string,
    deps: GatherDeps,
    researchDeps: ExternalContextDeps = {}
): Promise<string> {
    const docsRawFn = researchDeps.docsRaw ?? docsRaw
    const fetchRawFn = researchDeps.fetchRaw ?? fetchRaw
    const searchFn = researchDeps.searchFn ?? defaultSearch
    const npmVersionFn = researchDeps.npmVersionLookup ?? npmVersionLookup
    const enrichTargets = extractEnrichTargets(refined)

    // Every named dep past the heavy-docs cap still gets a cheap live version
    // lookup, so a version block exists for ALL of them (the docs-fetched ones
    // emit their version below from the bundled lookup). Without this, deps 4..N
    // had no live version and a "which version?" question fell back to the model's
    // stale training data — how tailwindcss got pinned to an old major.
    const docsPkgs = new Set(enrichTargets.packages)
    const extraVersionPkgs = enrichTargets.versionPackages.filter(p => !docsPkgs.has(p))

    if (
        enrichTargets.packages.length === 0
        && enrichTargets.urls.length === 0
        && enrichTargets.services.length === 0
    ) {
        return ''
    }

    const enrichSections: string[] = []
    const tEnrichStart = Date.now()
    const [docsResults, fetchResults, serviceResults, extraVersionResults] = await Promise.all([
        Promise.all(
            enrichTargets.packages.map(pkg =>
                docsRawFn({
                    pkg,
                    query: refined.split('\n').find(l => l.trim()) ?? refined,
                    cwd: deps.cwd,
                    signal: deps.signal
                }).catch(() => null)
            )
        ),
        Promise.all(
            enrichTargets.urls.map(url => fetchRawFn({url, signal: deps.signal}).catch(() => null))
        ),
        Promise.all(
            enrichTargets.services.map(s =>
                searchFn({
                    query: `${s.name} ${s.query}`,
                    count: 3,
                    signal: deps.signal
                }).catch(() => null)
            )
        ),
        Promise.all(
            extraVersionPkgs.map(pkg => npmVersionFn(pkg, {signal: deps.signal}).catch(() => null))
        )
    ])

    // npm version blocks lead the section so the model anchors on live version
    // data before reading any docs body. The docs-fetched packages carry their
    // version in docsRaw's bundled lookup; the remaining named deps get theirs
    // from the cheap standalone lookup above. Together they cover EVERY named dep.
    for (let i = 0; i < enrichTargets.packages.length; i++) {
        const v = docsResults[i]?.npmVersion
        if (v) enrichSections.push(formatNpmVersionSection(v))
    }
    for (const v of extraVersionResults) {
        if (v) enrichSections.push(formatNpmVersionSection(v))
    }

    for (let i = 0; i < enrichTargets.packages.length; i++) {
        const r = docsResults[i]
        if (r?.kind === 'ok' && r.chunks.length > 0) {
            const body = r.chunks
                .map(c => c.content)
                .join('\n\n')
                .slice(0, 4000)
            enrichSections.push(`### docs: ${enrichTargets.packages[i]}\n${body}`)
        }
    }

    for (let i = 0; i < enrichTargets.urls.length; i++) {
        const r = fetchResults[i]
        if (r) {
            enrichSections.push(`### url: ${enrichTargets.urls[i]}\n${r.markdown.slice(0, 4000)}`)
        }
    }

    const skipped: string[] = []
    for (let i = 0; i < enrichTargets.services.length; i++) {
        const s = enrichTargets.services[i]
        const r = serviceResults[i]
        if (r === null) continue
        if (r.kind === 'no_key') {
            skipped.push(s.name)
            continue
        }
        if (r.kind === 'error') continue
        // kind === 'ok'
        enrichSections.push(formatServiceBlock(s.name, `${s.name} ${s.query}`, r.results))
    }

    if (skipped.length > 0) {
        enrichSections.push(formatFreshnessSkippedBlock(skipped))
    }

    deps.recordSubStep?.('enrichment', Date.now() - tEnrichStart)

    if (enrichSections.length === 0) return ''
    return `EXTERNAL CONTEXT\n${enrichSections.join('\n\n')}\n\n`
}
