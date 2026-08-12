/**
 * STAGE 2 STEP D — THE A/B. Does changing the APIS OUTPUT CONTRACT make worker:apis ask
 * behaviour questions about the packages it writes entries for?
 *
 * ── THE TWO METRICS, DECLARED IN WRITING BEFORE THE RUN ───────────────────────────────────
 *
 * PRIMARY — decides the verdict. Per rep: did worker:apis issue at least one BEHAVIOUR-class
 * PACKAGE docs query? Recorded at the TOOL LAYER from the shipped PI_TASK_TYPEONLY_LOG sink,
 * classified by the COMMITTED `classifyQuery` in scripts/apis-trajectory.ts, UNCHANGED (it was
 * fixed against a 2-rep smoke run before Stage 1 was scored; retuning it now would measure the
 * retuning). Never model self-report. NOT "did it stop" — that metric is what made PROMPT 2's
 * p = 0.88 unreadable, because the lever it scored could not mechanically move it.
 *
 * Why this lever CAN move this metric: the lever changes what the worker must PRODUCE — a
 * semantics clause per third-party entry — and the only way to produce one is to ask for one.
 *
 * MEASURED BASELINE (Stage 1, commit 807ffad, 16 live reps on these same two fixtures, taken
 * BEFORE the lever existed in the build): 2/15 reps = 13.3%; both fixtures contribute (task27
 * 1/7, task28 1/8), so it is not a single-fixture artifact. Package-query behaviour share
 * 3/61 = 4.9%.
 *
 * SECONDARY — reported, NEVER used to pass, and no arm is sized on it. Per rep: did it call
 * search or fetch at all (Stage 1: 0/15). This is a SECOND causal claim: more behaviour
 * questions need not produce escalation, because a behaviour question can still be answered
 * out of the package text. A secondary PASS must not rescue a primary FAIL.
 *
 * PREDICATE HONESTY, restated with every result this prints: of Stage 1's 29 "neither"
 * queries, two are arguably behavioural ("how route chaining works with hc", "how response
 * looks after $fetch"), so the true behaviour rate there is 3-5 of 127, not exactly 3. The
 * same predicate scores both arms, so the bias is common-mode.
 *
 * ── THE TWO ARMS ──────────────────────────────────────────────────────────────────────────
 *
 * One process, two privately patched dist copies, arms INTERLEAVED (baseline rep i, then
 * treatment rep i) over two fixtures. The llama-server's state drifts over hours; a block
 * design would land that drift entirely on one arm.
 *   treatment  the real shipped path.
 *   baseline   the same, with the contract block removed by ASSERTED string surgery. Verified
 *              three ways, because a surgery that silently matched nothing makes both arms
 *              identical and the A/B can then only report "no effect" — the most expensive
 *              failure mode, because it looks like a result:
 *                (i)   buildPatchedDist refuses an anchor that does not occur exactly once;
 *                (ii)  the LOADED module's assembled APIS prompt is checked at startup;
 *                (iii) the assembled prompt is re-checked IN EVERY REP from a dump patch.
 *                      "the arms differed at startup" is a different claim from "the arms
 *                      differed in every one of 40 child processes over three hours".
 *
 * ── INVARIANTS, AND WHY TWO OF THEM ARE STATISTICAL ───────────────────────────────────────
 *
 * `excerptVerified === false` churns on 43% of questions between IDENTICAL reps (measured,
 * 90/210). A strict `treatment <= baseline` on a counter that noisy fails by coin flip about
 * half the time at this arm size, which would make a real result unreportable and an unreal
 * one publishable. So the fabrication guard is a one-tailed Fisher test for a RISE, at the
 * same 0.05 threshold as the headline — pre-declared here, before the data exists. Raw counts
 * are printed alongside so the reader can apply their own rule.
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/live-apis-contract-ab.ts [REPS] [FIXTURE]
 * Re-score a completed run offline, no model time:
 *   AB_DIR=~/tmp/apis-contract-ab bun run scripts/live-apis-contract-ab.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {APIS_SEMANTICS_CONTRACT} from '../src/task/apis-contract.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {TYPEONLY_LOG_ENV, readTypeOnlyLog, type TypeOnlyLogRecord} from '../src/workers/typeonly-log.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'
import {buildPatchedDist, stubSearchExtension, type Surgery} from './spec-url-dist.js'
import {fisherOneTail} from './prompt1-combined-verdict.js'
import {
    FIXTURES,
    CALLS_LOG_ENV,
    assertFetchToolReachable,
    buildFixtureTree,
    writeStubExtension,
    fetchedUrls,
    searchQueries,
    toolResults,
    type SpecUrlFixture
} from './spec-url-fixtures.js'
import {
    channelsFor,
    extractSection,
    groundEntries,
    parseApisEntries,
    parseTrajectory,
    readTouchedFiles,
    type GroundingCorpus,
    type Step
} from './apis-trajectory.js'
import {countSemantics, isBehaviourPackageQuery, packageQueryKinds, semanticsSymbols} from './apis-semantics.js'
import {CONTRACT_MARKER, STRIP_CONTRACT, assertContractInPrompt} from './apis-contract-surgery.js'
import {requirePreconditions} from './ab-preflight.js'

const REPS = Number(process.argv[2] ?? '10')
const WHICH = process.argv[3] ?? 'all'
/** `||` not `??`, absolute: a set-but-empty env var is not nullish, and the sink path is read
 *  inside the pi child whose cwd is the trial tree. That pair once produced a complete,
 *  plausible report off ZERO recorded answers against 16 docs calls. */
