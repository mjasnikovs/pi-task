/**
 * External-context enrichment — extract packages / URLs / services from a piece
 * of text, fan out to docs / fetch / search workers, and assemble the
 * `EXTERNAL CONTEXT` block that gets prepended to a worker prompt.
 *
 * Split out of phases.ts so the research phase reads as "gather context → run
 * probes → assemble", and so this fan-out has its own test surface separate
 * from the four research workers. `enrichment.ts` stays a pure parser; the I/O
 * lives here.
 *
 * TWO call paths share this assembly: the research phase via
 * {@link gatherExternalContext} (raw workers) and the grill auto-answer via
 * {@link buildExternalContext} directly (focused workers). Everything that shows
 * up in the OUTPUT is identical between them — the "npm blocks lead" ordering, the
 * `### docs:` / `### url:` headings, the service loop's `no_key` / `error`
 * handling, the trailing blank-line terminator — and they differ only on POLICY.
 *
 * So the shape lives here once, the differences are {@link ExternalContextPolicy},
 * and the raw-vs-focused worker choice is {@link ExternalContextLookups}, an
 * adapter the focused-extractor seam made expressible.
 *
 * Run against a mixed source, the emitted headings come out in exactly that order:
 * `### npm:` then `### docs:` then `### url:` then `### service:`.
 */

import {chooseEcosystem, defaultEcosystemIo} from '../workers/docs-ecosystems.js'
import {docsRaw} from '../workers/docs-core.js'
import {fetchRaw} from '../workers/fetch-core.js'
import {
    formatNpmVersionSection,
    npmVersionLookup,
    type NpmVersionInfo
} from '../workers/npm-version.js'
import {search as defaultSearch} from '../workers/search-core.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'
import {extractEnrichTargets} from './enrichment.js'
import {formatServiceBlock, formatFreshnessSkippedBlock} from './service-blocks.js'
import type {PhaseDeps} from './child-runner.js'

/** How much of a docs/url body survives into the block, for the raw-worker lookups. */
const RAW_BODY_LIMIT = 4000

/**
 * What assembling the block needs off the phase's deps: where it runs, when to
 * stop, where to trail a sub-step — and, for the research binding, the four
 * lookup seams. They are fields on `PhaseDeps` (not a second bag) because the
 * bag was a trailing parameter no production caller could reach.
 */
type GatherDeps = Pick<
    PhaseDeps,
    'cwd' | 'signal' | 'recordSubStep' | 'docsRaw' | 'fetchRaw' | 'npmVersionLookup' | 'searchFn'
>

/** One docs (`pkg`) or url target, in the order it will appear in the block. */
interface ExternalTarget {
    kind: 'pkg' | 'url'
    /** The package name or the URL — also the `### docs:` / `### url:` heading. */
    name: string
}

/** What a target lookup contributes to the block. */
export interface ExternalTargetResult {
    /** Emitted as an `### npm:` block ahead of every body. Absent for url targets. */
    npmVersion?: NpmVersionInfo | null
    /** Which registry the version block came from; npm when absent. */
    registryLabel?: string
    /**
     * The `### docs:`/`### url:` body. `undefined` means "this target contributes no
     * body block" — and the two call paths draw that line differently ON PURPOSE:
     * the raw lookups emit a (possibly empty) body whenever the docs call returned
     * chunks, the focused ones emit one only when the child produced a non-empty
     * answer. Both keep any `npmVersion` regardless.
     */
    body?: string
}

/**
 * The worker variant. This is the adapter the focused-extractor seam made
 * expressible: `gatherExternalContext` binds the RAW workers (whole doc chunks /
 * whole page markdown, truncated), `phaseAutoAnswer` binds the FOCUSED ones (a
 * child's one-question answer). Everything else about the block is identical.
 *
 * A rejected lookup is caught by the builder and yields no blocks for that target,
 * so adapters may throw freely. Confirmed: one adapter rejecting mid-fan-out
 * leaves the other targets' blocks intact and contributes nothing of its own.
 */
