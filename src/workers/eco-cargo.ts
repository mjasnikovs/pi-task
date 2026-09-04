/**
 * eco-cargo — reading Rust crates for the docs Worker tool.
 *
 * Rust ships no declarations file, so the documented surface has to be cut out
 * of `.rs` source: doc comments, attributes and public item heads kept, function
 * bodies and private items dropped. That is what `surface` below does, and it is
 * why this row needs code where the npm row needed none.
 *
 * Nothing here parses TOML. `Cargo.lock` is a generated file with a fixed
 * `[[package]]` shape, and a line reader over it costs one small function where
 * a TOML dependency would cost a dependency.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {ResolveError, type ResolvedPackage} from './docs-resolve.js'
import type {NpmVersionInfo} from './npm-version.js'

/** crates.io rejects a request with no User-Agent naming the caller. */
const CRATES_UA = 'pi-task (github.com/mjasnikovs/pi-task)'
const CRATES_API = 'https://crates.io/api/v1/crates'
const CRATES_DL = 'https://static.crates.io/crates'

/** A crate name is written with either separator and means the same crate. */
function canonical(name: string): string {
    return name.replace(/-/g, '_')
}

export function isValidCrateName(name: string): boolean {
    return /^[A-Za-z0-9_-]+(?:::[A-Za-z0-9_:]+)?$/.test(name)
}

/** `serde_json::Value` is a path into `serde_json`; the crate is what installs. */
export function crateOf(name: string): string {
    return name.split('::')[0]
}

/** Compare two `major.minor.patch[-pre]` strings numerically, newest last. */
function compareVersions(a: string, b: string): number {
    const parts = (v: string): number[] =>
        v
            .split('-')[0]
            .split('.')
            .map(n => Number(n) || 0)
    const [pa, pb] = [parts(a), parts(b)]
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0)
        if (d !== 0) return d
    }
    return 0
}

/** Every version of `name` recorded in a `Cargo.lock`, oldest first. */
export function lockVersions(lockText: string, name: string): string[] {
    const want = canonical(name)
    const found: string[] = []
    let current: string | null = null
    for (const raw of lockText.split('\n')) {
        const line = raw.trim()
        if (line === '[[package]]') {
            current = null
            continue
        }
        const nameMatch = /^name\s*=\s*"([^"]+)"$/.exec(line)
        if (nameMatch) {
            current = canonical(nameMatch[1]) === want ? want : null
            continue
        }
        const versionMatch = /^version\s*=\s*"([^"]+)"$/.exec(line)
        if (versionMatch && current) found.push(versionMatch[1])
    }
    return found.sort(compareVersions)
}

/** Directories that never hold a project's own manifest. */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', 'build'])

/** Anything that marks `cwd` as the root of a project rather than a scratch directory. */
const ROOT_MARKERS = ['.git', 'package.json', 'Cargo.toml', 'cabal.project']

/**
 * Immediate child directories of `cwd`, for the one-level-down manifest scan —
 * and EMPTY unless `cwd` is itself a project root.
 *
 * Without that guard the scan reaches into any directory that merely happens to
 * contain projects. `/tmp` is the case that bites: a single unrelated checkout
 * under it would make every lookup run from `/tmp` believe it was in that
 * ecosystem.
 */
export function childDirs(cwd: string): string[] {
    if (!ROOT_MARKERS.some(m => fs.existsSync(path.join(cwd, m)))) return []
    try {
        return fs
            .readdirSync(cwd, {withFileTypes: true})
            .filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
            .map(e => path.join(cwd, e.name))
    } catch {
        return []
    }
}

/**
 * The `Cargo.lock` governing `cwd`: cargo's own upward walk first, then ONE level
 * down. The step down is the Tauri shape — `package.json` at the repo root and
 * the crate under `src-tauri/` — where the upward walk from the root finds
 * nothing at all.
 */
