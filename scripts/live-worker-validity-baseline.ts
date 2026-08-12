/**
 * STEP 0 item 1 — the LIVE regression base for research-worker answer validity.
 *
 * WHY THIS EXISTS. The mx5 run-15 report carries a table (pi-worker-docs 58.6% valid,
 * 33.3% strict) computed by STATIC forensics over one run's research-cache.json. A
 * one-run number cannot separate a real defect from model variance, and it cannot show
 * that a later change helped. This harness replays that run's own questions against the
 * real local model so PROMPT 1–3 have a recorded number to beat instead of an assertion.
 *
 * SEAM. The pi-worker-docs TOOL, entered through `makeWorkerTool`'s `execute` — the same
 * entry point the research worker child calls. Not `docsFocused`: the tool layer is where
 * the version banner, the hallucination warning and the details record are assembled, and
 * those three ARE the metric. Everything below them (resolve, index, retrieve, the child
 * summariser) is the real shipped path against the real installed tree.
 *
 * THE CACHE IS OFF, MECHANICALLY. `makeWorkerTool` consults the research cache only when
 * `PI_TASK_RUN_ID` is set (shared.ts:98–105). With it unset the tool neither reads nor
 * writes, so every rep is a fresh live lookup. The harness ASSERTS this rather than
 * assuming it — a replay served from cache would report perfect stability and mean
 * nothing, which is exactly the failure ab-verdict.ts was written about.
 *
 * METRIC — mechanical, recorded at the tool layer, never the model's self-report. The
 * three counters are scored off the returned text/details with the same predicates the
 * static pass used:
 *   unclear     text matches /unclear from this package/i
 *   halluc-warn details.excerptVerified === false  (child-output.ts:44 emits the warning)
 *   caveated    text carries the "[VERSION — verify]" banner (docs-core.ts:197)
 *   valid       neither unclear nor halluc-warn;  strict = valid and not caveated
 *
 * FIXTURE. scripts/fixtures/run15-docs-corpus.json — the 210 package questions the run
 * actually asked, extracted by scripts/fixtures/build-run15-fixtures.ts. Read its header
 * before quoting them as "verbatim": the cache key is lowercased, so these are the
 * questions semantically but not byte-for-byte.
 *
 * ENVIRONMENT (record it when quoting any number this prints)
 *   model    Qwen3.6-27B-NVFP4-MTP.gguf via llama-server @ 127.0.0.1:8080
 *   launcher ~/hub/qwen/run-Q3.6-27B.sh — that script, never a hand-rolled invocation:
 *            a sub-default batch (-b 512 -ub 256) corrupts large parallel tool calls,
 *            bisected over 930 live reps.
 *   tree     a fixture cwd carrying mx5's package.json with its node_modules symlinked
 *            read-only. This is load-bearing, not convenience: the "[VERSION — verify]"
 *            banner fires when a package is ABSENT from package.json, which is why all 61
 *            `bun` answers are caveated (mx5 declares @types/bun, never bun/bun-types).
 *            Replay against a different manifest and the caveat counter measures the
 *            fixture instead of the worker.
 *
 * Run (PI_BIN is mandatory — an unset PI_BIN makes the child re-invoke this harness
 * instead of pi, a fork bomb that has crashed this machine twice):
 *   PI_BIN=$(command -v pi) bun run scripts/live-worker-validity-baseline.ts [REPS] [LIMIT]
 *
 * REPS defaults to 8 — the floor for a model-variable seam, below which a real effect
 * cannot be told from noise. LIMIT truncates the corpus for a smoke run; a LIMITed run
 * is marked NOT A BASELINE in its own banner so a partial run can never be quoted as one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawn as nodeSpawn} from 'node:child_process'
import {registerPiWorkerDocs} from '../src/workers/pi-worker-docs.js'
import type {SpawnFn} from '../src/shared/child-process.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {reportArm, type Invariant} from './ab-verdict.js'
import {requirePreconditions} from './ab-preflight.js'

// ─── guards ──────────────────────────────────────────────────────────────────

await requirePreconditions('live-worker-validity-baseline', {model: {}, piBin: true, cacheOff: true})


const REPS = Number(process.argv[2] ?? '8')
const LIMIT = process.argv[3] ? Number(process.argv[3]) : undefined
if (!Number.isFinite(REPS) || REPS < 1) {
    console.error(`bad REPS: ${process.argv[2]}`)
    process.exit(1)
}

// ─── corpus + fixture tree ───────────────────────────────────────────────────

interface Question {
    pkg: string
    query: string
    recorded: {unclear: boolean; hallucWarn: boolean; caveated: boolean}
}

const HERE = path.dirname(new URL(import.meta.url).pathname)
const corpusAll = JSON.parse(
    fs.readFileSync(path.join(HERE, 'fixtures', 'run15-docs-corpus.json'), 'utf8')
) as Question[]
const corpus = LIMIT === undefined ? corpusAll : corpusAll.slice(0, LIMIT)

const MX5 = path.join(os.homedir(), 'hub', 'mx5')
const ROOT = path.join(os.homedir(), 'tmp', 'worker-validity-baseline')

function buildFixtureTree(): string {
    const dir = path.join(ROOT, 'tree')
    fs.rmSync(ROOT, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    fs.copyFileSync(path.join(MX5, 'package.json'), path.join(dir, 'package.json'))
    // Read-only view of the real installed tree: resolve/index only ever read it.
    fs.symlinkSync(path.join(MX5, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
    return dir
}

// ─── the tool under test, captured from the real registration ────────────────

type ToolExecute = (
    toolCallId: string,
    params: {module: string; query: string},
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: {cwd: string}
) => Promise<{content: Array<{type: string; text: string}>; details: Record<string, unknown>}>

/**
 * SPAWN INJECTION, and why it is faithful rather than a shortcut.
 *
 * pi-worker-docs.ts:128–132 picks `globalThis.Bun.spawn` when a Bun runtime is present,
 * but `runChild` (child-process.ts:385) invokes its spawn node-style as
 * `spawn(command, args, opts)` while `Bun.spawn` takes `(cmdArray, opts)` — so under Bun
 * every spawn in that tool throws `TypeError: cmd must be an array`. That branch is
 * DORMANT in production: pi runs the extension under node, which run 15 proves directly
 * (95 cache entries carry `autoInstalled: true`, i.e. the npm spawn succeeded). It fires
 * here only because harnesses run under `bun run`.
 *
 * So this injects, through the tool's own documented `internals.spawn` hook, exactly the
 * spawn production uses. It substitutes the process-spawn primitive and nothing else —
 * resolve, index, retrieve, the child summariser, the version banner, the hallucination
 * warning and the cache policy all stay the real shipped code. Fixing the Bun branch is a
 * src/ change and STEP 0 is measurement-only; it is recorded as a finding instead.
 */