export interface ExternalContextLookups {
    docs(pkg: string): Promise<ExternalTargetResult | null>
    url(url: string): Promise<ExternalTargetResult | null>
    /** Defaults to the real search worker. */
    search?: (input: SearchCoreInput) => Promise<SearchCoreResult>
}

/**
 * The five places the two call paths genuinely disagree. Each is a knob rather
 * than a default, because every one is a deliberate choice on at least one path:
 * the auto-answer block is capped and records nothing because it runs per grill
 * question, in front of a waiting user, while research is uncapped and trails its
 * sub-step.
 */
export interface ExternalContextPolicy {
    /**
     * Max combined docs+url targets fanned out, packages first. Omit for uncapped
     * (research); the auto-answer path caps at 2.
     */
    targetCap?: number
    /** Max services fanned out. Omit for uncapped; the auto-answer path caps at 2. */
    serviceCap?: number
    /**
     * A cheap live version lookup for every named dep that did NOT get a docs
     * target, so a version block exists for ALL of them. Omit to disable, as the
     * auto-answer path does. Without it, any dep past the docs cap carries no live
     * version at all, and a "which version?" question falls back to whatever the
     * model remembers — which is how a dependency gets pinned to a stale major.
     */
    versionLookup?: (pkg: string) => Promise<NpmVersionInfo | null>
    /** Which registry `versionLookup` asks, for the block heading. npm when absent. */
    versionLabel?: string
    /** Sub-step label recorded via `deps.recordSubStep`. Omit to record nothing. */
    subStepLabel?: string
    /**
     * Return `''` before any fan-out when there is nothing to look up. Only the
     * research path does this today; on the auto-answer path the empty fan-out is
     * a no-op that produces the same `''`.
     */
    earlyReturnOnNoTargets?: boolean
}

/**
 * Assemble the `EXTERNAL CONTEXT\n…\n\n` block for `source`, or `''` when there is
 * nothing to enrich — no targets, or every lookup failed. Both were run: a source
 * naming nothing returns `''`, and so does one whose only target is a service
 * search that errored.
 */
export async function buildExternalContext(
    source: string,
    deps: GatherDeps,
    lookups: ExternalContextLookups,
    policy: ExternalContextPolicy = {}
): Promise<string> {
    const searchFn = lookups.search ?? defaultSearch
    const enrichTargets = extractEnrichTargets(source)

    // Packages lead urls, then the combined cap applies — so a capped run spends
    // its budget on named deps first. Uncapped, this is just "packages, then urls".
    const targets: ExternalTarget[] = [
        ...enrichTargets.packages.map(name => ({kind: 'pkg' as const, name})),
        ...enrichTargets.urls.map(name => ({kind: 'url' as const, name}))
    ].slice(0, policy.targetCap ?? Number.POSITIVE_INFINITY)
    const services = enrichTargets.services.slice(0, policy.serviceCap ?? Number.POSITIVE_INFINITY)

    const versionLookup = policy.versionLookup
    const docsTargets = new Set(targets.filter(t => t.kind === 'pkg').map(t => t.name))
    const extraVersionPkgs =
        versionLookup ? enrichTargets.versionPackages.filter(p => !docsTargets.has(p)) : []

    if (policy.earlyReturnOnNoTargets && targets.length === 0 && services.length === 0) return ''

    const startedAt = Date.now()
    const [targetResults, serviceResults, extraVersionResults] = await Promise.all([
        Promise.all(
            targets.map(t =>
                (t.kind === 'pkg' ? lookups.docs(t.name) : lookups.url(t.name)).catch(() => null)
            )
        ),
        Promise.all(
            services.map(s =>
                searchFn({
                    query: `${s.name} ${s.query}`,
                    count: 3,
                    signal: deps.signal
                }).catch(() => null)
            )
        ),
        Promise.all(
            versionLookup ? extraVersionPkgs.map(pkg => versionLookup(pkg).catch(() => null)) : []
        )
    ])

    const sections: string[] = []

    // npm version blocks lead the section so the model anchors on live version
    // data before reading any docs body. The docs-fetched packages carry their
    // version in the lookup's own bundled result; the remaining named deps get
    // theirs from the cheap standalone lookup above. Together they cover EVERY
    // named dep.
    for (const r of targetResults) {
        if (r?.npmVersion) sections.push(formatNpmVersionSection(r.npmVersion, r.registryLabel))
    }
    for (const v of extraVersionResults) {
        if (v) sections.push(formatNpmVersionSection(v, policy.versionLabel))
    }

    for (let i = 0; i < targets.length; i++) {
        const body = targetResults[i]?.body
        if (body === undefined) continue
        const heading = targets[i].kind === 'pkg' ? 'docs' : 'url'
        sections.push(`### ${heading}: ${targets[i].name}\n${body}`)
    }

    const skipped: string[] = []
    for (let i = 0; i < services.length; i++) {
        const s = services[i]
        const r = serviceResults[i]
        if (r === null) continue
        if (r.kind === 'no_key') {
            skipped.push(s.name)
            continue
        }
        if (r.kind === 'error') continue
        // kind === 'ok'
        sections.push(formatServiceBlock(s.name, `${s.name} ${s.query}`, r.results))
    }

    if (skipped.length > 0) {
        sections.push(formatFreshnessSkippedBlock(skipped))
    }

    if (policy.subStepLabel) deps.recordSubStep?.(policy.subStepLabel, Date.now() - startedAt)

    if (sections.length === 0) return ''
    return `EXTERNAL CONTEXT\n${sections.join('\n\n')}\n\n`
}

