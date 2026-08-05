/**
 * LIVE A/B (nexttask 6, part 2) — under YOLO, does spending ONE unattended autofix
 * attempt before the terminal auto-ACCEPT stop a defect from shipping?
 *
 *     baseline    src/task/task-gates.ts as it ships at git HEAD: an ACCEPT
 *                 recommendation with the unattended budget untouched is accepted
 *                 immediately, zero attempts.
 *     treatment   the working tree's module: one attempt first, then the same
 *                 auto-ACCEPT and the same debt if it still FAILs.
 *
 * Both arms run the REAL `runGatesForTask` (the baseline module is materialised out
 * of git, never re-implemented) over the SAME deps and the SAME fixture. The only
 * difference is the module under test — which is exactly the production difference.
 *
 * ── THE FIXTURE IS A REPLAY, NOT A CONSTRUCTION ──────────────────────────────
 *
 * mx5 run 19, TASK_0009 (`~/hub/mx5 @ ae3efff`), verbatim from its gate trail:
 *
 *     13:22:39  verify: FAIL — work did not verify: The VERIFY block command
 *               `AGENT=1 bun test test/listings.test.ts` fails unaided because no
 *               `.env` file exists …
 *     13:23:59  resolution: recommended ACCEPT
 *     13:23:59  resolution: auto-ACCEPTED despite verify FAIL — autofix budget
 *               spent, nobody to ask (YOLO)      ← budget was 0/3
 *
 * Each trial is a `cp -a --reflink=auto` clone of ~/hub/mx5 reset to ae3efff (the
 * commit that shipped the accepted work), cleaned of every later run artifact, with
 * `.env` removed — the exact pre-fix condition. Measured on this box before this
 * harness was written, in that tree:
 *
 *     bunx tsc --noEmit                          → exit 0
 *     bunx eslint .                              → exit 0
 *     AGENT=1 bun test test/listings.test.ts     → exit 1, 0 pass (no DATABASE_URL)
 *     …the same with a `.env` present            → exit 0, 49 pass
 *
 * That the attempt was worth spending is not an argument: run 19's own RECOMMEND
 * child (`.pi-tasks/verify-debug.log` 13:23:02-13:23:53) copied `.env.example` to
 * `.env`, ran the suite green (49 pass), derived the corrected `getTestDbUrl()`
 * regex, then DELETED the `.env` and recommended ACCEPT. The fix was in its hands.
 *
 * ── DISCLOSED NARROWINGS ─────────────────────────────────────────────────────
 *
 *  1. VERDICT IS COMMAND-GROUNDED, NOT JUDGE-GROUNDED. `deps.verify` runs the
 *     task's own VERIFY block (the shipped `runVerifyCommandLine`) and passes only
 *     when every line exits 0. Production asks a model to judge; here the metric is
 *     three exit codes, so a converged trial is a fact rather than an opinion. The
 *     FIRST FAIL still carries the RECORDED reason text verbatim, so the re-attempt
 *     child receives byte-identically what run 19's would have.
 *  2. THE IMPL RE-RUN IS ONE CHILD, NOT THE WHOLE RUNNER. `deps.runTask` spawns a
 *     `read,edit,bash` child with the shipped RE-ATTEMPT banner + the recorded
 *     spec, instead of re-entering runSingleTask's full phase pipeline. It is the
 *     same shape as the final-gate fix child that historically repaired this defect.
 *  3. PER-TRIAL DATABASE. `.env.example`'s database name is rewritten to
 *     `mx5_ab_<arm><n>` (created before, dropped after) so trials cannot contaminate
 *     each other or the dev database. Nothing else in the tree is touched, and the
 *     defect under test is the ABSENCE of `.env`, not its contents.
 *  4. ONE FIXTURE. `~/tmp/fixcheck` TASK_0016 (the other recorded ACCEPT with an
 *     unspent budget whose FAIL is a code bug) was attempted and is NOT replayable
 *     here: its migration dies with `syntax error at or near "$1"` before reaching
 *     the recorded "33 of 37 fail" state, so its failure surface is not the recorded
 *     one. The harness reports it as unreplayable rather than substituting it.
 *
 * ── PRE-REGISTERED METRIC ────────────────────────────────────────────────────
 *
 * Per trial: the verify verdict AFTER resolution — PASS vs still-FAIL, re-measured
 * from a fresh run of the VERIFY block once the gate returns.
 *
 *     PASS      treatment converges on ≥ 1/3 of trials where baseline converges on
 *               0, one-sided Fisher p < 0.05, AND every invariant holds.   exit 0
 *     FAIL      anything else. Both proportions are reported.              exit 1
 *     ABSTAIN   the fixture does not reproduce the recorded FAIL.          exit 2
 *
 * INVARIANTS (each also pinned deterministically in src/task/task-gates.test.ts):
 *   inv-no-unobserved-autofix  an UNOBSERVED FAIL never triggers an attempt.
 *   inv-no-frozen-autofix      a frozen-blocked repo-health FAIL never does either.
 *   inv-bounded                at most ONE extra attempt per task, ever.
 *   inv-debt-preserved         a non-converged treatment trial records the same
 *                              yolo-accepted debt the baseline records.
 *   inv-no-regression          no check that passed before the attempt fails after.
 *   inv-no-workaround          a converged trial still RUNS the suite (≥49 tests
 *                              pass) — a fix that deletes tests is not a fix.
 *   inv-trail-truthful         every auto-ACCEPTED line names its real branch and
 *                              its real counter (measured in both arms — the
 *                              baseline's is expected to break, and that break is
 *                              the defect part 1 fixes).
 *
 * Run: PI_BIN=$(command -v pi) bun run scripts/yolo-accept-autofix-ab.ts [TRIALS]
 * Safety: refuses to run without PI_BIN (an unset PI_BIN self-spawns a fork bomb —
 * see memory/pi-child-spawn-forkbomb-guard.md); ONE child at a time; every tree is
 * a throwaway clone under ~/.cache; ~/hub/mx5 is never written to.
 */
