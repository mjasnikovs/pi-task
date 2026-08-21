/**
 * nexttask 5B — THE A/B. Does bounding worker:apis's project-source fan-out remove
 * the guaranteed 240s wall-clock timeout without thinning the APIS section?
 *
 * ── WHAT IS BEING TESTED ──────────────────────────────────────────────────────
 *
 * mx5 run 18, measured (scripts/research-restart-baserate.ts, which reproduces
 * every figure below from the recorded logs):
 *
 *     96 worker runs, 23 restarted, 30 discarded attempts, 120.0 min of compute
 *     thrown away (42% of all worker wall time), 19 of those attempts on the
 *     critical path = 76.0 min. 21 of the 23 reported exit=0.
 *     r(project-source lookups, worker:apis wall clock) = 0.909, n = 24.
 *     <=4 lookups: 1/8 restarted.  >=46 lookups: 5/5 burned the FULL budget.
 *
 * The 240s per-worker cap (RESEARCH_WORKER_TIMEOUT_MS) and a 46+-call fan-out are
 * jointly unsatisfiable — each project-source `pi-worker-docs` call runs its own
 * summarising model pass — so on codebase-heavy tasks the timeout is not a
 * backstop, it is the guaranteed outcome, and the whole attempt is then repeated
 * twice more.
 *
 * ── THE ARMS ──────────────────────────────────────────────────────────────────
 *
 * All arms run the SAME BUILD. Both levers are env-gated and OFF by default
 * (src/task/research-fanout-budget.ts), so no dist surgery is involved and the
 * baseline arm is the shipped path byte-for-byte, not a patched copy of it.
 *
 *   baseline   as shipped: no cap, 240s, 2 restarts.
 *   cap        at most PROJECT_DOCS_BUDGET project-source lookups per ATTEMPT,
 *              announced to the worker upfront and enforced in the tool.
 *   scale      each project-source lookup pushes the attempt's deadline out by
 *              PER_LOOKUP_MS, to a hard ceiling of CEILING_MS.
 *   both       cap + scale together.
 *
 * THE BUDGET NUMBER IS PRE-REGISTERED HERE, BEFORE THE RUN: 20. Run 18 puts the
 * boundary between 25 lookups (1 timeout) and 46 (the full budget burned, every
 * time); 8 of the 24 tasks finished clean at <= 15. 20 sits inside the band that
 * demonstrably fits in 240s and above the fan-out of every task that never timed
 * out. Tuning it after seeing this run's numbers would be fitting the lever to
 * its own test set.
 *
 * ── THE FIXTURE, AND ONE DELIBERATE DEVIATION FROM nexttask 5 ────────────────
 *
 * The five tasks that burned the full restart budget — TASK_0017, 0019, 0020,
 * 0021, 0022 — plus the three lowest-fan-out tasks (0001, 0003, 0004) as the
 * untouched control. Prompts are the verbatim `## refined prompt` from
 * ~/hub/mx5/.pi-tasks/TASK_00NN.md.
 *
 * nexttask 5 says to replay them against `evidence/run18-task24`. This harness
 * instead replays each task against ITS OWN `chore: checkpoint before "<raw
 * prompt>"` commit — the tree that task's research actually saw. Reason: the
 * run18-task24 tree is the END of the run, in which all five of these tasks are
 * already implemented. Replaying TASK_0017's research against a tree that already
 * contains Marketplace.tsx changes both the fan-out under test and the APIS
 * section the quality invariant scores, i.e. it would measure a different event
 * than the one that burned the 120 minutes. The checkpoint commits are resolved
 * at run time by matching the task's raw prompt, and the resolved SHA is recorded
 * in every trial file.
 *
 * Research workers run PARALLEL here, because run 18 did: TASK_0024's apis and
 * context workers both end at 14:31:23.1xx, and the phase widget's `workers`
 * total tracks the slowest worker rather than the sum. That matters beyond
 * fidelity — four concurrent children share the one GPU, and that contention is
 * part of what makes 240s unreachable.
 *
 * ── PRE-REGISTERED METRICS, all mechanical, none model-reported ───────────────
 *
 *   1. TARGET SHAPE (decides the verdict): worker:apis logged >= 1
 *      `RESTART … reason=worker-timeout` in the trial. Read from the 5A
 *      instrumentation, which is why 5A had to land first.
 *   2. TIME TO A USABLE ANSWER (`total=` on the done line — again 5A), over the
 *      trials that produced one. The raw mean is CENSORED — a baseline trial
 *      killed at 3x240s never answered, so its 720s is a truncated lower bound —
 *      and is printed as descriptive text only, never as an invariant.
 *   3. QUALITY GUARD, the load-bearing one. A faster worker that ships a thinner
 *      APIS section is a regression, not a win (memory/apis-contract-stage2-failed.md:
 *      a lever moved behaviour 20/20 while fabricating 15% of it):
 *        - signature coverage: entries carrying the `<name>  <signature or use>`
 *          second field the APIS contract demands (src/task/apis-contract.ts),
 *          scored with the committed parser in scripts/apis-trajectory.ts;
 *        - fabrication: entry symbols present in NO channel (groundEntriesStrict)
 *          — the four retrieval channels PLUS the fixture's own source at its
 *          checkpoint commit, because a symbol that exists in the project was not
 *          invented — plus findSynthesizedApis (src/task/api-synthesis.ts), which
 *          still catches wrong-signature claims about symbols that do exist.
 *
 *   PASS     baseline >= 1 timeout per fixture; treatment 0 timeouts; AND
 *            wall-clock strictly lower; AND quality invariants hold.   exit 0
 *   FAIL     timeouts remain, or quality regressed.                    exit 1
 *   ABSTAIN  baseline produced 0 timeouts — the fixture does not exercise
 *            the lever. Extend the fixture; do NOT wire.               exit 2
 *
 * Invariants (checked in `score`). Any of them can also come back UNMEASURED,
 * which ABSTAINS the verdict — an invariant with no evidence under it must never
 * report HOLDS, and each of these has done exactly that once:
 *   inv-quality-not-worse    per fixture: treatment signature coverage >= baseline
 *                            and fabricated-symbol RATE not higher. Unmeasured
 *                            when an arm shipped no section carrying symbols.
 *   inv-no-new-degrade       no `degraded — timed out after restarts` in treatment.
 *   inv-low-fanout-untouched TASK_0001/0003/0004 (0-3 lookups): wall clock within
 *                            LOW_FANOUT_WALL_TOLERANCE, entries >= 80% of baseline,
 *                            and zero budget refusals (the cap must never fire there).
 *                            Unmeasured when a control fixture was not run — it
 *                            reported HOLDS on ZERO control trials in the n=3 run.
 *   inv-time-to-answer-lower over trials that produced a usable answer, so the
 *                            comparison is uncensored on both sides.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────────
 *
 * Needs llama-server at 127.0.0.1:8080 (run-Q3.6-27B.sh, never -b 512 -ub 256),
 * a `bun run build` first (children load extensions from dist), and one harness
 * at a time — they share the one GPU. Never run `bun test` alongside it:
 * src/task/real-pi.smoke.test.ts spawns real pi.
 *
 *   bun run build
 *   PI_BIN=$(command -v pi) bun run scripts/live-research-fanout-budget-ab.ts baseline [TRIALS]
 *   PI_BIN=$(command -v pi) bun run scripts/live-research-fanout-budget-ab.ts cap [TRIALS]
 *   bun run scripts/live-research-fanout-budget-ab.ts score [treatmentArm]
 *
 * Trials are written one JSON file each under $AB_DIR (default
 * ~/tmp/research-fanout-ab), so an interrupted arm resumes by re-running it and
 * `score` never needs model time.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {execFileSync, spawn as nodeSpawn} from 'node:child_process'
import {findSynthesizedApis} from '../src/task/api-synthesis.js'
import type {SpawnFn} from '../src/shared/child-process.js'
import {isGroundingRetrieval} from '../src/workers/pi-worker-core.js'
import {
    FANOUT_TIMEOUT_CEILING_ENV,
    WORKER_CARRY_FORWARD_ENV,
    WORKER_PROGRESS_CEILING_ENV,
    FANOUT_TIMEOUT_PER_LOOKUP_ENV,
    PROJECT_DOCS_BUDGET_ENV
} from '../src/task/research-fanout-budget.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {TYPEONLY_LOG_ENV, readTypeOnlyLog, type TypeOnlyLogRecord} from '../src/workers/typeonly-log.js'
import {buildCheckpointTree, checkpointSourceText} from './run15-fixture-tree.js'
import {
    extractSection,
    groundEntriesStrict,
    parseApisEntries,
    parseTrajectory,
    readTouchedFiles,
    type GroundingCorpus
} from './apis-trajectory.js'
import {reportAb, reportArm, type Invariant} from './ab-verdict.js'

const MX5 = path.join(os.homedir(), 'hub', 'mx5')
const DIST = path.resolve(import.meta.dir, '..', 'dist')
const ROOT = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'research-fanout-ab')
)
const TRIAL_TIMEOUT_MS = 45 * 60_000

/** PRE-REGISTERED, see the header. Do not re-tune after seeing this run's numbers. */
const PROJECT_DOCS_BUDGET = 20
/** ~10s is the observed cost of one project-source lookup (58 lookups ≈ 600s of a 648s worker). */
const PER_LOOKUP_MS = 10_000
/** Hard bound the extensions may never cross — a scaled worker is still a bounded worker. */
const CEILING_MS = 900_000
/**
 * inv-low-fanout-untouched: significance level for a control regression.
 *
 * Replaces the fixed ratios this invariant used to compare means against
 * (`LOW_FANOUT_WALL_TOLERANCE = 1.5`, `ENTRY_FLOOR = 0.8`). Those had no variance
 * model, and on count metrics whose within-fixture CV reaches 87% they were a
 * coin flip: MEASURED at 419/924 = 45.3% false breaks over every 6-vs-6 split of
 * a 36-trial pure-baseline corpus, where both halves are the same arm and every
 * break is therefore false by construction
 * (`scripts/lowfanout-null-control.ts`, corpus `~/tmp/research-fanout-ab-nullctl`).
 *
 * Calibrated on that null corpus and NOTHING else — no treatment data enters it,
 * which is what makes this admissible after a treatment run broke the old rule.
 * Same sweep, directional exact permutation test: 4.4% at 0.05, 0.9% at 0.01.
 */
