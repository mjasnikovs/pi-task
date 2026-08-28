/**
 * LIVE A/B — what thinking level should each reasoning group's DEFAULT be?
 *
 * `DEFAULT_REASONING_TABLE` (src/config/reasoning.ts) ships all-`inherit` on
 * purpose: a cell filled in from intuition is worse than one that admits it
 * knows nothing. This harness is how a cell earns a value.
 *
 * WHY THIS FILE WAS REWRITTEN
 * ---------------------------
 * Its first version built every prompt from a string literal — including the
 * group it called "the CALIBRATION CASE", which sent
 * `AUTO_DECOMPOSE_PROMPT('Implement @fx', '')`: a ~40-character one-liner with
 * no @-expansion, no clarifications and no requirements ledger. The
 * magicknumbers.md result it claimed to calibrate against came from a ~20 KB
 * inlined spec. By its own docstring's rule that meant the harness was wrong,
 * and it was.
 *
 * The repo already had the convention:
 *   - `src/task/__fixtures__/planning/mx5-project.md` — byte-identical copy of
 *     the real spec; its README says do not "improve" it.
 *   - `scripts/ab-planning.ts` `loadPlanningFixture` → the PRODUCTION
 *     `expandFeatureMentions`; `extractRequirementsNew` → the real ledger.
 *   - `scripts/ab-corpus.ts` `openRecordedRun` → a real 57-task run whose every
 *     phase INPUT is on disk.
 * Capture the spec, rebuild the prompt with production code. Never hand-write a
 * prompt.
 *
 * WHAT IT SCORES, IN THIS ORDER. Speed is LAST, and that ordering is the design.
 * magicknumbers.md measured the decompose child on this model with the same one
 * knob: thinking off answered 1/10 (200+ tool calls, no plan) while thinking on
 * answered 8/8. The cheap arm is the one that fails, so a harness that ranked on
 * wall clock would pick it every time.
 *
 *   1. NON-TERMINATION — no usable answer within the child's own guards.
 *   2. USABLE OUTPUT — the phase's OWN parser accepts it. Production validators,
 *      imported. A harness that reimplements the check measures the harness.
 *   3. WALL CLOCK — decisive ONLY when neither quality axis separates the arms.
 *
 * TWO-WAY VERDICT: `off` | `medium`. Every run names one of the two levels it
 * measured. `inherit` is not on the ballot: this harness exists to answer which
 * level a group wants, and "no answer" is not one of the levels.
 *
 * The ladder, in order, first rung that fires wins:
 *   1. one arm is significantly WORSE on non-termination or usable output
 *      → the other arm. A quality loss ends it, whatever the clock says.
 *   2. quality is level and one arm is significantly FASTER → that arm.
 *   3. nothing separates them → `off`, by a stated prior, NOT by measurement:
 *      thinking that buys no measurable quality and no measurable time is
 *      tokens spent for nothing. The cell's comment MUST say the rung it came
 *      down on, so a cell decided by rung 3 is never mistaken for a win.
 *
 * WHAT IS HELD FIXED — this list IS the validity of the run:
 *   - ONE MODEL per invocation. The local run scripts all bind :8080 with
 *     --network host, so sequencing is structural. A swap MID-run is caught by
 *     watching /props — see MODEL_IDENTITY_URL.
 *   - BYTE-IDENTICAL PROMPT per rep, built once and handed to both arms.
 *   - REPS ARE DIFFERENT REAL TASKS, not repeats of one prompt. 57 recorded
 *     tasks beat 20 replays of a single synthetic string.
 *   - INTERLEAVED arm order, so drift cannot load onto one arm.
 *   - pi-task config PINNED via PI_TASK_CONFIG_PATH. NOTE: bunfig's
 *     test-ambient-isolation preload covers `bun test` only, NOT `bun run`, so
 *     this harness must pin it itself or it measures the developer's machine.
 *
 * Run:
 *   PI_BIN=$(command -v pi) PI_TASK_CONFIG_PATH=$(mktemp) \
 *     bun run scripts/live-reasoning-group-ab.ts <group> <modelLabel> [REPS]
 *
 * Exit: 0 a verdict, 2 ABSTAIN — preconditions unmet, the model changed mid-run,
 * the corpus is missing, or neither arm produced anything usable.
 */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runPhaseChild, type PhaseDeps} from '../src/task/child-runner.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {runFocusedExtraction} from '../src/workers/focused-extractor.js'
import {
    REFINE_PROMPT,
    RESEARCH_APIS_PROMPT,
    RESEARCH_CONTEXT_PROMPT,
    RESEARCH_FILES_PROMPT,
    RESEARCH_TOOLING_PROMPT
} from '../src/task/prompts.js'
import {buildVerifyPrompt, VERIFY_TOOLS} from '../src/task/verify-work.js'
import {AUTO_DECOMPOSE_PROMPT} from '../src/task/auto-prompts.js'
import {buildRequirementsLedger} from '../src/task/requirements.js'
import {
    RESEARCH_SEARCH_HINT,
    SINGLE_READ_EXTENSION_PATH,
    apisWorkerChannels,
    scopedToolingGoal,
    searchConfigured
} from '../src/task/phases.js'
import {REASONING_GROUPS, REASONING_ON_LEVEL, type ReasoningGroup} from '../src/config/reasoning.js'
import {loadPlanningFixture, extractRequirementsNew} from './ab-planning.js'
import {openRecordedRun, type TaskRecord} from './ab-corpus.js'
import {requirePreconditions, abstainMidRun, llamaModelIdentity} from './ab-preflight.js'
import {gateStimuli, type GateStimulus} from './reasoning-ab-gate-truth.js'
import {
    filesRecallStimuli,
    filesAnswered,
    groundedPaths,
    namedRecall,
    treePaths,
    type FilesStimulus
} from './reasoning-ab-files-truth.js'
import {extractTree, implTasks} from './impl-ab-corpus.js'
import {extractionStimuli} from './reasoning-ab-extraction-truth.js'
import {
    scoreTooling,
    toolingRunnable,
    toolingStimuli,
    type ToolingStimulus
} from './reasoning-ab-tooling-truth.js'
import {minAttainableP} from './ab-stats.js'
import type {ArmStats} from './reasoning-ab-decide.js'
import {ARMS as ARMS_, decide} from './reasoning-ab-decide.js'
import {
    contextEmittedBullets,
    GROUP_SCORERS,
    planningPlanFaithful,
    verdictWord,
    gateVerdictCorrect,
    verdictParserContractProblem
} from './reasoning-ab-scorers.js'
import {EXIT_CODE} from './ab-verdict.js'

/**
 * Watched instead of ab-preflight's DEFAULT_MODEL_HEALTH_URL, and this is not a
 * detail. This harness swaps containers between models by design, so "the
 * instrument changed under the run" is its most likely way to produce a
 * confident wrong number.
 *
 * `watch.unchanged()` compares the probe BODY across ticks, so the endpoint has
 * to be both identifying and byte-stable. Measured on llama-server b10618:
 *
 *   /health      `{"status":"ok"}` for EVERY model. Stable, but cannot tell two
 *                models apart, so the guard silently guarantees nothing.
 *   /v1/models   names the model — and carries a `"created"` UNIX timestamp that
 *                ticks every second, so equality NEVER holds and every trial
 *                abstains as a phantom restart.
 *   /props       names `model_path` AND `build_info`, byte-identical across a
 *                generation. This one.
 */
const MODEL_IDENTITY_URL = process.env.AB_MODEL_URL ?? 'http://127.0.0.1:8080/props'

/**
 * Probe budget. Far above ab-preflight's 3s default: these run BETWEEN TRIALS on
 * a box whose single GPU has just been saturated for minutes, and a busy
 * llama-server answers late, not never.
 */
const PROBE_TIMEOUT_MS = 20_000

/** The recorded run supplying real phase inputs. */
const CORPUS_ROOT = process.env.AB_CORPUS ?? path.join(os.homedir(), 'hub', 'mx5')

/**
 * The child's context window, passed EXPLICITLY rather than read from
 * models.json.
 *
 * The first version passed 0 through a double cast, which disarms the stall
 * detector's context-churn rule — the guard added by the very commit behind the
 * magicknumbers measurement, so the harness was silently running with a weaker
 * child than production. Reading it from the user's models.json would fix the
 * number and reintroduce an ambient-config dependency, so it is an argument with
 * a printed default instead.
 */
const CONTEXT_WINDOW = Number(process.env.AB_CONTEXT_WINDOW ?? 120_000)

/**
 * Where the gate group extracts the trees it scores verdicts against.
 *
 * Under TMPDIR so the container's own mount holds them: a tree is a full corpus
 * checkout, and one per trial on the host's / would fill it.
 */
const GATE_TREE_ROOT = path.join(os.tmpdir(), 'pi-task-gate-trees')

/** How long a screening VERIFY may run. The same wall the impl harness uses. */
const GATE_VERIFY_TIMEOUT_MS = Number(process.env.AB_VERIFY_TIMEOUT_MS ?? 180_000)

