/**
 * ZERO-RETRIEVAL GATE — THE A/B. Does the deterministic zero-retrieval gate stop worker:apis
 * from SHIPPING an APIS section it produced with no retrieval at all (every symbol recalled
 * from parametric memory)?
 *
 * This is a DISTINCT failure from the STAGE 1-3 stopping-point/escalation thread and is scored
 * separately (nexxtasks:1058, :1076). The stopping-point work asked "why does a worker that
 * DID retrieve judge itself finished". This asks a stronger question: some reps retrieve
 * NOTHING and still emit a complete, plausible section. STAGE 1's own scorer excludes those
 * reps by construction (live-apis-stopping-point.ts filters `docsSteps > 0`).
 *
 * ── WHY A GATE AND NOT AN INSTRUCTION ─────────────────────────────────────────────────────
 *
 * RESEARCH_APIS_PROMPT ALREADY instructs tool use ("Use the read, grep, find, ls tools — and
 * `pi-worker-docs`…") and the worker skips it anyway. STAGE 2 proved a prompt line does not
 * move grounding (its abstention instruction was used 0/40); STAGE 3 proved a symbol-grounding
 * brace-gate cannot discriminate a PROSE semantics clause. The shape that has worked is a
 * deterministic gate keyed on a CHECKABLE HANDLE (PROMPT 1's braces; CONTEXT's
 * demoteUnsourcedAttributions). This failure has a trivial one that STAGE 3 lacked:
 * groundingRetrievalCount === 0. A section built on zero retrieval is ungrounded BY
 * CONSTRUCTION — no semantic judgement needed.
 *
 * THE LEVER (shipped in src, treatment arm): phases.ts runSpec re-runs worker:apis ONCE with a
 * forced retrieval-first preamble when its first pass emitted a non-empty section with
 * groundingRetrievalCount === 0, and keeps the retry only if it actually retrieved. The
 * grounding-retrieval classes are pi-worker-docs/read/grep/search/fetch — `ls`/`find` are
 * EXCLUDED (they return names, and APIS owns symbols not paths), which is the anti-gaming
 * property: "one trivial `ls` then fabricate the rest" leaves the count at 0 and still fires.
 *
 * ── THE PRIMARY METRIC, DECLARED BEFORE THE RUN ───────────────────────────────────────────
 *
 * Per PRODUCTIVE rep (non-empty section, no error): did the shipped section carry ZERO
 * grounding-retrieval tool calls across the whole worker:apis trajectory (original + any
 * retry)? Read at the TOOL LAYER from the trial log via parseTrajectory + the COMMITTED
 * isGroundingRetrieval predicate (src/workers/pi-worker-core.ts), never model self-report. In
 * the treatment arm a fired-and-recovered rep has the retry's retrieval calls in the same log,
 * so it scores as GROUNDED — the metric measures the SHIPPED outcome, which is the point.
 *
 * MEASURED BASELINE (STEP 0, ungated): pooled 4/34 = 11.8% of reps ship a zero-retrieval
 * section (clean run 1/16, historical 3/18; Wilson95 [4.7%, 26.6%]). Both fixtures contribute.
 *
 * VERDICT: treatment zero-retrieval-ship rate strictly below baseline, one-tailed Fisher
 * p < ALPHA over PRODUCTIVE reps. The gate must have FIRED at least MIN_FIRINGS times in the
 * treatment arm or the run ABSTAINs — a lever never exercised proves nothing.
 *
 * ── INVARIANTS (all must hold; thresholds fixed before the data) ──────────────────────────
 *
 * STAGE 2 moved its target metric 10x and still FAILED on fabrication. So a moved primary is
 * not a PASS on its own:
 *   1. ungrounded-SYMBOL rate of the emitted section must not RISE (one-tailed Fisher for a
 *      rise, p >= ALPHA) AND entries must not collapse (invariant 2). Same conservative
 *      grounding as STAGE 1 (identifier tokens, no stop-list, union of every channel ⇒ FLOOR).
 *   2. APIS entry count must not collapse (treatment >= ENTRY_COLLAPSE_FLOOR x baseline): a
 *      silenced worker is a different regression.
 *   3. no runaway: the forced retry must not push APIS into the ~37-read tail. No treatment
 *      rep exceeds RUNAWAY_CALL_CEILING worker:apis tool calls, treatment total grounding
 *      calls <= COST_CEILING x baseline, and wall clock <= COST_CEILING x baseline mean.
 *   + SURGERY HELD: the baseline arm NEVER retried (the gate condition is hard-false there),
 *     verified per rep, and the two dist copies differ by the gate strip ALONE.
 *
 * ── THE TWO ARMS ──────────────────────────────────────────────────────────────────────────
 *
 * One process, two privately patched dist copies, arms INTERLEAVED (baseline rep i, then
 * treatment rep i) over both fixtures, so the llama-server's multi-hour drift lands on both.
 *   treatment  the real shipped path (the gate fires).
 *   baseline   the same dist with the gate condition surgically hard-disabled to `false`, so
 *              the retry can never run. Asserted three ways: buildPatchedDist refuses an anchor
 *              that is not unique; the two loaded dist files are checked to differ by the strip
 *              alone at startup; and every baseline rep is checked to have NOT retried.
 * The network is stubbed (offline web, same as the contract A/B) so escalation is deterministic
 * and every counter here is re-scorable offline. Nothing else is stubbed: real phaseResearch,
 * the shipped model, the real tools.
 *
 * Run (`bun run build` first — this imports from patched copies of dist/):
 *   PI_BIN=$(command -v pi) bun run scripts/live-apis-zero-retrieval-ab.ts [REPS_PER_ARM] [FIXTURE]
 * Re-score a completed run offline, no model time:
 *   AB_DIR=~/tmp/apis-zero-retrieval-ab bun run scripts/live-apis-zero-retrieval-ab.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {
    TYPEONLY_LOG_ENV,
    readTypeOnlyLog,
    type TypeOnlyLogRecord
} from '../src/workers/typeonly-log.js'
import {isGroundingRetrieval, runWorker} from '../src/workers/pi-worker-core.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'
import {buildPatchedDist, stubSearchExtension, type Surgery} from './spec-url-dist.js'
import {fisherOneTail} from './prompt1-combined-verdict.js'
import {
    FIXTURES,
    CALLS_LOG_ENV,
    assertFetchToolReachable,
    buildFixtureTree,
    writeStubExtension,
    type SpecUrlFixture
} from './spec-url-fixtures.js'
import {
    extractSection,
    groundEntries,
    parseApisEntries,
    parseTrajectory,
    readTouchedFiles,
    type GroundingCorpus,
    type Step
} from './apis-trajectory.js'
import {requirePreconditions} from './ab-preflight.js'

const REPS = Number(process.argv[2] ?? '20')
const WHICH = process.argv[3] ?? 'all'
/** `||` not `??`, absolute: a set-but-empty env var is not nullish, and the sink path is read
 *  inside the pi child whose cwd is the trial tree. */
