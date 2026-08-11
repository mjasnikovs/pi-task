/**
 * A/B for 6A — OPEN-DEBT CARRY + RECOMPUTE (nexttask 6). Deterministic: no model,
 * no PI_BIN, no network. Drives the REAL `runAutoLoop` final-gate resolution loop.
 *
 * The defect: the run's "N recorded verify-FAIL defect(s) are STILL unresolved"
 * report is emitted from the FIRST gate result, and the converged-autofix paths
 * rebuilt the gate outcome as a bare `{ok, reason}` — `openDebts` was not merely
 * un-actioned, it was GONE from the value, so no code path could ever clear,
 * re-check or act on it. mx5 run 18: four defects stamped STILL OPEN at 14:58:29,
 * the autofix converged at 15:03:16, and one of the four had been fixed by that
 * very autofix.
 *
 *   baseline   `deps.recheckOpenDebts` absent — the shipped behaviour: the
 *              pre-autofix report is the run's last word.
 *   treatment  the dep wired, so the converged paths re-derive the ledger against
 *              the FINAL tree and correct the record.
 *
 * ── PRE-REGISTERED METRIC ──────────────────────────────────────────────────
 * Per scenario: the SET of debt ids the run reports STILL OPEN at run end, read
 * off the gate trail as (`defect STILL OPEN` ids) minus (`defect RESOLVED` ids).
 *
 * ⚠ THE EXPECTATION IN nexttask 6 IS CORRECTED HERE, BEFORE MEASURING, exactly as
 * that document instructs ("fix the expectation in the script, not at review
 * time"). It asks for run 18's treatment set to be {TASK_0007, TASK_0008}. STEP 0
 * (`open-debt-lifecycle-baserate.ts`) measured why that is unreachable:
 *
 *   - The shipped derivation can prove only two classes resolved — static-class
 *     (`repo health: …`) and cross-task-deletion. Across 3121 recorded debts in
 *     every tree this project retains, ZERO are static-class, and none of run 18's
 *     four are either class.
 *   - TASK_0024 (the one genuinely fixed by the autofix) is a Playwright CT
 *     failure. Proving it resolved needs the gate to show that a suite it observed
 *     PASSING actually covered `MyListings.spec.tsx` — evidence the gate does not
 *     retain (passing output is discarded). Clearing it on anything less is
 *     precisely the false-clear `inv-no-false-clear` forbids.
 *   - TASK_0019 is a constraint-violation claim about an edit already shipped in
 *     HEAD. No tree state can falsify it. Unfalsifiable ⇒ stays open, by rule.
 *
 * So the corrected pre-registration is:
 *
 *   PASS    (a) every CLEARABLE debt (static-class resolved by the autofix,
 *               cross-task-deletion whose file the autofix restored) is reported
 *               STILL OPEN by baseline and RESOLVED by treatment;
 *           (b) no debt that is still true is cleared by treatment — in
 *               particular run 18's set is IDENTICAL in both arms;
 *           (c) the non-converging path's trail is byte-identical between arms;
 *           (d) both arms still complete the run.                        exit 0
 *   FAIL    any false-clear, any missed clearable debt, any trail drift on the
 *           fail path, or a run that stops completing.                   exit 1
 *   ABSTAIN the mx5 evidence tags are missing, so the recorded run 18 scenario
 *           cannot be replayed (the synthetic pool is still reported). exit 2
 *
 * Invariants (asserted, named in the output):
 *   inv-no-false-clear        — behavioral / prose-only debts are never cleared,
 *                               even when the autofix demonstrably fixed them.
 *   inv-fail-path-unchanged   — a non-converging gate produces a byte-identical
 *                               trail in both arms.
 *   inv-no-new-block          — 6A never turns a completing run into a blocked
 *                               one; the final task state is `completed` in both.
 *   inv-demoted-path-conservative
 *                             — on the demote-and-converge door the statics are
 *                               NOT proven, so a static-class debt stays open.
 *
 * Run: bun run scripts/open-debt-recompute-ab.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runAutoLoop, type AutoDeps} from '../src/task/auto-orchestrator.js'
import {buildAutoBody} from '../src/task/auto-io.js'
import {writeTaskFile, readTaskFile} from '../src/task/task-io.js'
import {deriveOpenDebts} from '../src/task/final-gate.js'
import {FINAL_AUTOFIX_LABEL} from '../src/task/final-gate-fix.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import type {TaskFrontMatter} from '../src/task/task-types.js'
import {tempRepo} from './scratch-repo.js'

/** `--trace` prints every gate-trail line of every arm (debugging the harness). */
const TRACE = process.argv.includes('--trace')
const MX5 = process.env.MX5_REPO ?? path.join(os.homedir(), 'hub', 'mx5')
const PRE_TAG = 'evidence/run18-task24'
const POST_TAG = 'evidence/run18-final-autofix'