/**
 * Restrict the gate screen to an already-known task list.
 *
 * A SPEED knob, never a trust knob. Every task named is still screened — a
 * screen result is a fact about a tree plus its node_modules, and both move —
 * so a stale name is dropped and logged rather than believed.
 */
const GATE_ONLY: readonly string[] = (process.env.AB_GATE_TASKS ?? '')
    .split(',')
    .map(x => x.trim())
    .filter(x => x.length > 0)

/**
 * How many screened tasks to build stimuli from. Each becomes TWO stimuli (one
 * per tree) and each stimulus is run by both arms, so the default 10 is 40
 * trials — the same GPU cost as the shape-scored gate run it replaces.
 */
const GATE_TASK_LIMIT = Number(process.env.AB_GATE_TASK_LIMIT ?? 10)

/**
 * How many screened tasks the research group replays. One stimulus each, run by
 * both arms, so the default 20 is 40 trials — the rep count the queue already
 * budgeted for this group.
 */
const RESEARCH_TASK_LIMIT = Number(process.env.AB_RESEARCH_TASK_LIMIT ?? 20)

/**
 * How many pre-existing edited files a task needs before it may be a research
 * stimulus. Two, so the recall half has somewhere to move — one edited file is
 * a bar any answer naming a dozen paths usually clears by accident. Lower it to
 * 1 for a wider corpus (27 tasks instead of 10) at the cost of headroom.
 */
const RESEARCH_MIN_EDITED = Number(process.env.AB_RESEARCH_MIN_EDITED ?? 2)

/** How many recorded docs queries the extraction screen replays before stopping. */
const EXTRACTION_TASK_LIMIT = Number(process.env.AB_EXTRACTION_TASK_LIMIT ?? 20)

/** Where the research group extracts the before-trees its children work in. */
const FILES_TREE_ROOT = path.join(os.tmpdir(), 'pi-task-files-trees')

/** Where the tooling group extracts the before-trees its children inspect. */
const TOOLING_TREE_ROOT = path.join(os.tmpdir(), 'pi-task-tooling-trees')

/** Where the two clock-only research groups extract their before-trees. */
const CLOCK_TREE_ROOT = path.join(os.tmpdir(), 'pi-task-clock-trees')

/**
 * How long to wait for a model that has gone away, and how often to look.
 *
 * The local server crashes; it comes back. Treating "down right now" as a
 * verdict-ending abstain converts a recoverable blip into the loss of every GPU
 * hour already spent, which is what the previous version of this file did with
 * a 2-try, 3-second `confirm()`. A SWAP is still terminal — that is the
 * instrument changing, not a blip.
 */
const MODEL_WAIT_MS = Number(process.env.AB_MODEL_WAIT_MS ?? 1_800_000)
const MODEL_POLL_MS = Number(process.env.AB_MODEL_POLL_MS ?? 15_000)

// ─── Resume ledger ───────────────────────────────────────────────────────────

/**
 * The run's append-only ledger, written after EVERY trial.
 *
 * A multi-hour run that keeps its results in memory turns any interruption — a
 * model crash, a reboot, a Ctrl-C — into a total loss of the GPU time already
 * spent. Resuming reads this back and skips what is in it, so re-running the
 * same command costs only the trials that never finished.
 */
function ledgerPath(): string {
    return process.env.AB_LEDGER ?? path.join(os.tmpdir(), 'pi-task-groupab-ledger.jsonl')
}

/**
 * What makes one row resumable, and every field of it is load-bearing.
 *
 * `fingerprint` — a ledger written against a different model is a different
 * experiment, so continuing into it would mix two models inside one cell.
 * `group` and `reps` — the trial key is the INDEX into `armOrder(reps * 2)`,
 * and `build(rep)` is only deterministic for a fixed group and rep count. A row
 * from a 10-rep run is not trial 7 of a 20-rep run.
 */
interface LedgerRow extends Trial {
    fingerprint: string | null
    group: string
    reps: number
    index: number
    at: string
}

function appendTrial(
    t: Trial,
    index: number,
    group: string,
    reps: number,
    fingerprint: string | null
): void {
    const row: LedgerRow = {...t, fingerprint, group, reps, index, at: new Date().toISOString()}
    fs.appendFileSync(ledgerPath(), JSON.stringify(row) + '\n')
}

/** Trials already recorded for this exact model, group and rep count, by index. */
function loadLedger(
    group: string,
    reps: number,
    fingerprint: string | null
): Map<number, LedgerRow> {
    const out = new Map<number, LedgerRow>()
    const file = ledgerPath()
    if (!fs.existsSync(file)) return out
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        try {
            const row = JSON.parse(line) as LedgerRow
            if (row.fingerprint !== fingerprint) continue
            if (row.group !== group || row.reps !== reps) continue
            out.set(row.index, row)
        } catch {
            // A torn last line is what a kill -9 mid-write leaves. Skip it.
        }
    }
    return out
}

// ─── Arms ────────────────────────────────────────────────────────────────────

/** The two arms, and nothing else. `medium` is REASONING_ON_LEVEL by import. */
const ARMS = ARMS_
type Arm = (typeof ARMS)[number]

/**
 * Interleaved, not blocked. A blocked order loads every effect that drifts over
 * a multi-hour run — GPU thermals, cache warmth, another process starting —
 * onto whichever arm ran second.
 */
function armOrder(trials: number): Arm[] {
    const out: Arm[] = []
    for (let i = 0; i < trials; i++) {
        // off,med,med,off,… — balanced within every pair AND every four.
        out.push(ARMS[(i % 4 === 1 || i % 4 === 2 ? 1 : 0) as 0 | 1]!)
    }
    return out
}

// ─── One trial's outcome ─────────────────────────────────────────────────────

interface Trial {
    arm: Arm
    /** Which recorded task supplied this trial's input. */
    source: string
    /**
     * The answer the STIMULUS makes correct, when the group has a ground truth.
     *
     * Only `gate` sets it today: its trials run against a screened tree whose
     * VERIFY outcome was executed with no model in the loop, so `PASS` or `FAIL`
     * here is a fact, not an opinion. Stored so the row stays rescorable — a
     * scorer change must never need the corpus back. Absent for every group
     * scored on text alone.
     */
    truth?: string
    /**
     * A fingerprint of the exact content the child was shown, when the trial's
     * axis is "the answer is grounded in that content".
     *
     * Only `extraction` sets it, and it exists because a rescore of this group
     * RE-RETRIEVES rather than re-reads. MEASURED 2026-08-26: two trials that
     * verified inside the container failed when rescored on the host, both
     * quoting real `bun` type declarations — the sandbox image and the host ship
     * different bun versions, so `docsRaw` returned different chunks for the
     * same query. Retrieval is deterministic within one environment and NOT
     * across two, so a rescorer must be able to tell that it is holding
     * different material rather than a different verdict.
     */
    verifyHash?: string
    /** The child never produced a usable answer within its own guards. */
    nonTerminating: boolean
    /** The phase's own parser accepted what came back. */
    usable: boolean
    ms: number
    /** Why, for the log. A run nobody can explain is a run nobody trusts. */
    note: string
    /**
     * WHAT THE CHILD ACTUALLY WROTE, verbatim — the single most valuable field
     * in the ledger, and it was missing.
     *
     * Every other field is a JUDGEMENT the scorer made. When a scorer turns out
     * to be wrong — and three of five in this file were — a ledger of judgements
     * is unrescorable and the GPU hours behind it are gone. That is precisely
     * what happened to 28 phase trials: they stored `usable: false` decided by a
     * check for a section refine is FORBIDDEN to emit, and the text that would
     * have settled it was never written down. A rule change costs nothing to
     * rescore (see rescore-reasoning-ledger.ts); a scorer change now costs
     * nothing either.
     *
     * Truncated at CAPTURE_LIMIT so one runaway child cannot fill the disk. When
     * that fires `truncated` is true, and a rescorer must treat the row as
     * unrescorable rather than score a fragment.
     */
    output: string
    truncated: boolean
}

/**
 * How much child text a row keeps. Generous on purpose: the point of storing it
 * is to rescore, and a scorer that reads a clipped answer is a new wrong scorer.
 * Real answers here run a few KB; only a loop-killed child approaches this.
 */
const CAPTURE_LIMIT = 200_000

/** Short, stable fingerprint of a verify target — see {@link Trial.verifyHash}. */
function contentHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function capture(text: string): {output: string; truncated: boolean} {
    return text.length > CAPTURE_LIMIT ?
            {output: text.slice(0, CAPTURE_LIMIT), truncated: true}
        :   {output: text, truncated: false}
}

/**
 * One group's experiment.
 *
 * `build(rep)` is called ONCE PER REP and returns the prompt plus the id of the
 * recorded task it came from — so the two arms of a rep see identical bytes while
 * different reps exercise different real work.
 */
/**
 * One rep's stimulus. `prompt` and `source` are all most groups need; `gate`
 * also carries the tree its verdict is scored against.
 */