const CONTROL_ALPHA = 0.05
/**
 * inv-quality-not-worse: the same, and it needed it more.
 *
 * Its rule was `treatment mean < baseline mean` on signature coverage — a strict
 * inequality with no variance model, which is a coin flip per fixture by
 * construction. MEASURED on the null corpus over the same 924 splits: **98.1%**
 * of pure-baseline splits broke this invariant, 437-442 of them on the signature
 * clause alone for each of the three fixtures.
 *
 * Two things follow, and they point in opposite directions:
 *   - every BREAK this invariant has ever reported is uninformative, including
 *     the n=3 FAIL on TASK_0020 that sent this whole investigation down the
 *     grounding-corpus path;
 *   - every HOLD is strong. A guard that fires on 98% of null data and did NOT
 *     fire is saying something real, which is why the n=6 quality HOLD survives
 *     this correction rather than being undone by it.
 */
const QUALITY_ALPHA = 0.05
/** A fixture posed the problem if it fanned out this far via docs… */
const WITNESS_LOOKUPS = 10
/** …or this far across ALL content-returning retrieval tools (D5). */
const WITNESS_RETRIEVALS = 20
/**
 * RESCUE's absolute backstop. With a progress-based deadline, 240s stops being
 * the total time allowed and becomes the time allowed WITHOUT PROGRESS; this is
 * the hard bound no amount of progress can pass. Set from the observed worst
 * case (run 18's slowest worker: 702s over 3 attempts) with room above it, so a
 * genuinely large fan-out finishes on the first attempt instead of restarting.
 */
const PROGRESS_CEILING_MS = 1_200_000

type Arm = 'baseline' | 'cap' | 'scale' | 'both' | 'rescue' | 'carry' | 'progress'
const ARMS: Arm[] = ['baseline', 'cap', 'scale', 'both', 'rescue', 'carry', 'progress']

/**
 * The progress deadline SHIPPED ON in nexttask 9, so `PI_TASK_WORKER_PROGRESS_CEILING_MS`
 * is now the OFF switch. Every arm that is not the progress arm must therefore
 * spell the off value: leaving it unset used to mean "shipped default = fixed cap"
 * and now means "shipped default = progress deadline", which would quietly turn
 * the baseline into a second copy of the treatment — and an A/B whose baseline is
 * the treatment reports 0/0 and calls it a win.
 */
const PROGRESS_OFF = {[WORKER_PROGRESS_CEILING_ENV]: 'off'}

const ARM_ENV: Record<Arm, Record<string, string>> = {
    baseline: {...PROGRESS_OFF},
    cap: {...PROGRESS_OFF, [PROJECT_DOCS_BUDGET_ENV]: String(PROJECT_DOCS_BUDGET)},
    scale: {
        ...PROGRESS_OFF,
        [FANOUT_TIMEOUT_PER_LOOKUP_ENV]: String(PER_LOOKUP_MS),
        [FANOUT_TIMEOUT_CEILING_ENV]: String(CEILING_MS)
    },
    both: {
        ...PROGRESS_OFF,
        [PROJECT_DOCS_BUDGET_ENV]: String(PROJECT_DOCS_BUDGET),
        [FANOUT_TIMEOUT_PER_LOOKUP_ENV]: String(PER_LOOKUP_MS),
        [FANOUT_TIMEOUT_CEILING_ENV]: String(CEILING_MS)
    },
    // Both halves together: they address one fault from two sides — stop
    // discarding the work, and stop killing a worker for being slow rather than
    // stuck. Run as one arm because either alone leaves the fault reachable (a
    // carried-forward worker still gets killed mid-answer; a progress-deadlined
    // worker that IS killed still loses everything).
    rescue: {
        [WORKER_CARRY_FORWARD_ENV]: '1',
        [WORKER_PROGRESS_CEILING_ENV]: String(PROGRESS_CEILING_MS)
    },
    // CARRY-ONLY. The rescue arm eliminated every restart, which also meant
    // carry-forward and salvage NEVER FIRED in it — `attempts=1` on all 8 trials.
    // Half the lever therefore shipped a result it did not earn, and its own
    // failure mode (a half-written entry replayed as established fact) went
    // completely unexercised. Keeping the fixed 240s cap restores the restarts,
    // so this arm is the only one in which the carry is actually under test.
    carry: {...PROGRESS_OFF, [WORKER_CARRY_FORWARD_ENV]: '1'},
    // PROGRESS-ONLY — the missing cell of the 2x2, and on the evidence the only
    // one worth shipping. `rescue` (both halves) removed every timeout, but
    // `carry` (carry alone) shows carry-forward is not merely inert without the
    // progress deadline: it prepends up to CARRY_FORWARD_LIMIT chars to a prompt
    // that must still fit the SAME fixed cap, so it spends the budget it exists
    // to save — TASK_0020 went 22 entries in baseline to 2 and a degrade, with
    // all three attempts timing out where baseline's third succeeded. Without
    // this arm, `rescue`'s win cannot be attributed to either half.
    progress: {[WORKER_PROGRESS_CEILING_ENV]: String(PROGRESS_CEILING_MS)}
}

/** The five tasks that burned the full restart budget, and the three that never restarted. */
const HIGH_FANOUT = ['TASK_0017', 'TASK_0019', 'TASK_0020', 'TASK_0021', 'TASK_0022']
const LOW_FANOUT = ['TASK_0001', 'TASK_0003', 'TASK_0004']

interface Fixture {
    taskId: string
    title: string
    rawPrompt: string
    refined: string
    /** `chore: checkpoint before "<rawPrompt>"` — the tree this task's research saw. */
    commit: string
    lowFanout: boolean
}

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

/**
 * Resolve one run-18 task into a fixture. The checkpoint commit is FOUND, not
 * hard-coded: a hard-coded SHA that silently stops matching its task would
 * replay the right prompt against the wrong tree, and every number here would
 * still look plausible.
 */
function loadFixture(taskId: string): Fixture {
    const file = path.join(MX5, '.pi-tasks', `${taskId}.md`)
    const md = fs.readFileSync(file, 'utf8')
    const title = /^title:\s*(.*)$/m.exec(md)?.[1]?.trim() ?? taskId
    const rawPrompt = section(md, 'raw prompt')
    const refined = section(md, 'refined prompt')
    if (rawPrompt.length === 0 || refined.length === 0) {
        throw new Error(`${taskId}: missing raw or refined prompt in ${file}`)
    }
    const subject = `chore: checkpoint before "${rawPrompt}"`
    const commit = execFileSync('git', ['log', '--format=%H%x09%s'], {
        cwd: MX5,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8'
    })
        .split('\n')
        .find(l => l.slice(l.indexOf('\t') + 1) === subject)
        ?.split('\t')[0]
    if (!commit) {
        throw new Error(
            `${taskId}: no checkpoint commit whose subject is exactly\n  ${subject}\n`
                + 'Without it this task would be replayed against the wrong tree.'
        )
    }
    return {
        taskId,
        title,
        rawPrompt,
        refined,
        commit,
        lowFanout: LOW_FANOUT.includes(taskId)
    }
}

export interface TrialResult {
    arm: Arm
    taskId: string
    trial: number
    commit: string
    /** METRIC 1 — the target shape. */
    workerTimeouts: number
    attempts: number
    restartReasons: string[]
    /** METRIC 2 — worker:apis wall clock, from its own `total=` field. */
    apisWallMs: number
    /** Whole-phase wall clock, for context only. */
    phaseWallMs: number
    /** The lever's precondition: how much fan-out this trial actually produced. */
    projectLookups: number
    /** D5: every content-returning retrieval call, across all tools. */
    retrievalCalls: number
    packageLookups: number
    /** How often the CAP arm refused a call (0 in every other arm). */
    budgetRefusals: number
    degraded: boolean
    /**
     * RESCUE attribution: the answer came from a DISCARDED attempt because the
     * final one returned less. Separates "never killed" (progress deadline) from
     * "killed but kept its work" (carry-forward + salvage).
     */
    salvaged: boolean
    /** METRIC 3 — quality. */
    entries: number
    withSignature: number
    symbols: number
    ungroundedSymbols: number
    synthesizedApis: number
    apisSection: string
    error?: string
}

