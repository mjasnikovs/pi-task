/**
 * STAGE 2 STEP A — FEASIBILITY PROBE for the APIS output-contract lever. ~30 minutes.
 *
 * ── THIS PROBE CANNOT PASS. IT CAN ONLY REFUTE ────────────────────────────────────────────
 *
 * Four reps is far too few to establish anything. Its entire job is to be CHEAP: if the
 * behaviour-query rate under the lever is flat against the measured baseline of 13.3%, that is
 * PROMPT 4 repeating itself, and the finding costs half an hour instead of the three hours a
 * full A/B costs. A non-flat probe is NOT evidence the lever works — it is only permission to
 * spend the three hours. The exit code says so: flat ⇒ non-zero, non-flat ⇒ zero with a banner
 * that refuses the word "pass".
 *
 * ── THE METRIC, DECLARED BEFORE THE RUN ───────────────────────────────────────────────────
 *
 * PRIMARY, and the only one that decides anything here: per rep, did worker:apis issue at
 * least one BEHAVIOUR-class PACKAGE docs query, scored by the COMMITTED `classifyQuery` from
 * scripts/apis-trajectory.ts, unchanged, off the shipped PI_TASK_TYPEONLY_LOG sink. Never
 * model self-report, never "did it stop" — that metric is what made PROMPT 2's p = 0.88
 * unreadable, because the lever it scored could not mechanically move it.
 *
 * MEASURED BASELINE to compare against, from Stage 1 (commit 807ffad, 16 live reps on these
 * same two fixtures, before any lever existed in the build):
 *     reps issuing >= 1 behaviour-class package query    2/15 = 13.3%
 *     behaviour-class share of PACKAGE queries           3/61 =  4.9%
 *     escalation (any search/fetch call)                 0/15 =  0%
 *
 * ── HOW THE LEVER IS INJECTED, AND WHY THAT IS NOT THE SHIPPED PATH ───────────────────────
 *
 * By ASSERTED string surgery into a private dist copy: `APIS_SEMANTICS_CONTRACT` — the exact
 * text src/task/apis-contract.ts exports, imported here rather than retyped, so the probe and
 * the eventual shipped lever cannot drift — is spliced in front of the APIS output-format
 * line. The anchor must occur exactly once or buildPatchedDist throws; a silent no-op would
 * make this probe measure the shipped prompt and report it as the lever, which is the most
 * expensive possible failure because it looks like a result.
 *
 * Nothing is wired into src/ at this step. That ordering is the point of the whole file this
 * work sits under: measure, then implement.
 *
 * ── CONDITIONS ────────────────────────────────────────────────────────────────────────────
 *
 * Real phaseResearch on each task's own run-15 checkpoint tree, shipped model, shipped tools,
 * shipped docs worker. Only the NETWORK is replaced, by the offline fixture web PROMPT 4 built
 * (scripts/spec-url-fixtures.ts) — so a multi-hour comparison cannot be moved by page drift or
 * by a slow host, and so the positive control below is available at all. The fetch/search
 * stubs record the request BEFORE attempting it, so the secondary metric counts what the
 * worker ASKED FOR, which is the thing the lever could move.
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/live-apis-contract-probe.ts [REPS_PER_FIXTURE]
 * Re-score a completed probe offline, no model time:
 *   PROBE_DIR=~/tmp/apis-contract-probe bun run scripts/live-apis-contract-probe.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {APIS_SEMANTICS_CONTRACT} from '../src/task/apis-contract.js'
import {RESEARCH_RUN_ID_ENV} from '../src/workers/research-cache.js'
import {TYPEONLY_LOG_ENV, readTypeOnlyLog, type TypeOnlyLogRecord} from '../src/workers/typeonly-log.js'
import {runWorker} from '../src/workers/pi-worker-core.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'
import {buildPatchedDist, stubSearchExtension} from './spec-url-dist.js'
import {
    FIXTURES,
    CALLS_LOG_ENV,
    assertFetchToolReachable,
    buildFixtureTree,
    writeStubExtension,
    fetchedUrls,
    searchQueries
} from './spec-url-fixtures.js'
import {extractSection, parseTrajectory} from './apis-trajectory.js'
import {countSemantics, isBehaviourPackageQuery, packageQueryKinds} from './apis-semantics.js'
import {CONTRACT_MARKER, SPLICE_CONTRACT, assertContractInPrompt} from './apis-contract-surgery.js'
import {requirePreconditions} from './ab-preflight.js'

const REPS_PER_FIXTURE = Number(process.argv[2] ?? '2')
/** `||`, not `??`, and absolute: a set-but-empty PROBE_DIR is not nullish, and the sink path
 * is read by code running inside the pi child, whose cwd is the trial tree. That exact pair
 * of mistakes once produced a complete, plausible report off ZERO recorded answers. */