export function findLock(cwd: string): string | null {
    let dir = cwd
    while (true) {
        const candidate = path.join(dir, 'Cargo.lock')
        if (fs.existsSync(candidate)) return candidate
        const up = path.dirname(dir)
        if (up === dir) break
        dir = up
    }
    for (const child of childDirs(cwd)) {
        const candidate = path.join(child, 'Cargo.lock')
        if (fs.existsSync(candidate)) return candidate
    }
    return null
}

/**
 * The version the project pins `name` to. Several is not an error — a workspace
 * legitimately holds two majors of one crate — and the NEWEST is taken, which
 * the answer then states in its `Per <name>@<version>:` header.
 */
export function lockedVersion(name: string, cwd: string): string | null {
    const lock = findLock(cwd)
    if (!lock) return null
    let text: string
    try {
        text = fs.readFileSync(lock, 'utf8')
    } catch {
        return null
    }
    const versions = lockVersions(text, crateOf(name))
    return versions.length ? versions[versions.length - 1] : null
}

/**
 * Every crate the lock pins, name to version. Cargo has already resolved these,
 * so unlike an npm range these are exact — and a `cargo update` that moves one
 * is what a cached answer about it has to be dropped on.
 */
export function lockedDeps(cwd: string): Record<string, string> | undefined {
    const lock = findLock(cwd)
    if (!lock) return undefined
    let text: string
    try {
        text = fs.readFileSync(lock, 'utf8')
    } catch {
        return undefined
    }
    const out: Record<string, string> = {}
    let name: string | null = null
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line === '[[package]]') {
            name = null
            continue
        }
        const nameMatch = /^name\s*=\s*"([^"]+)"$/.exec(line)
        if (nameMatch) {
            name = nameMatch[1]
            continue
        }
        const versionMatch = /^version\s*=\s*"([^"]+)"$/.exec(line)
        if (versionMatch && name) {
            const existing = out[name]
            if (!existing || compareVersions(versionMatch[1], existing) > 0) {
                out[name] = versionMatch[1]
            }
        }
    }
    return out
}

/** Every `<name>-<version>` directory under a cargo registry checkout root. */
function registryRoots(cargoHome: string): string[] {
    const base = path.join(cargoHome, 'registry', 'src')
    try {
        return fs
            .readdirSync(base, {withFileTypes: true})
            .filter(e => e.isDirectory())
            .map(e => path.join(base, e.name))
    } catch {
        return []
    }
}

/**
 * A checkout directory is `<name>-<version>`, and the name half may be written
 * with either separator — so the split is at the LAST dash and only the name
 * half is canonicalised. Canonicalising the whole string turns
 * `tiny-crate-0.1.0` into `tiny_crate_0.1.0` and matches nothing.
 */
function findSourceDir(
    roots: string[],
    crate: string,
    version?: string
): {dir: string; name: string; version: string} | null {
    const want = canonical(crate)
    let best: {dir: string; name: string; version: string} | null = null
    for (const root of roots) {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(root, {withFileTypes: true})
        } catch {
            continue
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const cut = entry.name.lastIndexOf('-')
            if (cut < 0) continue
            if (canonical(entry.name.slice(0, cut)) !== want) continue
            const found = entry.name.slice(cut + 1)
            if (!/^\d/.test(found)) continue
            if (version !== undefined && found !== version) continue
            if (!best || compareVersions(found, best.version) > 0) {
                best = {
                    dir: path.join(root, entry.name),
                    // The DIRECTORY spells the registry's own name. Reporting the
                    // caller's spelling instead would give `tiny_crate` and
                    // `tiny-crate` two cache rows for one crate.
                    name: entry.name.slice(0, cut),
                    version: found
                }
            }
        }
    }
    return best
}

function readmeIn(root: string): string | null {
    for (const name of ['README.md', 'readme.md', 'README.markdown']) {
        const abs = path.join(root, name)
        if (fs.existsSync(abs)) return abs
    }
    const declared = /^readme\s*=\s*"([^"]+)"$/m.exec(safeRead(path.join(root, 'Cargo.toml')) ?? '')
    if (declared) {
        const abs = path.join(root, declared[1])
        if (fs.existsSync(abs)) return abs
    }
    return null
}

