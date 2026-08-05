/**
 * A/B for nexttask 1 — `detectTypesRedirect`'s file-count guard vs. the
 * empty-entry rule, both arms in one process over one corpus.
 *
 *     baseline    docs-resolve.ts as shipped at BASELINE_REV (git snapshot,
 *                 imported for real — not a re-implementation)
 *     treatment   the working tree: + "an entry file that declares anything of
 *                 its own is not a redirect stub"
 *
 * Pre-registered metric: for every package installed in every corpus tree, the
 * FINAL RESOLVED PACKAGE NAME after the redirect loop (docs-core.ts:275-292),
 * compared as a map. Plus, for `sharp`, the file the retrieved chunks actually
 * came from — asserted on chunk.filePath, never on a model answer.
 *
 *     PASS      sharp resolves to `sharp` in treatment and `@types/node` in
 *               baseline, AND every invariant holds.                    exit 0
 *     FAIL      sharp still misresolves, or any invariant breaks.       exit 1
 *     ABSTAIN   a node corpus tree has no node_modules installed.       exit 2
 *
 * ABSTAIN is scoped to NODE trees (a package.json with no node_modules). A tree
 * that is not a node project at all — IAR1 is C++ — carries no evidence either
 * way and is reported as skipped, not as an abstention.
 *
 * Run: bun run scripts/docs-redirect-ab.ts
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as treatment from '../src/workers/docs-resolve.js'
import {docsRaw as docsRawTreatment} from '../src/workers/docs-core.js'
import type {ResolvedPackage} from '../src/workers/docs-resolve.js'
import {CORPUS, listInstalled, treeStatus} from './docs-redirect-baserate.js'

/** The shipped commit this A/B's baseline arm is pinned to (v0.29.0). Pinned, not
 *  `HEAD`, so the comparison stays reproducible after the treatment lands. */
const BASELINE_REV = 'f9a52e8f8cb7743d289b16ca0a5db1c06ca02b5a'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Where the docs worker auto-installs hop targets (docs-core.ts getDocsModulesDir). */
const INSTALL_CACHE = path.join(
    process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), '.cache'),
    'pi-worker',
    'docs-modules'
)

interface ResolveArm {
    resolvePackage(name: string, cwd: string): ResolvedPackage
    detectTypesRedirect(pkg: ResolvedPackage): string | null
    hasTypeFiles(root: string): boolean
    typesPackageName(name: string): string | null
}

/** Materialise the baseline arm: the two modules as they exist at BASELINE_REV,
 *  with their relative imports rewritten to absolute paths into the working tree
 *  so every collaborator (cache, index, retrieve) stays shared between arms and
 *  only docs-resolve differs. */
function materialiseBaseline(dir: string): {resolvePath: string; corePath: string} {
    fs.mkdirSync(dir, {recursive: true})
    const show = (file: string): string =>
        execFileSync('git', ['show', `${BASELINE_REV}:${file}`], {cwd: REPO, encoding: 'utf8'})

    const resolvePath = path.join(dir, 'docs-resolve.ts')
    fs.writeFileSync(resolvePath, show('src/workers/docs-resolve.ts'))

    const core = show('src/workers/docs-core.ts')
        .replace(/from '\.\/docs-resolve\.js'/g, `from '${resolvePath.replace(/\.ts$/, '.js')}'`)
        .replace(/from '\.\/([\w-]+)\.js'/g, `from '${REPO}/src/workers/$1.js'`)
        .replace(/from '\.\.\/([\w-]+)\/([\w-]+)\.js'/g, `from '${REPO}/src/$1/$2.js'`)
    const corePath = path.join(dir, 'docs-core.ts')
    fs.writeFileSync(corePath, core)

    return {resolvePath, corePath}
}

/** The redirect loop of docs-core.ts:275-292, with the arm's predicate injected.
 *
 *  The shipped loop hops through `tryResolveOrInstall`, which npm-installs a hop
 *  target that the project does not have — that is how `sharp -> node` reaches
 *  `@types/node`: npm's junk `node` package installs, ships no declarations, and
 *  the `!hasTypeFiles` branch then redirects it to `@types/node`. Installing
 *  inside an A/B would make it non-deterministic and would write to the network,
 *  so the hop resolves from the docs worker's own install cache instead (the same
 *  directory the shipped path installs into, already populated by run 19). A hop
 *  that resolves NOWHERE is reported as `(needs-install:X)` rather than silently
 *  collapsing to "no redirect happened". */