// ─── fixtures ────────────────────────────────────────────────────────────────

/**
 * Run 18's ledger is NOT retyped here — it is read verbatim out of git.
 *
 * `.pi-tasks/` is tracked in mx5, so the recorded ledger is a blob at the tags,
 * and re-transcribing it into a fixture is a live hazard: the first version of
 * this harness did exactly that, dropped two backslashes from TASK_0007's
 * ``(`sql\`...\`)``, and the harness's own autofix step (which checks the tagged
 * tree out over the worktree, `.pi-tasks/` included) then restored the REAL text
 * — so the re-derivation saw a debt whose key had changed and reported it both
 * RESOLVED and STILL OPEN in the same trail. Read the blob, never retype it.
 *
 * The 4-entry ledger is taken from the POST tag: TASK_0024's enforce-revert debt
 * was recorded at 14:57, between the task commit (the PRE tag) and the 14:58 gate
 * that reported all four, so the PRE tag's own blob holds only three.
 */
function run18Ledger(): string | null {
    const r = spawnSync('git', ['show', `${POST_TAG}:.pi-tasks/accept-debt.md`], {
        cwd: MX5,
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024
    })
    if (r.error || r.status !== 0) return null
    return r.stdout
}

/** Run 18's recorded first-gate failure list, as trailed at 14:58:29. */
const RUN18_FAILURES = [
    'the assembled app does not render: `/` served no root element',
    '`bun run test` exited 1',
    '`bun run lint` reported 2 problems',
    'lockfile out of date with package.json'
]

/**
 * The synthetic pool. Each debt carries GROUND TRUTH about whether the scripted
 * autofix really fixes it, and whether a deterministic check can PROVE that — the
 * two are deliberately not the same, and the gap is where inv-no-false-clear
 * lives.
 */
interface SyntheticDebt {
    taskId: string
    reason: string
    origin: string
    /** Does the scripted autofix actually repair the defect? */
    reallyFixed: boolean
    /** Can the shipped derivation PROVE it resolved after the autofix? */
    provable: boolean
    note: string
}

const SYNTHETIC: SyntheticDebt[] = [
    {
        taskId: 'TASK_0101',
        reason: 'repo health: `bun run lint` exited 1',
        origin: 'accepted',
        reallyFixed: true,
        provable: true,
        note: 'static-class: the converged gate proves the statics pass'
    },
    {
        taskId: 'TASK_0102',
        // The recorded shape extractDeletedDebtPath parses: `deleted \`<path>\``.
        reason:
            'deleted `src/client/pages/admin.tsx` — a sibling task’s committed deliverable '
            + '(introduced by TASK_0099)',
        origin: 'cross-task-deletion',
        reallyFixed: true,
        provable: true,
        note: 'cross-task-deletion: the autofix restores the file, existence is decidable'
    },
    {
        taskId: 'TASK_0103',
        reason:
            'work did not verify: 1 of 51 Playwright CT tests fails (MyListings.spec.tsx:186) '
            + 'due to a locator collision',
        origin: 'yolo-accepted',
        reallyFixed: true,
        provable: false,
        note: 'NEGATIVE CONTROL — really fixed, but unprovable here: must stay OPEN'
    },
    {
        taskId: 'TASK_0104',
        reason:
            'work did not verify: the shipped project contains extra dependencies beyond what '
            + 'the spec allows',
        origin: 'yolo-accepted',
        reallyFixed: false,
        provable: false,
        note: 'NEGATIVE CONTROL — still true: must stay OPEN'
    }
]

