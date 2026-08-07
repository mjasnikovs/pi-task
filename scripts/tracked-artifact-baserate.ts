/**
 * STEP 1 for nexttask 15A — how many work trees TRACK a path that
 * `git-state-guard.ts`'s ARTIFACT_PATTERNS calls regenerable output, measured per
 * pattern, BEFORE any exemption is wired into the deletion guard.
 *
 * The question this answers is narrow and it is the only one that licences the
 * split: the deletion guard rejects any tracked deletion with no same-basename
 * add. Exempting a pattern is only safe if a tracked instance of that pattern is
 * never a deliverable. `test-results/` failure screenshots regenerate on the next
 * test run; a committed `dist/` may BE the shipped artifact. That difference has
 * to be visible in the corpus, per pattern, not asserted.
 *
 * Read-only. Reuses the work-tree walker shape from
 * `scripts/env-template-closure-baserate.ts`, and its honesty rule too: N trees
 * are not N projects. Trees are grouped into FAMILIES by their root prefix so an
 * A/B harness's delivery trees — many independent RUNS of one project shape —
 * are reported as reproducibility evidence, never as breadth.
 *
 *   bun run scripts/tracked-artifact-baserate.ts
 *
 * MEASURED 2026-08-07 — and it does NOT match the numbers nexttask15.md
 * pre-registered. Both differences are recorded because both change the argument:
 *
 *     trees walked                                   269
 *     trees with .pi-tasks                           163
 *     trees tracking any ARTIFACT_PATTERNS path       33   (33 of 33 are pi-task trees)
 *
 *     by pattern:  test-results/    33 trees /  33 files
 *                  .last-run.json   33 trees /  33 files
 *                  everything else   0 trees /   0 files
 *
 *   1. `test-results/` and `.last-run.json` are NOT two independent findings.
 *      Every one of the 33 tracked `test-results/` paths IS `test-results/
 *      .last-run.json` — one file per tree, matched by two patterns. The real
 *      count is 33 trees tracking one regenerable run-state file each.
 *
 *   2. `dist/` is tracked by ZERO trees, not 15. Verified independently with a
 *      `git ls-files | grep -E '^(dist|build|\.next|\.turbo|\.svelte-kit)/'`
 *      sweep over all 273 `.git` dirs: no hits anywhere.
 *
 * WHAT THE SPLIT THEREFORE RESTS ON, restated honestly:
 *
 *   - EXEMPT `test-results/` and `.last-run.json` on MEASUREMENT. They are the
 *     only artifact paths this corpus tracks at all, and the one real episode
 *     (mx5 run 20) is exactly a tracked `test-results/` deletion.
 *   - EXEMPT `playwright-report/`, `coverage/`, `.nyc_output/`, `*.tsbuildinfo`
 *     BY CONSTRUCTION, not by measurement — zero corpus evidence either way.
 *     A coverage report, an nyc output dir, a Playwright HTML report and a
 *     tsbuildinfo incremental cache have no hand-authored form: there is no
 *     version of them that is a deliverable.
 *   - DO NOT exempt `dist/`, `build/`, `.next/`, `.turbo/`, `.svelte-kit/`. The
 *     doc justified this with "15 trees track dist/"; that count is 0 here, so
 *     the justification is now the other way round and stronger: with zero
 *     tracked instances the exemption would never fire, so it buys nothing while
 *     carrying real destructive risk — a published npm package's `dist/` IS the
 *     shipped artifact, unlike any of the six above.
 *
 * FAILURE SCREENSHOTS (`*-actual.png` / `*-diff.png`) — 0 of 269 trees track one
 * at HEAD; over full history, exactly ONE tree ever did: ~/hub/mx5, 3 files,
 * added by TASK_0027 (3e87014). n=1, and it is the lead's own run. Never quote a
 * rate off it.
 *
 * INDEPENDENCE — 32 of the 33 artifact-tracking trees are one A/B harness's
 * delivery trees built from a single mx5 DESIGN/PROJECT.md (24 under
 * ~/.cache/pi-task-env-delivery-ab, 8 under ~/.cache/pi-task-boot-skip). They are
 * 32 independent RUNS of one project shape: evidence of reproducibility, not of
 * breadth. The 33rd is mx5 itself.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const HOME = os.homedir()
const ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]
const MAX_DEPTH = 6

/**
 * The patterns under trial, named individually. This is a COPY of the list in
 * `git-state-guard.ts` deliberately: the measurement must not move when the
 * shared constant is split in STEP 2, or the numbers below stop being a
 * pre-registration.
 */
