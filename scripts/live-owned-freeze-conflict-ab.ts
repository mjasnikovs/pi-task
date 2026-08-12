/**
 * LIVE A/B against the real local model (llama-server @ 127.0.0.1:8080 via pi):
 * does forcing the owned-requirement/category-freeze finding into the critique
 * rewrite make the DELIVERED spec SATISFIABLE? (nexttask 7, mx5 run 18)
 *
 * WHAT THIS MEASURES AND WHY IT IS NOT A DELIVERY METRIC. The run-16 lever
 * (`scripts/live-owned-requirement-compose-ab.ts`) already proved DELIVERY: the
 * owned clause reaches the composed spec's CONSTRAINTS, verbatim and marked
 * AUTHORITATIVE. Run 18 shows delivery at 100% and satisfaction at 0% — the same
 * spec froze `src/server/index.ts` with a category freeze and converted the
 * behavioural half of the clause ("serves `/api` + static `dist/`") into a
 * string-match on `package.json`. So every metric here scores SATISFIABILITY:
 *
 *   M1 pair-present     does the delivered spec still carry (category freeze ∧
 *                       owned requirement naming a file inside it)? — the A/B
 *                       metric, deterministic via findOwnedFreezeConflicts
 *   M2 resolution-shape scoped-ownership | reassigned  (permitted)
 *                       requirement-dropped | prose-surrender  (failures)
 *   M3 verify-can-fail  does VERIFY contain a command that could OBSERVE the
 *                       requirement's behaviour, rather than only asserting a
 *                       string in a config file? Run 18's VERIFY scores 0 here
 *                       and that is the whole defect (classifyVerifyCommands)
 *
 * ARMS (one per invocation; they differ by the probe ALONE — both call the same
 * shipped phaseCritique, the treatment passing the probe text through its
 * `extraDefects` seam, because the probe is deliberately NOT wired until this
 * harness passes):
 *
 *   baseline            real phaseCompose + real phaseCritique, no probe
 *   treatment           real phaseCompose + real phaseCritique + the probe
 *   critique-baseline   draft FIXED to run 18's TASK_0023 spec verbatim → no probe
 *   critique-treatment  same fixed draft → probe forced into the rewrite
 *
 * The controlled critique-seam pair exists for the same reason it does in
 * `live-frozen-conflict-ab.ts`: compose does not reliably echo the pair into the
 * draft, and a treatment arm whose draft never carried the pair proves nothing.
 *
 * INPUTS are the recorded run-18 incident, read from the evidence tree rather
 * than pasted, and asserted at startup: the recorded TASK_0023 spec MUST carry
 * the pair, or the fixture cannot discriminate and the run refuses to spend
 * model time. The per-trial fixture is a `git archive` export of mx5 at the
 * checkpoint BEFORE TASK_0023 ran, plus that run's own `.pi-tasks` owned ledger,
 * so compose sees exactly what it saw live. The evidence tree is never written.
 *
 * ── VERDICT 2026-08-04, 20 trials/arm: FAIL. The probe is UNWIRED. ───────────
 *
 *   critique-baseline   pair 8/20   M2 requirement-dropped 12/20   M3 6/20
 *   critique-treatment  pair 0/20   M2 requirement-dropped 11/20,
 *                                      scoped-ownership     9/20   M3 6/20
 *   baseline/treatment  ABSTAIN — 0/20 drafts carried a DETECTABLE pair
 *
 * M1 passes and means nothing on its own: the probe drives pair-present to zero
 * by getting the rewrite to DELETE the authoritative clause as often as to grant
 * ownership (11 of 20; none of the 11 reassigned it to the task that owns the
 * file — they rationalised it: "this references an existing file; no edits are
 * required or permitted"). M3 does not move at all: 6/20 in both arms, i.e. the
 * delivered VERIFY still checks the behavioural requirement by grepping
 * `package.json`. `inv-no-spec-inflation` holds (CONSTRAINTS lines 11.2 → 10.4)
 * — the treatment specs are if anything shorter, which is the deletion showing
 * up in a second measure.
 *
 * The compose arms ABSTAINING is not a fixture defect, it is the second finding:
 * `appendOwnedConstraints` (the braces) runs AFTER `critiqueWithFallback`, so at
 * critique time the machine-marked owned bullet does not exist yet, and
 * compose's own folding is a paraphrase the quote-match cannot see. 11/40 drafts
 * carried the clause semantically; 0/40 carried a detectable pair.
 *
 * Usage:
 *   PI_BIN=$(command -v pi) bun run scripts/live-owned-freeze-conflict-ab.ts <arm> [TRIALS]
 *   bun run scripts/live-owned-freeze-conflict-ab.ts compare      (cross-arm M3 + inflation)
 * Raw: ~/tmp/owned-freeze-ab/<arm>.jsonl — every spec verbatim, re-scorable offline.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawnSync} from 'node:child_process'
import {phaseCompose, phaseCritique} from '../src/task/phases.js'
import {reportArm} from './ab-verdict.js'
import type {PhaseDeps} from '../src/task/child-runner.js'
import {
    findOwnedFreezeConflicts,
    ownedFreezeConflictProbeText,
    trackedSourceOracle
} from '../src/task/owned-freeze-conflict.js'
import {classifyVerifyCommands} from '../src/task/verify-quality.js'
import {parseOwnedRequirements, ownedForTitle} from '../src/task/requirements.js'
import {requirePreconditions} from './ab-preflight.js'
import {readSection} from './ab-corpus.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')
const ROOT = path.join(os.homedir(), 'tmp', 'owned-freeze-ab')
/** mx5 `chore: checkpoint before "Wire dev build pipeline …"` — the tree state
 *  TASK_0023 was composed against. */