// ─── harness ─────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): {ok: boolean; out: string} {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    return {ok: !r.error && r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`}
}

function autoFm(id: string): TaskFrontMatter {
    return {
        id,
        state: 'in_progress',
        phase: 'done',
        created_at: 'T',
        updated_at: 'T',
        title: 'feat'
    } as unknown as TaskFrontMatter
}

interface Outcome {
    /** Every gate-trail line, in order. */
    trail: string[]
    /** Debt ids reported STILL OPEN at run end. */
    stillOpen: Set<string>
    /** Debt ids the run reported as RESOLVED by the autofix. */
    resolved: Set<string>
    finalState: string
}

const STILL_OPEN_RE = /^defect STILL OPEN — (\S+):/
const RESOLVED_RE = /^defect RESOLVED by the final-gate autofix — (\S+):/

/**
 * One replay. `arm` decides only whether `recheckOpenDebts` is wired — everything
 * else is byte-identical between the arms by construction.
 */
async function replay(params: {
    cwd: string
    arm: 'baseline' | 'treatment'
    /** Gate outcome for the FIRST (failing) run. */
    failures: string[]
    /** Statics state the first gate saw. */
    firstStaticOk: boolean
    /** Mutate the tree the way the autofix did. Return false ⇒ never converges. */
    applyAutofix: () => boolean
    /** Converge via the DEMOTE door instead of a clean pass. */
    viaDemotion?: boolean
}): Promise<Outcome> {
    const {cwd, arm} = params
    const handle = makeFakeCtx(cwd)
    const trail: string[] = []
    await writeTaskFile(cwd, autoFm('TASK_AUTO_0001'), buildAutoBody('feat', '(none)', ['A']))

    let converged = false
    let fixRuns = 0
    const deps: AutoDeps = {
        runChild: () => Promise.resolve(''),
        runTask: () =>
            Promise.resolve({taskId: 'TASK_0006', ok: true, sessionCancelled: false}),
        commit: () => Promise.resolve({committed: true}),
        record: (_c, _id, line) => {
            trail.push(line)
            return Promise.resolve()
        },
        finalGate: async c => {
            // The REAL derivation, against the tree as it is at gate time — this is
            // what both arms report from before the fix pass.
            const {openDebts, debtNote} = await deriveOpenDebts(c, params.firstStaticOk)
            return {
                ok: false,
                reason: params.failures[0],
                failures: params.failures,
                openDebts,
                ...(debtNote ? {debtNote} : {})
            }
        },
        finalGateFix: () => {
            fixRuns++
            const ok = params.applyAutofix()
            if (!ok) {
                return Promise.resolve({
                    ok: false,
                    reason: `did not converge: ${params.failures[0]}`,
                    gateReason: params.failures[0],
                    gateFailures: params.failures
                })
            }
            converged = true
            if (params.viaDemotion === true) {
                // The demote-and-converge door: the SAME ranked-first failure comes
                // back from a tree-changing attempt, so the orchestrator demotes it
                // and converges on the remaining (here: none) checks.
                return Promise.resolve({
                    ok: false,
                    reason: `did not converge: ${params.failures[0]}`,
                    gateReason: params.failures[0],
                    gateFailures: [params.failures[0]]
                })
            }
            return Promise.resolve({
                ok: true,
                reason: 'statics + `bun run test` + `bun run test:ct` passed'
            })
        },
        // The non-progress classifier only demotes a check when the attempt
        // actually CHANGED the tree, so a demote-door scenario has to report
        // stranded edits (the real dep reads `git status`).
        pendingChanges: () =>
            Promise.resolve(params.viaDemotion === true && fixRuns > 0 ? ['touched.txt'] : []),
        ...(arm === 'treatment' ?
            {recheckOpenDebts: (c: string, staticOk: boolean) => deriveOpenDebts(c, staticOk)}
        :   {})
    }

    // The demote door needs two tree-changing attempts returning the same failure.
    const attempts = params.viaDemotion === true ? 3 : 1
    for (let i = 0; i < attempts; i++) handle.queueSelect(FINAL_AUTOFIX_LABEL)
    await runAutoLoop(handle.ctx, cwd, 'TASK_AUTO_0001', deps)
    void converged

    const stillOpen = new Set<string>()
    const resolved = new Set<string>()
    for (const line of trail) {
        const o = STILL_OPEN_RE.exec(line)
        if (o) stillOpen.add(o[1])
        const r = RESOLVED_RE.exec(line)
        if (r) {
            resolved.add(r[1])
            stillOpen.delete(r[1])
        }
    }
    const fm = await readTaskFile(cwd, 'TASK_AUTO_0001')
    return {trail, stillOpen, resolved, finalState: String(fm.frontMatter.state)}
}