const ROOT = path.resolve(process.env.PROBE_DIR || path.join(os.homedir(), 'tmp', 'apis-contract-probe'))
const TRIAL_TIMEOUT_MS = 45 * 60_000

/** Stage 1, commit 807ffad. Quoted in the banner so the comparison is on screen, not in a file. */
const STAGE1 = {repsWithBehaviour: 2, reps: 15, behaviourPkgQueries: 3, pkgQueries: 61} as const

interface Rep {
    fixture: string
    rep: number
    answers: TypeOnlyLogRecord[]
    /** Package-query kinds by the committed classifier. */
    kinds: ReturnType<typeof packageQueryKinds>
    /** PRIMARY: >= 1 behaviour-class package docs query. */
    behaviourHit: boolean
    /** SECONDARY, reported only: any search or fetch call. */
    escalated: boolean
    fetches: string[]
    searches: string[]
    docsCalls: number
    apisSection: string
    semantics: ReturnType<typeof countSemantics>
    /** Proof the surgery held THIS rep: the contract text present in the assembled prompt. */
    contractInPrompt: boolean
    minutes: number
    error?: string
}

const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`)
const PROMPT_DUMP_ENV = 'PI_TASK_PROMPT_DUMP'

async function runReps(): Promise<Rep[]> {
    await requirePreconditions('live-apis-contract-probe', {model: {}, piBin: true, cacheOff: true})
    fs.mkdirSync(ROOT, {recursive: true})
    const stub = writeStubExtension(ROOT)
    const dist = buildPatchedDist('apis-contract-probe', [
        stubSearchExtension(stub),
        SPLICE_CONTRACT,
        {
            // Observation only — dumps every assembled worker prompt, so "the contract reached
            // the prompt" is checked per rep against the real assembled text rather than
            // inferred from the fact that a string replacement ran at startup.
            file: 'task/phases.js',
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
    // Prove the splice took effect against the LOADED module's assembled prompt, not against
    // the fact that a string replacement ran. The payload is escaped for a template-literal
    // context; a mangled escape would leave a dist that patches cleanly and assembles wrongly.
    const assembled = await assertContractInPrompt(dist, true)
    const {phaseResearch} = (await import(path.join(dist, 'task', 'phases.js'))) as typeof import('../dist/task/phases.js')

    // Before spending model time on how often the worker escalates, prove it CAN reach the
    // tool. An extension that fails to load leaves NO error — the run would read zero and look
    // like a clean null result about the model.
    await assertFetchToolReachable(ROOT, buildFixtureTree(ROOT, FIXTURES[0], 0), runWorker)

    console.log(
        `live-apis-contract-probe — STAGE 2 STEP A (feasibility only; this cannot pass)\n`
            + `model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, real phaseResearch, offline web\n`
            + `${REPS_PER_FIXTURE} reps x ${FIXTURES.length} fixtures, lever spliced into a patched dist\n`
            + `baseline to beat (Stage 1, 807ffad): ${STAGE1.repsWithBehaviour}/${STAGE1.reps} reps `
            + `= ${pct(STAGE1.repsWithBehaviour, STAGE1.reps)} behaviour-class package queries\n`
            + `assembled APIS prompt ${assembled.length} chars, contract ${APIS_SEMANTICS_CONTRACT.length} chars\n`
            + `--- the spliced contract, verbatim ---\n${APIS_SEMANTICS_CONTRACT}\n---`
    )

    const reps: Rep[] = []
    for (let t = 1; t <= REPS_PER_FIXTURE; t++) {
        for (const f of FIXTURES) {
            const dir = path.resolve(buildFixtureTree(ROOT, f, t))
            const sink = path.join(dir, 'answers.jsonl')
            const calls = path.join(dir, 'calls.log')
            const dump = path.join(dir, 'prompts.txt')
            for (const p of [sink, calls, dump]) fs.rmSync(p, {force: true})
            process.env[TYPEONLY_LOG_ENV] = sink
            process.env[CALLS_LOG_ENV] = calls
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
            const answers = readTypeOnlyLog(read(sink))
            const section = extractSection(research, 'APIS')
            const apisPrompt = read(dump).split('===== ').find(s => s.startsWith('worker:apis')) ?? ''
            const rep: Rep = {
                fixture: f.name,
                rep: t,
                answers,
                kinds: packageQueryKinds(answers),
                behaviourHit: answers.some(isBehaviourPackageQuery),
                escalated: fetchedUrls(calls).length + searchQueries(calls).length > 0,
                fetches: fetchedUrls(calls),
                searches: searchQueries(calls),
                docsCalls: parseTrajectory(read(logPath)).filter(s => s.tool === 'pi-worker-docs').length,
                apisSection: section,
                semantics: countSemantics(section),
                contractInPrompt: apisPrompt.includes(CONTRACT_MARKER),
                minutes: (Date.now() - started) / 60000,
                ...(error ? {error} : {})
            }
            reps.push(rep)
            console.log(
                `  ${f.name} rep ${t}/${REPS_PER_FIXTURE}: docs=${rep.docsCalls} `
                    + `pkgQ=${rep.kinds.total} behaviourQ=${rep.kinds.behaviour} `
                    + `${rep.behaviourHit ? 'PRIMARY-HIT' : 'primary-miss'} `
                    + `esc=${rep.escalated ? 'yes' : 'no'} entries=${rep.semantics.entries} `
                    + `sem=${rep.semantics.withSemantics}(${rep.semantics.unverified}unv) `
                    + `contract=${rep.contractInPrompt ? 'ok' : 'MISSING'} [${rep.minutes.toFixed(1)}m]`
                    + (error ? `  ERROR ${error}` : '')
            )
            fs.writeFileSync(path.join(ROOT, 'probe.json'), JSON.stringify(reps), 'utf8')
        }
    }
    return reps
}

function loadReps(): Rep[] {
    const saved = path.join(ROOT, 'probe.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: PROBE_DIR set but ${saved} does not exist.`)
        process.exit(1)
    }
    console.log(`live-apis-contract-probe — RE-SCORING ${saved} (no model time)`)
    return JSON.parse(fs.readFileSync(saved, 'utf8')) as Rep[]
}

