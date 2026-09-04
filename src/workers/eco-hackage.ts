/**
 * eco-hackage — reading Haskell packages for the docs Worker tool.
 *
 * Two things make Haskell unlike the other rows.
 *
 * A package is distributed as a tarball, not as a checked-out tree: cabal keeps
 * `<name>-<version>.tar.gz` and nothing else, so a package has to be extracted
 * before it can be read. Extraction is a spawn, and a row's `resolve` is
 * synchronous, so it happens in `acquire` — which is also where a package cabal
 * has never fetched is downloaded from Hackage. Both paths end the same way: an
 * extracted tree under the tool's own modules directory.
 *
 * And a Haskell MODULE name is not its PACKAGE name. `Data.Aeson` lives in
 * `aeson`; asking Hackage for `Data.Aeson` finds nothing. That is the mistake
 * issue #18 opened on, so it is refused by name with the correction in the
 * message rather than silently missing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {ResolveError, type ResolvedPackage} from './docs-resolve.js'
import {childDirs} from './eco-cargo.js'
import type {NpmVersionInfo} from './npm-version.js'

const HACKAGE = 'https://hackage.haskell.org/package'
/** Where cabal files a downloaded tarball, under any of its package directories. */
const HACKAGE_REPO = 'hackage.haskell.org'

export function isValidHackageName(name: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)
}

/** True for a dotted Haskell MODULE name, which is never a package name. */
export function looksLikeModuleName(name: string): boolean {
    return /^[A-Z][A-Za-z0-9_']*(?:\.[A-Z][A-Za-z0-9_']*)+$/.test(name)
}

function safeRead(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

/** The first existing file at `rel` at or above `cwd`, or one level below it. */
function findUpOrDown(cwd: string, rel: string[]): string | null {
    let dir = cwd
    while (true) {
        const candidate = path.join(dir, ...rel)
        if (fs.existsSync(candidate)) return candidate
        const up = path.dirname(dir)
        if (up === dir) break
        dir = up
    }
    for (const child of childDirs(cwd)) {
        const candidate = path.join(child, ...rel)
        if (fs.existsSync(candidate)) return candidate
    }
    return null
}

interface CabalPlan {
    'install-plan'?: Array<{'pkg-name'?: unknown; 'pkg-version'?: unknown}>
}

/**
 * Every package version this build resolved, name to version.
 *
 * Three sources in falling order of authority. `dist-newstyle/cache/plan.json` is
 * what cabal actually built and is exact. A `cabal.project.freeze` is what the
 * project asked for and is exact too, but may predate the build. `stack.yaml.lock`
 * covers a stack project, which has no plan.json at all. None of them present is
 * a real answer — the project pins nothing here — and the caller then falls back
 * to whatever Hackage calls latest.
 */
export function resolvedVersions(cwd: string): Record<string, string> | undefined {
    const plan = findUpOrDown(cwd, ['dist-newstyle', 'cache', 'plan.json'])
    if (plan) {
        const parsed = parsePlanJson(safeRead(plan) ?? '')
        if (parsed) return parsed
    }
    const freeze = findUpOrDown(cwd, ['cabal.project.freeze'])
    if (freeze) {
        const parsed = parseFreeze(safeRead(freeze) ?? '')
        if (Object.keys(parsed).length) return parsed
    }
    const stackLock = findUpOrDown(cwd, ['stack.yaml.lock'])
    if (stackLock) {
        const parsed = parseStackLock(safeRead(stackLock) ?? '')
        if (Object.keys(parsed).length) return parsed
    }
    return undefined
}

export function parsePlanJson(text: string): Record<string, string> | undefined {
    let body: CabalPlan
    try {
        body = JSON.parse(text) as CabalPlan
    } catch {
        return undefined
    }
    const plan = body['install-plan']
    if (!Array.isArray(plan)) return undefined
    const out: Record<string, string> = {}
    for (const entry of plan) {
        const name = entry['pkg-name']
        const version = entry['pkg-version']
        if (typeof name === 'string' && typeof version === 'string') out[name] = version
    }
    return out
}

/**
 * `cabal.project.freeze` states each pin as `any.<name> ==<version>`. Scanned
 * across the whole file rather than line by line: cabal writes the first
 * constraint on the `constraints:` line itself and the rest indented below it.
 */
export function parseFreeze(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    const re = /\bany\.([A-Za-z0-9-]+)\s*==\s*([0-9][0-9.]*)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) out[m[1]] = m[2]
    return out
}

/** `stack.yaml.lock` names each extra dep as `hackage: <name>-<version>@sha256:…`. */
export function parseStackLock(text: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const raw of text.split('\n')) {
        const m = /hackage:\s*([A-Za-z0-9-]+)-([0-9][0-9.]*)@/.exec(raw)
        if (m) out[m[1]] = m[2]
    }
    return out
}

