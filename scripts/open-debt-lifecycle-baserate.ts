/**
 * STEP 0 — base rate for the OPEN-DEBT LIFECYCLE lever (nexttask 6), measured
 * BEFORE any change. Deterministic, no model, no PI_BIN, no network.
 *
 * The defect (auto-orchestrator.ts:1622-1633 vs :1802): the "N recorded
 * verify-FAIL defect(s) are STILL unresolved" report is built from the FIRST
 * gate result, and the converged-autofix path rebuilds `fin` as
 * `{ok: true, reason}` — so `openDebts` is not merely un-actioned, it is gone
 * from the value. Nothing can ever clear, re-check or act on it.
 *
 * 6A proposes: carry `openDebts` across the converged path and RE-DERIVE them
 * against the post-autofix tree, then re-emit from the final state.
 *
 * The pre-registered question this script answers, before writing that code:
 *
 *   Of every debt this project has ever recorded, what fraction would the
 *   SHIPPED derivation (recheckAcceptDebts) clear if it were re-run at the end
 *   of the run instead of before the autofix?
 *
 * That fraction is EXACTLY what 6A recovers. It is not the same as "how many
 * debts were actually fixed by run end" — the shipped derivation can only prove
 * two classes resolved (see accept-debt.ts):
 *
 *   - static-class  (`repo health: …`) → resolved iff the statics now pass;
 *   - cross-task-deletion               → resolved iff the named file is back.
 *
 * Everything else is surfaced, never auto-closed (FP-safe by construction, and
 * `inv-no-false-clear` says that boundary is non-negotiable). So this script
 * reports BOTH numbers and keeps them apart:
 *
 *   RECOVERABLE  — debts the shipped derivation could flip open→resolved.
 *   REACHABLE    — debts whose claim is mechanically checkable AT ALL (a
 *                  stronger checker's ceiling), vs dynamic, vs prose-only.
 *
 * Ground truth for run 18 (hand-verified against `~/hub/mx5` HEAD = a9c6145,
 * the converged autofix commit) is carried as a fixture so the classifier can
 * be scored rather than trusted.
 *
 * Pools are kept separate on purpose (methodology rule 2 — a lever measured on
 * its own design sample proves nothing on its own):
 *   PROJECT  real multi-task project runs (~/hub/*, ~/tmp/fixcheck) — run 18
 *            (mx5) is the design sample and is labelled as such.
 *   TRIAL    the A/B trial trees under ~/tmp/<experiment>/**, each a 1-3 task
 *            fixture run. Hugely duplicated (the same fixture spec run 30x), so
 *            they are also reported DEDUPED by (taskId, origin, reason).
 *
 * Run: bun run scripts/open-debt-lifecycle-baserate.ts
 *      bun run scripts/open-debt-lifecycle-baserate.ts --statics   (slow: runs
 *          each tree's real static commands to get a true `staticOk`)
 */
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    isStaticClassDebt,
    parseAcceptDebts,
    recheckAcceptDebts,
    type AcceptDebt
} from '../src/task/accept-debt.js'
import {runRepoHealthCheck} from '../src/task/repo-health-check.js'

const HOME = os.homedir()
const RUN_STATICS = process.argv.includes('--statics')

// ─── corpus discovery ────────────────────────────────────────────────────────

const SEARCH_ROOTS = [
    path.join(HOME, 'hub'),
    path.join(HOME, 'tmp'),
    path.join(HOME, '.cache')
]

/** Depth-limited walk for `<tree>/.pi-tasks/accept-debt.md`. */
function findLedgers(root: string, depth = 0, out: string[] = []): string[] {
    if (depth > 4) return out
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(root, {withFileTypes: true})
    } catch {
        return out
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name === 'node_modules' || e.name === '.git') continue
        const dir = path.join(root, e.name)
        if (e.name === '.pi-tasks') {
            const f = path.join(dir, 'accept-debt.md')
            if (fs.existsSync(f)) out.push(f)
            continue
        }
        findLedgers(dir, depth + 1, out)
    }
    return out
}

/** A real project run vs a throwaway A/B trial tree. */
function poolOf(tree: string): 'PROJECT' | 'TRIAL' {
    const rel = path.relative(HOME, tree)
    if (rel.startsWith('hub' + path.sep)) return 'PROJECT'
    if (rel === path.join('tmp', 'fixcheck')) return 'PROJECT'
    return 'TRIAL'
}

