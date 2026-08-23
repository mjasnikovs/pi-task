/**
 * STEP 0 for nexttask 1-1 — how many `npm install`s the redirect loop's HOP fires,
 * and what fraction of them ever produce usable declarations.
 *
 * VERDICT (2026-08-05, two runs): the lead is REFUTED and no lever was built. Of
 * 947 hop-installs across 6 corpus trees, 634 (66.9%) install a package that
 * really ships declarations, and only **4** sit under a direct dependency — the
 * only kind of package a docs lookup ever names. Replayed against run 19's own
 * logs (`docs-hop-replay.ts`, 500 lookups) the hop fires **0** times. Kept as the
 * regression net: if a change ever makes the hop reachable, these numbers move.
 * Full write-up in VALIDATION-DEBT.md, "RULED OUT".
 *
 * The shipped loop (`resolveTypeSource`, docs-core.ts:284-308) hops to a better
 * type source and reaches it through `tryResolveOrInstall` (:259-278), which
 * resolves from the project tree and, on `not_installed`, runs a real
 * `npm install` into the machine-shared docs cache. Nothing records a miss, so a
 * hop whose target does not exist on npm at all pays a full registry round trip
 * on every lookup, forever.
 *
 * Three phases, in order of cost:
 *
 *   1. WALK   (read-only)  every package in every corpus tree through the shipped
 *                          loop, resolving locally only; every hop target that
 *                          misses locally is one `npm install` the shipped path
 *                          would fire. Branch is recorded: `redirect-stub`
 *                          (detectTypesRedirect) or `typeless-@types`.
 *   2. EXIST  (registry)   one `npmVersionLookup` per DISTINCT hop target — the
 *                          same client the docs path already uses, no second one.
 *   3. INSTALL (registry)  for every distinct target that EXISTS, the shipped
 *                          `runAutoInstall` into a throwaway cache, timed, then
 *                          `resolvePackage` + `hasTypeFiles` on the result. This
 *                          is the pre-registered question: of the hops, what
 *                          fraction ever produce usable declarations?
 *
 * The install probe redirects `XDG_CACHE_HOME` at a temp dir before importing
 * docs-core, so `getDocsModulesDir()` points at the throwaway and the machine's
 * real 94-dep docs cache is neither read nor written. Corpus trees are read-only.
 *
 * A miss (target absent from npm) is timed on a SAMPLE — `MISS_SAMPLE` targets —
 * because every miss is the same E404 round trip and the population is large.
 *
 * The registry is the one non-deterministic input: run this TWICE and report both
 * tables.
 *
 * Run: bun run scripts/docs-hop-install-baserate.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Created in main(), never at import time: `walk` is imported by other scripts,
// and merely importing this module must not redirect their cache or leave a temp
// dir behind. Set before any getDocsModulesDir() call so the install probe cannot
// touch the real machine-shared docs cache.
let PROBE_CACHE = ''

const {spawn} = await import('node:child_process')
const {runAutoInstall, extractParentPackage} = await import('../src/workers/docs-core.js')
const {
    detectTypesRedirect,
    hasTypeFiles,
    resolvePackage,
    typesPackageName,
    ResolveError
} = await import('../src/workers/docs-resolve.js')
type ResolvedPackage = import('../src/workers/docs-resolve.js').ResolvedPackage
const {npmVersionLookup} = await import('../src/workers/npm-version.js')
const {CORPUS, listInstalled, treeStatus} = await import('./docs-redirect-baserate.js')

/** How many absent-from-npm targets get a timed install attempt. */
const MISS_SAMPLE = Number(process.env.MISS_SAMPLE ?? 10)

type Branch = 'redirect-stub' | 'typeless-@types'

export interface Hop {
    tree: string
    pkg: string
    target: string
    branch: Branch
    /** hop index within this package's walk (0 = first hop) */
    depth: number
}

/** The shipped redirect loop with LOCAL-ONLY resolution. Every hop target that
 *  fails to resolve from the tree is one `npm install` the shipped path fires;
 *  the walk stops there, because what happens after the install depends on what
 *  the install produced (phase 3 answers that). */
export function walk(tree: string, requested: string): {hops: Hop[]; stoppedAtInstall: boolean} {
    const hops: Hop[] = []
    let cur: ResolvedPackage
    try {
        cur = resolvePackage(requested, tree)
    } catch {
        return {hops, stoppedAtInstall: false}
    }
    const visited = new Set<string>([cur.name, extractParentPackage(requested)])
    for (let depth = 0; depth < 3; depth++) {
        let next = detectTypesRedirect(cur)
        let branch: Branch = 'redirect-stub'
        if (next && visited.has(next)) next = null
        if (!next && !hasTypeFiles(cur.root)) {
            const types = typesPackageName(cur.name)
            if (types && !visited.has(types)) {
                next = types
                branch = 'typeless-@types'
            }
        }
        if (!next) break
        visited.add(next)
        let resolved: ResolvedPackage
        try {
            resolved = resolvePackage(next, tree)
        } catch (err) {
            // Only `not_installed` reaches runAutoInstall in the shipped path
            // (tryResolveOrInstall returns null on anything else).
            if (err instanceof ResolveError && err.kind === 'not_installed') {
                hops.push({tree, pkg: requested, target: next, branch, depth})
                return {hops, stoppedAtInstall: true}
            }
            return {hops, stoppedAtInstall: false}
        }
        cur = resolved
    }
    return {hops, stoppedAtInstall: false}
}