import {execFileSync, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {judge, EXIT_CODE, type Invariant} from './ab-verdict.js'
import {runChild} from '../src/task/child-runner.js'
import {runVerifyCommandLine} from '../src/task/final-gate.js'
import {parseVerifyBlockStrict} from '../src/task/spec-validation.js'
import {extractSpecForVerification} from '../src/task/verify-work.js'
import {getConfig} from '../src/config/config.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import type {GateDeps, GateParams, GateResult} from '../src/task/task-gates.js'
import {runGatesForTask as treatmentGates, MAX_AUTO_AUTOFIX} from '../src/task/task-gates.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const TASK_DIR = path.join(REPO, 'src', 'task')
const HOME = os.homedir()
const MX5 = path.join(HOME, 'hub', 'mx5')
const FIXCHECK = path.join(HOME, 'tmp', 'fixcheck')
const WORK = path.join(HOME, '.cache', 'pi-task-yolo-ab')
const TRIALS = Number(process.argv[2] ?? 12)
const TASK_ID = 'TASK_0009'
const FIXTURE_SHA = 'ae3efff'
const CHILD_TIMEOUT_MS = 20 * 60_000
const VERIFY_TIMEOUT_MS = 10 * 60_000
const PG_CONTAINER = 'mx5-postgres-1'
const PG_USER = 'mx5_dev'

/** Verbatim from `.pi-tasks/TASK_0009.md`, the 13:22:39 gate line. */
const RECORDED_FAIL_REASON =
    'work did not verify: The VERIFY block command `AGENT=1 bun test test/listings.test.ts` fails '
    + 'unaided because no `.env` file exists (only `.env.example` is shipped), leaving DATABASE_URL '
    + "undefined and causing the test suite to crash before any tests run. Additionally, the test's "
    + '`getTestDbUrl()` regex `/\\/mx5$/` does not match `/mx5_private`, preventing the required swap '
    + 'to the `mx5_test` database even when DATABASE_URL is set.'

/** The shipped RE-ATTEMPT banner (orchestrator.ts `_specForDelivery`), verbatim. */
function reattemptBanner(fixInstruction: string): string {
    return (
        'RE-ATTEMPT — your previous implementation of this task FAILED verification.\n'
        + "Fix the cause below, then make the spec's VERIFY block pass. Do NOT start over;\n"
        + 'change only what is needed to resolve the failure.\n\n'
        + `VERIFICATION FAILURE:\n${fixInstruction.trim()}`
    )
}

type Arm = 'baseline' | 'treatment'
type RunGates = (
    ctx: Parameters<typeof treatmentGates>[0],
    deps: GateDeps,
    p: GateParams
) => Promise<GateResult>

// ─── the baseline module, materialised from git ──────────────────────────────

/**
 * The SHIPPED task-gates module at HEAD, with its relative imports rewritten to
 * absolute paths into the working tree's `src/`. Safe because this change touches
 * only `task-gates.ts` — every module it imports (including `yolo.ts` and the
 * config singleton the YOLO flag lives in) is shared by both arms.
 */
async function loadBaselineGates(): Promise<RunGates> {
    const r = spawnSync('git', ['show', 'HEAD:src/task/task-gates.ts'], {
        cwd: REPO,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
    })
    if (r.error || r.status !== 0) throw new Error('cannot read HEAD:src/task/task-gates.ts')
    const src = r.stdout.replace(
        /from '(\.\.?\/[^']+)'/g,
        (_m, rel: string) => `from '${path.resolve(TASK_DIR, rel)}'`
    )
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-ab-baseline-'))
    const file = path.join(dir, 'task-gates.baseline.ts')
    fs.writeFileSync(file, src, 'utf8')
    const mod = (await import(file)) as {runGatesForTask: RunGates}
    return mod.runGatesForTask
}

