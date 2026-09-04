import {createRequire} from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {EcosystemId} from './docs-ecosystems.js'

const DTS_RE = /\.d\.(?:ts|mts|cts)$/

/** True for TypeScript declaration files: .d.ts, .d.mts, .d.cts. */
export function isDtsFile(name: string): boolean {
    return DTS_RE.test(name)
}

export interface ResolvedPackage {
    /** Which registry this package came from. Scopes it in the docs cache. */
    ecosystem: EcosystemId
    name: string
    version: string
    root: string
    /** The file holding the package's public API surface, if it has one. */
    entry: string | null
    readme: string | null
}

export class ResolveError extends Error {
    constructor(
        public readonly kind: 'not_installed' | 'invalid_name',
        message: string
    ) {
        super(message)
        this.name = 'ResolveError'
    }
}

const MODULE_NAME_RE = /^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+(?:\/[a-z0-9-_./]+)?$/i

export function isValidModuleName(name: string): boolean {
    if (!name || name.includes('..') || name.startsWith('/')) return false
    return MODULE_NAME_RE.test(name)
}

// Runtimes whose builtin `<runtime>:<sub>` imports are typed by the runtime's own
// types package, not by a literal package named "<runtime>:<sub>". `node:fs` and
// `bun:sqlite` are real imports whose declarations live in @types/node and
// bun-types. `bun:sql` is a phantom — importing it fails with "Cannot find
// package 'sql'" — and the only way to disprove it is to resolve the runtime and
// find the symbol absent. Either way the docs lookup target is the runtime, never
// the colon-name.
const RUNTIME_NAMESPACES = new Set(['bun', 'node', 'deno'])

/**
 * Split a runtime builtin specifier (`bun:sql`, `node:fs/promises`) into its
 * runtime and submodule. Returns null for ordinary specifiers (including scoped
 * names, which legitimately contain no colon). The resolver maps the runtime to
 * its types package via the existing @types redirect chain (bun -> bun-types,
 * node -> @types/node), so a `bun:sql` query lands on Bun's real SQL surface
 * (`declare module "bun"` → `const sql: SQL`) instead of erroring `invalid_name`.
 */
export function splitRuntimeNamespace(spec: string): {runtime: string; sub: string} | null {
    const m = /^([a-z]+):([a-z0-9./_-]+)$/i.exec(spec)
    if (!m) return null
    const runtime = m[1].toLowerCase()
    if (!RUNTIME_NAMESPACES.has(runtime)) return null
    return {runtime, sub: m[2]}
}

function parentPackageName(moduleName: string): string {
    if (moduleName.startsWith('@')) {
        const parts = moduleName.split('/')
        return `${parts[0]}/${parts[1]}`
    }
    return moduleName.split('/')[0]
}

interface PackageJson {
    name?: string
    version?: string
    types?: string
    typings?: string
    exports?: Record<string, unknown> | string
}

function readPackageJson(file: string): PackageJson {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson
}

function extractTypesFromExports(exports: PackageJson['exports']): string | null {
    if (!exports || typeof exports === 'string') return null
    const root = exports['.']
    if (!root || typeof root !== 'object') return null
    const r = root as Record<string, unknown>
    const t = r.types
    return typeof t === 'string' ? t : null
}

function findReadme(root: string): string | null {
    const candidate = path.join(root, 'README.md')
    if (fs.existsSync(candidate)) return candidate
    let entries: string[]
    try {
        entries = fs.readdirSync(root)
    } catch {
        return null
    }
    const match = entries.find(e => e.toLowerCase() === 'readme.md')
    return match ? path.join(root, match) : null
}

function resolveEntryDts(
    moduleName: string,
    parent: string,
    root: string,
    pkg: PackageJson
): string | null {
    if (moduleName !== parent) {
        const subpath = moduleName.slice(parent.length + 1)
        const candidates = [
            `${subpath}.d.ts`,
            `${subpath}.d.mts`,
            `${subpath}.d.cts`,
            `${subpath}/index.d.ts`,
            `${subpath}/index.d.mts`,
            `${subpath}/index.d.cts`,
            subpath
        ]
        for (const c of candidates) {
            const abs = path.join(root, c)
            if (fs.existsSync(abs) && isDtsFile(abs)) return abs
        }
    }
    const fromTypes = pkg.types || pkg.typings
    if (fromTypes) {
        const abs = path.resolve(root, fromTypes)
        if (fs.existsSync(abs)) return abs
    }
    const fromExports = extractTypesFromExports(pkg.exports)
    if (fromExports) {
        const abs = path.resolve(root, fromExports)
        if (fs.existsSync(abs)) return abs
    }
    for (const name of ['index.d.ts', 'index.d.mts', 'index.d.cts']) {
        const fallback = path.join(root, name)
        if (fs.existsSync(fallback)) return fallback
    }
    return null
}