const RESULT_DIR = (arm: Arm): string => path.join(ROOT, 'results', arm)
const resultPath = (arm: Arm, taskId: string, trial: number): string =>
    path.join(RESULT_DIR(arm), `${taskId}-${trial}.json`)

function loadResults(arm: Arm): TrialResult[] {
    const dir = RESULT_DIR(arm)
    if (!fs.existsSync(dir)) return []
    const all = fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TrialResult)
    // Second line of defence for results recorded before the quarantine below
    // existed: a thrown trial is never scored, whichever arm produced it.
    const usable = all.filter(r => !isUnmeasurable(r))
    if (usable.length !== all.length) {
        console.log(
            `  note: ${all.length - usable.length} recorded ${arm} trial(s) carry an error`
                + ` and are excluded from scoring`
        )
    }
    return usable
}

/**
 * A trial that THREW is not a measurement, in either direction.
 *
 * The first baseline arm lost six of eight fixtures this way: llama-server died
 * partway through, every remaining trial burned its three connection-error
 * retries in ~46s, and each was recorded as `timeouts=0 entries=0`. On the
 * BASELINE arm that reads as "this fixture never posed the problem"; on a
 * TREATMENT arm it reads as "the lever removed every timeout" — a dead server
 * would have scored as the strongest possible PASS.
 *
 * The partial failures are no safer. Baseline TASK_0019 fanned out to 28 project
 * lookups and DID time out — real data for metric 1 — but then the FILES worker
 * threw, so it carries `entries=0`. Scored, it would drop the baseline quality
 * floor to zero and hand `inv-quality-not-worse` a free pass to any treatment.
 *
 * So the rule is the blunt one: a thrown trial produced no APIS section, and
 * without an APIS section none of the three metrics has a value. It is written
 * to `errored/` for inspection — a lever that CAUSES crashes must stay visible,
 * not get silently dropped — and re-run on the next invocation.
 */
const isUnmeasurable = (r: TrialResult): boolean => r.error !== undefined

const isServerGone = (r: TrialResult): boolean =>
    r.error !== undefined && /Connection error|ECONNREFUSED|fetch failed/i.test(r.error)

interface PhasesModule {
    phaseResearch: typeof import('../dist/task/phases.js').phaseResearch
}
interface ConfigModule {
    getConfig: typeof import('../dist/config/config.js').getConfig
}

/** Parse the 5A instrumentation out of one trial's debug log. */
function readInstrumentation(log: string): {
    attempts: number
    reasons: string[]
    apisWallMs: number
    degraded: boolean
    salvaged: boolean
} {
    const reasons: string[] = []
    let attempts = 1
    let apisWallMs = 0
    let degraded = false
    let salvaged = false
    for (const raw of log.split('\n')) {
        if (!raw.startsWith('[debug] worker:apis: ')) continue
        const line = raw.slice('[debug] worker:apis: '.length)
        if (line.startsWith('RESTART ')) {
            reasons.push(/reason=(\S+)/.exec(line)?.[1] ?? 'unknown')
            continue
        }
        if (line.startsWith('degraded — ')) {
            degraded = true
            continue
        }
        if (!line.startsWith('done ')) continue
        attempts = Number(/attempts=(\d+)/.exec(line)?.[1] ?? '1')
        apisWallMs = Number(/total=(\d+)ms/.exec(line)?.[1] ?? '0')
        if (line.includes('salvaged=1')) salvaged = true
    }
    return {attempts, reasons, apisWallMs, degraded, salvaged}
}

/**
 * A spawn that records what every child is handed on stdin — i.e. the ASSEMBLED
 * worker prompt.
 *
 * `GroundingCorpus.prompt` is documented as "the assembled worker:apis prompt:
 * orientation dump, inventory, FILES map, refined task". This harness was
 * supplying the 1.9KB seeded task file instead, which is why symbols the worker
 * legitimately knew from orientation scored as fabrications — `$delete` was
 * flagged while sitting in the fixture's own src/client/api.ts:143. Capturing it
 * here needs no change to shipped code: phaseResearch already threads `spawn`
 * down to runWorker, and the prompt goes to the child on stdin.
 */
function capturingSpawn(sink: string[]): SpawnFn {
    return ((command: string, args: ReadonlyArray<string>, options: never) => {
        const child = nodeSpawn(command, args as string[], options)
        const stdin = child.stdin
        if (stdin) {
            const write = stdin.write.bind(stdin)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            stdin.write = ((chunk: any, ...rest: any[]) => {
                if (typeof chunk === 'string') sink.push(chunk)
                else if (Buffer.isBuffer(chunk)) sink.push(chunk.toString('utf8'))
                return write(chunk, ...(rest as []))
            }) as typeof stdin.write
        }
        return child
    }) as unknown as SpawnFn
}

/**
 * The five grounding channels for one trial.
 *
 * `projectTree` is the one that decides whether the quality invariant measures
 * FABRICATION or merely retrieval. Everything else here is what the worker
 * fetched; a symbol it knew from orientation and did not re-read scored as
 * invented, and that is 100% of what still broke TASK_0019 and TASK_0020 — every
 * flagged symbol was checked by hand against the trial's own checkout and was
 * real. `checkpointSourceText` reads the fixture's hand-authored source at the
 * SHA recorded in the trial, and deliberately excludes build/cache output so a
 * symbol that exists only in a vendored bundle is still a fabrication.
 */
function corpusOf(
    trialDir: string,
    log: string,
    answers: TypeOnlyLogRecord[],
    prompt: string,
    commit: string
): GroundingCorpus {
    const join = (rs: TypeOnlyLogRecord[]): string =>
        rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt,
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: fs.existsSync(trialDir) ? readTouchedFiles(trialDir, parseTrajectory(log)) : '',
        projectTree: checkpointSourceText(commit)
    }
}

async function runTrial(
    mod: PhasesModule,
    fixture: Fixture,
    arm: Arm,
    trial: number
): Promise<TrialResult> {
    const dir = path.resolve(
        buildCheckpointTree(path.join(ROOT, arm, fixture.taskId), trial, {
            commit: fixture.commit,
            taskId: fixture.taskId,
            title: fixture.title,
            rawPrompt: fixture.rawPrompt
        })
    )
    const sink = path.join(dir, 'answers.jsonl')
    const logPath = path.join(dir, 'trial.log')
    fs.rmSync(sink, {force: true})
    fs.rmSync(logPath, {force: true})
    process.env[TYPEONLY_LOG_ENV] = sink
    // Per-trial research cache id: a cache shared across trials would hand later
    // trials answers earlier ones paid for, which is a per-arm speedup nobody asked for.
    process.env[RESEARCH_RUN_ID_ENV] = `${arm}-${fixture.taskId}-${trial}-${Date.now()}`

    const promptSink: string[] = []
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    const started = Date.now()
    let research = ''
    let error: string | undefined
    try {
        research = await mod.phaseResearch(
            {
                cwd: dir,
                taskId: fixture.taskId,
                signal: abort.signal,
                onChildOutput: l => fs.appendFileSync(logPath, l + '\n'),
                logDebug: m => fs.appendFileSync(logPath, `[debug] ${m}\n`),
                spawn: capturingSpawn(promptSink),
                // OFFLINE ENRICHMENT, identically in every arm. External context is
                // a prompt header the lever does not touch; leaving it live would
                // add network variance to a wall-clock metric and spend model time
                // on package summaries that are the same in both arms. These are
                // PhaseDeps fields now, not a third parameter no production caller
                // could reach.
                searchFn: () => Promise.resolve({kind: 'ok' as const, results: []}),
                fetchRaw: () =>
                    Promise.resolve({markdown: '', finalUrl: '', title: 'offline (A/B fixture)'}),
                docsRaw: () =>
                    Promise.resolve({kind: 'error' as const, message: 'offline (A/B fixture)'}),
                npmVersionLookup: () => Promise.resolve(null)
            },
            fixture.refined
        )
    } catch (e) {
        error = String(e).slice(0, 300)
    } finally {
        clearTimeout(timer)
    }
    const phaseWallMs = Date.now() - started

    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    const answers = readTypeOnlyLog(fs.existsSync(sink) ? fs.readFileSync(sink, 'utf8') : '')
    const inst = readInstrumentation(log)
    const apisSection = extractSection(research, 'APIS')
    const steps = parseTrajectory(log)
    const docsSteps = steps.filter(s => s.tool === 'pi-worker-docs')
    // The REAL prompt channel: every assembled prompt this trial's children were
    // given, not the seeded task file. See capturingSpawn.
    const corpus = corpusOf(
        dir,
        log,
        answers,
        [fixture.refined, ...promptSink].join('\n'),
        fixture.commit
    )
    const grounded = groundEntriesStrict(parseApisEntries(apisSection), corpus)
    const entries = parseApisEntries(apisSection)

    return {
        arm,
        taskId: fixture.taskId,
        trial,
        commit: fixture.commit,
        workerTimeouts: inst.reasons.filter(r => r === 'worker-timeout').length,
        attempts: inst.attempts,
        restartReasons: inst.reasons,
        apisWallMs: inst.apisWallMs,
        phaseWallMs,
        projectLookups: docsSteps.filter(s => s.arg.startsWith('.')).length,
        // D5 — a worker that fans out through `read`/`grep` instead of
        // `pi-worker-docs` was scoring as "never posed the problem" while timing
        // out. The precondition is retrieval VOLUME, not one tool's name.
        retrievalCalls: steps.filter(st => isGroundingRetrieval(st.tool)).length,
        packageLookups: docsSteps.filter(s => !s.arg.startsWith('.')).length,
        // Counted from the tool's own refusal text — the cap's firing rate is not
        // inferred from the lookup count, which the model controls.
        budgetRefusals: (log.match(/PROJECT LOOKUP BUDGET SPENT/g) ?? []).length,
        degraded: inst.degraded,
        salvaged: inst.salvaged,
        entries: entries.length,
        withSignature: entries.filter(e => e.rest.length > 0).length,
        symbols: grounded.reduce((n, g) => n + g.entry.symbols.length, 0),
        ungroundedSymbols: grounded.reduce((n, g) => n + g.ungrounded.length, 0),
        synthesizedApis: findSynthesizedApis(
            apisSection,
            fixture.refined,
            [corpus.docsProject, corpus.docsPackage, corpus.reads].join('\n')
        ).length,
        apisSection,
        ...(error ? {error} : {})
    }
}