// ─── claim classification ────────────────────────────────────────────────────

export type DebtClass = 'static-repo-health' | 'grep-checkable' | 'dynamic' | 'prose-only'

/** A path-like token (same shape accept-debt.ts uses for existence claims). */
const PATH_RE = /(?:[\w.@-]+\/)+[\w.@-]+\.\w+/
/** A code token in backticks that grep could look for: has a call, dot or ::. */
const CODE_TOKEN_RE = /`[^`]*(?:\(\)|\.\w|::)[^`]*`/
/**
 * Evidence the claim can only be settled by RUNNING something: an exit status, a
 * suite result, a runtime service, a browser, a boot. Deliberately narrow — a
 * reason that merely names a test FILE is still grep-checkable (does it exist,
 * is it where the VERIFY block says).
 */
const DYNAMIC_RE =
    /\b(?:exit(?:s|ed)? \d|exit code|\d+ of \d+ .*tests? fail|tests? fails?|suite|flaky|timed? ?out|could not run|runtime|postgres|docker|browser|headless|boot|serve[sd]?|listener|GUI|manual)\b/i

/**
 * Classify what KIND of check could ever settle a recorded reason.
 *
 * Precedence is deliberate and stated so the scoring below is falsifiable:
 *   1. `repo health:` prefix        → the one class the shipped code re-checks.
 *   2. a concrete path or code token → grep/exists could decide it, even if the
 *      reason ALSO mentions a failing suite (run 18 TASK_0008 is exactly this:
 *      "the VERIFY command fails (exit 1) BECAUSE the file is at X not Y" — the
 *      exit code is the symptom, the path mismatch is the decidable claim).
 *   3. dynamic evidence             → needs a run.
 *   4. otherwise                     → prose-only, never auto-clearable.
 */
export function classifyDebt(reason: string): DebtClass {
    if (isStaticClassDebt(reason)) return 'static-repo-health'
    if (PATH_RE.test(reason) || CODE_TOKEN_RE.test(reason)) return 'grep-checkable'
    if (DYNAMIC_RE.test(reason)) return 'dynamic'
    return 'prose-only'
}

// ─── run 18 ground truth (hand-verified against mx5 HEAD a9c6145) ────────────

interface GroundTruth {
    taskId: string
    /** Is the recorded defect still present in the tree at run end? */
    stillTrue: 'yes' | 'no' | 'historical'
    evidence: string
}

const RUN18_GROUND_TRUTH: GroundTruth[] = [
    {
        taskId: 'TASK_0007',
        stillTrue: 'yes',
        evidence: 'sql.unsafe( present in src/server/routes/listings.ts'
    },
    {
        taskId: 'TASK_0008',
        stillTrue: 'yes',
        evidence: 'spec VERIFY runs src/server/routes/listings.test.ts; file is test/listings.test.ts'
    },
    {
        taskId: 'TASK_0019',
        stillTrue: 'historical',
        evidence: 'a prohibition violation about an already-shipped edit — not a tree state'
    },
    {
        taskId: 'TASK_0024',
        stillTrue: 'no',
        evidence: 'the same autofix commit a9c6145 added the .first() that fixes it'
    }
]

const MX5 = process.env.MX5_REPO ?? path.join(HOME, 'hub', 'mx5')

/**
 * Re-check run 18's ground truth mechanically where the tree allows it, so the
 * table above is evidence rather than assertion. Returns per-task agreement.
 */
function verifyRun18GroundTruth(): string[] {
    const notes: string[] = []
    const at = (rel: string): boolean => fs.existsSync(path.join(MX5, rel))
    if (!fs.existsSync(path.join(MX5, '.git'))) {
        return ['   (mx5 repo absent — ground truth carried as fixture, unverified here)']
    }
    let head = ''
    try {
        head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: MX5, encoding: 'utf8'}).trim()
    } catch {
        /* leave blank */
    }
    notes.push(`   mx5 HEAD = ${head.slice(0, 7) || '(unknown)'}`)

    const listings = path.join(MX5, 'src/server/routes/listings.ts')
    if (fs.existsSync(listings)) {
        const src = fs.readFileSync(listings, 'utf8')
        const n = (src.match(/sql\.unsafe\(/g) ?? []).length
        notes.push(
            `   TASK_0007  sql.unsafe( occurrences at HEAD: ${n} `
                + `→ still true: ${n > 0 ? 'YES' : 'no'} (fixture says YES)`
        )
    }
    const specPath = at('src/server/routes/listings.test.ts')
    const realPath = at('test/listings.test.ts')
    notes.push(
        `   TASK_0008  src/server/routes/listings.test.ts exists: ${specPath}; `
            + `test/listings.test.ts exists: ${realPath} `
            + `→ still true: ${!specPath && realPath ? 'YES' : 'no'} (fixture says YES)`
    )
    const spec = path.join(MX5, 'src/client/pages/MyListings.spec.tsx')
    if (fs.existsSync(spec)) {
        const src = fs.readFileSync(spec, 'utf8')
        const fixed = /getByText\('SOLD',\s*\{exact:\s*true\}\)\.first\(\)/.test(src)
        notes.push(
            `   TASK_0024  the .first() fix is in HEAD: ${fixed} `
                + `→ still true: ${fixed ? 'no' : 'YES'} (fixture says no — already fixed)`
        )
    }
    notes.push(
        '   TASK_0019  a constraint-violation claim about an edit already shipped in HEAD — '
            + 'no tree state can falsify it; HISTORICAL by construction.'
    )
    return notes
}

