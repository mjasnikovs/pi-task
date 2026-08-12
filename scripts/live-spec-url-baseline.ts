/**
 * PROMPT 4 STEP 2 — how often does the SHIPPED worker:apis fetch a spec-cited URL at all?
 *
 * THIS RUNS BEFORE THE LEVER EXISTS, and that ordering is the point. nexxtasks records
 * PROMPT 3 as "implementation was started before the baseline existed — the exact inversion
 * STEP 0 exists to prevent", and PROMPT 1's entry shows why a guessed rate is worse than
 * none: ">= 8 reps with baseline >= 1 hit and treatment 0" passes a DO-NOTHING lever about
 * one run in ten at a 25% baseline. The arm size for STEP 3 has to come out of this number,
 * so this number has to be measured first, on code that contains no lever to strip.
 *
 * THE ONE FIGURE THAT EXISTED — 1 of 17 reps (~6%) fetched hono.dev/docs/guides/rpc — is an
 * estimate from a probe built for another question, and PROMPT 4 says to re-measure it, not
 * inherit it. Its Wilson 95% interval at 1/17 runs roughly 1%–27%, which spans arm sizes from
 * 10 to 300. That spread is the whole reason this harness exists.
 *
 * SEAM — the real phaseResearch on the real pre-task tree, NOTHING about the worker stubbed.
 * Only the NETWORK is replaced, through the injection hooks pi-worker-fetch and
 * pi-worker-search already expose, by redirecting the extension path with asserted string
 * surgery over a private dist copy (scripts/spec-url-dist.ts). The same surgery is what the
 * A/B applies to BOTH its arms, so this baseline and that A/B measure the same world.
 *
 * METRIC — mechanical, tool layer, never model self-report: the stub appends the URL it was
 * asked for to a per-rep log BEFORE attempting the lookup, and a rep HITS iff any of those
 * URLs appears in the design document as it exists in that rep's own tree. It is NOT
 * "did the worker terminate" — the metric PROMPT 2's A/B got wrong, at a cost of hours.
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/live-spec-url-baseline.ts [REPS] [FIXTURE]
 * FIXTURE is a fixture name (task27-hono | task28-wouter) or `all`, the default.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {
    FIXTURES,
    CALLS_LOG_ENV,
    buildFixtureTree,
    designUrlsOf,
    writeStubExtension,
    fetchedUrls,
    searchQueries,
    citedFetches,
    type SpecUrlFixture
} from './spec-url-fixtures.js'
import {buildPatchedDist, stubSearchExtension, REPO} from './spec-url-dist.js'
import {fisherOneTail} from './prompt1-combined-verdict.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'

const REPS = Number(process.argv[2] ?? '10')
const WHICH = process.argv[3] ?? 'all'
const ROOT = path.join(os.homedir(), 'tmp', 'spec-url-baseline')
const TRIAL_TIMEOUT_MS = 45 * 60_000

export interface RepResult {
    fixture: string
    rep: number
    fetched: string[]
    citedFetched: string[]
    searches: number
    docsCalls: number
    minutes: number
    error?: string
}

/**
 * The scoring set per fixture, read out of the trial tree the first time one is built. Kept
 * here rather than re-derived at print time so nothing rebuilds a 222-file tree just to
 * label a table, and so the set that scored the reps is the set that gets printed.
 */
const designByFixture = new Map<string, Set<string>>()
const normUrl = (u: string): string => u.replace(/\/+$/, '')

/** Wilson 95% — a rate quoted without one is how ">= 8 reps" got treated as sufficient. */
/** Re-exported from `ab-stats.ts`, the one tested home for this. */
export {wilson} from './ab-stats.js'
import {wilson} from './ab-stats.js'
import {requirePreconditions} from './ab-preflight.js'


/**
 * Reps per arm so a DO-NOTHING treatment scores zero by chance with probability <= `alpha`.
 * With baseline rate p, a lever that changes nothing still yields 0 hits in n reps with
 * probability (1-p)^n; solve (1-p)^n <= alpha. This is exactly the arithmetic PROMPT 1's
 * entry works through, generalised so nobody has to redo it by eye.
 */
export function repsForFalsePass(p: number, alpha = 0.05): number {
    if (p <= 0) return Infinity
    if (p >= 1) return 1
    return Math.ceil(Math.log(alpha) / Math.log(1 - p))
}

