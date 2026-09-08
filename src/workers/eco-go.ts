/**
 * eco-go — reading Go packages for the docs Worker tool.
 *
 * Three things separate this row from the others.
 *
 * A Go IMPORT PATH is not a module. `github.com/gin-gonic/gin/binding` is served
 * by the `gin` module, and `github.com/aws/aws-sdk-go-v2/service/s3` is its own
 * module despite looking like a subdirectory of one. No syntactic rule tells
 * them apart, so the module boundary is found by asking the proxy for the
 * longest prefix that resolves — longest FIRST, because shorter prefixes answer
 * too: `github.com/go-redis/redis` is a real, ancient, different module from
 * `github.com/go-redis/redis/v8`.
 *
 * The go.mod IS the lockfile. From Go 1.17 the indirect block is the complete
 * pruned closure with resolved versions, so nothing here walks a dependency
 * graph and `go.sum` is never read: it carries integrity hashes for versions
 * that were considered and rejected, so using it would over-report.
 *
 * And Go has no re-export syntax at all — no `pub use`, no export list — so this
 * row sets neither `supplements` nor `exportGap`. Every name a package exports
 * is declared in that package's own files.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {ResolveError, type ResolvedPackage} from './docs-resolve.js'
import {findAtOrAbove} from './eco-cargo.js'
import {buildConstraint} from './go-surface.js'
import {readZip, readEntry, isUnsafeEntryName} from '../shared/zip.js'
import {acquireStdlibPackage, findInGoroot, findSliced} from './go-stdlib.js'
import type {NpmVersionInfo} from './npm-version.js'

const PROXY = 'https://proxy.golang.org'
const USER_AGENT = 'pi-task (github.com/mjasnikovs/pi-task)'

/**
 * Hosts that never serve a module at `<host>/<one segment>`, so the prefix walk
 * has a floor and does not spend two requests proving `github.com/gin-gonic` is
 * not a module.
 */
const TWO_SEGMENT_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org'])

export function isValidImportPath(name: string): boolean {
    if (!name || name.startsWith('/') || name.endsWith('/')) return false
    if (name.includes('..') || name.includes('//')) return false
    return /^[A-Za-z0-9][A-Za-z0-9._~+-]*(?:\/[A-Za-z0-9._~+-]+)*$/.test(name)
}

/**
 * The proxy and the module cache both spell an uppercase letter as `!` plus its
 * lowercase form, so that a case-insensitive filesystem cannot collide two
 * modules whose paths differ only in case.
 */
export function escapeModulePath(name: string): string {
    return name.replace(/[A-Z]/g, c => `!${c.toLowerCase()}`)
}

