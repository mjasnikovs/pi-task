/**
 * Detect phantom runtime imports — `bun:sql`, `node:nope`, etc. — referenced in a
 * task/spec but NOT actually declared by the runtime's installed types.
 *
 * A real `<runtime>:<sub>` builtin appears as `declare module "<runtime>:<sub>"`
 * in the runtime's type files (bun-types declares bun:sqlite/bun:test/bun:ffi/…;
 * @types/node declares node:fs/…). A specifier with no such declaration is a
 * hallucination — the symbol, if it exists at all, lives on the base module. This
 * is the exact `bun:sql` failure class: a design doc invented `bun:sql`, every
 * phase echoed it, and the implementer fabricated a `declare module "bun:sql"`
 * shim to make it compile. Verifying the specifier against the installed types
 * catches it deterministically, with no false positives and no LLM call.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    resolvePackage,
    splitRuntimeNamespace,
    detectTypesRedirect,
    typesPackageName,
    hasTypeFiles,
    isDtsFile,
    ResolveError,
    type ResolvedPackage
} from './docs-resolve.js'

export interface PhantomImport {
    /** The bad specifier exactly as written, e.g. `bun:sql`. */
    spec: string
    /** Real `<runtime>:` modules the types DO declare (evidence for the correction). */
    realModules: string[]
    /** Corrective guidance to inject into the spec. */
    suggestion: string
}

// Runtime builtin specifiers as they appear in prose/code: `bun:sql`,
// `node:fs/promises`. Bounded to the runtimes splitRuntimeNamespace accepts.
const SPEC_RE = /\b(?:bun|node|deno):[a-z0-9][a-z0-9/_-]*/gi
const DECLARE_MODULE_RE = /declare module "([^"]+)"/g

/** Every distinct runtime-namespace specifier mentioned in the text, in first-seen order. */
export function extractRuntimeSpecifiers(text: string): string[] {
    const seen = new Set<string>()
    for (const m of text.matchAll(SPEC_RE)) {
        // Normalise: drop a trailing punctuation the word boundary may include is
        // already excluded by the class; lowercase the runtime only (subpaths are
        // case-sensitive). splitRuntimeNamespace lowercases the runtime itself.
        if (!seen.has(m[0])) seen.add(m[0])
    }
    return [...seen]
}

export interface RuntimeImportVerdict {
    spec: string
    real: boolean
    /** When phantom: a base-module symbol matching the submodule leaf, if the types
     *  declare one (so the correction can name the real import). */
    baseSymbol: string | null
    /** Real `<runtime>:` modules declared in the type text. */
    realModules: string[]
}

/**
 * Pure verdict over a runtime's concatenated type text — no I/O, so the rule is
 * unit-testable with synthetic declarations.
 */
