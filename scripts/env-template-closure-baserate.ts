/**
 * STEP 0 for nexttask 10 — how often does a tracked env template omit a variable
 * tracked source REQUIRES, measured BEFORE the check is wired into any gate.
 *
 * VERDICT (2026-08-05): the rule is usable, the pre-registered close condition is
 * NOT met, and the corpus is deeper than the doc's two trees but no wider in
 * INDEPENDENT projects — which is stated here rather than glossed.
 *
 *   188 git work trees under ~/hub, ~/tmp, ~/.cache; 123 track an env template.
 *   82 findings across 41 trees (33.3%), naming exactly 2 variables:
 *   ADMIN_PHONE ×41 and ADMIN_PASSWORD ×41.
 *
 *   BY FAMILY — 123 trees are not 123 projects:
 *     ~/tmp/owned-freeze-delivered   40 trees   40 fire   pipeline DELIVERIES
 *     ~/hub/mx5                       1 tree     1 fires  THE LEAD
 *     ~/tmp/owned-freeze-ab          81 trees    0 fire   same spec, template COMPLETE
 *     ~/hub/dace-pro                  1 tree     0 fires  human-authored, 13 declared
 *
 *   The 81-vs-41 split is the useful part: same spec family, same three required
 *   variables, and the trees whose `.env.example` declares all three are silent
 *   while the deliveries that declare two are not. The check discriminates
 *   WITHIN a family rather than firing on a family shape.
 *
 *   HISTORY (same rules, evaluated per commit via `git ls-tree`/`git show`, no
 *   checkout): mx5 carries the defect in 12 of 12 sampled commits (be86e4f →
 *   dfbdd6f, the template growing 1→2 declared while the requirement stayed 2);
 *   dace-pro is clean in 12 of 12 (4→13 declared as it grew).
 *
 *   CLOSE CONDITION — "the missing var is genuinely supplied by CI/compose/
 *   secrets" — NOT MET. Every finding's variable was searched for across the rest
 *   of the tracked tree: none appears in a workflow, compose file, or Dockerfile.
 *   They appear in `DESIGN/PROJECT.md` and `.pi-tasks/TASK_*.md` — i.e. the run
 *   KNEW about them and the template still omitted them.
 *
 *   INDEPENDENCE, stated plainly: every positive comes from one spec family, and
 *   the only independent human-authored project carrying a template (dace-pro) is
 *   clean. The FP burden is therefore carried by the template-LESS trees below,
 *   where the rules meet unrehearsed code.
 *
 * SIX INSTRUMENT CORRECTIONS, each demanded by a hand-read of a real read site,
 * and the reason this section exists at all (`memory/rescue-arm-failed-grounding`
 * — the instrument is the thing to fix first):
 *
 *   1. a `\bEnv\b` prefilter silently dropped EVERY Go file (`os.Getenv` has no
 *      word boundary before `env`) — caught by the go fixture, not by the corpus.
 *   2. `os.Getenv("X") == ""` — the operator sits past the call's closing paren,
 *      so Go's own defaulting idiom read as required.
 *   3. `Number(process.env.RAG_BATCH) || 32` (gofer-rag) — the default sits past
 *      a WRAPPING call's paren.
 *   4. `process.env.PI_REMOTE_PUSH_LOG?.trim() || '/tmp/…'` — past an accessor
 *      chain; and `A ?? process.env.BRAVE_API_KEY`, where the read IS the default.
 *   5. `delete process.env.GOFER_GDFORMAT` (gofer) and the test save/restore
 *      idiom (`prev = process.env.X` in a file that also assigns it) are WRITES.
 *   6. presence probes: `if (process.env.PI_BIN)`, `const c =
 *      process.env.CHROME_BIN; if (c)`, and — the discriminator that keeps the
 *      lead — `if (!x) return` vs mx5's `if (!phone) throw`. A negated guard
 *      means REQUIRED only when the program stops.
 *   Plus rule 4 by MECHANISM: `npm_*`, `GITHUB_*`, `XDG_*`, `RUNNER_*`, `CI_*`
 *      are platform-injected and belong in no template.
 *
 *   Effect on this repo's own tree: 47 "required" reads → 0. On gofer: 10 → 2,
 *   both of which are genuine (`if (!process.env.GOFER_GODOT_BINARY) throw`).
 *   Effect on the 82 findings: ZERO. Every correction removed noise elsewhere and
 *   left the lead untouched — which is what makes the 82 worth believing.
 *
 *   RESIDUE, disclosed: gofer-rag's `scripts/test-package.mjs:50` reads
 *   `process.env.GOFER_RAG_CACHE_DIR` inside a STRING LITERAL of generated source.
 *   Deciding that needs a parser, not a line scanner; it is one read in a
 *   template-less tree, and no rule was added for it.
 *
 * The doc's first pass was two trees (mx5, dace-pro) and explicitly said the task
 * must not be wired on it. This widens to every git work tree under `~/hub`,
 * `~/tmp` and `~/.cache` that TRACKS an env template — which includes the many
 * pi-task-DELIVERED trees left behind by earlier A/B runs, i.e. the population the
 * gate would actually run on — plus the git HISTORY of the long-lived repos, plus
 * synthetic non-JS trees (`os.environ[…]`, `os.Getenv(…)`) so the rule is shown
 * not to be npm-shaped (`memory/gate-blind-on-non-npm-projects.md`).
 *
 * Three things are reported, because three different claims are on trial:
 *
 *   FINDINGS   every MISSING var with its read site — the defect rate.
 *   STEP-ASIDE the histogram of reads the four rules excluded, so the rules can be
 *              hand-read rather than trusted. The doc names rule 3 (assignment
 *              target, mx5's seven test files) as the largest FP source; this
 *              prints whether that holds corpus-wide.
 *   SUPPLY     for every finding, whether the var is named anywhere ELSE in the
 *              tracked tree (CI workflow, compose file, Dockerfile, README, …).
 *              This is the pre-registered close condition: if findings are
 *              routinely vars CI supplies, the FP class is real and the task
 *              closes or needs a fifth exclusion.
 *
 * Read-only. No tree is written to, and no VALUE from any env file is ever printed
 * — only variable NAMES (`.env` secrets are the canonical case; see nexttask 4's
 * `inv-no-secret-echo`).
 *
 *     bun run scripts/env-template-closure-baserate.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    AMBIENT_ENV,
    ENV_TEMPLATE_NAMES,
    parseTemplate,
    scanEnvTemplateClosure,
    scanSource,
    type EnvRead,
    type StepAside
} from '../src/task/env-template-closure.js'

const HOME = os.homedir()
const ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]
/** Depth from each root at which we stop looking for work trees. */
const MAX_DEPTH = 6