function captureDocsTool(): ToolExecute {
    let captured: ToolExecute | undefined
    const pi = {
        registerTool(spec: {execute: ToolExecute}) {
            captured = spec.execute
        }
    }
    registerPiWorkerDocs(pi as never, {spawn: nodeSpawn as unknown as SpawnFn})
    if (!captured) throw new Error('registerPiWorkerDocs did not register a tool')
    return captured
}

// ─── scoring — the same predicates the static pass used ──────────────────────

const UNCLEAR = /unclear from this package/i
const CAVEAT = /\[VERSION — verify\]/

interface Score {
    unclear: boolean
    hallucWarn: boolean
    caveated: boolean
    valid: boolean
    strict: boolean
}

function score(text: string, details: Record<string, unknown>): Score {
    const unclear = UNCLEAR.test(text)
    const hallucWarn = details.excerptVerified === false
    const caveated = CAVEAT.test(text)
    const valid = !unclear && !hallucWarn
    return {unclear, hallucWarn, caveated, valid, strict: valid && !caveated}
}

interface Tally {
    n: number
    unclear: number
    hallucWarn: number
    caveated: number
    valid: number
    strict: number
    errors: number
}

const blank = (): Tally => ({
    n: 0,
    unclear: 0,
    hallucWarn: 0,
    caveated: 0,
    valid: 0,
    strict: 0,
    errors: 0
})