function resolveTypeSource(arm: ResolveArm, requested: string, cwd: string): string {
    let cur: ResolvedPackage
    try {
        cur = arm.resolvePackage(requested, cwd)
    } catch {
        return '(unresolved)'
    }
    const visited = new Set<string>([cur.name, parentOf(requested)])
    for (let depth = 0; depth < 3; depth++) {
        let next = arm.detectTypesRedirect(cur)
        if (next && visited.has(next)) next = null
        if (!next && !arm.hasTypeFiles(cur.root)) {
            const types = arm.typesPackageName(cur.name)
            if (types && !visited.has(types)) next = types
        }
        if (!next) break
        visited.add(next)
        let resolved: ResolvedPackage | null = null
        for (const from of [cwd, INSTALL_CACHE]) {
            try {
                resolved = arm.resolvePackage(next, from)
                break
            } catch {
                /* try the next source */
            }
        }
        if (!resolved) return `(needs-install:${next})`
        cur = resolved
    }
    return cur.name
}

function parentOf(name: string): string {
    if (name.startsWith('@')) return name.split('/').slice(0, 2).join('/')
    return name.split('/')[0]
}

type Map_ = Record<string, string>

function resolutionMap(arm: ResolveArm, tree: string, packages: string[]): Map_ {
    const out: Map_ = {}
    for (const name of packages) out[name] = resolveTypeSource(arm, name, tree)
    return out
}

interface Invariant {
    name: string
    ok: boolean
    detail: string
}

function main(): Promise<void> | void {
    return run()
}

