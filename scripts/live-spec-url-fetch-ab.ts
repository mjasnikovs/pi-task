/**
 * PROMPT 4 STEP 3 — the A/B. Does ranking the design's own cited URLs as fetch candidates
 * make worker:apis actually fetch them?
 *
 * ── THE METRIC, AND THE ERROR IT EXISTS TO AVOID ──────────────────────────────────────────
 *
 * WHICH URL WAS FETCHED. Recorded at the tool layer: the offline fetch stub appends the URL
 * it was asked for, BEFORE attempting the lookup, and a rep HITS iff one of those URLs
 * appears in the design document as it exists in that rep's own tree.
 *
 * It is NOT the termination rate. PROMPT 2's A/B scored ALL research terminations while its
 * lever touched 0.54% of answers, returned p = 0.88, and cost hours producing a number that
 * could not have come out any other way. A metric a lever cannot mechanically move is not a
 * weak experiment — it is not an experiment. This metric is the lever's effect by
 * construction: the lever's only action is to put specific URLs in front of the worker, and
 * the metric is which URLs it asked for.
 *
 * ── THE TWO ARMS ──────────────────────────────────────────────────────────────────────────
 *
 * Both run in ONE process against two privately patched copies of dist/ (scripts/
 * spec-url-dist.ts), so the counts are directly comparable and neither arm can be a
 * different build:
 *   treatment  the shipped path, network redirected to the offline fixture web.
 *   baseline   the same, plus ASSERTED string surgery that makes buildSpecUrlBlock return ''.
 *              The anchor must occur exactly once or the surgery throws; and the effect is
 *              VERIFIED AT RUNTIME by calling the loaded baseline module and asserting it
 *              returns empty for an input the treatment module answers non-empty. A
 *              replacement that silently matched nothing would make both arms identical and
 *              the A/B unreadable — the most expensive failure mode, because it looks like a
 *              result.
 *
 * The network stub is applied to BOTH arms identically, so it cannot bias the comparison.
 * Search is stubbed over a corpus that INCLUDES the cited pages (see spec-url-fixtures.ts):
 * the baseline can find them by searching, exactly as on the real web. The lever has to beat
 * search, not be handed a monopoly.
 *
 * ── ARMS ARE INTERLEAVED ──────────────────────────────────────────────────────────────────
 *
 * baseline rep i then treatment rep i, alternating, rather than one arm then the other. The
 * llama-server is a shared resource whose state (KV cache occupancy, thermal behaviour)
 * drifts over hours; a block design would let that drift land entirely on one arm.
 *
 * ── VERDICT ───────────────────────────────────────────────────────────────────────────────
 *
 * Fisher's exact, one-tailed, on the real 2x2 — not "baseline ~0 AND treatment most", which
 * is a threshold chosen after seeing the data. The arm size comes from STEP 2's MEASURED
 * baseline rate (scripts/live-spec-url-baseline.ts prints it), never from the file's
 * inherited ">= 8 reps".
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/live-spec-url-fetch-ab.ts [REPS] [FIXTURE]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {TYPEONLY_LOG_ENV, readTypeOnlyLog} from '../src/workers/typeonly-log.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {
    FIXTURES,
    CALLS_LOG_ENV,
    assertFetchToolReachable,
    buildFixtureTree,
    designUrlsOf,
    writeStubExtension,
    fetchedUrls,
    searchQueries,
    toolResults,
    citedFetches,
    type SpecUrlFixture
} from './spec-url-fixtures.js'
import {buildPatchedDist, stubSearchExtension, type Surgery} from './spec-url-dist.js'
import {fisherOneTail} from './prompt1-combined-verdict.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'

const REPS = Number(process.argv[2] ?? '10')
const WHICH = process.argv[3] ?? 'all'
const ROOT = path.join(os.homedir(), 'tmp', 'spec-url-fetch-ab')
const TRIAL_TIMEOUT_MS = 45 * 60_000

type Arm = 'baseline' | 'treatment'

/**
 * The surgery that removes the lever. The anchor is the guard clause at the top of
 * buildSpecUrlBlock, which tsc emits verbatim; src/task/spec-urls.ts carries a comment
 * naming this harness so the line is not "cleaned up" without updating the anchor.
 */
