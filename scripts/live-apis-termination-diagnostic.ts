/**
 * THE OPEN QUESTION — what was worker:apis looking at when it decided it was done?
 *
 * FACT (recorded, not re-derived here): 14 of 17 live probe reps ended worker:apis without
 * ever calling search or fetch — 82%. PROMPT 2 assumed type-only answers caused that. That
 * assumption is now REFUTED by measurement: the type-only detector fires on 9 of 1680 live
 * answers (0.54%) and on 2 of 210 questions, so it is arithmetically incapable of accounting
 * for an 82% aggregate. The cause is currently UNNAMED, and nothing may be built against it
 * until it is measured. This harness measures it. It is a DIAGNOSTIC: no lever, no src/
 * behaviour change, nothing stubbed.
 *
 * THE DIAGNOSTIC, exactly as the open question specifies it: for each rep take the LAST docs
 * answer before the worker stopped and classify it with the predicates this project already
 * defines — valid / "unclear from this package" / excerptVerified === false / type-only —
 * then report the distribution SPLIT BY whether the rep escalated. That says what the worker
 * was holding when it stopped.
 *
 * WHY IT IS ANSWERABLE NOW AND WAS NOT BEFORE. src/workers/typeonly-log.ts records EVERY
 * pi-worker-docs answer — module, verbatim query, full answer text, the shipped type-only
 * verdict and excerptVerified — as JSONL when PI_TASK_TYPEONLY_LOG names a sink, and is a
 * no-op otherwise. So the complete research transcript of a live rep is on disk and
 * re-scorable offline. This harness adds NO second logging channel; it sets that variable
 * and reads what the shipped tool wrote.
 *
 * ONE HOLE IN THAT CHANNEL HAD TO BE CLOSED FIRST, and it was not a small one. The sink was
 * wired only into the npm-package branch of pi-worker-docs; the `module: "."` project-source
 * branch returns ~150 lines earlier and recorded nothing. Project-source is the MAJORITY of
 * what worker:apis asks — 13 of 17 docs calls in run 15's fatal task, 7 of 12 in this
 * harness's first live rep — so "the last docs answer" would have been read off a sink whose
 * last row was routinely not the worker's last answer. The project branch's abstention is
 * also worded "unclear from this PROJECT", which the package-only predicate scored as valid.
 * Both are fixed in the shipped instrumentation, which remains behaviour-neutral: off unless
 * the env var is set, side-effect only, every failure swallowed.
 *
 * TWO CHANNELS, DELIBERATELY NOT ONE:
 *   escalation — the trial log phaseResearch itself writes via onChildOutput
 *                (`worker:apis: pi-worker-<tool>: …`), the same channel run 15 was audited
 *                from. A rep ESCALATED iff that log gains a search or fetch line.
 *   answers    — the JSONL sink, written from inside the docs tool.
 * Neither is a model self-report and neither is re-implemented here.
 *
 * ORDERING. The sink is appended when a lookup COMPLETES, so its order is completion order,
 * which is what "the last answer the worker received" means. Under parallel tool calls the
 * final batch's internal order is arbitrary, so the last-3 classes are printed alongside the
 * last-1 rather than resting the whole reading on one row.
 *
 * COUNTED SEPARATELY, NEVER FOLDED IN: a rep that made ZERO docs calls did not "accept an
 * answer and stop" — it wrote the APIS section from memory. That is a DIFFERENT, already
 * recorded failure (3 of ~18 reps). Folding it into the terminated column would attribute
 * a memory-written section to whatever the worker never looked at.
 *
 * CORPUS-WIDE COMPARISON RATES, measured over 1680 live lookups of the run-15 corpus:
 * unclear 25.3%, halluc-warn 22.5%, type-only 0.54%. A last-answer class distribution that
 * matches those is a random draw and names no cause; one that departs from them does.
 *
 * ENVIRONMENT (record it when quoting any number this prints)
 *   model    Qwen3.6-27B-NVFP4-MTP.gguf via llama-server @ 127.0.0.1:8080
 *   launcher ~/hub/qwen/run-Q3.6-27B.sh — that script, never a hand-rolled invocation: a
 *            sub-default batch (-b 512 -ub 256) corrupts large parallel tool calls.
 *   tree     the run's OWN pre-TASK_0027 tree (mx5@4b9827d) via run15-fixture-tree.ts.
 *
 * Run (`bun run build` first — this imports from dist/ so phaseResearch resolves the docs
 * extension path; PI_BIN mandatory, an unset PI_BIN self-spawns a fork bomb):
 *   PI_BIN=$(command -v pi) bun run scripts/live-apis-termination-diagnostic.ts [REPS]
 * To re-score a completed run without spending model time again:
 *   DIAG_DIR=~/tmp/apis-termination-diagnostic bun run scripts/live-apis-termination-diagnostic.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
// From dist/, not src/ — phaseResearch resolves DOCS_EXTENSION_PATH relative to its own
// module as a .js, which exists only in the build.
import {phaseResearch} from '../dist/task/phases.js'
import type {PhaseDeps} from '../dist/task/child-runner.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {
    TYPEONLY_LOG_ENV,
    readTypeOnlyLog,
    type TypeOnlyLogRecord
} from '../src/workers/typeonly-log.js'
import {reportArm, type Invariant} from './ab-verdict.js'
import {REFINED_27, buildPreTask27Tree} from './run15-fixture-tree.js'

const REPS = Number(process.argv[2] ?? '12')
const ROOT = process.env.DIAG_DIR ?? path.join(os.homedir(), 'tmp', 'apis-termination-diagnostic')
const TRIAL_TIMEOUT_MS = 45 * 60_000

/**
 * The four classes the open question names. They are NOT mutually exclusive in the raw data
 * (an "unclear" answer can also carry an unverified excerpt), so a single-label view needs a
 * stated priority: most specific first. Raw per-flag counts are printed too, so the priority
 * cannot hide an overlap.
 */
