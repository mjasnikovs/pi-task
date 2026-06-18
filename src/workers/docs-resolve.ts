import {createRequire} from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'

const DTS_RE = /\.d\.(?:ts|mts|cts)$/

/** True for TypeScript declaration files: .d.ts, .d.mts, .d.cts. */
export function isDtsFile(name: string): boolean {
    return DTS_RE.test(name)
}

export interface ResolvedPackage {
    name: string
    version: string
    root: string
    entryDts: string | null
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

function isValidModuleName(name: string): boolean {
    if (!name || name.includes('..') || name.startsWith('/')) return false
    return MODULE_NAME_RE.test(name)
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

    // First try: use createRequire (works when package.json is exported)
    const requireFromCwd = createRequire(path.join(cwd, '__pi-worker-docs-sentinel__'))
    let pkgJsonPath: string | null = null
    try {
        pkgJsonPath = requireFromCwd.resolve(`${parent}/package.json`)
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw err
        // Fall through to direct filesystem fallback below
    }

    // Second try: walk node_modules directly (handles packages that don't export package.json)
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
        name: pkg.name ?? parent,
        version: pkg.version ?? '0.0.0',
        root,
        entryDts: resolveEntryDts(moduleName, parent, root, pkg),
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

/** When a package is a pure pointer to another types package — a single-file
 *  `/// <reference types="X" />` (the `@types/bun -> bun-types` shape) or a lone
 *  `export * from "X"` re-export — return the target package name. Returns null
 *  for packages that ship their own declarations (more than one .d.ts file, or a
 *  local `/// <reference path=... />` aggregator entry). */
export function detectTypesRedirect(pkg: ResolvedPackage): string | null {
    // A package that ships multiple declaration files is an aggregator, not a
    // redirect stub — use its own types.
    if (countTypeFiles(pkg.root, 2) > 1) return null
    const entry = pkg.entryDts ?? findIndexDts(pkg.root)
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
    const ref = REFERENCE_TYPES_RE.exec(content)
    if (ref && isBareSpecifier(ref[1])) return parentPackageName(ref[1])
    const rex = REEXPORT_ALL_RE.exec(content)
    if (rex && isBareSpecifier(rex[1])) return parentPackageName(rex[1])
    return null
}