const STRIP_LEVER: Surgery = {
    file: 'task/spec-urls.js',
    find: "if (ranked.length === 0)\n        return '';",
    replace: "if (true)\n        return '';",
    label: 'buildSpecUrlBlock -> always empty (baseline arm only)'
}

interface RepResult {
    fixture: string
    arm: Arm
    rep: number
    fetched: string[]
    citedFetched: string[]
    nonCitedFetched: string[]
    searches: number
    docsCalls: number
    fetchCalls: number
    /** excerptVerified === false, from the docs sink and the fetch/search wrapper. */
    hallucWarn: number
    /**
     * Length of the spec-URL block phaseResearch actually assembled THIS rep, read back from
     * the `spec-urls: block N chars` line it logs. This is the per-rep proof that the string
     * surgery held: a module-level check runs once, but a run is dozens of child processes
     * over hours, and "the arms were different at startup" is not the same claim as "the arms
     * were different in every rep".
     */
    blockChars: number
    minutes: number
    error?: string
}

interface PhasesModule {
    phaseResearch: typeof import('../dist/task/phases.js').phaseResearch
}
interface SpecUrlsModule {
    buildSpecUrlBlock: (urls: string[], packages: string[]) => string
}

const normUrl = (u: string): string => u.replace(/\/+$/, '')