/** Names in a tree's own package.json dependencies/devDependencies/peerDependencies. */
function declaredDeps(tree: string): Set<string> {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8')) as Record<
            string,
            Record<string, string> | undefined
        >
        return new Set([
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
            ...Object.keys(pkg.peerDependencies ?? {})
        ])
    } catch {
        return new Set()
    }
}

interface TargetFact {
    target: string
    hops: number
    branches: Set<Branch>
    existsOnNpm: boolean | null
    latest?: string
    installOk?: boolean
    installMs?: number
    /** after a successful install: does the resolved package ship declarations? */
    shipsTypes?: boolean
    resolvedAs?: string
}

async function main(): Promise<void> {
    PROBE_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-hop-probe-'))
    process.env.XDG_CACHE_HOME = PROBE_CACHE
    const statuses = CORPUS.map(treeStatus)
    const trees = statuses.filter(s => s.kind === 'ok').map(s => s.tree)
    const abstain = statuses.filter(s => s.kind === 'uninstalled')
    const skipped = statuses.filter(s => s.kind === 'not-a-node-tree')

    // ---- phase 1: WALK -----------------------------------------------------
    const hops: Hop[] = []
    let walked = 0
    let directWalked = 0
    let directHops = 0
    for (const tree of trees) {
        const packages = listInstalled(tree)
        const direct = declaredDeps(tree)
        walked += packages.length
        directWalked += packages.filter(p => direct.has(p)).length
        let treeHops = 0
        let treeDirect = 0
        for (const name of packages) {
            const r = walk(tree, name)
            hops.push(...r.hops)
            treeHops += r.hops.length
            if (direct.has(name)) treeDirect += r.hops.length
        }
        directHops += treeDirect
        console.log(
            `=== ${tree}  packages=${packages.length}  install-hops=${treeHops}` +
                `  (direct deps: ${packages.filter(p => direct.has(p)).length}, their hops: ${treeDirect})`
        )
    }
    console.log(`\n=== WALK`)
    console.log(`  packages walked                 ${walked}   (${trees.length} trees)`)
    console.log(`  hop targets that would install  ${hops.length}   (${pct(hops.length, walked)})`)
    for (const b of ['redirect-stub', 'typeless-@types'] as Branch[]) {
        const n = hops.filter(h => h.branch === b).length
        console.log(`    ${b.padEnd(16)} ${n}`)
    }
    // The denominator that matters. A docs lookup is issued for a package the SPEC
    // names — a direct dependency — never for a transitive one, so a hop under a
    // transitive package is a cost no workload can actually pay.
    console.log(`  direct deps walked              ${directWalked}`)
    console.log(`  their hops                      ${directHops}   (${pct(directHops, hops.length)} of all hops)`)

    // ---- distinct targets ---------------------------------------------------
    const byTarget = new Map<string, TargetFact>()
    for (const h of hops) {
        let f = byTarget.get(h.target)
        if (!f) {
            f = {target: h.target, hops: 0, branches: new Set(), existsOnNpm: null}
            byTarget.set(h.target, f)
        }
        f.hops++
        f.branches.add(h.branch)
    }
    const targets = [...byTarget.values()].sort((a, b) => b.hops - a.hops || a.target.localeCompare(b.target))
    console.log(`  distinct hop targets            ${targets.length}`)
    if (process.env.WALK_ONLY === '1') {
        for (const t of targets.slice(0, 40))
            console.log(`    x${String(t.hops).padStart(3)}  ${t.target}  [${[...t.branches].join('+')}]`)
        fs.rmSync(PROBE_CACHE, {recursive: true, force: true})
        return
    }

    // ---- phase 2: EXIST -----------------------------------------------------
    console.log(`\n=== EXIST (npmVersionLookup, ${targets.length} distinct targets)`)
    let probeFailures = 0
    for (const t of targets) {
        const info = await npmVersionLookup(t.target, {timeoutMs: 10_000})
        t.existsOnNpm = info !== null
        t.latest = info?.latest
        if (info === null) probeFailures++
    }
    const present = targets.filter(t => t.existsOnNpm)
    const absent = targets.filter(t => !t.existsOnNpm)
    console.log(`  exist on npm      ${present.length} distinct  / ${sumHops(present)} hops`)
    console.log(`  absent from npm   ${absent.length} distinct  / ${sumHops(absent)} hops`)

    // ---- phase 3: INSTALL ---------------------------------------------------
    // Every target that exists gets a real timed install; absent targets are a
    // uniform E404 and are sampled.
    const toInstall = [...present, ...absent.slice(0, MISS_SAMPLE)]
    console.log(
        `\n=== INSTALL (${toInstall.length} probes: ${present.length} present + ${Math.min(MISS_SAMPLE, absent.length)}/${absent.length} absent sampled)`
    )
    for (const t of toInstall) {
        // A fresh cache per target: isolates the per-hop cost and stops one
        // package's peer-dep tree from deciding another's answer.
        const cache = fs.mkdtempSync(path.join(PROBE_CACHE, 'c-'))
        process.env.XDG_CACHE_HOME = cache
        const t0 = Date.now()
        const res = await runAutoInstall(spawn as never, t.target)
        t.installMs = Date.now() - t0
        t.installOk = res.success
        if (res.success) {
            try {
                const pkg = resolvePackage(t.target, res.installDir)
                t.resolvedAs = `${pkg.name}@${pkg.version}`
                t.shipsTypes = hasTypeFiles(pkg.root) || pkg.entryDts !== null
            } catch {
                t.resolvedAs = '(unresolved after install)'
                t.shipsTypes = false
            }
        } else {
            t.shipsTypes = false
        }
        fs.rmSync(cache, {recursive: true, force: true})
    }

    // ---- the pre-registered answer -----------------------------------------
    const usableDistinct = toInstall.filter(t => t.shipsTypes)
    const usableHops = sumHops(usableDistinct)
    console.log(`\n=== TABLE  (target | hops | branch | on npm | installs | ships .d.ts | ms)`)
    for (const t of targets) {
        const probed = t.installOk !== undefined
        console.log(
            `  ${t.target.padEnd(34)} x${String(t.hops).padStart(3)}  ${[...t.branches].join('+').padEnd(16)}` +
                ` npm=${t.existsOnNpm ? 'yes' : 'NO '}` +
                ` install=${probed ? (t.installOk ? 'ok ' : 'FAIL') : '-   '}` +
                ` types=${probed ? (t.shipsTypes ? 'YES' : 'no ') : '-  '}` +
                ` ${probed ? `${t.installMs}ms` : ''}` +
                (t.resolvedAs ? `  ${t.resolvedAs}` : '')
        )
    }

    const missMs = toInstall.filter(t => !t.existsOnNpm).map(t => t.installMs!)
    const hitMs = toInstall.filter(t => t.existsOnNpm).map(t => t.installMs!)
    console.log(`\n=== ANSWER — of the ${hops.length} hop installs, what fraction is useful?`)
    console.log(`  hops producing usable declarations   ${usableHops} / ${hops.length}  (${pct(usableHops, hops.length)})`)
    console.log(`  hops that can NEVER produce any      ${hops.length - usableHops}  (${pct(hops.length - usableHops, hops.length)})`)
    console.log(`    of those, target absent from npm   ${sumHops(absent)}`)
    console.log(`    of those, installs but no types    ${sumHops(present.filter(t => !t.shipsTypes))}`)
    console.log(`  registry-probe nulls (exists=NO)     ${probeFailures}`)
    console.log(`\n=== WALL CLOCK (per install, fresh cache)`)
    console.log(`  miss  n=${missMs.length}  mean=${mean(missMs)}ms  min=${min(missMs)}  max=${max(missMs)}`)
    console.log(`  hit   n=${hitMs.length}  mean=${mean(hitMs)}ms  min=${min(hitMs)}  max=${max(hitMs)}`)
    console.log(
        `  projected total for ${hops.length} hops        ${fmtSec(sumHops(absent) * mean(missMs) + sumHops(present) * mean(hitMs))}`
    )

    console.log('\n=== TREES')
    console.log(`  measured: ${trees.length}`)
    for (const s of skipped) console.log(`  skipped (not a node project): ${s.tree}`)
    for (const s of abstain) console.log(`  ABSTAIN (node project, not installed): ${s.tree}`)

    fs.rmSync(PROBE_CACHE, {recursive: true, force: true})

    if (abstain.length) process.exit(2)
    // The registry client returns null on network failure too — an all-null probe
    // is unreachability, not a corpus of nonexistent packages.
    if (present.length === 0 && targets.length > 0) {
        console.log('\nABSTAIN — every registry probe returned null (registry unreachable?)')
        process.exit(2)
    }
}

const sumHops = (ts: TargetFact[]): number => ts.reduce((n, t) => n + t.hops, 0)
const pct = (n: number, d: number): string => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`)
const mean = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0)
const min = (xs: number[]): number => (xs.length ? Math.min(...xs) : 0)
const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : 0)
const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(0)}s`

if (import.meta.main) await main()