function safeRead(file: string): string | null {
    try {
        return fs.readFileSync(file, 'utf8')
    } catch {
        return null
    }
}

/** `src/lib.rs` is the crate's public root; a binary-only crate has `src/main.rs`. */
function entryIn(root: string): string | null {
    for (const rel of ['src/lib.rs', 'src/main.rs']) {
        const abs = path.join(root, ...rel.split('/'))
        if (fs.existsSync(abs)) return abs
    }
    return null
}

export interface CargoResolveDirs {
    cargoHome: string
    /** Where a crate fetched by this tool was extracted. */
    modulesDir: string
}

/**
 * Find a crate's source on disk.
 *
 * The lock is consulted first, so a project reading `tokio` gets the `tokio` it
 * builds against rather than the newest copy the machine happens to hold. With
 * no lock in sight — which is where the post-fetch re-resolve arrives, since it
 * is handed the download directory — the newest extracted copy wins.
 */
export function resolveCrate(name: string, cwd: string, dirs: CargoResolveDirs): ResolvedPackage {
    if (!isValidCrateName(name)) {
        throw new ResolveError('invalid_name', `Invalid crate name: "${name}"`)
    }
    const crate = crateOf(name)
    const pinned = lockedVersion(crate, cwd)
    const fetched = path.join(dirs.modulesDir, 'cargo')
    const roots = [...registryRoots(dirs.cargoHome), fetched]

    const found =
        (pinned ? findSourceDir(roots, crate, pinned) : null) ?? findSourceDir(roots, crate)
    if (!found) {
        throw new ResolveError(
            'not_installed',
            `Crate "${crate}" has no source checkout under ${dirs.cargoHome} or ${fetched}. `
                + 'Run `cargo fetch` in the project and retry.'
        )
    }
    return {
        ecosystem: 'cargo',
        name: found.name,
        version: found.version,
        root: found.dir,
        entry: entryIn(found.dir),
        readme: readmeIn(found.dir)
    }
}

interface CratesApiResponse {
    crate?: {max_stable_version?: unknown; newest_version?: unknown}
    versions?: Array<{num?: unknown; created_at?: unknown}>
}

/** The newest published version of a crate, or null on any failure. */
export async function cratesLatest(
    name: string,
    fetchFn: typeof fetch,
    signal?: AbortSignal
): Promise<NpmVersionInfo | null> {
    const crate = crateOf(name)
    try {
        const response = await fetchFn(`${CRATES_API}/${encodeURIComponent(crate)}`, {
            headers: {'user-agent': CRATES_UA, accept: 'application/json'},
            ...(signal ? {signal} : {})
        })
        if (!response.ok) return null
        const body = (await response.json()) as CratesApiResponse
        const latest = body.crate?.max_stable_version ?? body.crate?.newest_version
        if (typeof latest !== 'string' || latest.length === 0) return null
        const versions = body.versions ?? []
        const recent = versions
            .map(v => v.num)
            .filter((n): n is string => typeof n === 'string')
            .slice(0, 10)
        const publishedAt = versions.find(v => v.num === latest)?.created_at
        return {
            pkg: crate,
            latest,
            recent,
            ...(typeof publishedAt === 'string' ? {publishedAt} : {})
        }
    } catch {
        return null
    }
}

export function crateTarballUrl(name: string, version: string): string {
    const crate = crateOf(name)
    return `${CRATES_DL}/${crate}/${crate}-${version}.crate`
}

// ── surface extraction ──────────────────────────────────────────────────────

