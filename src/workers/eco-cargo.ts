/**
 * eco-cargo — reading Rust crates for the docs Worker tool.
 *
 * Rust ships no declarations file, so the documented surface has to be cut out
 * of `.rs` source: doc comments, attributes and public item heads kept, function
 * bodies and private items dropped. That is what `surface` below does, and it is
 * why this row needs code where the npm row needed none.
 *
 * No TOML parser. `Cargo.lock` is generated with a fixed `[[package]]` shape, and
 * `Cargo.toml`'s dependency tables are read for their KEYS only, so a line reader
 * covers both where a TOML dependency would cost a dependency.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {ResolveError, type ResolvedPackage} from './docs-resolve.js'
import type {NpmVersionInfo} from './npm-version.js'
import type {ExportGap} from './export-gap.js'

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

/** Compare two `major.minor.patch[-pre][+build]` strings numerically, newest last. */
function compareVersions(a: string, b: string): number {
    const parts = (v: string): number[] =>
        v
            .split(/[-+]/)[0]
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
    return findAtOrAbove(cwd, 'Cargo.lock')
}

/**
 * The first `<dir>/<name>` at or above `cwd`, checking each ancestor's immediate
 * children too.
 *
 * The sideways step is the Tauri shape: `package.json` at the repo root and the
 * crate under `src-tauri/`. Checking children of `cwd` alone is not enough —
 * from the frontend directory `src/`, the crate is in a SIBLING, so the scan has
 * to happen at every level on the way up or the whole project reads as npm-only.
 */