/** A throwaway git repo seeded with a ledger and the synthetic tree state. */
function makeSyntheticTree(debts: SyntheticDebt[]): string {
    const repo = tempRepo('open-debt-ab-', {
        files: {
            '.pi-tasks/accept-debt.md':
                debts.map(d => `${d.taskId}\t${d.reason}\t${d.origin}`).join('\n') + '\n',
            'README.md': 'seed\n'
        },
        commit: 'seed'
    })
    // The cross-task-deletion debt's file starts DELETED (that is the defect), so
    // only its parent directory exists — no file is seeded under it.
    fs.mkdirSync(path.join(repo.dir, 'src', 'client', 'pages'), {recursive: true})
    return repo.dir
}

// ─── scenarios ───────────────────────────────────────────────────────────────

interface ScenarioResult {
    name: string
    baseline: Outcome
    treatment: Outcome
    ok: boolean
    notes: string[]
}

const results: ScenarioResult[] = []
let abstained = false

/** SCENARIO 1 — the recorded run 18 sequence, replayed on the tagged trees. */
async function scenarioRun18(): Promise<ScenarioResult | null> {
    if (!fs.existsSync(path.join(MX5, '.git'))) return null
    for (const tag of [PRE_TAG, POST_TAG]) {
        if (!git(MX5, ['rev-parse', '--verify', `${tag}^{commit}`]).ok) return null
    }
    const ledger = run18Ledger()
    if (ledger === null) return null
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'open-debt-run18-'))
    const run = async (arm: 'baseline' | 'treatment'): Promise<Outcome> => {
        const wt = path.join(base, arm)
        if (!git(MX5, ['worktree', 'add', '--detach', '-f', wt, PRE_TAG]).ok) {
            throw new Error(`cannot create worktree at ${wt}`)
        }
        fs.mkdirSync(path.join(wt, '.pi-tasks'), {recursive: true})
        fs.writeFileSync(path.join(wt, '.pi-tasks', 'accept-debt.md'), ledger, 'utf8')
        return replay({
            cwd: wt,
            arm,
            failures: RUN18_FAILURES,
            firstStaticOk: false,
            applyAutofix: () => {
                // Exactly what the recorded autofix did: move the tree to the
                // converged revision (which is where mx5 HEAD sits today).
                const r = git(wt, ['checkout', '-f', POST_TAG, '--', '.'])
                return r.ok
            }
        })
    }
    const baseline = await run('baseline')
    const treatment = await run('treatment')
    for (const arm of ['baseline', 'treatment']) {
        git(MX5, ['worktree', 'remove', '--force', path.join(base, arm)])
    }

    const notes: string[] = []
    const expected = new Set(['TASK_0007', 'TASK_0008', 'TASK_0019', 'TASK_0024'])
    const same =
        baseline.stillOpen.size === treatment.stillOpen.size
        && [...baseline.stillOpen].every(i => treatment.stillOpen.has(i))
    const baselineFull = [...expected].every(i => baseline.stillOpen.has(i))
    notes.push(`baseline  STILL OPEN: {${[...baseline.stillOpen].sort().join(', ')}}`)
    notes.push(`treatment STILL OPEN: {${[...treatment.stillOpen].sort().join(', ')}}`)
    notes.push(
        `treatment cleared: {${[...treatment.resolved].sort().join(', ') || '∅'}} `
            + '(expected ∅ — no run-18 debt is in a provable class)'
    )
    notes.push(
        'corrected pre-registration: the sets must MATCH, and must still contain '
            + 'TASK_0007/TASK_0008 (both verified still true at HEAD).'
    )
    const ok = same && baselineFull && treatment.resolved.size === 0
    return {name: 'run18-recorded', baseline, treatment, ok, notes}
}