/** Where a Rust declaration begins, so a chunk never splits a signature. */
export const CARGO_DECL_SPLIT_RE =
    /^\s*(?:#\[[^\n]*\]\s*)*(?:pub\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+)*(?:fn|struct|enum|union|trait|type|impl|mod|const|static)\b/m

const ITEM_HEAD_RE =
    /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+|async\s+|unsafe\s+|const\s+|extern\s+"[^"]*"\s+|extern\s+)*(fn|struct|enum|union|trait|impl|mod|type|const|static|use|macro_rules!)\b/

/** A `pub(crate)`/`pub(super)` item is not part of the crate's public surface. */
function isPublic(head: string): boolean {
    if (!/^pub\b/.test(head)) return false
    const restricted = /^pub\s*\(\s*(crate|super|self|in\s)/.exec(head)
    return restricted === null
}

interface Item {
    /** Doc comments and attributes immediately above the item. */
    pending: string
    /** The item text up to its `{` or `;`. */
    head: string
    /** The brace body, without the braces. Null for a `;`-terminated item. */
    body: string | null
}

/**
 * Split one nesting level of Rust source into items.
 *
 * Braces are counted with strings, chars, comments and lifetimes skipped: `"{"`
 * and `'{'` both appear in real source, and a scanner that counts them never
 * finds the end of the item it is in.
 */
export function splitRustItems(src: string): Item[] {
    const items: Item[] = []
    let i = 0
    let pendingStart = 0
    let itemStart = -1
    let depth = 0
    let headEnd = -1

    const flush = (end: number, bodyStart: number, bodyEnd: number): void => {
        // With no brace the item ended at its `;`, which is not part of the head.
        const head = src.slice(itemStart, headEnd < 0 ? end - 1 : headEnd).trim()
        if (head) {
            items.push({
                pending: src.slice(pendingStart, itemStart).trim(),
                head,
                body: bodyStart < 0 ? null : src.slice(bodyStart, bodyEnd)
            })
        }
        pendingStart = end
        itemStart = -1
        headEnd = -1
    }

    while (i < src.length) {
        const c = src[i]

        if (c === '/' && src[i + 1] === '/') {
            const end = src.indexOf('\n', i)
            i = end < 0 ? src.length : end + 1
            continue
        }
        if (c === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i + 2)
            i = end < 0 ? src.length : end + 2
            continue
        }
        if (c === '"') {
            i = skipString(src, i)
            continue
        }
        if (c === "'" && isCharLiteral(src, i)) {
            i = skipChar(src, i)
            continue
        }

        // An attribute belongs to the item BELOW it, so it stays in the pending
        // preamble rather than opening the item — otherwise the `[` starts the
        // head and the item stops looking like a declaration at all.
        if (depth === 0 && itemStart < 0 && c === '#') {
            i = skipAttribute(src, i)
            continue
        }
        if (depth === 0 && itemStart < 0 && !/\s/.test(c)) {
            itemStart = i
        }

        if (c === '{') {
            if (depth === 0 && itemStart >= 0 && headEnd < 0) headEnd = i
            depth++
            i++
            continue
        }
        if (c === '}') {
            depth--
            if (depth === 0 && itemStart >= 0) {
                flush(i + 1, headEnd + 1, i)
                i++
                continue
            }
            i++
            continue
        }
        if (c === ';' && depth === 0 && itemStart >= 0) {
            flush(i + 1, -1, -1)
            i++
            continue
        }
        i++
    }
    return items
}

/** Step over a whole `#[...]` / `#![...]` attribute, brackets balanced. */
function skipAttribute(src: string, i: number): number {
    let j = src[i + 1] === '!' ? i + 2 : i + 1
    if (src[j] !== '[') return i + 1
    let depth = 0
    while (j < src.length) {
        if (src[j] === '[') depth++
        else if (src[j] === ']') {
            depth--
            if (depth === 0) return j + 1
        } else if (src[j] === '"') {
            j = skipString(src, j) - 1
        }
        j++
    }
    return src.length
}

function skipString(src: string, i: number): number {
    let j = i + 1
    while (j < src.length) {
        if (src[j] === '\\') {
            j += 2
            continue
        }
        if (src[j] === '"') return j + 1
        j++
    }
    return src.length
}