const ROOT = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'apis-zero-retrieval-ab')
)
const TRIAL_TIMEOUT_MS = 45 * 60_000
const PROMPT_DUMP_ENV = 'PI_TASK_PROMPT_DUMP'

/** THE VERDICT THRESHOLD, fixed before any data exists. */
const ALPHA = 0.05
/** Invariant 2's floor: a worker silenced into fewer entries is a regression, not a fix. */
const ENTRY_COLLAPSE_FLOOR = 0.8
/** Invariant 3's ceiling on added cost. The retry legitimately ~doubles calls on a FIRED rep,
 *  so 2x is the natural bound; anything past it is thrash, not the retry. */
const COST_CEILING = 2
/** Invariant 3's absolute per-rep call cap. A healthy APIS rep does up to ~21 calls; a fired
 *  rep's retry ~doubles that to ~42. 45 flags a genuine runaway (the ~37-read tail), not the
 *  retry doing its job. */
const RUNAWAY_CALL_CEILING = 45
/** The lever must be EXERCISED this many times in treatment or the run proves nothing. */
const MIN_FIRINGS = 3

/** STEP 0 base rate (ungated), printed in the banner so the comparison is on screen. */
const STEP0 = {ungroundedShipReps: 4, reps: 34, pct: 11.8} as const