/** SCENARIO 2 — clearable + unclearable debts, autofix converges cleanly. */
async function scenarioSynthetic(): Promise<ScenarioResult> {
    const run = async (arm: 'baseline' | 'treatment'): Promise<Outcome> => {
        const dir = makeSyntheticTree(SYNTHETIC)
        return replay({
            cwd: dir,
            arm,
            failures: ['`bun run lint` exited 1', '`bun run test` exited 1'],
            // The statics FAILED at the first gate — that is why TASK_0101's
            // static-class debt cannot close there.
            firstStaticOk: false,
            applyAutofix: () => {
                // The autofix restores the deleted deliverable (TASK_0102) and, by
                // converging, proves the statics now pass (TASK_0101). TASK_0103 is
                // "fixed" in reality but leaves no deterministic trace.
                fs.writeFileSync(
                    path.join(dir, 'src', 'client', 'pages', 'admin.tsx'),
                    'export default function Admin() { return null }\n',
                    'utf8'
                )
                return true
            }
        })
    }
    const baseline = await run('baseline')
    const treatment = await run('treatment')

    const notes: string[] = []
    let ok = true
    for (const d of SYNTHETIC) {
        const inBaseline = baseline.stillOpen.has(d.taskId)
        const inTreatment = treatment.stillOpen.has(d.taskId)
        const want = !d.provable // provable ⇒ treatment must clear it
        const pass = inBaseline && inTreatment === want
        if (!pass) ok = false
        notes.push(
            `${pass ? 'ok  ' : 'FAIL'} ${d.taskId} provable=${d.provable} `
                + `reallyFixed=${d.reallyFixed} baseline-open=${inBaseline} `
                + `treatment-open=${inTreatment} — ${d.note}`
        )
    }
    return {name: 'synthetic-clearable', baseline, treatment, ok, notes}
}

/** SCENARIO 3 — inv-fail-path-unchanged: the autofix never converges. */
async function scenarioFailPath(): Promise<ScenarioResult> {
    const run = async (arm: 'baseline' | 'treatment'): Promise<Outcome> => {
        const dir = makeSyntheticTree(SYNTHETIC)
        return replay({
            cwd: dir,
            arm,
            failures: ['`bun run lint` exited 1'],
            firstStaticOk: false,
            applyAutofix: () => false
        })
    }
    const baseline = await run('baseline')
    const treatment = await run('treatment')
    const identical =
        baseline.trail.length === treatment.trail.length
        && baseline.trail.every((l, i) => l === treatment.trail[i])
    const notes = [
        `trail lines: baseline=${baseline.trail.length} treatment=${treatment.trail.length}`,
        `byte-identical: ${identical}`,
        `final state: baseline=${baseline.finalState} treatment=${treatment.finalState}`
    ]
    if (!identical) {
        const i = baseline.trail.findIndex((l, k) => l !== treatment.trail[k])
        notes.push(`first divergence @${i}:`)
        notes.push(`   baseline : ${baseline.trail[i] ?? '(none)'}`)
        notes.push(`   treatment: ${treatment.trail[i] ?? '(none)'}`)
    }
    return {name: 'fail-path-unchanged', baseline, treatment, ok: identical, notes}
}