const PRE_TASK_COMMIT = '8963f4c'
const TASK = 'TASK_0023'
const TRIAL_TIMEOUT_MS = 30 * 60_000
/** The paths compose can read; `.pi-tasks`, `dist/` and the screenshot
 *  baselines are excluded (the harness writes its own `.pi-tasks`). */
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

type Mode = 'baseline' | 'treatment' | 'critique-baseline' | 'critique-treatment'
const MODES: Mode[] = ['baseline', 'treatment', 'critique-baseline', 'critique-treatment']

function git(args: string[], cwd: string): {stdout: string; exitCode: number} {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
    return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
}

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
function section(doc: string, name: string): string {
    const s = readSection(doc, name)
    if (s === undefined) throw new Error(`section "${name}" not found`)
    return s
}

// ─── The recorded incident inputs ────────────────────────────────────────────

const taskFile = path.join(MX5, '.pi-tasks', `${TASK}.md`)
if (!fs.existsSync(taskFile)) {
    console.error(`ABSTAIN: evidence tree missing (${taskFile}); set MX5_DIR.`)
    process.exit(2)
}
const RECORDED = fs.readFileSync(taskFile, 'utf8')
const RAW_PROMPT = section(RECORDED, 'raw prompt')
const REFINED = section(RECORDED, 'refined prompt').replace(
    /^[\s\S]*?(?=^GOAL$)/m,
    '' // the recorded refine output opens with a stray "Now I have all the context…" line
)
const RESEARCH = section(RECORDED, 'research')
const QA = section(RECORDED, 'grill Q&A')
/** The delivered run-18 spec — the pair-carrying draft for the controlled seam. */
const MX5_DRAFT = section(RECORDED, 'spec')
const OWNED_LEDGER = fs.readFileSync(path.join(MX5, '.pi-tasks', 'requirements-owned.md'), 'utf8')
const OWNED = ownedForTitle(parseOwnedRequirements(OWNED_LEDGER), RAW_PROMPT)

/** The owned clause whose satisfaction this whole task is about. */
const TARGET_PATH = 'src/server/index.ts'
const TARGET_QUOTE = 'serves `/api` + static `dist/`'

// ─── Scoring ─────────────────────────────────────────────────────────────────

type Resolution =
    | 'unresolved'
    | 'scoped-ownership'
    | 'reassigned'
    | 'requirement-dropped'
    | 'prose-surrender'

interface TrialResult {
    draftPair: number
    finalPair: number
    resolution: Resolution
    verifyBehaviour: boolean
    verifyCmds: number
    constraintLines: number
    specChars: number
    error?: string
}

