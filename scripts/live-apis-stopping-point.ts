/**
 * STAGE 1 — MEASURE THE STOPPING POINT of worker:apis. Diagnostic only: no lever, nothing
 * stubbed, no src/ behaviour change.
 *
 * ── WHAT IS ALREADY KNOWN, AND IS NOT RE-DERIVED HERE ─────────────────────────────────────
 *
 * worker:apis terminates without ever calling search or fetch in 11/12 live reps (91.7%), and
 * 0/20 reps of the two fixtures below fetched anything at all. The CLASS of its last docs
 * answer does not discriminate: exact two-sided binomial per class against that rep's own
 * all-answer rate, Bonferroni over four classes, every adjusted p = 1.000 except type-only at
 * 0.338. It is not stuck in front of failed lookups — its own questions come back "unclear"
 * 6.1% of the time against 25.3% for the replayed run-15 corpus, and 63.9% of what it sees
 * scores valid. Two levers have failed against this seam: one conditioned on RECOGNISING an
 * answer (type-only, reach 9/1680 = 0.54%), one conditioned on nothing but an instruction
 * delivered verbatim into the prompt (spec-cited URLs, 2/20 vs 3/20, Fisher p = 0.50).
 *
 * So the remaining question is not "what was the last answer". It is: WHY does worker:apis
 * judge itself finished? Nothing currently records what the research trajectory LOOKS LIKE at
 * the moment it stops, or how that trajectory relates to the section the worker then emits.
 * This harness records both.
 *
 * ── THE THREE MEASUREMENTS, and what each one can refute ──────────────────────────────────
 *
 *  (a) TRAJECTORY — the full ordered tool-call sequence per rep. Read off the two channels
 *      that already exist: phaseResearch's own trial log (`worker:apis: <tool>: <arg>`, every
 *      tool, in order) and the PI_TASK_TYPEONLY_LOG sink (verbatim query, prose answer, and —
 *      newly — the tool's whole return text). No third channel is introduced.
 *
 *  (b) COVERAGE — the APIS section the worker emitted, scored entry by entry for whether its
 *      symbols appear in anything the worker was GIVEN (its assembled prompt: orientation file
 *      dump, project inventory, FILES map, refined task) or RETRIEVED (docs answers, files it
 *      read). A worker that stops while its own output carries symbols it never looked up is
 *      stopping for a different reason than one whose output is fully covered. Grounding is a
 *      plain case-sensitive substring test over the union of every channel, with no stop-list,
 *      so every ambiguity resolves toward GROUNDED and the ungrounded rate is a floor.
 *
 *  (c) SHAPE — does it stop after a run of successful lookups, on a plateau of repeats, or at
 *      a fixed budget? Recorded docs calls/rep have mean 9.6–18.1 and range 2–33 across runs,
 *      so a fixed-count ceiling is cheap to refute and is tested explicitly (dispersion and
 *      modal mass), alongside a near-repeat rate over the trajectory tail and a novelty curve
 *      (symbols an answer introduced that no earlier answer in the same rep carried).
 *
 * ── WHY THE PROMPT IS CAPTURED, AND WHY THAT IS NOT A STUB ────────────────────────────────
 *
 * (b) is a claim about what the worker had. The APIS worker is handed an orientation block
 * containing the FULL TEXT of the project's core files, plus the inventory and the finished
 * FILES map. Scoring grounding without that text would count symbols the worker was literally
 * handed as "from memory" — the exact over-claim this file exists to prevent. So a private
 * dist copy is patched with ONE observation-only edit that appends each assembled worker
 * prompt to disk; it is the same anchor scripts/spec-url-prompt-delivery-check.ts uses, and it
 * is asserted to occur exactly once. Nothing about worker behaviour is replaced: the model,
 * the tools, and the network are the shipped ones.
 *
 * ── HONEST LIMITS ─────────────────────────────────────────────────────────────────────────
 *
 *  - The sink records a docs answer only on the tool's success path, so sink rows <= docs call
 *    lines is expected; the invariant is that it observed most of them.
 *  - `grep` results are not captured, only the path grepped. The file's contents are read back
 *    from the preserved trial tree instead, which is a superset of what any grep returned —
 *    again biased toward GROUNDED.
 *  - Under parallel tool calls the final batch's internal completion order is arbitrary, so
 *    tail statistics are reported over the last three calls, never one.
 *
 * ENVIRONMENT (record it when quoting any number this prints)
 *   model    Qwen3.6-27B-NVFP4-MTP.gguf via llama-server @ 127.0.0.1:8080
 *   launcher ~/hub/qwen/run-Q3.6-27B.sh — that script, never a hand-rolled invocation: a
 *            sub-default batch (-b 512 -ub 256) corrupts large parallel tool calls.
 *   fixtures scripts/spec-url-fixtures.ts — task27-hono and task28-wouter, real run-15 tasks
 *            replayed on their own `chore: checkpoint before …` trees.
 *
 * Run (`bun run build` first — this imports from a patched copy of dist/):
 *   PI_BIN=$(command -v pi) bun run scripts/live-apis-stopping-point.ts [REPS_PER_FIXTURE]
 * Re-score a completed run offline, no model time:
 *   STOP_DIR=~/tmp/apis-stopping-point bun run scripts/live-apis-stopping-point.ts
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
import {reportArm, type Invariant} from './ab-verdict.js'
import {buildPatchedDist} from './spec-url-dist.js'
import {FIXTURES, buildFixtureTree} from './spec-url-fixtures.js'
import {
    parseTrajectory,
    stepModule,
    extractSection,
    parseApisEntries,
    groundEntries,
    readTouchedFiles,
    repeatFlags,
    noveltyCurve,
    classifyQuery,
    mean,
    sd,
    type Step,
    type Channel,
    type GroundingCorpus
} from './apis-trajectory.js'
import {requirePreconditions} from './ab-preflight.js'

const REPS_PER_FIXTURE = Number(process.argv[2] ?? '8')
/**
 * `||` and not `??`, and resolved to an ABSOLUTE path, for two reasons a smoke run found the
 * hard way. `STOP_DIR=` (set but empty) is not nullish, so `??` left ROOT as the empty string;
 * every trial tree was then created relative to the repo working directory. Worse, the sink
 * path handed to the child was relative too, and the child's cwd is the trial tree — so the
 * shipped instrumentation wrote to a path one level deeper and the run recorded ZERO answers
 * against 16 docs calls. It still printed a full report. The invariants caught it; the
 * defaults now make it unreachable.
 */
