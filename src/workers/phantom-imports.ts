/**
 * Detect phantom runtime imports — `bun:sql`, `node:nope`, etc. — referenced in a
 * task/spec but NOT actually declared by the runtime's installed types.
 *
 * A real `<runtime>:<sub>` builtin appears as `declare module "<runtime>:<sub>"`
 * in the runtime's type files: bun-types declares exactly bun:bundle, bun:ffi,
 * bun:jsc, bun:sqlite and bun:test, and @types/node declares node:assert,
 * node:buffer, node:child_process and the rest. A specifier with no such
 * declaration is a hallucination — the symbol, if it exists at all, lives on the
 * base module. `bun:sql` is the canonical case: bun-types declares no such module,
 * but `declare module "bun"` does declare `const sql: SQL`, so the correct import
 * is from `"bun"` and a `declare module "bun:sql"` shim only hides the mistake.
 *
 * The check is deterministic and needs no LLM call. It can only be as good as the
 * installed types: a runtime whose types are not on disk is skipped entirely.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    resolvePackage,
    splitRuntimeNamespace,
    hasTypeFiles,
    isDtsFile,
    resolveTypeSource,
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
    /** Base-module symbol the submodule leaf maps to (`bun:sql` → `SQL`), or null
     *  when the types declare no matching symbol. Drives the canonical-import rewrite. */
    baseSymbol: string | null
}

// Runtime builtin specifiers as they appear in prose/code: `bun:sql`,
// `node:fs/promises`. Bounded to the runtimes splitRuntimeNamespace accepts.
const SPEC_RE = /\b(?:bun|node|deno):[a-z0-9][a-z0-9/_-]*/gi
const DECLARE_MODULE_RE = /declare module "([^"]+)"/g

