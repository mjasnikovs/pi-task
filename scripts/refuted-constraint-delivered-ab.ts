/**
 * A/B-2 for nexttask 8 — the DELIVERY claim, live.
 *
 * Re-composes mx5 run 19's TASK_0001 from the real recorded inputs (its refined
 * prompt, its research, its grill Q&A, its carried contract blocks), n=20 per
 * arm, through the SHIPPED chain — compose THEN critique.
 *
 * Critique is not optional here. The recorded run-19 spec, the one carrying "Do
 * NOT use built-in `Bun.password`", is what critique emitted; the run's debug log
 * records both phases and keeps neither draft, so which of the two authored the
 * prohibition is not knowable from artifacts. Critique is also handed the refined
 * task as GROUND TRUTH under "CONSTRAINTS … MUST be preserved in spirit", so it
 * is the phase most able to UNDO the treatment. Scoring compose's draft alone
 * would measure half the pipeline and hand the treatment an unearned win.
 *
 *   baseline    refine CONSTRAINTS as recorded
 *   treatment   + the refutation-driven token drop (applyRefutations)
 *
 * PRE-REGISTERED METRIC, both counts mechanical on the delivered spec:
 *
 *   REQUIRES-UNNEEDED-DEP   the spec requires a dependency the design says is
 *                           unnecessary — `argon2` or `bun-sql` appearing in a
 *                           CONSTRAINTS, ACCEPTANCE or VERIFY line.
 *   FORBIDS-MANDATED-API    the spec forbids an API the design mandates —
 *                           `Bun.password` or `Bun.sql` in a clause that also
 *                           carries a negation cue ("Do NOT use built-in
 *                           `Bun.password` for hashing").
 *
 *   PASS      treatment 0/20 on BOTH counts vs baseline >= 8/20 on at least
 *             one, Fisher exact p < 0.05.
 *   FAIL      anything else. Both proportions are reported either way.
 *
 * The recorded run-19 spec must itself score positive on both counts, or the
 * fixture cannot discriminate and the harness refuses to spend model time.
 *
 * INVARIANTS: spec-shape validity must not fall in treatment, and the treatment
 * spec must not shed the dependencies that ARE real (`hono`, `sharp`, `react`) —
 * a pass bought by a spec that stopped asking for anything is not a pass.
 *
 * Usage: PI_BIN=$(command -v pi) bun run scripts/refuted-constraint-delivered-ab.ts [REPS=20]
 * Raw:   ~/tmp/refuted-constraint-ab/ab-chain.jsonl (compose->critique) or ab.jsonl
 *        (WITH_CRITIQUE=0) — every spec verbatim, re-scorable offline. Re-score
 *        with scripts/refuted-constraint-scorer-check.ts's scorers before trusting
 *        any proportion; this metric was wrong three times before it was right.
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {COMPOSE_PROMPT} from '../src/task/prompts.js'
import {buildContractsBlock, readContracts} from '../src/task/contracts.js'
import {buildRequirementsBlock, readRequirements} from '../src/task/requirements.js'
import {stripSpecPreamble, validateSpecShape} from '../src/task/spec-validation.js'
import {phaseCritique} from '../src/task/phases.js'
import {runChild} from '../src/task/child-runner.js'
import {applyRefutations} from '../src/task/refuted-constraint.js'
import {reportAb, type Invariant} from './ab-verdict.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')
const TASK_FILE = 'TASK_0001.md'
const OUT_DIR = path.join(os.homedir(), 'tmp', 'refuted-constraint-ab')
const REPS = Number(process.argv[2] ?? '20')
const TRIAL_TIMEOUT_MS = 15 * 60_000
/** Score the spec the pipeline SHIPS (compose→critique). WITH_CRITIQUE=0 scores
 *  compose's draft alone — useful for attributing which phase authored a defect,
 *  never for the delivery claim. */
const WITH_CRITIQUE = process.env.WITH_CRITIQUE !== '0'

/** Dependencies DESIGN/PROJECT.md rules out (`Bun.password`/`Bun.sql` are built in). */
const UNNEEDED_DEPS = ['argon2', 'bun-sql']
/** APIs the design mandates; forbidding one is the harm this lever is about. */
const MANDATED_APIS = ['Bun.password', 'Bun.sql']
/** Real dependencies the design DOES pin — the treatment must keep asking for them. */
const REAL_DEPS = ['hono', 'sharp', 'react']

