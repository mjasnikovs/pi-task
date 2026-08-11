/**
 * A/B (deterministic, no model, no PI_BIN) for the ENFORCE-DIFFERENTIAL ATTRIBUTION
 * lever — mx5 run 18 / nexttask 4.
 *
 * Both arms drive the REAL `runGatesForTask` enforce block with `deps.verify` stubbed
 * to the RECORDED verdict text of each incident:
 *
 *   baseline   `task-gates.ts` exactly as it ships at git HEAD — materialised by
 *              copying the HEAD blob out of git and rewriting its relative imports to
 *              absolute ones, so it is the shipped module, not a re-implementation.
 *   treatment  the working tree's `task-gates.ts` (attribution against the ENFORCE
 *              COMMIT's file set + the disjoint-file pre-filter).
 *
 * Pre-registered metric, per incident: `(reverted?, debt recorded?, repair queued?)`.
 * Target shape: a revert whose failing file is disjoint from the enforce diff.
 *
 *   PASS     baseline reverts ≥1 disjoint-file incident; treatment reverts 0 of them,
 *            AND reverts every non-disjoint incident exactly as baseline did.  exit 0
 *   FAIL     treatment keeps a revert it should have dropped, or drops one it
 *            should have kept.                                                exit 1
 *   ABSTAIN  no incident in the set has a disjoint file set.                   exit 2
 *
 * Invariants asserted alongside the metric:
 *   inv-real-regression-still-reverts  — 2 fixtures where the enforce diff DOES reach
 *                                        the failing file (directly, and via its own
 *                                        spec) still revert in BOTH arms.
 *   inv-unparseable-reason-reverts     — a FAIL text naming no file at all reverts.
 *   inv-debt-still-recorded            — on the new KEEP path the defect is still
 *                                        written to the debt ledger AND a scoped
 *                                        repair is still queued (mx5 run 5's mistake
 *                                        was keeping the work and losing the finding).
 *
 * Run: bun run scripts/enforce-revert-attribution-replay-ab.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import type {GateDeps, GateParams, GateResult} from '../src/task/task-gates.js'
import {runGatesForTask as treatmentGates} from '../src/task/task-gates.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import {withTmpTaskDir} from '../src/test-utils/tmp-task-dir.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const TASK_DIR = path.join(REPO, 'src', 'task')

type RunGates = (
    ctx: Parameters<typeof treatmentGates>[0],
    deps: GateDeps,
    p: GateParams
) => Promise<GateResult>

/**
 * The SHIPPED task-gates module, materialised from git HEAD. Relative imports are
 * rewritten to absolute paths into the working tree's `src/`, which is safe because
 * this A/B changes only `task-gates.ts` itself — every module it imports is shared.
 */
async function loadBaselineGates(): Promise<RunGates> {
    const r = spawnSync('git', ['show', 'HEAD:src/task/task-gates.ts'], {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    })
    if (r.error || r.status !== 0) {
        throw new Error('cannot read HEAD:src/task/task-gates.ts — is this a git repo?')
    }
    const src = r.stdout.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel: string) => {
        return `from '${path.resolve(TASK_DIR, rel)}'`
    })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-ab-baseline-'))
    const file = path.join(dir, 'task-gates.baseline.ts')
    fs.writeFileSync(file, src, 'utf8')
    const mod = (await import(file)) as {runGatesForTask: RunGates}
    return mod.runGatesForTask
}

// ─── incidents ───────────────────────────────────────────────────────────────

interface Incident {
    id: string
    /** Recorded (or, for synthetics, constructed) re-verify FAIL text. */
    reason: string
    /** E — the enforce commit's own diff. */
    enforce: string[]
    /** T — the task commit + enforce commit (what the shipped code attributes against). */
    taskCommitted: string[]
    /** Tracked repo paths, for bare-name resolution. */
    repoFiles: string[]
    /** file → introducing task. */
    provenance: Record<string, string>
    /** GROUND TRUTH: can the enforce diff reach the failing check at all? */
    disjoint: boolean
    /** Provenance of the fixture itself — recorded incident or constructed. */
    kind: 'recorded' | 'synthetic'
    note: string
}

/** Verbatim from run 18's `.pi-tasks/accept-debt.md` (origin `enforce-revert`). */
const RUN18_REASON =
    'work did not verify: 1 of 51 Playwright CT tests fails (MyListings.spec.tsx:186 — "toggle Mark as '
    + 'Sold / Undo Sold updates listing status in-place") due to a pre-existing flaky locator collision '
    + "where getByText('SOLD', {exact: true}) resolves to 2 elements; however, this test file was NOT modified b"

const MX5_REPO_FILES = [
    'src/client/pages/Admin.tsx',
    'src/client/pages/Admin.spec.tsx',
    'src/client/pages/MyListings.tsx',
    'src/client/pages/MyListings.spec.tsx',
    'src/client/pages/MyListings.stories.tsx',
    'src/client/components/Nav.tsx'
]

