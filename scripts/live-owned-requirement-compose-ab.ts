/**
 * live-owned-requirement-compose-ab — does injecting a task's OWN mapped design
 * obligation (buildOwnedRequirementsBlock) make compose carry it into the spec's
 * CONSTRAINTS/ACCEPTANCE, where today it silently narrows away? (mx5 run 16)
 *
 * THE SEAM. Run 16 lost §9's "serves `/api` + static `dist/`" exactly here:
 * TASK_0008's pipeline SAW the clause (its grill question quotes it verbatim) and
 * the composed spec still shipped without it — narrowed to "SPA fallback serves
 * index.html" — so the server never served the client bundle and the app was
 * permanently blank behind a green run. The owned-requirements channel
 * (requirements-owned.md, written at plan time since this commit) exists to hand
 * compose that clause as AUTHORITATIVE text; THIS A/B measures whether compose
 * obeys, before the injection is wired into phaseCarriedBlocks (wire only on PASS
 * — the PROMPT-4 lesson is that models ignore some instructions, so delivery
 * alone proves nothing).
 *
 * ARMS (one process, interleaved; the arms differ by the owned block ALONE):
 *   baseline  = COMPOSE_PROMPT(refined, research, qa, null, carried-blocks) — the
 *               shipped compose inputs, reconstructed from the RECORDED run-16
 *               task file and the run's own .pi-tasks artifacts.
 *   treatment = identical + buildOwnedRequirementsBlock([target clause]).
 *
 * FIXTURES — two REAL run-16 losses, different tasks, different design sections:
 *   task8-serve   TASK_0008 + "serves `/api` + static `dist/`"        [§9]
 *   task23-hooks  TASK_0023 + "small hooks for fetch/mutations"       [§8]
 * Both recorded specs verifiably LACK the clause (asserted at startup — if a
 * fixture's recorded spec already carries it, the fixture cannot discriminate
 * and the run refuses to spend model time).
 *
 * WHAT ITS PASS DOES **NOT** COVER (nexttask 7, added 2026-08-04). This harness
 * passed on a DELIVERY metric — "does the composed spec carry the clause". It
 * does not measure whether the delivered clause is SATISFIABLE. mx5 run 18 is
 * the demonstration: `.pi-tasks/requirements-owned.md:21` carried this very
 * clause, TASK_0023's CONSTRAINTS carried it verbatim and marked AUTHORITATIVE —
 * delivery 100% — and the same spec froze `src/server/index.ts` with a category
 * freeze while converting the behavioural half ("serves `/api` + static `dist/`")
 * into a string-match on `package.json`. Satisfaction 0%; the app shipped with no
 * static route behind a green run. Do not read this PASS as covering that class:
 * it is `scripts/live-owned-freeze-conflict-ab.ts`'s question, scored on
 * satisfiability (pair-present / resolution-shape / verify-can-fail).
 *
 * METRIC, mechanical, pre-registered: the composed spec's CONSTRAINTS+ACCEPTANCE
 * span contains the normalised QUOTE or a DISCRIMINATING PHRASE (see Fixture.
 * phrases — chosen to be present only when the spec obligates the missing
 * behavior, and asserted ABSENT from the recorded run-16 spec at startup).
 * The verbatim-quote count is recorded alongside for honesty, never used to
 * pass. Framed for ab-verdict as REMOVAL of the OMISSION: baselineHits = reps
 * whose spec OMITS the clause (expected ~all), treatmentHits = omissions
 * surviving treatment (require strict reduction).
 *
 * INVARIANTS: (1) spec-shape validity rate must not fall in treatment (an
 * injected block that breaks compose output is a regression, not a win);
 * (2) spec length must not balloon (>2x baseline mean) — folding one clause in
 * must not rewrite the whole spec.
 *
 * Usage: PI_BIN=$(command -v pi) bun run scripts/live-owned-requirement-compose-ab.ts [REPS=8]
 * Raw:   ~/tmp/owned-req-compose-ab/ab.jsonl (every spec verbatim, re-scorable offline)
 */
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {COMPOSE_PROMPT} from '../src/task/prompts.js'
import {
    buildOwnedRequirementsBlock,
    buildRequirementsBlock,
    readRequirements
} from '../src/task/requirements.js'
import {buildContractsBlock, normalise, readContracts} from '../src/task/contracts.js'
import {stripSpecPreamble, validateSpecShape} from '../src/task/spec-validation.js'
import {runChild} from '../src/task/child-runner.js'
import {reportAb, type Invariant} from './ab-verdict.js'

