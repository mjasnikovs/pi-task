/**
 * Zero-FP suite for the owned-requirement/category-freeze detector (nexttask 7)
 * — run BEFORE wiring, and any time the patterns change.
 *
 * The discipline is `frozen-conflict`'s ("FP-swept over the 26 real mx5 run-12
 * specs") and `dangling-artifact-fp-suite.ts`'s: a detector whose finding is
 * FORCED into the critique rewrite spends model time on every fire, so a false
 * positive is not a nuisance, it is a spec the model is ordered to damage.
 *
 * THE mx5 ARM IS PINNED, and it took two rollovers to learn why. `~/hub/mx5` keeps
 * running. It held run 18 when this suite was written (the pair on TASK_0023), then
 * run 19 (the same clause, on TASK_0015), and by 2026-08-12 neither existed: the
 * clause survives in TASK_0014 but its freeze now EXEMPTS `src/server/index.ts` by
 * name, which is a correct non-finding. This suite had been reporting MISMATCH for
 * reasons that had nothing to do with the detector it guards, and a net that goes
 * red on its own is a net nobody reads — exactly what dangling-artifact-fp-suite.ts
 * recorded when it stopped scanning a live tree.
 *
 * So the mx5 arm now scans a `git archive` export of 5138b30, the commit that
 * recorded run 18's TASK_0023, and its source oracle reads `git ls-tree` AT THAT
 * COMMIT rather than the live index. Nothing checks the evidence repo out, adds a
 * worktree, or touches its index.
 *
 * The remaining pools are scanned live as ZERO arms: they pre-register no finding,
 * so a rollover there can only remove specs, never invent a mismatch. The scanned
 * count is printed so that erosion is visible rather than silent.
 *
 * The hand-built arms — six negatives carrying BOTH sides of the shape and
 * satisfiable anyway, and three positive controls without which the negatives
 * also pass with a detector that never fires at all — moved to
 * `scripts/owned-freeze-conflict-fp.test.ts`. They need no corpus and no repo,
 * so they run on every `bun test` instead of when somebody remembers this file.
 * Run 18's TASK_0023 spec is preserved there verbatim too.
 *
 * Ground truth here is recorded spec text. No model.
 *
 * Run: bun run scripts/owned-freeze-conflict-fp-suite.ts
 *   PASS 0 · FAIL 1 · ABSTAIN 2 (spec corpus unavailable)
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import {findOwnedFreezeConflicts, trackedSourceOracle} from '../src/task/owned-freeze-conflict.js'
import {parseOwnedRequirements, ownedForTitle} from '../src/task/requirements.js'
import {mx5Snapshot} from './html-asset-closure-corpus.js'
import {readSection} from './ab-corpus.js'

const HUB = path.join(os.homedir(), 'hub')
const MX5 = path.join(HUB, 'mx5')
/** The commit recording run 18's TASK_0023 — the pair this arm exists to catch. */
const MX5_PIN = '5138b30'
/** Zero arms: they pre-register no finding, so a rollover cannot fake a mismatch. */
const LIVE_POOLS = ['gofer-pixel', 'IAR1', 'runner', 'aiz-client']

/** The one pair the pinned corpus contains (STEP 0, hand-checked). */
const EXPECTED = [`mx5@${MX5_PIN}/TASK_0023 src/server/index.ts`]

let failures = 0

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

/** `git ls-files` against a live checkout. */
function liveOracle(dir: string): (p: string) => boolean {
    return trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-files', '--', p], {cwd: dir, encoding: 'utf8'})
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
}

/**
 * The same question asked of a COMMIT rather than of the index, so the pinned arm
 * cannot drift when the evidence tree gains or loses a file. `git ls-tree` reads
 * the object store; the working tree is never consulted.
 */
function pinnedOracle(repo: string, commit: string): (p: string) => boolean {
    return trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-tree', '-r', '--name-only', commit, '--', p], {
            cwd: repo,
            encoding: 'utf8'
        })
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
}

/** Scan one `.pi-tasks` directory, appending `label/TASK_NNNN path` per finding. */
function scanTasks(
    label: string,
    tasks: string,
    isSource: (p: string) => boolean,
    found: string[]
): number {
    const ledgerFile = path.join(tasks, 'requirements-owned.md')
    const ledger =
        existsSync(ledgerFile) ? parseOwnedRequirements(readFileSync(ledgerFile, 'utf8')) : []
    let scanned = 0
    for (const file of readdirSync(tasks).filter(f => /^TASK_\d+\.md$/.test(f)).sort()) {
        const doc = readFileSync(path.join(tasks, file), 'utf8')
        const spec = section(doc, 'spec')
        if (spec.length === 0) continue
        scanned++
        const owned = ownedForTitle(ledger, section(doc, 'raw prompt'))
        for (const c of findOwnedFreezeConflicts(spec, {owned, isSource})) {
            for (const p of c.paths) found.push(`${label}/${file.replace(/\.md$/, '')} ${p}`)
        }
    }
    return scanned
}

// ── arm 1a: the PINNED mx5 export — the true positive ────────────────────────
const found: string[] = []
let scanned = 0

const snapshot = mx5Snapshot(MX5_PIN)
if (snapshot === null) {
    console.log(
        `*** ABSTAIN — THIS RUN PROVED NOTHING ***\n`
            + `The evidence repo ${MX5} is unavailable, so the pinned true-positive arm\n`
            + `never ran. A clean sweep of the zero arms alone proves only that the\n`
            + `detector is silent. The hand-built negatives and positive controls still\n`
            + `ran: see scripts/owned-freeze-conflict-fp.test.ts (bun test).`
    )
    process.exit(2)
}
scanned += scanTasks(
    `mx5@${MX5_PIN}`,
    path.join(snapshot, '.pi-tasks'),
    pinnedOracle(MX5, MX5_PIN),
    found
)

// ── arm 1b: the live zero pools ──────────────────────────────────────────────
for (const pool of LIVE_POOLS) {
    const tasks = path.join(HUB, pool, '.pi-tasks')
    if (!existsSync(tasks)) continue
    scanned += scanTasks(pool, tasks, liveOracle(path.join(HUB, pool)), found)
}

const sortedFound = [...found].sort()
const arm1ok = JSON.stringify(sortedFound) === JSON.stringify([...EXPECTED].sort())
console.log(`arm 1 — ${scanned} real specs: ${found.length} finding(s) — ${arm1ok ? 'OK' : 'MISMATCH'}`)
for (const f of sortedFound) console.log(`  - ${f}`)
if (!arm1ok) {
    console.log(`  expected: ${JSON.stringify(EXPECTED)}`)
    // The mx5 arm is pinned now, so a mismatch here IS about the detector — that is
    // the whole point of pinning it. What it cannot be any more is the evidence tree
    // having moved on underneath the expectation, which is what it was for a week.
    failures++
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
