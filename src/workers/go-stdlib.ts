/**
 * go-stdlib — reading `net/http`, `fmt` and the rest of Go's standard library.
 *
 * The standard library is a large share of what anyone asks about Go and it is
 * not on the module proxy: `net/http` and `std` both 404, and
 * `github.com/golang/go` resolves to an archive with ZERO entries under `src/`,
 * because a nested `go.mod` excludes the whole tree.
 *
 * It does ship inside the `golang.org/toolchain` module, which is 83 MB of
 * mostly prebuilt binaries. Downloading that to read one package would be
 * absurd, so this reads the archive's central directory over HTTP Range and then
 * pulls only the entries it wants — 2.2 MB for `net/http`, against 83 MB for the
 * archive. `src/` is identical across GOOS and GOARCH, so the platform is
 * pinned rather than detected.
 *
 * A local toolchain, where there is one, costs nothing at all and matches the
 * version the project actually builds with, so it is tried first.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {readRemoteZip, readRemoteEntries, type ZipEntry, type RangeFetch} from '../shared/zip.js'
import {isGoFile} from './eco-go.js'

const TOOLCHAIN = 'https://proxy.golang.org/golang.org/toolchain/@v'

/** `src/` is byte-identical across platforms, so one is as good as another. */
const PLATFORM = 'linux-amd64'

const USER_AGENT = 'pi-task (github.com/mjasnikovs/pi-task)'

/** Where a sliced stdlib is filed, alongside the extracted modules. */
export function stdlibDirName(goVersion: string): string {
    return `std@${goVersion}`
}

export interface StdlibLocation {
    dir: string
    version: string
}

/**
 * A local Go installation's copy of the package, if there is one.
 *
 * Free, and exactly the version the project builds against. `GOROOT` is read
 * from the environment rather than from `go env`, so this stays synchronous and
 * usable from `resolve`; discovering an unset `GOROOT` needs a spawn and belongs
 * in the acquire path.
 */
export function findInGoroot(
    importPath: string,
    goroot: string | undefined
): StdlibLocation | null {
    const root = goroot?.trim()
    if (!root) return null
    const dir = path.join(root, 'src', ...importPath.split('/'))
    if (!fs.existsSync(dir)) return null
    const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').split('\n')[0].trim()
    return {dir, version: version || 'unknown'}
}

/** A stdlib package this tool sliced out of a toolchain archive earlier. */
export function findSliced(importPath: string, roots: readonly string[]): StdlibLocation | null {
    for (const root of roots) {
        let entries: string[]
        try {
            entries = fs.readdirSync(root).filter(e => e.startsWith('std@'))
        } catch {
            continue
        }
        for (const entry of entries.sort().reverse()) {
            const dir = path.join(root, entry, ...importPath.split('/'))
            if (fs.existsSync(dir)) return {dir, version: entry.slice('std@'.length)}
        }
    }
    return null
}

interface ToolchainVersion {
    /** The module version, e.g. `v0.0.1-go1.24.12.linux-amd64`. */
    moduleVersion: string
    /** The Go release it carries, e.g. `go1.24.12`. */
    goVersion: string
}

function parseToolchainList(body: string): ToolchainVersion[] {
    const out: ToolchainVersion[] = []
    for (const line of body.split('\n')) {
        const match = new RegExp(`^(v[\\d.]+-(go[\\d.]+)\\.${PLATFORM})$`).exec(line.trim())
        if (match) out.push({moduleVersion: match[1], goVersion: match[2]})
    }
    return out.sort((a, b) => compareGoVersions(a.goVersion, b.goVersion))
}