type Arm = 'baseline' | 'treatment'

/** The grounding-retrieval marker line runSpec logs when the gate fires. */
const GATE_FIRE_MARKER = 'zero-retrieval — retrying'

interface RepResult {
    fixture: string
    arm: Arm
    rep: number
    /** PRIMARY (over productive reps): the shipped section carried NO grounding retrieval. */
    ungroundedShip: boolean
    /** The section had at least one entry and the rep did not error. */
    productive: boolean
    /** Did the gate fire on this rep (treatment only; baseline must always be false). */
    retriedByGate: boolean
    /** Grounding-retrieval tool calls across the whole worker:apis trajectory. */
    groundingCalls: number
    /** All worker:apis tool calls with an argument — the runaway guard's unit. */
    toolCalls: number
    /** search/fetch calls (offline-stubbed), reported for cost only. */
    escalations: number
    docsAnswers: number
    entries: number
    symbols: number
    ungroundedSymbols: number
    /** entries grounded by a RETRIEVAL channel (docs/read), not prompt-only — the diagnostic
     *  that the section is backed by retrieved content, not re-emitted memory. */
    retrievalGroundedEntries: number
    /** The emitted section verbatim, so every counter here is re-scorable offline. */
    apisSection: string
    minutes: number
    error?: string
}

interface PhasesModule {
    phaseResearch: typeof import('../dist/task/phases.js').phaseResearch
}

function corpusOf(
    trialDir: string,
    steps: Step[],
    answers: TypeOnlyLogRecord[],
    prompt: string
): GroundingCorpus {
    const join = (rs: TypeOnlyLogRecord[]): string =>
        rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt,
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: fs.existsSync(trialDir) ? readTouchedFiles(trialDir, steps) : ''
    }
}

async function runRep(
    mod: PhasesModule,
    fixture: SpecUrlFixture,
    arm: Arm,
    rep: number
): Promise<RepResult> {
    const dir = path.resolve(buildFixtureTree(path.join(ROOT, arm), fixture, rep))
    const sink = path.join(dir, 'answers.jsonl')
    const calls = path.join(dir, 'calls.log')
    const dump = path.join(dir, 'prompts.txt')
    for (const p of [sink, calls, dump]) fs.rmSync(p, {force: true})
    process.env[TYPEONLY_LOG_ENV] = sink
    process.env[CALLS_LOG_ENV] = calls
    process.env[PROMPT_DUMP_ENV] = dump

    const logPath = path.join(dir, 'trial.log')
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
                logDebug: m => fs.appendFileSync(logPath, `[debug] ${m}\n`)
            },
            fixture.refined
        )
    } catch (e) {
        error = String(e).slice(0, 200)
    } finally {
        clearTimeout(timer)
    }

    const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
    const logText = read(logPath)
    const answers = readTypeOnlyLog(read(sink))
    const steps = parseTrajectory(logText)
    const section = extractSection(research, 'APIS')
    const apisPrompt = read(dump).split('===== ').find(s => s.startsWith('worker:apis')) ?? ''
    const corpus = corpusOf(dir, steps, answers, apisPrompt)
    const grounded = groundEntries(parseApisEntries(section), corpus)
    const groundingCalls = steps.filter(s => s.arg.length > 0 && isGroundingRetrieval(s.tool)).length
    const productive = !error && grounded.length > 0

    return {
        fixture: fixture.name,
        arm,
        rep,
        ungroundedShip: productive && groundingCalls === 0,
        productive,
        retriedByGate: logText.includes(GATE_FIRE_MARKER),
        groundingCalls,
        toolCalls: steps.filter(s => s.arg.length > 0).length,
        escalations: steps.filter(
            s => s.tool === 'pi-worker-search' || s.tool === 'pi-worker-fetch'
        ).length,
        docsAnswers: answers.length,
        entries: grounded.length,
        symbols: grounded.reduce((a, g) => a + g.entry.symbols.length, 0),
        ungroundedSymbols: grounded.reduce((a, g) => a + g.ungrounded.length, 0),
        retrievalGroundedEntries: grounded.filter(g =>
            g.channels.some(c => c === 'docs-package' || c === 'docs-project' || c === 'read')
        ).length,
        apisSection: section,
        minutes: (Date.now() - started) / 60000,
        ...(error ? {error} : {})
    }
}