export function findAtOrAbove(cwd: string, ...rel: string[]): string | null {
    let dir = cwd
    while (true) {
        const here = path.join(dir, ...rel)
        if (fs.existsSync(here)) return here
        for (const child of childDirs(dir)) {
            const candidate = path.join(child, ...rel)
            if (fs.existsSync(candidate)) return candidate
        }
        const up = path.dirname(dir)
        if (up === dir) return null
        dir = up
    }
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
            // Under BOTH spellings. `lockedVersion` canonicalises `-`/`_` before
            // matching, so a map keyed only on the lockfile's literal name gives a
            // different answer to the same question for `tokio-util` vs
            // `tokio_util` — and the freshness check silently keeps the entry.
            for (const key of new Set([name, canonical(name)])) {
                const existing = out[key]
                if (!existing || compareVersions(versionMatch[1], existing) > 0) {
                    out[key] = versionMatch[1]
                }
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
 * `<name>-<version>`, split at the first dash a full `x.y.z` follows.
 *
 * Neither greediness alone works. Splitting at the LAST dash cuts a prerelease in
 * half (`clap-4.0.0-rc.1` → version `rc.1`); splitting at the first dash ANY digit
 * follows cuts the name in half (`md-5-0.10.6` → name `md`), and md-5, sha-1 and
 * utf-8 are all real crates. Requiring three numeric components is what tells the
 * two apart, and it keeps `toml-0.9.12+spec-1.1.0` whole as build metadata.
 */
const CHECKOUT_DIR_RE = /^(.*?)-(\d+\.\d+\.\d+(?:[-+][^\s]*)?)$/

/**
 * Find a crate's checkout directory. Only the NAME half is canonicalised — a
 * crate is written with either separator, but `canonical()` over the whole
 * string turns `tiny-crate-0.1.0` into `tiny_crate_0.1.0` and matches nothing.
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
            const parts = CHECKOUT_DIR_RE.exec(entry.name)
            if (!parts) continue
            if (canonical(parts[1]) !== want) continue
            const found = parts[2]
            if (version !== undefined && found !== version) continue
            if (!best || compareVersions(found, best.version) > 0) {
                best = {
                    dir: path.join(root, entry.name),
                    // The DIRECTORY spells the registry's own name. Reporting the
                    // caller's spelling instead would give `tiny_crate` and
                    // `tiny-crate` two cache rows for one crate.
                    name: parts[1],
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

    // A pin that is not on disk is not_installed, NOT an invitation to answer from
    // whatever copy another checkout left behind. Nothing marks that substitution,
    // so the version banner stays empty and the swap reaches the model silently.
    const found = pinned ? findSourceDir(roots, crate, pinned) : findSourceDir(roots, crate)
    if (!found) {
        throw new ResolveError(
            'not_installed',
            `Crate "${crate}" has no ${pinned ? `v${pinned} ` : ''}source checkout under `
                + `${dirs.cargoHome} or ${fetched}. Run \`cargo fetch\` in the project and retry.`
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
    crate?: {
        name?: unknown
        id?: unknown
        max_stable_version?: unknown
        newest_version?: unknown
    }
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
        // The registry's OWN spelling. crates.io's API normalises `-` and `_`, but
        // static.crates.io does not — it answers 403 for the path that does not
        // match what was published, and `use tokio_util::…` is how Rust source
        // spells `tokio-util`.
        const registryName = body.crate?.name ?? body.crate?.id
        const versions = body.versions ?? []
        const recent = versions
            .map(v => v.num)
            .filter((n): n is string => typeof n === 'string')
            .slice(0, 10)
        const publishedAt = versions.find(v => v.num === latest)?.created_at
        return {
            pkg: typeof registryName === 'string' && registryName ? registryName : crate,
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

/**
 * Where a Rust declaration begins, so a chunk never splits a signature. Column 0
 * only: `rustSurface` INDENTS the members of an impl or a trait, so an `^\s*`
 * anchor cut every method into its own chunk — an orphan signature with no
 * receiver type, carrying the next method's doc comment.
 */
export const CARGO_DECL_SPLIT_RE =
    /^(?:#\[[^\n]*\]\s*)*(?:pub\s+)?(?:async\s+|unsafe\s+|const\s+|extern\s+)*(?:fn|struct|enum|union|trait|type|impl|mod|const|static)\b/m

// `macro_rules!` carries its own terminator, so it sits OUTSIDE the `\b` — a word
// boundary after `!` requires a word character next, and what follows is a space.
const ITEM_HEAD_RE =
    /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+|async\s+|unsafe\s+|const\s+|extern\s+"[^"]*"\s+|extern\s+)*((?:fn|struct|enum|union|trait|impl|mod|type|const|static|use)\b|macro_rules!)/

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
        // `r#"…"#` ends only at a quote followed by the same number of hashes, so
        // a `"` INSIDE one is ordinary text. Treating it as a delimiter re-opens
        // the scanner, desynchronises brace depth, and swallows the rest of the
        // file — Tauri's whole WebviewBuilder surface disappears that way.
        const raw = rawStringEnd(src, i)
        if (raw >= 0) {
            i = raw
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
        } else {
            const raw = rawStringEnd(src, j)
            if (raw >= 0) j = raw - 1
        }
        j++
    }
    return src.length
}

/**
 * End index of a raw or byte string starting at `i`, or -1 when one does not.
 * Handles `r"…"`, `r#"…"#`, `r##"…"##`, and the `b`-prefixed byte forms.
 */
function rawStringEnd(src: string, i: number): number {
    let j = i
    if (src[j] === 'b') j++
    if (src[j] !== 'r') return -1
    // A preceding identifier character means this is a name, not a prefix.
    if (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1])) return -1
    j++
    let hashes = 0
    while (src[j] === '#') {
        hashes++
        j++
    }
    if (src[j] !== '"') return -1
    const close = `"${'#'.repeat(hashes)}`
    const end = src.indexOf(close, j + 1)
    return end < 0 ? src.length : end + close.length
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

/**
 * Only `///` and attributes survive as an item's preamble. `//!` documents the
 * MODULE, and `rustSurface` emits those once at the top — keeping them here as
 * well printed every file's module doc twice, and three times inside a `mod`.
 */
function keptPreamble(pending: string): string {
    return pending
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('///') || l.startsWith('#['))
        .join('\n')
}

/**
 * This module's own `//!` docs: the ones outside every brace.
 *
 * Not a leading RUN — a crate root usually opens with `#![allow(…)]` blocks and
 * only then documents itself, and tokio's 19 KB of module docs sit below four of
 * them. Not the whole file either, or a nested `mod`'s docs are hoisted to the
 * crate root and printed again inside the module.
 */