/**
 * The RESEARCH-phase binding: raw workers, no caps, live versions for every
 * named dep, truncated bodies, timed, and short-circuited when there is nothing
 * to look up.
 *
 * Returns the `EXTERNAL CONTEXT\n…\n\n` block for the refined spec, or `''`.
 */
export async function gatherExternalContext(refined: string, deps: GatherDeps): Promise<string> {
    const docsRawFn = deps.docsRaw ?? docsRaw
    const fetchRawFn = deps.fetchRaw ?? fetchRaw
    const npmVersionFn = deps.npmVersionLookup ?? npmVersionLookup
    const docsQuery = refined.split('\n').find(l => l.trim()) ?? refined

    // Which registry the standalone version lookups should ask. A cargo-only
    // project's dependency names are crate names, and asking npm about them
    // returns a real but unrelated package's versions — the exact confusion the
    // docs tool now refuses. Nothing detected keeps npm, which is what a bare
    // directory has always done. Ambiguous asks nobody.
    const choice = chooseEcosystem({cwd: deps.cwd})
    const versionLabel = choice.ok ? choice.profile.registryLabel : 'npm'
    const versionLookup =
        !choice.ok ?
            choice.reason === 'none' ?
                (pkg: string) => npmVersionFn(pkg, {signal: deps.signal})
            :   undefined
        : choice.profile.id === 'npm' ? (pkg: string) => npmVersionFn(pkg, {signal: deps.signal})
        : (pkg: string) =>
                choice.profile.latest(
                    pkg,
                    defaultEcosystemIo(deps.signal ? {signal: deps.signal} : {})
                )

    return buildExternalContext(
        refined,
        deps,
        {
            docs: async pkg => {
                const r = await docsRawFn({
                    pkg,
                    query: docsQuery,
                    cwd: deps.cwd,
                    signal: deps.signal
                })
                return {
                    npmVersion: r.npmVersion,
                    ...(r.registryLabel ? {registryLabel: r.registryLabel} : {}),
                    body:
                        r.kind === 'ok' && r.chunks.length > 0 ?
                            r.chunks
                                .map(c => c.content)
                                .join('\n\n')
                                .slice(0, RAW_BODY_LIMIT)
                        :   undefined
                }
            },
            url: async url => {
                const r = await fetchRawFn({url, signal: deps.signal})
                return {body: r.markdown.slice(0, RAW_BODY_LIMIT)}
            },
            search: deps.searchFn
        },
        {
            ...(versionLookup ? {versionLookup, versionLabel} : {}),
            subStepLabel: 'enrichment',
            earlyReturnOnNoTargets: true
        }
    )
}