// ─── arm runner ──────────────────────────────────────────────────────────────

async function serverAlive(): Promise<boolean> {
    try {
        const res = await fetch('http://127.0.0.1:8080/health', {
            signal: AbortSignal.timeout(3000)
        })
        return res.ok
    } catch {
        return false
    }
}

async function runArm(arm: Arm, trials: number, only: string[]): Promise<void> {
    if (!(await serverAlive())) {
        console.error(
            'FATAL: llama-server @ 127.0.0.1:8080 not reachable. Start ~/hub/qwen/run-Q3.6-27B.sh.'
        )
        process.exit(1)
    }
    if (!fs.existsSync(path.join(DIST, 'task', 'phases.js'))) {
        console.error(`FATAL: no dist at ${DIST}. Run \`bun run build\` first.`)
        process.exit(1)
    }
    for (const [k, v] of Object.entries(ARM_ENV[arm])) process.env[k] = v
    // Clear every var ANY arm sets, not just `both`'s — otherwise a rescue run
    // followed by a baseline run in the same shell would leak the lever in.
    for (const k of new Set(ARMS.flatMap(a => Object.keys(ARM_ENV[a])))) {
        if (!(k in ARM_ENV[arm])) delete process.env[k]
    }

    const fixtures = [...HIGH_FANOUT, ...LOW_FANOUT]
        .filter(t => only.length === 0 || only.includes(t))
        .map(loadFixture)
    fs.mkdirSync(RESULT_DIR(arm), {recursive: true})

    const mod = (await import(path.join(DIST, 'task', 'phases.js'))) as PhasesModule
    const cfg = ((await import(path.join(DIST, 'config', 'config.js'))) as ConfigModule).getConfig()
    // Run 18's configuration — see the header. The GPU contention it creates is
    // part of the fault under test, not an artifact to be tuned away.
    cfg.parallelResearchWorkers = true

    console.log(
        `live-research-fanout-budget-ab — arm ${arm}\n`
            + `  env: ${JSON.stringify(ARM_ENV[arm])}\n`
            + `  fixtures: ${fixtures.map(f => `${f.taskId}@${f.commit.slice(0, 7)}`).join(' ')}\n`
            + `  ${trials} trial(s) each, parallel research workers, offline enrichment\n`
            + `  results: ${RESULT_DIR(arm)}`
    )

    for (let trial = 0; trial < trials; trial++) {
        for (const fixture of fixtures) {
            const out = resultPath(arm, fixture.taskId, trial)
            if (fs.existsSync(out)) {
                console.log(`  ${fixture.taskId} trial ${trial}: already recorded — skipping`)
                continue
            }
            const r = await runTrial(mod, fixture, arm, trial)
            if (isUnmeasurable(r)) {
                const kept = path.join(RESULT_DIR(arm), 'errored')
                fs.mkdirSync(kept, {recursive: true})
                fs.writeFileSync(
                    path.join(kept, `${fixture.taskId}-${trial}-${Date.now()}.json`),
                    JSON.stringify(r, null, 2)
                )
                console.log(
                    `  ${fixture.taskId} trial ${trial}: THREW — not scored,`
                        + ` kept under errored/. lookups=${r.projectLookups}`
                        + ` timeouts=${r.workerTimeouts}. ${r.error}`
                )
                if (isServerGone(r) && !(await serverAlive())) {
                    console.error(
                        '\nFATAL: llama-server @ 127.0.0.1:8080 went away mid-arm.'
                            + ' Aborting rather than burning the remaining fixtures on a dead'
                            + ' server. Restart it and re-run this arm — recorded trials are'
                            + ' skipped, so it resumes where it stopped.'
                    )
                    process.exit(1)
                }
                continue
            }
            fs.writeFileSync(out, JSON.stringify(r, null, 2))
            console.log(
                `  ${fixture.taskId} trial ${trial}: timeouts=${r.workerTimeouts}`
                    + ` attempts=${r.attempts} apisWall=${(r.apisWallMs / 1000).toFixed(0)}s`
                    + ` lookups=${r.projectLookups}(+${r.packageLookups}pkg)`
                    + ` refusals=${r.budgetRefusals}`
                    + ` entries=${r.entries} sig=${r.withSignature}`
                    + ` ungrounded=${r.ungroundedSymbols}/${r.symbols}`
                    + (r.salvaged ? ' SALVAGED' : '')
                    + (r.degraded ? ' DEGRADED' : '')
                    + (r.error ? ` ERROR ${r.error}` : '')
            )
        }
    }

    const rows = loadResults(arm).filter(r => HIGH_FANOUT.includes(r.taskId))
    const hits = rows.filter(r => r.workerTimeouts > 0).length
    // The precondition this arm needs to have exercised the lever at all: the
    // worker actually fanned out. Without it a zero-timeout treatment arm is
    // indistinguishable from a fixture that never posed the problem.
    const witnessed = rows.filter(r =>
        arm === 'cap' || arm === 'both' ?
            r.budgetRefusals > 0 || r.projectLookups >= PROJECT_DOCS_BUDGET
        :   r.projectLookups >= WITNESS_LOOKUPS || r.retrievalCalls >= WITNESS_RETRIEVALS
    ).length
    reportArm({
        name: 'research fan-out budget',
        arm,
        reps: rows.length,
        targetShape: 'worker:apis logged >= 1 restart with reason=worker-timeout',
        hits,
        witnessed,
        expect: arm === 'baseline' ? 'some' : 'none'
    })
    console.log(
        `\n  (one arm cannot render the A/B verdict — run the other arm, then:`
            + `\n   bun run scripts/live-research-fanout-budget-ab.ts score ${arm === 'baseline' ? '<arm>' : arm})`
    )
}

// ─── scoring ─────────────────────────────────────────────────────────────────

const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

/** C(n, k), multiplicatively so the intermediate values stay small. */
export function binomial(n: number, k: number): number {
    if (k < 0 || k > n) return 0
    const kk = Math.min(k, n - k)
    let r = 1
    for (let i = 1; i <= kk; i++) r = (r * (n - kk + i)) / i
    return Math.round(r)
}

/**
 * Two-sample permutation test on the difference of means.
 *
 * Re-exported so `live-research-fanout-budget-ab.test.ts` and any other harness
 * keep their import; the implementation moved to `ab-stats.ts`, the one tested
 * home for a statistic that decides a verdict. It was the ONLY tested statistic
 * in scripts/ before that module existed, and the reason MIN_CONTROL_N is 4 —
 * `minAttainableP(3, 3)` is exactly 0.05 — is now stated there as a function.
 */
export {permutationP} from './ab-stats.js'
import {permutationP} from './ab-stats.js'
import {readSection} from './ab-corpus.js'


/**
 * A trial can only ground symbols it actually wrote. `symbols === 0` means the
 * APIS section is a stub — a degraded one-line "Now let me look at…" — and its
 * 0% ungrounded rate is the ABSENCE of a measurement, not clean work.
 */
const scorable = (r: TrialResult): boolean => r.symbols > 0

/**
 * METRIC 3, quality — and the one place this harness has been wrong twice.
 *
 * The n=3 re-run had baseline time out 12/12, of which FIVE trials shipped a
 * one-entry stub carrying zero symbols. Scored as written, those trials gave the
 * baseline a 0.0% fabrication rate on three fixtures, which nothing can beat: a
 * 28-entry section with one unretrieved-but-real symbol "regressed" against a
 * stub sentence. That is not a strict guard, it is a guard measuring nothing and
 * reporting the result as if it had.
 *
 * So the grounding comparison runs over SCORABLE trials only, and when either arm
 * has none for a fixture the comparison is reported UNSCORABLE — which abstains
 * the whole verdict rather than holding. Two ways that could be gamed, both
 * closed here:
 *
 *   - a treatment that degrades to stubs would drop its own bad trials out of the
 *     comparison, so `inv-quality-not-worse` also breaks outright if the
 *     treatment ships MORE empty sections than the baseline;
 *   - signature coverage stays over ALL trials, absolute, unchanged: a treatment
 *     that answers less must not be able to hide its stubs behind a filter.
 */