function git(cwd: string, args: string[]): string | null {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024})
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
            return // a work tree is a leaf: submodules are its business, not ours
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

interface TreeReport {
    label: string
    dir: string
    templates: string[]
    declared: number
    required: number
    missing: EnvRead[]
    aside: Map<StepAside, number>
}

/** Where else in the tracked tree the name appears — the CI-supplies-it question. */
function supplySites(dir: string, name: string): string[] {
    const out = git(dir, ['grep', '-l', '-F', '-e', name, '--', '.'])
    if (out === null) return []
    return out
        .split('\n')
        .filter(p => p.length > 0)
        .filter(p => !/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$/i.test(p))
        .filter(p => !ENV_TEMPLATE_NAMES.includes(path.posix.basename(p)))
        .slice(0, 6)
}

function tally(reads: EnvRead[]): Map<StepAside, number> {
    const m = new Map<StepAside, number>()
    for (const r of reads) {
        if (r.stepAside === null) continue
        m.set(r.stepAside, (m.get(r.stepAside) ?? 0) + 1)
    }
    return m
}

function reportTree(dir: string): TreeReport | null {
    const c = scanEnvTemplateClosure(dir)
    if (c.templates.length === 0) return null
    return {
        label: rel(dir),
        dir,
        templates: c.templates,
        declared: c.declared.size,
        required: c.reads.filter(r => r.stepAside === null).length,
        missing: c.missing,
        aside: tally(c.reads)
    }
}

