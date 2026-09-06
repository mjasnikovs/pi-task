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
import {findAtOrAbove} from './eco-cargo.js'
import type {NpmVersionInfo} from './npm-version.js'
import type {ExportGap} from './export-gap.js'

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

/** The first existing file at `rel` at or above `cwd`, siblings included. */
function findUpOrDown(cwd: string, rel: string[]): string | null {
    return findAtOrAbove(cwd, ...rel)
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
    // A pin that is not unpacked is not_installed, NOT an invitation to answer from
    // whatever version another build left behind. Nothing marks that substitution,
    // so the version banner stays empty and the swap reaches the model silently.
    const found =
        exact ?
            fs.existsSync(exact) ?
                {root: exact, version: pinned!}
            :   null
        :   newestExtracted(extractDir, name)
    if (!found) {
        throw new ResolveError(
            'not_installed',
            `Hackage package "${name}"${pinned ? ` v${pinned}` : ''} is not unpacked under `
                + `${extractDir}.`
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
/** The same heads with the `::` wrapped onto the next line. */
const BARE_NAME_RE = /^(?:[a-z_][\w']*|\([^)]+\))(?:\s*,\s*(?:[a-z_][\w']*|\([^)]+\)))*\s*$/
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
/**
 * Blank out `{- … -}` block comments, nesting included, keeping line count.
 *
 * Without this, code inside a comment is read as real API. `vector`'s
 * `thawMany` is commented out and surfaced as a genuine signature sitting
 * between two real functions — a plausible declaration for a function that does
 * not exist, which is the worst answer this tool can give.
 *
 * `{-|` and `{-^` are haddock, not commentary, and are handled by the caller.
 */
export function stripBlockComments(src: string): string {
    const out: string[] = []
    let depth = 0
    for (const line of src.split('\n')) {
        let kept = ''
        let i = 0
        while (i < line.length) {
            if (line.startsWith('{-', i) && !isHaddockOpen(line, i)) {
                depth++
                i += 2
                continue
            }
            if (line.startsWith('-}', i) && depth > 0) {
                depth--
                i += 2
                continue
            }
            // A `--` line comment outside a block runs to end of line, and may
            // legitimately contain `{-`.
            if (depth === 0 && line.startsWith('--', i)) {
                kept += line.slice(i)
                break
            }
            if (depth === 0) kept += line[i]
            i++
        }
        out.push(kept)
    }
    return out.join('\n')
}

/** `{-|` and `{-^` open haddock; `{-#` opens a pragma, which is not a comment. */
function isHaddockOpen(line: string, i: number): boolean {
    const c = line[i + 2]
    return c === '|' || c === '^' || c === '#'
}

/** A `{-| … -}` haddock block, flattened to the `-- |` form the rest of the pass keeps. */
function haddockBlockAt(lines: string[], start: number): {text: string[]; next: number} | null {
    if (!/^\{-[|^]/.test(lines[start].trim())) return null
    const text: string[] = []
    for (let i = start; i < lines.length; i++) {
        const closed = lines[i].includes('-}')
        text.push(
            `-- ${lines[i]
                .replace(/^\s*\{-[|^]?/, '')
                .replace(/-\}\s*$/, '')
                .trim()}`
        )
        if (closed) return {text: text.filter(l => l.trim() !== '--'), next: i + 1}
    }
    return {text: text.filter(l => l.trim() !== '--'), next: lines.length}
}

/**
 * A head line that has not finished: an open bracket, an arrow, a pragma, or the
 * bare keyword — aeson writes the constraint block on the lines underneath.
 */
const INSTANCE_HEAD_CONTINUES_RE = /(?:=>|->|,|\(|\[|#-\})\s*$|^\s*instance\s*$/

/**
 * The head of an `instance`, which may wrap.
 *
 * `instance {-# OVERLAPPING #-}` and `instance ( Selector s` are both a first
 * line that names nothing, and aeson ships twelve chunks that are exactly that —
 * each one still costing a retrieval slot. The head runs to `where`, or to the
 * first line that closes its brackets without ending mid-declaration.
 */
function instanceHead(block: readonly string[]): string[] {
    const head: string[] = []
    let depth = 0
    for (const line of block) {
        const w = /\bwhere\b/.exec(line)
        if (w) {
            head.push(line.slice(0, w.index + 'where'.length).trimEnd())
            return head
        }
        head.push(line)
        for (const c of line) {
            if (c === '(' || c === '[') depth++
            else if (c === ')' || c === ']') depth--
        }
        if (depth <= 0 && !INSTANCE_HEAD_CONTINUES_RE.test(line)) return head
    }
    return head
}

export function haskellSurface(rawSrc: string): string {
    // Haddock blocks survive; ordinary `{- … -}` commentary does not.
    const src = stripBlockComments(rawSrc)
    const lines = src.split('\n')
    const out: string[] = []
    let i: number

    // The export list is the module's own statement of its API, and it spans
    // however many lines it takes to balance the parentheses.
    const moduleStart = lines.findIndex(l => /^module\s/.test(l))
    if (moduleStart >= 0) {
        // The `{-| Module : … -}` header sits ABOVE the `module` keyword, and for
        // most Hackage packages it IS the headline documentation. Emitting from
        // `module` down dropped every line of it.
        for (let h = 0; h < moduleStart; h++) {
            const block = haddockBlockAt(lines, h)
            if (!block) continue
            out.push(...block.text)
            h = block.next - 1
        }
        if (out.length) out.push('')
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
        // `{-| … -}` is how most modules write their documentation, and the
        // module header block above all. Dropping it loses the part a reader
        // actually wants.
        const haddockBlock = haddockBlockAt(lines, i)
        if (haddockBlock) {
            pending.push(...haddockBlock.text)
            i = haddockBlock.next
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

        // A signature whose `::` starts the CONTINUATION line is the same
        // declaration, and it is how most multi-constraint signatures are written:
        //     decode
        //       :: FromJSON a
        //       => ByteString -> Maybe a
        // Matching the head line alone drops those, and their haddock with them.
        const wrappedSignature =
            BARE_NAME_RE.test(line) && (block[1]?.trim().startsWith('::') ?? false)

        if (SIGNATURE_RE.test(line) || OPERATOR_SIGNATURE_RE.test(line) || wrappedSignature) {
            out.push(...pending, ...block, '')
        } else if (TYPE_HEAD_RE.test(line)) {
            const head = TYPE_HEAD_RE.exec(line)![1]
            // An instance's indented lines are definitions, not fields.
            out.push(...pending, ...(head === 'instance' ? instanceHead(block) : block), '')
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

/**
 * The package names the project's `.cabal` file declares in `build-depends`,
 * across every stanza.
 *
 * NOT {@link resolvedVersions}: that reads the cabal install plan, which is the
 * whole transitive closure, so it cannot say whether a module may be imported.
 * Undefined when there is no readable `.cabal` file.
 */
export function manifestPackages(cwd: string): Set<string> | undefined {
    let entries: string[]
    try {
        entries = fs.readdirSync(cwd)
    } catch {
        return undefined
    }
    const cabal = entries.find(e => e.endsWith('.cabal'))
    if (!cabal) return undefined
    const text = safeRead(path.join(cwd, cabal))
    if (text === null) return undefined
    const out = new Set<string>()
    let inDepends = false
    for (const raw of text.split('\n')) {
        const line = raw.replace(/--.*$/, '')
        const start = /^\s*build-depends\s*:(.*)$/i.exec(line)
        const body = start ? start[1] : line
        if (start) inDepends = true
        else if (!inDepends) continue
        // A continuation is indented; a new field at the stanza's own indent ends
        // the list. Both `,`-leading and `,`-trailing layouts are in the wild.
        else if (/^\s*[A-Za-z-]+\s*:/.test(line) || line.trim() === '') {
            inDepends = false
            continue
        }
        for (const part of body.split(',')) {
            const name = /^\s*([A-Za-z0-9][A-Za-z0-9_-]*)/.exec(part)
            if (name) out.add(name[1])
        }
    }
    return out
}

// ── re-export resolution ────────────────────────────────────────────────────

/**
 * What a package exports but does not declare.
 *
 * `hspec` indexes to 14 chunks of export lists: `it`, `describe` and `shouldBe`
 * are in the corpus as bare names with no signature attached, because every
 * signature is in `hspec-core`. The whole index is a table of contents.
 *
 * Both shapes are here because either alone misses half of it. A name-level
 * re-export puts the name in the export list; a `module X` re-export puts
 * nothing there at all, which is why `shouldBe` is invisible to the first.
 *
 * See DEFECT-12-STOPPING-RULE.md for why this triggers on the hole itself
 * rather than on a fraction of the export list.
 */

const EXPORT_NAME_RE = /^[A-Za-z_][\w']*$/
/** `module X` inside an export list is a re-export; `Prelude` is base, and base is not fetched. */
const REEXPORT_RE = /\bmodule\s+([\w.']+)/g

/** The text between `module M (` and its balancing `)`. */
function exportListText(src: string): string {
    const m = /^module\s+[\w.']+\s*/m.exec(src)
    if (!m) return ''
    const open = src.indexOf('(', m.index)
    if (open < 0) return ''
    let depth = 0
    for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++
        else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
    }
    return ''
}

const SURFACE_DECL_RE =
    /^([a-z_][\w']*)\s*::|^\(([^)]+)\)\s*::|^(?:data|newtype|type|class)\s+(?:family\s+)?(?:[^=>]*=>\s*)?([A-Z][\w']*)/

/** Every name the extracted surface declares: signatures, heads, constructors, fields. */
export function declaredInSurface(surface: string): Set<string> {
    const out = new Set<string>()
    const lines = surface.split('\n')
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const m = SURFACE_DECL_RE.exec(line)
        if (m) {
            out.add((m[1] ?? m[2] ?? m[3]).trim())
            continue
        }
        if (BARE_NAME_RE.test(line) && (lines[i + 1]?.trim().startsWith('::') ?? false)) {
            for (const n of line.split(',')) out.add(n.trim())
            continue
        }
        if (!/^\s/.test(line)) continue
        for (const c of line.matchAll(/(?:^|[=|])\s*([A-Z][\w']*)/g)) out.add(c[1])
        for (const f of line.matchAll(/(?:^|[,{])\s*([a-z_][\w']*)\s*::/g)) out.add(f[1])
    }
    return out
}

/** Read every `.hs` under `root`, skipping the directories no surface pass reads. */
function haskellSources(root: string): string[] {
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
                if (!(HACKAGE_SKIP_DIRS as readonly string[]).includes(e.name))
                    walk(path.join(dir, e.name))
            } else if (isHaskellFile(e.name)) out.push(path.join(dir, e.name))
        }
    }
    walk(root)
    return out
}

export function hackageExportGap(root: string): ExportGap {
    const declared = new Set<string>()
    const exported = new Set<string>()
    const ownModules = new Set<string>()
    const reexportedModules = new Set<string>()
    for (const file of haskellSources(root)) {
        const src = safeRead(file)
        if (src === null) continue
        for (const n of declaredInSurface(haskellSurface(src))) declared.add(n)
        const own = /^module\s+([\w.']+)/m.exec(src)
        if (own) ownModules.add(own[1])
        const list = exportListText(src)
        for (const m of list.matchAll(REEXPORT_RE)) reexportedModules.add(m[1])
        for (const raw of list.split('\n')) {
            const line = raw.replace(/--.*$/, '').replace(REEXPORT_RE, '')
            for (const token of line.split(/[,\s]+/)) {
                const name = token
                    .replace(/\(\.\.\)$/, '')
                    .replace(/[(),]/g, '')
                    .trim()
                if (EXPORT_NAME_RE.test(name)) exported.add(name)
            }
        }
    }
    for (const m of ownModules) reexportedModules.delete(m)
    reexportedModules.delete('Prelude')
    const unresolved = new Set([...exported].filter(n => !declared.has(n)))
    return {
        empty: unresolved.size === 0 && reexportedModules.size === 0,
        wholesale: (_relPath, raw) => {
            const module = /^module\s+([\w.']+)/m.exec(raw)?.[1]
            return module !== undefined && reexportedModules.has(module)
        },
        fillsHole: chunk => [...declaredInSurface(chunk)].some(n => unresolved.has(n))
    }
}

/**
 * Which declared dependencies may be opened to fill the gap.
 *
 * Hackage splits a facade from its implementation by name — `hspec`/`hspec-core`,
 * `hspec`/`hspec-expectations` — and that convention is the whole bound. Without
 * it the rule has to fetch every `build-depends` entry to find out whether it
 * declares anything: aeson names 38 of them and would resolve none, because its
 * nine unresolved exports are CPP macros and internal punctuation helpers.
 *
 * The cost of the bound is stated rather than hidden: `scotty` re-exports
 * sixteen names from `cookie`, which shares no prefix, so that hole stays open.
 */
export function supplementCandidates(
    pkgName: string,
    declaredDeps: ReadonlySet<string>,
    resolved: Readonly<Record<string, string>>
): Array<{name: string; version: string}> {
    const out: Array<{name: string; version: string}> = []
    for (const dep of declaredDeps) {
        if (!dep.startsWith(`${pkgName}-`)) continue
        const version = resolved[dep]
        if (version) out.push({name: dep, version})
    }
    // Code-unit order, not `localeCompare`: this sort decides index order and a
    // locale-aware compare is a machine-dependent index.
    return out.sort((a, b) =>
        a.name < b.name ? -1
        : a.name > b.name ? 1
        : 0
    )
}