export function scoreQuality(
    shared: string[],
    base: TrialResult[],
    treat: TrialResult[]
): {qualityBreaks: string[]; unscorable: string[]} {
    const qualityBreaks: string[] = []
    const unscorable: string[] = []
    const rate = (rs: TrialResult[]): number => {
        const sym = rs.reduce((n, r) => n + r.symbols, 0)
        return sym === 0 ? 0 : (rs.reduce((n, r) => n + r.ungroundedSymbols, 0) / sym) * 100
    }

    // Pass 1 — establish what can be tested, so the correction below divides by
    // the tests actually performed rather than the ones this fixture list
    // implies. Three metrics per fixture: signatures, stub count, grounding.
    const cases: {id: string; b: TrialResult[]; t: TrialResult[]}[] = []
    for (const id of shared) {
        const b = base.filter(r => r.taskId === id)
        const t = treat.filter(r => r.taskId === id)
        if (b.length > 0 && t.length > 0) cases.push({id, b, t})
    }
    // Conservative when a fixture's grounding turns out to be unscorable and
    // only 2 of its 3 tests run — over-correcting costs power, under-correcting
    // costs a false FAIL, and only one of those is a verdict.
    const alpha = cases.length === 0 ? QUALITY_ALPHA : QUALITY_ALPHA / (cases.length * 3)

    for (const {id, b, t} of cases) {
        // Only GROUNDING needs a section with symbols on both sides, and it is
        // reported first because it is a fact about the DATA, independent of how
        // many trials ran. Signature coverage and the stub count below are
        // computed over ALL trials on purpose: a treatment that degrades to
        // stubs would otherwise drop its own bad trials out of the comparison
        // and report UNSCORABLE — the exact gaming route the stub tripwire
        // exists to close.
        const bs = b.filter(scorable)
        const ts = t.filter(scorable)
        const groundable = bs.length > 0 && ts.length > 0
        if (!groundable) {
            unscorable.push(
                `${id} grounding: ${bs.length}/${b.length} baseline and`
                    + ` ${ts.length}/${t.length} treatment trial(s) produced a section with symbols`
                    + ` — no fabrication comparison exists on this fixture`
            )
        }

        const floor = 2 / binomial(b.length + t.length, b.length)
        if (floor > alpha) {
            unscorable.push(
                `${id} quality: ${b.length} baseline and ${t.length} treatment trial(s)`
                    + ` — the smallest p an exact test can report here is ${floor.toFixed(3)},`
                    + ` above the corrected ${alpha.toFixed(4)}, so this fixture can neither`
                    + ` break nor hold`
            )
            continue
        }

        const bSigs = b.map(r => r.withSignature)
        const tSigs = t.map(r => r.withSignature)
        const pSig = permutationP(bSigs, tSigs)
        if (mean(tSigs) < mean(bSigs) && pSig <= alpha) {
            qualityBreaks.push(
                `${id} signatures ${mean(bSigs).toFixed(1)}→${mean(tSigs).toFixed(1)}`
                    + ` (p=${pSig.toFixed(3)})`
            )
        }

        // Stubs are 0/1 per trial; a permutation test on the indicator is the
        // same machinery and needs no separate small-sample rule.
        const bEmpty = b.map(r => (scorable(r) ? 0 : 1))
        const tEmpty = t.map(r => (scorable(r) ? 0 : 1))
        const pEmpty = permutationP(bEmpty, tEmpty)
        if (mean(tEmpty) > mean(bEmpty) && pEmpty <= alpha) {
            const n = (xs: number[]): number => xs.reduce((s, x) => s + x, 0)
            qualityBreaks.push(
                `${id} empty sections ${n(bEmpty)}/${b.length}→${n(tEmpty)}/${t.length}`
                    + ` (p=${pEmpty.toFixed(3)})`
            )
        }

        if (!groundable) continue
        // D2 — the SHARE decides direction, not the raw count: a section that
        // grows trips an absolute-count test purely for being bigger. The count
        // is the secondary tripwire, and the test is what makes either binding.
        const bUng = bs.map(r => r.ungroundedSymbols)
        const tUng = ts.map(r => r.ungroundedSymbols)
        const pUng = permutationP(bUng, tUng)
        if (rate(ts) > rate(bs) && mean(tUng) > mean(bUng) && pUng <= alpha) {
            qualityBreaks.push(
                `${id} ungrounded ${rate(bs).toFixed(1)}%→${rate(ts).toFixed(1)}%`
                    + ` (${mean(bUng).toFixed(1)}→${mean(tUng).toFixed(1)}, p=${pUng.toFixed(3)})`
            )
        }
    }
    return {qualityBreaks, unscorable}
}

/**
 * inv-low-fanout-untouched — and the same false pass, one metric down.
 *
 * The n=3 re-run reported this invariant HOLDS having run NO control fixture at
 * all: the loop `continue`d on every control for want of trials, produced zero
 * breaks, and zero breaks read as "controls unchanged". A control invariant with
 * no controls under it is exactly the absence of evidence wearing the shape of
 * evidence — the thing ab-verdict.ts exists to prevent — so a control fixture
 * missing from either arm is now reported as UNMEASURED, which ABSTAINS the
 * verdict instead of passing it.
 *
 * A control that RAN and broke still FAILS: `unmeasured` only decides what
 * happens when there was nothing to measure.
 */
export function scoreLowFanout(
    base: TrialResult[],
    treat: TrialResult[]
): {lowBreaks: string[]; unmeasured: string[]} {
    const lowBreaks: string[] = []
    const unmeasured: string[] = []
    const testable: {id: string; b: TrialResult[]; t: TrialResult[]}[] = []
    const byFixture = (rows: TrialResult[], id: string): TrialResult[] =>
        rows.filter(r => r.taskId === id)
    for (const id of LOW_FANOUT) {
        const b = byFixture(base, id)
        const t = byFixture(treat, id)
        if (b.length === 0 || t.length === 0) {
            unmeasured.push(
                `${id} control: ${b.length} baseline and ${t.length} treatment trial(s)`
                    + ` — inv-low-fanout-untouched has no evidence on this fixture`
            )
            continue
        }
        // A refusal is a categorical fact, not a noisy mean: the CAP lever
        // engaged on a fixture it was never supposed to reach. It needs no
        // significance test and is checked at any n.
        const fired = t.reduce((n, r) => n + r.budgetRefusals, 0)
        if (fired > 0) lowBreaks.push(`${id} budget fired ${fired}× on a low-fan-out task`)

        testable.push({id, b, t})
    }

    // MULTIPLICITY. This is ONE invariant that breaks if ANY of its sub-tests
    // fires, so 0.05 belongs to the invariant, not to each test. Measured on the
    // null corpus: per-test 0.05 across 3 fixtures x 2 metrics gives an 11.7%
    // false-break rate for the invariant — better than the 45.3% of the ratio
    // rule it replaced, but still not the 5% it claims. Bonferroni over the
    // tests ACTUALLY PERFORMED (so a run with fewer controls is not silently
    // penalised) restores it: 1.5% on the same sweep. The sub-tests are
    // positively correlated within a fixture, which only makes this conservative.
    const alpha = testable.length === 0 ? CONTROL_ALPHA : CONTROL_ALPHA / (testable.length * 2)
    // …and the correction feeds back into what counts as measurable. The
    // smallest two-sided p an exact test can report is 2/C(nb+nt, nb); a fixture
    // whose floor sits above the CORRECTED alpha can neither break nor hold, and
    // saying HOLDS there is arithmetic wearing the shape of evidence. With 3
    // controls the corrected alpha is 0.0083, so n=4 per arm (floor 2/70 =
    // 0.029) is NOT enough and n=5 (2/252 = 0.0079) is — a threshold derived
    // from the test, never chosen to suit a run.
    const measurable = testable.filter(({id, b, t}) => {
        const floor = 2 / binomial(b.length + t.length, b.length)
        if (floor <= alpha) return true
        unmeasured.push(
            `${id} control: ${b.length} baseline and ${t.length} treatment trial(s)`
                + ` — the smallest p an exact test can report here is ${floor.toFixed(3)},`
                + ` above the corrected ${alpha.toFixed(4)}, so this fixture can neither`
                + ` break nor hold`
        )
        return false
    })
    for (const {id, b, t} of measurable) {
        const bw = b.map(r => r.apisWallMs)
        const tw = t.map(r => r.apisWallMs)
        const be = b.map(r => r.entries)
        const te = t.map(r => r.entries)
        // Directional: only a treatment that is SLOWER, or that lost entries,
        // can break a control. Two-sided p with a direction filter is exactly
        // the shape the null-control sweep calibrated.
        const slower = permutationP(bw, tw)
        if (mean(tw) > mean(bw) && slower <= alpha) {
            lowBreaks.push(
                `${id} wall ${(mean(bw) / 1000).toFixed(0)}s→${(mean(tw) / 1000).toFixed(0)}s`
                    + ` (p=${slower.toFixed(3)})`
            )
        }
        const thinner = permutationP(be, te)
        if (mean(te) < mean(be) && thinner <= alpha) {
            lowBreaks.push(
                `${id} entries ${mean(be).toFixed(1)}→${mean(te).toFixed(1)}`
                    + ` (p=${thinner.toFixed(3)})`
            )
        }
    }
    return {lowBreaks, unmeasured}
}