// ── history mode: evaluate the SAME rules at past commits, without a checkout ──

interface HistoryPoint {
    rev: string
    date: string
    declared: number
    required: number
    missing: EnvRead[]
}

function scanCommit(dir: string, rev: string): HistoryPoint | null {
    const listing = git(dir, ['ls-tree', '-r', '--name-only', rev])
    if (listing === null) return null
    const files = listing.split('\n').filter(p => p.length > 0)
    const templates = files.filter(p => ENV_TEMPLATE_NAMES.includes(path.posix.basename(p)))
    if (templates.length === 0) return null
    const declared = new Set<string>()
    for (const t of templates) {
        const text = git(dir, ['show', `${rev}:${t}`])
        if (text !== null) for (const n of parseTemplate(text)) declared.add(n)
    }
    const reads: EnvRead[] = []
    for (const f of files) {
        if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$/i.test(f)) continue
        if (/(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|\.next|\.output)\//.test(f))
            continue
        const text = git(dir, ['show', `${rev}:${f}`])
        if (text === null || !/env/i.test(text)) continue
        reads.push(...scanSource(f, text))
    }
    const date = (git(dir, ['show', '-s', '--format=%cs', rev]) ?? '').trim()
    return {
        rev: rev.slice(0, 7),
        date,
        declared: declared.size,
        required: reads.filter(r => r.stepAside === null).length,
        missing: reads.filter(r => r.stepAside === null && !declared.has(r.name))
    }
}

/** Commits that touched a template or any source file, newest first, capped. */
function historyRevs(dir: string, cap: number): string[] {
    const out = git(dir, ['log', '--format=%H', '-n', String(cap * 4), '--', '.'])
    if (out === null) return []
    const all = out.split('\n').filter(s => s.length > 0)
    if (all.length <= cap) return all
    const step = all.length / cap
    return Array.from({length: cap}, (_, i) => all[Math.floor(i * step)])
}

// ── synthetic non-JS trees (the ecosystem-generality claim) ───────────────────

interface Fixture {
    label: string
    files: Record<string, string>
    /** What the check MUST find here, exactly. */
    expect: string[]
}

const FIXTURES: Fixture[] = [
    {
        label: 'fixture:python-missing',
        files: {
            '.env.example': 'DATABASE_URL=postgres://x\n# comment\nAPP_URL=http://localhost\n',
            'app/main.py':
                'import os\n'
                + 'db = os.environ["DATABASE_URL"]\n'
                + 'admin = os.environ["ADMIN_PHONE"]\n'
                + 'url = os.getenv("APP_URL", "http://localhost")\n'
                + 'region = os.getenv("AWS_REGION", "eu-north-1")\n'
                + 'mode = os.environ.get("MODE")\n'
        },
        expect: ['ADMIN_PHONE', 'MODE']
    },
    {
        label: 'fixture:go-missing',
        files: {
            '.env.sample': 'DATABASE_URL=postgres://x\n',
            'main.go':
                'package main\n\n'
                + 'import "os"\n\n'
                + 'func main() {\n'
                + '\tdsn := os.Getenv("DATABASE_URL")\n'
                + '\tkey := os.Getenv("STRIPE_KEY")\n'
                + '\tif v, ok := os.LookupEnv("DEBUG_MODE"); ok { _ = v }\n'
                + '\tif os.Getenv("FEATURE_X") == "" { _ = dsn; _ = key }\n'
                + '}\n'
        },
        expect: ['STRIPE_KEY']
    },
    {
        label: 'fixture:no-template',
        files: {'app/main.py': 'import os\nk = os.environ["ANYTHING_AT_ALL"]\n'},
        expect: []
    }
]