// ─── fixture ─────────────────────────────────────────────────────────────────

function sh(cwd: string, cmd: string, args: string[]): void {
    const r = spawnSync(cmd, args, {cwd, encoding: 'utf8'})
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr ?? ''}`)
}

function psql(db: string, sql: string): void {
    spawnSync('docker', ['exec', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', db, '-c', sql], {
        encoding: 'utf8'
    })
}

/**
 * One pristine replay tree: mx5 at the commit that shipped TASK_0009's accepted
 * work, stripped of every later artifact and of `.env`. `git clean -fdx` keeps
 * node_modules only — the playwright/dist caches of later tasks did not exist at
 * accept time and would make `eslint .` fail for reasons unrelated to the defect.
 */
function materialise(arm: Arm, n: number): {dir: string; db: string} {
    const dir = path.join(WORK, `${arm}-t${n}`)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(WORK, {recursive: true})
    sh(WORK, 'cp', ['-a', '--reflink=auto', MX5, dir])
    sh(dir, 'git', ['reset', '--hard', FIXTURE_SHA])
    sh(dir, 'git', ['clean', '-fdx', '-e', 'node_modules'])
    fs.rmSync(path.join(dir, '.env'), {force: true})
    // Per-trial database (narrowing 3).
    const db = `mx5_ab_${arm}${n}`
    const example = path.join(dir, '.env.example')
    fs.writeFileSync(
        example,
        fs.readFileSync(example, 'utf8').replace(/\/mx5_private\b/g, `/${db}`),
        'utf8'
    )
    sh(dir, 'git', ['commit', '-qam', 'trial: per-trial database name'])
    psql('postgres', `DROP DATABASE IF EXISTS ${db}`)
    psql('postgres', `CREATE DATABASE ${db}`)
    psql('postgres', `DROP DATABASE IF EXISTS ${db}_test`)
    psql('postgres', `CREATE DATABASE ${db}_test`)
    return {dir, db}
}

function dropDb(db: string): void {
    psql('postgres', `DROP DATABASE IF EXISTS ${db}`)
    psql('postgres', `DROP DATABASE IF EXISTS ${db}_test`)
}

// ─── the grounded verify ─────────────────────────────────────────────────────

interface VerifyMeasurement {
    ok: boolean
    /** The line that failed, and its tail. */
    reason: string
    /** Tests reported passing by the `bun test` line, or null if it never ran. */
    testsPassed: number | null
    /** Per-line outcome, for inv-no-regression. */
    perLine: Array<{line: string; outcome: string}>
}

function verifyBlockFor(dir: string): string[] {
    const body = fs.readFileSync(path.join(dir, '.pi-tasks', `${TASK_ID}.md`), 'utf8')
    const spec = extractSpecForVerification(body)
    if (spec === null) throw new Error('task file has no ## spec section')
    const cmds = parseVerifyBlockStrict(spec)
    if (cmds === null || cmds.length === 0) throw new Error('task spec has no strict VERIFY block')
    return cmds.map(c => c.raw)
}

/** Run every VERIFY line. PASS only when all of them exit 0. */
function measureVerify(dir: string): VerifyMeasurement {
    const perLine: VerifyMeasurement['perLine'] = []
    let firstBad: string | null = null
    let testsPassed: number | null = null
    for (const line of verifyBlockFor(dir)) {
        const r = runVerifyCommandLine(dir, line, VERIFY_TIMEOUT_MS)
        perLine.push({line, outcome: r.outcome})
        if (r.outcome !== 'pass' && firstBad === null) {
            firstBad =
                r.outcome === 'gap' ?
                    `work unobserved: \`${line}\` could not run — ${r.detail}`
                :   `work did not verify: \`${line}\` exited ${r.status} — ${r.tail}`
        }
        if (/\bbun test\b/.test(line)) testsPassed = countTestsPassed(dir, line)
    }
    return {
        ok: firstBad === null,
        reason: firstBad ?? 'all VERIFY lines exit 0',
        testsPassed,
        perLine
    }
}