/** Numeric ordering, because `go1.9` sorts above `go1.24` as a string. */
function compareGoVersions(a: string, b: string): number {
    const parts = (v: string): number[] => v.replace(/^go/, '').split('.').map(Number)
    const [x, y] = [parts(a), parts(b)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const diff = (x[i] ?? 0) - (y[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

/**
 * Which toolchain to read, given what the project's `go` directive asks for.
 *
 * The newest patch of the project's own minor version, so the answer describes
 * the API the project compiles against. With no directive, or a version older
 * than any release still published, the newest available stands in.
 */
export function chooseToolchain(
    available: readonly ToolchainVersion[],
    goDirective: string | null
): ToolchainVersion | null {
    if (available.length === 0) return null
    const wanted = goDirective?.trim().replace(/^go/, '')
    if (wanted) {
        const minor = wanted.split('.').slice(0, 2).join('.')
        const matching = available.filter(v =>
            v.goVersion.replace(/^go/, '').startsWith(`${minor}.`)
        )
        if (matching.length > 0) return matching[matching.length - 1]
    }
    return available[available.length - 1]
}

export async function listToolchains(
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<ToolchainVersion[]> {
    const response = await fetchFn(`${TOOLCHAIN}/list`, {
        headers: {'user-agent': USER_AGENT},
        ...(signal ? {signal} : {})
    })
    if (!response.ok) return []
    return parseToolchainList(await response.text())
}

function toolchainUrl(moduleVersion: string): string {
    return `${TOOLCHAIN}/${moduleVersion}.zip`
}

/**
 * The archive's entry list, cached on disk.
 *
 * Reading it costs 1.6 MB, and every research child that asks about a second
 * stdlib package would pay it again — the list is the same bytes for a given
 * toolchain, so it is written once beside the source it describes.
 */
async function toolchainEntries(
    moduleVersion: string,
    cacheFile: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<ZipEntry[]> {
    const cached = readCachedEntries(cacheFile)
    if (cached) return cached

    const url = toolchainUrl(moduleVersion)
    const head = await fetchFn(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: {'user-agent': USER_AGENT},
        ...(signal ? {signal} : {})
    })
    const size = Number(head.headers.get('content-length'))
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`toolchain ${moduleVersion}: no content length to range over`)
    }
    const entries = await readRemoteZip(size, rangeFetch(url, fetchFn, signal))
    // Only `src` is ever read, and dropping the rest takes the cache from
    // 10,751 entries to a fraction of that.
    const wanted = entries.filter(e => /\/src\//.test(e.name) && isGoFile(e.name))
    fs.mkdirSync(path.dirname(cacheFile), {recursive: true})
    fs.writeFileSync(cacheFile, JSON.stringify({size, entries: wanted}))
    return wanted
}

function readCachedEntries(cacheFile: string): ZipEntry[] | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as {entries?: ZipEntry[]}
        return Array.isArray(parsed.entries) && parsed.entries.length > 0 ? parsed.entries : null
    } catch {
        return null
    }
}

function rangeFetch(url: string, fetchFn: typeof fetch, signal?: AbortSignal): RangeFetch {
    return async (start, end) => {
        const response = await fetchFn(url, {
            headers: {'user-agent': USER_AGENT, range: `bytes=${start}-${end}`},
            redirect: 'follow',
            ...(signal ? {signal} : {})
        })
        if (!response.ok) throw new Error(`range ${start}-${end}: HTTP ${response.status}`)
        return Buffer.from(await response.arrayBuffer())
    }
}

export interface AcquireStdlibInput {
    importPath: string
    /** The project's `go` directive, so the answer matches what it builds with. */
    goDirective: string | null
    /** Where the sliced package tree is written. */
    installDir: string
    fetchFn: typeof fetch
    signal?: AbortSignal | undefined
}

/**
 * Slice one standard-library package out of a toolchain archive.
 *
 * Subdirectories come too — `net/http/httptest` and `net/http/httputil` are what
 * a question about `net/http` half the time turns out to be about, and they are
 * adjacent in the archive, so they cost almost nothing on top.
 */
export async function acquireStdlibPackage(
    input: AcquireStdlibInput
): Promise<{success: boolean; installDir: string; stderr: string}> {
    const {importPath, installDir, fetchFn, signal} = input
    try {
        const chosen = chooseToolchain(await listToolchains(fetchFn, signal), input.goDirective)
        if (!chosen) {
            return {success: false, installDir, stderr: 'No Go toolchain is published to slice.'}
        }
        const dest = path.join(installDir, stdlibDirName(chosen.goVersion))
        const entries = await toolchainEntries(
            chosen.moduleVersion,
            path.join(installDir, `.${chosen.moduleVersion}.entries.json`),
            fetchFn,
            signal
        )
        const prefix = `/src/${importPath}/`
        const wanted = entries.filter(e => e.name.includes(prefix))
        if (wanted.length === 0) {
            return {
                success: false,
                installDir,
                stderr: `"${importPath}" is not a package in ${chosen.goVersion}.`
            }
        }
        const bytes = await readRemoteEntries(
            wanted,
            rangeFetch(toolchainUrl(chosen.moduleVersion), fetchFn, signal)
        )
        for (const [name, content] of bytes) {
            const rel = name.slice(name.indexOf('/src/') + '/src/'.length)
            const target = path.join(dest, ...rel.split('/'))
            fs.mkdirSync(path.dirname(target), {recursive: true})
            fs.writeFileSync(target, content)
        }
        return {success: true, installDir, stderr: ''}
    } catch (err) {
        return {
            success: false,
            installDir,
            stderr: err instanceof Error ? err.message : String(err)
        }
    }
}
