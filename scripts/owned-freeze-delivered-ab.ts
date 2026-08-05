/**
 * A/B-2 (live, the DELIVERED spec) for nexttask 2 — when the detach/claim pass
 * moves the §9 Build & run server clause onto the task that actually writes
 * `src/server/index.ts`, does that task's spec end up OBSERVING static asset
 * serving?
 *
 * This is the delivery half. A/B-1 proves the bookkeeping is sound (no quote
 * lost, no new conflict, idempotent); it cannot prove the moved clause changes
 * what gets specced. The run-18 lever passed its pair metric and failed exactly
 * here — the delivered VERIFY still grepped `package.json`, 6/20 in BOTH arms.
 *
 * ARMS. Both run the REAL pipeline (phaseCompose → phaseCritique →
 * appendOwnedConstraints) on the real run-19 inputs for the task that writes the
 * server file. They differ ONLY in the fixture's `requirements-owned.md`, which
 * is the single artifact the pass edits — so both the belt
 * (`buildOwnedRequirementsBlock` inside compose) and the braces see the arm:
 *
 *   baseline    the ledger run 19 actually produced — the clause is owned by
 *               TASK_0015 (Build tooling), which may not touch the server file
 *   treatment   the ledger after DETACH (on TASK_0015's own recorded spec) and
 *               CLAIM (from TASK_0017's own recorded refined prompt) — the
 *               clause is owned by TASK_0017, which writes the server file
 *
 * TASK_0017, not TASK_0014. nexttask2.md nominates TASK_0014 as the target. STEP
 * 0 refutes it twice over: TASK_0014 ran to completion BEFORE TASK_0015, so a
 * ledger edit naming it is never read again; and at detach time the pending
 * tasks are bare plan titles, none of which contains the path — the claim can
 * only be made later, by the task whose refined prompt says it writes the file.
 *
 * PRE-REGISTERED METRIC (M1, deterministic, scored on the delivered spec's
 * ACCEPTANCE and VERIFY blocks only): a line that OBSERVES static asset
 * serving — a request against the running server for a BUILT asset, checked to
 * come back as that asset rather than as `index.html`. `scoreStaticObservation`
 * is the published implementation; every spec is written to disk verbatim so
 * the metric can be re-scored offline without re-spending model time.
 *
 *   PASS   treatment >= 14/20 and baseline <= 4/20, one-sided p < 0.05,
 *          AND inv-no-requirement-loss holds in all 40 specs
 *   FAIL   anything else — both proportions reported
 *
 * A treatment spec that carries the clause but still verifies it by grepping
 * `package.json` scores 0 here. That is the run-18 outcome and it must FAIL.
 *
 * Usage:
 *   PI_BIN=$(command -v pi) bun run scripts/owned-freeze-delivered-ab.ts <arm> [TRIALS]
 *   bun run scripts/owned-freeze-delivered-ab.ts compare
 * Raw: ~/tmp/owned-freeze-delivered/<arm>.jsonl + per-trial spec files.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {phaseCompose, phaseCritique} from '../src/task/phases.js'
import {reportArm} from './ab-verdict.js'
import type {PhaseDeps} from '../src/task/child-runner.js'
import {
    appendOwnedConstraints,
    ownedForTitle,
    parseOwnedRequirements,
    type OwnedRequirement
} from '../src/task/requirements.js'
import {
    detachUnsatisfiableRequirements,
    claimPendingRequirements
} from '../src/task/owned-freeze-reassign.js'
import {trackedSourceOracle} from '../src/task/owned-freeze-conflict.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')
const ROOT = path.join(os.homedir(), 'tmp', 'owned-freeze-delivered')
/** mx5 `chore: checkpoint before "Client API layer …"` — the tree TASK_0017 was
 *  composed against. */
const PRE_TASK_COMMIT = 'f55ee76'
/** The task that WRITES `src/server/index.ts` and is still pending when the
 *  conflict is detected. */
const TASK = 'TASK_0017'
/** The task the conflict fires on (the clause's recorded owner). */
const CONFLICT_TASK = 'TASK_0015'
const TARGET_QUOTE = 'serves `/api` + static `dist/`'
const TRIAL_TIMEOUT_MS = 30 * 60_000
const FIXTURE_PATHS = [
    'package.json',
    'tsconfig.json',
    'eslint.config.js',
    '.prettierrc.cjs',
    'build.ts',
    'docker-compose.dev.yml',
    '.env.example',
    'src',
    'DESIGN'
]