/** How many tests the suite actually RAN and passed — the anti-workaround signal. */
function countTestsPassed(dir: string, line: string): number | null {
    const r = spawnSync('sh', ['-c', line], {cwd: dir, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS})
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    const m = /^\s*(\d+)\s+pass\s*$/m.exec(out)
    return m ? Number(m[1]) : null
}

// ─── one trial ───────────────────────────────────────────────────────────────

interface Trial {
    arm: Arm
    n: number
    /** Did the fixture reproduce the recorded FAIL? */
    reproduced: boolean
    /** Verify verdict AFTER resolution — the pre-registered metric. */
    converged: boolean
    attempts: number
    testsPassed: number | null
    debts: string[]
    trail: string[]
    childOk: boolean | null
    finalReason: string
    perLine: VerifyMeasurement['perLine']
    ms: number
}

async function runTrial(arm: Arm, n: number, gates: RunGates): Promise<Trial> {
    const started = Date.now()
    const {dir, db} = materialise(arm, n)
    const logPath = path.join(WORK, `${arm}-t${n}.child.log`)
    const log = (m: string): void => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), CHILD_TIMEOUT_MS)

    const trial: Trial = {
        arm,
        n,
        reproduced: false,
        converged: false,
        attempts: 0,
        testsPassed: null,
        debts: [],
        trail: [],
        childOk: null,
        finalReason: '',
        perLine: [],
        ms: 0
    }

    // Fixture check: the recorded FAIL must actually reproduce before anything runs.
    const first = measureVerify(dir)
    trial.reproduced = !first.ok
    if (!trial.reproduced) {
        clearTimeout(timer)
        dropDb(db)
        trial.ms = Date.now() - started
        trial.finalReason = 'fixture did not reproduce the recorded FAIL'
        return trial
    }

    const {ctx} = makeFakeCtx(dir)
    let verifyCalls = 0
    const specBody = extractSpecForVerification(
        fs.readFileSync(path.join(dir, '.pi-tasks', `${TASK_ID}.md`), 'utf8')
    )!
    const deps: GateDeps = {
        // The gate's first FAIL carries the RECORDED reason (narrowing 1); every
        // later call is a live re-measurement of the tree.
        verify: () => {
            verifyCalls += 1
            if (verifyCalls === 1) return Promise.resolve({ok: false, reason: RECORDED_FAIL_REASON})
            const m = measureVerify(dir)
            return Promise.resolve(m.ok ? {ok: true} : {ok: false, reason: m.reason})
        },
        // The recorded recommendation, replayed. Run 19's child said ACCEPT after
        // proving the fix worked; its prose is not in the log, so the rationale is
        // the recorded FAIL text (what production falls back to).
        recommend: () => Promise.resolve({recommend: 'accept', rationale: RECORDED_FAIL_REASON}),
        runTask: async (c, _cwd, _title, opts) => {
            trial.attempts += 1
            const prompt = `${reattemptBanner(opts?.fixInstruction ?? '')}\n\n${specBody}`
            log(`=== impl child ${trial.attempts} start ===`)
            const r = await runChild(dir, 'read,edit,bash', prompt, abort.signal, line => log(line))
            log(`=== impl child ${trial.attempts} end: exit ${r.exitCode} ===`)
            trial.childOk = r.exitCode === 0
            return {ctx: c, taskId: TASK_ID, ok: r.exitCode === 0, sessionCancelled: false}
        },
        commit: () => Promise.resolve({committed: true}),
        record: (_c, _id, line) => {
            trial.trail.push(line)
            return Promise.resolve()
        },
        recordYoloAcceptDebt: (_c, _id, reason) => {
            trial.debts.push(`yolo-accepted: ${reason}`)
            return Promise.resolve()
        },
        recordAcceptDebt: (_c, _id, reason) => {
            trial.debts.push(`accepted: ${reason}`)
            return Promise.resolve()
        }
    }

    const cfg = getConfig()
    const prevYolo = cfg.yoloMode
    cfg.yoloMode = true
    try {
        await gates(ctx, deps, {cwd: dir, taskId: TASK_ID, title: 'Listing search routes and tests', tag: TASK_ID})
    } finally {
        cfg.yoloMode = prevYolo
        clearTimeout(timer)
    }

    // THE METRIC: a fresh, independent measurement after the gate returned.
    const after = measureVerify(dir)
    trial.converged = after.ok
    trial.finalReason = after.reason
    trial.testsPassed = after.testsPassed
    trial.perLine = after.perLine
    trial.ms = Date.now() - started
    fs.writeFileSync(
        path.join(WORK, `${arm}-t${n}.json`),
        JSON.stringify({...trial, diff: gitDiffNames(dir)}, null, 2)
    )
    dropDb(db)
    return trial
}

