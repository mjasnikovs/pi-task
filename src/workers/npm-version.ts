/**
 * Live npm registry version lookup.
 *
 * Without it the auto-answer and research workers have no live source for "what
 * is the latest published version of X", so they answer from training data, which
 * is stale by construction — it can only ever name a version that existed when the
 * model was trained.
 *
 * This fetches the registry's metadata endpoint and returns just enough to anchor
 * a worker in the present: the dist-tag `latest`, a short list of versions, and
 * the publish date of `latest`.
 */

import {httpRequest, HttpRequestError} from './http-request.js'

const REGISTRY_BASE = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 3000
const RECENT_VERSIONS_LIMIT = 10

export interface NpmVersionInfo {
    pkg: string
    /** The `latest` dist-tag — the stable release npm would install. */
    latest: string
    /**
     * The LAST `RECENT_VERSIONS_LIMIT` keys of the registry's `versions` map,
     * reversed. That is publication order, not semver order, and it is not
     * filtered: for a package that publishes prereleases these are mostly canary
     * and experimental builds, not the recent stable releases.
     */
    recent: string[]
    publishedAt?: string
}

export interface NpmVersionOpts {
    timeoutMs?: number
    signal?: AbortSignal
    registry?: string
}

interface RegistryResponse {
    'dist-tags'?: {latest?: unknown; [tag: string]: unknown}
    versions?: Record<string, unknown>
    time?: Record<string, unknown>
}

/**
 * Fetch the latest version + recent version list for an npm package.
 *
 * Returns `null` on every ordinary failure — an invalid package name, a registry
 * that is down, a 404, a malformed body, a missing `dist-tags.latest`. The caller
 * treats null as "no fresh data available" and continues without it.
 *
 * It is NOT null-on-everything: a user cancel is re-thrown (see below), and so is
 * anything that is not an {@link HttpRequestError}.
 *
 * An invalid name is rejected before any request is made. `UPPER` is valid — the
 * name regex is case-insensitive — while an empty name, a leading `.` or `_`, a
 * space, more than 214 characters, or an unscoped path like `a/b/c` are not.
 */
export async function npmVersionLookup(
    pkg: string,
    opts: NpmVersionOpts = {}
): Promise<NpmVersionInfo | null> {
    if (!isValidPackageName(pkg)) return null

    const base = opts.registry ?? REGISTRY_BASE
    const url = `${base}/${encodePackageName(pkg)}`

    try {
        return await httpRequest(
            url,
            {
                timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                ...(opts.signal === undefined ? {} : {signal: opts.signal}),
                method: 'GET',
                headers: {accept: 'application/vnd.npm.install-v1+json, application/json'}
            },
            async response => {
                // npm's own status policy: a version banner is a nicety, so every
                // non-OK answer is simply "no version to report".
                if (!response.ok) return null

                let body: RegistryResponse
                try {
                    body = (await response.json()) as RegistryResponse
                } catch {
                    return null
                }

                const latest = body['dist-tags']?.latest
                if (typeof latest !== 'string' || latest.length === 0) return null

                const allVersions = Object.keys(body.versions ?? {})
                const recent = allVersions.slice(-RECENT_VERSIONS_LIMIT).reverse()
                const publishedAtRaw = body.time?.[latest]
                const publishedAt = typeof publishedAtRaw === 'string' ? publishedAtRaw : undefined

                return {pkg, latest, recent, publishedAt}
            }
        )
    } catch (err) {
        // A user cancel is RE-THROWN, not swallowed. Returning null here would make a
        // cancelled lookup indistinguishable from a registry that is down, and the
        // caller would go on assembling a version block for a run the user stopped.
        if (err instanceof HttpRequestError && err.kind === 'aborted') throw err
        if (err instanceof HttpRequestError) return null
        throw err
    }
}

/** Format an NpmVersionInfo as a short Markdown block for EXTERNAL CONTEXT: a
 *  `### <registry>: <pkg>` heading, a `latest:` line that gains ` (published
 *  YYYY-MM-DD)` when the date is known, and a `recent:` line only when the list is
 *  non-empty. The label defaults to npm, which is where every caller but the docs
 *  tool's non-npm rows reads from. */
export function formatNpmVersionSection(info: NpmVersionInfo, label = 'npm'): string {
    const lines = [`### ${label}: ${info.pkg}`, `latest: ${info.latest}`]
    if (info.publishedAt) {
        const date = info.publishedAt.slice(0, 10)
        lines[1] += ` (published ${date})`
    }
    if (info.recent.length > 0) {
        lines.push(`recent: ${info.recent.join(', ')}`)
    }
    return lines.join('\n')
}

function isValidPackageName(pkg: string): boolean {
    if (pkg.length === 0 || pkg.length > 214) return false
    if (pkg.startsWith('.') || pkg.startsWith('_')) return false
    return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(pkg)
}

function encodePackageName(pkg: string): string {
    if (pkg.startsWith('@')) {
        const slash = pkg.indexOf('/')
        if (slash > 0) {
            return (
                encodeURIComponent(pkg.slice(0, slash))
                + '/'
                + encodeURIComponent(pkg.slice(slash + 1))
            )
        }
    }
    return encodeURIComponent(pkg)
}