/**
 * Smallest reps-per-arm at which the EXPECTED 2x2 (baseline at rate `p0`, treatment at `p1`)
 * reaches Fisher one-tailed p < `alpha`. Best case by construction: it assumes each arm lands
 * exactly on its rate, so it is a floor on the arm size, never a sufficient one.
 */
export function repsForPower(p0: number, p1: number, alpha = 0.05, max = 60): number {
    for (let n = 3; n <= max; n++) {
        const b = Math.round(p0 * n)
        const t = Math.round(p1 * n)
        if (fisherOneTail(t, n - t, b, n - b) < alpha) return n
    }
    return Infinity
}

/**
 * `all` is the ACCUMULATOR across fixtures, not a per-fixture array, and the checkpoint below
 * writes all of it. An earlier version wrote only the current fixture's slice, so finishing
 * fixture 2 silently overwrote fixture 1's rows: the in-process summary was right (0/20) and
 * the raw data on disk claimed 10. Raw data that disagrees with the summary is worse than no
 * raw data, because the summary is the part nobody re-checks.
 */
async function runFixture(
    phaseResearch: typeof import('../dist/task/phases.js').phaseResearch,
    fixture: SpecUrlFixture,
    reps: number,
    all: RepResult[]
): Promise<void> {
    for (let t = 1; t <= reps; t++) {
        const dir = buildFixtureTree(ROOT, fixture, t)
        const callsLog = path.join(dir, 'calls.log')
        process.env[CALLS_LOG_ENV] = callsLog
        const logPath = path.join(dir, 'trial.log')
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
        const started = Date.now()
        let error: string | undefined
        try {
            await phaseResearch(
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
        if (!designByFixture.has(fixture.name)) {
            designByFixture.set(fixture.name, new Set(design.map(normUrl)))
        }
        const cited = citedFetches(fetched, design)
        const trialLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
        const docsCalls = trialLog
            .split('\n')
            .filter(l => !l.startsWith('[debug] ') && /pi-worker-docs:/.test(l)).length
        const r: RepResult = {
            fixture: fixture.name,
            rep: t,
            fetched,
            citedFetched: cited,
            searches: searchQueries(callsLog).length,
            docsCalls,
            minutes: (Date.now() - started) / 60000,
            ...(error ? {error} : {})
        }
        all.push(r)
        console.log(
            `  ${fixture.name} rep ${t}/${reps}: docs=${docsCalls} search=${r.searches} `
                + `fetch=${fetched.length} spec-cited=${cited.length}`
                + `  ${cited.length > 0 ? `HIT ${cited.join(' ')}` : ''}`
                + `  [${r.minutes.toFixed(1)}m]${error ? ` ERROR ${error}` : ''}`
        )
        fs.writeFileSync(path.join(ROOT, 'baseline.json'), JSON.stringify(all, null, 1), 'utf8')
    }
}

async function main(): Promise<void> {
    await requirePreconditions('live-spec-url-baseline', {model: {}, piBin: true, cacheOff: true})
    // THE ORDERING GUARD, mechanical rather than remembered. "Measure the baseline first" is
    // the rule PROMPT 3 broke by starting its implementation before its baseline existed, and
    // the way it would be broken here is trivial: build once with the lever in dist/ and this
    // harness silently measures the treatment while calling it a baseline. So refuse to run
    // if the lever module is present in the build at all.
    const leverInDist = path.join(REPO, 'dist', 'task', 'spec-urls.js')
    if (fs.existsSync(leverInDist)) {
        console.error(
            `REFUSING TO RUN: ${leverInDist} exists, so dist/ already contains the PROMPT 4 lever.\n`
                + 'This harness measures the rate BEFORE the lever exists — that ordering is the\n'
                + 'entire point of STEP 2. Check out a pre-lever tree (or `git stash` the change),\n'
                + 'rebuild, and re-run; then implement.'
        )
        process.exit(1)
    }

    fs.mkdirSync(ROOT, {recursive: true})
    const stub = writeStubExtension(ROOT)
    const distRoot = buildPatchedDist('spec-url-baseline', [stubSearchExtension(stub)])
    const {phaseResearch} = (await import(
        path.join(distRoot, 'task', 'phases.js')
    )) as typeof import('../dist/task/phases.js')

    const fixtures = WHICH === 'all' ? FIXTURES : FIXTURES.filter(f => f.name === WHICH)
    if (fixtures.length === 0) {
        console.error(
            `unknown fixture "${WHICH}"; expected all | ${FIXTURES.map(f => f.name).join(' | ')}`
        )
        process.exit(1)
    }

    console.log(
        `live-spec-url-baseline — PROMPT 4 STEP 2, model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
            + `SHIPPED phaseResearch, no lever exists yet; network replaced by the offline fixture web\n`
            + `fixtures: ${fixtures.map(f => f.name).join(', ')}   ${REPS} reps each\n`
            + `patched dist: ${distRoot}`
    )

    const all: RepResult[] = []
    for (const f of fixtures) await runFixture(phaseResearch, f, REPS, all)
    summarise(
        all,
        fixtures.map(f => f.name)
    )
}

/**
 * Everything after the model time. Split out so a completed run can be RE-SCORED from
 * baseline.json without spending another 90 minutes — the same reason the diagnostic and the
 * type-only base rate retain their raw rows. An arm-size table that has to be recomputed by
 * hand is one that gets recomputed wrong.
 */
function summarise(all: RepResult[], fixtureNames: string[]): void {
    // ── the rate ─────────────────────────────────────────────────────────────
    console.log(`\n=== BASELINE RATE — reps that fetched a SPEC-CITED URL ===`)
    for (const name of fixtureNames) {
        const rows = all.filter(r => r.fixture === name)
        const hits = rows.filter(r => r.citedFetched.length > 0).length
        const [lo, hi] = wilson(hits, rows.length)
        console.log(
            `  ${name.padEnd(16)} ${hits}/${rows.length}`
                + `   Wilson 95% [${(100 * lo).toFixed(1)}%, ${(100 * hi).toFixed(1)}%]`
        )
    }
    const hits = all.filter(r => r.citedFetched.length > 0).length
    const [lo, hi] = wilson(hits, all.length)
    console.log(
        `  ${'POOLED'.padEnd(16)} ${hits}/${all.length}`
            + `   Wilson 95% [${(100 * lo).toFixed(1)}%, ${(100 * hi).toFixed(1)}%]`
    )
    console.log(`  the single prior figure, to be replaced by the above: 1/17 reps (~6%)`)

    // Any fetching at all is the precondition: a worker that never fetches cannot be moved
    // from "fetched the wrong page" to "fetched the cited page", and the lever would be
    // aimed at the wrong seam entirely.
    const anyFetch = all.filter(r => r.fetched.length > 0).length
    const anySearch = all.filter(r => r.searches > 0).length
    console.log(
        `\n  reps that fetched ANY url: ${anyFetch}/${all.length}   `
            + `reps that searched: ${anySearch}/${all.length}   `
            + `total fetches ${all.reduce((a, r) => a + r.fetched.length, 0)}`
    )
    const urlCounts = new Map<string, number>()
    for (const r of all) for (const u of r.fetched) urlCounts.set(u, (urlCounts.get(u) ?? 0) + 1)
    console.log(`\n  every URL fetched across all reps (cited pages marked):`)
    const designAll = new Set([...designByFixture.values()].flatMap(s => [...s]))
    for (const [u, n] of [...urlCounts].sort((a, b) => b[1] - a[1])) {
        console.log(
            `    ${String(n).padStart(3)}x  ${designAll.has(normUrl(u)) ? 'CITED    ' : 'not cited'}  ${u}`
        )
    }

    // ── ARM SIZING, computed rather than chosen ──────────────────────────────
    //
    // THE DIRECTION MATTERS AND IS EASY TO GET BACKWARDS. PROMPT 1's lever REMOVED a bad
    // shape, so its false-pass risk was "treatment scores 0 by chance", which grows as the
    // baseline rate FALLS — hence its 8 -> 11 -> 17 reps table. THIS lever ADDS a good shape,
    // so a low baseline makes a false pass HARDER, not easier, and the binding question is
    // POWER: how many reps before a real effect can reach significance at all.
    //
    // So the table below is the smallest n per arm at which Fisher's exact, one-tailed,
    // reaches p < 0.05 given the MEASURED baseline p0 and an assumed treatment rate p1. No
    // single p1 is assumed — several are tabulated, and the run is sized for the least
    // optimistic one worth acting on.
    const p = all.length > 0 ? hits / all.length : 0
    console.log(`\n=== ARM SIZE FOR STEP 3 ===`)
    console.log(
        `  measured baseline p0 = ${(100 * p).toFixed(1)}% (${hits}/${all.length}), `
            + `Wilson 95% [${(100 * lo).toFixed(1)}%, ${(100 * hi).toFixed(1)}%]`
    )
    console.log(`  smallest reps/arm reaching Fisher one-tailed p < 0.05, by treatment rate:`)
    for (const p1 of [0.4, 0.5, 0.6, 0.8, 1.0]) {
        const n = repsForPower(p, p1)
        console.log(
            `    treatment ${(100 * p1).toFixed(0).padStart(3)}%  ->  `
                + (Number.isFinite(n) ? `${n} reps/arm` : '> 60 reps/arm — infeasible here')
        )
    }
    console.log(
        `  These are BEST-CASE n: they assume the arms land exactly on p0 and p1. Model\n`
            + `  variance will not oblige, so run comfortably above the row you are sizing for.\n`
            + `  Note the sizing is conservative in the SAFE direction here — a lower baseline\n`
            + `  makes a spurious PASS harder, not easier, which is the opposite of PROMPT 1's\n`
            + `  situation and the reason its 8/11/17 table must not be copied across.`
    )
    console.log(`\n  raw data: ${path.join(ROOT, 'baseline.json')}`)

    // ── verdict ──────────────────────────────────────────────────────────────
    // A BASELINE CENSUS IS NOT A LEVER TEST, and reportArm's ABSTAIN rule does not fit it.
    // That rule exists so "the baseline never produced the shape" can never read as a pass —
    // right for an A/B arm, wrong here, where ZERO IS THE RESULT. PROMPT 4 fact (b) predicts
    // a near-zero rate; measuring it and being told the run "proved nothing" would invert the
    // meaning of the one number this harness exists to produce. So the outcome is decided
    // here and handed to the shared report(), keeping the one sanctioned exit path.
    //
    // ABSTAIN is reserved for a MEASUREMENT failure: too few reps, or reps that threw.
    const REPS_FLOOR = 8 * fixtureNames.length
    const errored = all.filter(r => r.error).length
    const invariants: Invariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            label: 'reps >= 8 per fixture — the floor for a model-variable seam',
            ok: all.length >= REPS_FLOOR,
            detail: `${all.length} reps across ${fixtureNames.length} fixture(s)`
        },
        {
            label: 'no rep errored out',
            ok: errored === 0,
            detail: `${errored} errored`
        }
    ]
    const lines = [
        '',
        '=== VERDICT: live-spec-url-baseline [STEP 2 baseline census, no lever] ===',
        `  measured: ${hits}/${all.length} reps fetched a spec-cited URL`,
        `  context : ${anyFetch}/${all.length} reps fetched ANY url, `
            + `${anySearch}/${all.length} searched`,
        ...invariants.map(
            i =>
                `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}`
                + (i.detail ? ` — ${i.detail}` : '')
        )
    ]
    const broken = invariants.filter(i => !i.ok)
    let outcome: Outcome
    if (broken.length > 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — THE MEASUREMENT DID NOT COMPLETE ***',
            `Not the rate being low — that would be a result. These are broken: `
                + broken.map(i => i.label).join('; '),
            'Re-run to the floor before quoting any number above as a baseline.'
        )
    } else {
        outcome = 'PASS'
        lines.push(
            '',
            `PASS — baseline rate measured at ${hits}/${all.length}.`,
            hits === 0 ?
                '  ZERO IS THE RESULT, not a missing one: PROMPT 4 fact (b) reproduced live.'
                    + '  Size STEP 3 for POWER from the table above; a zero baseline makes a'
                    + '  spurious PASS harder, so no false-pass inflation is needed.'
            :   '  Size STEP 3 from this rate, not from the inherited ">= 8 reps".'
        )
    }
    report({outcome, lines})
}

/** Re-score a completed run from baseline.json — no model time, no guards needed. */
function rescore(dir: string): void {
    const saved = path.join(dir, 'baseline.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: BASELINE_DIR set but ${saved} does not exist.`)
        process.exit(1)
    }
    const all = JSON.parse(fs.readFileSync(saved, 'utf8')) as RepResult[]
    console.log(`live-spec-url-baseline — RE-SCORING ${saved} (no model time)`)
    // The design URL set is a property of the fixture tree, which re-scoring does not rebuild.
    // Only the "CITED / not cited" labels in the per-URL table need it, and citedFetched was
    // already computed per rep at run time, so every RATE below is unaffected.
    for (const f of FIXTURES) {
        designByFixture.set(f.name, new Set(all.flatMap(r => r.citedFetched).map(normUrl)))
    }
    summarise(all, [...new Set(all.map(r => r.fixture))])
}

if (process.env.BASELINE_DIR) {
    rescore(process.env.BASELINE_DIR)
} else {
    main().catch(e => {
        console.error(e)
        process.exit(1)
    })
}