/** SCENARIO 4 — inv-demoted-path-conservative: converge via the DEMOTE door. */
async function scenarioDemoted(): Promise<ScenarioResult> {
    const run = async (arm: 'baseline' | 'treatment'): Promise<Outcome> => {
        const dir = makeSyntheticTree(SYNTHETIC)
        return replay({
            cwd: dir,
            arm,
            failures: ['`bun run lint` exited 1'],
            firstStaticOk: false,
            viaDemotion: true,
            applyAutofix: () => {
                fs.writeFileSync(path.join(dir, 'touched.txt'), 'x\n', 'utf8')
                return true
            }
        })
    }
    const baseline = await run('baseline')
    const treatment = await run('treatment')
    // The statics were never proven on this door ⇒ the static-class debt stays open.
    const staticStaysOpen = treatment.stillOpen.has('TASK_0101')
    const notes = [
        `treatment STILL OPEN: {${[...treatment.stillOpen].sort().join(', ')}}`,
        `TASK_0101 (static-class) stays open on the demote door: ${staticStaysOpen}`,
        'the cross-task-deletion debt may still close here — its check is a pure'
            + ' existence test that does not depend on the statics.'
    ]
    return {name: 'demoted-convergence', baseline, treatment, ok: staticStaysOpen, notes}
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log('OPEN-DEBT CARRY + RECOMPUTE — A/B for 6A (nexttask 6)')
    console.log('')

    const run18 = await scenarioRun18()
    if (run18 === null) {
        abstained = true
        console.log(`── run18-recorded: ABSTAIN — ${MX5} or its evidence tags are missing.`)
        console.log('')
    } else {
        results.push(run18)
    }
    results.push(await scenarioSynthetic())
    results.push(await scenarioFailPath())
    results.push(await scenarioDemoted())

    for (const r of results) {
        console.log(`── ${r.name}: ${r.ok ? 'ok' : 'FAIL'}`)
        for (const n of r.notes) console.log(`   ${n}`)
        if (TRACE) {
            for (const arm of ['baseline', 'treatment'] as const) {
                console.log(`   ── ${arm} trail`)
                for (const l of r[arm].trail) console.log(`      | ${l.slice(0, 200)}`)
            }
        }
        console.log('')
    }

    // inv-no-new-block, across every converging scenario.
    const blocking = results.filter(
        r =>
            r.name !== 'fail-path-unchanged'
            && (r.baseline.finalState !== 'completed' || r.treatment.finalState !== 'completed')
    )
    console.log(`── inv-no-new-block: ${blocking.length === 0 ? 'HOLDS' : 'BROKEN'}`)
    for (const b of blocking) {
        console.log(
            `   ${b.name}: baseline=${b.baseline.finalState} treatment=${b.treatment.finalState}`
        )
    }
    console.log('')

    const failed = results.filter(r => !r.ok)
    console.log('── VERDICT')
    if (failed.length > 0 || blocking.length > 0) {
        console.log(`   FAIL — ${failed.map(r => r.name).join(', ') || '(blocking)'}`)
        process.exit(1)
    }
    if (abstained) {
        console.log('   ABSTAIN — the synthetic pool passes, but the recorded run 18 sequence')
        console.log('   could not be replayed (mx5 evidence tags missing).')
        process.exit(2)
    }
    console.log('   PASS — every provable debt is cleared by treatment and by neither arm')
    console.log('   before it; no still-true debt is cleared; the fail path is byte-identical;')
    console.log('   both arms still complete.')
    console.log('')
    console.log('   READ THIS WITH STEP 0: on run 18 itself the reported set does NOT shrink,')
    console.log('   and cannot — none of its four debts is in a class any deterministic check')
    console.log('   can close. What 6A fixes is the value-lifetime bug: the report is now')
    console.log('   derived from the tree the run ends with, and the seam where a stronger')
    console.log('   checker would plug in exists at all. The recovery number stays 0 until')
    console.log('   such a checker exists.')
    process.exit(0)
}

void main()