/** Every distinct runtime-namespace specifier mentioned in the text, in first-seen order. */
export function extractRuntimeSpecifiers(text: string): string[] {
    const seen = new Set<string>()
    for (const m of text.matchAll(SPEC_RE)) {
        // Kept exactly as written, including case: `BUN:SQL` and `bun:sql` are two
        // entries here. `splitRuntimeNamespace` lowercases the runtime downstream,
        // and the subpath is case-sensitive, so nothing is folded at this layer.
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
        // leaf? Case-insensitive, which is what makes `bun:sql` find the real
        // `const sql: SQL` and report `SQL` as the symbol to import.
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

/** The phantom-import checker's adapter over the shared redirect walk: hops resolve
 *  SYNCHRONOUSLY and never install. A runtime whose types aren't on disk simply
 *  can't be verified (null), so we never flag what we can't prove. */
async function resolveRuntimeTypesRoot(runtime: string, cwd: string): Promise<string | null> {
    let start: ResolvedPackage
    try {
        start = resolvePackage(runtime, cwd)
    } catch (err) {
        if (err instanceof ResolveError) return null
        throw err
    }
    const cur = await resolveTypeSource(start, runtime, next => {
        try {
            return Promise.resolve(resolvePackage(next, cwd))
        } catch {
            return Promise.resolve(null)
        }
    })
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
export async function loadRuntimeTypeText(runtime: string, cwd: string): Promise<string | null> {
    const root = await resolveRuntimeTypesRoot(runtime, cwd)
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
export async function findPhantomImports(
    text: string,
    cwd: string,
    loadText: (
        runtime: string,
        cwd: string
    ) => string | null | Promise<string | null> = loadRuntimeTypeText
): Promise<PhantomImport[]> {
    const out: PhantomImport[] = []
    const typeTextByRuntime = new Map<string, string | null>()
    for (const spec of extractRuntimeSpecifiers(text)) {
        const ns = splitRuntimeNamespace(spec)
        if (!ns) continue
        if (!typeTextByRuntime.has(ns.runtime)) {
            typeTextByRuntime.set(ns.runtime, await loadText(ns.runtime, cwd))
        }
        const typeText = typeTextByRuntime.get(ns.runtime)
        if (!typeText) continue
        const verdict = classifyRuntimeImport(spec, ns.runtime, ns.sub, typeText)
        if (verdict.real) continue
        out.push({
            spec,
            realModules: verdict.realModules,
            suggestion: suggestionFor(verdict, ns.runtime),
            baseSymbol: verdict.baseSymbol
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

/**
 * A top-of-handoff override banner (Layer B — orchestrator.ts names the two layers:
 * A strips phantoms from the refined spec, B overrides at delivery). The check has
 * proven —
 * against the installed type definitions — that the spec, or a design doc it
 * references, names an API that does NOT exist. The implementer is told the spec/doc
 * is authoritative, so a residual affirmative that survived into the composed spec, or
 * one re-injected when pi expands an `@design.md` the spec references, can still push it
 * to write `bun:sql` / a `declare module` shim. This banner sits ABOVE the spec and is
 * declared to outrank it for these specifiers only. Empty when nothing is flagged.
 */
export function formatApiOverrideBanner(phantoms: PhantomImport[]): string {
    if (phantoms.length === 0) return ''
    const lines = phantoms.map(p => `  - ${p.suggestion}`)
    return (
        'VERIFIED API OVERRIDES — checked against the installed type definitions. These '
        + 'SUPERSEDE the spec below and any design/spec document it references: the doc is '
        + 'WRONG about these specifiers, so do NOT follow it here.\n'
        + lines.join('\n')
        + '\nUse the corrected import shown for each. Never write the phantom specifier, '
        + 'and never add a `declare module` shim to make it resolve.'
    )
}

// An @-file mention in a spec ("@DESIGN/foo.md", path until whitespace) minus the
// trailing prose punctuation a sentence adds. Mirrors auto-orchestrator's mention
// rules so we read the same docs pi re-expands when delivering the spec.
const MENTION_RE = /(?:^|\s)@([^\s]+)/g
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/**
 * The phantoms the IMPLEMENTER would actually encounter: those named in the delivered
 * spec text itself, PLUS those in any @-file the spec references (pi expands that
 * mention at send time, re-injecting the doc's affirmative). Concatenates the spec with
 * each readable referenced doc and runs the standard deterministic check over the whole.
 * Unreadable mentions are skipped; silent when types are absent or nothing is flagged.
 * Drives the impl-handoff override banner (Layer B).
 */
export async function findDeliveryPhantoms(spec: string, cwd: string): Promise<PhantomImport[]> {
    let text = spec
    const seen = new Set<string>()
    for (const m of spec.matchAll(MENTION_RE)) {
        const rel = m[1].replace(MENTION_TRAILING_PUNCT, '')
        if (rel === '' || seen.has(rel)) continue
        seen.add(rel)
        try {
            text += '\n' + fs.readFileSync(path.resolve(cwd, rel), 'utf8')
        } catch {
            // not a readable file — leave the @token, skip it
        }
    }
    return findPhantomImports(text, cwd)
}

/**
 * Subtractively rewrite every flagged phantom specifier in `text` to the canonical
 * import the installed types prove, so NO affirmative occurrence of the specifier
 * survives downstream. This is the half an APPENDED correction cannot do: later
 * phases copy identifiers verbatim, so a `bun:sql` left in the text keeps being
 * re-stated no matter what a correction says about it.
 *
 * Deterministic, no LLM. Handles the four forms a phantom takes: an import/require
 * `from "<spec>"`, a fabricated `declare module "<spec>"`, a backticked prose
 * mention `` `<spec>` ``, and a bare word. A path-like `./bun:sql/x` is left alone
 * by the bare-word rule's lookbehind.
 *
 * Idempotent: once a specifier is replaced the literal is gone. The `declare
 * module` replacement deliberately does not echo the spec, so a second pass over
 * the output returns it byte for byte.
 */
export function rewritePhantomSpecifiers(text: string, phantoms: PhantomImport[]): string {
    let out = text
    for (const p of phantoms) {
        const ns = splitRuntimeNamespace(p.spec)
        if (!ns) continue
        const runtime = ns.runtime
        const canonical =
            p.baseSymbol ?
                `import { ${p.baseSymbol} } from "${runtime}"`
            :   `the "${runtime}" module`
        const spec = escapeRe(p.spec)
        out = out
            // `from "bun:sql"` / `require("bun:sql")` → point at the base runtime module
            .replace(
                new RegExp(`((?:from\\s+|require\\(\\s*)["'])${spec}(["'])`, 'g'),
                `$1${runtime}$2`
            )
            // a fabricated `declare module "bun:sql"` → a comment naming the real import.
            // Deliberately does NOT echo the spec literal, so the bare-word pass below
            // can't re-corrupt this comment (keeps the rewrite idempotent).
            .replace(
                new RegExp(`declare\\s+module\\s+["']${spec}["']`, 'g'),
                `/* not a module — use ${canonical} */`
            )
            // backticked prose mention → the canonical import
            .replace(new RegExp('`' + spec + '`', 'g'), '`' + canonical + '`')
            // bare word, not already inside quotes/backticks/a path or our own comment
            .replace(new RegExp(`(?<![\`"'/])\\b${spec}\\b(?![\`"'])`, 'g'), canonical)
    }
    return out
}