export function unescapeModulePath(name: string): string {
    return name.replace(/!([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * Go's own rule, from `cmd/go`'s `IsStandardImportPath`: the first path element
 * of a standard-library import contains no dot. `net/http` is stdlib,
 * `go.uber.org/zap` is not.
 */
export function isStdlibImport(importPath: string): boolean {
    const first = importPath.split('/')[0]
    return first !== '' && !first.includes('.')
}

/**
 * Is this import path the standard library, in THIS project?
 *
 * Go's rule is purely lexical, so a project whose own module path has no dot —
 * `module myapp` — makes `myapp/internal/db` look like stdlib. The project's own
 * module is stripped first, which is what `cmd/go` effectively does too.
 */
export function isProjectStdlib(importPath: string, cwd: string): boolean {
    if (!isStdlibImport(importPath)) return false
    const own = goProjectName(cwd)
    return own === null || !prefixes(own, importPath)
}

export function isGoFile(name: string): boolean {
    // On the suffix, never the word "test": `test_helpers.go` holds
    // `gin.CreateTestContext`, which is documented public API.
    return name.endsWith('.go') && !name.endsWith('_test.go')
}

function safeRead(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

export interface GoRequire {
    module: string
    version: string
    indirect: boolean
}

export interface GoMod {
    module: string | null
    /** The `go` directive, which says which language version the source targets. */
    goVersion: string | null
    toolchain: string | null
    requires: GoRequire[]
    /** `replace` targets, by the module being replaced. */
    replaces: Map<string, string>
}

const REQUIRE_LINE_RE = /^([^\s()]+)\s+(\S+)(.*)$/

/**
 * Parse a `go.mod`.
 *
 * Written against what real files contain rather than the grammar's happy path:
 * gin has THREE `require` blocks, single-line and block forms mix freely, and
 * the direct/indirect split is the `// indirect` comment and never the block a
 * line happens to sit in.
 */
export function parseGoMod(text: string): GoMod {
    const out: GoMod = {
        module: null,
        goVersion: null,
        toolchain: null,
        requires: [],
        replaces: new Map()
    }
    type Block = 'require' | 'replace' | 'exclude' | 'retract'
    let block: Block | null = null

    for (const raw of text.split('\n')) {
        const line = stripLineComment(raw).trim()
        if (line === '') continue
        if (block !== null) {
            if (line === ')') block = null
            else if (block === 'require') addRequire(out, line, raw)
            else if (block === 'replace') addReplace(out, line)
            continue
        }
        const open = /^(require|replace|exclude|retract)\s*\($/.exec(line)
        if (open) {
            block = open[1] as Block
            continue
        }
        const single = /^(module|go|toolchain|require|replace)\s+(.*)$/.exec(line)
        if (!single) continue
        const [, directive, rest] = single
        if (directive === 'module') out.module = rest.trim()
        else if (directive === 'go') out.goVersion = rest.trim()
        else if (directive === 'toolchain') out.toolchain = rest.trim()
        else if (directive === 'require') addRequire(out, rest, raw)
        else addReplace(out, rest)
    }
    return out
}

/** Strip a `//` comment, keeping enough of it to see an `// indirect` marker. */
function stripLineComment(line: string): string {
    const at = line.indexOf('//')
    return at < 0 ? line : line.slice(0, at)
}

function addRequire(out: GoMod, line: string, raw: string): void {
    const match = REQUIRE_LINE_RE.exec(line.trim())
    if (!match) return
    out.requires.push({
        module: match[1],
        version: match[2],
        indirect: /\/\/\s*indirect/.test(raw)
    })
}

function addReplace(out: GoMod, line: string): void {
    const match = /^(\S+)(?:\s+\S+)?\s*=>\s*(\S+)/.exec(line.trim())
    if (match) out.replaces.set(match[1], match[2])
}

/**
 * A `replace` target that is a directory rather than a module path. Its source
 * is in the working tree, so the proxy has nothing to serve for it — and the
 * placeholder version such an entry carries (`k8s.io/api v0.0.0`) would 404.
 */
function isLocalReplacement(target: string): boolean {
    return target.startsWith('.') || target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)
}

/** The `use` directories a `go.work` names, resolved against its own location. */
export function parseGoWork(text: string, dir: string): string[] {
    const dirs: string[] = []
    let inBlock = false
    for (const raw of text.split('\n')) {
        const line = stripLineComment(raw).trim()
        if (line === '') continue
        if (inBlock) {
            if (line === ')') inBlock = false
            else dirs.push(path.resolve(dir, line))
            continue
        }
        if (/^use\s*\($/.test(line)) inBlock = true
        else {
            const single = /^use\s+(\S+)$/.exec(line)
            if (single) dirs.push(path.resolve(dir, single[1]))
        }
    }
    return dirs
}

/**
 * Every `go.mod` that governs `cwd`.
 *
 * A `go.work` wins where there is one: each of its `use` directories is a
 * first-class module, and taking only the root would miss every dependency the
 * members declare.
 */
export function goManifests(cwd: string): string[] {
    const work = findAtOrAbove(cwd, 'go.work')
    if (work) {
        const text = safeRead(work)
        if (text !== null) {
            const mods = parseGoWork(text, path.dirname(work))
                .map(d => path.join(d, 'go.mod'))
                .filter(f => fs.existsSync(f))
            if (mods.length > 0) return mods
        }
    }
    const mod = findAtOrAbove(cwd, 'go.mod')
    return mod ? [mod] : []
}

export function detectGo(cwd: string): boolean {
    return findAtOrAbove(cwd, 'go.mod') !== null || findAtOrAbove(cwd, 'go.work') !== null
}

/** The project's own module path, from the nearest manifest. */
export function goProjectName(cwd: string): string | null {
    const manifests = goManifests(cwd)
    if (manifests.length === 0) return null
    const text = safeRead(manifests[0])
    return text === null ? null : parseGoMod(text).module
}

function readManifests(cwd: string): GoMod[] | undefined {
    const files = goManifests(cwd)
    if (files.length === 0) return undefined
    const parsed = files
        .map(safeRead)
        .filter((t): t is string => t !== null)
        .map(parseGoMod)
    return parsed.length > 0 ? parsed : undefined
}

/**
 * Every module version the project resolves, direct and indirect.
 *
 * A `replace` onto a local directory is dropped: nothing can be fetched for it,
 * and its recorded version is a placeholder rather than a fact about a release.
 */
export function goDeclaredDeps(cwd: string): Record<string, string> | undefined {
    const mods = readManifests(cwd)
    if (!mods) return undefined
    const out: Record<string, string> = {}
    for (const mod of mods) {
        for (const req of mod.requires) {
            const replacement = mod.replaces.get(req.module)
            if (replacement !== undefined && isLocalReplacement(replacement)) continue
            if (!(req.module in out)) out[req.module] = req.version
        }
    }
    return out
}

/**
 * The modules the project may import directly — the requires with no
 * `// indirect` marker, less the workspace's own members, which resolve from the
 * working tree rather than from a registry.
 */
export function goManifestDeps(cwd: string): Set<string> | undefined {
    const mods = readManifests(cwd)
    if (!mods) return undefined
    const members = new Set(mods.map(m => m.module).filter((m): m is string => m !== null))
    const out = new Set<string>()
    for (const mod of mods) {
        for (const req of mod.requires) {
            if (!req.indirect && !members.has(req.module)) out.add(req.module)
        }
    }
    return out
}

/**
 * The version the project pins the module serving `importPath` to.
 *
 * The longest require whose path prefixes the import wins, so
 * `github.com/aws/aws-sdk-go-v2/service/s3` takes the s3 submodule's own pin and
 * not the SDK core's.
 */
export function goDeclaredVersion(importPath: string, cwd: string): string | null {
    const deps = goDeclaredDeps(cwd)
    if (!deps) return null
    let best: string | null = null
    let longest = -1
    for (const [module, version] of Object.entries(deps)) {
        if (!prefixes(module, importPath) || module.length <= longest) continue
        longest = module.length
        best = version
    }
    return best
}

function prefixes(module: string, importPath: string): boolean {
    return importPath === module || importPath.startsWith(`${module}/`)
}

export interface VendorEntry {
    module: string
    version: string
}

/**
 * The package-to-module map `vendor/modules.txt` states outright.
 *
 * Exact and free: no prefix walk, no request, and replaces already applied. Its
 * one limit is that `go mod vendor` copies only the packages the project
 * imports, so a question about an untouched corner of a dependency still needs
 * the module zip.
 */
export function parseVendorModules(text: string): Map<string, VendorEntry> {
    const out = new Map<string, VendorEntry>()
    let current: VendorEntry | null = null
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line === '') continue
        if (line.startsWith('##')) continue
        if (line.startsWith('# ')) {
            const match = /^#\s+(\S+)\s+(\S+)/.exec(line)
            current = match ? {module: match[1], version: match[2]} : null
            continue
        }
        if (line.startsWith('#')) continue
        if (current) out.set(line, current)
    }
    return out
}

export interface GoResolveDirs {
    /** `$GOMODCACHE`, holding extracted module trees and downloaded zips. */
    goModCache: string
    /** Where a module fetched by this tool was extracted. */
    modulesDir: string
    /** A local Go installation, whose `src/` is the standard library for free. */
    goroot?: string | undefined
}

export function defaultGoModCache(): string {
    const configured = process.env.GOMODCACHE?.trim()
    if (configured) return configured
    const gopath = process.env.GOPATH?.trim() || path.join(os.homedir(), 'go')
    return path.join(gopath, 'pkg', 'mod')
}

interface FoundPackage {
    module: string
    version: string
    /** The package's own directory, which is the module root for a root package. */
    dir: string
}

/** Extracted module trees, newest source of truth last so a fetch wins a tie. */
function moduleRoots(dirs: GoResolveDirs): string[] {
    return [dirs.goModCache, path.join(dirs.modulesDir, 'go')]
}

/**
 * Find the directory serving `importPath` under one extracted-modules root.
 *
 * The module boundary is read off the DIRECTORY NAME — every extracted tree is
 * `<escaped module>@<version>` — so no manifest is parsed and no network is
 * touched. The longest matching prefix wins, for the same reason the proxy walk
 * runs longest-first.
 */
function findInRoot(root: string, importPath: string, pinned: string | null): FoundPackage | null {
    for (const module of modulePrefixes(importPath)) {
        const parent = path.join(root, ...escapeModulePath(module).split('/').slice(0, -1))
        const leaf = escapeModulePath(module).split('/').pop()!
        let entries: string[]
        try {
            entries = fs.readdirSync(parent)
        } catch {
            continue
        }
        const versions = entries
            .filter(e => e.startsWith(`${leaf}@`))
            .map(e => ({dir: path.join(parent, e), version: e.slice(leaf.length + 1)}))
        const wanted = pinned ? versions.filter(v => v.version === pinned) : versions
        if (wanted.length === 0) continue
        const chosen = wanted.sort((a, b) => a.version.localeCompare(b.version)).pop()!
        const sub = importPath.slice(module.length).replace(/^\//, '')
        const dir = sub === '' ? chosen.dir : path.join(chosen.dir, ...sub.split('/'))
        if (!fs.existsSync(dir)) continue
        return {module, version: chosen.version, dir}
    }
    return null
}

/** Candidate module paths for an import, longest first. */
export function modulePrefixes(importPath: string): string[] {
    const parts = importPath.split('/')
    const floor = TWO_SEGMENT_HOSTS.has(parts[0]) ? 3 : 2
    const out: string[] = []
    for (let n = parts.length; n >= Math.min(floor, parts.length); n--) {
        out.push(parts.slice(0, n).join('/'))
    }
    return out
}

function readmeIn(root: string): string | null {
    for (const name of ['README.md', 'readme.md', 'README.markdown', 'README']) {
        const abs = path.join(root, name)
        if (fs.existsSync(abs)) return abs
    }
    return null
}

/** The file most likely to carry the package's headline documentation. */
function entryIn(root: string, importPath: string): string | null {
    const leaf = importPath.split('/').pop() ?? ''
    for (const name of ['doc.go', `${leaf}.go`]) {
        const abs = path.join(root, name)
        if (fs.existsSync(abs)) return abs
    }
    try {
        const first = fs.readdirSync(root).filter(isGoFile).sort()[0]
        return first === undefined ? null : path.join(root, first)
    } catch {
        return null
    }
}

/**
 * Find a Go package's source on disk.
 *
 * Vendored source first: it is exact, already extracted, and needs nothing from
 * the network. Then the module cache, then whatever this tool fetched earlier.
 */
export function resolveGoPackage(
    importPath: string,
    cwd: string,
    dirs: GoResolveDirs
): ResolvedPackage {
    if (!isValidImportPath(importPath)) {
        throw new ResolveError('invalid_name', `Invalid Go import path: "${importPath}"`)
    }
    const found =
        isProjectStdlib(importPath, cwd) ?
            resolveStdlib(importPath, dirs)
        :   (resolveVendored(importPath, cwd) ?? resolveExtracted(importPath, cwd, dirs))
    if (!found) {
        throw new ResolveError(
            'not_installed',
            `Go package "${importPath}" has no source under ${dirs.goModCache}, `
                + `${path.join(dirs.modulesDir, 'go')} or a vendor directory.`
        )
    }
    return {
        ecosystem: 'go',
        name: importPath,
        version: found.version,
        root: found.dir,
        entry: entryIn(found.dir, importPath),
        readme: readmeIn(found.dir)
    }
}

/** A local toolchain first: it costs nothing and matches the project's build. */
function resolveStdlib(importPath: string, dirs: GoResolveDirs): FoundPackage | null {
    const found = findInGoroot(importPath, dirs.goroot) ?? findSliced(importPath, moduleRoots(dirs))
    return found ? {module: 'std', version: found.version, dir: found.dir} : null
}

function resolveVendored(importPath: string, cwd: string): FoundPackage | null {
    const manifest = findAtOrAbove(cwd, 'vendor', 'modules.txt')
    if (!manifest) return null
    const text = safeRead(manifest)
    if (text === null) return null
    const entry = parseVendorModules(text).get(importPath)
    if (!entry) return null
    const dir = path.join(path.dirname(manifest), ...importPath.split('/'))
    return fs.existsSync(dir) ? {module: entry.module, version: entry.version, dir} : null
}

function resolveExtracted(
    importPath: string,
    cwd: string,
    dirs: GoResolveDirs
): FoundPackage | null {
    // A pin that is not on disk is not_installed, never an invitation to answer
    // from whatever version another checkout left behind: nothing downstream
    // marks the substitution.
    const pinned = goDeclaredVersion(importPath, cwd)
    for (const root of moduleRoots(dirs)) {
        const found = findInRoot(root, importPath, pinned)
        if (found) return found
    }
    return null
}

interface ProxyInfo {
    Version?: unknown
    Time?: unknown
    Origin?: {Subdir?: unknown}
}

/**
 * One `@latest` or `.info` lookup.
 *
 * A 200 is not enough. `github.com/aws/aws-sdk-go-v2/service/@latest` answered
 * `200` with an empty body on one probe and `404` on the next, so a walk that
 * stops on `res.ok` lands on a path that is not a module at all.
 */
async function proxyInfo(
    module: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<ProxyInfo | null> {
    try {
        const response = await fetchFn(`${PROXY}/${escapeModulePath(module)}/@latest`, {
            headers: {'user-agent': USER_AGENT, accept: 'application/json'},
            ...(signal ? {signal} : {})
        })
        if (!response.ok) return null
        const body = (await response.json()) as ProxyInfo
        return typeof body?.Version === 'string' && body.Version !== '' ? body : null
    } catch {
        return null
    }
}

/**
 * Which module serves `importPath`, by asking the proxy about the longest
 * prefix first.
 *
 * Longest first is not an optimisation. `github.com/go-redis/redis/v8` and
 * `github.com/go-redis/redis` both resolve, to different modules a major apart,
 * and a walk that grows from the left returns the wrong one every time.
 */
export async function resolveModulePath(
    importPath: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<{module: string; version: string} | null> {
    for (const candidate of modulePrefixes(importPath)) {
        const info = await proxyInfo(candidate, fetchFn, signal)
        if (info) return {module: candidate, version: info.Version as string}
    }
    return null
}

/** The newest published version of the module serving `importPath`. */
export async function goLatest(
    importPath: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<NpmVersionInfo | null> {
    if (isStdlibImport(importPath)) return null
    for (const candidate of modulePrefixes(importPath)) {
        const info = await proxyInfo(candidate, fetchFn, signal)
        if (!info) continue
        return {
            pkg: candidate,
            latest: info.Version as string,
            recent: [],
            ...(typeof info.Time === 'string' ? {publishedAt: info.Time} : {})
        }
    }
    return null
}

export function moduleZipUrl(module: string, version: string): string {
    return `${PROXY}/${escapeModulePath(module)}/@v/${escapeModulePath(version)}.zip`
}

/**
 * Fetch a module and extract its Go source under `<modulesDir>/go`.
 *
 * Entries are laid out exactly as the module cache lays them out —
 * `<module>@<version>/…`, in the module's original case — so what lands on disk
 * is indistinguishable from a tree `go mod download` would have written, and
 * `findInRoot` reads both with one rule.
 */
export async function acquireGoModule(
    importPath: string,
    pinned: string | null,
    cwd: string,
    dirs: GoResolveDirs,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<{success: boolean; installDir: string; stderr: string}> {
    const installDir = path.join(dirs.modulesDir, 'go')
    if (isProjectStdlib(importPath, cwd)) {
        return acquireStdlibPackage({
            importPath,
            goDirective: goDirectiveOf(cwd),
            installDir,
            fetchFn,
            signal
        })
    }
    const resolved = await resolveModulePath(importPath, fetchFn, signal)
    if (!resolved) {
        return {
            success: false,
            installDir,
            stderr: `No module on ${PROXY} serves the import path "${importPath}".`
        }
    }
    const version = pinned ?? resolved.version
    try {
        const response = await fetchFn(moduleZipUrl(resolved.module, version), {
            headers: {'user-agent': USER_AGENT},
            redirect: 'follow',
            ...(signal ? {signal} : {})
        })
        if (!response.ok) {
            return {
                success: false,
                installDir,
                stderr: `${resolved.module}@${version}: proxy returned ${response.status}.`
            }
        }
        writeModule(Buffer.from(await response.arrayBuffer()), installDir, resolved.module, version)
        return {success: true, installDir, stderr: ''}
    } catch (err) {
        return {
            success: false,
            installDir,
            stderr: err instanceof Error ? err.message : String(err)
        }
    }
}

/** The language version the project targets, for picking a toolchain to read. */
function goDirectiveOf(cwd: string): string | null {
    const manifests = goManifests(cwd)
    if (manifests.length === 0) return null
    const text = safeRead(manifests[0])
    return text === null ? null : parseGoMod(text).goVersion
}

/** Only the files a reader can use: Go source, documentation, and the manifest. */
function isWantedEntry(name: string): boolean {
    const leaf = name.split('/').pop() ?? ''
    return isGoFile(leaf) || leaf === 'go.mod' || /^readme(\.md|\.markdown)?$/i.test(leaf)
}

/**
 * The zip spells the module path in its ORIGINAL case; the module cache spells it
 * escaped. Writing the entries verbatim leaves `github.com/BurntSushi/toml`
 * beside a resolver looking for `github.com/!burnt!sushi/toml`, and every
 * uppercase module resolves as not-installed straight after a successful fetch.
 */
function writeModule(archive: Buffer, installDir: string, module: string, version: string): void {
    const from = `${module}@${version}/`
    const to = `${escapeModulePath(module)}@${escapeModulePath(version)}/`
    for (const entry of readZip(archive)) {
        if (!isWantedEntry(entry.name) || isUnsafeEntryName(entry.name)) continue
        const rel = entry.name.startsWith(from) ? to + entry.name.slice(from.length) : entry.name
        const target = path.join(installDir, ...rel.split('/'))
        fs.mkdirSync(path.dirname(target), {recursive: true})
        fs.writeFileSync(target, readEntry(archive, entry))
    }
}

/**
 * Keep one file per set of build-tag variants.
 *
 * Go does what npm's `.d.ts`/`.d.cts` twins do: `binding.go` and
 * `binding_nomsgpack.go` declare the same twelve names under opposite
 * constraints, and `internal/json` declares the same five names four times. All
 * of them in one index is duplicate text competing for the retrieval budget with
 * nothing to tell the copies apart.
 *
 * The default build decides, which is what a reader gets by running `go build`
 * with no tags: a bare negation holds, a bare tag does not.
 */
export function selectBuildVariants(files: readonly string[]): string[] {
    const byDir = new Map<string, string[]>()
    for (const file of files) {
        const dir = path.dirname(file)
        byDir.set(dir, [...(byDir.get(dir) ?? []), file])
    }
    const kept: string[] = []
    for (const group of byDir.values()) {
        const defaults = group.filter(f => holdsByDefault(safeRead(f) ?? ''))
        // A directory whose every file is tag-guarded still has to be readable.
        kept.push(...(defaults.length > 0 ? defaults : group))
    }
    return kept.sort()
}

/**
 * Does this file compile with no `-tags` argument?
 *
 * Only the shapes that actually occur: a conjunction of bare tags and bare
 * negations. Anything with a parenthesis or a version tag is kept, because
 * guessing wrong drops real API and keeping a duplicate only costs budget.
 */
function holdsByDefault(src: string): boolean {
    const constraint = buildConstraint(src)
    if (constraint === null) return true
    const expr = constraint.replace(/^\/\/go:build\s*/, '').trim()
    if (/[()|]/.test(expr) || /\bgo1\./.test(expr)) return true
    return expr.split(/\s*&&\s*/).every(term => term.startsWith('!'))
}

/**
 * Everything below `goSurface` and the file-selection rule that feeds it, by
 * source, so a fix to either re-indexes rather than being masked by a cache hit.
 */
export function goContentFingerprintParts(): string[] {
    return [String(selectBuildVariants), String(holdsByDefault), String(isWantedEntry)]
}