async function run(): Promise<void> {
    const statuses = CORPUS.map(treeStatus)
    const abstain = statuses.filter(s => s.kind === 'uninstalled')
    const skipped = statuses.filter(s => s.kind === 'not-a-node-tree')
    const trees = statuses.filter(s => s.kind === 'ok').map(s => s.tree)

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-redirect-ab-'))
    const {resolvePath, corePath} = materialiseBaseline(work)
    const baseline = (await import(resolvePath)) as unknown as ResolveArm
    const baselineDocsRaw = ((await import(corePath)) as {docsRaw: typeof docsRawTreatment}).docsRaw

    const maps: {tree: string; base: Map_; treat: Map_}[] = []
    for (const tree of trees) {
        const packages = listInstalled(tree)
        maps.push({
            tree,
            base: resolutionMap(baseline, tree, packages),
            treat: resolutionMap(treatment as unknown as ResolveArm, tree, packages)
        })
    }

    // ---- the map diff -----------------------------------------------------
    const changed: {tree: string; pkg: string; base: string; treat: string}[] = []
    for (const m of maps) {
        for (const pkg of Object.keys(m.base)) {
            if (m.base[pkg] !== m.treat[pkg])
                changed.push({tree: m.tree, pkg, base: m.base[pkg], treat: m.treat[pkg]})
        }
    }
    console.log(`=== RESOLUTION MAP DIFF (${changed.length} packages changed)`)
    const byChange = new Map<string, number>()
    for (const c of changed) {
        const key = `${c.pkg}: ${c.base} -> ${c.treat}`
        byChange.set(key, (byChange.get(key) ?? 0) + 1)
    }
    for (const [key, n] of [...byChange.entries()].sort()) console.log(`  x${n}  ${key}`)

    // ---- the headline: sharp, through the OFFLINE map ----------------------
    const sharpTrees = maps.filter(m => m.base.sharp !== undefined)
    console.log(`\n=== SHARP — offline resolution map (${sharpTrees.length} trees have it)`)
    for (const m of sharpTrees)
        console.log(`  ${m.tree}: baseline=${m.base.sharp} treatment=${m.treat.sharp}`)

    // ---- invariants --------------------------------------------------------
    const inv: Invariant[] = []

    const bunChain = maps.filter(m => m.base['@types/bun'] !== undefined || m.base.bun !== undefined)
    const bunBad = bunChain.filter(
        m => m.base['@types/bun'] !== m.treat['@types/bun'] || m.base.bun !== m.treat.bun
    )
    inv.push({
        name: 'inv-bun-chain-kept',
        ok: bunChain.length > 0 && bunBad.length === 0,
        detail:
            bunChain.length === 0 ?
                'no tree has bun installed — nothing measured'
            :   bunChain
                    .map(
                        m =>
                            `${path.basename(m.tree)}: @types/bun ${m.base['@types/bun']}->${m.treat['@types/bun']}, bun ${m.base.bun}->${m.treat.bun}`
                    )
                    .join('; ')
    })

    const reactTrees = maps.filter(m => m.base.react !== undefined)
    const reactBad = reactTrees.filter(
        m => m.base.react !== m.treat.react || m.base['react-dom'] !== m.treat['react-dom']
    )
    inv.push({
        name: 'inv-typeless-kept',
        ok: reactTrees.length > 0 && reactBad.length === 0,
        detail:
            reactTrees.length === 0 ?
                'no tree has react installed — nothing measured'
            :   reactTrees
                    .map(
                        m =>
                            `${path.basename(m.tree)}: react=${m.treat.react}, react-dom=${m.treat['react-dom']}`
                    )
                    .join('; ')
    })

    // A redirect exists when the loop moved the package somewhere else.
    const newRedirects = changed.filter(c => c.base === c.pkg && c.treat !== c.pkg)
    inv.push({
        name: 'inv-no-new-redirects',
        ok: newRedirects.length === 0,
        detail:
            newRedirects.length === 0 ?
                'treatment only ever removes a redirect'
            :   newRedirects.map(c => `${c.pkg}: ${c.base}->${c.treat}`).join(', ')
    })

    // ---- the headline + inv-retrieval-improves: real docsRaw, both arms ----
    // Judged on the SHIPPED path, not on the offline map: docsRaw is what run 19
    // ran, chunk.filePath is what the model was shown, and pkg.name is the final
    // resolution the redirect loop actually reached.
    const sharpTree = sharpTrees[0]?.tree
    let retrievalDetail = 'sharp not installed in any corpus tree'
    let retrievalOk = false
    let sharpBaseOk = false
    let sharpTreatOk = false
    if (sharpTree) {
        const query = 'resize webp rotate'
        const noNetwork = {
            pkg: 'sharp',
            query,
            cwd: sharpTree,
            autoInstall: false,
            npmVersionLookup: () => Promise.resolve(null)
        } as Parameters<typeof docsRawTreatment>[0]
        type Raw = {kind: string; pkg?: {name: string}; chunks?: {filePath: string}[]}
        const b = (await baselineDocsRaw(noNetwork)) as Raw
        const t = (await docsRawTreatment(noNetwork)) as Raw
        // chunk.filePath is stored RELATIVE to the resolved package root
        // (docs-index.ts:160), so the package name is the other half of the fact.
        const files = (r: Raw): string[] =>
            r.kind === 'ok' ? [...new Set((r.chunks ?? []).map(c => c.filePath))] : []
        const bf = files(b)
        const tf = files(t)
        sharpBaseOk = b.pkg?.name === '@types/node'
        sharpTreatOk = t.pkg?.name === 'sharp'
        retrievalOk =
            sharpBaseOk &&
            sharpTreatOk &&
            bf.length > 0 &&
            tf.length > 0 &&
            tf.some(f => f === 'lib/index.d.ts')
        console.log(`\n=== SHARP — shipped docsRaw path (${sharpTree})`)
        console.log(`  baseline  pkg=${b.pkg?.name}@${(b.pkg as {version?: string})?.version}`)
        console.log(`            chunks: ${bf.join(', ') || '(none)'}`)
        console.log(`  treatment pkg=${t.pkg?.name}@${(t.pkg as {version?: string})?.version}`)
        console.log(`            chunks: ${tf.join(', ') || '(none)'}`)
        retrievalDetail =
            `baseline ${b.pkg?.name}:[${bf.join(' ')}] | treatment ${t.pkg?.name}:[${tf.join(' ')}]`
    }
    inv.push({name: 'inv-retrieval-improves', ok: retrievalOk, detail: retrievalDetail})

    // ---- inv-degrade-safe --------------------------------------------------
    const missingEntry: ResolvedPackage = {
        name: 'ghost',
        version: '0.0.0',
        root: path.join(work, 'no-such-package'),
        entryDts: path.join(work, 'no-such-package', 'index.d.ts'),
        readme: null
    }
    const unreadableRoot = path.join(work, 'unreadable')
    fs.mkdirSync(unreadableRoot, {recursive: true})
    fs.mkdirSync(path.join(unreadableRoot, 'index.d.ts'), {recursive: true}) // a DIR where a file is expected
    const unreadable: ResolvedPackage = {
        name: 'unreadable',
        version: '0.0.0',
        root: unreadableRoot,
        entryDts: path.join(unreadableRoot, 'index.d.ts'),
        readme: null
    }
    const degradeOk =
        treatment.detectTypesRedirect(missingEntry) === null &&
        treatment.detectTypesRedirect(unreadable) === null &&
        baseline.detectTypesRedirect(missingEntry) === null &&
        baseline.detectTypesRedirect(unreadable) === null
    inv.push({
        name: 'inv-degrade-safe',
        ok: degradeOk,
        detail: 'absent entry file and unreadable entry file both return null in both arms'
    })

    console.log('\n=== INVARIANTS')
    for (const i of inv) console.log(`  ${i.ok ? 'HOLD ' : 'BREAK'} ${i.name} — ${i.detail}`)

    // ---- observation (not a pass criterion): the split-surface case --------
    reportSplitSurface(maps, baseline)

    console.log('\n=== TREES')
    console.log(`  measured: ${trees.length}`)
    for (const s of skipped) console.log(`  skipped (not a node project): ${s.tree}`)
    for (const s of abstain) console.log(`  ABSTAIN (node project, not installed): ${s.tree}`)

    fs.rmSync(work, {recursive: true, force: true})

    if (abstain.length) {
        console.log('\nVERDICT: ABSTAIN — a node corpus tree has no node_modules')
        process.exit(2)
    }
    const invOk = inv.every(i => i.ok)
    if (!sharpBaseOk || !sharpTreatOk || !invOk) {
        console.log(
            `\nVERDICT: FAIL — sharp baseline=@types/node:${sharpBaseOk} treatment=sharp:${sharpTreatOk}, invariants ${invOk ? 'held' : 'BROKE'}`
        )
        process.exit(1)
    }
    console.log('\nVERDICT: PASS')
}