function gitDiffNames(dir: string): string[] {
    try {
        const tracked = execFileSync('git', ['status', '--porcelain'], {cwd: dir, encoding: 'utf8'})
        return tracked.split('\n').filter(Boolean)
    } catch {
        return []
    }
}

// ─── deterministic invariant probes (no model) ───────────────────────────────

/** Does an UNOBSERVED / frozen-blocked FAIL trigger an attempt? It must not. */
async function probeNoAttempt(
    gates: RunGates,
    kind: 'unobserved' | 'frozen'
): Promise<{attempts: number; acceptLine: string | undefined}> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-ab-probe-'))
    fs.mkdirSync(path.join(dir, '.pi-tasks'), {recursive: true})
    const {ctx} = makeFakeCtx(dir)
    let attempts = 0
    const trail: string[] = []
    const deps: GateDeps = {
        runTask: c => {
            attempts += 1
            return Promise.resolve({ctx: c, taskId: TASK_ID, ok: true, sessionCancelled: false})
        },
        commit: () => Promise.resolve({committed: true}),
        record: (_c, _id, line) => {
            trail.push(line)
            return Promise.resolve()
        },
        verify: () =>
            Promise.resolve(
                kind === 'unobserved' ?
                    {ok: false, unobserved: true, reason: 'work unobserved: docker absent'}
                :   {ok: false, reason: 'repo health: `bun run lint` exited 2'}
            ),
        ...(kind === 'frozen' && {
            lintFix: () => Promise.resolve({ok: false, reason: 'frozen-path: tsconfig.json'}),
            recordFrozenBlockedDebt: () => Promise.resolve()
        }),
        recommend: () => Promise.resolve({recommend: 'accept', rationale: 'x'}),
        recordYoloAcceptDebt: () => Promise.resolve()
    }
    const cfg = getConfig()
    const prev = cfg.yoloMode
    cfg.yoloMode = true
    try {
        await gates(ctx, deps, {cwd: dir, taskId: TASK_ID, title: 'probe', tag: TASK_ID})
    } finally {
        cfg.yoloMode = prev
    }
    return {attempts, acceptLine: trail.find(l => /^resolution: auto-ACCEPTED/.test(l))}
}

// ─── statistics ──────────────────────────────────────────────────────────────

function logChoose(n: number, k: number): number {
    let s = 0
    for (let i = 0; i < k; i++) s += Math.log(n - i) - Math.log(i + 1)
    return s
}