/** `'a` is a lifetime; `'x'` and `'\n'` are char literals. */
function isCharLiteral(src: string, i: number): boolean {
    if (src[i + 1] === '\\') return true
    return src[i + 2] === "'"
}

function skipChar(src: string, i: number): number {
    let j = i + 1
    while (j < src.length) {
        if (src[j] === '\\') {
            j += 2
            continue
        }
        if (src[j] === "'") return j + 1
        j++
    }
    return src.length
}

/** Only `//!`, `///` and attributes survive as an item's preamble. */
function keptPreamble(pending: string): string {
    return pending
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('///') || l.startsWith('//!') || l.startsWith('#['))
        .join('\n')
}

const BODY_KINDS = new Set(['struct', 'enum', 'union', 'trait', 'impl', 'mod', 'extern'])

/**
 * Reduce Rust source to its public API surface.
 *
 * Function bodies go — they are the bulk of the file and answer no question the
 * docs tool is asked. Everything a caller can name stays: the item head, its doc
 * comment, its attributes, and for a struct or enum its fields and variants.
 *
 * Inside a `trait` every member is public by definition, so the `pub` test is
 * suspended there; anywhere else a bare or `pub(crate)` item is dropped.
 */
export function rustSurface(src: string, insideTrait = false): string {
    const out: string[] = []
    // `//!` documents the module, not the item under it, so it survives whether or
    // not the first item does.
    const moduleDoc = src
        .split('\n')
        .filter(l => l.trim().startsWith('//!'))
        .map(l => l.trim())
        .join('\n')
    if (!insideTrait && moduleDoc) out.push(moduleDoc)
    for (const item of splitRustItems(src)) {
        const headMatch = ITEM_HEAD_RE.exec(item.head)
        if (!headMatch) continue
        const kind = headMatch[1]
        if (kind === 'macro_rules!') continue
        const keep = insideTrait || kind === 'impl' || isPublic(item.head)
        if (!keep) continue

        const preamble = keptPreamble(item.pending)
        const head = item.head.replace(/\s+/g, ' ').trim()
        const lead = preamble ? `${preamble}\n` : ''

        if (item.body === null || kind === 'fn') {
            out.push(`${lead}${head};`)
            continue
        }
        if (BODY_KINDS.has(kind)) {
            // Every method of a trait, and of an impl OF a trait, is public by
            // definition — the `pub` keyword is not written there.
            const membersArePublic = kind === 'trait' || / for /.test(item.head)
            const inner =
                kind === 'struct' || kind === 'union' ? fieldsOf(item.body, true)
                : kind === 'enum' ? fieldsOf(item.body, false)
                : rustSurface(item.body, membersArePublic)
            out.push(inner ? `${lead}${head} {\n${indent(inner)}\n}` : `${lead}${head} {}`)
            continue
        }
        out.push(`${lead}${head};`)
    }
    return out.join('\n\n')
}

/**
 * A struct's fields or an enum's variants. A struct field is public only when it
 * says `pub`; an enum variant carries no such keyword and is always public.
 */
function fieldsOf(body: string, requirePub: boolean): string {
    return body
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('//') && !l.startsWith('#['))
        .filter(l => !requirePub || /^pub\b/.test(l))
        .join('\n')
        .trim()
}

function indent(s: string): string {
    return s
        .split('\n')
        .map(l => (l.length ? `    ${l}` : l))
        .join('\n')
}

export function isRustFile(name: string): boolean {
    return name.endsWith('.rs')
}

/** The `[package] name` of a cargo project, for labelling its own source. */
export function cargoProjectName(cwd: string): string | null {
    const text = safeRead(path.join(cwd, 'Cargo.toml'))
    if (!text) return null
    const section = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(text)
    const match = /^\s*name\s*=\s*"([^"]+)"/m.exec(section?.[1] ?? '')
    return match ? match[1] : null
}