type Mode = 'baseline' | 'treatment'
const MODES: Mode[] = ['baseline', 'treatment']

function git(args: string[], cwd: string): {stdout: string; exitCode: number} {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
    return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
}

function section(md: string, name: string): string {
    const re = new RegExp(String.raw`^##\s+${name}\s*$`, 'im')
    const m = re.exec(md)
    if (!m) throw new Error(`section "${name}" not found`)
    const rest = md.slice(m.index + m[0].length)
    const next = /^##\s+/m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

const taskDoc = (id: string): string =>
    fs.readFileSync(path.join(MX5, '.pi-tasks', `${id}.md`), 'utf8')

// ─── Recorded run-19 inputs ─────────────────────────────────────────────────

if (!fs.existsSync(path.join(MX5, '.pi-tasks', `${TASK}.md`))) {
    console.error(`ABSTAIN: evidence tree missing (${MX5}); set MX5_DIR.`)
    process.exit(2)
}
const RECORDED = taskDoc(TASK)
const RAW_PROMPT = section(RECORDED, 'raw prompt')
const REFINED = section(RECORDED, 'refined prompt').replace(/^[\s\S]*?(?=^GOAL$)/m, '')
const RESEARCH = section(RECORDED, 'research')
const QA = section(RECORDED, 'grill Q&A')
const LEDGER_TEXT = fs.readFileSync(path.join(MX5, '.pi-tasks', 'requirements-owned.md'), 'utf8')
const BASE_LEDGER = parseOwnedRequirements(LEDGER_TEXT)

/**
 * The treatment ledger: the recorded one, run through BOTH halves of the pass —
 * detach on the conflicting task's own recorded spec, then claim from this
 * task's own recorded refined prompt. Not hand-edited; the arm IS the mechanism.
 */
function treatmentLedger(): OwnedRequirement[] {
    const spec = section(taskDoc(CONFLICT_TASK), 'spec')
    const conflictTitle = section(taskDoc(CONFLICT_TASK), 'raw prompt')
    const isSource = trackedSourceOracle(q => git(['ls-files', '--', q], MX5))
    const detached = detachUnsatisfiableRequirements({
        spec,
        title: conflictTitle,
        ledger: BASE_LEDGER,
        isSource
    })
    if (!detached.actions.some(a => a.kind === 'detach' && a.quote.includes(TARGET_QUOTE))) {
        throw new Error(`the pass did not detach the target clause from ${CONFLICT_TASK}`)
    }
    const claimed = claimPendingRequirements({
        intent: REFINED,
        title: RAW_PROMPT,
        ledger: detached.ledger
    })
    if (!claimed.actions.some(a => a.kind === 'claim' && a.quote.includes(TARGET_QUOTE))) {
        throw new Error(`${TASK} did not claim the clause — fixture cannot discriminate`)
    }
    return claimed.ledger
}

function ledgerText(owned: OwnedRequirement[]): string {
    return (
        owned
            .map(
                o =>
                    `OWNED: "${o.quote}"${o.anchor ? ` [anchor: ${o.anchor}]` : ''}`
                    + (o.pending && o.pending.length > 0 ? ` [pending: ${o.pending.join(', ')}]` : '')
                    + ` [title: ${o.title.replace(/\n/g, ' ')}]`
            )
            .join('\n') + '\n'
    )
}

// ─── Scoring ────────────────────────────────────────────────────────────────

function blockOf(spec: string, name: 'ACCEPTANCE' | 'VERIFY'): string {
    const m = new RegExp(String.raw`^${name}\b[ \t]*:?[ \t]*$`, 'm').exec(spec)
    if (!m) return ''
    const rest = spec.slice(m.index + m[0].length)
    const next = /^(?:GOAL|CONSTRAINTS|ACCEPTANCE|VERIFY|KNOWN-UNKNOWNS)\b/m.exec(rest)
    return next ? rest.slice(0, next.index) : rest
}

/** A request against a running server. */
const REQUEST_RE = /\b(?:curl|wget|fetch\(|http:\/\/|https:\/\/|GET\s+\/|request(?:s|ed)?\s+(?:for\s+)?\/)/i
/** A BUILT asset — the thing the clause says the server must serve. `index.html`
 *  alone is the SPA fallback, which run 19 already had and which is exactly what
 *  the catch-all wrongly returned for every path. */
const BUILT_ASSET_RE = /\b(?:dist\/[\w.-]+|app\.css|main\.js|\/[\w.-]+\.(?:js|css|mjs|map))\b/i
/** The assertion half: the response must be checked to BE the asset. */
const ASSET_ASSERT_RE =
    /\b(?:content-type|text\/css|application\/javascript|javascript|css|not\s+(?:the\s+)?html|rather\s+than\s+(?:the\s+)?html|bytes|body\s+match|same\s+(?:content|bytes)|200)\b/i

/**
 * M1 — does an ACCEPTANCE or VERIFY line OBSERVE static asset serving?
 *
 * A line qualifies when it makes a request for a built asset AND asserts what
 * came back. A line whose only asset is `index.html` never qualifies: serving
 * the SPA shell for `/app.css` IS the defect this whole task is about.
 */
export function scoreStaticObservation(spec: string): {hit: boolean; line: string | null} {
    for (const block of ['ACCEPTANCE', 'VERIFY'] as const) {
        for (const raw of blockOf(spec, block).split('\n')) {
            const line = raw.trim()
            if (line.length === 0) continue
            if (!REQUEST_RE.test(line)) continue
            // The asset must survive removing every `index.html` mention: a line
            // whose only asset is the SPA shell is the fallback run 19 already
            // had, not static serving. A line that names a real asset AND
            // contrasts it with `index.html` ("returns the stylesheet, not the
            // SPA `index.html`") is exactly the observation wanted, so the
            // mention alone can never disqualify it.
            const withoutShell = line.replace(/\bdist\/index\.html\b|\bindex\.html\b/gi, ' ')
            if (!BUILT_ASSET_RE.test(withoutShell)) continue
            if (!ASSET_ASSERT_RE.test(line)) continue
            return {hit: true, line}
        }
    }
    return {hit: false, line: null}
}

/** M2 (secondary, weaker): the clause's BEHAVIOUR is stated anywhere in the
 *  spec's ACCEPTANCE — static serving named, however it is checked. */
function scoreBehaviourStated(spec: string): boolean {
    const acc = blockOf(spec, 'ACCEPTANCE')
    return /\bstatic\b/i.test(acc) && /\bdist\b/i.test(acc)
}

interface TrialResult {
    staticObservation: boolean
    observationLine: string | null
    behaviourStated: boolean
    clauseVerbatim: boolean
    specChars: number
    error?: string
}

// ─── Fixture ────────────────────────────────────────────────────────────────

function buildFixture(dir: string, owned: OwnedRequirement[]): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    const tar = spawnSync('git', ['archive', PRE_TASK_COMMIT, '--', ...FIXTURE_PATHS], {
        cwd: MX5,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer'
    })
    if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr?.toString().slice(0, 200)}`)
    const extract = spawnSync('tar', ['-x', '-C', dir], {
        input: tar.stdout,
        maxBuffer: 512 * 1024 * 1024
    })
    if (extract.status !== 0) throw new Error('tar extract failed')
    const tasks = path.join(dir, '.pi-tasks')
    fs.mkdirSync(tasks, {recursive: true})
    fs.writeFileSync(path.join(tasks, 'requirements-owned.md'), ledgerText(owned))
    fs.writeFileSync(
        path.join(tasks, 'TASK_AB.md'),
        [
            '---',
            'id: TASK_AB',
            'state: in_progress',
            'phase: compose',
            'created_at: 2026-08-04T14:48:57.076Z',
            'updated_at: 2026-08-04T14:48:57.076Z',
            `title: ${RAW_PROMPT.split('\n')[0]}`,
            '---',
            '',
            '## raw prompt',
            '',
            RAW_PROMPT,
            ''
        ].join('\n')
    )
    git(['init', '-q'], dir)
    git(['add', '-A', '--', ...FIXTURE_PATHS], dir)
}

// ─── Trial ──────────────────────────────────────────────────────────────────

async function runTrial(mode: Mode, n: number, owned: OwnedRequirement[]): Promise<TrialResult> {
    const dir = path.join(ROOT, `${mode}-t${n}`)
    buildFixture(dir, owned)
    const logPath = path.join(dir, 'trial.log')
    const log = (m: string): void => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
    const deps: PhaseDeps = {
        cwd: dir,
        taskId: 'TASK_AB',
        signal: abort.signal,
        onChildOutput: line => log(line),
        logDebug: msg => log(`[debug] ${msg}`)
    }
    try {
        log(`=== compose start (${mode} t${n}) ===`)
        const draft = await phaseCompose(deps, REFINED, RESEARCH, QA)
        const critiqued = await phaseCritique(deps, draft, REFINED, QA, undefined, RESEARCH, null)
        // The BRACES, exactly as phases.ts applies them after critique.
        const final = appendOwnedConstraints(critiqued, ownedForTitle(owned, RAW_PROMPT))
        fs.writeFileSync(path.join(ROOT, `${mode}-t${n}.spec.md`), final)
        const obs = scoreStaticObservation(final)
        log(`=== done — static observation: ${obs.hit} ===`)
        return {
            staticObservation: obs.hit,
            observationLine: obs.line,
            behaviourStated: scoreBehaviourStated(final),
            clauseVerbatim: final.includes(TARGET_QUOTE),
            specChars: final.length
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log(`=== TRIAL ERROR: ${msg} ===`)
        return {
            staticObservation: false,
            observationLine: null,
            behaviourStated: false,
            clauseVerbatim: false,
            specChars: 0,
            error: msg
        }
    } finally {
        clearTimeout(timer)
    }
}

// ─── Cross-arm comparison ───────────────────────────────────────────────────

interface Row extends TrialResult {
    trial: number
}

function readArm(mode: Mode): Row[] {
    const f = path.join(ROOT, `${mode}.jsonl`)
    if (!fs.existsSync(f)) return []
    return fs
        .readFileSync(f, 'utf8')
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l) as Row)
        .filter(r => !r.error)
}

/** One-sided Fisher exact: P(treatment >= observed | same rate). */
function fisherOneSided(a: number, b: number, c: number, d: number): number {
    const lg = (n: number): number => {
        let s = 0
        for (let i = 2; i <= n; i++) s += Math.log(i)
        return s
    }
    const p = (x: number): number =>
        Math.exp(
            lg(x + b) + lg(c + d) + lg(x + c) + lg(b + d)
                - lg(x + b + c + d) - lg(x) - lg(b) - lg(c) - lg(d)
        )
    // Hypergeometric tail over tables at least as extreme as (a,b,c,d).
    const n = a + b + c + d
    const row1 = a + b
    const col1 = a + c
    let tail = 0
    for (let x = a; x <= Math.min(row1, col1); x++) {
        const bb = row1 - x
        const cc = col1 - x
        const dd = n - x - bb - cc
        if (bb < 0 || cc < 0 || dd < 0) continue
        tail += p(x)
    }
    return Math.min(1, tail)
}

function compare(): boolean {
    const b = readArm('baseline')
    const t = readArm('treatment')
    if (b.length === 0 || t.length === 0) {
        console.log(`NO DATA (baseline ${b.length}, treatment ${t.length} scored trials)`)
        return false
    }
    const hb = b.filter(r => r.staticObservation).length
    const ht = t.filter(r => r.staticObservation).length
    const p = fisherOneSided(ht, t.length - ht, hb, b.length - hb)
    // The clause is only OWNED by this task in the treatment arm, so the
    // no-loss invariant is a statement about treatment specs. Scoring the
    // baseline against it reported "BROKEN 20/40" for the arm behaving exactly
    // as designed.
    const loss = t.filter(r => !r.clauseVerbatim)
    console.log(`\n=== A/B-2 delivered spec (${TASK}) ===`)
    console.log(`  M1 static-serving OBSERVED   baseline ${hb}/${b.length}   treatment ${ht}/${t.length}`)
    console.log(
        `  M2 behaviour stated          baseline ${b.filter(r => r.behaviourStated).length}/${b.length}`
        + `   treatment ${t.filter(r => r.behaviourStated).length}/${t.length}`
    )
    console.log(`  one-sided Fisher p           ${p.toFixed(4)}`)
    console.log(
        `  inv-no-requirement-loss      ${loss.length === 0 ? 'HOLDS' : `BROKEN in ${loss.length}/${b.length + t.length}`}`
        + '   (the clause verbatim in the delivered spec)'
    )
    const pass = ht >= 14 && hb <= 4 && p < 0.05 && loss.length === 0
    console.log(`\n  VERDICT ${pass ? 'PASS' : 'FAIL'}`)
    if (!pass) {
        console.log('  Pre-registered PASS: treatment >= 14/20, baseline <= 4/20, p < 0.05, no loss.')
    }
    for (const r of t.filter(x => x.staticObservation).slice(0, 3)) {
        console.log(`   treatment hit t${r.trial}: ${r.observationLine?.slice(0, 140)}`)
    }
    return pass
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (process.argv[2] === 'compare') {
        process.exit(compare() ? 0 : 1)
    }
    if (!process.env.PI_BIN) {
        console.error('FATAL: PI_BIN is not set — refusing to run (self-spawn fork-bomb guard).')
        process.exit(1)
    }
    const mode = process.argv[2] as Mode
    if (!MODES.includes(mode)) {
        console.error(
            'usage: PI_BIN=$(command -v pi) bun run scripts/owned-freeze-delivered-ab.ts '
                + '<baseline|treatment> [TRIALS]   |   compare'
        )
        process.exit(1)
    }
    const treat = treatmentLedger()
    const owned = mode === 'treatment' ? treat : BASE_LEDGER
    // The arms must actually differ where it matters, or nothing is measured.
    const mineBase = ownedForTitle(BASE_LEDGER, RAW_PROMPT)
    const mineTreat = ownedForTitle(treat, RAW_PROMPT)
    if (mineBase.some(o => o.quote.includes(TARGET_QUOTE))) {
        console.error('ABSTAIN: the baseline ledger already gives the clause to this task.')
        process.exit(2)
    }
    if (!mineTreat.some(o => o.quote.includes(TARGET_QUOTE))) {
        console.error('ABSTAIN: the treatment ledger does not give the clause to this task.')
        process.exit(2)
    }
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error('FATAL: llama-server @ 127.0.0.1:8080 not reachable.')
        process.exit(1)
    }

    const trials = parseInt(process.argv[3] ?? '20', 10)
    fs.mkdirSync(ROOT, {recursive: true})
    const jsonl = path.join(ROOT, `${mode}.jsonl`)
    fs.writeFileSync(jsonl, '')
    let hits = 0
    let stated = 0
    let lost = 0
    for (let t = 1; t <= trials; t++) {
        const r = await runTrial(mode, t, owned)
        fs.appendFileSync(jsonl, `${JSON.stringify({trial: t, ...r})}\n`)
        if (r.error) {
            console.log(`[${mode} t${t}] ERROR: ${r.error.slice(0, 160)}`)
            continue
        }
        if (r.staticObservation) hits++
        if (r.behaviourStated) stated++
        if (!r.clauseVerbatim) lost++
        console.log(
            `[${mode} t${t}] M1 static observed=${r.staticObservation}`
                + ` | M2 behaviour stated=${r.behaviourStated}`
                + ` | clause verbatim=${r.clauseVerbatim}`
                + (r.observationLine ? ` | ${r.observationLine.slice(0, 90)}` : '')
        )
    }
    console.log(`\n[${mode}] over ${trials} trials:  M1 ${hits}/${trials}   M2 ${stated}/${trials}`)
    console.log(`  raw: ${jsonl} — run \`compare\` once both arms are done.`)

    reportArm({
        name: 'owned-freeze-delivered-ab',
        arm: mode,
        reps: trials,
        targetShape:
            'a delivered spec whose ACCEPTANCE/VERIFY OBSERVES the server returning a built '
            + 'asset for a static request (not the SPA shell)',
        hits,
        witnessed: trials,
        expect: mode === 'baseline' ? 'none' : 'some',
        invariants: [
            {
                label: 'inv-no-requirement-loss: the clause is verbatim in every treatment spec',
                ok: mode === 'baseline' || lost === 0,
                detail: `${lost}/${trials} specs missing the clause`,
                unmeasured: mode === 'baseline'
            }
        ]
    })
}

// Only when this file IS the entry point — `scoreStaticObservation` is imported
// by scripts/owned-freeze-delivered-scorer-check.ts, which must not spend model
// time to validate the metric.
if (import.meta.main) {
    main().catch(e => {
        console.error(e)
        process.exit(1)
    })
}