const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')
const OUT_DIR = path.join(os.homedir(), 'tmp', 'owned-req-compose-ab')
const REPS = Number(process.argv[2] ?? '8')
const TRIAL_TIMEOUT_MS = 15 * 60_000

interface Fixture {
    name: string
    taskFile: string
    quote: string
    anchor: string
    /**
     * DISCRIMINATING PHRASES (normalised-substring). A first cut used loose
     * token sets ({static,dist}+serve verb) and the startup assert caught it
     * cold: the recorded run-16 spec SCORES as carrying the clause because it
     * talks ABOUT static serving ("serveStatic … static file serving") while
     * obligating only index.html — the STAGE-3 prose-token trap. HIT is now:
     * the normalised span contains the normalised QUOTE, or any of these
     * phrases — each chosen to be present only when the spec obligates the
     * MISSING behavior, and asserted absent from the recorded spec at startup.
     */
    phrases: string[]
}

const FIXTURES: Fixture[] = [
    {
        name: 'task8-serve',
        taskFile: 'TASK_0008.md',
        quote: 'serves `/api` + static `dist/`',
        anchor: '9. Build & run',
        // The run-16 defect is assets (bundle.js/app.css) never served; a spec
        // that fixes it must obligate serving dist files beyond index.html.
        phrases: [
            'static `dist/`',
            'static dist',
            'asset',
            'app.css',
            'bundle',
            'static files from dist',
            'files in dist'
        ]
    },
    {
        name: 'task23-hooks',
        taskFile: 'TASK_0023.md',
        quote: 'small hooks for fetch/mutations',
        anchor: '8. Frontend',
        // "hooks" alone is consumer-list noise in the recorded spec ("pages,
        // hooks, components"); only phrases obligating hook CREATION count.
        phrases: ['small hooks', 'hooks for fetch', 'mutation hooks', 'hooks that wrap', 'data hooks']
    }
]

function section(md: string, name: string): string {
    const re = new RegExp(`^## ${name}\\s*$`, 'm')
    const m = re.exec(md)
    if (!m) throw new Error(`section "${name}" not found`)
    const rest = md.slice(m.index + m[0].length)
    const next = /^## /m.exec(rest)
    return (next ? rest.slice(0, next.index) : rest).trim()
}

/** The CONSTRAINTS+ACCEPTANCE span of a composed spec ('' when absent). */
export function constraintsSpan(spec: string): string {
    const from = /^CONSTRAINTS\s*$/m.exec(spec)
    if (!from) return ''
    const tail = spec.slice(from.index)
    const end = /^VERIFY:?\s*$/m.exec(tail)
    return end ? tail.slice(0, end.index) : tail
}

export function scoreClause(spec: string, fx: Fixture): boolean {
    const span = normalise(constraintsSpan(spec))
    if (span.length === 0) return false
    if (span.includes(normalise(fx.quote))) return true
    return fx.phrases.some(p => span.includes(normalise(p)))
}