/** Dump every assembled worker prompt — observation only, applied identically to BOTH arms.
 *  Anchored on the `basePrompt` binding (worker:apis's runSpec assembles the prompt once there,
 *  then reuses it for the gate retry), so the dump is per worker, not per attempt. */
const PROMPT_DUMP: Surgery = {
    file: 'task/phases.js',
    find: "        const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt;",
    replace:
        '        const basePrompt = (p => { try { const s = process.env['
        + JSON.stringify(PROMPT_DUMP_ENV)
        + "]; if (s) require('node:fs').appendFileSync(s, '\\n===== ' + spec.label"
        + " + ' =====\\n' + p) } catch {} return p })"
        + "(typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt);",
    label: 'dump every assembled worker prompt (observation only, both arms)'
}

/**
 * BASELINE surgery: hard-disable the zero-retrieval gate so the retry can never run. The three
 * `&&` clauses and the whole body are left byte-identical — only the first operand flips to
 * `false`, so the arms differ by the gate firing and by nothing else.
 */
const STRIP_GATE: Surgery = {
    file: 'task/phases.js',
    find:
        '        if (spec.zeroRetrievalRetry\n'
        + '            && r.groundingRetrievalCount === 0\n'
        + '            && r.text.trim().length > 0) {',
    replace:
        '        if (false /* STRIP_ZERO_RETRIEVAL_GATE — baseline arm */\n'
        + '            && r.groundingRetrievalCount === 0\n'
        + '            && r.text.trim().length > 0) {',
    label: 'hard-disable the zero-retrieval gate (baseline arm)'
}

/** Read a patched dist's phases.js and confirm the gate is present/absent as the arm requires. */
function assertGateState(distRoot: string, arm: Arm): string {
    const text = fs.readFileSync(path.join(distRoot, 'task', 'phases.js'), 'utf8')
    const live = text.includes('if (spec.zeroRetrievalRetry')
    const stripped = text.includes('STRIP_ZERO_RETRIEVAL_GATE')
    if (arm === 'treatment' && (!live || stripped)) {
        throw new Error('treatment dist does not carry the LIVE zero-retrieval gate')
    }
    if (arm === 'baseline' && (live || !stripped)) {
        throw new Error('baseline dist still carries the LIVE zero-retrieval gate')
    }
    return text
}