/** "You MAY edit `X` ONLY …" — the granted-ownership resolution. */
const SCOPED_GRANT_RE = /\b(?:may|can|are\s+allowed\s+to)\s+(?:edit|modify|chang|touch|updat)\w*\b[^\n]{0,80}?\bonly\b/i
/** "not satisfiable in this task", "belongs to step 21", "deferred to the task that owns …". */
const REASSIGN_RE =
    /\b(?:not\s+satisfiable|cannot\s+be\s+satisfied|belongs\s+to|owned\s+by|deferred\s+to|handled\s+(?:by|in)\s+(?:the\s+)?(?:task|step))\b/i
/** The run-16/run-18 non-resolutions: acknowledging the gap in prose. */
const SURRENDER_RE =
    /\b(?:accept|acknowledg\w*|note)\s+that\b[^\n]{0,160}?\b(?:will\s+not|won'?t|cannot|can'?t|is\s+not|isn'?t)\b/i

function constraintsSpan(spec: string): string {
    const m = /^CONSTRAINTS[ \t]*$/m.exec(spec)
    if (!m) return ''
    const rest = spec.slice(m.index + m[0].length)
    const next = /^(?:ACCEPTANCE|VERIFY|GOAL|KNOWN-UNKNOWNS)/m.exec(rest)
    return next ? rest.slice(0, next.index) : rest
}

function score(final: string, isSource: (p: string) => boolean): Omit<TrialResult, 'draftPair' | 'error'> {
    const conflicts = findOwnedFreezeConflicts(final, {owned: OWNED, isSource})
    const finalPair = conflicts.length
    const carriesQuote = final.includes(TARGET_QUOTE)
    const namesTarget = final.includes(TARGET_PATH)
    const grant = final.split('\n').some(l => SCOPED_GRANT_RE.test(l) && l.includes(TARGET_PATH))
    let resolution: Resolution = 'unresolved'
    if (finalPair === 0) {
        if (grant) resolution = 'scoped-ownership'
        else if (!carriesQuote && REASSIGN_RE.test(final) && namesTarget) resolution = 'reassigned'
        else if (!carriesQuote) resolution = 'requirement-dropped'
        else if (SURRENDER_RE.test(final)) resolution = 'prose-surrender'
        else resolution = 'scoped-ownership'
    } else if (SURRENDER_RE.test(final)) {
        resolution = 'prose-surrender'
    }
    const cmds = classifyVerifyCommands(final)
    return {
        finalPair,
        resolution,
        verifyBehaviour: cmds.some(c => c.observesBehaviour),
        verifyCmds: cmds.length,
        constraintLines: constraintsSpan(final).split('\n').filter(l => l.trim().length > 0).length,
        specChars: final.length
    }
}

// ─── Fixture ─────────────────────────────────────────────────────────────────

function buildFixture(dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    const tar = spawnSync('git', ['archive', PRE_TASK_COMMIT, '--', ...FIXTURE_PATHS], {
        cwd: MX5,
        maxBuffer: 512 * 1024 * 1024,
        encoding: 'buffer'
    })
    if (tar.status !== 0) throw new Error(`git archive failed: ${tar.stderr?.toString().slice(0, 200)}`)
    const extract = spawnSync('tar', ['-x', '-C', dir], {input: tar.stdout, maxBuffer: 512 * 1024 * 1024})
    if (extract.status !== 0) throw new Error('tar extract failed')
    // The run's own owned ledger, and a task file whose `raw prompt` matches the
    // ledger titles — that pairing is what phaseCarriedBlocks resolves.
    const tasks = path.join(dir, '.pi-tasks')
    fs.mkdirSync(tasks, {recursive: true})
    fs.writeFileSync(path.join(tasks, 'requirements-owned.md'), OWNED_LEDGER)
    fs.writeFileSync(
        path.join(tasks, 'TASK_AB.md'),
        [
            '---',
            'id: TASK_AB',
            'state: in_progress',
            'phase: compose',
            'created_at: 2026-07-30T14:12:06.337Z',
            'updated_at: 2026-07-30T14:12:06.337Z',
            `title: ${RAW_PROMPT.split('\n')[0]}`,
            '---',
            '',
            '## raw prompt',
            '',
            RAW_PROMPT,
            ''
        ].join('\n')
    )
    // A git index so the probe's source oracle behaves exactly as in production.
    git(['init', '-q'], dir)
    git(['add', '-A', '--', ...FIXTURE_PATHS], dir)
}

// ─── Trial ───────────────────────────────────────────────────────────────────

async function runTrial(mode: Mode, n: number): Promise<TrialResult> {
    const dir = path.join(ROOT, `${mode}-t${n}`)
    buildFixture(dir)
    const isSource = trackedSourceOracle(p => git(['ls-files', '--', p], dir))
    const logPath = path.join(dir, 'trial.log')
    const log = (m: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
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
        let draft: string
        if (mode === 'critique-baseline' || mode === 'critique-treatment') {
            draft = MX5_DRAFT
        } else {
            log(`=== compose start (${mode} t${n}) ===`)
            draft = await phaseCompose(deps, REFINED, RESEARCH, QA)
        }
        fs.writeFileSync(path.join(dir, 'draft.spec.md'), draft)
        const draftConflicts = findOwnedFreezeConflicts(draft, {owned: OWNED, isSource})
        log(`=== draft pair conflicts: ${draftConflicts.length} ===`)
        const probe =
            mode.endsWith('treatment') && draftConflicts.length > 0 ?
                ownedFreezeConflictProbeText(draftConflicts)
            :   null
        const final = await phaseCritique(deps, draft, REFINED, QA, undefined, RESEARCH, probe)
        fs.writeFileSync(path.join(dir, 'final.spec.md'), final)
        const s = score(final, isSource)
        log(`=== critique done — final pair: ${s.finalPair} (${s.resolution}) ===`)
        return {draftPair: draftConflicts.length, ...s}
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        log(`=== TRIAL ERROR: ${msg} ===`)
        return {
            draftPair: -1,
            finalPair: -1,
            resolution: 'unresolved',
            verifyBehaviour: false,
            verifyCmds: 0,
            constraintLines: 0,
            specChars: 0,
            error: msg
        }
    } finally {
        clearTimeout(timer)
    }
}

// ─── Cross-arm comparison ────────────────────────────────────────────────────

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

const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length)