export function hackageVersion(name: string, cwd: string): string | null {
    return resolvedVersions(cwd)?.[name] ?? null
}

export function hackageTarballUrl(name: string, version: string): string {
    return `${HACKAGE}/${name}-${version}/${name}-${version}.tar.gz`
}

/** The tarball cabal has already downloaded, in any of its package directories. */
export function findCabalTarball(
    name: string,
    version: string,
    packageDirs: readonly string[]
): string | null {
    for (const dir of packageDirs) {
        const candidate = path.join(dir, HACKAGE_REPO, name, version, `${name}-${version}.tar.gz`)
        if (fs.existsSync(candidate)) return candidate
    }
    return null
}

/** Every version of `name` cabal holds a tarball for, oldest first. */
export function cachedVersions(name: string, packageDirs: readonly string[]): string[] {
    const found = new Set<string>()
    for (const dir of packageDirs) {
        try {
            for (const entry of fs.readdirSync(path.join(dir, HACKAGE_REPO, name))) {
                if (/^[0-9]/.test(entry)) found.add(entry)
            }
        } catch {
            continue
        }
    }
    return [...found].sort(compareVersions)
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0)
        if (d !== 0) return d
    }
    return 0
}

/** Where the tool keeps its own extracted copies. */
export function hackageExtractDir(modulesDir: string): string {
    return path.join(modulesDir, 'hackage')
}

function newestExtracted(dir: string, name: string): {root: string; version: string} | null {
    let best: {root: string; version: string} | null = null
    try {
        for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
            if (!entry.isDirectory()) continue
            const cut = entry.name.lastIndexOf('-')
            if (cut < 0 || entry.name.slice(0, cut) !== name) continue
            const version = entry.name.slice(cut + 1)
            if (!/^\d/.test(version)) continue
            if (!best || compareVersions(version, best.version) > 0) {
                best = {root: path.join(dir, entry.name), version}
            }
        }
    } catch {
        return null
    }
    return best
}

const README_NAMES = ['README.md', 'README.markdown', 'readme.md', 'ReadMe.md', 'changelog.md']

function readmeIn(root: string): string | null {
    for (const name of README_NAMES) {
        const abs = path.join(root, name)
        if (fs.existsSync(abs)) return abs
    }
    return null
}

/**
 * The module that carries the package's headline API — `aeson` documents itself
 * in `Data/Aeson.hs`. Matched by the last path segment, since a package name is
 * lowercase and its module path is not.
 */
function entryIn(root: string, name: string): string | null {
    const wanted = `${name.replace(/-/g, '').toLowerCase()}.hs`
    const files = walkHaskell(root)
    const headline = files.find(f => path.basename(f).toLowerCase() === wanted)
    if (headline) return headline
    return files[0] ?? null
}

/** Library sources only — `tests/` and `benchmarks/` answer no API question. */
export const HACKAGE_SKIP_DIRS = [
    'tests',
    'test',
    'benchmarks',
    'bench',
    'examples',
    'dist-newstyle',
    'golden'
] as const

function walkHaskell(root: string): string[] {
    const out: string[] = []
    const stack = [root]
    while (stack.length) {
        const dir = stack.pop()!
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            continue
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                if (!(HACKAGE_SKIP_DIRS as readonly string[]).includes(entry.name)) {
                    stack.push(path.join(dir, entry.name))
                }
            } else if (entry.isFile() && entry.name.endsWith('.hs')) {
                out.push(path.join(dir, entry.name))
            }
        }
    }
    return out.sort()
}

export interface HackageResolveDirs {
    modulesDir: string
}

/**
 * Find an EXTRACTED package. A tarball cabal holds is not readable in place, and
 * unpacking it is a spawn, so getting it into this state is `acquire`'s job.
 */
export function resolveHackage(
    name: string,
    cwd: string,
    dirs: HackageResolveDirs
): ResolvedPackage {
    if (looksLikeModuleName(name)) {
        throw new ResolveError(
            'invalid_name',
            `"${name}" is a Haskell MODULE name. Pass the Hackage PACKAGE that ships it `
                + '(for example "aeson", not "Data.Aeson").'
        )
    }
    if (!isValidHackageName(name)) {
        throw new ResolveError('invalid_name', `Invalid Hackage package name: "${name}"`)
    }
    const extractDir = hackageExtractDir(dirs.modulesDir)
    const pinned = hackageVersion(name, cwd)
    const exact = pinned ? path.join(extractDir, `${name}-${pinned}`) : null
    const found =
        exact && fs.existsSync(exact) ?
            {root: exact, version: pinned!}
        :   newestExtracted(extractDir, name)
    if (!found) {
        throw new ResolveError(
            'not_installed',
            `Hackage package "${name}" is not unpacked under ${extractDir}.`
        )
    }
    return {
        ecosystem: 'hackage',
        name,
        version: found.version,
        root: found.root,
        entry: entryIn(found.root, name),
        readme: readmeIn(found.root)
    }
}

