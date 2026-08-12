/**
 * STAGE 1 A + B — how often does a type-only answer actually happen, and is it stable?
 *
 * THE QUESTION THIS SETTLES. PROMPT 2's A/B returned p = 0.88 and the lever was recorded as
 * "did not move the metric". Two admitted defects in that experiment, neither of which is a
 * defect in the code: the metric counted ALL research terminations while the lever touches
 * only type-only answers, and the detector was measured — statically, once — at 1 flag in
 * 150 recorded answers (0.7%), which is arithmetically incapable of moving an 82% aggregate.
 * Before any further experiment can be SIZED, two numbers have to exist and do not:
 *
 *   A. BASE RATE.  Over >= 8 reps x the 210 run-15 package questions, how often does
 *      pi-worker-docs return an answer the SHIPPED detector calls type-only? Confirm or
 *      refute the static 0.7% live, and report the per-rep spread — a rate that swings
 *      across identical reps is not a rate you can size an arm from.
 *   B. STABILITY.  Is a given question type-only in EVERY rep, or does it churn? This is not
 *      a pedantic question. The same corpus churns `excerptVerified` on 43% of questions
 *      (90/210) between IDENTICAL reps, so that counter is not a per-question property at
 *      all. If type-only churns similarly, NO small fixture is valid — including the pinned
 *      hc regression test that stage 1 exit (ii) would otherwise prescribe — and this
 *      harness must say so.
 *
 * SEAM — the pi-worker-docs TOOL via makeWorkerTool's execute, the same entry point
 * live-worker-validity-baseline.ts uses and the same one the research child calls. The
 * detector runs inside that tool (pi-worker-docs.ts, right after parseChildOutput), so
 * `details.typeOnly` is the shipped verdict, not a re-implementation living in this file.
 * A harness that re-derived the predicate would measure the harness.
 *
 * METRIC — mechanical, tool-layer, never model self-report. Two independent channels are
 * recorded and cross-checked against each other:
 *   (1) `details.typeOnly === true` on the tool's return value;
 *   (2) the PI_TASK_TYPEONLY_LOG JSONL sink written from inside the tool.
 * They must agree on every lookup. That equality is asserted as an invariant, because it is
 * the only thing standing between "the instrumentation observes every answer" and a rate
 * computed over a denominator that quietly lost rows.
 *
 * NOT A BEHAVIOUR TEST. This harness measures the SHIPPED path, both arms of nothing. It
 * answers "how big is the population" — the input to choosing an instrument — and it is
 * deliberately NOT the conditional A/B, which is only valid if this run says the population
 * exists.
 *
 * ENVIRONMENT (record it when quoting any number this prints)
 *   model    Qwen3.6-27B-NVFP4-MTP.gguf via llama-server @ 127.0.0.1:8080
 *   launcher ~/hub/qwen/run-Q3.6-27B.sh — that script, never a hand-rolled invocation: a
 *            sub-default batch (-b 512 -ub 256) corrupts large parallel tool calls,
 *            bisected over 930 live reps.
 *   tree     a fixture cwd carrying mx5's package.json with node_modules symlinked, exactly
 *            as live-worker-validity-baseline.ts builds it (the version banner fires on
 *            ABSENCE from package.json, so the manifest is load-bearing).
 *
 * Run (PI_BIN mandatory — an unset PI_BIN makes the child re-invoke this harness instead of
 * pi, a fork bomb that has crashed this machine twice):
 *   PI_BIN=$(command -v pi) bun run scripts/live-typeonly-baserate.ts [REPS] [LIMIT]
 *
 * REPS defaults to 8. LIMIT truncates the corpus for a smoke run and marks the run NOT A
 * BASELINE in its own banner, so a partial run can never be quoted as one.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawn as nodeSpawn} from 'node:child_process'
import {registerPiWorkerDocs} from '../src/workers/pi-worker-docs.js'
import type {SpawnFn} from '../src/shared/child-process.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {TYPEONLY_LOG_ENV, readTypeOnlyLog} from '../src/workers/typeonly-log.js'
import {reportArm, type Invariant} from './ab-verdict.js'
import {wilson} from './ab-stats.js'
import {requirePreconditions} from './ab-preflight.js'

// ─── guards ──────────────────────────────────────────────────────────────────

await requirePreconditions('live-typeonly-baserate', {model: {}, piBin: true, cacheOff: true})


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
const ROOT = path.join(os.homedir(), 'tmp', 'typeonly-baserate')

function buildFixtureTree(): string {
    const dir = path.join(ROOT, 'tree')
    fs.rmSync(ROOT, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    fs.copyFileSync(path.join(MX5, 'package.json'), path.join(dir, 'package.json'))
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
 * SPAWN INJECTION — the same substitution live-worker-validity-baseline.ts documents.
 * pi-worker-docs.ts picks `globalThis.Bun.spawn` under a Bun runtime, but runChild invokes
 * its spawn node-style, so under `bun run` every spawn throws `TypeError: cmd must be an
 * array` (F-4). That branch is DORMANT in production — pi runs the extension under node —
 * so injecting node's spawn through the tool's own documented `internals.spawn` hook
 * restores exactly the production primitive and changes nothing else: resolve, index,
 * retrieve, the child summariser, the version banner, the excerpt verifier and the type-only
 * detector all stay the real shipped code.
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

// ─── scoring ─────────────────────────────────────────────────────────────────

const UNCLEAR = /unclear from this package/i

interface Row {
    rep: number
    pkg: string
    query: string
    typeOnly: boolean
    unclear: boolean
    hallucWarn: boolean
    error?: string
}

const pct = (a: number, b: number): string => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1)}%`)

/** Wilson 95% interval — a 1-in-200 rate quoted without one invites the same overreach the
 *  static 0.7% produced. */