const ROOT = path.resolve(process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'apis-contract-ab'))
const TRIAL_TIMEOUT_MS = 45 * 60_000
const PROMPT_DUMP_ENV = 'PI_TASK_PROMPT_DUMP'

/** THE VERDICT THRESHOLD, fixed before any data exists. */
const ALPHA = 0.05
/** Invariant 1's floor: a worker silenced into fewer entries is a regression, not a fix. */
const ENTRY_COLLAPSE_FLOOR = 0.8
/** Invariant 3's ceiling on added cost, same 2x PROMPT 4 used. */
const COST_CEILING = 2

/** Stage 1, commit 807ffad — printed in the banner so the comparison is on screen. */
const STAGE1 = {
    repsWithBehaviour: 2,
    reps: 15,
    behaviourPkgQueries: 3,
    pkgQueries: 61,
    entriesPerRep: 18.5,
    ungroundedSymbols: 2,
    symbols: 588,
    escalatedReps: 0
} as const

type Arm = 'baseline' | 'treatment'

interface RepResult {
    fixture: string
    arm: Arm
    rep: number
    /** PRIMARY. */
    behaviourHit: boolean
    /** SECONDARY, reported only. */
    escalated: boolean
    kinds: ReturnType<typeof packageQueryKinds>
    docsCalls: number
    toolCalls: number
    fetches: number
    searches: number
    docsAnswers: number
    /** excerptVerified === false, from the docs sink AND the fetch/search wrapper. */
    hallucWarn: number
    entries: number
    symbols: number
    ungroundedSymbols: number
    semantics: ReturnType<typeof countSemantics>
    /**
     * Grounding of the text the lever ADDS. The Stage-1 counter above scores entry NAMES only,
     * so without this the lever's own output field would sit outside the fabrication guard —
     * and fabrication in exactly that field is what killed run 15.
     */
    semanticsSymbols: number
    ungroundedSemanticsSymbols: number
    /** The emitted section verbatim, so every counter here is re-scorable offline. */
    apisSection: string
    /** Every package query with its class, so the committed classifier can be re-audited. */
    packageQueries: Array<{module: string; query: string}>
    /** Per-rep proof the surgery held: was the contract in THIS rep's assembled APIS prompt. */
    contractInPrompt: boolean
    /** The behaviour-class package queries themselves, so the metric is auditable by hand. */
    behaviourQueries: string[]
    minutes: number
    error?: string
}

interface PhasesModule {
    phaseResearch: typeof import('../dist/task/phases.js').phaseResearch
}

function corpusOf(trialDir: string, steps: Step[], answers: TypeOnlyLogRecord[], prompt: string): GroundingCorpus {
    const join = (rs: TypeOnlyLogRecord[]): string => rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt,
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: fs.existsSync(trialDir) ? readTouchedFiles(trialDir, steps) : ''
    }
}