function buildFixture(f: Fixture, root: string): string {
    const dir = path.join(root, f.label.replace(/[^a-z0-9]+/gi, '-'))
    fs.mkdirSync(dir, {recursive: true})
    for (const [p, text] of Object.entries(f.files)) {
        fs.mkdirSync(path.dirname(path.join(dir, p)), {recursive: true})
        fs.writeFileSync(path.join(dir, p), text)
    }
    spawnSync('git', ['init', '-q'], {cwd: dir})
    spawnSync('git', ['add', '-A'], {cwd: dir})
    spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x'], {cwd: dir})
    return dir
}

// ── report ────────────────────────────────────────────────────────────────────

function main(): void {
    const t0 = Date.now()
    const trees: string[] = []
    for (const root of ROOTS) {
        if (!fs.existsSync(root)) continue
        trees.push(...findWorkTrees(root))
    }
    console.log(`# nexttask 10 STEP 0 — env-template closure base rate`)
    console.log(`scanned roots: ${ROOTS.map(rel).join(', ')}`)
    console.log(`git work trees found: ${trees.length}`)

    const reports: TreeReport[] = []
    for (const dir of trees) {
        const r = reportTree(dir)
        if (r) reports.push(r)
    }
    console.log(`work trees TRACKING an env template: ${reports.length}`)
    console.log(`ambient allowlist (${AMBIENT_ENV.size}): ${[...AMBIENT_ENV].join(', ')}`)

    console.log(`\n## per-tree (only trees with a tracked template)\n`)
    const withMissing = reports.filter(r => r.missing.length > 0)
    for (const r of reports) {
        const mark = r.missing.length > 0 ? 'MISSING' : 'clean'
        console.log(
            `${r.label}\n    template ${r.templates.join(', ')}   declared ${r.declared}   `
                + `required ${r.required}   ${mark}`
        )
        for (const m of r.missing) {
            const supply = supplySites(r.dir, m.name)
            console.log(
                `    MISSING ${m.name}  ${m.file}:${m.line} (${m.construct})`
                    + (supply.length > 0 ? `  ALSO NAMED IN: ${supply.join(', ')}` : '  (nowhere else in tree)')
            )
        }
    }

    console.log(`\n## aggregate\n`)
    const totalRequired = reports.reduce((a, r) => a + r.required, 0)
    const totalMissing = reports.reduce((a, r) => a + r.missing.length, 0)
    console.log(`trees with template     ${reports.length}`)
    console.log(
        `trees with a MISSING    ${withMissing.length} `
            + `(${((100 * withMissing.length) / Math.max(1, reports.length)).toFixed(1)}%)`
    )
    console.log(`required reads          ${totalRequired}`)
    console.log(`missing findings        ${totalMissing}`)
    const distinct = new Map<string, number>()
    for (const r of reports) for (const m of r.missing) distinct.set(m.name, (distinct.get(m.name) ?? 0) + 1)
    console.log(
        `distinct missing vars   ${distinct.size}: `
            + [...distinct.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 20)
                .map(([n, c]) => `${n}×${c}`)
                .join(', ')
    )

    // Independence, stated plainly: 123 trees are not 123 projects. The ~/tmp
    // trees are replicate deliveries of a handful of A/B specs, so a family that
    // fires 41 times is ONE piece of evidence repeated, and a family that splits
    // clean/missing is the interesting one (same spec, different outcome).
    console.log(`\n## families (a tree family = one A/B run or one repo)\n`)
    const fam = new Map<string, {n: number; missing: number}>()
    for (const r of reports) {
        const parts = r.label.split('/')
        const key = parts.slice(0, parts[1] === 'hub' ? 3 : 3).join('/')
        const f = fam.get(key) ?? {n: 0, missing: 0}
        f.n++
        if (r.missing.length > 0) f.missing++
        fam.set(key, f)
    }
    for (const [k, v] of [...fam.entries()].sort((a, b) => b[1].n - a[1].n))
        console.log(`${k.padEnd(34)} trees ${String(v.n).padStart(3)}   with MISSING ${v.missing}`)
    console.log(`independent families: ${fam.size}`)

    console.log(`\n## step-aside histogram (which rule did the excluding)\n`)
    const aside = new Map<StepAside, number>()
    for (const r of reports)
        for (const [k, v] of r.aside) aside.set(k, (aside.get(k) ?? 0) + v)
    for (const [k, v] of [...aside.entries()].sort((a, b) => b[1] - a[1]))
        console.log(`${k.padEnd(14)} ${v}`)

    // The FP burden the per-tree table cannot show: trees with NO template are
    // inert by contract, so they contribute zero findings — but they are where the
    // rules meet the most unrehearsed code. Print what the four rules DID with
    // their env reads, so the classification can be hand-read on independent
    // repos rather than only on the mx5 family.
    console.log(`\n## rule pressure on template-LESS trees (inert by contract, read for the rules)\n`)
    const inert: {label: string; required: EnvRead[]; aside: Map<StepAside, number>}[] = []
    for (const dir of trees) {
        const tracked = git(dir, ['ls-files', '-z'])
        if (tracked === null) continue
        const files = tracked.split('\0').filter(p => p.length > 0)
        if (files.some(p => ENV_TEMPLATE_NAMES.includes(path.posix.basename(p)))) continue
        const reads: EnvRead[] = []
        for (const f of files) {
            if (!/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go)$/i.test(f)) continue
            if (/(?:^|\/)(?:node_modules|dist|build|out|vendor|coverage|\.next|\.output)\//.test(f))
                continue
            let text: string
            try {
                text = fs.readFileSync(path.join(dir, f), 'utf8')
            } catch {
                continue
            }
            if (!/env/i.test(text)) continue
            reads.push(...scanSource(f, text))
        }
        if (reads.length === 0) continue
        inert.push({
            label: rel(dir),
            required: reads.filter(r => r.stepAside === null),
            aside: tally(reads)
        })
    }
    for (const t of inert.sort((a, b) => b.required.length - a.required.length).slice(0, 12)) {
        const names = [...new Set(t.required.map(r => r.name))]
        console.log(
            `${t.label}\n    required ${t.required.length} (${names.slice(0, 12).join(', ')})`
                + `\n    step-aside ${[...t.aside.entries()].map(([k, v]) => `${k} ${v}`).join('  ') || 'none'}`
        )
        for (const r of t.required.slice(0, 8)) console.log(`      ${r.name}  ${r.file}:${r.line}`)
    }

    console.log(`\n## non-JS ecosystems (synthetic, proves the rule is not npm-shaped)\n`)
    const fxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'env-closure-fx-'))
    let fxOk = true
    for (const f of FIXTURES) {
        const dir = buildFixture(f, fxRoot)
        const c = scanEnvTemplateClosure(dir)
        const got = c.missing.map(m => m.name).sort()
        const want = [...f.expect].sort()
        const ok = got.join(',') === want.join(',')
        if (!ok) fxOk = false
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${f.label}  expected [${want}]  got [${got}]`)
    }
    fs.rmSync(fxRoot, {recursive: true, force: true})

    console.log(`\n## git history of the long-lived repos\n`)
    const hub = path.join(HOME, 'hub')
    const longLived = reports.filter(r => r.dir.startsWith(hub))
    for (const r of longLived) {
        const revs = historyRevs(r.dir, 12)
        const pts = revs.map(rev => scanCommit(r.dir, rev)).filter((p): p is HistoryPoint => !!p)
        if (pts.length === 0) {
            console.log(`${r.label}: no commit in the sample carries a template`)
            continue
        }
        console.log(`${r.label} — ${pts.length} sampled commits carrying a template`)
        for (const p of pts) {
            const names = p.missing.map(m => `${m.name}@${m.file}:${m.line}`)
            console.log(
                `    ${p.rev} ${p.date}  declared ${p.declared}  required ${p.required}  `
                    + (names.length > 0 ? `MISSING ${names.join(' ')}` : 'clean')
            )
        }
    }

    console.log(`\n(${((Date.now() - t0) / 1000).toFixed(1)}s)`)
    if (!fxOk) process.exitCode = 1
}

main()