async function runAll(): Promise<RepResult[]> {
    await requirePreconditions('live-apis-zero-retrieval-ab', {model: {}, piBin: true, cacheOff: true})
    fs.mkdirSync(ROOT, {recursive: true})
    const stubSurgery = stubSearchExtension(writeStubExtension(ROOT))
    const treatmentDist = buildPatchedDist('apis-zero-retrieval-treatment', [stubSurgery, PROMPT_DUMP])
    const baselineDist = buildPatchedDist('apis-zero-retrieval-baseline', [
        stubSurgery,
        PROMPT_DUMP,
        STRIP_GATE
    ])

    // Startup proof the arms differ by the gate strip ALONE: apply the same find->replace to the
    // treatment dist text and it must reproduce the baseline dist text byte for byte.
    const treatText = assertGateState(treatmentDist, 'treatment')
    const baseText = assertGateState(baselineDist, 'baseline')
    if (treatText.split(STRIP_GATE.find).join(STRIP_GATE.replace) !== baseText) {
        throw new Error(
            'ARMS DIFFER BY MORE THAN THE LEVER: stripping the gate from the treatment dist does '
                + 'not reproduce the baseline dist. Whatever else differs would be confounded with '
                + 'the gate in every number this run prints.'
        )
    }

    // Prove a real child can reach the stubbed fetch tool BEFORE spending hours — a failed
    // extension load leaves no error and both arms would silently read zero escalations.
    await assertFetchToolReachable(ROOT, buildFixtureTree(ROOT, FIXTURES[0], 0), runWorker)

    const mods: Record<Arm, PhasesModule> = {
        baseline: (await import(path.join(baselineDist, 'task', 'phases.js'))) as PhasesModule,
        treatment: (await import(path.join(treatmentDist, 'task', 'phases.js'))) as PhasesModule
    }
    const fixtures = WHICH === 'all' ? FIXTURES : FIXTURES.filter(f => f.name === WHICH)
    if (fixtures.length === 0) {
        console.error(
            `unknown fixture "${WHICH}"; expected all | ${FIXTURES.map(f => f.name).join(' | ')}`
        )
        process.exit(1)
    }

    console.log(
        `live-apis-zero-retrieval-ab — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
            + `real phaseResearch, offline web, ${REPS} reps per arm per fixture over `
            + `${fixtures.map(f => f.name).join(', ')}\n`
            + `PRIMARY: fewer PRODUCTIVE reps ship a ZERO-grounding-retrieval section. STEP 0 `
            + `baseline ${STEP0.ungroundedShipReps}/${STEP0.reps} = ${STEP0.pct}%. `
            + `Threshold: Fisher one-tailed p < ${ALPHA}, and >= ${MIN_FIRINGS} gate firings.\n`
            + `surgery verified: treatment carries the live gate, baseline is stripped, and the `
            + `two dist copies differ by the strip alone.`
    )

    const rows: RepResult[] = []
    for (const f of fixtures) {
        for (let rep = 1; rep <= REPS; rep++) {
            for (const arm of ['baseline', 'treatment'] as const) {
                const r = await runRep(mods[arm], f, arm, rep)
                rows.push(r)
                console.log(
                    `  ${f.name} ${arm.padEnd(9)} rep ${rep}/${REPS}: `
                        + `grounding=${r.groundingCalls} tool=${r.toolCalls} `
                        + `${r.ungroundedShip ? 'ZERO-RETRIEVAL-SHIP' : 'grounded'} `
                        + `${r.retriedByGate ? 'GATE-FIRED' : ''} `
                        + `entries=${r.entries} ungr=${r.ungroundedSymbols}/${r.symbols} `
                        + `esc=${r.escalations} [${r.minutes.toFixed(1)}m]`
                        + (r.error ? `  ERROR ${r.error}` : '')
                )
                // Persisted after EVERY rep so a crash late in the run keeps the earlier reps.
                fs.writeFileSync(path.join(ROOT, 'ab.json'), JSON.stringify(rows), 'utf8')
            }
        }
    }
    return rows
}

function loadRows(): RepResult[] {
    const saved = path.join(ROOT, 'ab.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: AB_DIR set but ${saved} does not exist.`)
        process.exit(1)
    }
    console.log(`live-apis-zero-retrieval-ab — RE-SCORING ${saved} (no model time)`)
    return JSON.parse(fs.readFileSync(saved, 'utf8')) as RepResult[]
}