export type AnswerClass = 'type-only' | 'unclear' | 'halluc-warn' | 'valid'

export function classify(rec: TypeOnlyLogRecord): AnswerClass {
    if (rec.typeOnly) return 'type-only'
    if (rec.unclear) return 'unclear'
    if (rec.excerptVerified === false) return 'halluc-warn'
    return 'valid'
}

const CLASSES: AnswerClass[] = ['valid', 'unclear', 'halluc-warn', 'type-only']

/** Tool-layer call counts for one rep, read back from the log the run itself wrote. */
export interface ToolCounts {
    docs: number
    dotDocs: number
    search: number
    fetch: number
}

/**
 * Count tool calls from a trial log. Each call appears TWICE — once via logDebug and once via
 * onChildOutput — so the `[debug] ` copies are dropped; an earlier probe counted both and
 * reported every call count doubled.
 */
export function countToolCalls(log: string): ToolCounts {
    const lines = log.split('\n').filter(l => !l.startsWith('[debug] '))
    const n = (re: RegExp): number => lines.filter(l => re.test(l)).length
    return {
        docs: n(/pi-worker-docs:/),
        dotDocs: n(/pi-worker-docs: \.\s/),
        search: n(/pi-worker-search:/),
        fetch: n(/pi-worker-fetch:/)
    }
}

interface Rep {
    rep: number
    counts: ToolCounts
    answers: TypeOnlyLogRecord[]
    minutes: number
    error?: string
}

const pct = (a: number, b: number): string => (b === 0 ? ' n/a' : `${((100 * a) / b).toFixed(1)}%`)

/** Distribution of classes over a set of answers, printed as one aligned row. */
function dist(records: TypeOnlyLogRecord[]): Record<AnswerClass, number> {
    const out = {valid: 0, unclear: 0, 'halluc-warn': 0, 'type-only': 0} as Record<
        AnswerClass,
        number
    >
    for (const r of records) out[classify(r)]++
    return out
}

/** ln n!, summed rather than via a gamma approximation — n here is at most a few hundred. */
function lnFact(n: number): number {
    let s = 0
    for (let i = 2; i <= n; i++) s += Math.log(i)
    return s
}

/** Exact binomial pmf, in log space so a small p and a large n do not underflow to zero. */
function binomPmf(k: number, n: number, p: number): number {
    if (k < 0 || k > n) return 0
    if (p <= 0) return k === 0 ? 1 : 0
    if (p >= 1) return k === n ? 1 : 0
    return Math.exp(
        lnFact(n) - lnFact(k) - lnFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p)
    )
}