function moduleDocOf(src: string): string {
    const kept: string[] = []
    let depth = 0
    for (const raw of src.split('\n')) {
        const line = raw.trim()
        if (depth === 0 && line.startsWith('//!')) {
            kept.push(line)
            continue
        }
        // Comment lines are skipped whole: a `//` line may hold an unbalanced
        // brace, and only real code should move the depth.
        if (line.startsWith('//')) continue
        for (const c of raw) {
            if (c === '{') depth++
            else if (c === '}') depth--
        }
    }
    return kept.join('\n')
}

/** The type an `impl` block is FOR: after `for` when present, else after `impl`. */
function implTarget(head: string): string | null {
    const after = / for\s+([^\s{<]+)/.exec(head) ?? /^impl(?:\s*<[^>]*>)?\s+([^\s{<]+)/.exec(head)
    if (!after) return null
    const parts = after[1].split('::')
    return parts[parts.length - 1] || null
}

/** Type names this block declares WITHOUT `pub`. An impl for one of them is not API. */
function privateTypeNames(items: Item[]): Set<string> {
    const out = new Set<string>()
    for (const item of items) {
        const m =
            /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:struct|enum|union|trait|type)\s+([A-Za-z_][\w]*)/.exec(
                item.head
            )
        if (m && !isPublic(item.head)) out.add(m[1])
    }
    return out
}

const BODY_KINDS = new Set(['struct', 'enum', 'union', 'trait', 'impl', 'mod', 'extern'])

/**
 * `use` braces hold a LIST, not a block. `splitRustItems` hands back the text
 * before the brace and the text inside it, so a re-export has to be put back
 * together — otherwise `pub use crate::runtime::{Runtime, Builder};` is emitted
 * as `pub use crate::runtime::;`, which names nothing and is not even Rust. A
 * third of the `pub use` lines across a real registry are braced, and in most
 * crates `pub use` in lib.rs IS the public API.
 */
const LIST_KINDS = new Set(['use'])

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
export function rustSurface(src: string, insideTrait = false, topLevel = true): string {
    const out: string[] = []
    const items = splitRustItems(src)
    const privateTypes = privateTypeNames(items)
    // `//!` documents the module, not the item under it, so it survives whether or
    // not the first item does — and only at the top, never again per nested block.
    // Only the `//!` lines before the first item belong to THIS module. Scanning
    // the whole text hoists a nested `mod`'s doc to the crate root and prints it
    // again inside the module.
    const moduleDoc = moduleDocOf(src)
    if (topLevel && moduleDoc) out.push(moduleDoc)
    for (const item of items) {
        const headMatch = ITEM_HEAD_RE.exec(item.head)
        if (!headMatch) continue
        const kind = headMatch[1]
        // A `#[macro_export]` macro IS the crate's API — `anyhow::bail!`,
        // `serde_json::json!`. Dropping every macro answered "no such thing"
        // for 714 exported macros across a third of the crates on this box.
        if (kind === 'macro_rules!') {
            if (!/#\[macro_export\]/.test(item.pending)) continue
            const preamble = keptPreamble(item.pending)
            out.push(
                `${preamble ? `${preamble}\n` : ''}${item.head.replace(/\s+/g, ' ').trim()} `
                    + '{ /* macro arms elided */ }'
            )
            continue
        }
        // An `impl` on a type this module keeps private is not reachable from
        // outside it, so publishing its constructor invites a call that cannot
        // compile.
        const target = kind === 'impl' ? implTarget(item.head) : null
        if (kind === 'impl' && target && privateTypes.has(target)) continue
        const keep = insideTrait || kind === 'impl' || isPublic(item.head)
        if (!keep) continue

        const preamble = keptPreamble(item.pending)
        const head = item.head.replace(/\s+/g, ' ').trim()
        const lead = preamble ? `${preamble}\n` : ''

        if (item.body !== null && LIST_KINDS.has(kind)) {
            out.push(`${lead}${head}{${item.body.replace(/\s+/g, ' ').trim()}};`)
            continue
        }
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
 * A struct's fields or an enum's variants.
 *
 * Split on top-level COMMAS across the whole body, not line by line. A field
 * whose type wraps (`pub map: HashMap<\n String,\n u8,\n>`) or a struct variant
 * (`A { x: u8 }`) spans several lines, and a per-line splitter cuts it at the
 * newline and emits `pub map: HashMap<` — a type that does not exist.
 *
 * A struct field is public only when `isPublic` says so, which rejects
 * `pub(crate)`; an enum variant carries no keyword and is always public.
 */
function fieldsOf(body: string, requirePub: boolean): string {
    const out: string[] = []
    let doc: string[] = []
    for (const field of splitFields(body)) {
        if (field.doc.length && (!requirePub || isPublic(field.text))) doc = field.doc
        else if (field.doc.length) doc = []
        if (requirePub && !isPublic(field.text)) {
            doc = []
            continue
        }
        out.push(...doc, `${field.text},`)
        doc = []
    }
    return out.join('\n').trim()
}

interface Field {
    /** `///` lines immediately above this field. */
    doc: string[]
    /** The field or variant, whitespace collapsed. */
    text: string
}

const OPENERS: Record<string, string> = {'<': '>', '(': ')', '[': ']', '{': '}'}

/**
 * Cut a field or variant list at its top-level commas.
 *
 * Depth is tracked over `<>()[]{}` so `HashMap<String, u8>` stays one field, and
 * `->` is skipped because a return arrow is not a closing generic — counting it
 * drives the depth negative and the rest of the list stops splitting.
 */
function splitFields(body: string): Field[] {
    const out: Field[] = []
    let doc: string[] = []
    let buf = ''
    let depth = 0

    const flush = (): void => {
        const text = buf.replace(/\s+/g, ' ').trim()
        buf = ''
        if (!text) {
            doc = []
            return
        }
        out.push({doc, text})
        doc = []
    }

    for (const raw of body.split('\n')) {
        const line = raw.trim()
        if (depth === 0 && buf.trim() === '') {
            if (line.startsWith('///')) {
                doc.push(line)
                continue
            }
            if (line.startsWith('//') || line.startsWith('#[')) continue
        }
        for (let i = 0; i < line.length; i++) {
            const c = line[i]
            if (OPENERS[c]) depth++
            else if (c === '>' && line[i - 1] !== '-') depth--
            else if (c === ')' || c === ']' || c === '}') depth--
            else if (c === ',' && depth === 0) {
                flush()
                continue
            }
            buf += c
        }
        buf += '\n'
    }
    flush()
    return out
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

/**
 * The crate names `Cargo.toml` itself declares, under both `-` and `_` spellings.
 *
 * NOT {@link lockedDeps}: a lock file is the whole transitive closure, so it
 * answers "can this resolve" and not "may this crate `use` it". The live run of
 * 2026-09-05 answered about `tower` — in the lock via axum, absent from
 * `[dependencies]` — and the crate did not compile.
 *
 * Undefined when there is no readable manifest, which is not "declares nothing".
 */
export function manifestCrates(cwd: string): Set<string> | undefined {
    const text = safeRead(path.join(cwd, 'Cargo.toml'))
    if (text === null) return undefined
    const out = new Set<string>()
    const add = (name: string): void => {
        for (const key of new Set([name, canonical(name)])) out.add(key)
    }
    let inDeps = false
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        const header = /^\[([^\]]+)\]$/.exec(line)
        if (header) {
            const section = header[1]
            // `[dependencies.serde]` and `[target.'cfg(unix)'.dependencies]` both
            // declare, and the first names its crate in the header itself.
            const table = /^(?:target\.[^.]*\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/.exec(
                section
            )
            inDeps = table !== null && table[1] === undefined
            if (table?.[1]) add(table[1])
            continue
        }
        if (!inDeps) continue
        const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)
        if (key) add(key[1])
    }
    return out
}

// ── the facade gap (DEFECT-12-STOPPING-RULE.md, cargo half) ─────────────────

/** A `pub use …;` statement, attributes and line breaks included. */
const PUB_USE_RE = /\bpub\s+use\s+([^;]+);/g
/** Every item head that introduces a name, visibility ignored — a facade may
 *  re-export something its own private module declares. */
const RUST_DECL_RE =
    /\b(?:fn|struct|enum|union|trait|type|const|static|mod)\s+([A-Za-z_][A-Za-z0-9_]*)|macro_rules!\s*([A-Za-z_][A-Za-z0-9_]*)/g
/** Path roots that name this crate, never a dependency. */
const OWN_PATH_ROOTS = new Set(['crate', 'self', 'super'])

/** Read `[dependencies]` only. Dev- and build-dependencies were measured and
 *  fetch `tokio-test`, `regex-test` and `tower-test` for zero extra names. */
function runtimeDeps(root: string): Set<string> {
    const text = safeRead(path.join(root, 'Cargo.toml'))
    const out = new Set<string>()
    if (text === null) return out
    let inDeps = false
    for (const raw of text.split('\n')) {
        const line = raw.trim()
        const header = /^\[([^\]]+)\]$/.exec(line)
        if (header) {
            const table = /^(?:target\.[^.]*\.)?dependencies(?:\.(.+))?$/.exec(header[1])
            inDeps = table !== null && table[1] === undefined
            if (table?.[1]) out.add(canonical(table[1]))
            continue
        }
        if (!inDeps) continue
        const key = /^([A-Za-z0-9_-]+)\s*=/.exec(line)
        if (key) out.add(canonical(key[1]))
    }
    return out
}

/** Every leaf name a use-path brings in, and every module it globs. */
function useTargets(body: string): {names: string[]; globs: string[]} {
    // Whitespace is normalised, never removed: `Inner as Outer` collapsed to
    // `InnerasOuter` is unrecoverable, and splitting a leaf on a bare "as" turns
    // `Hasher` into `H`.
    const flat = body
        .replace(/#\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    const names: string[] = []
    const globs: string[] = []
    const expand = (prefix: string, rest: string): void => {
        const brace = rest.indexOf('{')
        if (brace === -1) {
            const full = prefix + rest
            if (full.endsWith('*')) globs.push(full.replace(/::\*$/, ''))
            else {
                // The SOURCE name of a rename is the hole: the supplier declares
                // `Inner`, whatever the facade calls it.
                const leaf = full
                    .split('::')
                    .pop()
                    ?.split(/\s+as\s+/)[0]
                    .trim()
                if (leaf) names.push(leaf)
            }
            return
        }
        const head = prefix + rest.slice(0, brace)
        let depth = 0
        let start = brace + 1
        for (let i = brace; i < rest.length; i++) {
            const c = rest[i]
            if (c === '{') depth++
            else if (c === '}') {
                depth--
                if (depth === 0) return expand(head, rest.slice(start, i))
            } else if (c === ',' && depth === 1) {
                expand(head, rest.slice(start, i))
                start = i + 1
            }
        }
    }
    expand('', flat)
    return {names, globs}
}

function rustSources(root: string): string[] {
    const out: string[] = []
    const walk = (dir: string): void => {
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (!CARGO_SKIP_DIRS.includes(e.name)) walk(path.join(dir, e.name))
            } else if (isRustFile(e.name)) out.push(path.join(dir, e.name))
        }
    }
    walk(root)
    return out
}
const CARGO_SKIP_DIRS = ['tests', 'benches', 'examples', 'target', '.git']

/** `axum-core-0.5.6/src/response/mod.rs` -> `response`, the module path a
 *  `pub use axum_core::response::*` names. `lib.rs` and `mod.rs` are the module
 *  they sit in, not a module of their own. */
function moduleOfPath(relPath: string): string {
    const parts = relPath.replace(/\\/g, '/').split('/')
    const src = parts.indexOf('src')
    const tail = (src === -1 ? parts : parts.slice(src + 1)).join('/').replace(/\.rs$/, '')
    return tail
        .split('/')
        .filter(seg => seg !== 'mod' && seg !== 'lib')
        .join('::')
}

/**
 * The names this crate publishes through a dependency and declares nowhere.
 *
 * The trigger is the hole, with no threshold — measured, and for the same reason
 * as hackage: across twenty-two crates the unresolved fraction reads 100% on a
 * crate with one re-export and 0% on a crate with none, so a ratio separates
 * nothing. See "Defect 16" in DOC_REGRESSINONS.md for the sweep.
 */
export function cargoExportGap(root: string): ExportGap {
    const deps = runtimeDeps(root)
    const declared = new Set<string>()
    const reexported = new Set<string>()
    const globModules = new Set<string>()
    for (const file of rustSources(root)) {
        const src = safeRead(file)
        if (src === null) continue
        for (const m of src.matchAll(RUST_DECL_RE)) declared.add((m[1] ?? m[2]) as string)
        for (const m of src.matchAll(PUB_USE_RE)) {
            const rootSeg = m[1]
                .replace(/#\[[^\]]*\]/g, '')
                .trim()
                .split(/::|\{/)[0]
                .trim()
            if (rootSeg === '' || OWN_PATH_ROOTS.has(rootSeg) || !deps.has(canonical(rootSeg)))
                continue
            const {names, globs} = useTargets(m[1])
            for (const n of names) if (/^[A-Za-z_]/.test(n)) reexported.add(n)
            // Drop the leading crate segment: the supplier's own paths start below it.
            for (const g of globs) globModules.add(g.split('::').slice(1).join('::'))
        }
    }
    const unresolved = new Set([...reexported].filter(n => !declared.has(n)))
    return {
        empty: unresolved.size === 0 && globModules.size === 0,
        wholesale: relPath => globModules.has(moduleOfPath(relPath)),
        fillsHole: chunk => {
            for (const m of chunk.matchAll(RUST_DECL_RE)) {
                if (unresolved.has((m[1] ?? m[2]) as string)) return true
            }
            return false
        }
    }
}

/**
 * Source of every function `cargoExportGap` delegates to.
 *
 * `String(cargoExportGap)` covers only the top level, and the two bugs already
 * found in this pass — a rename split that truncated `Hasher`, a lock read from
 * the wrong root — both lived in helpers. A fix to one of them has to move the
 * index fingerprint or every cached facade keeps the chunks the old rule chose.
 */
export function cargoGapFingerprint(): string {
    return [cargoExportGap, runtimeDeps, useTargets, rustSources, moduleOfPath]
        .map(String)
        .concat([
            PUB_USE_RE.source,
            RUST_DECL_RE.source,
            CARGO_SKIP_DIRS.join(','),
            [...OWN_PATH_ROOTS].join(',')
        ])
        .join('\u0000')
}

/**
 * Which declared dependencies may be opened to fill the gap.
 *
 * Cargo splits a facade from its implementation by name the way hackage does —
 * `axum`/`axum-core`, `futures`/`futures-util`, `tracing`/`tracing-core` — and
 * writes that name with either separator, so both spellings are one candidate.
 *
 * The bound's cost is stated rather than hidden: `hyper` re-exports twelve names
 * from `http`, `bytes` and `http-body`, and axum's own `Bytes` comes from `bytes`.
 * No prefix rule can see any of them.
 */
export function cargoSupplementCandidates(
    pkgName: string,
    declaredDeps: ReadonlySet<string>,
    resolved: Readonly<Record<string, string>>
): Array<{name: string; version: string}> {
    const out: Array<{name: string; version: string}> = []
    const seen = new Set<string>()
    for (const dep of declaredDeps) {
        if (canonical(dep) === canonical(pkgName)) continue
        if (!canonical(dep).startsWith(`${canonical(pkgName)}_`)) continue
        const version = resolved[dep]
        if (!version || seen.has(canonical(dep))) continue
        seen.add(canonical(dep))
        out.push({name: dep, version})
    }
    // Code-unit order, not `localeCompare`: the sort decides the order supplement
    // chunks enter the index, and a locale-aware compare puts `-` and `_` in
    // different places under a different LANG.
    return out.sort((a, b) =>
        a.name < b.name ? -1
        : a.name > b.name ? 1
        : 0
    )
}