/** A clause that FORBIDS. Used by count 2 and, with the shapes below, count 1. */
const PROHIBITION =
    /\bdo\s+not\b|\bdon't\b|\bnever\b|\bmust\s+not\b|\bavoid\b|\bno\s+longer\b|\bwithout\b|\binstead\s+of\b|\brather\s+than\b/i

/**
 * A clause that says a dependency is NOT NEEDED. Distinct from PROHIBITION and
 * load-bearing for count 1: three separate live reps were mis-scored as
 * "requires `argon2`" while saying the opposite, each in a shape the previous cut
 * of this list missed —
 *
 *   "… — do not add `argon2` …"                         (prohibition)
 *   "… — no external `argon2` … dependency needed."      (negation of need)
 *   "Use `Bun.password.hash()` … instead of any external argon2 package"
 *
 * Deliberately WIDER than task/refuted-constraint.ts's closed set: this is a
 * MEASURING instrument, where a missed negation inflates the defect count in
 * BOTH arms and a spurious one deflates it. The detector's set is narrow because
 * it ACTS; this one is wide because it only counts.
 */
const NOT_NEEDED =
    /\bno\s+external\b|\bnot\s+needed\b|\bnot\s+required\b|\bno\s+need\b|\bunnecessary\b|\bnot\s+a\s+dependency\b|\bdoes\s+not\s+require\b|\bbuilt-?in\b|\bdoes\s+not\s+exist\b|\bnot\s+an?\s+npm\s+package\b|\bno\s+.{0,40}?\s+package\s+exists\b/i

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

/** The CONSTRAINTS → end-of-spec span: CONSTRAINTS, ACCEPTANCE and VERIFY. */
export function obligationSpan(spec: string): string {
    const from = /^CONSTRAINTS\s*$/m.exec(spec)
    return from ? spec.slice(from.index) : ''
}

/**
 * Count 1 — the spec REQUIRES a dependency the design says is unnecessary.
 *
 * The doc pre-registers this as "token present in a CONSTRAINTS or ACCEPTANCE or
 * VERIFY line". That operationalization is blind to polarity, and the very first
 * live rep proved it: the treatment arm composed
 *
 *   "Password hashing uses `Bun.password` (built-in) — do not add `argon2` …"
 *
 * which is the OUTCOME THIS LEVER WANTS, and bare token presence scored it as a
 * requirement. So the count is polarity-aware, using the same clause split as
 * count 2: a token requires the dependency unless its own clause forbids it or
 * says it is not needed. The claim being measured is unchanged; only the
 * mechanical test of it is.
 */
export function requiresUnneededDep(spec: string): string[] {
    const out = new Set<string>()
    for (const line of obligationSpan(spec).split('\n')) {
        for (const clause of line.split(/[.;]\s+|\s+—\s+|\s+--\s+/)) {
            if (PROHIBITION.test(clause) || NOT_NEEDED.test(clause)) continue
            for (const d of UNNEEDED_DEPS) {
                if (new RegExp(`\`${d}\`|['"]${d}['"]`, 'i').test(clause)) out.add(d)
            }
        }
    }
    return [...out]
}

/**
 * Count 2 — the spec forbids an API the design mandates.
 *
 * Clause-scoped AND direction-aware. Clause scoping alone is not enough: a
 * negation cue only reaches what comes AFTER it, and the scorer check caught the
 * difference on a real shape —
 *
 *   "Use `Bun.password.hash()` … instead of any external `argon2` package"
 *
 * mandates `Bun.password` and forbids `argon2`, but a cue-anywhere test read it
 * as forbidding `Bun.password`. So a cue counts only when it precedes the API it
 * is supposed to be forbidding.
 */
export function forbidsMandatedApi(spec: string): string[] {
    const out = new Set<string>()
    for (const line of obligationSpan(spec).split('\n')) {
        // Clause boundaries, so "Use `Bun.password`. Do not add `argon2`." does
        // not read as forbidding `Bun.password`.
        for (const clause of line.split(/[.;]\s+|\s+—\s+|\s+--\s+/)) {
            const cue = PROHIBITION.exec(clause)
            if (!cue) continue
            for (const api of MANDATED_APIS) {
                const at = clause.indexOf(api)
                if (at !== -1 && cue.index < at) out.add(api)
            }
        }
    }
    return [...out]
}