async function runRep(mod: PhasesModule, fixture: SpecUrlFixture, arm: Arm, rep: number): Promise<RepResult> {
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
    const answers = readTypeOnlyLog(read(sink))
    const steps = parseTrajectory(read(logPath))
    const section = extractSection(research, 'APIS')
    const apisPrompt = read(dump).split('===== ').find(s => s.startsWith('worker:apis')) ?? ''
    const corpus = corpusOf(dir, steps, answers, apisPrompt)
    const grounded = groundEntries(parseApisEntries(section), corpus)
    const semSyms = semanticsSymbols(section)
    const results = toolResults(calls)
    const fetches = fetchedUrls(calls)
    const searches = searchQueries(calls)

    return {
        fixture: fixture.name,
        arm,
        rep,
        behaviourHit: answers.some(isBehaviourPackageQuery),
        escalated: fetches.length + searches.length > 0,
        kinds: packageQueryKinds(answers),
        docsCalls: steps.filter(s => s.tool === 'pi-worker-docs').length,
        toolCalls: steps.filter(s => s.arg.length > 0).length,
        fetches: fetches.length,
        searches: searches.length,
        docsAnswers: answers.length,
        hallucWarn:
            answers.filter(a => a.excerptVerified === false).length
            + results.filter(r => r.excerptVerified === false).length,
        entries: grounded.length,
        symbols: grounded.reduce((a, g) => a + g.entry.symbols.length, 0),
        ungroundedSymbols: grounded.reduce((a, g) => a + g.ungrounded.length, 0),
        semantics: countSemantics(section),
        semanticsSymbols: semSyms.length,
        ungroundedSemanticsSymbols: semSyms.filter(s => channelsFor(s, corpus).length === 0).length,
        apisSection: section,
        packageQueries: answers.filter(a => a.module !== '.').map(a => ({module: a.module, query: a.query})),
        contractInPrompt: apisPrompt.includes(CONTRACT_MARKER),
        behaviourQueries: answers.filter(isBehaviourPackageQuery).map(a => `[${a.module}] ${a.query.replace(/\s+/g, ' ')}`),
        minutes: (Date.now() - started) / 60000,
        ...(error ? {error} : {})
    }
}

/** Dump every assembled worker prompt — observation only, applied identically to BOTH arms. */
const PROMPT_DUMP: Surgery = {
    file: 'task/phases.js',
    // Anchored on the `basePrompt` binding — runSpec assembles worker:apis's prompt once there,
    // then reuses it for the zero-retrieval gate retry (was: the inline `prompt:` property,
    // removed when that retry was introduced).
    find: "        const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt;",
    replace:
        '        const basePrompt = (p => { try { const s = process.env['
        + JSON.stringify(PROMPT_DUMP_ENV)
        + "]; if (s) require('node:fs').appendFileSync(s, '\\n===== ' + spec.label"
        + " + ' =====\\n' + p) } catch {} return p })"
        + "(typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt);",
    label: 'dump every assembled worker prompt (observation only, both arms)'
}