/**
 * A trial that produced an answer someone could use. Both halves matter: a
 * DEGRADED trial was killed on its last attempt, and a zero-symbol trial shipped
 * a stub sentence.
 */
export const usableAnswer = (r: TrialResult): boolean => !r.degraded && r.symbols > 0

/**
 * METRIC 2, wall clock — and why the pre-registered version of it must not be
 * read as a lever benefit.
 *
 * Baseline trials are RIGHT-CENSORED. A trial killed at 3x240s did not take 720s
 * to answer; it never answered, and 720s is a lower bound truncated by the cap
 * that is itself under test. The n=3 run compared a mean over 12/12 such trials
 * against an arm where none were truncated and reported `610s → 608s HOLDS`.
 * That number is arithmetic across two different scales.
 *
 * So the censored mean is DESCRIPTIVE ONLY, printed with its censoring rate and
 * never an invariant.
 *
 * The obvious replacement — mean over the trials that DID answer — is censored
 * too, just less visibly, and it took the v2 corpus to show it. Baseline answered
 * in 4 of 12 trials, and those four are precisely the ones that got there in two
 * attempts (325-434s); every trial that needed a third hit the 720s cap and
 * answered nothing. Conditioning on answering therefore selects the baseline's
 * fastest third and hides its failures, and on this corpus it reported the
 * progress arm 390s → 637s WORSE while that arm answered 12/12. Survivorship in
 * one arm is not a comparison either.
 *
 * So the invariant is evaluated only on fixtures where EVERY trial in BOTH arms
 * produced a usable answer — no selection on either side — and the answer RATE is
 * printed beside it, since "how often it answers at all" is the thing that
 * conditioning throws away. A treatment cannot buy its way in by degrading:
 * degrades break inv-no-new-degrade and stubs break inv-quality-not-worse's
 * empty-section test, both over ALL trials.
 */
export function scoreTimeToAnswer(
    shared: string[],
    base: TrialResult[],
    treat: TrialResult[]
): {invariant: Invariant; unmeasured: string[]; descriptive: string[]} {
    const pick = (rows: TrialResult[], id: string): TrialResult[] =>
        rows.filter(r => r.taskId === id)
    const note = (rows: TrialResult[], label: string): string => {
        const shown = shared.flatMap(id => pick(rows, id))
        const cut = shown.filter(r => r.workerTimeouts > 0).length
        const answered = shown.filter(usableAnswer).length
        return (
            `${label} mean ${(mean(shown.map(r => r.apisWallMs)) / 1000).toFixed(0)}s`
            + ` over ${shown.length} trial(s), ${cut} truncated by the cap;`
            + ` reached a usable answer ${answered}/${shown.length}`
        )
    }
    const descriptive = [
        'wall clock, CENSORED — descriptive only, NOT an invariant and NOT a lever benefit:',
        `    ${note(base, 'baseline ')}`,
        `    ${note(treat, 'treatment')}`,
        '    a truncated distribution against an untruncated one is not a comparison'
    ]
    const complete = (rows: TrialResult[], id: string): boolean => {
        const rs = pick(rows, id)
        return rs.length > 0 && rs.every(usableAnswer)
    }
    const comparable = shared.filter(id => complete(base, id) && complete(treat, id))
    const fixtureMean = (rows: TrialResult[], id: string): number =>
        mean(pick(rows, id).map(r => r.apisWallMs))
    const bMean = mean(comparable.map(id => fixtureMean(base, id)))
    const tMean = mean(comparable.map(id => fixtureMean(treat, id)))
    if (comparable.length === 0) {
        return {
            invariant: {
                label: 'inv-time-to-answer-lower',
                ok: true,
                unmeasured: true,
                detail: 'no fixture answered in EVERY trial of both arms — see the note above'
            },
            unmeasured: [
                'time-to-answer: no shared fixture produced a usable answer in every trial of'
                    + ' BOTH arms, so any comparison would condition on which trials answered'
                    + ' — an arm that answers a third of the time would score as the fast one'
            ],
            descriptive
        }
    }
    // WAS `ok: tMean < bMean` — a strict inequality on means with no variance
    // model, i.e. the exact shape [[quality-invariant-false-break]] and
    // [[lowfanout-invariant-noise-detector]] were written about, and the A/A
    // caught it: 114/200 = 57.0% false-break on pure-baseline splits of
    // `~/tmp/research-fanout-ab-v3`. At n=21 a coin flip is what it should be —
    // two samples of the same arm have no reason to tie.
    //
    // It was also demanding the wrong thing. This header already says wall clock
    // is censored and is NOT a lever benefit; requiring the treatment to be
    // FASTER made a benefit claim out of it anyway, and nexttask 9 rules that
    // claim out on its own terms (baseline's 720s trials are pinned at the 3x240s
    // cap, so the comparison is an artifact of the cap). What is worth guarding is
    // the harm direction: an arm that pushes a deadline outward must not end up
    // significantly SLOWER to a usable answer. Hence a directional permutation
    // test over per-trial wall — same repair, same discipline, calibrated on
    // treatment-free data.
    const bw = comparable.flatMap(id => pick(base, id).map(r => r.apisWallMs))
    const tw = comparable.flatMap(id => pick(treat, id).map(r => r.apisWallMs))
    const floor = 2 / binomial(bw.length + tw.length, bw.length)
    const shift = `${(bMean / 1000).toFixed(0)}s → ${(tMean / 1000).toFixed(0)}s`
        + ` over ${comparable.length} fixture(s) that answered in every trial of both`
        + ` arms (${comparable.join(', ')})`
    if (floor > VERDICT_ALPHA) {
        return {
            invariant: {
                label: 'inv-time-to-answer-not-worse',
                ok: true,
                unmeasured: true,
                detail:
                    `${shift} — but the smallest p an exact test can report at`
                    + ` ${bw.length}v${tw.length} trials is ${floor.toFixed(3)}, above`
                    + ` ${VERDICT_ALPHA}, so this can neither break nor hold`
            },
            unmeasured: [
                `time-to-answer: ${bw.length} baseline and ${tw.length} treatment trial(s) on`
                    + ` complete fixtures — too few for the test to resolve anything`
            ],
            descriptive
        }
    }
    const slower = permutationP(bw, tw)
    return {
        invariant: {
            label: 'inv-time-to-answer-not-worse',
            ok: !(mean(tw) > mean(bw) && slower <= VERDICT_ALPHA),
            detail: `${shift} (p=${slower.toFixed(3)}, breaks only on a significant SLOWDOWN)`
        },
        unmeasured: [],
        descriptive
    }
}

/**
 * ADMISSIBILITY (nexttask 9, Phase A.1).
 *
 * A trial is admissible evidence for the QUALITY comparison only if it produced a
 * non-degraded section carrying at least one extracted symbol. The n=3 FAIL that
 * sent this investigation down the grounding-corpus path was a zero denominator: a
 * baseline trial that shipped a one-sentence stub has an ungrounded rate of
 * 0/0 = 0.0%, which then scores as better grounded than a 28-entry section.
 *
 * Two rules keep this from becoming a filter that hides a regression:
 *
 *   - it applies to the quality comparison ONLY. Metric 1 (timeouts) and metric 2
 *     (delivered work) are computed over every measurable trial, because a
 *     treatment that ships stubs must show up as a loss there, not vanish into an
 *     exclusion;
 *   - the counts are PRINTED, per arm, with the reason. An unreported exclusion
 *     invalidates the run (`inv-admissibility-reported`).
 */
const isAdmissible = (r: TrialResult): boolean => !isUnmeasurable(r) && usableAnswer(r)

/** nexttask 9's pre-registered floor: below this an arm cannot render a quality verdict. */
const N_MIN_ADMISSIBLE = 12

interface Ledger {
    arm: string
    recorded: number
    degraded: number
    zeroSymbol: number
    admissible: number
}

function ledger(arm: string, rows: TrialResult[]): Ledger {
    const measurable = rows.filter(r => !isUnmeasurable(r))
    return {
        arm,
        recorded: rows.length,
        degraded: measurable.filter(r => r.degraded).length,
        zeroSymbol: measurable.filter(r => !r.degraded && r.symbols === 0).length,
        admissible: measurable.filter(isAdmissible).length
    }
}

const ledgerLine = (l: Ledger): string =>
    `  admissible-n ${l.arm.padEnd(9)} ${String(l.admissible).padStart(3)} of ${String(l.recorded).padStart(3)}`
    + ` scored  |  excluded: ${l.degraded} degraded, ${l.zeroSymbol} zero-symbol`

/**
 * A/A CALIBRATION (nexttask 9, Phase A.3), read back into the A/B report.
 *
 * `inv-aa-calibrated`: an A/B result is not believable until the same instrument
 * has been run with BOTH arms set to baseline and its false-break rate measured
 * under 5%. The number is written by `--aa` and reproduced here, because a
 * calibration that lives only in a chat log is a calibration nobody can check.
 */