// ─── main ────────────────────────────────────────────────────────────────────

interface Row {
    tree: string
    pool: 'PROJECT' | 'TRIAL'
    debt: AcceptDebt
    cls: DebtClass
    /** Would the SHIPPED derivation clear it, re-run at HEAD? */
    shippedClears: boolean
    staticOk: boolean | null
}

async function main(): Promise<void> {
    const ledgers = SEARCH_ROOTS.flatMap(r => findLedgers(r))
    const rows: Row[] = []
    let treesWithDebt = 0

    for (const f of ledgers) {
        const tree = path.dirname(path.dirname(f))
        let debts: AcceptDebt[]
        try {
            debts = parseAcceptDebts(fs.readFileSync(f, 'utf8').trim())
        } catch {
            continue
        }
        if (debts.length === 0) continue
        treesWithDebt++
        const pool = poolOf(tree)
        // `staticOk` decides every static-class re-check. Running the real
        // static commands over ~100 trees costs minutes each, so it is opt-in;
        // without it we take the FAVOURABLE assumption (statics pass) so the
        // recoverable count is an UPPER bound, never an understatement.
        let staticOk: boolean | null = null
        if (RUN_STATICS) {
            try {
                staticOk = (await runRepoHealthCheck(tree, {timeoutMs: 120_000})).ok
            } catch {
                staticOk = null
            }
        }
        const {resolved} = await recheckAcceptDebts(debts, {
            staticOk: staticOk ?? true,
            fileExists: rel => fs.existsSync(path.join(tree, rel))
        })
        const resolvedKeys = new Set(resolved.map(d => `${d.taskId}\t${d.reason}`))
        for (const d of debts) {
            rows.push({
                tree,
                pool,
                debt: d,
                cls: classifyDebt(d.reason),
                shippedClears: resolvedKeys.has(`${d.taskId}\t${d.reason}`),
                staticOk
            })
        }
    }

    const project = rows.filter(r => r.pool === 'PROJECT')
    const trial = rows.filter(r => r.pool === 'TRIAL')
    const dedupeKey = (r: Row): string => `${r.debt.taskId}\t${r.debt.origin}\t${r.debt.reason}`
    const trialDeduped = [...new Map(trial.map(r => [dedupeKey(r), r])).values()]

    const report = (name: string, set: Row[]): void => {
        const clears = set.filter(r => r.shippedClears).length
        const byClass = new Map<DebtClass, number>()
        for (const r of set) byClass.set(r.cls, (byClass.get(r.cls) ?? 0) + 1)
        const byOrigin = new Map<string, number>()
        for (const r of set) {
            const o = r.debt.origin ?? 'accepted'
            byOrigin.set(o, (byOrigin.get(o) ?? 0) + 1)
        }
        console.log(`── ${name}: ${set.length} recorded debt(s)`)
        console.log(
            `   RECOVERABLE by the shipped derivation re-run at HEAD : ${clears}`
                + ` (${set.length > 0 ? ((100 * clears) / set.length).toFixed(1) : '0.0'}%)`
        )
        console.log('   class ceiling (what any checker could ever settle):')
        for (const c of [
            'static-repo-health',
            'grep-checkable',
            'dynamic',
            'prose-only'
        ] as DebtClass[]) {
            console.log(`      ${c.padEnd(20)} ${byClass.get(c) ?? 0}`)
        }
        console.log(
            '   origins: '
                + [...byOrigin.entries()].map(([o, n]) => `${o}=${n}`).join('  ')
        )
        console.log('')
    }

    console.log('OPEN-DEBT LIFECYCLE — STEP 0 base rate (nexttask 6)')
    console.log(
        `corpus: ${ledgers.length} ledger file(s) found, ${treesWithDebt} with at least one record`
    )
    console.log(`staticOk source: ${RUN_STATICS ? 'measured (--statics)' : 'assumed true (upper bound)'}`)
    console.log('')

    report('PROJECT pool (real multi-task runs)', project)
    report('TRIAL pool (A/B trees, raw)', trial)
    report('TRIAL pool (deduped by task+origin+reason)', trialDeduped)

    console.log('── PROJECT pool, per tree')
    const byTree = new Map<string, Row[]>()
    for (const r of project) {
        const l = byTree.get(r.tree) ?? []
        l.push(r)
        byTree.set(r.tree, l)
    }
    for (const [tree, set] of byTree) {
        console.log(`   ${path.relative(HOME, tree)}  (${set.length} debt(s))`)
        for (const r of set) {
            console.log(
                `      ${(r.debt.taskId || '(none)').padEnd(14)} ${r.cls.padEnd(20)} `
                    + `${(r.debt.origin ?? 'accepted').padEnd(18)} `
                    + `shipped-clears=${r.shippedClears}`
            )
        }
    }
    console.log('')

    console.log('── RUN 18 (mx5) — the design sample, ground truth vs machinery')
    for (const n of verifyRun18GroundTruth()) console.log(n)
    const run18 = project.filter(r => r.tree === MX5)
    const gtById = new Map(RUN18_GROUND_TRUTH.map(g => [g.taskId, g]))
    let actuallyFixed = 0
    let recoveredByShipped = 0
    for (const r of run18) {
        const gt = gtById.get(r.debt.taskId)
        if (gt?.stillTrue === 'no') actuallyFixed++
        if (r.shippedClears) recoveredByShipped++
    }
    console.log(
        `   recorded=${run18.length}  actually-fixed-by-run-end=${actuallyFixed}  `
            + `recovered-by-6A-as-specified=${recoveredByShipped}`
    )
    console.log('')

    // ─── the headline ────────────────────────────────────────────────────────
    const totalClears = project.filter(r => r.shippedClears).length
    console.log('── VERDICT')
    if (totalClears === 0) {
        console.log('   The shipped derivation clears ZERO debts anywhere in the PROJECT pool, even')
        console.log('   under the favourable staticOk=true assumption. So 6A as literally specified')
        console.log('   ("re-run the existing derivation against the post-autofix tree") recovers NO')
        console.log('   debt on any run this project has recorded — including run 18, where 1 of the 4')
        console.log('   reported STILL OPEN was demonstrably fixed by the very autofix that preceded')
        console.log('   the report.')
        console.log('')
        console.log('   That does NOT make 6A wrong; it makes it necessary-but-not-sufficient. The')
        console.log('   value-lifetime bug is real and independent: the report is emitted from a value')
        console.log('   the converged path then discards, so no future checker — however strong — can')
        console.log('   ever run at the only moment that matters. 6A restores the seam. The recovery')
        console.log('   number stays 0 until a checker exists for the grep-checkable class.')
    } else {
        console.log(`   The shipped derivation clears ${totalClears} PROJECT-pool debt(s) at HEAD.`)
    }
    console.log('')
    console.log('   CAVEAT (methodology rule 2): run 18 is the sample this lever was designed on.')
    console.log('   The PROJECT pool is small (see per-tree listing); the TRIAL pool is large but is')
    console.log('   the same 1-3 task fixture repeated, so its raw count overstates independence —')
    console.log('   read the deduped line, not the raw one.')
}

void main()