const ROOT = path.resolve(
    process.env.STOP_DIR || path.join(os.homedir(), 'tmp', 'apis-stopping-point')
)
const TRIAL_TIMEOUT_MS = 45 * 60_000
/** Read by the patched dist at prompt-assembly time, so one patched copy serves every rep. */
const PROMPT_DUMP_ENV = 'PI_TASK_PROMPT_DUMP'

interface Rep {
    fixture: string
    rep: number
    trialDir: string
    /** Ordered tool calls, from the trial log. */
    steps: Step[]
    /** Every docs answer, from the shipped sink. */
    answers: TypeOnlyLogRecord[]
    /** The APIS section phaseResearch returned. */
    apisSection: string
    /** The assembled worker:apis prompt, from the observation patch. */
    apisPrompt: string
    minutes: number
    error?: string
}

const pct = (a: number, b: number): string => (b === 0 ? '  n/a' : `${((100 * a) / b).toFixed(1)}%`)

// ─── running ─────────────────────────────────────────────────────────────────

async function runReps(): Promise<Rep[]> {
    await requirePreconditions('live-apis-stopping-point', {model: {}, piBin: true, cacheOff: true})
    // ONE observation-only edit, asserted exactly-once by buildPatchedDist. Without the
    // assertion a silently-missed anchor would leave every rep with an empty prompt and every
    // symbol scored ungrounded — a fabricated finding, which is worse than no finding.
    const dist = buildPatchedDist('apis-stopping-point', [
        {
            file: 'task/phases.js',
            // Anchored on the `basePrompt` binding — runSpec assembles worker:apis's prompt once
            // there, then reuses it for the zero-retrieval gate retry (was: the inline `prompt:`
            // property, removed when that retry was introduced).
            find: "        const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt;",
            replace:
                '        const basePrompt = (p => { try { const s = process.env['
                + JSON.stringify(PROMPT_DUMP_ENV)
                + "]; if (s) require('node:fs').appendFileSync(s, '\\n===== ' + spec.label"
                + " + ' =====\\n' + p) } catch {} return p })"
                + "(typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt);",
            label: 'dump every assembled worker prompt (observation only)'
        }
    ])
    const {phaseResearch} = (await import(path.join(dist, 'task', 'phases.js'))) as typeof import(
        '../dist/task/phases.js'
    )

    console.log(
        'live-apis-stopping-point — model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080\n'
            + `real phaseResearch, NOTHING stubbed, ${REPS_PER_FIXTURE} reps x ${FIXTURES.length} fixtures\n`
            + `answers via ${TYPEONLY_LOG_ENV}, prompts via ${PROMPT_DUMP_ENV}, into ${ROOT}`
    )

    const reps: Rep[] = []
    for (let t = 1; t <= REPS_PER_FIXTURE; t++) {
        // Fixtures INTERLEAVED, not run one after the other: a drift in the machine (thermal,
        // another process, a server restart) then lands on both fixtures alike instead of on
        // whichever one happened to run second.
        for (const f of FIXTURES) {
            // Absolute, always: both paths are read by code running inside the pi child,
            // whose cwd is the trial tree, not this process's.
            const dir = path.resolve(buildFixtureTree(ROOT, f, t))
            const sink = path.join(dir, 'answers.jsonl')
            const dump = path.join(dir, 'prompts.txt')
            fs.rmSync(sink, {force: true})
            fs.rmSync(dump, {force: true})
            process.env[TYPEONLY_LOG_ENV] = sink
            process.env[PROMPT_DUMP_ENV] = dump

            const abort = new AbortController()
            const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
            const logPath = path.join(dir, 'trial.log')
            const started = Date.now()
            let research = ''
            let error: string | undefined
            try {
                research = await phaseResearch(
                    {
                        cwd: dir,
                        taskId: f.taskId,
                        signal: abort.signal,
                        onChildOutput: l => fs.appendFileSync(logPath, l + '\n'),
                        logDebug: m => fs.appendFileSync(logPath, `[debug] ${m}\n`)
                    },
                    f.refined
                )
            } catch (e) {
                error = String(e).slice(0, 200)
            } finally {
                clearTimeout(timer)
            }
            const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
            const rep: Rep = {
                fixture: f.name,
                rep: t,
                trialDir: dir,
                steps: parseTrajectory(read(logPath)),
                answers: readTypeOnlyLog(read(sink)),
                apisSection: extractSection(research, 'APIS'),
                apisPrompt:
                    read(dump)
                        .split('===== ')
                        .find(s => s.startsWith('worker:apis')) ?? '',
                minutes: (Date.now() - started) / 60000,
                ...(error ? {error} : {})
            }
            reps.push(rep)
            const docs = rep.steps.filter(s => s.tool === 'pi-worker-docs').length
            const esc = rep.steps.filter(s => /pi-worker-(search|fetch)/.test(s.tool)).length
            console.log(
                `  ${f.name} rep ${t}/${REPS_PER_FIXTURE}: docs=${docs} escalations=${esc} `
                    + `answers=${rep.answers.length} apis-entries=${parseApisEntries(rep.apisSection).length} `
                    + `prompt=${rep.apisPrompt.length}c [${rep.minutes.toFixed(1)}m]`
                    + (error ? `  ERROR ${error}` : '')
            )
            // Persisted after EVERY rep so a crash at rep 15 does not throw away reps 1-14.
            fs.writeFileSync(path.join(ROOT, 'stopping-point.json'), JSON.stringify(reps), 'utf8')
        }
    }
    return reps
}