/**
 * Two-sided exact binomial p for observing `k` successes in `n` draws at rate `p`, by the
 * min-tail-doubled convention. Used to ask whether a class appears in the LAST position more
 * or less often than it appears anywhere in the same worker's answer stream.
 */
export function binomTwoSided(k: number, n: number, p: number): number {
    if (n === 0) return 1
    let lower = 0
    for (let i = 0; i <= k; i++) lower += binomPmf(i, n, p)
    let upper = 0
    for (let i = k; i <= n; i++) upper += binomPmf(i, n, p)
    return Math.min(1, 2 * Math.min(lower, upper))
}

function distRow(label: string, d: Record<AnswerClass, number>, n: number): string {
    const cells = CLASSES.map(c => `${c} ${String(d[c]).padStart(3)} (${pct(d[c], n).padStart(6)})`)
    return `  ${label.padEnd(30)} n=${String(n).padStart(4)}   ${cells.join('  ')}`
}

async function runReps(): Promise<Rep[]> {
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error(
            'FATAL: llama-server @ 127.0.0.1:8080 not reachable. Start ~/hub/qwen/run-Q3.6-27B.sh.'
        )
        process.exit(1)
    }
    console.log(
        `live-apis-termination-diagnostic — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n`
            + `real phaseResearch, NOTHING stubbed, ${REPS} reps on the pre-TASK_0027 tree\n`
            + `answers recorded by the shipped tool via ${TYPEONLY_LOG_ENV} into ${ROOT}/rep-N.jsonl`
    )
    const reps: Rep[] = []
    for (let t = 1; t <= REPS; t++) {
        const dir = buildPreTask27Tree(ROOT, t)
        const sink = path.join(ROOT, `rep-${t}.jsonl`)
        fs.rmSync(sink, {force: true})
        // The sink is read by the docs tool running inside the worker:apis pi child, which
        // inherits this process's environment. Absolute path: the child's cwd is the trial tree.
        process.env[TYPEONLY_LOG_ENV] = sink

        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
        const logPath = path.join(dir, 'trial.log')
        const deps: PhaseDeps = {
            cwd: dir,
            taskId: 'TASK_0027',
            signal: abort.signal,
            onChildOutput: l => fs.appendFileSync(logPath, l + '\n'),
            logDebug: m => fs.appendFileSync(logPath, `[debug] ${m}\n`)
        }
        const started = Date.now()
        let error: string | undefined
        try {
            await phaseResearch(deps, REFINED_27)
        } catch (e) {
            error = String(e).slice(0, 200)
        } finally {
            clearTimeout(timer)
        }
        const counts = countToolCalls(
            fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
        )
        const answers = fs.existsSync(sink) ? readTypeOnlyLog(fs.readFileSync(sink, 'utf8')) : []
        const rep: Rep = {
            rep: t,
            counts,
            answers,
            minutes: (Date.now() - started) / 60000,
            ...(error ? {error} : {})
        }
        reps.push(rep)
        const last = answers.at(-1)
        console.log(
            `  rep ${t}/${REPS}: docs=${counts.docs} (dot=${counts.dotDocs}) `
                + `search=${counts.search} fetch=${counts.fetch}  `
                + `escalated=${counts.search + counts.fetch > 0 ? 'YES' : 'no'}  `
                + `answers=${answers.length} last=${last ? `${classify(last)}/${last.module}` : 'NONE'}`
                + `  [${rep.minutes.toFixed(1)}m]${error ? `  ERROR ${error}` : ''}`
        )
        // Persist after every rep so a crash at rep 11 does not throw away reps 1-10.
        fs.writeFileSync(path.join(ROOT, 'diagnostic.json'), JSON.stringify(reps, null, 1), 'utf8')
    }
    return reps
}

/** Re-score a completed run from what is already on disk — no model time. */
function loadReps(): Rep[] {
    const saved = path.join(ROOT, 'diagnostic.json')
    if (fs.existsSync(saved)) {
        console.log(`live-apis-termination-diagnostic — RE-SCORING ${saved} (no model time)`)
        return JSON.parse(fs.readFileSync(saved, 'utf8')) as Rep[]
    }
    console.error(`FATAL: DIAG_DIR set but ${saved} does not exist.`)
    process.exit(1)
}