// ─── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {

    const cwd = buildFixtureTree()
    // Second, independent channel: the tool writes here from inside itself. Cross-checked
    // against `details.typeOnly` below, so a silently-dropped row cannot inflate the rate.
    const sink = path.join(ROOT, 'answers.jsonl')
    process.env[TYPEONLY_LOG_ENV] = sink

    const execute = captureDocsTool()
    const rows: Row[] = []
    let errors = 0

    console.log(
        `live-typeonly-baserate — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
            + `corpus ${corpus.length}/${corpusAll.length} questions x ${REPS} reps `
            + `= ${corpus.length * REPS} live lookups, research cache OFF, tree ${cwd}\n`
            + `answers + verdicts: ${sink}`
            + (LIMIT === undefined ? '' : '\n*** LIMITed run — NOT A BASELINE ***')
    )
    const started = Date.now()

    for (let rep = 1; rep <= REPS; rep++) {
        const repStart = Date.now()
        let repFlags = 0
        let repN = 0
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
                const typeOnly = r.details.typeOnly === true
                repN++
                if (typeOnly) repFlags++
                rows.push({
                    rep,
                    pkg: q.pkg,
                    query: q.query,
                    typeOnly,
                    unclear: UNCLEAR.test(text),
                    hallucWarn: r.details.excerptVerified === false
                })
            } catch (err) {
                errors++
                rows.push({
                    rep,
                    pkg: q.pkg,
                    query: q.query,
                    typeOnly: false,
                    unclear: false,
                    hallucWarn: false,
                    error: String(err).slice(0, 200)
                })
            }
        }
        console.log(
            `  rep ${rep}/${REPS}  n=${repN} type-only=${repFlags} (${pct(repFlags, repN)})`
                + `  errors=${errors}  [${((Date.now() - repStart) / 60000).toFixed(1)}m]`
        )
        // Persist after every rep so a crash at rep 7 does not throw away reps 1-6.
        fs.writeFileSync(path.join(ROOT, 'baserate.json'), JSON.stringify(rows, null, 1), 'utf8')
    }

    // ── A. BASE RATE ─────────────────────────────────────────────────────────
    const scored = rows.filter(r => r.error === undefined)
    const flags = scored.filter(r => r.typeOnly).length
    const [lo, hi] = wilson(flags, scored.length)

    console.log(
        `\n=== A. BASE RATE (${scored.length} scored lookups, `
            + `${((Date.now() - started) / 3600000).toFixed(2)}h) ===`
    )
    console.log(
        `  type-only ${flags}/${scored.length} = ${pct(flags, scored.length)}`
            + `   Wilson 95% [${(100 * lo).toFixed(2)}%, ${(100 * hi).toFixed(2)}%]`
    )
    console.log(`  static run-15 record: 1/150 = 0.7%  <- confirm or refute against the above`)
    console.log(`  unclear ${scored.filter(r => r.unclear).length}   `
        + `halluc-warn ${scored.filter(r => r.hallucWarn).length}   errors ${errors}`)

    const perRep: number[] = []
    for (let rep = 1; rep <= REPS; rep++) {
        const rr = scored.filter(r => r.rep === rep)
        perRep.push(rr.filter(r => r.typeOnly).length)
    }
    console.log(`  per-rep type-only counts: ${perRep.join(' ')}`
        + `  (min ${Math.min(...perRep)}, max ${Math.max(...perRep)})`)

    const perPkg: Record<string, {n: number; flags: number}> = {}
    for (const r of scored) {
        const e = (perPkg[r.pkg] ??= {n: 0, flags: 0})
        e.n++
        if (r.typeOnly) e.flags++
    }
    const flagging = Object.entries(perPkg)
        .filter(([, v]) => v.flags > 0)
        .sort((a, b) => b[1].flags - a[1].flags)
    console.log(`\n  packages with any firing (${flagging.length} of ${Object.keys(perPkg).length}):`)
    for (const [pkg, v] of flagging) {
        console.log(`    ${pkg.padEnd(36)} ${v.flags}/${v.n} = ${pct(v.flags, v.n)}`)
    }

    // ── B. STABILITY ─────────────────────────────────────────────────────────
    // A question is a valid FIXTURE only if it behaves the same way in every rep. The same
    // corpus churns excerptVerified on 43% of questions between identical reps; if type-only
    // churns like that, no pinned single-case regression test is trustworthy either.
    // Each entry CARRIES its pkg and query instead of encoding them into the key. The key
    // needs a separator that cannot occur in a query; a NUL does the job but turns this file
    // binary, so grep/ripgrep silently report zero matches in it — a real trap this repo has
    // been bitten by before. U+241F (the SYMBOL FOR UNIT SEPARATOR) is just as impossible in
    // a query and keeps the file text.
    const byQ: Record<string, {pkg: string; query: string; n: number; flags: number}> = {}
    for (const r of scored) {
        const e = (byQ[`${r.pkg}\u241f${r.query}`] ??= {
            pkg: r.pkg,
            query: r.query,
            n: 0,
            flags: 0
        })
        e.n++
        if (r.typeOnly) e.flags++
    }
    const qs = Object.values(byQ)
    const always = qs.filter(q => q.flags === q.n).length
    const never = qs.filter(q => q.flags === 0).length
    const churn = qs.filter(q => q.flags > 0 && q.flags < q.n).length
    const everFlagged = qs.length - never

    console.log(`\n=== B. STABILITY (${qs.length} distinct questions x ${REPS} reps) ===`)
    console.log(
        `  type-only in EVERY rep : ${always}\n`
            + `  type-only in SOME reps : ${churn}   <- churning; not a per-question property\n`
            + `  type-only in NO rep    : ${never}`
    )
    console.log(
        `  of the ${everFlagged} questions that EVER flag, ${churn} churn = `
            + `${pct(churn, everFlagged)} churn rate  (excerptVerified's churn on this same `
            + `corpus: 43%)`
    )
    if (everFlagged > 0) {
        console.log('\n  every question that ever flagged (flags/reps):')
        for (const q of qs.filter(e => e.flags > 0)) {
            console.log(
                `    ${String(q.flags).padStart(2)}/${q.n}  ${q.pkg}  ${q.query.slice(0, 96)}`
            )
        }
    }

    // ── cross-check the two channels ─────────────────────────────────────────
    const logged = fs.existsSync(sink) ? readTypeOnlyLog(fs.readFileSync(sink, 'utf8')) : []
    const loggedFlags = logged.filter(l => l.typeOnly).length
    console.log(
        `\n  instrumentation cross-check: sink rows ${logged.length} (flags ${loggedFlags}) `
            + `vs tool returns ${scored.length} (flags ${flags})`
    )
    console.log(`  per-question detail: ${path.join(ROOT, 'baserate.json')}`)

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
            label: 'full corpus replayed (a LIMITed run is not a base rate)',
            ok: LIMIT === undefined,
            detail: `${corpus.length}/${corpusAll.length} questions`
        },
        {
            label: 'lookup error rate under 10% (else the tree/server is broken, not the worker)',
            ok: errors < rows.length * 0.1,
            detail: `${errors} errors / ${rows.length} attempts`
        },
        {
            // The rate's denominator comes from the tool's return values; the sink is the
            // channel every OTHER stage-1 measurement reads. If they disagree, the sink is
            // dropping rows and every number read from it downstream is wrong.
            label: 'instrumentation sink observed every scored answer, with identical verdicts',
            ok: logged.length === scored.length && loggedFlags === flags,
            detail: `sink ${logged.length}/${loggedFlags} vs tool ${scored.length}/${flags}`
        }
    ]

    reportArm({
        name: 'live-typeonly-baserate',
        arm: 'shipped/pi-worker-docs',
        reps: scored.length,
        targetShape:
            'a pi-worker-docs answer the SHIPPED detector calls TYPE-ONLY. This is a '
            + 'population census, not a lever test: it measures how many answers the '
            + 'PROMPT 2 lever can possibly reach. An ABSTAIN (zero firings across the whole '
            + 'corpus) means the lever has no population at all and a conditional A/B '
            + 'cannot be run — see stage 1 exit (ii).',
        hits: flags,
        witnessed: scored.length,
        expect: 'some',
        invariants
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