interface AaCalibration {
    corpus: string
    splits: number
    perArm: number
    breaks: number
    rate: number
    byInvariant: Record<string, number>
    at: string
}

const AA_PATH = path.join(ROOT, 'aa-calibration.json')

function loadAaCalibration(): AaCalibration | null {
    if (!fs.existsSync(AA_PATH)) return null
    return JSON.parse(fs.readFileSync(AA_PATH, 'utf8')) as AaCalibration
}

/**
 * Significance level for the two verdict-level invariants that compare the arms
 * directly — degrade rate and time to answer. Same 0.05 the other two use; they
 * carry their own Bonferroni over their own sub-tests, and these two are one test
 * each, so the correction here is the identity.
 */
const VERDICT_ALPHA = 0.05

/**
 * `inv-no-new-degrade`, repaired.
 *
 * WAS `highTreat.every(r => !r.degraded)` — an ABSOLUTE zero, on a corpus where
 * the baseline itself degrades 8 trials in 12. The A/A caught it at **200/200 =
 * 100.0%**: feed the instrument two halves of the same baseline and it reports
 * "the treatment introduced degrades" every single time, because the rule never
 * looked at the baseline at all. The label said NEW; the code said ANY.
 *
 * Repaired to what the label claims: the treatment may not degrade SIGNIFICANTLY
 * MORE OFTEN than the baseline, by a directional permutation test on the 0/1
 * indicator. The direction matters — an arm that degrades LESS (the whole point
 * of the progress deadline) must not be penalised for degrading at all — and the
 * gaming route stays shut, because a treatment that degrades more still breaks
 * this, and one that ships stubs instead breaks `inv-quality-not-worse`'s
 * empty-section test over ALL trials.
 */
function degradeInvariant(base: TrialResult[], treat: TrialResult[]): Invariant {
    const b: number[] = base.map(r => (r.degraded ? 1 : 0))
    const t: number[] = treat.map(r => (r.degraded ? 1 : 0))
    const counts = `${b.reduce((n, x) => n + x, 0)}/${b.length} baseline`
        + ` → ${t.reduce((n, x) => n + x, 0)}/${t.length} treatment`
    if (b.length === 0 || t.length === 0) {
        return {
            label: 'inv-no-new-degrade',
            ok: true,
            unmeasured: true,
            detail: 'one arm has no high-fan-out trials — nothing to compare'
        }
    }
    const floor = 2 / binomial(b.length + t.length, b.length)
    if (floor > VERDICT_ALPHA) {
        return {
            label: 'inv-no-new-degrade',
            ok: true,
            unmeasured: true,
            detail:
                `${counts} — the smallest p an exact test can report at these n is`
                + ` ${floor.toFixed(3)}, above ${VERDICT_ALPHA}: can neither break nor hold`
        }
    }
    const p = permutationP(b, t)
    return {
        label: 'inv-no-new-degrade',
        ok: !(mean(t) > mean(b) && p <= VERDICT_ALPHA),
        detail: `${counts} degraded (p=${p.toFixed(3)}, breaks only on a significant RISE)`
    }
}

/**
 * Everything the verdict rests on, computed without printing, so the A/A can put
 * pure-baseline data through the SAME code path the A/B verdict uses. A
 * calibration run against a re-implementation of the scorer measures the
 * re-implementation.
 */
interface Evaluation {
    shared: string[]
    excluded: string[]
    qualityBreaks: string[]
    unscorable: string[]
    lowBreaks: string[]
    lowUnmeasured: string[]
    wall: ReturnType<typeof scoreTimeToAnswer>
    highBase: TrialResult[]
    highTreat: TrialResult[]
    reps: number
    invariants: Invariant[]
    unmeasured: string[]
}

function evaluate(base: TrialResult[], treat: TrialResult[]): Evaluation {
    const byFixture = (rows: TrialResult[], id: string): TrialResult[] =>
        rows.filter(r => r.taskId === id)
    const highBase = base.filter(r => HIGH_FANOUT.includes(r.taskId))
    const highTreat = treat.filter(r => HIGH_FANOUT.includes(r.taskId))

    // METRIC 2 — wall clock, over the fixtures BOTH arms actually ran AND both
    // actually fanned out on.
    //
    // D1: `witnessed` used to gate metric 1 only, so a fixture that never posed
    // the problem still set the bar for metrics 2 and 3. TASK_0022's baseline
    // made ONE project lookup and still contributed 234s against the treatment's
    // 405s, and 24→23 signatures as a "quality break", on a lever it never
    // exercised.
    const posed = (rows: TrialResult[], id: string): boolean =>
        byFixture(rows, id).some(
            r => r.projectLookups >= WITNESS_LOOKUPS || r.retrievalCalls >= WITNESS_RETRIEVALS
        )
    const shared = HIGH_FANOUT.filter(
        id =>
            byFixture(base, id).length > 0
            && byFixture(treat, id).length > 0
            && posed(base, id)
            && posed(treat, id)
    )
    const excluded = HIGH_FANOUT.filter(
        id =>
            byFixture(base, id).length > 0 && byFixture(treat, id).length > 0 && !shared.includes(id)
    )
    // Controls are checked for FABRICATION too. They are excluded from metrics
    // 2-3 as a lever BENEFIT — they never posed the problem, so a wall-clock or
    // coverage win there measures nothing — but collateral damage is not a
    // benefit, and quality was the one invariant that never looked. The v3 run
    // put real numbers in that blind spot: TASK_0001 ungrounded 0.0→2.0 and
    // TASK_0004 0.7→2.7, while the invariant printed "did not rise on any
    // fixture". "Did not look" must not render as "did not rise".
    const qualityFixtures = [
        ...shared,
        ...LOW_FANOUT.filter(
            id => byFixture(base, id).length > 0 && byFixture(treat, id).length > 0
        )
    ]
    const {qualityBreaks, unscorable} = scoreQuality(qualityFixtures, base, treat)
    const {lowBreaks, unmeasured: lowUnmeasured} = scoreLowFanout(base, treat)
    const wall = scoreTimeToAnswer(shared, base, treat)

    const invariants: Invariant[] = [
        {
            label: 'inv-quality-not-worse',
            ok: qualityBreaks.length === 0,
            detail:
                qualityBreaks.length > 0 ? qualityBreaks.join('; ')
                : unscorable.length > 0 ?
                    `signature coverage held; grounding NOT EVALUATED on ${unscorable.length} fixture(s)`
                :   'signature coverage held and fabricated symbols did not rise on any fixture'
        },
        degradeInvariant(highBase, highTreat),
        {
            label: 'inv-low-fanout-untouched',
            ok: lowBreaks.length === 0,
            ...(lowBreaks.length === 0 && lowUnmeasured.length > 0 ? {unmeasured: true} : {}),
            detail:
                lowBreaks.length > 0 ? lowBreaks.join('; ')
                : lowUnmeasured.length > 0 ?
                    `${lowUnmeasured.length} control fixture(s) were not run — nothing to compare`
                :   'controls unchanged'
        },
        wall.invariant
    ]

    return {
        shared,
        excluded,
        qualityBreaks,
        unscorable,
        lowBreaks,
        lowUnmeasured,
        wall,
        highBase,
        highTreat,
        reps: Math.min(highBase.length, highTreat.length),
        invariants,
        unmeasured: [...unscorable, ...lowUnmeasured, ...wall.unmeasured]
    }
}

/**
 * TRUE A/A (nexttask 9, Phase A.3). Both "arms" are baseline trials, so every
 * break the instrument reports is false by construction, and the rate at which it
 * reports one is its false-break rate.
 *
 * Split by TRIAL INDEX within each fixture, not across fixtures: the fixtures
 * differ from each other by far more than the arms do, so a split that put
 * TASK_0017 on one side and TASK_0020 on the other would measure the fixture, not
 * the instrument. Every split keeps both halves balanced per fixture — exactly the
 * structure a real A/B has.
 *
 * `scripts/lowfanout-null-control.ts` did this for two invariants over 6-vs-6
 * splits of a dedicated null corpus; this runs the WHOLE verdict, including the
 * invariants that only exist inside `score`.
 */