export function resolvePackage(moduleName: string, cwd: string): ResolvedPackage {
    if (!isValidModuleName(moduleName)) {
        throw new ResolveError('invalid_name', `Invalid module name: "${moduleName}"`)
    }
    const parent = parentPackageName(moduleName)

    // First try: `createRequire`. It only works when the package EXPORTS
    // `./package.json`; a package that does not gives ERR_PACKAGE_PATH_NOT_EXPORTED
    // and falls through. Any other resolve error is rethrown.
    const requireFromCwd = createRequire(path.join(cwd, '__pi-worker-docs-sentinel__'))
    let pkgJsonPath: string | null = null
    try {
        pkgJsonPath = requireFromCwd.resolve(`${parent}/package.json`)
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err
    }

    // Second try: walk node_modules upward from cwd. This is what handles a package
    // that does not export its package.json, and it is the only path that reports
    // `not_installed`.
    if (!pkgJsonPath) {
        const direct = findPackageJsonInNodeModules(parent, cwd)
        if (!direct) {
            throw new ResolveError(
                'not_installed',
                `Package "${parent}" is not installed in ${cwd}. Run \`npm install ${parent}\` (or \`bun add ${parent}\`) and retry.`
            )
        }
        pkgJsonPath = direct
    }

    const root = path.dirname(pkgJsonPath)
    const pkg = readPackageJson(pkgJsonPath)
    return {
        ecosystem: 'npm',
        name: pkg.name ?? parent,
        version: pkg.version ?? '0.0.0',
        root,
        entry: resolveEntryDts(moduleName, parent, root, pkg),
        readme: findReadme(root)
    }
}

function findPackageJsonInNodeModules(parent: string, startDir: string): string | null {
    const segments = parent.startsWith('@') ? parent.split('/').slice(0, 2) : [parent.split('/')[0]]
    let dir = startDir
    while (true) {
        const candidate = path.join(dir, 'node_modules', ...segments, 'package.json')
        if (fs.existsSync(candidate)) return candidate
        const up = path.dirname(dir)
        if (up === dir) return null
        dir = up
    }
}

/** Conventional DefinitelyTyped package for a runtime package that ships no
 *  types of its own. `bun` -> `@types/bun`, `@scope/x` -> `@types/scope__x`.
 *  Returns null for packages that are already under the `@types` scope. */
export function typesPackageName(moduleName: string): string | null {
    const parent = parentPackageName(moduleName)
    if (parent.startsWith('@types/')) return null
    if (parent.startsWith('@')) {
        const [scope, name] = parent.slice(1).split('/')
        if (!scope || !name) return null
        return `@types/${scope}__${name}`
    }
    return `@types/${parent}`
}

/** Count declaration files under root (excluding nested node_modules), stopping
 *  once `cap` is reached. */
function countTypeFiles(root: string, cap: number): number {
    let n = 0
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
            if (entry.name === 'node_modules') continue
            const full = path.join(dir, entry.name)
            if (entry.isDirectory()) stack.push(full)
            else if (entry.isFile() && isDtsFile(entry.name)) {
                if (++n >= cap) return n
            }
        }
    }
    return n
}

/** True if the package ships at least one declaration file. */
export function hasTypeFiles(root: string): boolean {
    return countTypeFiles(root, 1) > 0
}

function findIndexDts(root: string): string | null {
    for (const name of ['index.d.ts', 'index.d.mts', 'index.d.cts']) {
        const abs = path.join(root, name)
        if (fs.existsSync(abs)) return abs
    }
    return null
}

function isBareSpecifier(spec: string): boolean {
    return spec.length > 0 && !spec.startsWith('.') && !spec.startsWith('/')
}

const REFERENCE_TYPES_RE = /\/\/\/\s*<reference\s+types=["']([^"']+)["']\s*\/>/
const REEXPORT_ALL_RE = /^\s*export\s+(?:type\s+)?\*\s+from\s+["']([^"']+)["'];?\s*$/m

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const DECLARATION_RE =
    /^\s*(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+|async\s+)?(?:interface|type|class|function|const|let|var|namespace|module|enum)\b/