async function runRep(
    mod: PhasesModule,
    fixture: SpecUrlFixture,
    arm: Arm,
    rep: number
): Promise<RepResult> {
    const dir = buildFixtureTree(path.join(ROOT, arm), fixture, rep)
    const callsLog = path.join(dir, 'calls.log')
    const docsSink = path.join(dir, 'docs-answers.jsonl')
    process.env[CALLS_LOG_ENV] = callsLog
    process.env[TYPEONLY_LOG_ENV] = docsSink
    const logPath = path.join(dir, 'trial.log')
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    const started = Date.now()
    let error: string | undefined
    try {
        await mod.phaseResearch(
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

    const fetched = fetchedUrls(callsLog)
    const design = designUrlsOf(dir)
    const citedSet = new Set(design.map(normUrl))
    const cited = citedFetches(fetched, design)
    const trialLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
    const docsCalls = trialLog
        .split('\n')
        .filter(l => !l.startsWith('[debug] ') && /pi-worker-docs:/.test(l)).length
    const docsAnswers =
        fs.existsSync(docsSink) ? readTypeOnlyLog(fs.readFileSync(docsSink, 'utf8')) : []
    const results = toolResults(callsLog)
    const hallucWarn =
        docsAnswers.filter(a => a.excerptVerified === false).length
        + results.filter(r => r.excerptVerified === false).length
    const blockLine = /spec-urls: block (\d+) chars/.exec(trialLog)
    const blockChars = blockLine ? Number(blockLine[1]) : -1

    return {
        fixture: fixture.name,
        arm,
        rep,
        fetched,
        citedFetched: cited,
        nonCitedFetched: [...new Set(fetched.filter(f => !citedSet.has(normUrl(f))))],
        searches: searchQueries(callsLog).length,
        docsCalls,
        fetchCalls: fetched.length,
        hallucWarn,
        blockChars,
        minutes: (Date.now() - started) / 60000,
        ...(error ? {error} : {})
    }
}

/**
 * Prove the two loaded modules really differ, against the loaded code rather than the file
 * text. Without this the whole run can be two identical arms wearing different labels.
 */
async function verifySurgery(baselineDist: string, treatmentDist: string): Promise<string> {
    const b = (await import(path.join(baselineDist, 'task', 'spec-urls.js'))) as SpecUrlsModule
    const t = (await import(path.join(treatmentDist, 'task', 'spec-urls.js'))) as SpecUrlsModule
    const urls = ['https://hono.dev/docs/guides/rpc']
    const pkgs = ['hono', 'hono/client']
    const bOut = b.buildSpecUrlBlock(urls, pkgs)
    const tOut = t.buildSpecUrlBlock(urls, pkgs)
    if (bOut !== '') {
        throw new Error(
            `BASELINE SURGERY FAILED: buildSpecUrlBlock still returns ${bOut.length} chars. `
                + 'The baseline arm would carry the lever and the A/B would be meaningless.'
        )
    }
    if (tOut.trim().length === 0) {
        throw new Error(
            'TREATMENT ARM HAS NO LEVER: buildSpecUrlBlock returned empty for a cited URL whose '
                + 'package is named. There is nothing to measure.'
        )
    }
    return tOut
}

async function main(): Promise<void> {
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error('FATAL: llama-server @ 127.0.0.1:8080 not reachable.')
        process.exit(1)
    }
    fs.mkdirSync(ROOT, {recursive: true})
    const stub = writeStubExtension(ROOT)
    const stubSurgery = stubSearchExtension(stub)
    const treatmentDist = buildPatchedDist('spec-url-treatment', [stubSurgery])
    const baselineDist = buildPatchedDist('spec-url-baseline-arm', [stubSurgery, STRIP_LEVER])

    const sampleBlock = await verifySurgery(baselineDist, treatmentDist)
    // Before spending hours on how OFTEN the worker fetches, prove it CAN. STEP 2 measured 0
    // of 20 reps fetching anything; that reads identically whether the worker declined or the
    // tool was never registered, and an extension that fails to load leaves no error behind.
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
        `live-spec-url-fetch-ab — PROMPT 4 STEP 3\n`
            + `model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, real phaseResearch, offline web\n`
            + `fixtures ${fixtures.map(f => f.name).join(', ')}   ${REPS} reps per arm per fixture\n`
            + `surgery VERIFIED at runtime: baseline block '' / treatment block `
            + `${sampleBlock.length} chars\n`
            + `--- the treatment block, verbatim ---\n${sampleBlock}\n---`
    )

    const rows: RepResult[] = []
    for (const f of fixtures) {
        for (let rep = 1; rep <= REPS; rep++) {
            // Interleaved: the two arms see the same server state at the same point in time.
            for (const arm of ['baseline', 'treatment'] as const) {
                const r = await runRep(mods[arm], f, arm, rep)
                rows.push(r)
                console.log(
                    `  ${f.name} ${arm.padEnd(9)} rep ${rep}/${REPS}: docs=${r.docsCalls} `
                        + `search=${r.searches} fetch=${r.fetchCalls} `
                        + `spec-cited=${r.citedFetched.length} halluc=${r.hallucWarn} `
                        + `block=${r.blockChars}c`
                        + `${r.citedFetched.length > 0 ? `  HIT ${r.citedFetched.join(' ')}` : ''}`
                        + `  [${r.minutes.toFixed(1)}m]${r.error ? ` ERROR ${r.error}` : ''}`
                )
                fs.writeFileSync(path.join(ROOT, 'ab.json'), JSON.stringify(rows, null, 1), 'utf8')
            }
        }
    }

    // ── results ──────────────────────────────────────────────────────────────
    const of = (arm: Arm, fixture?: string): RepResult[] =>
        rows.filter(r => r.arm === arm && (fixture === undefined || r.fixture === fixture))
    const hits = (rs: RepResult[]): number => rs.filter(r => r.citedFetched.length > 0).length
    const mean = (rs: RepResult[], f: (r: RepResult) => number): number =>
        rs.length === 0 ? 0 : rs.reduce((a, r) => a + f(r), 0) / rs.length

    console.log(`\n=== HITS — reps that fetched a SPEC-CITED URL ===`)
    for (const f of fixtures) {
        const b = of('baseline', f.name)
        const t = of('treatment', f.name)
        console.log(
            `  ${f.name.padEnd(16)} baseline ${hits(b)}/${b.length}   treatment ${hits(t)}/${t.length}`
                + `   Fisher one-tailed p = ${fisherOneTail(
                    hits(t),
                    t.length - hits(t),
                    hits(b),
                    b.length - hits(b)
                ).toFixed(4)}`
        )
    }
    const B = of('baseline')
    const T = of('treatment')
    const pooledP = fisherOneTail(hits(T), T.length - hits(T), hits(B), B.length - hits(B))
    console.log(
        `  ${'POOLED'.padEnd(16)} baseline ${hits(B)}/${B.length}   treatment ${hits(T)}/${T.length}`
            + `   Fisher one-tailed p = ${pooledP.toFixed(4)}`
    )

    console.log(`\n=== INVARIANT COUNTERS (per rep means) ===`)
    console.log(
        `  ${'arm'.padEnd(10)} ${'docs'.padStart(6)} ${'search'.padStart(7)} ${'fetch'.padStart(6)}`
            + ` ${'halluc'.padStart(7)} ${'minutes'.padStart(8)} ${'non-cited fetches'.padStart(18)}`
    )
    for (const [name, rs] of [
        ['baseline', B],
        ['treatment', T]
    ] as const) {
        console.log(
            `  ${name.padEnd(10)} ${mean(rs, r => r.docsCalls)
                .toFixed(1)
                .padStart(6)}`
                + ` ${mean(rs, r => r.searches)
                    .toFixed(1)
                    .padStart(7)}`
                + ` ${mean(rs, r => r.fetchCalls)
                    .toFixed(1)
                    .padStart(6)}`
                + ` ${mean(rs, r => r.hallucWarn)
                    .toFixed(1)
                    .padStart(7)}`
                + ` ${mean(rs, r => r.minutes)
                    .toFixed(1)
                    .padStart(8)}`
                + ` ${rs.filter(r => r.nonCitedFetched.length > 0).length}/${rs.length}`.padStart(
                    19
                )
        )
    }

    const urlCounts = new Map<string, {b: number; t: number}>()
    for (const r of rows) {
        for (const u of new Set(r.fetched)) {
            const e = urlCounts.get(u) ?? {b: 0, t: 0}
            if (r.arm === 'baseline') e.b++
            else e.t++
            urlCounts.set(u, e)
        }
    }
    console.log(`\n=== EVERY URL FETCHED (reps that asked for it, baseline / treatment) ===`)
    const citedAll = new Set(rows.flatMap(r => r.citedFetched).map(normUrl))
    for (const [u, c] of [...urlCounts].sort((a, b) => b[1].t + b[1].b - (a[1].t + a[1].b))) {
        console.log(
            `  ${String(c.b).padStart(3)} / ${String(c.t).padStart(3)}  `
                + `${citedAll.has(normUrl(u)) ? 'CITED    ' : 'not cited'}  ${u}`
        )
    }
    console.log(`\n  raw data: ${path.join(ROOT, 'ab.json')}`)

    const baseHalluc = B.reduce((a, r) => a + r.hallucWarn, 0)
    const treatHalluc = T.reduce((a, r) => a + r.hallucWarn, 0)
    const baseCalls = B.reduce((a, r) => a + r.fetchCalls + r.searches, 0)
    const treatCalls = T.reduce((a, r) => a + r.fetchCalls + r.searches, 0)

    const invariants: Invariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            // PROMPT 4 invariant 1. Research was already 63.7% of run 15's spec-phase wall
            // clock (8777s of 13783s); a lever that doubles the fetch/search load is not free
            // even if it works.
            label: 'invariant 1: fetch+search calls per rep did not blow up (<= 2x baseline)',
            ok: baseCalls === 0 || treatCalls <= baseCalls * 2,
            detail: `baseline ${baseCalls} vs treatment ${treatCalls} calls total`
        },
        {
            // PROMPT 4 invariant 2. Buying answers with fabrication is the failure this whole
            // file is about, so a rise is a FAIL even if the headline metric moved.
            label: 'invariant 2: excerptVerified === false did NOT rise',
            ok: treatHalluc <= baseHalluc,
            detail: `baseline ${baseHalluc} vs treatment ${treatHalluc} warnings`
        },
        {
            // PROMPT 4 invariant 3. Ranking spec URLs above model-chosen ones must not become
            // "only spec URLs" — a worker that can no longer follow a question off the design's
            // reference list has been narrowed, not improved.
            label: 'invariant 3: treatment still fetches NON-cited URLs when the question needs them',
            ok:
                B.filter(r => r.nonCitedFetched.length > 0).length === 0
                || T.filter(r => r.nonCitedFetched.length > 0).length > 0,
            detail:
                `baseline ${B.filter(r => r.nonCitedFetched.length > 0).length}/${B.length} reps, `
                + `treatment ${T.filter(r => r.nonCitedFetched.length > 0).length}/${T.length} reps`
        },
        {
            label: 'Fisher one-tailed p < 0.05 (a do-nothing lever passes at most 5% of the time)',
            ok: pooledP < 0.05,
            detail: `p = ${pooledP.toFixed(4)} on ${hits(T)}/${T.length} vs ${hits(B)}/${B.length}`
        },
        {
            // Per-rep, not once at startup: every baseline rep must have assembled an EMPTY
            // block and every treatment rep a non-empty one. -1 means the log line was absent
            // entirely, which would mean the arm never reached the wiring at all.
            label: 'surgery held in EVERY rep: baseline block 0 chars, treatment block > 0',
            ok: B.every(r => r.blockChars === 0) && T.every(r => r.blockChars > 0),
            detail:
                `baseline ${B.filter(r => r.blockChars === 0).length}/${B.length} at 0 chars, `
                + `treatment ${T.filter(r => r.blockChars > 0).length}/${T.length} non-empty`
        },
        {
            label: 'both fixtures exercised (a PASS on one library is a single-case fit)',
            ok: fixtures.length >= 2,
            detail: fixtures.map(f => f.name).join(', ')
        },
        {
            label: 'no rep errored out',
            ok: rows.every(r => !r.error),
            detail: `${rows.filter(r => r.error).length} errored`
        }
    ]

    // ── verdict ──────────────────────────────────────────────────────────────
    // judge() is written for a lever that REMOVES a bad shape from the baseline; this lever
    // ADDS a good one to the treatment. Feeding the arms to it inverted would produce the
    // right exit code under labels that say the opposite of what happened, which is the exact
    // class of thing ab-verdict.ts exists to prevent. So the outcome is decided here and
    // handed to the shared report(), keeping one sanctioned exit path: PASS 0, FAIL 1,
    // ABSTAIN 2.
    const broken = invariants.filter(i => !i.ok)
    const lines = [
        '',
        '=== VERDICT: live-spec-url-fetch-ab ===',
        '  target shape: a rep in which worker:apis hands pi-worker-fetch a URL the design cites',
        `  BASELINE  fetched a cited URL: ${hits(B)}/${B.length}`,
        `  TREATMENT fetched a cited URL: ${hits(T)}/${T.length}`,
        `  Fisher one-tailed p = ${pooledP.toFixed(4)}`,
        ...invariants.map(
            i =>
                `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`
        )
    ]

    let outcome: Outcome
    if (hits(T) === 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — THIS RUN PROVED NOTHING ***',
            'The TREATMENT arm never fetched a cited URL, so the lever never reached the',
            'worker at all. A zero in the baseline column here is the absence of the shape,',
            'not evidence about the lever. Check that the block is actually reaching the',
            'APIS prompt before reading anything else in this run.'
        )
    } else if (hits(B) === B.length && B.length > 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — THE BASELINE IS SATURATED ***',
            'The shipped worker already fetches a cited URL in every rep. PROMPT 4 fact (b)',
            'no longer holds against this fixture and the prompt is void as written: stop and',
            're-derive rather than crediting a lever with behaviour that was already there.'
        )
    } else if (broken.length > 0) {
        outcome = 'FAIL'
        lines.push('', `FAIL — invariant(s) broken: ${broken.map(i => i.label).join('; ')}`)
    } else {
        outcome = 'PASS'
        lines.push(
            '',
            `PASS — the lever moved cited-URL fetching from ${hits(B)}/${B.length} to `
                + `${hits(T)}/${T.length} (Fisher p = ${pooledP.toFixed(4)}), with every `
                + 'invariant green.'
        )
    }
    report({outcome, lines})
}

if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
    console.error(
        'REFUSING TO RUN: PI_BIN is unset. An unset PI_BIN makes the child re-invoke this '
            + 'harness instead of pi — a fork bomb that has crashed this machine twice.'
    )
    process.exit(1)
}
if (process.env[RESEARCH_RUN_ID_ENV]) {
    console.error(`REFUSING TO RUN: ${RESEARCH_RUN_ID_ENV} is set — reps would replay.`)
    process.exit(1)
}
main().catch(e => {
    console.error(e)
    process.exit(1)
})