function calibrateAa(splits: number): void {
    const base = loadResults('baseline')
    if (base.length === 0) {
        console.error(`no baseline trials under ${path.join(ROOT, 'results')} — run that arm first.`)
        process.exit(2)
    }
    const byId = new Map<string, TrialResult[]>()
    for (const r of base) byId.set(r.taskId, [...(byId.get(r.taskId) ?? []), r])
    const splittable = [...byId.entries()].filter(([, rs]) => rs.length >= 2)
    if (splittable.length === 0) {
        console.error('no fixture has >=2 baseline trials — an A/A needs both halves per fixture.')
        process.exit(2)
    }
    const perArm = splittable.reduce((n, [, rs]) => n + Math.floor(rs.length / 2), 0)

    console.log(`=== A/A CALIBRATION — both arms are baseline, every break is false by construction`)
    console.log(`  corpus: ${ROOT}`)
    console.log(
        `  ${base.length} baseline trials over ${splittable.length} splittable fixture(s)`
            + ` → ${perArm} per half, ${splits} random splits`
    )

    const byInvariant: Record<string, number> = {}
    let breaks = 0
    for (let i = 0; i < splits; i++) {
        const a: TrialResult[] = []
        const b: TrialResult[] = []
        for (const [, rows] of splittable) {
            // Shuffle within the fixture, then deal alternately: both halves get
            // the same fixture mix and the same n, and an odd trial is dropped
            // rather than handed to one side.
            const shuffled = [...rows].sort(() => Math.random() - 0.5)
            const half = Math.floor(shuffled.length / 2)
            a.push(...shuffled.slice(0, half))
            b.push(...shuffled.slice(half, half * 2))
        }
        const ev = evaluate(a, b)
        const broken = ev.invariants.filter(inv => !inv.ok)
        if (broken.length > 0) breaks++
        for (const inv of broken) byInvariant[inv.label] = (byInvariant[inv.label] ?? 0) + 1
    }

    const rate = breaks / splits
    const calibration: AaCalibration = {
        corpus: ROOT,
        splits,
        perArm,
        breaks,
        rate,
        byInvariant,
        at: new Date().toISOString()
    }
    fs.writeFileSync(AA_PATH, `${JSON.stringify(calibration, null, 4)}\n`)

    console.log('')
    console.log(`  FALSE-BREAK RATE  ${breaks}/${splits} = ${(rate * 100).toFixed(1)}%`)
    for (const [label, n] of Object.entries(byInvariant).sort((x, y) => y[1] - x[1])) {
        console.log(`    ${label.padEnd(28)} ${n}/${splits} = ${((n / splits) * 100).toFixed(1)}%`)
    }
    console.log(`\n  written to ${AA_PATH}`)
    if (rate >= AA_MAX_FALSE_BREAK) {
        console.log(
            `\n*** NOT CALIBRATED — ${(rate * 100).toFixed(1)}% >= the ${(AA_MAX_FALSE_BREAK * 100).toFixed(0)}%`
                + ` ceiling. Any A/B verdict on this instrument is noise. Fix the instrument.`
        )
        process.exitCode = 1
        return
    }
    console.log(
        `\nCALIBRATED — under the ${(AA_MAX_FALSE_BREAK * 100).toFixed(0)}% ceiling.`
            + ' An A/B on this instrument may now be believed.'
    )
}

/** nexttask 9: "measured false-break rate must be < 5% before any A/B result is believed". */
const AA_MAX_FALSE_BREAK = 0.05

function score(treatment: Arm): void {
    const base = loadResults('baseline')
    const treat = loadResults(treatment)
    if (base.length === 0 || treat.length === 0) {
        console.error(
            `no recorded trials for ${base.length === 0 ? 'baseline' : treatment}`
                + ` under ${path.join(ROOT, 'results')} — run that arm first.`
        )
        process.exit(2)
    }
    const byFixture = (rows: TrialResult[], id: string): TrialResult[] =>
        rows.filter(r => r.taskId === id)

    console.log(`=== live-research-fanout-budget-ab — baseline vs ${treatment}`)
    console.log(
        '  fixture     arm        n  timeouts  apisWall(s)  lookups  entries  sig  ungrounded  synth'
    )
    for (const id of [...HIGH_FANOUT, ...LOW_FANOUT]) {
        for (const [label, rows] of [
            ['baseline', byFixture(base, id)],
            [treatment, byFixture(treat, id)]
        ] as const) {
            if (rows.length === 0) continue
            console.log(
                `  ${id.padEnd(11)} ${label.padEnd(9)} ${String(rows.length).padStart(2)}`
                    + `  ${rows.filter(r => r.workerTimeouts > 0).length}/${rows.length}`.padStart(9)
                    + `  ${(mean(rows.map(r => r.apisWallMs)) / 1000).toFixed(0).padStart(10)}`
                    + `  ${mean(rows.map(r => r.projectLookups)).toFixed(1).padStart(7)}`
                    + `  ${mean(rows.map(r => r.entries)).toFixed(1).padStart(7)}`
                    + `  ${mean(rows.map(r => r.withSignature)).toFixed(1).padStart(4)}`
                    + `  ${mean(rows.map(r => r.ungroundedSymbols)).toFixed(1).padStart(10)}`
                    + `  ${mean(rows.map(r => r.synthesizedApis)).toFixed(1).padStart(5)}`
            )
        }
    }

    const ev = evaluate(base, treat)
    if (ev.excluded.length > 0) {
        console.log(
            `\n  excluded from metrics 2-3 (never posed the problem in one or both arms):`
                + ` ${ev.excluded.join(', ')}`
        )
    }
    for (const u of ev.unscorable) console.log(`\n  quality UNSCORABLE — ${u}`)
    for (const u of ev.lowUnmeasured) console.log(`\n  control UNMEASURED — ${u}`)
    console.log('')
    for (const d of ev.wall.descriptive) console.log(`  ${d}`)

    // ADMISSIBILITY LEDGER — printed before the verdict, always, whatever it says.
    const ledgers = [ledger('baseline', base), ledger(treatment, treat)]
    console.log('')
    for (const l of ledgers) console.log(ledgerLine(l))
    const thin = ledgers.filter(l => l.admissible < N_MIN_ADMISSIBLE)

    const aa = loadAaCalibration()
    console.log(
        aa === null ?
            `  A/A calibration: NOT ON RECORD (${AA_PATH} missing) — run \`--aa\` first`
        :   `  A/A calibration: ${(aa.rate * 100).toFixed(1)}% false-break`
                + ` (${aa.breaks}/${aa.splits} same-arm splits, ${aa.perArm}/half, ${aa.at.slice(0, 10)})`
    )

    const invariants: Invariant[] = [
        ...ev.invariants,
        // Not a property of the lever — a property of THIS RUN's evidence. Both are
        // stated as invariants so a verdict cannot be printed without them, and both
        // are placed last: a MEASURED break in the invariants above still FAILs
        // first, because a treatment that degrades to stubs must not be able to
        // ABSTAIN its way out by making its own trials inadmissible.
        {
            label: 'inv-admissibility-reported',
            ok: true,
            ...(thin.length > 0 ? {unmeasured: true} : {}),
            detail:
                thin.length > 0 ?
                    `${thin.map(l => `${l.arm} has ${l.admissible}`).join(', ')} admissible trial(s),`
                        + ` below the pre-registered n_min=${N_MIN_ADMISSIBLE}`
                :   ledgers.map(l => `${l.arm} ${l.admissible}/${l.recorded}`).join(', ')
                        + ' admissible; exclusions reported above'
        },
        {
            label: 'inv-aa-calibrated',
            ok: aa === null || aa.rate < AA_MAX_FALSE_BREAK,
            ...(aa === null ? {unmeasured: true} : {}),
            detail:
                aa === null ?
                    'no A/A on record — the false-break rate of this instrument is unknown'
                : aa.rate < AA_MAX_FALSE_BREAK ?
                    `${(aa.rate * 100).toFixed(1)}% < ${(AA_MAX_FALSE_BREAK * 100).toFixed(0)}% on`
                        + ` ${aa.splits} same-arm splits`
                :   `${(aa.rate * 100).toFixed(1)}% false-break — this instrument reports noise`
        }
    ]

    reportAb({
        name: `research fan-out budget (baseline vs ${treatment})`,
        reps: ev.reps,
        targetShape: 'worker:apis logged >= 1 restart with reason=worker-timeout',
        baselineHits: ev.highBase.filter(r => r.workerTimeouts > 0).length,
        treatmentHits: ev.highTreat.filter(r => r.workerTimeouts > 0).length,
        invariants,
        unmeasured: [
            ...ev.unmeasured,
            ...(aa === null ? ['A/A false-break rate not on record — run `--aa`'] : []),
            ...thin.map(
                l =>
                    `${l.arm} has ${l.admissible} admissible trial(s) (< n_min=${N_MIN_ADMISSIBLE}):`
                    + ` ${l.degraded} degraded, ${l.zeroSymbol} zero-symbol excluded`
            )
        ]
    })
}

// ─── entry ───────────────────────────────────────────────────────────────────

// Guarded so the scorer can be imported and unit-tested. Before this, importing
// the module ran the CLI and exited 1 on a missing mode argument, which is why
// the quality comparison had no test while it was wrong twice.
if (import.meta.main) {
    const [modeArg, ...rest] = process.argv.slice(2)
    const only = rest.filter(a => a.startsWith('TASK_'))
    const trials = Number(rest.find(a => /^\d+$/.test(a)) ?? '1')

    if (modeArg === '--aa' || modeArg === 'aa') {
        calibrateAa(Number(rest.find(a => /^\d+$/.test(a)) ?? '200'))
    } else if (modeArg === 'score') {
        const treatment = (rest.find(a => ARMS.includes(a as Arm)) ?? 'cap') as Arm
        score(treatment)
    } else if (ARMS.includes(modeArg as Arm)) {
        await runArm(modeArg as Arm, trials, only)
    } else {
        console.error(
            `usage: live-research-fanout-budget-ab.ts <${ARMS.join('|')}|score|--aa> [TRIALS] [TASK_00NN …]`
        )
        process.exit(1)
    }
}