async function runAll(): Promise<RepResult[]> {
    await requirePreconditions('live-apis-contract-ab', {model: {}, piBin: true, cacheOff: true})
    fs.mkdirSync(ROOT, {recursive: true})
    const stubSurgery = stubSearchExtension(writeStubExtension(ROOT))
    const treatmentDist = buildPatchedDist('apis-contract-treatment', [stubSurgery, PROMPT_DUMP])
    const baselineDist = buildPatchedDist('apis-contract-baseline', [stubSurgery, PROMPT_DUMP, STRIP_CONTRACT])

    // (ii) of the three surgery checks: against the LOADED module's assembled prompt.
    const treatPrompt = await assertContractInPrompt(treatmentDist, true)
    const basePrompt = await assertContractInPrompt(baselineDist, false)
    // (iv) the arms must differ by the block and by nothing else.
    if (treatPrompt.replace(APIS_SEMANTICS_CONTRACT, '').replace(/\n{3,}/g, '\n\n') !== basePrompt.replace(/\n{3,}/g, '\n\n')) {
        throw new Error(
            'ARMS DIFFER BY MORE THAN THE LEVER: removing the contract from the treatment prompt '
                + 'does not reproduce the baseline prompt. Whatever else differs would be '
                + 'confounded with the lever in every number this run prints.'
        )
    }

    // Prove a real child can reach the tool under test BEFORE spending hours on how often it
    // does. A failed extension load leaves NO error — both arms would read zero and it would
    // look like a clean null result about the model.
    await assertFetchToolReachable(ROOT, buildFixtureTree(ROOT, FIXTURES[0], 0), runWorker)

    const mods: Record<Arm, PhasesModule> = {
        baseline: (await import(path.join(baselineDist, 'task', 'phases.js'))) as PhasesModule,
        treatment: (await import(path.join(treatmentDist, 'task', 'phases.js'))) as PhasesModule
    }
    const fixtures = WHICH === 'all' ? FIXTURES : FIXTURES.filter(f => f.name === WHICH)
    if (fixtures.length === 0) {
        console.error(`unknown fixture "${WHICH}"; expected all | ${FIXTURES.map(f => f.name).join(' | ')}`)
        process.exit(1)
    }

    console.log(
        `live-apis-contract-ab — STAGE 2 STEP D\n`
            + `model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, real phaseResearch, offline web\n`
            + `fixtures ${fixtures.map(f => f.name).join(', ')}   ${REPS} reps per arm per fixture\n`
            + `PRIMARY: >= 1 behaviour-class PACKAGE docs query per rep. Baseline (Stage 1) `
            + `${STAGE1.repsWithBehaviour}/${STAGE1.reps} = 13.3%. Threshold: Fisher one-tailed p < ${ALPHA}.\n`
            + `SECONDARY (reported, cannot pass the run): any search/fetch call. Stage 1 ${STAGE1.escalatedReps}/${STAGE1.reps}.\n`
            + `surgery verified: treatment prompt ${treatPrompt.length}c WITH the contract, `
            + `baseline ${basePrompt.length}c WITHOUT, and the arms differ by the block alone.`
    )

    const rows: RepResult[] = []
    for (const f of fixtures) {
        for (let rep = 1; rep <= REPS; rep++) {
            for (const arm of ['baseline', 'treatment'] as const) {
                const r = await runRep(mods[arm], f, arm, rep)
                rows.push(r)
                console.log(
                    `  ${f.name} ${arm.padEnd(9)} rep ${rep}/${REPS}: docs=${r.docsCalls} `
                        + `pkgQ=${r.kinds.total} behaviourQ=${r.kinds.behaviour} `
                        + `${r.behaviourHit ? 'PRIMARY-HIT' : 'primary-miss'} `
                        + `esc=${r.escalated ? `yes(f${r.fetches}/s${r.searches})` : 'no'} `
                        + `entries=${r.entries} sem=${r.semantics.withSemantics}(${r.semantics.unverified}unv) `
                        + `ungr=${r.ungroundedSymbols}/${r.symbols} halluc=${r.hallucWarn} `
                        + `contract=${r.contractInPrompt ? 'in' : 'out'} [${r.minutes.toFixed(1)}m]`
                        + (r.error ? `  ERROR ${r.error}` : '')
                )
                // Persisted after EVERY rep so a crash at rep 39 does not throw away 38 reps.
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
    console.log(`live-apis-contract-ab — RE-SCORING ${saved} (no model time)`)
    return JSON.parse(fs.readFileSync(saved, 'utf8')) as RepResult[]
}

/** An invariant that could not be exercised is reported as held-not-tested, never as validated. */
interface StageInvariant extends Invariant {
    vacuous?: boolean
}

function main(rows: RepResult[]): void {
    const of = (arm: Arm, fixture?: string): RepResult[] =>
        rows.filter(r => r.arm === arm && (fixture === undefined || r.fixture === fixture))
    const hits = (rs: RepResult[]): number => rs.filter(r => r.behaviourHit).length
    const sum = (rs: RepResult[], f: (r: RepResult) => number): number => rs.reduce((a, r) => a + f(r), 0)
    const mean = (rs: RepResult[], f: (r: RepResult) => number): number =>
        rs.length === 0 ? 0 : sum(rs, f) / rs.length
    const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`)
    const B = of('baseline')
    const T = of('treatment')
    const fixtureNames = [...new Set(rows.map(r => r.fixture))]

    console.log(`\n=== PRIMARY — reps issuing >= 1 BEHAVIOUR-class PACKAGE docs query ===`)
    for (const f of fixtureNames) {
        const b = of('baseline', f)
        const t = of('treatment', f)
        console.log(
            `  ${f.padEnd(16)} baseline ${hits(b)}/${b.length}   treatment ${hits(t)}/${t.length}`
                + `   Fisher one-tailed p = ${fisherOneTail(hits(t), t.length - hits(t), hits(b), b.length - hits(b)).toFixed(4)}`
        )
    }
    const pooledP = fisherOneTail(hits(T), T.length - hits(T), hits(B), B.length - hits(B))
    console.log(
        `  ${'POOLED'.padEnd(16)} baseline ${hits(B)}/${B.length}   treatment ${hits(T)}/${T.length}`
            + `   Fisher one-tailed p = ${pooledP.toFixed(4)}`
    )
    console.log(
        `  package-query behaviour share  baseline ${sum(B, r => r.kinds.behaviour)}/${sum(B, r => r.kinds.total)}`
            + ` = ${pct(sum(B, r => r.kinds.behaviour), sum(B, r => r.kinds.total))}`
            + `   treatment ${sum(T, r => r.kinds.behaviour)}/${sum(T, r => r.kinds.total)}`
            + ` = ${pct(sum(T, r => r.kinds.behaviour), sum(T, r => r.kinds.total))}`
            + `   (Stage 1: ${STAGE1.behaviourPkgQueries}/${STAGE1.pkgQueries} = 4.9%)`
    )
    console.log(
        `  PREDICATE HONESTY: the committed classifyQuery is used unchanged. Of Stage 1's 29\n`
            + `  "neither" queries two are arguably behavioural, so its behaviour rate is 3-5 of 127,\n`
            + `  not exactly 3. The same predicate scores both arms, so the bias is common-mode.`
    )

    console.log(`\n=== SECONDARY — escalation. REPORTED ONLY; it cannot pass this run. ===`)
    console.log(
        `  reps calling search or fetch  baseline ${B.filter(r => r.escalated).length}/${B.length}`
            + `   treatment ${T.filter(r => r.escalated).length}/${T.length}   (Stage 1: 0/15)`
            + `   Fisher p = ${fisherOneTail(
                T.filter(r => r.escalated).length,
                T.length - T.filter(r => r.escalated).length,
                B.filter(r => r.escalated).length,
                B.length - B.filter(r => r.escalated).length
            ).toFixed(4)}`
    )
    console.log(
        `  a behaviour question can be answered out of the package text, so this is a SECOND\n`
            + `  causal claim with its own number — a secondary PASS never rescues a primary FAIL.`
    )

    console.log(`\n=== PER-ARM COUNTERS (per-rep means unless stated) ===`)
    const cols = ['docs', 'pkgQ', 'toolCalls', 'entries', 'sem', 'unv', 'ungr/sym', 'halluc', 'fetch', 'search', 'min']
    console.log(`  ${'arm'.padEnd(10)}${cols.map(c => c.padStart(10)).join('')}`)
    for (const [name, rs] of [
        ['baseline', B],
        ['treatment', T]
    ] as const) {
        console.log(
            `  ${name.padEnd(10)}`
                + [
                    mean(rs, r => r.docsCalls).toFixed(1),
                    mean(rs, r => r.kinds.total).toFixed(1),
                    mean(rs, r => r.toolCalls).toFixed(1),
                    mean(rs, r => r.entries).toFixed(1),
                    mean(rs, r => r.semantics.withSemantics).toFixed(1),
                    mean(rs, r => r.semantics.unverified).toFixed(1),
                    `${sum(rs, r => r.ungroundedSymbols)}/${sum(rs, r => r.symbols)}`,
                    String(sum(rs, r => r.hallucWarn)),
                    mean(rs, r => r.fetches).toFixed(1),
                    mean(rs, r => r.searches).toFixed(1),
                    mean(rs, r => r.minutes).toFixed(1)
                ]
                    .map(v => v.padStart(10))
                    .join('')
        )
    }
    console.log(`  Stage 1 for reference: entries/rep ${STAGE1.entriesPerRep}, ungrounded ${STAGE1.ungroundedSymbols}/${STAGE1.symbols} = 0.3%`)

    // The fabrication guard aimed at the field the lever ADDS. The Stage-1 grounding counter
    // scores entry NAMES only, and the semantics clause lives in the rest of the line — so
    // without this the lever's own output would sit outside the guard entirely.
    console.log(`\n=== FABRICATION CHECK ON THE SEMANTICS CLAUSE ITSELF ===`)
    for (const [name, rs] of [
        ['baseline', B],
        ['treatment', T]
    ] as const) {
        const sym = sum(rs, r => r.semanticsSymbols)
        const ungr = sum(rs, r => r.ungroundedSemanticsSymbols)
        console.log(
            `  ${name.padEnd(10)} semantics-clause symbols ${String(sym).padStart(5)}   ungrounded `
                + `${String(ungr).padStart(4)} = ${pct(ungr, sym)}`
                + (sym === 0 ? '   [the arm emits no such clause — held-not-tested, by construction]' : '')
        )
    }
    console.log(
        `  Same conservative rule as Stage 1: identifier-shaped tokens, no stop-list, union of\n`
            + `  every channel the worker was given or retrieved, so this rate is a FLOOR. The\n`
            + `  baseline cannot exercise it (it emits no semantics clauses), so it is a\n`
            + `  TREATMENT DIAGNOSTIC, reported with its number and NOT scored as an invariant.`
    )

    console.log(`\n=== EVERY BEHAVIOUR-CLASS PACKAGE QUERY, both arms (the metric, auditable by hand) ===`)
    for (const r of rows) {
        for (const q of r.behaviourQueries) {
            console.log(`  ${r.arm.padEnd(9)} ${r.fixture} r${r.rep}  ${q.slice(0, 120)}`)
        }
    }
    console.log(`\n  raw data: ${path.join(ROOT, 'ab.json')} + per-rep trial trees under ${ROOT}`)

    // ── invariants ───────────────────────────────────────────────────────────
    const baseHalluc = sum(B, r => r.hallucWarn)
    const treatHalluc = sum(T, r => r.hallucWarn)
    const baseAnswers = sum(B, r => r.docsAnswers)
    const treatAnswers = sum(T, r => r.docsAnswers)
    // One-tailed Fisher for a RISE. excerptVerified churns on 43% of questions between
    // IDENTICAL reps, so a strict treatment<=baseline would fail by coin flip at this n.
    const hallucRiseP = fisherOneTail(treatHalluc, treatAnswers - treatHalluc, baseHalluc, baseAnswers - baseHalluc)
    const baseUngr = sum(B, r => r.ungroundedSymbols)
    const treatUngr = sum(T, r => r.ungroundedSymbols)
    const ungrRiseP = fisherOneTail(treatUngr, sum(T, r => r.symbols) - treatUngr, baseUngr, sum(B, r => r.symbols) - baseUngr)
    const baseEntries = mean(B, r => r.entries)
    const treatEntries = mean(T, r => r.entries)
    const baseCost = sum(B, r => r.docsCalls + r.fetches + r.searches)
    const treatCost = sum(T, r => r.docsCalls + r.fetches + r.searches)

    const invariants: StageInvariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first rep answers)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            // Per rep, not once at startup: a run is 40 child processes over hours.
            label: 'surgery held in EVERY rep — contract present in treatment, absent in baseline',
            ok: T.every(r => r.contractInPrompt) && B.every(r => !r.contractInPrompt),
            detail: `treatment ${T.filter(r => r.contractInPrompt).length}/${T.length} in, baseline ${B.filter(r => !r.contractInPrompt).length}/${B.length} out`
        },
        {
            // Invariant 1. A worker silenced into fewer entries is a regression, not a fix.
            label: `invariant 1: APIS entry count did not collapse (>= ${ENTRY_COLLAPSE_FLOOR}x baseline)`,
            ok: baseEntries === 0 || treatEntries >= baseEntries * ENTRY_COLLAPSE_FLOOR,
            detail: `baseline ${baseEntries.toFixed(1)}/rep vs treatment ${treatEntries.toFixed(1)}/rep (Stage 1 ${STAGE1.entriesPerRep})`,
            vacuous: baseEntries === 0
        },
        {
            // Invariant 2a. THE FABRICATION GUARD, and the reason step 3 of the fallback exists.
            label: `invariant 2a: ungrounded-symbol rate did not RISE (one-tailed Fisher p >= ${ALPHA})`,
            ok: ungrRiseP >= ALPHA,
            detail: `baseline ${baseUngr}/${sum(B, r => r.symbols)} vs treatment ${treatUngr}/${sum(T, r => r.symbols)}, p(rise) = ${ungrRiseP.toFixed(4)}`,
            vacuous: baseUngr === 0 && treatUngr === 0
        },
        {
            // Invariant 2b, same guard on the other channel.
            label: `invariant 2b: excerptVerified===false did not RISE (one-tailed Fisher p >= ${ALPHA})`,
            ok: hallucRiseP >= ALPHA,
            detail: `baseline ${baseHalluc}/${baseAnswers} vs treatment ${treatHalluc}/${treatAnswers} answers, p(rise) = ${hallucRiseP.toFixed(4)}`,
            vacuous: baseHalluc === 0 && treatHalluc === 0
        },
        {
            // Invariant 3. Research was already 63.7% of run-15 spec-phase wall clock.
            label: `invariant 3: docs+search+fetch calls did not blow up (<= ${COST_CEILING}x baseline)`,
            ok: baseCost === 0 || treatCost <= baseCost * COST_CEILING,
            detail: `baseline ${baseCost} vs treatment ${treatCost} calls`,
            vacuous: baseCost === 0
        },
        {
            label: `invariant 3b: wall clock did not blow up (<= ${COST_CEILING}x baseline mean)`,
            ok: mean(B, r => r.minutes) === 0 || mean(T, r => r.minutes) <= mean(B, r => r.minutes) * COST_CEILING,
            detail: `baseline ${mean(B, r => r.minutes).toFixed(1)} vs treatment ${mean(T, r => r.minutes).toFixed(1)} min/rep`
        },
        {
            // Invariant 4 was asserted at startup by assertFetchToolReachable, which throws.
            label: 'invariant 4: positive control — a real child reached pi-worker-fetch at startup',
            ok: true,
            detail: 'assertFetchToolReachable passed (it throws otherwise, so this run existing is the evidence)'
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
        },
        {
            label: `PRIMARY: Fisher one-tailed p < ${ALPHA} (threshold fixed before the data)`,
            ok: pooledP < ALPHA,
            detail: `p = ${pooledP.toFixed(4)} on ${hits(T)}/${T.length} vs ${hits(B)}/${B.length}`
        }
    ]

    const broken = invariants.filter(i => !i.ok)
    const lines = [
        '',
        '=== VERDICT: live-apis-contract-ab (STAGE 2 STEP D) ===',
        '  target shape: a rep in which worker:apis asks a BEHAVIOUR question about an npm package',
        `  BASELINE  ${hits(B)}/${B.length}`,
        `  TREATMENT ${hits(T)}/${T.length}`,
        `  Fisher one-tailed p = ${pooledP.toFixed(4)}   (threshold ${ALPHA}, fixed before the run)`,
        ...invariants.map(
            i =>
                `  invariant ${i.ok ? (i.vacuous ? 'HELD-NOT-TESTED' : 'HOLDS ') : 'BROKEN'}  ${i.label}`
                + `${i.detail ? ` — ${i.detail}` : ''}`
                + (i.vacuous ? '  [VACUOUS: the shape never arose, so this was never exercised]' : '')
        )
    ]

    let outcome: Outcome
    if (T.length === 0 || B.length === 0) {
        outcome = 'ABSTAIN'
        lines.push('', '*** ABSTAIN — an arm has no reps. ***')
    } else if (sum(B, r => r.kinds.total) === 0 && sum(T, r => r.kinds.total) === 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — THIS RUN PROVED NOTHING ***',
            'NEITHER arm asked about an npm package at all, so the lever had no population to',
            'act on and the metric has an empty denominator. That is a fixture problem, not a',
            'fact about the lever. Do not read the zeros above as a result.'
        )
    } else if (broken.length > 0) {
        outcome = 'FAIL'
        lines.push(
            '',
            `FAIL — ${broken.length} invariant(s) broken: ${broken.map(i => i.label).join('; ')}`,
            '',
            'A FAIL IS AN ACHIEVED RESULT. Record it with these numbers and UNWIRE the lever',
            'from src/task/prompts.ts, exactly as PROMPT 4 did. Do not iterate on wording to',
            'manufacture a pass.'
        )
    } else {
        outcome = 'PASS'
        lines.push(
            '',
            `PASS — the contract moved behaviour-class package questions from ${hits(B)}/${B.length} to `
                + `${hits(T)}/${T.length} (Fisher p = ${pooledP.toFixed(4)}), with every invariant green.`,
            `SECONDARY, reported and not part of this verdict: escalation `
                + `${B.filter(r => r.escalated).length}/${B.length} -> ${T.filter(r => r.escalated).length}/${T.length}.`
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
