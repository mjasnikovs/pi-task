/**
 * Live npm registry version lookup.
 *
 * Solves a real failure mode: the auto-answer/research workers have no live
 * source for "what's the latest published version of X", so they answer from
 * training data, which goes stale. TASK_0005 hit this — the worker said
 * "18.3.1, the latest stable React" when React 19.x had shipped months earlier.
 *
 * This module fetches the npm registry's metadata endpoint and returns just
 * enough to anchor the worker in current reality: the dist-tag 'latest', a
 * short list of recent versions, and the publish date of latest.
 */

const REGISTRY_BASE = 'https://registry.npmjs.org'
const DEFAULT_TIMEOUT_MS = 3000
const RECENT_VERSIONS_LIMIT = 10

export interface NpmVersionInfo {
    pkg: string
    latest: string
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
 * Returns `null` (never throws) on any failure — registry down, package not
 * found, network error, malformed response. The caller treats null as "no
 * fresh data available" and continues without it.
 */
export async function npmVersionLookup(
    pkg: string,
    opts: NpmVersionOpts = {}
): Promise<NpmVersionInfo | null> {
    if (!isValidPackageName(pkg)) return null

    const base = opts.registry ?? REGISTRY_BASE
    const url = `${base}/${encodePackageName(pkg)}`
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const internalController = new AbortController()
    const timeoutHandle = setTimeout(() => internalController.abort(), timeoutMs)
    const onUserAbort = () => internalController.abort()
    if (opts.signal) {
        if (opts.signal.aborted) onUserAbort()
        else opts.signal.addEventListener('abort', onUserAbort, {once: true})
    }

    try {
        let response: Response
        try {
            response = await fetch(url, {
                method: 'GET',
                headers: {accept: 'application/vnd.npm.install-v1+json, application/json'},
                signal: internalController.signal
            })
        } catch {
            return null
        }
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
    } finally {
        clearTimeout(timeoutHandle)
        if (opts.signal) opts.signal.removeEventListener('abort', onUserAbort)
    }
}

/** Format an NpmVersionInfo as a short Markdown block for EXTERNAL CONTEXT. */
export function formatNpmVersionSection(info: NpmVersionInfo): string {
    const lines = [`### npm: ${info.pkg}`, `latest: ${info.latest}`]
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