function main(rows: RepResult[]): void {
    const of = (arm: Arm, fixture?: string): RepResult[] =>
        rows.filter(r => r.arm === arm && (fixture === undefined || r.fixture === fixture))
    const prod = (rs: RepResult[]): RepResult[] => rs.filter(r => r.productive)
    const shipHits = (rs: RepResult[]): number => rs.filter(r => r.ungroundedShip).length
    const sum = (rs: RepResult[], f: (r: RepResult) => number): number =>
        rs.reduce((a, r) => a + f(r), 0)
    const mean = (rs: RepResult[], f: (r: RepResult) => number): number =>
        rs.length === 0 ? 0 : sum(rs, f) / rs.length
    const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`)
    const B = of('baseline')
    const T = of('treatment')
    const Bp = prod(B)
    const Tp = prod(T)
    const fixtureNames = [...new Set(rows.map(r => r.fixture))]
    const firings = T.filter(r => r.retriedByGate).length

    console.log(`\n=== PRIMARY — PRODUCTIVE reps shipping a ZERO-grounding-retrieval section ===`)
    for (const f of fixtureNames) {
        const b = prod(of('baseline', f))
        const t = prod(of('treatment', f))
        console.log(
            `  ${f.padEnd(16)} baseline ${shipHits(b)}/${b.length} = ${pct(shipHits(b), b.length)}`
                + `   treatment ${shipHits(t)}/${t.length} = ${pct(shipHits(t), t.length)}`
                + `   Fisher one-tailed p = ${fisherOneTail(
                    shipHits(b),
                    b.length - shipHits(b),
                    shipHits(t),
                    t.length - shipHits(t)
                ).toFixed(4)}`
        )
    }
    // Baseline first: improvement is FEWER hits, so we test P(baseline hits >= observed).
    const pooledP = fisherOneTail(
        shipHits(Bp),
        Bp.length - shipHits(Bp),
        shipHits(Tp),
        Tp.length - shipHits(Tp)
    )
    console.log(
        `  ${'POOLED'.padEnd(16)} baseline ${shipHits(Bp)}/${Bp.length} = ${pct(shipHits(Bp), Bp.length)}`
            + `   treatment ${shipHits(Tp)}/${Tp.length} = ${pct(shipHits(Tp), Tp.length)}`
            + `   Fisher one-tailed p = ${pooledP.toFixed(4)}   (STEP 0: ${STEP0.pct}%)`
    )
    console.log(
        `  GATE FIRINGS in treatment: ${firings}/${T.length}`
            + `   (each is a rep whose first pass retrieved nothing — the lever exercised)`
    )

    console.log(`\n=== PER-ARM COUNTERS (per-rep means unless stated) ===`)
    const cols = ['prodReps', 'zeroShip', 'entries', 'ungr/sym', 'retrGr', 'grCalls', 'toolCalls', 'esc', 'min']
    console.log(`  ${'arm'.padEnd(10)}${cols.map(c => c.padStart(10)).join('')}`)
    for (const [name, rs] of [
        ['baseline', Bp],
        ['treatment', Tp]
    ] as const) {
        console.log(
            `  ${name.padEnd(10)}`
                + [
                    String(rs.length),
                    String(shipHits(rs)),
                    mean(rs, r => r.entries).toFixed(1),
                    `${sum(rs, r => r.ungroundedSymbols)}/${sum(rs, r => r.symbols)}`,
                    pct(sum(rs, r => r.retrievalGroundedEntries), sum(rs, r => r.entries)),
                    mean(rs, r => r.groundingCalls).toFixed(1),
                    mean(rs, r => r.toolCalls).toFixed(1),
                    mean(rs, r => r.escalations).toFixed(1),
                    mean(rs, r => r.minutes).toFixed(1)
                ]
                    .map(v => v.padStart(10))
                    .join('')
        )
    }
    console.log(
        `  retrGr = share of entries grounded by a RETRIEVAL channel (docs/read), not prompt-only`
            + ` — evidence the retry grounds in retrieved content, not re-emitted memory.`
    )

    console.log(`\n=== every ZERO-RETRIEVAL-SHIP rep, both arms (the metric, auditable by hand) ===`)
    for (const r of rows.filter(x => x.ungroundedShip)) {
        console.log(
            `  ${r.arm.padEnd(9)} ${r.fixture} r${r.rep}  entries=${r.entries} `
                + `firstLine="${r.apisSection.split('\n')[0]?.slice(0, 90) ?? ''}"`
        )
    }
    console.log(`\n  raw data: ${path.join(ROOT, 'ab.json')} + per-rep trial trees under ${ROOT}`)

    // ── invariants ───────────────────────────────────────────────────────────
    const baseUngr = sum(Bp, r => r.ungroundedSymbols)
    const treatUngr = sum(Tp, r => r.ungroundedSymbols)
    const ungrRiseP = fisherOneTail(
        treatUngr,
        sum(Tp, r => r.symbols) - treatUngr,
        baseUngr,
        sum(Bp, r => r.symbols) - baseUngr
    )
    const baseEntries = mean(Bp, r => r.entries)
    const treatEntries = mean(Tp, r => r.entries)
    const baseGrounding = sum(Bp, r => r.groundingCalls)
    const treatGrounding = sum(Tp, r => r.groundingCalls)
    const maxTreatCalls = Math.max(0, ...T.map(r => r.toolCalls))

    const invariants: Invariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first rep answers)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            // Per rep, not once at startup: the gate can only be off in baseline if no baseline
            // rep ever retried. Startup already proved the code differs by the strip alone.
            label: 'surgery held: the baseline arm NEVER retried (gate hard-disabled)',
            ok: B.every(r => !r.retriedByGate),
            detail: `baseline retried ${B.filter(r => r.retriedByGate).length}/${B.length} reps (must be 0)`
        },
        {
            label: `invariant 1: ungrounded-symbol rate did not RISE (one-tailed Fisher p >= ${ALPHA})`,
            ok: ungrRiseP >= ALPHA,
            detail: `baseline ${baseUngr}/${sum(Bp, r => r.symbols)} vs treatment ${treatUngr}/${sum(Tp, r => r.symbols)}, p(rise) = ${ungrRiseP.toFixed(4)}`
        },
        {
            label: `invariant 2: APIS entry count did not collapse (>= ${ENTRY_COLLAPSE_FLOOR}x baseline)`,
            ok: baseEntries === 0 || treatEntries >= baseEntries * ENTRY_COLLAPSE_FLOOR,
            detail: `baseline ${baseEntries.toFixed(1)}/rep vs treatment ${treatEntries.toFixed(1)}/rep`
        },
        {
            label: `invariant 3a: no treatment rep ran away (<= ${RUNAWAY_CALL_CEILING} worker:apis tool calls)`,
            ok: maxTreatCalls <= RUNAWAY_CALL_CEILING,
            detail: `max treatment tool calls/rep = ${maxTreatCalls}`
        },
        {
            label: `invariant 3b: grounding-retrieval calls did not blow up (<= ${COST_CEILING}x baseline)`,
            ok: baseGrounding === 0 || treatGrounding <= baseGrounding * COST_CEILING,
            detail: `baseline ${baseGrounding} vs treatment ${treatGrounding} grounding calls`
        },
        {
            label: `invariant 3c: wall clock did not blow up (<= ${COST_CEILING}x baseline mean)`,
            ok:
                mean(Bp, r => r.minutes) === 0
                || mean(Tp, r => r.minutes) <= mean(Bp, r => r.minutes) * COST_CEILING,
            detail: `baseline ${mean(Bp, r => r.minutes).toFixed(1)} vs treatment ${mean(Tp, r => r.minutes).toFixed(1)} min/rep`
        },
        {
            label: 'both fixtures exercised (a result on one library is a single-case fit)',
            ok: fixtureNames.length >= 2,
            detail: fixtureNames.join(', ')
        },
        {
            label: 'no rep errored out',
            ok: rows.every(r => !r.error),
            detail: `${rows.filter(r => r.error).length} errored`
        }
    ]

    // The invariants above are HARM/VALIDITY checks — did the gate or the harness misbehave.
    // They are kept SEPARATE from the primary significance test on purpose: an underpowered
    // primary (too few baseline ships to reach p < ALPHA) is NOT a failure of the gate, it is
    // a failure to MEASURE, and must land as ABSTAIN — folding the primary in as an invariant
    // would mislabel a harmless-but-underpowered run as FAIL and wrongly trigger the unwire.
    const broken = invariants.filter(i => !i.ok)
    const primarySignificant = pooledP < ALPHA
    // The gate made things WORSE: treatment shipped SIGNIFICANTLY MORE zero-retrieval sections
    // than baseline. The retry can only ADD grounding, so this should be impossible — but it is
    // the one result that is a real negative (an achieved FAIL), not merely unpowered, so it is
    // checked apart. Statistical, not raw >: in the low-rate regime a 1-vs-0 stochastic blip
    // (baseline happened to sample no zero-retrieval rep while one treatment firing did not
    // recover) is not the gate backfiring, so a bare inequality must not trip a FAIL.
    const backfireP = fisherOneTail(
        shipHits(Tp),
        Tp.length - shipHits(Tp),
        shipHits(Bp),
        Bp.length - shipHits(Bp)
    )
    const backfire = backfireP < ALPHA
    const lines = [
        '',
        '=== VERDICT: live-apis-zero-retrieval-ab ===',
        '  target shape: worker:apis SHIPPING a non-empty APIS section built with zero retrieval',
        `  BASELINE  ${shipHits(Bp)}/${Bp.length} productive reps ship zero-retrieval`,
        `  TREATMENT ${shipHits(Tp)}/${Tp.length} productive reps ship zero-retrieval`,
        `  gate firings in treatment: ${firings}`,
        `  Fisher one-tailed p = ${pooledP.toFixed(4)}   (threshold ${ALPHA}, fixed before the run)`,
        ...invariants.map(
            i => `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`
        )
    ]

    lines.push(
        `  PRIMARY significance: Fisher p = ${pooledP.toFixed(4)} ${primarySignificant ? '<' : '>='} ${ALPHA}`
            + `  (kept apart from the harm invariants above — see note)`
    )

    let outcome: Outcome
    if (T.length === 0 || B.length === 0) {
        outcome = 'ABSTAIN'
        lines.push('', '*** ABSTAIN — an arm has no reps. ***')
    } else if (Bp.length === 0 || Tp.length === 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — an arm produced no non-empty APIS section, so the metric has an empty',
            'denominator. That is a fixture/model problem, not a fact about the gate. ***'
        )
    } else if (broken.length > 0) {
        // A broken HARM/VALIDITY invariant is a real negative regardless of power.
        outcome = 'FAIL'
        lines.push(
            '',
            `FAIL — ${broken.length} harm/validity invariant(s) broken: ${broken.map(i => i.label).join('; ')}`,
            '',
            'A FAIL IS AN ACHIEVED RESULT. Record it with these numbers and UNWIRE the gate from',
            'src (revert the phases.ts/pi-worker-core.ts changes). Do not iterate on wording to',
            'manufacture a pass.'
        )
    } else if (backfire) {
        outcome = 'FAIL'
        lines.push(
            '',
            `FAIL — the gate BACKFIRED: treatment shipped ${shipHits(Tp)} zero-retrieval sections vs`,
            `baseline ${shipHits(Bp)} (Fisher p(rise) = ${backfireP.toFixed(4)} < ${ALPHA}). The retry`,
            'can only add grounding, so this is a real negative. UNWIRE and record it.'
        )
    } else if (firings < MIN_FIRINGS) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            `*** ABSTAIN — the gate fired only ${firings} time(s) (< ${MIN_FIRINGS}), so the lever`,
            'was barely exercised. Harm invariants held (the gate did no damage), but this run',
            'cannot demonstrate benefit. Read the zeros as "not exercised", not "works". ***'
        )
    } else if (primarySignificant) {
        outcome = 'PASS'
        lines.push(
            '',
            `PASS — the gate cut zero-retrieval ships from ${shipHits(Bp)}/${Bp.length} to `
                + `${shipHits(Tp)}/${Tp.length} (Fisher p = ${pooledP.toFixed(4)}) over ${firings} `
                + `firings, harm invariants green — grounding improved, not just the count moved.`
        )
    } else {
        // Gate fired >= MIN_FIRINGS and recovered, no harm, no backfire — but baseline shipped
        // too few zero-retrieval sections for the reduction to clear ALPHA. Underpowered, not
        // failed. This is the STEP 0 low-rate regime landing exactly where it was predicted to.
        outcome = 'ABSTAIN'
        lines.push(
            '',
            `*** ABSTAIN (UNDERPOWERED) — the gate fired ${firings} times and recovered a grounded`,
            `section each time, with no harm invariant broken and no backfire. But baseline shipped`,
            `only ${shipHits(Bp)} zero-retrieval section(s) — too few for the reduction to reach`,
            `p < ${ALPHA} (got ${pooledP.toFixed(4)}). The gate WORKS on the firings observed; this`,
            `run lacks the baseline events to prove population-level significance. Do NOT read this`,
            `as PASS, and do NOT unwire — it is a measurement limit, exactly the STEP 0 low-rate`,
            `regime. A powered primary needs ~5 baseline ships (~85 baseline reps at ~6%). ***`
        )
    }
    report({outcome, lines})
}

if (process.env.AB_DIR) {
    main(loadRows())
} else {
    runAll()
        .then(main)
        .catch(e => {
            console.error(e)
            process.exit(1)
        })
}