function loadReps(): Rep[] {
    const saved = path.join(ROOT, 'stopping-point.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: STOP_DIR set but ${saved} does not exist.`)
        process.exit(1)
    }
    console.log(`live-apis-stopping-point — RE-SCORING ${saved} (no model time)`)
    return JSON.parse(fs.readFileSync(saved, 'utf8')) as Rep[]
}

// ─── scoring ─────────────────────────────────────────────────────────────────

const docsSteps = (r: Rep): Step[] => r.steps.filter(s => s.tool === 'pi-worker-docs')
const escalations = (r: Rep): number =>
    r.steps.filter(s => s.tool === 'pi-worker-search' || s.tool === 'pi-worker-fetch').length

function corpusOf(r: Rep): GroundingCorpus {
    const join = (rs: TypeOnlyLogRecord[]): string =>
        rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt: r.apisPrompt,
        docsProject: join(r.answers.filter(a => a.module === '.')),
        docsPackage: join(r.answers.filter(a => a.module !== '.')),
        reads: fs.existsSync(r.trialDir) ? readTouchedFiles(r.trialDir, r.steps) : ''
    }
}

function main(reps: Rep[]): void {
    // A rep that never called docs did not accept an answer and stop — it wrote the section
    // from memory. Already recorded as a DIFFERENT failure (3 of ~18 reps), and folded in it
    // would attribute a memory-written section to answers that were never fetched.
    const consulted = reps.filter(r => docsSteps(r).length > 0)
    const terminated = consulted.filter(r => escalations(r) === 0)
    const escalated = consulted.filter(r => escalations(r) > 0)

    console.log(`\n=== POPULATIONS (${reps.length} reps) ===`)
    for (const f of [...FIXTURES.map(x => x.name), 'POOLED']) {
        const rs = f === 'POOLED' ? reps : reps.filter(r => r.fixture === f)
        const c = rs.filter(r => docsSteps(r).length > 0)
        const term = c.filter(r => escalations(r) === 0)
        console.log(
            `  ${f.padEnd(14)} reps ${String(rs.length).padStart(2)}   consulted docs ${String(c.length).padStart(2)}`
                + `   terminated ${String(term.length).padStart(2)} (${pct(term.length, c.length)})`
                + `   escalated ${c.length - term.length}   zero-docs ${rs.length - c.length}`
        )
    }
    const errored = reps.filter(r => r.error)
    if (errored.length > 0) {
        console.log(`  reps that threw ${errored.length}: ${errored.map(r => r.error).join(' | ')}`)
    }

    // ── (a) TRAJECTORY ───────────────────────────────────────────────────────
    console.log(`\n=== (a) TRAJECTORY CENSUS ===`)
    const tools = new Map<string, number>()
    for (const r of reps) for (const s of r.steps) tools.set(s.tool, (tools.get(s.tool) ?? 0) + 1)
    console.log(
        `  tool calls over all reps: `
            + [...tools.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([t, n]) => `${t}=${n}`)
                .join('  ')
    )
    // The LAST three tool calls before the worker wrote its section. If the worker were
    // stalling on a failed external lookup, the tail would be package-heavy and answer-poor.
    const tail: string[] = []
    for (const r of terminated) {
        const upto = r.steps.filter(s => s.arg.length > 0)
        tail.push(
            upto
                .slice(-3)
                .map(s => (s.tool === 'pi-worker-docs' ? `docs(${stepModule(s)})` : s.tool))
                .join(' → ')
        )
    }
    const tailCounts = new Map<string, number>()
    for (const t of tail) tailCounts.set(t, (tailCounts.get(t) ?? 0) + 1)
    console.log(`  last 3 calls of each TERMINATED rep (${tail.length} reps):`)
    for (const [t, n] of [...tailCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
        console.log(`    ${String(n).padStart(2)}x  ${t}`)
    }

    // ── (b) COVERAGE ─────────────────────────────────────────────────────────
    console.log(`\n=== (b) COVERAGE — is the section it stopped to write actually grounded? ===`)
    console.log(
        `  GROUNDED = the symbol appears in the worker's own prompt (orientation dump,\n`
            + `  inventory, FILES map, refined task), in a docs answer, or in a file it read.\n`
            + `  Case-sensitive substring, union of every channel, no stop-list ⇒ the ungrounded\n`
            + `  rate below is a FLOOR.`
    )
    interface Cov {
        rep: Rep
        entries: number
        symbols: number
        ungroundedSymbols: number
        ungroundedEntries: number
        channels: Map<Channel, number>
        examples: string[]
    }
    const covs: Cov[] = consulted.map(rep => {
        const c = corpusOf(rep)
        const grounded = groundEntries(parseApisEntries(rep.apisSection), c)
        const channels = new Map<Channel, number>()
        let symbols = 0
        let ungroundedSymbols = 0
        const examples: string[] = []
        for (const g of grounded) {
            symbols += g.entry.symbols.length
            ungroundedSymbols += g.ungrounded.length
            for (const ch of g.channels) channels.set(ch, (channels.get(ch) ?? 0) + 1)
            if (g.ungrounded.length > 0) examples.push(`${g.entry.name} [${g.ungrounded.join(',')}]`)
        }
        return {
            rep,
            entries: grounded.length,
            symbols,
            ungroundedSymbols,
            ungroundedEntries: grounded.filter(g => g.ungrounded.length > 0).length,
            channels,
            examples
        }
    })
    const sum = (f: (c: Cov) => number): number => covs.reduce((a, c) => a + f(c), 0)
    console.log(
        `  entries/rep      mean ${mean(covs.map(c => c.entries)).toFixed(1)}`
            + `  range ${Math.min(...covs.map(c => c.entries))}-${Math.max(...covs.map(c => c.entries))}`
    )
    console.log(
        `  symbols          ${sum(c => c.symbols)} total, `
            + `${sum(c => c.ungroundedSymbols)} ungrounded = ${pct(sum(c => c.ungroundedSymbols), sum(c => c.symbols))}`
    )
    console.log(
        `  entries with >=1 ungrounded symbol   ${sum(c => c.ungroundedEntries)}/${sum(c => c.entries)}`
            + ` = ${pct(
                sum(c => c.ungroundedEntries),
                sum(c => c.entries)
            )}`
    )
    const repsWithUngrounded = covs.filter(c => c.ungroundedEntries > 0).length
    console.log(
        `  REPS whose emitted section carries >=1 ungrounded entry   `
            + `${repsWithUngrounded}/${covs.length} = ${pct(repsWithUngrounded, covs.length)}`
    )
    const chanTotals = new Map<Channel, number>()
    for (const c of covs) {
        for (const [k, v] of c.channels) chanTotals.set(k, (chanTotals.get(k) ?? 0) + v)
    }
    console.log(
        `  entries by grounding channel (an entry can have several): `
            + [...chanTotals.entries()].map(([k, v]) => `${k}=${v}`).join('  ')
    )
    console.log(`  sample ungrounded entries:`)
    for (const c of covs.slice(0, 6)) {
        for (const e of c.examples.slice(0, 2)) {
            console.log(`    ${c.rep.fixture} rep ${c.rep.rep}: ${e.slice(0, 110)}`)
        }
    }

    // ── is the trajectory a CHECKLIST over the output, or exploration? ───────
    // Two directions of the same correspondence, and they mean different things:
    //   YIELD    lookups whose subject reaches the emitted section. Low ⇒ the worker explored
    //            and threw most of it away, so the section is not what drove the trajectory.
    //   REACHED  entries whose symbol was itself ASKED ABOUT in some docs query. High ⇒ the
    //            worker looked up the very things it went on to write, i.e. it was working a
    //            list, and stopping means the list was covered.
    // The two are not redundant: a worker could look up everything it writes AND write a lot
    // it never looked up, or the reverse.
    let lookups = 0
    let lookupsUsed = 0
    let entriesTotal = 0
    let entriesAsked = 0
    let entriesPromptOnly = 0
    let entriesOpen = 0
    let entriesOpenStrict = 0
    for (const r of consulted) {
        const section = r.apisSection
        for (const a of r.answers) {
            lookups++
            const syms = (a.query.match(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g) ?? []).filter(s =>
                section.includes(s)
            )
            if (syms.length > 0) lookupsUsed++
        }
        const queries = r.answers.map(a => a.query).join('\n')
        // An answer the worker itself flagged as a non-answer. Two readings, and only the
        // STRICT one is evidence of stopping-with-a-gap:
        //   loose   the section carries the subject of an unanswered question at all. Most of
        //           those subjects were answered by some OTHER lookup, so this over-counts.
        //   strict  the subject appears in NO answered docs answer either — the worker asked,
        //           was told nothing, and wrote the entry regardless. That is the F-1/F-2 shape.
        // Reporting only the loose number would have claimed a gap rate ~20x the real one.
        const openText = r.answers
            .filter(a => a.unclear || a.typeOnly)
            .map(a => a.query)
            .join('\n')
        const answeredText = r.answers
            .filter(a => !a.unclear && !a.typeOnly)
            .map(a => `${a.toolText ?? ''}\n${a.answer}`)
            .join('\n')
        const grounded = groundEntries(parseApisEntries(section), corpusOf(r))
        for (const g of grounded) {
            entriesTotal++
            if (g.entry.symbols.some(s => queries.includes(s))) entriesAsked++
            if (g.channels.length === 1 && g.channels[0] === 'prompt') entriesPromptOnly++
            if (g.entry.symbols.some(s => openText.includes(s))) {
                entriesOpen++
                if (g.entry.symbols.some(s => openText.includes(s) && !answeredText.includes(s))) {
                    entriesOpenStrict++
                }
            }
        }
    }
    console.log(
        `  LOOKUP YIELD  — docs answers whose query names a token that reaches the section: `
            + `${lookupsUsed}/${lookups} = ${pct(lookupsUsed, lookups)}`
    )
    console.log(
        `  ENTRY REACHED — APIS entries whose own symbol was asked about in some docs query: `
            + `${entriesAsked}/${entriesTotal} = ${pct(entriesAsked, entriesTotal)}`
    )
    console.log(
        `  PROMPT-ONLY   — entries grounded ONLY by the text the worker was handed (task,\n`
            + `                  inventory, FILES map, orientation dump) and never looked up or read: `
            + `${entriesPromptOnly}/${entriesTotal} = ${pct(entriesPromptOnly, entriesTotal)}`
    )
    console.log(
        `  OPEN-GAP loose  — entries whose symbol was the subject of a question the worker's own\n`
            + `                  tool answered "unclear"/type-only, emitted anyway: `
            + `${entriesOpen}/${entriesTotal} = ${pct(entriesOpen, entriesTotal)}`
    )
    console.log(
        `  OPEN-GAP STRICT — the same, and the symbol appears in NO answered docs answer either\n`
            + `                  (asked, told nothing, written down regardless): `
            + `${entriesOpenStrict}/${entriesTotal} = ${pct(entriesOpenStrict, entriesTotal)}`
    )

    // ── (c) SHAPE ────────────────────────────────────────────────────────────
    console.log(`\n=== (c) SHAPE — budget, plateau, or saturation? ===`)
    const counts = consulted.map(r => docsSteps(r).length)
    const m = mean(counts)
    const s = sd(counts)
    const modal = new Map<number, number>()
    for (const c of counts) modal.set(c, (modal.get(c) ?? 0) + 1)
    const topMode = [...modal.entries()].sort((a, b) => b[1] - a[1])[0]
    console.log(
        `  docs calls/rep   mean ${m.toFixed(1)}  sd ${s.toFixed(1)}  cv ${(s / m).toFixed(2)}`
            + `  range ${Math.min(...counts)}-${Math.max(...counts)}`
    )
    console.log(
        `  FIXED-BUDGET TEST: modal count ${topMode[0]} occurs ${topMode[1]}/${counts.length} reps`
            + ` (${pct(topMode[1], counts.length)}). A ceiling would pile reps on one value;`
            + ` cv >= 0.3 is a spread, not a cap.`
    )
    console.log(
        `  total tool calls/rep  mean `
            + mean(consulted.map(r => r.steps.filter(x => x.arg.length > 0).length)).toFixed(1)
    )

    const allFlags: boolean[] = []
    const tailFlags: boolean[] = []
    for (const r of consulted) {
        const calls = r.answers.map(a => ({module: a.module, query: a.query}))
        const flags = repeatFlags(calls)
        allFlags.push(...flags)
        tailFlags.push(...flags.slice(-3))
    }
    console.log(
        `  PLATEAU TEST: near-repeat docs calls (same module, query Jaccard >= 0.6)\n`
            + `    over the whole trajectory  ${allFlags.filter(Boolean).length}/${allFlags.length}`
            + ` = ${pct(allFlags.filter(Boolean).length, allFlags.length)}\n`
            + `    over the LAST 3 calls      ${tailFlags.filter(Boolean).length}/${tailFlags.length}`
            + ` = ${pct(tailFlags.filter(Boolean).length, tailFlags.length)}`
            + `   <- a worker stopping on saturation repeats itself at the end`
    )

    // Novelty: symbols an answer introduced that no earlier answer in the same rep carried.
    // Normalised into thirds so reps of different lengths are comparable.
    const thirds: [number[], number[], number[]] = [[], [], []]
    const lastNovelty: number[] = []
    for (const r of consulted) {
        const curve = noveltyCurve(r.answers.map(a => a.toolText ?? a.answer))
        if (curve.length === 0) continue
        curve.forEach((v, i) => thirds[Math.min(2, Math.floor((3 * i) / curve.length))].push(v))
        lastNovelty.push(curve[curve.length - 1])
    }
    // What KIND of question the worker asks. The APIS output contract is `<name>  <one-line
    // signature or use>` — a signature list. If the questions are overwhelmingly signature
    // questions, the research is an enumeration of that format and the variable governing when
    // it stops is the FORMAT, not any property of the answers. Predicates fixed against the
    // 2-rep smoke run before this run was scored; see apis-trajectory.ts.
    const kinds = new Map<string, number>()
    const lastKinds = new Map<string, number>()
    const pkgKinds = new Map<string, number>()
    for (const r of consulted) {
        for (const a of r.answers) {
            const k = classifyQuery(a.query)
            kinds.set(k, (kinds.get(k) ?? 0) + 1)
            // Split out separately because escalating to the web is only ever APPLICABLE to a
            // package question. A behaviour rate diluted by project-source lookups would
            // understate the one denominator a documentation lever could act on.
            if (a.module !== '.') pkgKinds.set(k, (pkgKinds.get(k) ?? 0) + 1)
        }
        for (const a of r.answers.slice(-3)) {
            const k = classifyQuery(a.query)
            lastKinds.set(k, (lastKinds.get(k) ?? 0) + 1)
        }
    }
    const kindRow = (byKind: Map<string, number>): string => {
        const n = [...byKind.values()].reduce((a, b) => a + b, 0)
        return ['signature-only', 'behaviour', 'neither']
            .map(k => `${k} ${byKind.get(k) ?? 0} (${pct(byKind.get(k) ?? 0, n)})`)
            .join('   ')
    }
    console.log(
        `  QUESTION KIND — the output contract is "<name>  <one-line signature or use>"\n`
            + `    all docs queries    ${kindRow(kinds)}\n`
            + `    PACKAGE queries     ${kindRow(pkgKinds)}   <- the only ones the web could serve\n`
            + `    last 3 of each rep  ${kindRow(lastKinds)}`
    )

    console.log(
        `  SATURATION TEST: new symbols per answer, by trajectory third\n`
            + `    first ${mean(thirds[0]).toFixed(0)}   middle ${mean(thirds[1]).toFixed(0)}`
            + `   last ${mean(thirds[2]).toFixed(0)}   final answer ${mean(lastNovelty).toFixed(0)}`
            + `\n    a worker stopping because nothing new was coming back would end near 0.`
    )

    console.log(`\n  raw data: ${path.join(ROOT, 'stopping-point.json')} + per-rep trial trees`)

    // ── invariants ───────────────────────────────────────────────────────────
    const docsLines = reps.reduce((a, r) => a + docsSteps(r).length, 0)
    const answerRows = reps.reduce((a, r) => a + r.answers.length, 0)
    const withText = reps.reduce(
        (a, r) => a + r.answers.filter(x => (x.toolText ?? '').length > 0).length,
        0
    )
    const invariants: Invariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first rep answers)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            label: 'reps >= 12 across BOTH fixtures — the floor this stage was specified at',
            ok: reps.length >= 12 && new Set(reps.map(r => r.fixture)).size === FIXTURES.length,
            detail: `${reps.length} reps over ${new Set(reps.map(r => r.fixture)).size} fixture(s)`
        },
        {
            label: 'the answer sink observed the docs calls it could (success path only)',
            ok: docsLines > 0 && answerRows >= docsLines * 0.8 && answerRows <= docsLines,
            detail: `${answerRows} answers / ${docsLines} docs call lines`
        },
        {
            // Without this the grounding corpus silently loses its largest channel and every
            // symbol scores ungrounded — a fabricated finding shaped exactly like a real one.
            label: 'OBSERVATION CHECK: every rep captured a non-empty worker:apis prompt',
            ok: reps.every(r => r.apisPrompt.length > 1000),
            detail: `${reps.filter(r => r.apisPrompt.length > 1000).length}/${reps.length} reps`
        },
        {
            label: 'the extended sink carried the tool return text it was extended to carry',
            ok: answerRows > 0 && withText >= answerRows * 0.95,
            detail: `${withText}/${answerRows} rows with toolText`
        },
        {
            label: 'every rep that consulted docs emitted a non-empty APIS section to score',
            ok: consulted.every(r => parseApisEntries(r.apisSection).length > 0),
            detail: `${consulted.filter(r => parseApisEntries(r.apisSection).length === 0).length} empty`
        }
    ]

    reportArm({
        name: 'live-apis-stopping-point',
        arm: 'shipped/phaseResearch (STAGE 1 diagnostic, no lever)',
        reps: consulted.length,
        targetShape:
            'worker:apis TERMINATING without ever calling search or fetch, with its full tool '
            + 'trajectory, the grounding of the APIS section it then emitted, and the shape of '
            + 'that trajectory recorded. This is a DIAGNOSTIC census, not a lever test. An '
            + 'ABSTAIN (no rep consulted docs) means the population was not reproduced on these '
            + 'fixtures and nothing below may be read.',
        hits: terminated.length,
        witnessed: consulted.length,
        expect: 'some',
        invariants
    })
    console.log(
        `\n  escalated reps: ${escalated.length}/${consulted.length} — `
            + (escalated.length < 3 ?
                'too few to compare terminated against escalated. Any difference between the '
                + 'two groups read off this run would be one or two reps wearing a percentage, '
                + 'and none is reported above.'
            :   'enough to compare the two groups.')
    )
}

if (process.env.STOP_DIR) {
    main(loadReps())
} else {
    runReps()
        .then(main)
        .catch(e => {
            console.error(e)
            process.exit(1)
        })
}