/** Two-sided Fisher exact on the 2x2 [hits, misses] x [baseline, treatment]. */
/**
 * Two-sided Fisher exact. Re-exported under its original name so
 * `refuted-constraint-rescore.ts` keeps working; the implementation moved to
 * `ab-stats.ts`, where it is tested against exact BigInt references.
 */
export {fisherTwoSided as fisherExact} from './ab-stats.js'
import {fisherTwoSided} from './ab-stats.js'
import {requirePreconditions} from './ab-preflight.js'
import {readSection} from './ab-corpus.js'

async function main(): Promise<void> {
    await requirePreconditions('refuted-constraint-delivered-ab', {model: {}, piBin: true, cacheOff: true})

    const md = fs.readFileSync(path.join(MX5, '.pi-tasks', TASK_FILE), 'utf8')
    const refined = section(md, 'refined prompt')
    const research = section(md, 'research')
    const qa = section(md, 'grill Q&A')
    const recorded = section(md, 'spec')

    // The fixture has to be able to discriminate: the spec run 19 actually
    // shipped must score positive on BOTH counts.
    const recDep = requiresUnneededDep(recorded)
    const recApi = forbidsMandatedApi(recorded)
    console.log(
        `chain: compose${WITH_CRITIQUE ? ' -> critique (the shipped pipeline)' : ' only (WITH_CRITIQUE=0)'}`
    )
    console.log(
        `recorded run-19 spec: requires=[${recDep.join(', ')}] forbids=[${recApi.join(', ')}]`
    )
    if (recDep.length === 0 || recApi.length === 0) {
        console.error('FIXTURE CANNOT DISCRIMINATE — refusing to spend model time.')
        process.exit(1)
    }

    const treatedRefined = applyRefutations(refined, research).refined
    if (treatedRefined === refined) {
        console.error('FIXTURE CANNOT DISCRIMINATE — the pass drops nothing here.')
        process.exit(1)
    }

    await fsp.mkdir(OUT_DIR, {recursive: true})
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'refuted-ab-'))
    const carried = [
        buildContractsBlock(await readContracts(MX5).catch(() => '')),
        buildRequirementsBlock(await readRequirements(MX5).catch(() => ''))
    ]
        .filter(b => b.length > 0)
        .join('\n')

    const counts = new Map<
        string,
        {dep: number; api: number; either: number; valid: number; realKept: number}
    >([
        ['baseline', {dep: 0, api: 0, either: 0, valid: 0, realKept: 0}],
        ['treatment', {dep: 0, api: 0, either: 0, valid: 0, realKept: 0}]
    ])

    for (let rep = 1; rep <= REPS; rep++) {
        for (const arm of ['baseline', 'treatment'] as const) {
            const armRefined = arm === 'treatment' ? treatedRefined : refined
            const abort = new AbortController()
            const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
            const started = Date.now()
            let spec = ''
            let draft = ''
            let err = ''
            try {
                const r = await runChild(
                    cwd,
                    'read',
                    COMPOSE_PROMPT(armRefined, research, qa, null, carried),
                    abort.signal
                )
                draft = stripSpecPreamble(r.text)
                spec = draft
                if (r.exitCode !== 0) err = `exit ${r.exitCode}`
                // The SHIPPED chain, not compose alone. run 19's recorded spec —
                // the one carrying "Do NOT use built-in `Bun.password`" — is
                // POST-critique, and critique is handed the refined task as
                // GROUND TRUTH with "CONSTRAINTS … MUST be preserved in spirit".
                // Scoring compose's draft would measure half the pipeline and
                // give the treatment a win critique could still undo.
                if (!err && WITH_CRITIQUE) {
                    spec = await phaseCritique(
                        {cwd, taskId: 'TASK_0001', signal: abort.signal},
                        draft,
                        armRefined,
                        qa,
                        undefined,
                        research
                    )
                }
            } catch (e) {
                err = e instanceof Error ? e.message : String(e)
            } finally {
                clearTimeout(timer)
            }
            const shapeProblem = err ? err : validateSpecShape(spec)
            const valid = shapeProblem === null
            const dep = valid ? requiresUnneededDep(spec) : []
            const api = valid ? forbidsMandatedApi(spec) : []
            const realKept =
                valid && REAL_DEPS.every(d => new RegExp(`\`?${d}`, 'i').test(obligationSpan(spec)))
            const c = counts.get(arm)!
            if (valid) {
                c.valid += 1
                if (dep.length > 0) c.dep += 1
                if (api.length > 0) c.api += 1
                if (dep.length > 0 || api.length > 0) c.either += 1
                if (realKept) c.realKept += 1
            }
            await fsp.appendFile(
                path.join(OUT_DIR, WITH_CRITIQUE ? 'ab-chain.jsonl' : 'ab.jsonl'),
                JSON.stringify({
                    rep,
                    arm,
                    valid,
                    shapeProblem,
                    dep,
                    api,
                    realKept,
                    ms: Date.now() - started,
                    draft,
                    spec
                }) + '\n'
            )
            console.log(
                `rep ${rep} ${arm}: ${valid ? `requires=[${dep.join(',')}] forbids=[${api.join(',')}]` : `INVALID (${String(shapeProblem).slice(0, 60)})`}`
                    + ` ${((Date.now() - started) / 1000).toFixed(0)}s`
            )
        }
    }

    const b = counts.get('baseline')!
    const t = counts.get('treatment')!
    const p = fisherTwoSided(b.either, REPS - b.either, t.either, REPS - t.either)

    console.log(`\nPROPORTIONS (both reported whatever the verdict)`)
    console.log(`  REQUIRES-UNNEEDED-DEP   baseline ${b.dep}/${REPS}   treatment ${t.dep}/${REPS}`)
    console.log(`  FORBIDS-MANDATED-API    baseline ${b.api}/${REPS}   treatment ${t.api}/${REPS}`)
    console.log(
        `  EITHER                  baseline ${b.either}/${REPS}   treatment ${t.either}/${REPS}   p=${p.toExponential(2)}`
    )

    const invariants: Invariant[] = [
        {
            label: 'spec-shape validity did not fall in treatment',
            ok: t.valid >= b.valid - 1,
            detail: `valid baseline ${b.valid}/${REPS} vs treatment ${t.valid}/${REPS}`
        },
        {
            label: 'treatment still requires the REAL dependencies (hono, sharp, react)',
            ok: t.realKept >= Math.max(1, t.valid - 1),
            detail: `real-deps kept baseline ${b.realKept}/${b.valid} vs treatment ${t.realKept}/${t.valid}`,
            unmeasured: t.valid === 0
        }
    ]
    const outcome = reportAb({
        name: 'refuted-constraint delivered spec (mx5 run 19 TASK_0001)',
        reps: REPS,
        targetShape:
            'a composed spec that requires a design-refuted dependency, or forbids a design-mandated API',
        baselineHits: b.either,
        treatmentHits: t.either,
        requireTreatmentZero: true,
        invariants
    })

    // The doc's pre-registered gate, on top of the standard verdict.
    const preRegistered =
        t.dep === 0 && t.api === 0 && Math.max(b.dep, b.api) >= Math.ceil(0.4 * REPS) && p < 0.05
    console.log(
        `\npre-registered gate: treatment 0 on both (${t.dep === 0 && t.api === 0}), `
            + `baseline >= ${Math.ceil(0.4 * REPS)}/${REPS} on at least one (${Math.max(b.dep, b.api)}), p<0.05 (${p < 0.05})`
    )
    // ABSTAIN is kept distinct from FAIL on purpose: a baseline that never
    // reproduced the defect proves nothing about the lever, and reporting that
    // as a FAIL would be as dishonest as reporting it as a PASS.
    if (outcome === 'ABSTAIN') {
        console.log('A/B-2 ABSTAIN — the baseline never produced the target shape on this model')
        process.exit(2)
    }
    console.log(preRegistered && outcome === 'PASS' ? 'A/B-2 PASS' : 'A/B-2 FAIL')
    process.exit(preRegistered && outcome === 'PASS' ? 0 : 1)
}

// Guarded so the scorers above can be imported for offline re-scoring of
// ab.jsonl (and by the scorer check) without launching 40 model calls.
if (import.meta.main) await main()
