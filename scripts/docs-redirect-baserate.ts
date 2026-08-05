/**
 * STEP 0 for nexttask 1 — the BASE RATE of `detectTypesRedirect` firing, measured
 * with the SHIPPED predicate before any lever exists.
 *
 * Methodology rule this satisfies: measure the base rate BEFORE changing code
 * (VALIDATION-DEBT.md; memory/prompt2-typeonly-baserate.md). A predicate change
 * wired without one cannot distinguish "removed the wrong redirects" from "the
 * wrong redirects were never there".
 *
 * For every package installed in every corpus tree that the shipped predicate
 * REDIRECTS, print:
 *
 *     package -> redirect target | .d.ts count | entry lines | declarations in entry
 *
 * The last column is the discriminator under test (`countEntryDeclarations`): a
 * true redirect stub is a file with nothing in it but the pointer, so its count is
 * 0. Every redirect whose entry file carries declarations is a candidate bug —
 * `sharp -> node` (1971 lines) is the one that motivated this, but the table is
 * the artifact, not the anecdote.
 *
 * Nothing is written and nothing is installed; corpus trees are read only.
 *
 * Run: bun run scripts/docs-redirect-baserate.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
    countEntryDeclarations,
    detectTypesRedirect,
    hasTypeFiles,
    isDtsFile,
    resolvePackage,
    typesPackageName,
    type ResolvedPackage
} from '../src/workers/docs-resolve.js'

export const CORPUS = [
    '/home/edgars/hub/mx5',
    '/home/edgars/hub/aiz-server',
    '/home/edgars/hub/aiz-client',
    '/home/edgars/hub/gofer',
    '/home/edgars/hub/gofer-rag',
    '/home/edgars/hub/IAR1',
    '/home/edgars/.pi/agent/extensions/pi-task'
]

export interface TreeStatus {
    tree: string
    /** 'ok' | 'not-a-node-tree' (no package.json) | 'uninstalled' (package.json, no node_modules) */
    kind: 'ok' | 'not-a-node-tree' | 'uninstalled'
}

export function treeStatus(tree: string): TreeStatus {
    if (!fs.existsSync(tree)) return {tree, kind: 'not-a-node-tree'}
    if (!fs.existsSync(path.join(tree, 'package.json'))) return {tree, kind: 'not-a-node-tree'}
    if (!fs.existsSync(path.join(tree, 'node_modules'))) return {tree, kind: 'uninstalled'}
    return {tree, kind: 'ok'}
}

/** Every package name installed at the top level of a tree's node_modules. */
export function listInstalled(tree: string): string[] {
    const nm = path.join(tree, 'node_modules')
    const names: string[] = []
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(nm, {withFileTypes: true})
    } catch {
        return names
    }
    for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue
        if (e.name.startsWith('.')) continue
        if (!e.name.startsWith('@')) {
            names.push(e.name)
            continue
        }
        let scoped: fs.Dirent[]
        try {
            scoped = fs.readdirSync(path.join(nm, e.name), {withFileTypes: true})
        } catch {
            continue
        }
        for (const s of scoped) {
            if (s.name.startsWith('.')) continue
            names.push(`${e.name}/${s.name}`)
        }
    }
    return names.sort()
}

/** Uncapped .d.ts count under a package root (excluding nested node_modules). */
export function countDtsFiles(root: string, cap = 5000): number {
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

function findIndexDts(root: string): string | null {
    for (const name of ['index.d.ts', 'index.d.mts', 'index.d.cts']) {
        const abs = path.join(root, name)
        if (fs.existsSync(abs)) return abs
    }
    return null
}

export interface RedirectRow {
    tree: string
    pkg: string
    version: string
    target: string
    dts: number
    entry: string
    lines: number
    decls: number
}

export function measureTree(tree: string): RedirectRow[] {
    const rows: RedirectRow[] = []
    for (const name of listInstalled(tree)) {
        let pkg: ResolvedPackage
        try {
            pkg = resolvePackage(name, tree)
        } catch {
            continue
        }
        const target = detectTypesRedirect(pkg)
        if (!target) continue
        const entry = pkg.entryDts ?? findIndexDts(pkg.root)
        let content: string
        try {
            content = entry ? fs.readFileSync(entry, 'utf8') : ''
        } catch {
            content = ''
        }
        rows.push({
            tree,
            pkg: name,
            version: pkg.version,
            target,
            dts: countDtsFiles(pkg.root),
            entry: entry ? path.relative(pkg.root, entry) : '(none)',
            lines: content ? content.split('\n').length : 0,
            decls: countEntryDeclarations(content)
        })
    }
    return rows
}

/** Packages reaching the `!hasTypeFiles` -> `@types/<name>` branch of the redirect
 *  loop (docs-core.ts:282-285). Recorded so the A/B's inv-typeless-kept has a
 *  measured population, not an assumption about react alone. */
export function measureTypeless(tree: string): {pkg: string; target: string}[] {
    const out: {pkg: string; target: string}[] = []
    for (const name of listInstalled(tree)) {
        let pkg: ResolvedPackage
        try {
            pkg = resolvePackage(name, tree)
        } catch {
            continue
        }
        if (hasTypeFiles(pkg.root)) continue
        if (detectTypesRedirect(pkg)) continue
        const types = typesPackageName(pkg.name)
        if (!types) continue
        try {
            resolvePackage(types, tree)
        } catch {
            continue // the @types package is not installed — the hop is a no-op
        }
        out.push({pkg: name, target: types})
    }
    return out
}

function main(): void {
    const statuses = CORPUS.map(treeStatus)
    const skipped = statuses.filter(s => s.kind !== 'ok')
    const usable = statuses.filter(s => s.kind === 'ok')

    let total = 0
    let stubs = 0
    let candidates = 0
    const all: RedirectRow[] = []

    for (const {tree} of usable) {
        const rows = measureTree(tree)
        const typeless = measureTypeless(tree)
        all.push(...rows)
        console.log(`\n=== ${tree}  (${listInstalled(tree).length} packages installed)`)
        if (!rows.length) console.log('  (no package redirects)')
        for (const r of rows) {
            total++
            if (r.decls === 0) stubs++
            else candidates++
            const flag = r.decls === 0 ? 'stub     ' : 'CANDIDATE'
            console.log(
                `  ${flag} ${r.pkg}@${r.version} -> ${r.target} | dts=${r.dts} | ${r.entry} | lines=${r.lines} | decls=${r.decls}`
            )
        }
        console.log(
            `  typeless->@types hops: ${typeless.length ? typeless.map(t => `${t.pkg}->${t.target}`).join(', ') : '(none)'}`
        )
    }

    console.log('\n=== SKIPPED TREES')
    for (const s of skipped) console.log(`  ${s.tree}: ${s.kind}`)

    console.log('\n=== BASE RATE')
    console.log(`  trees measured        ${usable.length}/${CORPUS.length}`)
    console.log(`  redirects fired       ${total}`)
    console.log(`  true stubs (0 decls)  ${stubs}`)
    console.log(`  CANDIDATE BUGS        ${candidates}`)
    const distinct = [...new Set(all.filter(r => r.decls > 0).map(r => `${r.pkg} -> ${r.target}`))]
    for (const d of distinct) console.log(`    ${d}`)
}

if (import.meta.main) main()