function compare(): void {
    console.log('=== cross-arm comparison (M2, M3, inv-no-spec-inflation) ===\n')
    for (const pair of [
        ['baseline', 'treatment'],
        ['critique-baseline', 'critique-treatment']
    ] as [Mode, Mode][]) {
        const [b, t] = pair.map(readArm)
        if (b.length === 0 || t.length === 0) {
            console.log(`${pair[0]} vs ${pair[1]}: NO DATA (${b.length} / ${t.length} scored trials)\n`)
            continue
        }
        const m3b = b.filter(r => r.verifyBehaviour).length
        const m3t = t.filter(r => r.verifyBehaviour).length
        const badB = b.filter(r => r.resolution === 'prose-surrender' || r.resolution === 'requirement-dropped')
        const badT = t.filter(r => r.resolution === 'prose-surrender' || r.resolution === 'requirement-dropped')
        console.log(`${pair[0]} (n=${b.length}) vs ${pair[1]} (n=${t.length})`)
        console.log(`  M1 pair present        ${b.filter(r => r.finalPair > 0).length} → ${t.filter(r => r.finalPair > 0).length}`)
        console.log(`  M2 bad resolutions     ${badB.length} → ${badT.length}   (prose-surrender | requirement-dropped)`)
        console.log(`  M3 behavioural VERIFY  ${m3b}/${b.length} → ${m3t}/${t.length}`)
        console.log(`  inv-no-spec-inflation  CONSTRAINTS lines mean ${mean(b.map(r => r.constraintLines)).toFixed(1)} → ${mean(t.map(r => r.constraintLines)).toFixed(1)}`)
        console.log(`                         spec chars mean        ${mean(b.map(r => r.specChars)).toFixed(0)} → ${mean(t.map(r => r.specChars)).toFixed(0)}`)
        const m3ok = m3t / t.length > m3b / b.length
        console.log(`  M3 strictly improves:  ${m3ok ? 'YES' : 'NO'}`)
        console.log(`  M2 never bad in treatment: ${badT.length === 0 ? 'YES' : 'NO'}\n`)
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (process.argv[2] === 'compare') {
        compare()
        return
    }
    await requirePreconditions('live-owned-freeze-conflict-ab', {model: {}, piBin: true, cacheOff: true})
    const mode = process.argv[2] as Mode
    if (!MODES.includes(mode)) {
        console.error(
            'usage: PI_BIN=$(command -v pi) bun run scripts/live-owned-freeze-conflict-ab.ts '
                + '<baseline|treatment|critique-baseline|critique-treatment> [TRIALS]   |   compare'
        )
        process.exit(1)
    }
    // The fixture must be able to discriminate: the RECORDED run-18 spec has to
    // carry the pair, or nothing here measures what it claims to.
    fs.mkdirSync(ROOT, {recursive: true})
    const probeDir = path.join(ROOT, 'assert')
    buildFixture(probeDir)
    const assertSource = trackedSourceOracle(p => git(['ls-files', '--', p], probeDir))
    const recordedPair = findOwnedFreezeConflicts(MX5_DRAFT, {owned: OWNED, isSource: assertSource})
    if (recordedPair.length === 0 || !recordedPair.some(c => c.paths.includes(TARGET_PATH))) {
        console.error(
            `ABSTAIN: the recorded ${TASK} spec does not carry the owned/freeze pair on `
                + `${TARGET_PATH} — the fixture cannot discriminate.`
        )
        process.exit(2)
    }
    if (OWNED.length === 0) {
        console.error('ABSTAIN: the run-18 owned ledger has no entry for this task title.')
        process.exit(2)
    }

    const trials = parseInt(process.argv[3] ?? '20', 10)
    const jsonl = path.join(ROOT, `${mode}.jsonl`)
    fs.writeFileSync(jsonl, '')
    let draftHadPair = 0
    let finalHadPair = 0
    let behaviour = 0
    const resolutions: string[] = []
    for (let t = 1; t <= trials; t++) {
        const r = await runTrial(mode, t)
        fs.appendFileSync(jsonl, `${JSON.stringify({trial: t, ...r})}\n`)
        if (r.error) {
            console.log(`[${mode} t${t}] ERROR: ${r.error.slice(0, 160)}`)
            resolutions.push('error')
            continue
        }
        if (r.draftPair > 0) draftHadPair++
        if (r.finalPair > 0) finalHadPair++
        if (r.verifyBehaviour) behaviour++
        resolutions.push(r.resolution)
        console.log(
            `[${mode} t${t}] draft pair=${r.draftPair} | final pair=${r.finalPair}`
                + ` | resolution=${r.resolution} | behavioural VERIFY=${r.verifyBehaviour}`
                + ` | CONSTRAINTS lines=${r.constraintLines}`
        )
    }
    console.log(`\n[${mode}] over ${trials} trials:`)
    console.log(`  draft carried the owned/freeze pair:      ${draftHadPair}/${trials}`)
    console.log(`  DELIVERED spec still carries the pair:    ${finalHadPair}/${trials}`)
    console.log(`  VERIFY could observe the behaviour (M3):  ${behaviour}/${trials}`)
    console.log(`  resolutions: ${resolutions.join(', ')}`)
    console.log(`\n  raw: ${jsonl} — run \`compare\` once both arms of a pair are done.`)

    const bad = resolutions.filter(r => r === 'prose-surrender' || r === 'requirement-dropped')
    reportArm({
        name: 'live-owned-freeze-conflict-ab',
        arm: mode,
        reps: trials,
        targetShape:
            'a DELIVERED spec that still carries the unsatisfiable pair — a category freeze '
            + 'over the file an AUTHORITATIVE owned requirement names',
        hits: finalHadPair,
        witnessed: draftHadPair,
        expect: mode.endsWith('baseline') ? 'some' : 'none',
        invariants: [
            {
                label: 'no trial ended in a child error (errors are evidence for neither arm)',
                ok: !resolutions.includes('error'),
                detail: `${resolutions.filter(r => r === 'error').length}/${trials} errored`
            },
            {
                label: 'M2: no resolution was a prose surrender or a dropped requirement',
                ok: mode.endsWith('baseline') || bad.length === 0,
                detail: `${bad.length}/${trials} bad resolutions`,
                unmeasured: mode.endsWith('baseline')
            }
        ]
    })
}

main().catch(e => {
    console.error(e)
    process.exit(1)
})