function main(reps: Rep[]): void {
    // The lever can only act on a rep that asked about a package at all. A rep with zero
    // package queries is not evidence against it; it is a rep where the precondition never
    // arose, and folding it in would dilute the rate with reps the lever could not reach.
    const witnessed = reps.filter(r => r.kinds.total > 0)
    const hits = reps.filter(r => r.behaviourHit)
    const pkg = reps.reduce((a, r) => a + r.kinds.total, 0)
    const pkgBehaviour = reps.reduce((a, r) => a + r.kinds.behaviour, 0)

    console.log(`\n=== PRIMARY — reps issuing >= 1 BEHAVIOUR-class PACKAGE docs query ===`)
    for (const f of [...FIXTURES.map(x => x.name), 'POOLED']) {
        const rs = f === 'POOLED' ? reps : reps.filter(r => r.fixture === f)
        console.log(
            `  ${f.padEnd(14)} ${rs.filter(r => r.behaviourHit).length}/${rs.length}`
                + `   package queries ${rs.reduce((a, r) => a + r.kinds.behaviour, 0)}/${rs.reduce((a, r) => a + r.kinds.total, 0)} behaviour`
        )
    }
    console.log(
        `  PROBE   reps ${hits.length}/${reps.length} = ${pct(hits.length, reps.length)}`
            + `   package queries ${pkgBehaviour}/${pkg} = ${pct(pkgBehaviour, pkg)}`
    )
    console.log(
        `  STAGE 1 reps ${STAGE1.repsWithBehaviour}/${STAGE1.reps} = ${pct(STAGE1.repsWithBehaviour, STAGE1.reps)}`
            + `   package queries ${STAGE1.behaviourPkgQueries}/${STAGE1.pkgQueries} = ${pct(STAGE1.behaviourPkgQueries, STAGE1.pkgQueries)}`
    )

    console.log(`\n=== SECONDARY (reported, never used to decide) — escalation ===`)
    console.log(
        `  reps calling search or fetch at all  ${reps.filter(r => r.escalated).length}/${reps.length}`
            + `   (Stage 1: 0/15)   fetch requests ${reps.reduce((a, r) => a + r.fetches.length, 0)}`
            + `   search requests ${reps.reduce((a, r) => a + r.searches.length, 0)}`
    )

    console.log(`\n=== OUTPUT SIDE — did the contract change the artifact? ===`)
    const entries = reps.reduce((a, r) => a + r.semantics.entries, 0)
    const withSem = reps.reduce((a, r) => a + r.semantics.withSemantics, 0)
    const unv = reps.reduce((a, r) => a + r.semantics.unverified, 0)
    console.log(
        `  entries ${entries} (mean ${(entries / Math.max(1, reps.length)).toFixed(1)}/rep, `
            + `Stage 1 baseline 18.5)   with SEMANTICS field ${withSem} = ${pct(withSem, entries)}`
            + `   of those UNVERIFIED ${unv} = ${pct(unv, Math.max(1, withSem))}`
    )
    console.log(`  mean minutes/rep ${(reps.reduce((a, r) => a + r.minutes, 0) / Math.max(1, reps.length)).toFixed(1)} (Stage 1 ~3.5)`)

    console.log(`\n=== EVERY PACKAGE QUERY THIS PROBE ISSUED (the metric, auditable by hand) ===`)
    for (const r of reps) {
        for (const a of r.answers.filter(x => x.module !== '.')) {
            console.log(
                `  ${isBehaviourPackageQuery(a) ? 'BEHAVIOUR' : '         '} ${r.fixture} r${r.rep} `
                    + `[${a.module}] ${a.query.replace(/\s+/g, ' ').slice(0, 110)}`
            )
        }
    }
    console.log(`\n  raw data: ${path.join(ROOT, 'probe.json')}`)

    const invariants: Invariant[] = [
        {
            label: 'research cache OFF (else later reps replay the first rep answers)',
            ok: !process.env[RESEARCH_RUN_ID_ENV],
            detail: `${RESEARCH_RUN_ID_ENV} unset`
        },
        {
            label: 'the lever REACHED the assembled APIS prompt in every rep',
            ok: reps.every(r => r.contractInPrompt),
            detail: `${reps.filter(r => r.contractInPrompt).length}/${reps.length} reps`
        },
        {
            label: 'the answer sink recorded package queries to score',
            ok: pkg > 0,
            detail: `${pkg} package queries over ${reps.length} reps`
        },
        {
            label: 'no rep errored out',
            ok: reps.every(r => !r.error),
            detail: `${reps.filter(r => r.error).length} errored`
        }
    ]
    const broken = invariants.filter(i => !i.ok)

    const lines = [
        '',
        '=== PROBE VERDICT: live-apis-contract-probe (STEP A) ===',
        `  PRIMARY  ${hits.length}/${reps.length} reps vs Stage-1 baseline ${STAGE1.repsWithBehaviour}/${STAGE1.reps}`,
        `  package-query behaviour share ${pkgBehaviour}/${pkg} vs Stage-1 ${STAGE1.behaviourPkgQueries}/${STAGE1.pkgQueries}`,
        ...invariants.map(i => `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`)
    ]

    let outcome: Outcome
    if (witnessed.length === 0 || broken.length > 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — THIS PROBE PROVED NOTHING ***',
            witnessed.length === 0 ?
                'No rep asked a package question at all, so the lever had nothing to act on.'
            :   `Broken invariant(s): ${broken.map(i => i.label).join('; ')}`,
            'Fix the harness before reading any number above.'
        )
    } else if (hits.length === 0) {
        outcome = 'FAIL'
        lines.push(
            '',
            '*** REFUTED — THE RATE IS FLAT ***',
            `${witnessed.length} rep(s) asked about a package and NOT ONE asked a behaviour`,
            'question. That is PROMPT 4 repeating: the model reads the instruction and does not',
            'act on it. Do NOT talk past this and do NOT spend three hours on the A/B. Record the',
            'refutation with these numbers and go to STEP E.'
        )
    } else {
        outcome = 'PASS'
        lines.push(
            '',
            '*** NOT REFUTED — THIS IS NOT A PASS ***',
            `${hits.length}/${reps.length} reps issued a behaviour-class package query against a`,
            `baseline of ${STAGE1.repsWithBehaviour}/${STAGE1.reps}. At n=${reps.length} that is far too few reps to`,
            'establish anything: the only claim licensed here is that the lever is NOT obviously',
            'inert, i.e. that the three hours STEP D costs are worth spending. The verdict comes',
            'from STEP D and from nothing else.'
        )
    }
    report({outcome, lines})
}

if (process.env.PROBE_DIR) {
    main(loadReps())
} else {
    runReps()
        .then(main)
        .catch(e => {
            console.error(e)
            process.exit(1)
        })
}