function add(t: Tally, s: Score): void {
    t.n++
    if (s.unclear) t.unclear++
    if (s.hallucWarn) t.hallucWarn++
    if (s.caveated) t.caveated++
    if (s.valid) t.valid++
    if (s.strict) t.strict++
}

const pct = (a: number, b: number): string => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1)}%`)

// ─── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

    const cwd = buildFixtureTree()
    const execute = captureDocsTool()
    const overall = blank()
    const perPkg: Record<string, Tally> = {}
    const perRep: Tally[] = []
    const rows: Array<Record<string, unknown>> = []

    console.log(
        `live-worker-validity-baseline — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
            + `corpus ${corpus.length}/${corpusAll.length} questions x ${REPS} reps `
            + `= ${corpus.length * REPS} live lookups, research cache OFF, tree ${cwd}`
            + (LIMIT === undefined ? '' : '\n*** LIMITed run — NOT A BASELINE ***')
    )
    const started = Date.now()

    for (let rep = 1; rep <= REPS; rep++) {
        const t = blank()
        const repStart = Date.now()
        for (const q of corpus) {
            try {
                const r = await execute(
                    `t${rep}`,
                    {module: q.pkg, query: q.query},
                    undefined,
                    undefined,
                    {cwd}
                )
                const text = r.content.map(c => c.text).join('')
                const s = score(text, r.details)
                add(t, s)
                add(overall, s)
                add((perPkg[q.pkg] ??= blank()), s)
                rows.push({rep, pkg: q.pkg, query: q.query, ...s, recorded: q.recorded})
            } catch (err) {
                t.errors++
                overall.errors++
                ;(perPkg[q.pkg] ??= blank()).errors++
                rows.push({rep, pkg: q.pkg, query: q.query, error: String(err).slice(0, 200)})
            }
        }
        perRep.push(t)
        const mins = (Date.now() - repStart) / 60000
        console.log(
            `  rep ${rep}/${REPS}  n=${t.n} valid=${pct(t.valid, t.n)} strict=${pct(t.strict, t.n)}`
                + `  unclear=${t.unclear} halluc=${t.hallucWarn} caveat=${t.caveated}`
                + `  errors=${t.errors}  [${mins.toFixed(1)}m]`
        )
        // Persist after every rep so a crash at rep 7 does not throw away reps 1-6.
        fs.writeFileSync(path.join(ROOT, 'results.json'), JSON.stringify(rows, null, 1), 'utf8')
    }

    console.log(
        `\n=== LIVE BASELINE (${overall.n} scored lookups, `
            + `${((Date.now() - started) / 3600000).toFixed(2)}h) ===`
    )
    console.log(
        `  valid   ${overall.valid}/${overall.n} = ${pct(overall.valid, overall.n)}`
            + `   (static run-15: 123/210 = 58.6%)  <- COMPARABLE`
    )
    console.log(
        `  unclear ${overall.unclear}   (static 60)  <- COMPARABLE\n`
            + `  halluc-warn ${overall.hallucWarn}   (static 34)  <- COMPARABLE\n`
            + `  errors ${overall.errors}`
    )
    console.log(
        `  strict  ${overall.strict}/${overall.n} = ${pct(overall.strict, overall.n)}`
            + `   (static run-15: 70/210 = 33.3%)  <- NOT COMPARABLE, see below`
    )
    console.log(`  caveated ${overall.caveated}   (static 95)  <- NOT COMPARABLE, see below`)
    // MANIFEST DRIFT — measured 2026-07-21, do not delete this warning.
    //
    // The version banner fires when a package is ABSENT from package.json
    // (docs-core.ts:197-202). mx5's manifest GREW across the run: sharp arrived ~07:45,
    // hono/zod-validator mid-run, and so on. A question asked before its package was
    // installed got a banner; the same question replayed against the FINAL manifest does
    // not. Rep-1 evidence, per package (live/static caveats):
    //     bun 61/61, node:crypto 1/1   — never declared, unchanged
    //     sharp 0/22, hono 0/6, @hono/zod-validator 0/4, @tailwindcss/cli 0/1
    //                                  — declared at HEAD, undeclared when first asked
    // So the caveat counter, and `strict` which is defined as valid-and-not-caveated,
    // measure the fixture's manifest as much as the worker. They are self-consistent
    // across reps and across a PROMPT 1-3 A/B (same fixture both arms), which is what a
    // regression base needs — but they must NOT be read against the static run-15 table.
    console.log(
        '\n  *** caveat/strict vs the static table is a MANIFEST-DRIFT ARTIFACT ***\n'
            + '  The banner fires on absence from package.json. mx5 installed packages AS the\n'
            + '  run progressed, so early questions were asked against a thinner manifest than\n'
            + '  this fixture carries. Valid%, unclear and halluc-warn do not depend on the\n'
            + '  manifest and ARE comparable. Use caveat/strict only arm-vs-arm, never vs run-15.'
    )

    const spread = perRep.map(r => (r.n === 0 ? 0 : (100 * r.valid) / r.n))
    const lo = Math.min(...spread)
    const hi = Math.max(...spread)
    console.log(`  per-rep valid%: ${spread.map(s => s.toFixed(1)).join(' ')}  (spread ${(hi - lo).toFixed(1)}pp)`)

    console.log('\n  per-package (live %valid vs run-15 static %valid):')
    for (const [pkg, t] of Object.entries(perPkg).sort((a, b) => b[1].n - a[1].n)) {
        const asked = corpus.filter(q => q.pkg === pkg)
        const staticValid = asked.filter(q => !q.recorded.unclear && !q.recorded.hallucWarn).length
        console.log(
            `    ${pkg.padEnd(36)} n=${String(t.n).padStart(4)}  live ${pct(t.valid, t.n)}`
                + `   static ${pct(staticValid, asked.length)}   caveat ${pct(t.caveated, t.n)}`
        )
    }
    console.log(`\n  per-question detail: ${path.join(ROOT, 'results.json')}`)

    const invariants: Invariant[] = [
        {
            label: 'research cache stayed OFF for every lookup (else reps are replays)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            label: 'reps >= 8 — the floor for a model-variable seam',
            ok: REPS >= 8,
            detail: `${REPS} reps`
        },
        {
            label: 'full corpus replayed (a LIMITed run is not a baseline)',
            ok: LIMIT === undefined,
            detail: `${corpus.length}/${corpusAll.length} questions`
        },
        {
            // A few throws are the real world; a wall of them means the fixture tree or
            // the server is broken and the percentages describe neither.
            label: 'lookup error rate under 10% (else the tree/server is broken, not the worker)',
            ok: overall.errors < (overall.n + overall.errors) * 0.1,
            detail: `${overall.errors} errors / ${overall.n + overall.errors} attempts`
        }
    ]

    reportArm({
        name: 'live-worker-validity-baseline',
        arm: 'baseline/pi-worker-docs',
        reps: overall.n,
        targetShape:
            'a pi-worker-docs answer that is INVALID by the run-15 predicates — the '
            + '"unclear from this package" non-answer, or an excerpt the verifier could '
            + 'not find in the retrieved content',
        hits: overall.n - overall.valid,
        // Precondition: the lookup completed and produced a scoreable answer at all.
        witnessed: overall.n,
        expect: 'some',
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