/** One-sided Fisher exact: P(treatment ≥ observed | same rate in both arms). */
function fisherOneSided(a: number, b: number, c: number, d: number): number {
    // a = treatment converged, b = treatment not; c = baseline converged, d = baseline not.
    const n = a + b + c + d
    const row1 = a + b
    const col1 = a + c
    let p = 0
    for (let x = a; x <= Math.min(row1, col1); x++) {
        p += Math.exp(logChoose(col1, x) + logChoose(n - col1, row1 - x) - logChoose(n, row1))
    }
    return Math.min(1, p)
}

// ─── the fixcheck replayability probe (narrowing 4) ──────────────────────────

function fixcheckReplayable(): string {
    if (!fs.existsSync(FIXCHECK)) return 'absent'
    const dir = path.join(WORK, 'fixcheck-replay-probe')
    fs.rmSync(dir, {recursive: true, force: true})
    try {
        sh(WORK, 'cp', ['-a', '--reflink=auto', FIXCHECK, dir])
    } catch {
        return 'could not clone'
    }
    const db = 'mx5_ab_fixcheck'
    psql('postgres', `DROP DATABASE IF EXISTS ${db}`)
    psql('postgres', `CREATE DATABASE ${db}`)
    fs.writeFileSync(
        path.join(dir, '.env'),
        `DATABASE_URL=postgres://${PG_USER}:mx5_dev_password@localhost:5432/${db}\n`
    )
    const r = spawnSync('sh', ['-c', 'AGENT=1 bun test test/listings.test.ts'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: VERIFY_TIMEOUT_MS
    })
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
    dropDb(db)
    fs.rmSync(dir, {recursive: true, force: true})
    if (/Migration failed/.test(out)) return 'NOT replayable — migration dies before the recorded 33/37 state'
    if (/(\d+)\s+fail/.test(out)) return `reaches a failing suite: ${/(\d+ pass\s+\d+ fail)/.exec(out)?.[1] ?? '?'}`
    return 'unexpected outcome — see the harness output'
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (!process.env.PI_BIN) {
        console.error('refusing to run without PI_BIN (an unset PI_BIN self-spawns a fork bomb).')
        console.error('  PI_BIN=$(command -v pi) bun run scripts/yolo-accept-autofix-ab.ts')
        process.exit(2)
    }
    if (!fs.existsSync(MX5)) {
        console.error(`ABSTAIN — the replay corpus ${MX5} is absent.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }
    fs.mkdirSync(WORK, {recursive: true})
    const baselineGates = await loadBaselineGates()

    console.log(`YOLO one-attempt-before-accept — LIVE A/B, ${TRIALS} trials/arm`)
    console.log(`fixture: mx5 run 19 ${TASK_ID} @ ${FIXTURE_SHA}, .env removed`)
    console.log(`fixcheck ${'TASK_0016'} replayability: ${fixcheckReplayable()}`)
    console.log('')

    const trials: Trial[] = []
    for (const arm of ['baseline', 'treatment'] as const) {
        const gates = arm === 'baseline' ? baselineGates : treatmentGates
        for (let n = 1; n <= TRIALS; n++) {
            const t = await runTrial(arm, n, gates)
            trials.push(t)
            console.log(
                `  ${arm.padEnd(9)} t${String(n).padStart(2)}  ${t.converged ? 'CONVERGED' : 'still-FAIL'}`
                    + `  attempts=${t.attempts}  tests=${t.testsPassed ?? '—'}`
                    + `  ${(t.ms / 1000).toFixed(0)}s`
                    + (t.reproduced ? '' : '  [FIXTURE DID NOT REPRODUCE]')
            )
        }
    }

    const base = trials.filter(t => t.arm === 'baseline')
    const treat = trials.filter(t => t.arm === 'treatment')
    const baseConv = base.filter(t => t.converged).length
    const treatConv = treat.filter(t => t.converged).length
    const p = fisherOneSided(treatConv, treat.length - treatConv, baseConv, base.length - baseConv)
    const rate = treat.length === 0 ? 0 : treatConv / treat.length

    // ── invariants ───────────────────────────────────────────────────────────
    const unobservedProbe = await probeNoAttempt(treatmentGates, 'unobserved')
    const frozenProbe = await probeNoAttempt(treatmentGates, 'frozen')
    const notConverged = treat.filter(t => t.reproduced && !t.converged)
    const converged = treat.filter(t => t.converged)
    const trailTruthful = (t: Trial): boolean => {
        const line = t.trail.find(l => /^resolution: auto-ACCEPTED/.test(l))
        if (line === undefined) return true // converged before accepting
        return line.includes(`autofix budget ${t.attempts}/${MAX_AUTO_AUTOFIX}`)
    }
    const baselineTrailBroken = base.filter(t => !trailTruthful(t)).length
    // A check that passed BEFORE the attempt and fails after is a regression. tsc and
    // eslint both exit 0 in the pre-fix tree (measured), so any non-pass after is one.
    const regressions = treat.filter(t =>
        t.perLine.some(l => !/bun test/.test(l.line) && l.outcome !== 'pass')
    )
    const invariants: Invariant[] = [
        {
            label: 'inv-no-unobserved-autofix',
            ok: unobservedProbe.attempts === 0,
            detail: `attempts=${unobservedProbe.attempts}; line: ${unobservedProbe.acceptLine ?? '—'}`
        },
        {
            label: 'inv-no-frozen-autofix',
            ok: frozenProbe.attempts === 0,
            detail: `attempts=${frozenProbe.attempts}; line: ${frozenProbe.acceptLine ?? '—'}`
        },
        {
            label: 'inv-bounded',
            ok: treat.every(t => t.attempts <= 1) && base.every(t => t.attempts === 0),
            detail: `treatment max ${Math.max(0, ...treat.map(t => t.attempts))}, baseline max ${Math.max(0, ...base.map(t => t.attempts))}`
        },
        {
            label: 'inv-debt-preserved',
            ok:
                notConverged.every(t => t.debts.some(d => d.startsWith('yolo-accepted:')))
                && base.every(t => t.debts.some(d => d.startsWith('yolo-accepted:'))),
            detail: `${notConverged.length} non-converged treatment trial(s), ${base.length} baseline`,
            ...(notConverged.length === 0 && {unmeasured: false})
        },
        {
            label: 'inv-no-regression',
            ok: regressions.length === 0,
            detail:
                regressions.length === 0 ?
                    'tsc + eslint still exit 0 in every treatment trial'
                :   `${regressions.length} trial(s) broke a previously passing check`
        },
        {
            label: 'inv-no-workaround',
            ok: converged.every(t => (t.testsPassed ?? 0) >= 49),
            detail:
                converged.length === 0 ?
                    'no converged trial to check'
                :   `min tests passed in a converged trial: ${Math.min(...converged.map(t => t.testsPassed ?? 0))}`,
            unmeasured: converged.length === 0
        },
        {
            label: 'inv-trail-truthful',
            ok: treat.every(trailTruthful),
            detail: `treatment ${treat.filter(t => !trailTruthful(t)).length} false line(s); BASELINE ${baselineTrailBroken}/${base.length} false (the defect part 1 fixes)`
        }
    ]

    const unmeasured: string[] = []
    if (notConverged.length === 0 && base.length === 0) unmeasured.push('inv-debt-preserved had no trial')
    if (converged.length === 0) unmeasured.push('inv-no-workaround had no converged trial to score')

    console.log('')
    console.log(`  baseline  converged ${baseConv}/${base.length}`)
    console.log(`  treatment converged ${treatConv}/${treat.length}  (rate ${(rate * 100).toFixed(0)}%)`)
    console.log(`  one-sided Fisher p = ${p.toFixed(4)}`)

    // The pre-registered gate, expressed as invariants so `judge` renders it.
    invariants.push({
        label: 'pre-registered: treatment ≥ 1/3 and p < 0.05',
        ok: rate >= 1 / 3 && p < 0.05,
        detail: `rate ${(rate * 100).toFixed(0)}%, p=${p.toFixed(4)}`
    })

    const {outcome, lines} = judge({
        name: 'YOLO one-attempt-before-accept',
        reps: TRIALS,
        targetShape: 'the defect SHIPS — verify still FAILs after the gate resolved',
        baselineHits: base.filter(t => t.reproduced && !t.converged).length,
        treatmentHits: notConverged.length,
        requireTreatmentZero: false,
        invariants,
        unmeasured
    })
    for (const l of lines) console.log(l)
    process.exit(EXIT_CODE[outcome])
}

await main()