/** The enforce commit `ee65661`, in full. */
const RUN18_ENFORCE = ['.pi-tasks/TASK_0024.md', 'src/client/pages/Admin.tsx']
/** The task commit `4880e79`, source files only (the .playwright-cache noise is
 *  irrelevant to attribution and would only pad the fixture). */
const RUN18_TASK = [
    ...RUN18_ENFORCE,
    'src/client/pages/MyListings.tsx',
    'src/client/pages/Marketplace.tsx',
    'src/client/components/Nav.tsx'
]

const MX5_PROVENANCE: Record<string, string> = {
    'src/client/pages/MyListings.spec.tsx': 'TASK_0021',
    'src/client/pages/MyListings.tsx': 'TASK_0021',
    'src/client/pages/Admin.tsx': 'TASK_0022',
    'src/client/pages/Admin.spec.tsx': 'TASK_0022'
}

const INCIDENTS: Incident[] = [
    {
        id: 'run18/TASK_0024',
        reason: RUN18_REASON,
        enforce: RUN18_ENFORCE,
        taskCommitted: RUN18_TASK,
        repoFiles: MX5_REPO_FILES,
        provenance: MX5_PROVENANCE,
        disjoint: true,
        kind: 'recorded',
        note: 'the design sample: a one-line paren removal in Admin.tsx, reverted over a CT failure in MyListings.spec.tsx'
    },
    {
        id: 'synthetic/regression-direct',
        reason:
            'work did not verify: `bunx tsc --noEmit` exits 2 — src/client/pages/Admin.tsx:84:21 error '
            + 'TS2554: Expected 1 arguments, but got 2',
        enforce: RUN18_ENFORCE,
        taskCommitted: RUN18_TASK,
        repoFiles: MX5_REPO_FILES,
        provenance: MX5_PROVENANCE,
        disjoint: false,
        kind: 'synthetic',
        note: 'inv-real-regression-still-reverts — the enforce diff IS the failing file'
    },
    {
        id: 'synthetic/regression-companion',
        reason:
            'work did not verify: 1 of 51 Playwright CT tests fails (Admin.spec.tsx:31 — "renders the '
            + 'empty state") after the guideline pass',
        enforce: RUN18_ENFORCE,
        taskCommitted: RUN18_TASK,
        repoFiles: MX5_REPO_FILES,
        provenance: MX5_PROVENANCE,
        disjoint: false,
        kind: 'synthetic',
        note: "inv-real-regression-still-reverts — the enforce diff broke the touched file's OWN spec",
    },
    {
        id: 'synthetic/unparseable',
        reason: 'work did not verify: the VERIFY command exited 1 with no usable output',
        enforce: RUN18_ENFORCE,
        taskCommitted: RUN18_TASK,
        repoFiles: MX5_REPO_FILES,
        provenance: MX5_PROVENANCE,
        disjoint: false,
        kind: 'synthetic',
        note: 'inv-unparseable-reason-reverts — nothing extractable, so never keep on ignorance'
    },
    {
        id: 'synthetic/run14-shape',
        reason:
            'work did not verify: The shipped `bun test test/photos.test.ts` exits with code 1 due to a '
            + 'pre-existing teardown bug in `test/teardown.ts` (created by TASK_0007) that uses parameterized '
            + 'queries for table names in TRUNCATE statements — this task did not modify the teardown',
        // Run 14's real enforce diffs are unrecoverable (its reverts destroyed them),
        // so this arm's E is CONSTRUCTED: a guideline pass confined to the route file
        // the task itself wrote. Reported as synthetic, never as run-14 evidence.
        enforce: ['src/server/routes/invite.ts'],
        taskCommitted: ['src/server/routes/invite.ts', 'test/invite.test.ts'],
        repoFiles: ['test/teardown.ts', 'test/photos.test.ts', 'src/server/routes/invite.ts'],
        provenance: {'test/teardown.ts': 'TASK_0007', 'test/photos.test.ts': 'TASK_0019'},
        disjoint: true,
        kind: 'synthetic',
        note: 'the run-14 CLASS with a constructed enforce diff — the shipped root-cause channel also catches this one'
    }
]

// ─── one replay ──────────────────────────────────────────────────────────────

interface Observation {
    reverted: boolean
    debts: string[]
    queued: string[]
    trail: string[]
}

/**
 * `arm` selects which module runs; the DEPS are identical in both arms, including
 * the ones the shipped module ignores. The `enforce-commit` scope is the only place
 * the arms can diverge: the baseline never asks for it.
 */