interface Built {
    prompt: string
    source: string
    /** Present only where the group has a ground truth — see Trial.truth. */
    truth?: string
    /** The screened (task, tree) pair, for the group that runs in its own tree. */
    gate?: GateStimulus
    /** The screened task whose FILES answer is scored against its after-tree. */
    files?: FilesStimulus
    /** The screened task whose TOOLING commands are resolved against its tree. */
    tooling?: ToolingStimulus
    /** The task a clock-only worker replays: `research:apis`, `research:context`. */
    clockOnly?: {id: string; beforeCommit: string}
}

interface GroupExperiment {
    child: string
    /** What real material this group replays, for the banner. */
    stimulus: string
    build: (rep: number) => Built
    /** `built` is what `build` returned for this rep, both arms sharing it. */
    run: (built: Built, arm: Arm) => Promise<Trial>
}

/**
 * Real PhaseDeps — the real context window, no casts.
 *
 * `childExtensions` IS PART OF THE CHILD UNDER TEST, not decoration. Production
 * hands every PLANNING child `[SINGLE_READ_EXTENSION_PATH]`
 * (auto-orchestrator.ts, the planning deps beside `runChild`), so an
 * auto-decompose spawned without it is a DIFFERENT child from the one that
 * ships — and the guard it drops is precisely the one whose old form caused the
 * thrash this group was meant to measure (197 of 200 calls were its own
 * refusal). Measured with it missing, `planning` was scoring a child production
 * does not run. Callers pass what production passes for that child and nothing
 * else. `refine`, the gate children and three of the four research workers get
 * no extensions in production and get none here — but `worker:tooling` DOES get
 * `[SINGLE_READ_EXTENSION_PATH]` (phases.ts, the TOOLING worker spec), and the
 * sentence that used to stand here said the research children get none. The
 * `research:tooling` trial passes it.
 */
/**
 * The single-read extension as a file `pi` can actually load.
 *
 * `SINGLE_READ_EXTENSION_PATH` is resolved relative to the MODULE that declares
 * it, so production — running out of `dist/` — gets
 * `dist/workers/single-read-extension.js` and it exists. This harness runs the
 * TypeScript directly under bun, so the same constant points at
 * `src/workers/single-read-extension.js`, which is not on disk: only the `.ts`
 * is. And `pi` is a NODE bundle (`dist/bundle/cli.js`), so handing it the `.ts`
 * is not a fallback, it is a second way to load nothing.
 *
 * So map src -> dist and REQUIRE the built file. Abstaining is the only honest
 * option here: a missing extension does not fail loudly, it just silently
 * measures a child with one fewer guard than production ships, which is the
 * exact defect this whole wiring exists to remove.
 */
function loadableExtension(entry: string): string {
    if (fs.existsSync(entry)) return entry
    const built = entry.replace(`${path.sep}src${path.sep}`, `${path.sep}dist${path.sep}`)
    if (fs.existsSync(built)) return built
    console.error(
        `ABSTAIN — a child extension is not on disk as loadable JS.\n`
            + `  looked at: ${entry}\n`
            + `             ${built}\n`
            + '  Production hands the child under test this extension. Run `bun run build`'
            + ' first: without it this run would measure a child with one fewer tool or'
            + ' guard than production ships, and would not say so.'
    )
    process.exit(EXIT_CODE.ABSTAIN)
}

function loadableSingleReadExtension(): string {
    return loadableExtension(SINGLE_READ_EXTENSION_PATH)
}

function phaseDeps(cwd: string, extensions: readonly string[] = []): PhaseDeps {
    return {
        cwd,
        taskId: 'AB',
        signal: new AbortController().signal,
        contextWindow: CONTEXT_WINDOW,
        childExtensions: extensions
    } as PhaseDeps
}

/**
 * Run one phase-style child at a level and score it.
 *
 * The level reaches the child through the CONFIG, not hand-built argv: the thing
 * under test is the shipped resolution path, and a harness that assembles the
 * flag itself would pass even if runPhaseChild never read the group.
 */
async function phaseTrial(
    cwd: string,
    child: string,
    tools: string,
    prompt: string,
    source: string,
    arm: Arm,
    accept: (text: string) => boolean,
    extensions: readonly string[] = []
): Promise<Trial> {
    const t0 = Date.now()
    try {
        const text = await runPhaseChild(phaseDeps(cwd, extensions), child, tools, prompt)
        const usable = accept(text)
        return {
            arm,
            source,
            nonTerminating: false,
            usable,
            ms: Date.now() - t0,
            note: usable ? 'ok' : `answered but unusable (${text.trim().length} chars)`,
            ...capture(text)
        }
    } catch (e) {
        // Every guard this child has — phase timeout, loop budget, stall, model
        // error, leaked tool call — arrives here as a throw, and all of them are
        // the same outcome for scoring: no usable answer within its own budget.
        return {
            arm,
            source,
            nonTerminating: true,
            usable: false,
            ms: Date.now() - t0,
            note: e instanceof Error ? e.message.slice(0, 110) : String(e).slice(0, 110),
            // A throw carries no text: runPhaseChild's guards fire before it
            // returns one. Recorded as empty, not as a missing field, so a
            // rescorer can tell "wrote nothing" from "an older ledger dialect".
            ...capture('')
        }
    }
}

/**
 * One gate trial: a verify child in a freshly extracted tree, scored on whether
 * its verdict matches what that tree makes true.
 *
 * THE TREE IS EXTRACTED PER TRIAL, not per stimulus, and that is not waste. The
 * child runs with VERIFY_TOOLS, which includes bash — it can and does create
 * files while investigating. Reusing one tree across the two arms would let the
 * first arm's leftovers change what the second arm sees, which is a between-arm
 * difference the harness invented rather than measured.
 *
 * Extraction happens HERE rather than in `build` because `build` is called for
 * skipped trials too; on resume that would extract a full corpus tree per
 * already-finished row for nothing.
 */