function main(reps: Rep[]): void {
    // ── the three populations, kept apart ────────────────────────────────────
    // A rep that never called docs did not accept an answer and stop; it wrote the section
    // from memory. Already recorded as a distinct failure, and folded in it would attribute
    // a memory-written section to an answer that was never fetched.
    const noDocs = reps.filter(r => r.counts.docs === 0)
    const consulted = reps.filter(r => r.counts.docs > 0)
    const escalated = consulted.filter(r => r.counts.search + r.counts.fetch > 0)
    const terminated = consulted.filter(r => r.counts.search + r.counts.fetch === 0)

    console.log(`\n=== POPULATIONS (${reps.length} reps) ===`)
    console.log(
        `  consulted docs        ${consulted.length}\n`
            + `    terminated (no search/fetch)  ${terminated.length}  `
            + `= ${pct(terminated.length, consulted.length)} of reps that researched\n`
            + `    escalated                     ${escalated.length}\n`
            + `  ZERO docs calls       ${noDocs.length}  `
            + `<- DIFFERENT failure: section written from memory, counted separately`
    )
    const errored = reps.filter(r => r.error)
    if (errored.length > 0) console.log(`  reps that threw       ${errored.length}`)

    // ── the diagnostic ───────────────────────────────────────────────────────
    console.log(`\n=== LAST DOCS ANSWER BEFORE THE WORKER STOPPED ===`)
    console.log(
        `  Priority when flags overlap: type-only > unclear > halluc-warn > valid.\n`
            + `  Corpus-wide live rates for comparison (1680 lookups of the run-15 corpus):\n`
            + `    valid 51.6%  unclear 25.3%  halluc-warn 22.5%  type-only 0.54%`
    )
    const lastOf = (rs: Rep[]): TypeOnlyLogRecord[] =>
        rs.map(r => r.answers.at(-1)).filter((a): a is TypeOnlyLogRecord => a !== undefined)
    const lastTerm = lastOf(terminated)
    const lastEsc = lastOf(escalated)
    console.log('')
    console.log(distRow('LAST answer | terminated', dist(lastTerm), lastTerm.length))
    console.log(distRow('LAST answer | escalated', dist(lastEsc), lastEsc.length))

    // The comparison that decides whether the last-answer class means anything: if the last
    // answer's class distribution matches the distribution of ALL that rep's answers, the
    // last answer is a random draw from what the worker saw and names no cause.
    const allTerm = terminated.flatMap(r => r.answers)
    const allEsc = escalated.flatMap(r => r.answers)
    console.log('')
    console.log(distRow('ALL answers | terminated', dist(allTerm), allTerm.length))
    console.log(distRow('ALL answers | escalated', dist(allEsc), allEsc.length))

    // Last-3, because under parallel tool calls the final batch's internal completion order
    // is arbitrary and a single last row would be over-read.
    const last3 = (rs: Rep[]): TypeOnlyLogRecord[] => rs.flatMap(r => r.answers.slice(-3))
    console.log('')
    console.log(
        distRow('LAST-3 answers | terminated', dist(last3(terminated)), last3(terminated).length)
    )
    console.log(
        distRow('LAST-3 answers | escalated', dist(last3(escalated)), last3(escalated).length)
    )

    // ── DOES THE LAST-ANSWER CLASS DISCRIMINATE? decided by a stated test ─────
    // The question is whether the class of the last answer says anything about why the worker
    // stopped. The control is the SAME reps' own answer stream: if each last answer looks like
    // an independent draw from what that worker happened to see, its class names nothing.
    //
    // THE TEST IS EXACT-BINOMIAL, NOT A PERCENTAGE-POINT THRESHOLD, and that is not fussiness.
    // A first version of this block used "largest departure >= 10pp" and duly announced that
    // halluc-warn discriminated at 10.2pp — on 2 of 11 last answers, where ONE rep moves a
    // cell by 9pp. At this n a pp threshold is a coin flip with a decimal point. Under the
    // null each of the n last answers is a draw with the class's all-answer rate, so the
    // exact two-sided binomial p is available and costs nothing. Bonferroni over the four
    // classes, because looking at four and reporting the smallest is four chances at 0.05.
    const ALPHA = 0.05
    const lastDist = dist(lastTerm)
    const allDist = dist(allTerm)
    console.log(`\n=== DOES THE LAST-ANSWER CLASS DISCRIMINATE? ===`)
    console.log(
        `  per class: observed among the ${lastTerm.length} LAST answers vs the rate over all `
            + `${allTerm.length} answers of the same reps`
    )
    let anySignificant = false
    for (const c of CLASSES) {
        const k = lastDist[c]
        const p0 = allTerm.length === 0 ? 0 : allDist[c] / allTerm.length
        const p = binomTwoSided(k, lastTerm.length, p0)
        const adjusted = Math.min(1, p * CLASSES.length)
        if (adjusted < ALPHA) anySignificant = true
        console.log(
            `    ${c.padEnd(12)} ${String(k).padStart(2)}/${lastTerm.length} observed vs `
                + `${(100 * p0).toFixed(1).padStart(5)}% expected `
                + `(${(p0 * lastTerm.length).toFixed(1)} answers)   `
                + `binomial p = ${p.toFixed(3)}, Bonferroni ${adjusted.toFixed(3)}`
                + `${adjusted < ALPHA ? '  <- SIGNIFICANT' : ''}`
        )
    }
    console.log(
        `  VERDICT: `
            + (anySignificant ?
                'at least one class IS over- or under-represented in the last position; '
                + 'read the classes above.'
            :   'NO — the last-answer class DOES NOT DISCRIMINATE. Every class appears in the '
                + "last position at the rate it appears everywhere in that rep's own stream, "
                + 'so the last answer is a draw from what the worker saw and explains nothing '
                + 'about why it stopped.')
    )
    console.log(
        `  escalated reps: ${escalated.length}/${consulted.length} — `
            + (escalated.length < 3 ?
                'too few to compare the two groups at all. Any terminated-vs-escalated '
                + 'difference read off this run would be one or two reps wearing a percentage.'
            :   'enough to compare the two groups.')
    )

    // ── the honest-abstention predicate under-counts, and by how much ─────────
    // Rep 2 terminated on an answer scored `valid` that opens "The `hc` function signature …
    // are not explicitly defined in the provided package content" — an abstention in every
    // sense except the exact phrase the predicate matches. This is the CEILING WARNING made
    // numeric: the `valid` class is an upper bound, and so is every rate computed from it.
    // Re-scored offline from the retained answer text, which is why that text is retained.
    const HEDGE =
        /not (explicitly )?(defined|present|specified|included|shown|listed|documented|available|found)|does not (appear|contain|include|define|specify)|is not (in|part of)|no (information|details|documentation) (on|about|for)|cannot be determined|not (visible|covered) in/i
    const all = reps.flatMap(r => r.answers)
    const validAnswers = all.filter(a => classify(a) === 'valid')
    const hedgedValid = validAnswers.filter(a => HEDGE.test(a.answer))
    console.log(`\n=== HOW MUCH THE 'valid' CLASS OVER-COUNTS ===`)
    console.log(
        `  ${hedgedValid.length}/${validAnswers.length} = ${pct(hedgedValid.length, validAnswers.length)}`
            + ` of 'valid' answers carry an abstention hedge that "unclear from this `
            + `package/project" does not match`
    )
    console.log(
        `  so 'valid' is an upper bound by roughly that much, and the last-answer table `
            + `inherits it.`
    )

    // ── what the worker was ASKING about, which the class alone cannot say ────
    // Run 15's fatal task spent 13 of 17 docs calls on project source (`module: "."`). A
    // worker whose last lookups are project-source is not stalled on a failed package
    // answer at all — it is mapping local files and believes it is finished.
    console.log(`\n=== MODULE OF THE LAST ANSWER (package lookup vs project source ".") ===`)
    const modSplit = (rs: Rep[]): string => {
        const ls = lastOf(rs)
        const dot = ls.filter(a => a.module === '.').length
        return `"." ${dot}/${ls.length} (${pct(dot, ls.length)}), package ${ls.length - dot}`
    }
    console.log(`  terminated: ${modSplit(terminated)}`)
    console.log(`  escalated : ${modSplit(escalated)}`)
    const dotAll = (rs: Rep[]): string => {
        const a = rs.flatMap(r => r.answers)
        const dot = a.filter(x => x.module === '.').length
        return `${dot}/${a.length} (${pct(dot, a.length)})`
    }
    console.log(`  ALL answers, terminated reps: "." ${dotAll(terminated)}`)
    console.log(`  ALL answers, escalated reps : "." ${dotAll(escalated)}`)

    // ── the raw last answers, so a human can read what the worker was holding ─
    console.log(`\n=== THE LAST ANSWER OF EVERY TERMINATED REP (verbatim, clipped) ===`)
    for (const r of terminated) {
        const a = r.answers.at(-1)
        if (!a) {
            console.log(`  rep ${r.rep}: docs=${r.counts.docs} but the sink recorded NO answer`)
            continue
        }
        console.log(
            `  rep ${String(r.rep).padStart(2)} [${classify(a)}] ${a.module}  `
                + `q: ${a.query.replace(/\s+/g, ' ').slice(0, 88)}`
        )
        console.log(`      a: ${a.answer.replace(/\s+/g, ' ').slice(0, 150)}`)
    }

    // ── overlap, so the single-label priority cannot hide anything ────────────
    console.log(`\n=== RAW FLAG COUNTS over all ${all.length} recorded answers (overlapping) ===`)
    console.log(
        `  type-only ${all.filter(a => a.typeOnly).length}   `
            + `unclear ${all.filter(a => a.unclear).length}   `
            + `halluc-warn ${all.filter(a => a.excerptVerified === false).length}   `
            + `no excerpt cited ${all.filter(a => a.excerptVerified === undefined).length}`
    )
    console.log(`  raw data: ${path.join(ROOT, 'diagnostic.json')} + ${ROOT}/rep-N.jsonl`)

    // ── invariants ───────────────────────────────────────────────────────────
    // The sink is written only on the tool's success path; a lookup that failed to resolve a
    // package logs a call line and records no answer. So sink rows <= docs call lines is
    // EXPECTED, and the invariant is that the sink observed most of them — a sink that lost
    // rows silently would put a wrong denominator under every rate above.
    const docsCalls = reps.reduce((a, r) => a + r.counts.docs, 0)
    const invariants: Invariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first rep answers)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            label: 'reps >= 12 — the floor this diagnostic was specified at',
            ok: reps.length >= 12,
            detail: `${reps.length} reps`
        },
        {
            label: 'the instrumentation sink observed the docs calls it could',
            ok: docsCalls > 0 && all.length >= docsCalls * 0.8 && all.length <= docsCalls,
            detail: `${all.length} recorded answers / ${docsCalls} docs call lines`
        },
        {
            label: 'every rep that consulted docs recorded a last answer to classify',
            ok: consulted.every(r => r.answers.length > 0),
            detail: `${consulted.filter(r => r.answers.length === 0).length} rep(s) with none`
        }
    ]

    reportArm({
        name: 'live-apis-termination-diagnostic',
        arm: 'shipped/phaseResearch (diagnostic, no lever)',
        reps: consulted.length,
        targetShape:
            'worker:apis TERMINATING without ever calling search or fetch, with the class of '
            + 'the last docs answer it received recorded. This is a DIAGNOSTIC census, not a '
            + 'lever test: it names what the worker was holding when it stopped. An ABSTAIN '
            + '(no rep consulted docs) means the 82% population was not reproduced and the '
            + 'open question must be re-derived against a fixture that does reproduce it.',
        hits: terminated.length,
        witnessed: consulted.length,
        expect: 'some',
        invariants
    })
}

// Guards apply to a LIVE run only — re-scoring what is already on disk spawns nothing.
if (process.env.DIAG_DIR) {
    main(loadReps())
} else {
    if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
        console.error(
            'REFUSING TO RUN: PI_BIN is unset. An unset PI_BIN makes the child re-invoke this '
                + 'harness instead of pi — a fork bomb that has crashed this machine twice.'
        )
        process.exit(1)
    }
    if (process.env[RESEARCH_RUN_ID_ENV]) {
        console.error(
            `REFUSING TO RUN: ${RESEARCH_RUN_ID_ENV} is set — every rep after the first would `
                + 'replay the first rep answers from the research cache.'
        )
        process.exit(1)
    }
    runReps()
        .then(main)
        .catch(e => {
            console.error(e)
            process.exit(1)
        })
}