export function classifyRuntimeImport(
    spec: string,
    runtime: string,
    sub: string,
    typeText: string
): RuntimeImportVerdict {
    const declared = new Set<string>()
    for (const m of typeText.matchAll(DECLARE_MODULE_RE)) declared.add(m[1])
    const real = declared.has(spec)
    const realModules = [...declared].filter(d => d.startsWith(`${runtime}:`)).sort()
    let baseSymbol: string | null = null
    if (!real) {
        const leaf = sub.split('/').pop() ?? sub
        // Does the base runtime module declare a symbol named like the submodule
        // leaf (e.g. `bun:sql` → `const sql` / `class SQL` in `declare module "bun"`)?
        // Case-insensitive so `sql` matches the `SQL` class too.
        const re = new RegExp(
            `\\b(?:const|class|function|let|var|namespace|interface|type)\\s+(${escapeRe(leaf)})\\b`,
            'i'
        )
        const m = re.exec(typeText)
        baseSymbol = m ? m[1] : null
    }
    return {spec, real, baseSymbol, realModules}
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function suggestionFor(v: RuntimeImportVerdict, runtime: string): string {
    if (v.baseSymbol) {
        return (
            `\`${v.spec}\` is NOT a module — the symbol is exported from the base runtime `
            + `module: use \`import { ${v.baseSymbol} } from "${runtime}"\` (never import from `
            + `\`${v.spec}\` and never declare a module for it).`
        )
    }
    const list =
        v.realModules.length > 0 ?
            ` The real \`${runtime}:\` modules are: ${v.realModules.join(', ')}.`
        :   ''
    return (
        `\`${v.spec}\` is NOT a real module.${list} Import the needed symbol from `
        + `"${runtime}" or verify the correct specifier with pi-worker-docs; do not declare a module for it.`
    )
}

/** Sync resolution of a runtime to the package that actually holds its type
 *  declarations (bun -> @types/bun -> bun-types), bounded to a few hops. No
 *  auto-install: a runtime whose types aren't installed simply can't be verified
 *  (returns null), so we never flag what we can't prove. */
function resolveRuntimeTypesRoot(runtime: string, cwd: string): string | null {
    let cur: ResolvedPackage
    try {
        cur = resolvePackage(runtime, cwd)
    } catch (err) {
        if (err instanceof ResolveError) return null
        throw err
    }
    const visited = new Set<string>([cur.name, runtime])
    for (let hop = 0; hop < 3; hop++) {
        let next = detectTypesRedirect(cur)
        if (next && visited.has(next)) next = null
        if (!next && !hasTypeFiles(cur.root)) {
            const types = typesPackageName(cur.name)
            if (types && !visited.has(types)) next = types
        }
        if (!next) break
        visited.add(next)
        try {
            cur = resolvePackage(next, cwd)
        } catch {
            break
        }
    }
    return hasTypeFiles(cur.root) ? cur.root : null
}

const MAX_TYPE_BYTES = 4_000_000

function readRuntimeTypeText(root: string): string {
    const parts: string[] = []
    let total = 0
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
            if (entry.isDirectory()) {
                stack.push(full)
            } else if (entry.isFile() && isDtsFile(entry.name)) {
                try {
                    const raw = fs.readFileSync(full, 'utf8')
                    total += raw.length
                    parts.push(raw)
                    if (total >= MAX_TYPE_BYTES) return parts.join('\n')
                } catch {
                    // unreadable file — skip
                }
            }
        }
    }
    return parts.join('\n')
}

/** Default loader: resolve the runtime's installed types and read their .d.ts. */
export function loadRuntimeTypeText(runtime: string, cwd: string): string | null {
    const root = resolveRuntimeTypesRoot(runtime, cwd)
    if (!root) return null
    const text = readRuntimeTypeText(root)
    return text.length > 0 ? text : null
}

/**
 * Scan `text` for runtime-namespace specifiers and return the ones the installed
 * types do not declare. `loadText` is injectable for tests; in production it reads
 * the runtime's type package. A runtime whose types can't be loaded is skipped
 * (we never flag what we can't verify), so this is silent when types are absent.
 */
export function findPhantomImports(
    text: string,
    cwd: string,
    loadText: (runtime: string, cwd: string) => string | null = loadRuntimeTypeText
): PhantomImport[] {
    const out: PhantomImport[] = []
    const typeTextByRuntime = new Map<string, string | null>()
    for (const spec of extractRuntimeSpecifiers(text)) {
        const ns = splitRuntimeNamespace(spec)
        if (!ns) continue
        if (!typeTextByRuntime.has(ns.runtime)) {
            typeTextByRuntime.set(ns.runtime, loadText(ns.runtime, cwd))
        }
        const typeText = typeTextByRuntime.get(ns.runtime)
        if (!typeText) continue
        const verdict = classifyRuntimeImport(spec, ns.runtime, ns.sub, typeText)
        if (verdict.real) continue
        out.push({
            spec,
            realModules: verdict.realModules,
            suggestion: suggestionFor(verdict, ns.runtime)
        })
    }
    return out
}

/** Render flagged phantoms as an authoritative research section, or '' if none. */
export function formatApiCorrections(phantoms: PhantomImport[]): string {
    if (phantoms.length === 0) return ''
    const lines = phantoms.map(p => `  - ${p.suggestion}`)
    return `API CORRECTIONS\n${lines.join('\n')}`
}