/** Not pre-registered and not a gate: the packages whose pointer target holds a
 *  BIGGER surface than their own entry (the `@types/express` ->
 *  `express-serve-static-core` shape). Reported so the trade-off the empty-entry
 *  rule makes is on the record with numbers instead of being assumed away. */
function reportSplitSurface(
    maps: {tree: string; base: Map_; treat: Map_}[],
    baseline: ResolveArm
): void {
    console.log('\n=== OBSERVATION: split-surface packages (informational, not a gate)')
    const seen = new Set<string>()
    for (const m of maps) {
        for (const pkg of Object.keys(m.base)) {
            if (m.base[pkg] === m.treat[pkg]) continue
            if (seen.has(pkg)) continue
            seen.add(pkg)
            const target = /^\(needs-install:(.+)\)$/.exec(m.base[pkg])?.[1] ?? m.base[pkg]
            if (target === '@types/node') continue
            const own = entryLines(tryResolve(baseline, pkg, m.tree))
            const tgt = entryLines(tryResolve(baseline, target, m.tree))
            if (tgt > own)
                console.log(
                    `  ${pkg}: own entry ${own} lines vs baseline target ${target} ${tgt} lines` +
                        (tgt > own * 2 ? '  <- baseline reached the bigger surface' : '')
                )
        }
    }
}

function tryResolve(arm: ResolveArm, name: string, cwd: string): ResolvedPackage | null {
    for (const from of [cwd, INSTALL_CACHE]) {
        try {
            return arm.resolvePackage(name, from)
        } catch {
            /* try the next source */
        }
    }
    return null
}

function entryLines(pkg: ResolvedPackage | null): number {
    if (!pkg?.entryDts) return 0
    try {
        return fs.readFileSync(pkg.entryDts, 'utf8').split('\n').length
    } catch {
        return 0
    }
}

if (import.meta.main) await main()