async function gateTrial(b: Built, arm: Arm): Promise<Trial> {
    const g = b.gate
    if (!g || b.truth === undefined) {
        // Unreachable via buildExperiments, and a throw here beats scoring a
        // trial against an undefined truth — which would silently read as wrong.
        throw new Error('gateTrial called without a screened stimulus')
    }
    const dir = path.join(GATE_TREE_ROOT, `${g.id}-${g.condition}-${arm}`)
    try {
        extractTree(g.commit, dir)
        const t = await workerTrial(
            dir,
            b.prompt,
            b.source,
            arm,
            VERIFY_TOOLS,
            text => gateVerdictCorrect(text, b.truth!),
            text => {
                const said = verdictWord(text)
                return said === b.truth ? `verdict ${said} — correct` : (
                    `verdict ${said} — WRONG, tree is ${b.truth}`
                )
            }
        )
        return {...t, truth: b.truth}
    } finally {
        // A corpus checkout per trial fills a disk fast. The screen's own trees
        // are cleaned the same way.
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

/**
 * One research trial: a FILES worker in the task's BEFORE tree, scored on BOTH
 * halves — every path it names is real, and it names every pre-existing file
 * the task went on to edit.
 *
 * Two trees are involved and they are not interchangeable. The child works in
 * the before-tree because that is where the real worker worked — the files the
 * task will create are genuinely absent, so naming one is a prediction. The
 * precision check runs against the after-tree because a correctly predicted
 * file exists there, and only a path in neither tree is an invention.
 *
 * PRECISION ALONE WAS THE PREVIOUS AXIS AND IT SATURATED, 10/10 in both arms,
 * while hiding a 1.7x volume difference: `off` named 119 real paths to
 * `medium`'s 70. A precision-only axis pays a cheaper arm for saying less.
 * Recall alone has the opposite hole — one `src/` entry would win it — so the
 * axis is the conjunction and neither half can be gamed alone.
 *
 * Extracted per trial for the same reason gate's is: the worker holds read,
 * grep, find and ls, and one arm's leftovers must not change what the other
 * arm sees.
 */
async function filesTrial(b: Built, arm: Arm): Promise<Trial> {
    const f = b.files
    if (!f) throw new Error('filesTrial called without a screened stimulus')
    const edited = f.edited
    if (!edited || edited.length === 0) {
        throw new Error(`filesTrial: ${f.id} has no edited-file truth to score recall against`)
    }
    const dir = path.join(FILES_TREE_ROOT, `${f.id}-${arm}`)
    try {
        extractTree(f.beforeCommit, dir)
        // Read once per trial rather than per scorer call: it is a git process,
        // and `accept` and `describe` would each pay for it.
        const after = treePaths(f.afterCommit)
        return await workerTrial(
            dir,
            b.prompt,
            b.source,
            arm,
            undefined,
            text => filesAnswered(text, after, edited),
            text => {
                const g = groundedPaths(text, after)
                const r = namedRecall(text, edited)
                if (g.total === 0) return 'named no path at all'
                const prec =
                    g.missing.length === 0 ?
                        `${g.total}/${g.total} real`
                    :   `${g.present}/${g.total} real — invented ${g.missing.slice(0, 2).join(', ')}`
                const rec =
                    r.missing.length === 0 ?
                        `${r.total}/${r.total} edited named`
                    :   `${r.found}/${r.total} edited named — missed`
                        + ` ${r.missing.slice(0, 2).join(', ')}`
                return `${prec}; ${rec}`
            }
        )
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

/**
 * One `research:tooling` trial: the TOOLING worker in the task's BEFORE tree,
 * scored on whether the commands it emits actually resolve in that tree.
 *
 * PRODUCTION'S CHILD, NOT A LOOKALIKE. worker:tooling is the one research worker
 * that carries `[SINGLE_READ_EXTENSION_PATH]`, and its goal is `refined` put
 * through `scopedToolingGoal` — the prose-only slice, deliberately not the
 * per-file edit checklist that makes a weak model spelunk source and loop. Both
 * are passed here. The prompt HEADER (external context + inventory) is not,
 * which matches what the FILES trial already does and is the one difference from
 * production worth naming.
 *
 * The tree is the BEFORE tree because that is the tree the real worker
 * inspected, and the scripts it must not invent are the ones that tree declares.
 */
async function toolingTrial(b: Built, arm: Arm): Promise<Trial> {
    const s = b.tooling
    if (!s) throw new Error('toolingTrial called without a screened stimulus')
    const dir = path.join(TOOLING_TREE_ROOT, `${s.id}-${arm}`)
    try {
        extractTree(s.beforeCommit, dir)
        return await workerTrial(
            dir,
            b.prompt,
            b.source,
            arm,
            undefined,
            text => toolingRunnable(text, s.beforeCommit),
            text => {
                const sc = scoreTooling(text, s.beforeCommit)
                if (sc.checkable === 0) return `no checkable command (${sc.unknown} unknown)`
                return (
                    `${sc.checkable - sc.invented.length}/${sc.checkable} runnable`
                    + (sc.invented.length > 0 ? ` — invented ${sc.invented.join(', ')}` : '')
                    + ` (${sc.unknown} unknown)`
                )
            },
            [loadableSingleReadExtension()]
        )
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

/**
 * One `research:apis` or `research:context` trial — a COST measurement, not a
 * verdict.
 *
 * NEITHER WORKER HAS A QUALITY AXIS, and that is a finding, not an oversight.
 * Both candidates were screened offline against the recorded answers
 * (scripts/research-worker-axes-step0.ts) and both died:
 *   APIS     "every dotted symbol is in the tree" — 28/28 tasks, 81/81 items.
 *            Saturated, and loose: it greps the LAST SEGMENT, so `Hono.c.json`
 *            passes on the word `json`. Tightening has nothing to bite on,
 *            because APIS names are model-composed pseudo-symbols.
 *   CONTEXT  "every backticked project path exists" — 6/53 tasks, 213/391
 *            items. The CHECK loses, on the residue the phase path-axis audit
 *            already catalogued.
 *
 * So the axis here is TERMINATION ONLY — production's own `hasAnswerContent`.
 * It will saturate, the decision ladder will print NOT WRITABLE, and that is
 * the CORRECT outcome: a cheaper arm may simply be saying less, and this
 * scorer cannot tell. What the run is FOR is the ledger's clock, read as a
 * cost number a human decides on — never as a verdict this file writes.
 */
async function clockOnlyWorkerTrial(
    b: Built,
    arm: Arm,
    tools: string | undefined,
    extensions: readonly string[],
    accept: (text: string) => boolean
): Promise<Trial> {
    const t = b.clockOnly
    if (!t) throw new Error('clockOnlyWorkerTrial called without a screened stimulus')
    const dir = path.join(CLOCK_TREE_ROOT, `${t.id}-${arm}`)
    try {
        extractTree(t.beforeCommit, dir)
        return await workerTrial(
            dir,
            b.prompt,
            b.source,
            arm,
            tools,
            accept,
            text => `${text.trim().split('\n').filter(l => l.trim() !== '').length} line(s)`,
            extensions
        )
    } finally {
        fs.rmSync(dir, {recursive: true, force: true})
    }
}

/** A worker-style trial (research and gate both go through runWorker). */
async function workerTrial(
    cwd: string,
    prompt: string,
    source: string,
    arm: Arm,
    tools: string | undefined,
    accept: (text: string) => boolean,
    describe: (text: string) => string,
    extensions?: readonly string[]
): Promise<Trial> {
    const t0 = Date.now()
    const r = await runWorker({
        prompt,
    profile: 'adhoc',
        cwd,
        signal: new AbortController().signal,
        ...(tools ? {tools} : {}),
        ...(extensions && extensions.length > 0 ? {extensions: [...extensions]} : {}),
        thinking: ['--thinking', arm],
        contextWindow: CONTEXT_WINDOW
    })
    const ms = Date.now() - t0
    // A worker does not throw; it returns a failed shape. The three ways it can
    // come back with nothing are one outcome.
    const dead = r.exitCode !== 0 || Boolean(r.modelError) || r.text.trim().length === 0
    const usable = !dead && accept(r.text)
    return {
        arm,
        source,
        nonTerminating: dead,
        usable,
        ms,
        note:
            dead ?
                `exit ${r.exitCode}${r.modelError ? ` ${r.modelError.slice(0, 50)}` : ''}`
            :   describe(r.text),
        ...capture(r.text)
    }
}

// ─── The experiments, all replaying real captured material ───────────────────

/** The recorded tasks, opened once. */
function corpusTasks(): TaskRecord[] {
    const run = openRecordedRun(CORPUS_ROOT)
    if (!run) {
        console.error(
            `ABSTAIN — no recorded run at ${CORPUS_ROOT}. Set AB_CORPUS to a tree with a`
                + ' .pi-tasks/ directory. A synthetic prompt is not a substitute: the last'
                + ' version of this harness used one and could not reproduce its own'
                + ' calibration case.'
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }
    return run.tasks()
}

/** A recorded section, or abstain — a missing input must never become a fake one. */
function requireSection(t: TaskRecord, name: string): string {
    const s = t.section(name)?.trim()
    if (!s) {
        console.error(`ABSTAIN — ${t.id} has no "## ${name}" section to replay.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }
    return s
}

async function buildExperiments(group: ReasoningGroup): Promise<GroupExperiment | null> {
    if (group === 'planning') {
        // THE CALIBRATION CASE, now actually calibrated: the committed
        // byte-identical mx5 spec through the production @-expansion, plus the
        // production requirements ledger — the same stimulus magicknumbers.md
        // measured, rebuilt by production code.
        const fx = await loadPlanningFixture('mx5')
        // FIXTURE-DRIFT ASSERTION, the convention's integrity check
        // (live-batch-test-ab.ts has the same shape). The magicknumbers stimulus
        // was ~20 KB; a short one means the @-mention did not expand and the run
        // would measure a one-liner while claiming to measure a spec.
        if (fx.featureForModel.length < 15_000) {
            console.error(
                `ABSTAIN — fixture drift: featureForModel is ${fx.featureForModel.length} chars,`
                    + ' expected ~20 KB. The @-mention did not expand, so this would NOT be'
                    + ' the stimulus magicknumbers.md measured. That is the exact defect this'
                    + ' harness was rewritten to remove.'
            )
            process.exit(EXIT_CODE.ABSTAIN)
        }
        console.log(`fixture mx5: ${fx.featureForModel.length} chars of inlined spec`)
        // Extracted ONCE and reused by every rep of both arms, so the ledger is
        // never a source of between-arm variance.
        const reqs = await extractRequirementsNew(fx)
        const ledger = buildRequirementsLedger(reqs)
        console.log(`requirements ledger: ${reqs.length} grounded requirement(s)`)
        const prompt = AUTO_DECOMPOSE_PROMPT(fx.featureForModel, '', ledger)
        return {
            child: 'auto-decompose',
            stimulus: '__fixtures__/planning/mx5-project.md via expandFeatureMentions',
            build: () => ({prompt, source: 'mx5-fixture'}),
            run: (b, arm) =>
                // The production parser. A title list of one is what a thrashing
                // child emits just before giving up, so a real plan is the bar.
                phaseTrial(
                    fx.cwd,
                    'auto-decompose',
                    'read',
                    b.prompt,
                    b.source,
                    arm,
                    // NOT the shape check — that one read 10/10 in both arms.
                    // Every citation the plan makes must be real, adjudicated by
                    // production's own grounding against the very text the child
                    // was shown. See planningPlanFaithful.
                    text => planningPlanFaithful(text, fx.featureForModel),
                    // What production's planning deps pass. See phaseDeps.
                    [loadableSingleReadExtension()]
                )
        }
    }

    const tasks = corpusTasks()
    if (tasks.length === 0) {
        console.error(`ABSTAIN — ${CORPUS_ROOT} has no TASK_*.md to replay.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }
    /**
     * The tasks that actually RECORDED this section, non-empty.
     *
     * A task whose section is blank is not a stimulus, it is a non-observation.
     * The previous version abstained the entire group the first time `pick` hit
     * one, so a single blank `## refined prompt` in TASK_0001 cost the research
     * group all three of its attempts before a single trial ran. Skipping a
     * blank is not cherry-picking: an empty prompt is not a member of the
     * population being sampled.
     */
    const poolFor = (name: string): TaskRecord[] => {
        const have = tasks.filter(t => (t.section(name)?.trim() ?? '') !== '')
        if (have.length === 0) {
            console.error(
                `ABSTAIN — no task at ${CORPUS_ROOT} has a non-empty "## ${name}" to replay.`
            )
            process.exit(EXIT_CODE.ABSTAIN)
        }
        if (have.length < tasks.length) {
            console.log(
                `pool "${name}": ${have.length}/${tasks.length} tasks`
                    + ` (${tasks.length - have.length} skipped, section empty)`
            )
        }
        return have
    }
    const pickFrom = (pool: TaskRecord[], rep: number): TaskRecord => pool[rep % pool.length]!

    if (group === 'phase') {
        const pool = poolFor('raw prompt')
        // refine's REAL input: the `## raw prompt` a recorded task was handed.
        return {
            child: 'refine',
            stimulus: `## raw prompt from ${pool.length} recorded tasks`,
            build: rep => {
                const t = pickFrom(pool, rep)
                return {prompt: REFINE_PROMPT(requireSection(t, 'raw prompt')), source: t.id}
            },
            run: (b, arm) =>
                // THE PRODUCTION VALIDATOR. The previous scorer here demanded
                // GOAL && CONSTRAINTS && VERIFY as uppercased SUBSTRINGS, and
                // that is wrong twice over. VERIFY is not a refine section at
                // all — REFINE_PROMPT names GOAL, CONSTRAINTS, KNOWN-UNKNOWNS,
                // EXTERNAL-DEPENDENCIES and then forbids anything else — so a
                // perfectly compliant answer scored UNUSABLE unless the word
                // happened to fall in prose. (Root cause: GOAL/CONSTRAINTS/
                // ACCEPTANCE/VERIFY is the COMPOSE contract, validateSpecShape,
                // carried onto the wrong child.) And a substring test passes on
                // the word inside a sentence, while every downstream consumer
                // needs the heading BARE on its own line. 28 trials were voided
                // by this. validateRefineShape is now production's own answer.
                phaseTrial(
                    CORPUS_ROOT,
                    'refine',
                    'read',
                    b.prompt,
                    b.source,
                    arm,
                    GROUP_SCORERS.phase!
                )
        }
    }

    if (group === 'research:files') {
        /**
         * The FILES worker's real input, run in the tree it really ran in, and
         * scored on BOTH halves of the job: every path it names is real, and it
         * names every pre-existing file the task went on to edit.
         *
         * TWO AXES HAVE DIED HERE, and the second is the reason for this one.
         *
         *   1. `hasAnswerContent` — production's ">=2 lines of name<gap>desc",
         *      which IS the FILES entry shape. Correct, and a SHAPE check: a
         *      competent model produces one every time.
         *   2. PRECISION, "every path named is real". 10/10 in BOTH arms, and
         *      the ceiling hid a confound rather than reporting a tie: `off`
         *      named 119 real paths to `medium`'s 70, more in 9 of 10 tasks and
         *      never fewer, both arms 100% precise. Medium was 1.65x faster
         *      BECAUSE IT SAID LESS. A precision-only axis pays for that.
         *
         * Recall is the missing half, and it comes from the SHIPPED TREE, not
         * from the recorded answer: those ten recorded answers name 37 paths
         * total, fewer than either arm, so they cannot settle whether more is
         * better. `editedExistingPaths` is the truth — files that existed before
         * the turn and that the turn edited. Created files are NOT truth
         * (measured: the recorded answers score 49.0% against them — the CHECK
         * loses); restricted to pre-existing files they score 86.6%.
         *
         * The axis is the CONJUNCTION. Precision alone rewards saying less;
         * recall alone is won outright by one `src/` entry.
         *
         * THE STIMULUS SET CHANGED WITH IT, and that is not a detail. The
         * precision screen kept the first ten passing tasks, TASK_0002..0012 —
         * the greenfield scaffolding at the head of the run. SEVEN OF THOSE TEN
         * EDIT NO PRE-EXISTING FILE AT ALL. The trials that returned 10/10 vs
         * 10/10 were run on the tasks where recall does not exist.
         *
         * The child works in the BEFORE tree, which is where the real worker
         * worked: files the task will create are genuinely absent, so naming one
         * is a prediction rather than an `ls`. The AFTER tree is what a named
         * path must exist in, so a correct "to create" entry scores and only an
         * invention fails.
         */
        const byId = new Map(corpusTasks().map(t => [t.id, t]))
        const {stimuli, screened} = filesRecallStimuli({
            recordedFiles: t => {
                const research = byId.get(t.id)?.section('research')?.trim()
                if (!research) return undefined
                // The recorded `## research` holds FILES, APIS, CONTEXT and
                // VERIFIED-TOOLING under bare ALL-CAPS headings. Only the FILES
                // block is a path list; APIS is symbols and would score as 100%
                // invented.
                // Up to the next bare ALL-CAPS heading, or the end of the
                // section. `(?![\s\S])` is end-of-input; `$` under /m would
                // stop at the first newline.
                const m = /^FILES[ \t]*$([\s\S]*?)(?=^[A-Z][A-Z -]*[ \t]*$|(?![\s\S]))/m.exec(
                    research
                )
                return m?.[1]
            },
            refinedPrompt: t => byId.get(t.id)?.section('refined prompt')?.trim(),
            minEdited: RESEARCH_MIN_EDITED,
            limitTasks: RESEARCH_TASK_LIMIT
        })
        if (stimuli.length === 0) {
            console.error(
                `ABSTAIN — no task at ${CORPUS_ROOT} has a recorded FILES section that is`
                    + ' both fully grounded in its own after-tree and names every pre-existing'
                    + ` file the task edited (>=${RESEARCH_MIN_EDITED} of them). Without one`
                    + ' there is nothing to score a child against, and the axes left are the'
                    + ' shape check and precision — both of which this group has already'
                    + ' saturated.'
            )
            process.exit(EXIT_CODE.ABSTAIN)
        }
        // Named, not counted. A screen that silently drops tasks reads as "the
        // corpus is like this" when it is really "the check disagreed here".
        for (const o of screened.filter(x => !x.usable)) {
            console.log(`  dropped ${o.id}: ${o.detail}`)
        }
        console.log(
            `research ground truth: ${stimuli.length} task(s) whose recorded FILES is 100%`
                + ' real AND names every file the task edited'
        )
        return {
            child: 'worker:files',
            stimulus:
                `## refined prompt from ${stimuli.length} screened tasks`
                + ' — every named PATH must be real AND every EDITED file must be named',
            build: rep => {
                const f = stimuli[rep % stimuli.length]!
                return {
                    prompt: RESEARCH_FILES_PROMPT(f.refined),
                    source: f.id,
                    files: f
                }
            },
            run: (b, arm) => filesTrial(b, arm)
        }
    }

    if (group === 'research:tooling') {
        /**
         * The TOOLING worker, scored on whether its commands RUN.
         *
         * WHY THIS AXIS EXISTS AT ALL. `research` was one cell until 2026-08-28
         * and its only ledger is a FILES worker. Three candidate axes were
         * screened offline before any GPU was booked
         * (scripts/research-worker-axes-step0.ts), and two died there:
         *
         *   CONTEXT  every backticked project path exists — the recorded
         *            answers score 6/53 clean, 213/391 items. The CHECK loses,
         *            on exactly the residue the phase path-axis audit already
         *            catalogued: package specifiers, bare filenames, `src/`
         *            prefix elision.
         *   APIS     every dotted symbol is present in the tree — the recorded
         *            answers score 28/28, 81/81. SATURATED, and loose with it:
         *            the check greps the symbol's LAST SEGMENT, so `Hono.c.json`
         *            passes on the word `json`. A tighter check has nothing to
         *            bite on, because APIS names are model-composed pseudo-
         *            symbols (`Hono.c.var`, `UUID regex`), which is the same
         *            wall [[apis-contract-stage3-refuted]] hit.
         *
         * TOOLING survived: recorded answers 32/45 clean, 102/118 commands
         * runnable, and the failures are one verified class. `bun run dev` was
         * EXECUTED in an extracted TASK_0010 before-tree and printed `error:
         * Script not found "dev"` — the tree's scripts are `lint` and `test` at
         * every commit checked. So the check is right and the answer is wrong,
         * which is headroom rather than a losing check.
         */
        const byId = new Map(corpusTasks().map(t => [t.id, t]))
        const recordedTooling = (id: string): string | undefined => {
            const research = byId.get(id)?.section('research')?.trim()
            if (!research) return undefined
            const re = /^(?:VERIFIED-)?TOOLING[ \t]*$([\s\S]*?)(?=^[A-Z][A-Z -]*[ \t]*$|(?![\s\S]))/m
            return re.exec(research)?.[1]
        }
        const {stimuli, screened} = toolingStimuli({
            tasks: implTasks(),
            refinedPrompt: id => byId.get(id)?.section('refined prompt')?.trim(),
            recordedTooling,
            limitTasks: RESEARCH_TASK_LIMIT
        })
        if (stimuli.length === 0) {
            console.error(
                `ABSTAIN — no task at ${CORPUS_ROOT} has both a recorded refined prompt`
                    + ' and a before-tree declaring a package.json script. Without a script'
                    + ' to name, no command the worker emits is adjudicable either way and'
                    + ' every trial would be vacuous.'
            )
            process.exit(EXIT_CODE.ABSTAIN)
        }
        for (const o of screened.filter(x => !x.usable)) {
            console.log(`  dropped ${o.id}: ${o.detail}`)
        }
        const dirty = stimuli.filter(x => x.recorded.invented > 0).length
        console.log(
            `tooling stimuli: ${stimuli.length} task(s); the RECORDED answer already`
                + ` carries an unrunnable command in ${dirty} of them`
        )
        return {
            child: 'worker:tooling',
            stimulus:
                `## refined prompt from ${stimuli.length} screened tasks`
                + ' — every command the checker can adjudicate must RUN in that tree',
            build: rep => {
                const t = stimuli[rep % stimuli.length]!
                return {
                    prompt: RESEARCH_TOOLING_PROMPT(scopedToolingGoal(t.refined)),
                    source: t.id,
                    tooling: t
                }
            },
            run: (b, arm) => toolingTrial(b, arm)
        }
    }

    if (group === 'research:apis' || group === 'research:context') {
        /**
         * A COST RUN. Read the note on `clockOnlyWorkerTrial` first: neither
         * worker has a quality axis, so this run cannot and must not write a
         * cell. It exists to put a NUMBER on what thinking costs these two, on
         * the same corpus, the same trees and the same model as every other
         * cell — so a human decision is made on measured seconds rather than on
         * the assumption that `off` is cheaper.
         *
         * PRODUCTION'S CHILD IN BOTH CASES:
         *   apis     tools `read,grep,find,ls` + the worker channels, the same
         *            `-e` paths, the search hint when search is configured, and
         *            the FILES map the serial default hands it — taken from the
         *            task's OWN recorded FILES block, which is what the real
         *            APIS worker was given.
         *   context  tools `read,grep` and nothing else. Deliberately isolated;
         *            production does not hand it the APIS section.
         * WHAT THIS TRIAL DOES NOT SHIP, all of it the same for both arms:
         *   - the prompt HEADER (external context + inventory), omitted as it
         *     is for the FILES and TOOLING trials;
         *   - apis: `orientation.block` (the pre-read core files) and the
         *     `zeroRetrievalRetry` gate;
         *   - context: `retryIfSilent` and the `demoteUnsourcedAttributions`
         *     post-process.
         * The context omission is the one that touches a headline number here:
         * production retries a silent context worker ONCE before accepting the
         * loss, so the "died in a loop off 3/20" this run recorded is what the
         * child does UNGUARDED, and production's own rate is at most that.
         * Read the numbers as an upper bound on the wander, not as production's.
         */
        const byId = new Map(corpusTasks().map(t => [t.id, t]))
        const stimuli = implTasks()
            .filter(t => (byId.get(t.id)?.section('refined prompt')?.trim() ?? '') !== '')
            .slice(0, RESEARCH_TASK_LIMIT)
            .map(t => ({
                id: t.id,
                beforeCommit: t.preCommit,
                refined: byId.get(t.id)!.section('refined prompt')!.trim(),
                filesMap: (() => {
                    const research = byId.get(t.id)?.section('research')?.trim()
                    if (!research) return undefined
                    const m = /^FILES[ \t]*$([\s\S]*?)(?=^[A-Z][A-Z -]*[ \t]*$|(?![\s\S]))/m.exec(
                        research
                    )
                    return m?.[1]?.trim() || undefined
                })()
            }))
        if (stimuli.length === 0) {
            console.error(`ABSTAIN — no task at ${CORPUS_ROOT} has a recorded refined prompt.`)
            process.exit(EXIT_CODE.ABSTAIN)
        }
        const channels = apisWorkerChannels()
        const withMap = stimuli.filter(x => x.filesMap).length
        console.log(
            `${group}: ${stimuli.length} stimuli`
                + (group === 'research:apis' ?
                    `; ${withMap} carry a recorded FILES map; search ${
                        searchConfigured() ? 'IS' : 'is NOT'
                    } configured`
                :   '')
        )
        console.log(
            'COST RUN — the quality axis here is TERMINATION ONLY and will saturate.'
                + ' This run cannot write a cell; it measures what thinking costs.'
        )
        return {
            child: group === 'research:apis' ? 'worker:apis' : 'worker:context',
            stimulus:
                `## refined prompt from ${stimuli.length} tasks`
                + ' — TERMINATION ONLY, the clock is the deliverable',
            build: rep => {
                const t = stimuli[rep % stimuli.length]!
                const prompt =
                    group === 'research:apis' ?
                        RESEARCH_APIS_PROMPT(t.refined, t.filesMap)
                        + (searchConfigured() ? RESEARCH_SEARCH_HINT : '')
                    :   RESEARCH_CONTEXT_PROMPT(t.refined)
                return {
                    prompt,
                    source: t.id,
                    clockOnly: {id: t.id, beforeCommit: t.beforeCommit}
                }
            },
            run: (b, arm) =>
                group === 'research:apis' ?
                    clockOnlyWorkerTrial(
                        b,
                        arm,
                        `read,grep,find,ls,${channels.tools}`,
                        channels.extensions.map(loadableExtension),
                        // APIS entries ARE the `name<gap>description` shape, so
                        // production's own reader is the right termination check.
                        GROUP_SCORERS.research!
                    )
                :   // CONTEXT is a BULLET list, and `hasAnswerContent` rejects a
                    // prose bullet outright. Reusing it scored 40 good answers
                    // UNUSABLE and abstained the first cost run.
                    clockOnlyWorkerTrial(b, arm, 'read,grep', [], contextEmittedBullets)
        }
    }

    if (group === 'gate') {
        /**
         * verify's real input, built by PRODUCTION's own prompt builder, run in
         * a tree WHOSE CORRECT VERDICT IS ALREADY KNOWN.
         *
         * TWO SCORERS HAVE NOW DIED HERE, and the second one was correct:
         *
         *   1. A hand-written prompt ("answer PASS or FAIL on its own line")
         *      scored by /\b(PASS|FAIL)\b/ — either word anywhere in prose.
         *      37/40 usable. 40 rows voided.
         *   2. buildVerifyPrompt with `emittedVerdict`, production's own parser,
         *      asking "did the child state a verdict at all". 10/10 in BOTH arms.
         *
         * The second is not a bug. It is a ceiling, and a ceiling cannot
         * separate two arms however different they are. The reason it saturates
         * is that stating a verdict is easy; reaching the RIGHT one is the job.
         *
         * Scoring the verdict used to be impossible here for a good reason,
         * written into the old comment: the trials replayed recorded specs
         * against ONE corpus tree that may or may not contain the work, so a
         * FAIL was a fact about the tree rather than about the arm. The fix is
         * not to keep scoring shape — it is to stop guessing the tree.
         *
         * Each trial now runs in a freshly extracted tree that the task's own
         * VERIFY script was EXECUTED in, with no model involved:
         *   before-tree  VERIFY fails  ⇒ the only correct verdict is FAIL
         *   after-tree   VERIFY passes ⇒ the only correct verdict is PASS
         * Both conditions appear equally often, so always-PASS and always-FAIL
         * both score exactly 50%. Neither the ceiling nor the floor is reachable
         * without reading the tree.
         *
         * `findings` is left empty and no envNotes/contracts are passed: those
         * come from probes run against a live task tree, and inventing them
         * would be hand-writing the prompt again by another route.
         */
        const {stimuli, screened} = gateStimuli({
            treeRoot: GATE_TREE_ROOT,
            verifyTimeoutMs: GATE_VERIFY_TIMEOUT_MS,
            ...(GATE_ONLY.length > 0 ? {only: GATE_ONLY} : {}),
            limitTasks: GATE_TASK_LIMIT
        })
        if (stimuli.length === 0) {
            console.error(
                `ABSTAIN — no task at ${CORPUS_ROOT} survived the gate screen`
                    + ` (${screened.length} examined). Without a tree whose correct verdict is`
                    + ' known there is no quality axis here, only the saturated shape check'
                    + ' that already returned 10/10 in both arms.'
            )
            process.exit(EXIT_CODE.ABSTAIN)
        }
        console.log(
            `gate ground truth: ${stimuli.length} (task, tree) pair(s) from`
                + ` ${stimuli.length / 2} screened task(s) — half FAIL, half PASS`
        )
        return {
            child: 'verify',
            stimulus:
                `${stimuli.length} screened (task, tree) pairs via buildVerifyPrompt`
                + ' — the VERDICT is scored against the tree, not the answer\'s shape',
            build: rep => {
                const g = stimuli[rep % stimuli.length]!
                return {
                    prompt: buildVerifyPrompt(g.spec),
                    // The condition is IN the source, so the ledger says which
                    // tree a row ran against without needing the screen back.
                    source: `${g.id}/${g.condition}`,
                    truth: g.truth,
                    gate: g
                }
            },
            run: (b, arm) => gateTrial(b, arm)
        }
    }

    if (group === 'extraction') {
        /** Per-stimulus excerpt verify target, filled by `build` and read by `run`. */
        const verifyTargets = new Map<string, string>()
        /**
         * A focused extractor's real material: a query the recorded run really
         * asked the docs worker, over the chunks production's own retriever
         * picks for it, in the prompt production's own builder writes.
         *
         * THE HAND-WRITTEN PROMPT IS GONE. It used to feed a recorded `##
         * research` section through a locally written "Answer ONLY from the
         * content below" instruction, because the two production builders frame
         * their content as an npm package's docs or an anchored web page and a
         * `## research` section is neither. The fix was not a better frame, it
         * was the RIGHT MATERIAL: `.pi-tasks/research-cache.json` records 190
         * real `pi-worker-docs` queries over 31 packages, and those packages are
         * installed in the corpus copy. `extractionStimuli` replays them through
         * `docsRaw` + `buildPrompt` with no model and no network, which is
         * `docsFocused`'s own path minus the child.
         *
         * SCORER AUDITED, and it is production's own bar: fetch-core and
         * docs-core both gate on `ok` plus a non-empty `answer`, and both carry
         * `excerptVerified` as metadata rather than as a gate — so this scores
         * the same two things and only logs the third.
         *
         * THAT SCORER IS STILL A SHAPE CHECK, and it is the class that returned
         * 10/10 in both arms for gate, research and planning. The prompt no
         * longer blocks this cell; the AXIS does. `excerptVerified` is the
         * nearest candidate with headroom and is already carried through this
         * path — screen it for headroom before writing anything down.
         */
        const {stimuli, screened} = await extractionStimuli({
            cwd: CORPUS_ROOT,
            limitTasks: EXTRACTION_TASK_LIMIT
        })
        if (stimuli.length === 0) {
            console.error(
                `ABSTAIN — not one recorded docs query at ${CORPUS_ROOT} replays into a real`
                    + ' prompt. Either the corpus has no research-cache.json or its packages'
                    + ' are not installed there. Do NOT fall back to a hand-written prompt:'
                    + ' that is the thing this path replaced.'
            )
            process.exit(EXIT_CODE.ABSTAIN)
        }
        // Named, not counted — same rule as the other screens.
        for (const o of screened.filter(x => !x.usable)) {
            console.log(`  dropped ${o.id}: ${o.detail}`)
        }
        return {
            child: 'focused',
            stimulus:
                `${stimuli.length} recorded docs quer(ies) through docs-core.buildPrompt`,
            build: rep => {
                const s = stimuli[rep % stimuli.length]!
                // The excerpt is checked against exactly what went into the
                // prompt, so a genuine quote verifies and one pulled from memory
                // does not — the same contract docs-core uses.
                verifyTargets.set(s.id, s.content)
                return {prompt: s.prompt, source: s.id}
            },
            run: async (b, arm) => {
                const p = b.prompt
                const src = b.source
                // The PRODUCTION extractor, with the arm passed as an argument.
                // Not runWorker: that always emits `--tools <s>` and would send
                // `--tools ''`, which pi rejects — extraction children are
                // --no-tools. And not the ambient config either: the extractor
                // takes `thinking` from its caller now, which is the whole point
                // of that change.
                const t0 = Date.now()
                const r = await runFocusedExtraction({
                    prompt: p,
                    verifyAgainst: verifyTargets.get(src) ?? '',
                    cwd: CORPUS_ROOT,
                    signal: new AbortController().signal,
                    abortedMessage: 'ab aborted',
                    thinking: ['--thinking', arm]
                })
                const ok = r.ok === true
                // Pulled out of the union before the row is built: a failure
                // carries no `answer` at all, and the capture field needs the
                // text on both branches.
                const answer = r.ok ? r.answer : ''
                // THE AXIS IS THE CONJUNCTION: a non-empty answer AND a
                // citation that is really in the content the child was shown.
                //
                // Production gates on the first half only and carries
                // `excerptVerified` as metadata, so this is a HARDER bar than
                // production's own — legitimate for an A/B, and necessary
                // because the shape half is a ceiling. SCREENED offline with no
                // GPU over all 190 recorded docs answers: production's own
                // replies clear it 189/190, one of which cited no excerpt at
                // all. A known-good answer that could not clear the bar would
                // mean the CHECK loses, which is what killed phase's three
                // candidate axes and both grounding rules tried here (every
                // backticked span in the content scores the recorded answers
                // 51/190, code-shaped identifiers only 123/190 — real type
                // names like `ResponseInit` are simply not in the chunks).
                //
                // WHETHER IT HAS HEADROOM IS NOT KNOWABLE OFFLINE. 189/190 is
                // the production baseline, not both arms; if `off` fabricates
                // quotes it drops and if it does not the axis saturates and the
                // ladder bars rung 2. Pilot it at low reps before paying for n.
                const cited = ok && GROUP_SCORERS.extraction!(answer)
                    && r.excerptVerified === true
                return {
                    arm,
                    source: src,
                    verifyHash: contentHash(verifyTargets.get(src) ?? ''),
                    nonTerminating: !ok,
                    usable: cited,
                    ms: Date.now() - t0,
                    note:
                        !ok ? 'child failed'
                        : r.excerptVerified === true ? 'ok (excerpt verified)'
                        : r.excerpt === undefined ? 'answered, NO excerpt cited'
                        : 'answered, excerpt UNVERIFIED — not in the content shown',
                    // THE RAW CHILD TURN, not the parsed answer. `excerptVerified`
                    // is computed from the `<excerpt>` tag, which the answer body
                    // does not contain — storing only the answer would make this
                    // axis unrescorable, the exact failure that voided 28 phase
                    // trials. A rescorer recovers the verify target by replaying
                    // `docsRaw` for this row's `source`, which needs no GPU.
                    ...capture(r.stdout)
                }
            }
        }
    }

    return null
}

// ─── Verdict ─────────────────────────────────────────────────────────────────

function summarise(trials: Trial[], arm: Arm): ArmStats {
    const mine = trials.filter(t => t.arm === arm)
    return {
        n: mine.length,
        nonTerminating: mine.filter(t => t.nonTerminating).length,
        usable: mine.filter(t => t.usable).length,
        // Only usable trials time anything meaningful: a child killed at its
        // budget reports the budget, not how long the work takes.
        msOfUsable: mine.filter(t => t.usable).map(t => t.ms),
        // Same filter, same order, so the ladder can pair by stimulus. Groups
        // that reuse one fixture (`planning`) repeat an id here and the ladder
        // falls back to the unpaired test on its own.
        stimuliOfUsable: mine.filter(t => t.usable).map(t => t.source)
    }
}

/**
 * The three-way decision.
 *
 * `off` wins only when it is NOT WORSE on both quality axes and strictly faster.
 * Anything else is a tie, and a tie means `inherit` — the honest answer when a
 * measurement did not separate the arms.
 */

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * True unless the check fails TWICE in a row, with a pause between.
 *
 * The checks this wraps cannot distinguish a real change from a probe that timed
 * out, and on this hardware the second is common and the first is rare. Two
 * consecutive failures separate them without weakening the guard, because the
 * condition it watches for is not transient.
 */
async function confirm(check: () => Promise<boolean>, pauseMs = 3_000): Promise<boolean> {
    if (await check()) return true
    await new Promise(r => setTimeout(r, pauseMs))
    return await check()
}

type Ready = 'ok' | 'swapped' | 'gone'

/**
 * Block until the endpoint is answering as the SAME model, or give up.
 *
 * Down and swapped are different failures and must not share an outcome: a
 * crashed server comes back and the run continues from the ledger, while a
 * swapped one has changed the instrument and every remaining trial would belong
 * to a different experiment.
 */
async function waitReady(watch: {
    stillAlive(): Promise<boolean>
    unchanged(): Promise<boolean>
}): Promise<Ready> {
    const deadline = Date.now() + MODEL_WAIT_MS
    let announced = false
    for (;;) {
        if (await confirm(() => watch.stillAlive())) {
            if (await confirm(() => watch.unchanged())) {
                if (announced) console.log('  … model is back, same identity — resuming')
                return 'ok'
            }
            return 'swapped'
        }
        if (Date.now() >= deadline) return 'gone'
        if (!announced) {
            console.log(
                '  … model endpoint is down — waiting up to '
                    + `${Math.round(MODEL_WAIT_MS / 60_000)} min for it to come back`
            )
            announced = true
        }
        await new Promise(r => setTimeout(r, MODEL_POLL_MS))
    }
}

/** The identifying half of a /props body: what is loaded, and which build. */
function summariseServer(fingerprint: string | null): string {
    if (fingerprint === null) return 'unpublished'
    try {
        const j = JSON.parse(fingerprint) as {model_path?: unknown; build_info?: unknown}
        const model = typeof j.model_path === 'string' ? j.model_path : '?'
        const build = typeof j.build_info === 'string' ? j.build_info : '?'
        return `${model}  (${build})`
    } catch {
        return fingerprint.slice(0, 120)
    }
}

async function main(): Promise<void> {
    const [groupArg, modelLabel, repsArg] = process.argv.slice(2)
    const reps = Number(repsArg ?? 20)
    if (!groupArg || !modelLabel) {
        console.error(
            'usage: live-reasoning-group-ab.ts <group> <modelLabel> [REPS=20]\n'
                + `  measurable groups: ${MEASURABLE.join(', ')}\n`
                + `  env: AB_CORPUS (default ${CORPUS_ROOT}), AB_MODEL_URL, AB_CONTEXT_WINDOW`
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }
    const group = groupArg as ReasoningGroup
    if (!REASONING_GROUPS.includes(group)) {
        console.error(`ABSTAIN — "${groupArg}" is not a reasoning group.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }
    if (!MEASURABLE.includes(group)) {
        console.error(
            `ABSTAIN — group "${group}" is not measurable by THIS harness.`
                + (group === 'implementation' ?
                    '\n  The implementation turn runs in the host session, not a child, so it'
                    + ' cannot be measured by spawning one. It is 38.8% of a real run — see'
                    + ' scripts/live-implementation-thinking-ab.ts.'
                : group === 'plan' ?
                    '\n  /task-plan did not run at all in the recorded corpus (0% of wall'
                    + ' clock), so there is nothing to replay and nothing to gain.'
                : group === 'research' ?
                    '\n  Since the 2026-08-28 split this cell is the ad-hoc pi-worker TOOL'
                    + ' plus the fallback for an unset worker. The tool is invoked by a'
                    + ' model mid-turn with a free-text question, so there is no recorded'
                    + ' stimulus to replay. Measure research:files or research:tooling.'
                :   '')
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }

    // PI_TASK_CONFIG_PATH is the developer's own config unless the caller pinned
    // it. bunfig's test-ambient-isolation preload is `bun test` only.
    if (!process.env.PI_TASK_CONFIG_PATH) {
        console.error(
            'ABSTAIN — PI_TASK_CONFIG_PATH is unset, so this run would read the'
                + " developer's saved /task-config and measure the machine, not the code."
                + ' Re-run with PI_TASK_CONFIG_PATH=$(mktemp).'
        )
        process.exit(EXIT_CODE.ABSTAIN)
    }

    // Before any GPU: the gate scorer reads a production parser through a
    // sentinel string. If that drifted, every verdict-less answer would score
    // usable and the cell would come back at a ceiling again.
    const parserProblem = verdictParserContractProblem()
    if (parserProblem) {
        console.error(`ABSTAIN — ${parserProblem}. Fix the gate scorer before spending GPU.`)
        process.exit(EXIT_CODE.ABSTAIN)
    }

    const {watch, fingerprint} = await requirePreconditions('live-reasoning-group-ab', {
        model: {url: MODEL_IDENTITY_URL, timeoutMs: PROBE_TIMEOUT_MS, identity: llamaModelIdentity},
        piBin: true,
        cacheOff: true
    })

    const exp = await buildExperiments(group)
    if (!exp) {
        console.error(`ABSTAIN — no experiment wired for "${group}".`)
        process.exit(EXIT_CODE.ABSTAIN)
    }

    console.log(`\n=== reasoning group A/B — ${group} (${exp.child}) ===`)
    console.log(`label:   ${modelLabel}`)
    console.log(`server:  ${summariseServer(fingerprint)}`)
    console.log(`stimulus:${exp.stimulus}`)
    console.log(`arms:    off  vs  ${REASONING_ON_LEVEL}     reps: ${reps} per arm`)
    console.log(`ctx win: ${CONTEXT_WINDOW} (guards armed)`)
    // Printed BEFORE the first rep, so the run declares up front whether it can
    // reach significance rather than discovering it after six hours.
    console.log(
        `floor:   best attainable p at ${reps}v${reps} = ${minAttainableP(reps, reps).toFixed(5)}`
    )
    console.log(
        "NOTE: measured under this server's global sampler settings, which are the\n"
            + '      THINKING preset. That is the regime pi-task actually runs in on this\n'
            + '      machine, so the result is ecologically valid — but it is NOT a clean\n'
            + '      comparison: the off arm decodes on sampling tuned for the on arm.\n'
    )

    const done = loadLedger(group, reps, fingerprint)
    if (done.size > 0) {
        console.log(
            `resume:  ${done.size} trial(s) already in the ledger for this exact model,`
                + ' group and rep count — skipping them'
        )
    }
    console.log(`ledger:  ${ledgerPath()}\n`)

    const trials: Trial[] = []
    const order = armOrder(reps * 2)
    for (let i = 0; i < order.length; i++) {
        const arm = order[i]!
        // Built per REP (a pair of trials): both arms of a pair see the same
        // bytes, and different pairs replay different real tasks. Built even for
        // a skipped trial, so `build`'s per-rep side effects — the extraction
        // group's verify targets — stay in step with the trial index.
        const built = exp.build(Math.floor(i / 2))
        const cached = done.get(i)
        if (cached && cached.arm === arm && cached.source === built.source) {
            trials.push(cached)
            console.log(
                `  ${String(i + 1).padStart(3)}/${order.length} ${arm.padEnd(6)} SKIP    `
                    + `already in ledger  ${cached.source}`
            )
            continue
        }
        // A restart mid-run silently changes the thing under test: the arms
        // before and after are two different experiments wearing one name. A
        // server that is merely DOWN is waited out instead — see waitReady.
        const ready = await waitReady(watch)
        if (ready === 'swapped') {
            abstainMidRun(
                'live-reasoning-group-ab',
                'the endpoint is answering as a DIFFERENT model than the one this run started'
                    + ' against. That is a swap, not a restart, so the arms before and after it'
                    + ` are not comparable. Finished trials are kept in ${ledgerPath()}.`
            )
        }
        if (ready === 'gone') {
            abstainMidRun(
                'live-reasoning-group-ab',
                `the model did not come back within ${Math.round(MODEL_WAIT_MS / 60_000)} min.`
                    + ` Finished trials are kept in ${ledgerPath()} — bring the server up and`
                    + ' re-run the same command to continue from there.'
            )
        }
        const t = await exp.run(built, arm)
        trials.push(t)
        appendTrial(t, i, group, reps, fingerprint)
        console.log(
            `  ${String(i + 1).padStart(3)}/${order.length} ${arm.padEnd(6)} `
                + `${
                    t.usable ? 'USABLE '
                    : t.nonTerminating ? 'DEAD   '
                    : 'UNUSABLE'
                } `
                + `${String(t.ms).padStart(7)}ms  ${t.source.padEnd(11)} ${t.note}`
        )
    }

    const off = summarise(trials, 'off')
    const on = summarise(trials, REASONING_ON_LEVEL as Arm)
    console.log('')

    // Neither arm producing anything usable is the false pass this layer exists
    // to prevent: a zero-vs-zero comparison "ties", and a tie would be written
    // down as a measured result.
    if (off.usable === 0 && on.usable === 0) {
        console.log('*** ABSTAIN — NEITHER ARM PRODUCED A USABLE ANSWER ***')
        console.log('The stimulus never exercised the child, so the levels were never compared.')
        console.log('Fix the stimulus and re-run. Do NOT record this as a tie.')
        process.exit(EXIT_CODE.ABSTAIN)
    }

    // The gate cell's quality axis is no longer "did it answer" — it is "was the
    // answer right", against a tree the harness itself verified. Naming it in
    // the verdict matters: a reader who sees "usable output" beside a gate row
    // would read the saturated axis that already returned 10/10 twice.
    const {winner, rung, saturated, lines} = decide(
        off,
        on,
        undefined,
        group === 'gate' ? {quality: 'correct verdict', termination: 'no verdict at all'}
        : group === 'research:files' ?
            {quality: 'every path real', termination: 'no answer at all'}
        : group === 'research:tooling' ?
            {quality: 'every command runs', termination: 'no answer at all'}
        :   undefined
    )
    for (const l of lines) console.log(l)
    const cell = winner
    console.log('')
    console.log(`VERDICT (${modelLabel}, group ${group}): ${cell}  [rung ${rung}]`)
    if (saturated) {
        console.log(
            'NOT WRITABLE — the quality axis was saturated, so this run compared'
                + ' nothing. A cell written from it would record a prior as a'
                + ' measurement. Build an axis with headroom and re-measure; the'
                + ' ledger keeps the trials.'
        )
    } else {
        console.log(
            `Record it as: ${group}: '${cell}',  // A/B ${modelLabel} n=${reps}/arm `
                + `— off ${off.usable}/${off.n} usable,`
                + ` ${REASONING_ON_LEVEL} ${on.usable}/${on.n}`
                + `, rung ${rung}${rung === 3 ? ' (PRIOR, not evidence)' : ''}`
        )
    }
    console.log(
        'A cell only generalises if it reproduces on the other models. One model is'
            + ' one data point, and this table is a constant for everyone.'
    )
    process.exit(EXIT_CODE.PASS)
}

/**
 * The groups THIS harness can measure.
 *
 * `implementation` runs in the host session and needs its own harness;
 * `plan` never ran in the recorded corpus, so there is nothing to replay.
 * Declared rather than inferred, so the usage banner cannot advertise a group
 * that immediately abstains — which the previous version did.
 */
const MEASURABLE: ReasoningGroup[] = [
    'planning',
    'phase',
    'research:files',
    'research:apis',
    'research:context',
    'research:tooling',
    'gate',
    'extraction'
]

await main()