async function replay(runGates: RunGates, inc: Incident): Promise<Observation> {
    return withTmpTaskDir(async dir => {
        const {ctx} = makeFakeCtx(dir)
        const obs: Observation = {reverted: false, debts: [], queued: [], trail: []}
        let verifyCalls = 0
        const deps: GateDeps = {
            runTask: () => Promise.resolve({taskId: 'TASK_0024', ok: true, sessionCancelled: false}),
            commit: () => Promise.resolve({committed: true}),
            record: (_c, _id, line) => {
                obs.trail.push(line)
                return Promise.resolve()
            },
            // 1st call = the pre-enforce verify (PASS, so enforce runs in EDIT mode);
            // 2nd = the differential re-verify, red with the recorded text.
            verify: () => {
                verifyCalls += 1
                return Promise.resolve(
                    verifyCalls === 1 ? {ok: true} : {ok: false, reason: inc.reason}
                )
            },
            enforce: () => Promise.resolve({ok: true}),
            revert: () => {
                obs.reverted = true
                return Promise.resolve()
            },
            recordDebt: (_c, _id, reason, origin) => {
                obs.debts.push(`${origin}: ${reason}`)
                return Promise.resolve()
            },
            recordRepairCandidate: (_c, candidate) => {
                obs.queued.push(candidate.file)
                return Promise.resolve()
            },
            touchedFiles: (_c, scope) =>
                Promise.resolve(scope === 'enforce-commit' ? inc.enforce : inc.taskCommitted),
            repoFiles: () => Promise.resolve(inc.repoFiles),
            introducedBy: (_c, rel) => Promise.resolve(inc.provenance[rel] ?? null)
        }
        await runGates(ctx, deps, {
            cwd: dir,
            taskId: 'TASK_0024',
            title: 'replay',
            tag: 'TASK_0024'
        })
        return obs
    })
}

// ─── report ──────────────────────────────────────────────────────────────────

const fmt = (o: Observation): string =>
    `reverted=${o.reverted ? 'YES' : 'no '} debt=${o.debts.length > 0 ? o.debts[0]!.split(':')[0] : '—'} repair=${o.queued.join(',') || '—'}`

async function main(): Promise<void> {
    const baselineGates = await loadBaselineGates()
    let failures = 0
    const fail = (msg: string): void => {
        failures++
        console.log(`   ✗ ${msg}`)
    }

    const disjoint = INCIDENTS.filter(i => i.disjoint)
    if (disjoint.length === 0) {
        console.log('ABSTAIN — no incident in the set has a file set disjoint from its enforce diff.')
        process.exit(2)
    }

    let baselineRevertedDisjoint = 0
    let treatmentRevertedDisjoint = 0

    for (const inc of INCIDENTS) {
        const base = await replay(baselineGates, inc)
        const treat = await replay(treatmentGates, inc)
        console.log(`── ${inc.id}  [${inc.kind}, ${inc.disjoint ? 'DISJOINT' : 'reachable'}]`)
        console.log(`   ${inc.note}`)
        console.log(`   baseline   ${fmt(base)}`)
        console.log(`   treatment  ${fmt(treat)}`)

        if (inc.disjoint) {
            if (base.reverted) baselineRevertedDisjoint++
            if (treat.reverted) {
                treatmentRevertedDisjoint++
                fail(`${inc.id}: treatment REVERTED a failure the enforce diff cannot reach`)
            }
            // inv-debt-still-recorded — keeping the edits must not lose the finding.
            if (!treat.reverted) {
                if (treat.debts.length === 0) {
                    fail(`${inc.id}: inv-debt-still-recorded — kept the edits and recorded NO debt`)
                }
                if (treat.queued.length === 0) {
                    fail(`${inc.id}: inv-debt-still-recorded — kept the edits and queued NO repair`)
                }
            }
        } else {
            // inv-real-regression-still-reverts / inv-unparseable-reason-reverts
            if (!base.reverted) fail(`${inc.id}: baseline did not revert a reachable failure (fixture bug)`)
            if (!treat.reverted) {
                fail(`${inc.id}: treatment KEPT a failure the enforce diff can reach — regression escape`)
            }
            if (treat.reverted !== base.reverted || treat.debts.length !== base.debts.length) {
                fail(`${inc.id}: treatment changed a reachable incident's outcome`)
            }
        }
        console.log('')
    }

    console.log('── RESULT')
    console.log(`   disjoint incidents            : ${disjoint.length}`)
    console.log(`   baseline reverted them        : ${baselineRevertedDisjoint}`)
    console.log(`   treatment reverted them       : ${treatmentRevertedDisjoint}`)
    console.log(`   invariant/consistency failures: ${failures}`)

    if (baselineRevertedDisjoint === 0) {
        console.log('\nABSTAIN — the baseline never reverted a disjoint incident, so there is nothing to flip.')
        process.exit(2)
    }
    if (failures > 0) {
        console.log('\nFAIL')
        process.exit(1)
    }
    console.log('\nPASS — every disjoint revert flipped to KEEP (with the defect still recorded and queued),')
    console.log('       and every reachable failure still reverts exactly as the shipped code does.')
    process.exit(0)
}

void main()