async function main(): Promise<void> {
    if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
        console.error('REFUSING TO RUN: PI_BIN is unset (fork-bomb guard).')
        process.exit(1)
    }
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error('FATAL: llama-server @ 127.0.0.1:8080 not reachable.')
        process.exit(1)
    }
    await fsp.mkdir(OUT_DIR, {recursive: true})
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'owned-req-ab-'))

    // The run-16 carried blocks, reconstructed from the run's own artifacts so the
    // baseline is the compose run 16 actually performed.
    const contractsBlock = buildContractsBlock(
        await readContracts(MX5).catch(() => '')
    )
    const requirementsBlock = buildRequirementsBlock(await readRequirements(MX5).catch(() => ''))
    const carried = [contractsBlock, requirementsBlock].filter(b => b.length > 0).join('\n')

    interface Prepared extends Fixture {
        refined: string
        research: string
        qa: string
    }
    const prepared: Prepared[] = FIXTURES.map(fx => {
        const md = fs.readFileSync(path.join(MX5, '.pi-tasks', fx.taskFile), 'utf8')
        const recordedSpec = section(md, 'spec')
        if (scoreClause(recordedSpec, fx)) {
            console.error(
                `FIXTURE ${fx.name} CANNOT DISCRIMINATE: the recorded run-16 spec already `
                    + 'carries the clause. Refusing to spend model time.'
            )
            process.exit(1)
        }
        return {
            ...fx,
            refined: section(md, 'refined prompt'),
            research: section(md, 'research'),
            qa: section(md, 'grill Q&A')
        }
    })

    const counts = new Map<string, {omitted: number; valid: number; lens: number[]}>()
    const key = (fx: string, arm: string) => `${fx}:${arm}`
    for (const fx of prepared) {
        for (const arm of ['baseline', 'treatment']) {
            counts.set(key(fx.name, arm), {omitted: 0, valid: 0, lens: []})
        }
    }

    for (let rep = 1; rep <= REPS; rep++) {
        for (const fx of prepared) {
            for (const arm of ['baseline', 'treatment'] as const) {
                const owned =
                    arm === 'treatment' ?
                        buildOwnedRequirementsBlock([
                            {quote: fx.quote, anchor: fx.anchor, title: 'fixture'}
                        ])
                    :   ''
                const blocks = [carried, owned].filter(b => b.length > 0).join('\n')
                const abort = new AbortController()
                const timer = setTimeout(() => abort.abort(), TRIAL_TIMEOUT_MS)
                const started = Date.now()
                let spec = ''
                let err = ''
                try {
                    const r = await runChild(
                        cwd,
                        'read',
                        COMPOSE_PROMPT(fx.refined, fx.research, fx.qa, null, blocks),
                        abort.signal
                    )
                    spec = stripSpecPreamble(r.text)
                    if (r.exitCode !== 0) err = `exit ${r.exitCode}`
                } catch (e) {
                    err = e instanceof Error ? e.message : String(e)
                } finally {
                    clearTimeout(timer)
                }
                const shapeProblem = err ? err : validateSpecShape(spec)
                const valid = shapeProblem === null
                const hit = valid && scoreClause(spec, fx)
                const verbatim = valid && constraintsSpan(spec).includes(fx.quote)
                const c = counts.get(key(fx.name, arm))!
                if (valid) {
                    c.valid += 1
                    c.lens.push(spec.length)
                    if (!hit) c.omitted += 1
                }
                await fsp.appendFile(
                    path.join(OUT_DIR, 'ab.jsonl'),
                    JSON.stringify({
                        rep,
                        fixture: fx.name,
                        arm,
                        valid,
                        shapeProblem,
                        hit,
                        verbatim,
                        ms: Date.now() - started,
                        spec
                    }) + '\n'
                )
                console.log(
                    `rep ${rep} ${fx.name} ${arm}: ${valid ? (hit ? 'CLAUSE-IN-SPEC' : 'OMITTED') : `INVALID (${String(shapeProblem).slice(0, 60)})`}`
                        + `${verbatim ? ' [verbatim]' : ''} ${((Date.now() - started) / 1000).toFixed(0)}s`
                )
            }
        }
    }

    // Verdict per fixture, framed as removal of the OMISSION.
    let worst = 0
    for (const fx of prepared) {
        const b = counts.get(key(fx.name, 'baseline'))!
        const t = counts.get(key(fx.name, 'treatment'))!
        const meanLen = (a: number[]) =>
            a.length === 0 ? 0 : a.reduce((x, y) => x + y, 0) / a.length
        const invariants: Invariant[] = [
            {
                label: 'spec-shape validity did not fall in treatment',
                ok: t.valid >= b.valid - 1,
                detail: `valid baseline ${b.valid}/${REPS} vs treatment ${t.valid}/${REPS}`
            },
            {
                label: 'spec length did not balloon (>2x baseline mean)',
                ok: meanLen(t.lens) <= 2 * Math.max(1, meanLen(b.lens)),
                detail: `mean chars baseline ${meanLen(b.lens).toFixed(0)} vs treatment ${meanLen(t.lens).toFixed(0)}`
            }
        ]
        const code = reportAb({
            name: `owned-requirement compose injection — ${fx.name}`,
            reps: REPS,
            targetShape:
                'a valid composed spec whose CONSTRAINTS/ACCEPTANCE OMIT the owned design clause',
            baselineHits: b.omitted,
            treatmentHits: t.omitted,
            requireTreatmentZero: false,
            invariants
        })
        worst = Math.max(worst, code === 'PASS' ? 0 : code === 'FAIL' ? 1 : 2)
    }
    process.exit(worst)
}

await main()