const PATTERNS: ReadonlyArray<{name: string; re: RegExp}> = [
    {name: 'test-results/', re: /^test-results\//},
    {name: 'playwright-report/', re: /^playwright-report\//},
    {name: 'coverage/', re: /^coverage\//},
    {name: '.nyc_output/', re: /^\.nyc_output\//},
    {name: 'dist/', re: /^dist\//},
    {name: 'build/', re: /^build\//},
    {name: '.next/', re: /^\.next\//},
    {name: '.turbo/', re: /^\.turbo\//},
    {name: '.svelte-kit/', re: /^\.svelte-kit\//},
    {name: '.last-run.json', re: /(?:^|\/)\.last-run\.json$/},
    {name: '*.tsbuildinfo', re: /\.tsbuildinfo$/}
]

/** A Playwright FAILURE artifact: written only when an assertion failed. */
const FAILURE_SCREENSHOT = /-(?:actual|diff)\.png$/

function git(cwd: string, args: string[]): string | null {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
    if (r.error || r.status !== 0 || typeof r.stdout !== 'string') return null
    return r.stdout
}

/** Every directory holding a `.git`, breadth-first, without descending INTO one. */
function findWorkTrees(root: string): string[] {
    const found: string[] = []
    const walk = (dir: string, depth: number): void => {
        if (depth > MAX_DEPTH) return
        let entries: fs.Dirent[]
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true})
        } catch {
            return
        }
        if (entries.some(e => e.name === '.git')) {
            found.push(dir)
            return
        }
        for (const e of entries) {
            if (!e.isDirectory() || e.isSymbolicLink()) continue
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue
            walk(path.join(dir, e.name), depth + 1)
        }
    }
    walk(root, 0)
    return found
}

const rel = (p: string): string => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p)

/**
 * The family a tree belongs to: its parent directory under a root, so the 80-odd
 * delivery trees of one A/B harness collapse into one row instead of reading as
 * 80 projects.
 */
function family(dir: string): string {
    const r = rel(dir)
    const parts = r.split('/')
    // ~/hub/mx5 → ~/hub/mx5 (a real project); ~/.cache/pi-task-x/run-7 → ~/.cache/pi-task-x
    return parts.length <= 3 ? r : parts.slice(0, 3).join('/')
}

interface TreeReport {
    dir: string
    hasPiTasks: boolean
    /** pattern name → count of tracked paths matching it */
    hits: Map<string, number>
    failureShots: string[]
}

function scanTree(dir: string): TreeReport | null {
    const ls = git(dir, ['ls-files'])
    if (ls === null) return null
    const files = ls.split('\n').filter(p => p.length > 0)
    const hits = new Map<string, number>()
    const failureShots: string[] = []
    for (const raw of files) {
        const p = raw.replace(/\\/g, '/')
        for (const {name, re} of PATTERNS) {
            if (re.test(p)) hits.set(name, (hits.get(name) ?? 0) + 1)
        }
        if (FAILURE_SCREENSHOT.test(p)) failureShots.push(p)
    }
    return {
        dir,
        hasPiTasks: fs.existsSync(path.join(dir, '.pi-tasks')),
        hits,
        failureShots
    }
}

function main(): void {
    const trees: string[] = []
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        trees.push(...findWorkTrees(root))
    }
    trees.sort()

    const reports: TreeReport[] = []
    for (const t of trees) {
        const r = scanTree(t)
        if (r) reports.push(r)
    }

    const withPiTasks = reports.filter(r => r.hasPiTasks)
    const withAny = reports.filter(r => r.hits.size > 0)
    const withAnyPi = withAny.filter(r => r.hasPiTasks)

    console.log(`scanned roots: ${ROOTS.map(rel).join(', ')} (max depth ${MAX_DEPTH})`)
    console.log('')
    console.log(`trees walked                                  ${reports.length}`)
    console.log(`trees with .pi-tasks                          ${withPiTasks.length}`)
    console.log(`trees tracking any ARTIFACT_PATTERNS path     ${withAny.length}`)
    console.log(
        `…of which are pi-task trees                   ${withAnyPi.length}   (${withAnyPi.length} of ${withAny.length})`
    )
    console.log('')
    console.log('by pattern (trees tracking ≥1 path matching it):')
    for (const {name} of PATTERNS) {
        const n = reports.filter(r => (r.hits.get(name) ?? 0) > 0).length
        const files = reports.reduce((a, r) => a + (r.hits.get(name) ?? 0), 0)
        console.log(`  ${name.padEnd(20)} ${String(n).padStart(4)} trees  ${String(files).padStart(7)} files`)
    }

    console.log('')
    console.log('BY FAMILY — trees are not projects:')
    const fams = new Map<string, {total: number; hit: number}>()
    for (const r of reports) {
        const f = family(r.dir)
        const cur = fams.get(f) ?? {total: 0, hit: 0}
        cur.total += 1
        if (r.hits.size > 0) cur.hit += 1
        fams.set(f, cur)
    }
    const ranked = [...fams.entries()].filter(([, v]) => v.hit > 0).sort((a, b) => b[1].hit - a[1].hit)
    for (const [f, v] of ranked) {
        console.log(`  ${f.padEnd(48)} ${String(v.hit).padStart(4)} of ${String(v.total).padStart(4)} trees track artifacts`)
    }

    console.log('')
    console.log('FAILURE SCREENSHOTS (*-actual.png / *-diff.png), tracked at HEAD:')
    const shot = reports.filter(r => r.failureShots.length > 0)
    if (shot.length === 0) console.log('  none')
    for (const r of shot) {
        console.log(`  ${rel(r.dir)}  ${r.failureShots.length} file(s)`)
        for (const p of r.failureShots.slice(0, 4)) console.log(`      ${p}`)
    }

    // …and over full history, because run 20's three screenshots were added by
    // TASK_0027 and then DELETED by the stranded-fix commit that followed the two
    // guard rejections — so HEAD alone hides the only episode there is.
    console.log('')
    console.log('FAILURE SCREENSHOTS ever added, over full history:')
    let everCount = 0
    for (const r of reports) {
        const out = git(r.dir, [
            'log',
            '--all',
            '--diff-filter=A',
            '--format=',
            '--name-only',
            '--',
            '*-actual.png',
            '*-diff.png'
        ])
        const n = (out ?? '').split('\n').filter(p => p.length > 0).length
        if (n === 0) continue
        everCount += 1
        console.log(`  ${rel(r.dir)}  ${n} file(s)`)
    }
    console.log(`  → ${everCount} of ${reports.length} trees. n=${everCount}: quote no rate off this.`)

    console.log('')
    console.log('WHAT THE SPLIT RESTS ON — a tracked instance of each pattern, sampled:')
    for (const {name, re} of PATTERNS) {
        const ex = reports.find(r => (r.hits.get(name) ?? 0) > 0)
        if (!ex) continue
        const ls = git(ex.dir, ['ls-files']) ?? ''
        const sample = ls
            .split('\n')
            .filter(p => re.test(p.replace(/\\/g, '/')))
            .slice(0, 2)
        console.log(`  ${name}  in ${rel(ex.dir)}`)
        for (const s of sample) console.log(`      ${s}`)
    }
}

main()