interface PreferredResponse {
    'normal-version'?: unknown
}

/**
 * The newest version Hackage does not deprecate. `/preferred` returns them newest
 * first, with the deprecated ones in their own list — so this never names a
 * version the maintainer has withdrawn.
 */
export async function hackageLatest(
    name: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<NpmVersionInfo | null> {
    if (!isValidHackageName(name)) return null
    try {
        const response = await fetchFn(`${HACKAGE}/${encodeURIComponent(name)}/preferred`, {
            headers: {accept: 'application/json'},
            ...(signal ? {signal} : {})
        })
        if (!response.ok) return null
        const body = (await response.json()) as PreferredResponse
        const versions = body['normal-version']
        if (!Array.isArray(versions) || typeof versions[0] !== 'string') return null
        return {pkg: name, latest: versions[0], recent: versions.slice(0, 10) as string[]}
    } catch {
        return null
    }
}

// ── surface extraction ──────────────────────────────────────────────────────

/** Where a Haskell declaration begins, so a chunk never splits a signature. */
export const HACKAGE_DECL_SPLIT_RE =
    /^(?:[a-z_][\w']*\s*::|data\s|newtype\s|type\s|class\s|instance\s|pattern\s)/m

const SIGNATURE_RE = /^[a-z_][\w']*(?:\s*,\s*[a-z_][\w']*)*\s*::/
const OPERATOR_SIGNATURE_RE = /^\([^)]+\)\s*::/
const TYPE_HEAD_RE = /^(data|newtype|type|class|instance|pattern|foreign import)\b/
const HADDOCK_RE = /^--\s*[|^]/

/**
 * Reduce Haskell source to its public API surface: the module header with its
 * export list, every top-level type signature, every type and class
 * declaration, and the haddock attached to each.
 *
 * Equations go. In Haskell the signature IS the interface and the equations
 * below it are the implementation, so dropping them loses nothing a caller can
 * name — and an `instance` body is the same thing under another keyword, which
 * is why only its head survives.
 */
export function haskellSurface(src: string): string {
    const lines = src.split('\n')
    const out: string[] = []
    let i: number

    // The export list is the module's own statement of its API, and it spans
    // however many lines it takes to balance the parentheses.
    const moduleStart = lines.findIndex(l => /^module\s/.test(l))
    if (moduleStart >= 0) {
        let depth = 0
        let seenParen = false
        for (i = moduleStart; i < lines.length; i++) {
            out.push(lines[i])
            for (const c of lines[i]) {
                if (c === '(') {
                    depth++
                    seenParen = true
                } else if (c === ')') depth--
            }
            if (/\bwhere\b/.test(lines[i]) && (!seenParen || depth <= 0)) {
                i++
                break
            }
        }
        out.push('')
    } else {
        i = 0
    }

    let pending: string[] = []
    while (i < lines.length) {
        const line = lines[i]
        if (line.trim() === '') {
            i++
            continue
        }
        if (/^\s/.test(line)) {
            // A continuation with no head above it belongs to something dropped.
            i++
            continue
        }
        if (HADDOCK_RE.test(line)) {
            pending.push(line)
            i++
            continue
        }
        if (line.startsWith('--') || line.startsWith('{-#') || /^import\s/.test(line)) {
            pending = []
            i++
            continue
        }

        const block: string[] = [line]
        let j = i + 1
        while (j < lines.length && (lines[j].trim() === '' || /^\s/.test(lines[j]))) {
            block.push(lines[j])
            j++
        }
        // Drop the blank tail the block picked up on its way to the next head.
        while (block.length && block[block.length - 1].trim() === '') block.pop()

        if (SIGNATURE_RE.test(line) || OPERATOR_SIGNATURE_RE.test(line)) {
            out.push(...pending, ...block, '')
        } else if (TYPE_HEAD_RE.test(line)) {
            const head = TYPE_HEAD_RE.exec(line)![1]
            // An instance's indented lines are definitions, not fields.
            out.push(...pending, ...(head === 'instance' ? [line] : block), '')
        }
        pending = []
        i = j
    }
    return out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

export function isHaskellFile(name: string): boolean {
    return name.endsWith('.hs')
}

/** The `name:` field of the project's own `.cabal` file. */
export function hackageProjectName(cwd: string): string | null {
    let entries: string[]
    try {
        entries = fs.readdirSync(cwd)
    } catch {
        return null
    }
    const cabal = entries.find(e => e.endsWith('.cabal'))
    if (!cabal) return null
    const match = /^\s*name\s*:\s*(\S+)/m.exec(safeRead(path.join(cwd, cabal)) ?? '')
    return match ? match[1] : null
}