/**
 * Count declarations in a declaration file's text, ignoring comments, blank
 * lines, and the pointer lines a redirect stub is made of (`/// <reference .. />`
 * and `export * from "X"`).
 *
 * This is the discriminator `detectTypesRedirect` needs. A redirect stub has
 * nothing in it but the pointer and counts 0. A real API surface that merely
 * declares an AMBIENT DEPENDENCY on another types package —
 * `/// <reference types="node" />` above its own declarations — counts those
 * declarations and is not a stub. A `.d.ts` FILE count cannot tell the two apart:
 * both ship exactly one file.
 *
 * Deliberately lexical, not a TypeScript parse: `typescript` is a devDependency
 * here, so the shipped worker has no compiler to call. Over-counting is the safe
 * direction — a declaration found means not a stub, so the package keeps its own
 * types.
 */
export function countEntryDeclarations(content: string): number {
    const stripped = content.replace(BLOCK_COMMENT_RE, '')
    let n = 0
    for (const raw of stripped.split('\n')) {
        const line = raw.trim()
        if (!line || line.startsWith('//')) continue
        if (REEXPORT_ALL_RE.test(line)) continue
        if (DECLARATION_RE.test(line)) n++
    }
    return n
}

/** The package a declaration file points at: a triple-slash `<reference types>`
 *  or a whole-module `export * from`. Null when the file points nowhere. */
function pointerTarget(content: string): string | null {
    const ref = REFERENCE_TYPES_RE.exec(content)
    if (ref && isBareSpecifier(ref[1])) return parentPackageName(ref[1])
    const rex = REEXPORT_ALL_RE.exec(content)
    if (rex && isBareSpecifier(rex[1])) return parentPackageName(rex[1])
    return null
}

/** When a package is a pure pointer to another types package — a single-file
 *  `/// <reference types="X" />` (the `@types/bun -> bun-types` shape) or a lone
 *  `export * from "X"` re-export — return the target package name. Returns null
 *  for packages that ship their own declarations (more than one .d.ts file, a
 *  local `/// <reference path=... />` aggregator entry, or an entry file that
 *  declares anything of its own). */
export function detectTypesRedirect(pkg: ResolvedPackage): string | null {
    // A package that ships multiple declaration files is an aggregator, not a
    // redirect stub — use its own types.
    if (countTypeFiles(pkg.root, 2) > 1) return null
    const entry = pkg.entry ?? findIndexDts(pkg.root)
    if (!entry) return null
    let content: string
    try {
        content = fs.readFileSync(entry, 'utf8')
    } catch {
        return null
    }
    // A local `/// <reference path="..." />` means the entry aggregates sibling
    // declarations (e.g. bun-types) — not a redirect to another package.
    if (/\/\/\/\s*<reference\s+path=/.test(content)) return null
    const target = pointerTarget(content)
    if (!target) return null
    // A pointer line is not a redirect when the file it sits in also declares an
    // API. `/// <reference types="node" />` above a package's own declarations
    // means "my types NEED node's", not "my types ARE node's". Following it would
    // answer every question about that package out of @types/node while its own
    // surface sat one file away — and the .d.ts FILE count cannot see the
    // difference, because a stub and a single-file API surface both count 1.
    if (countEntryDeclarations(content) > 0) return null
    return target
}

/**
 * Follow the `@types/<name>` + triple-slash `<reference types>` redirect chain from
 * a package that ships no usable types of its own to the one that actually holds
 * the declarations — `bun` → `@types/bun` → `bun-types`. Bounded to three hops:
 * a chain of pure stubs stops after exactly three. The `visited` set cuts a cycle,
 * and the package it started from comes back when no better source is found.
 *
 * This is what the four predicates above exist for, and the walk is written once
 * for its two callers.
 *
 * `resolveHop` is the one thing those callers genuinely disagree about: docs-core
 * resolves the next hop through an auto-installing async lookup, while
 * phantom-imports wraps a bare sync `resolvePackage` that must never install.
 * Returning null stops the walk.
 */
export async function resolveTypeSource(
    start: ResolvedPackage,
    seed: string,
    resolveHop: (name: string) => Promise<ResolvedPackage | null>
): Promise<ResolvedPackage> {
    const visited = new Set<string>([start.name, seed])
    let cur = start
    for (let hop = 0; hop < 3; hop++) {
        let next = detectTypesRedirect(cur)
        if (next && visited.has(next)) next = null
        if (!next && !hasTypeFiles(cur.root)) {
            const types = typesPackageName(cur.name)
            if (types && !visited.has(types)) next = types
        }
        if (!next) break
        visited.add(next)
        const resolved = await resolveHop(next)
        if (!resolved) break
        cur = resolved
    }
    return cur
}
