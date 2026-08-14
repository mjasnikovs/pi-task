/**
 * REPLAY — mx5 run 21's final-gate resolution loop, and the run-14 control that
 * decides whether 19A may ship at all. Modelled line-for-line on
 * `scripts/replay-run20-final-gate.ts`: real git, a real
 * `runFinalIntegrationGate`, a real `runFinalGateAutofix` seam, a scripted
 * deterministic fix child doing what run 21's attempts did. NO MODEL anywhere.
 *
 * WHAT RUN 21 DID (`~/hub/mx5/.pi-tasks/TASK_AUTO_0001.md`, 2026-08-13):
 *
 *     18:55:50  final-gate FAIL 1/3: boot check: `bun run dev` listens on :3000 but
 *               the rendered body is EMPTY after client JS executed …
 *     19:03:35  final-gate: check DEMOTED to UNOBSERVED after 2 tree-changing
 *               attempts returned an identical failure — carried as debt
 *     19:03:35  final-gate: converged on all remaining checks
 *
 * The verdict was CORRECT and is still reproducible: serve the shipped `dist/` and
 * the gate's own judge returns ok:false on the DOM the bundle renders. The rule
 * that overrode it is `isNonProgress`, whose whole content was string equality —
 * and a deterministic un-fixed defect emits an identical failure BY DEFINITION, so
 * it reads reproducibility as evidence against the instrument.
 *
 * SAY THE 1 OUT LOUD. This is ONE episode in 33 recorded gate runs. 19A is not
 * justified by frequency. It is justified by what the one episode DID: it released
 * a product whose every page was blank and whose every API call 404'd, as a
 * `completed` run with a green trail.
 *
 * ── WHY THIS NEEDS A REPLAY AND NOT A CONSTRUCTION ARGUMENT ────────────────
 * 19B and 19C make their claims strictly SMALLER and cannot invent a fact. 19A
 * does not: REMOVING a demotion can turn a converged run into a failed one. That
 * is a delivery claim. So the control below is the whole lever.
 *
 * ── PRE-REGISTERED VERDICT ────────────────────────────────────────────────
 * exit 0 iff ALL of:
 *   REPLAY FIDELITY  baseline reproduces run 21 — it DEMOTES the observed render
 *                    FAIL and converges, and its trail carries both recorded lines
 *   TREATMENT        does NOT demote, and the run ends FAILED
 *   RUN-14 CONTROL   a boot check on a box with no ss/netstat/lsof still degrades
 *                    to UNOBSERVED, in BOTH arms. If run 14 stops degrading, 19A
 *                    has broken the thing the demote rule was built to protect and
 *                    MUST NOT SHIP.
 *   15A INVARIANT    no fix-pass repair is stranded uncommitted in either arm
 *
 * NEVER run a probe inside ~/hub — every fixture is built in a scratch dir.
 *
 * Run: bun run scripts/replay-run21-final-gate.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {runFinalIntegrationGate, type BootDeps, type FinalGateOutcome} from '../src/task/final-gate.js'
import {runFinalGateAutofix, type FinalFixDeps, type FinalFixResult} from '../src/task/final-gate-fix.js'
import {FINAL_AUTOFIX_LABEL} from '../src/task/final-gate-fix.js'
import {runFinalGateStage, type FinalGateStageDeps, type FinalGateStageResult} from '../src/task/run-final-gate.js'
import {parseTreeChanges} from '../src/task/write-guard.js'
import {makeFakeCtx} from '../src/test-utils/fake-ctx.js'
import {scratchGit as git, scratchRoot, writeFile} from './scratch-repo.js'

const ROOT = scratchRoot('replay-run21-final-gate')

/** The plan text the gate is handed. `serves` trips detectsServedApp, so the boot
 *  check requires a real listener — the run-21 condition. */
const PLAN_TEXT = 'The app serves an HTTP API at /api/listings and a React client.'

/**
 * mx5 run 21's shipped bundle, reduced to the part that decides the verdict: an
 * index.html with an empty mount point and a module script that dies before it can
 * mount. The console error is the REAL one the discarded stderr held —
 * `process is not defined` at main.js — so this fixture also exercises 19B.
 */
const BLANK_INDEX = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>MX5</title></head>
  <body>
    <div id="root"></div>
    <script src="main.js" type="module"></script>
  </body>
</html>
`
const BLANK_MAIN_JS = `const root = document.getElementById('root');
// The run-21 defect, verbatim in shape: a bundler that left a bare \`process\`
// reference in client code. It throws before anything mounts, so the DOM the
// render probe dumps has an EMPTY body.
if (process.env.API_URL) { root.textContent = 'Listings'; }
`

/** A server that listens on the gate's assigned PORT and serves the blank page. */
const SERVER_TS = `import {readFileSync, existsSync} from 'node:fs'
import * as path from 'node:path'
const port = Number(process.env.PORT ?? 3000)
const root = new URL('.', import.meta.url).pathname
const types: Record<string, string> = {'.html': 'text/html', '.js': 'text/javascript'}
Bun.serve({
    port,
    fetch(req) {
        const rel = new URL(req.url).pathname
        const f = path.join(root, rel === '/' ? 'index.html' : rel.replace(/^\\/+/, ''))
        if (!f.startsWith(root) || !existsSync(f)) return new Response('not found', {status: 404})
        const body = readFileSync(f)
        return new Response(body, {
            headers: {
                'content-type': types[path.extname(f)] ?? 'text/plain',
                'content-length': String(body.length)
            }
        })
    }
})
console.log('listening on ' + port)
setTimeout(() => {}, 600_000)
`

/** The run-14 control's server: alive, useful, and NEVER listening. */
const SILENT_TS = `console.log('working…')
setTimeout(() => {}, 600_000)
`

interface FixtureOpts {
    /** Serve the blank page (run 21) or never listen at all (run 14 control). */
    shape: 'blank-render' | 'never-listens'
}

function makeFixture(name: string, opts: FixtureOpts): string {
    const serving = opts.shape === 'blank-render'
    return ROOT.repo(name, {
        files: {
            'package.json':
                JSON.stringify(
                    {
                        name: 'mx5-run21-replay',
                        private: true,
                        type: 'module',
                        scripts: {
                            dev: serving ? 'bun run src/server.ts' : 'bun run src/silent.ts',
                            // A test suite that passes, so the ONLY failure the gate
                            // can report is the boot/render one. That is run 21's
                            // attempt-2 state, where the demotion actually fired.
                            test: "bun -e \"console.log('1 pass 0 fail')\""
                        }
                    },
                    null,
                    4
                ) + '\n',
            ...(serving ?
                {
                    'src/server.ts': SERVER_TS,
                    'src/index.html': BLANK_INDEX,
                    'src/main.js': BLANK_MAIN_JS
                }
            :   {'src/silent.ts': SILENT_TS})
        },
        commit: 'task: client — listings page (TASK_0017)'
    }).dir
}

// ─── arms ────────────────────────────────────────────────────────────────────

interface ArmModules {
    gate: typeof runFinalIntegrationGate
    autofix: (deps: FinalFixDeps) => Promise<FinalFixResult>
    stage: typeof runFinalGateStage
    parse: typeof parseTreeChanges
}

/**
 * The commit that introduced 19A's `observedFailures` channel; its parent is the
 * last tree with the blind compensator still in charge. NEVER `HEAD` while the
 * lever is committed — memory/ab-baseline-ref-must-not-move.md.
 *
 * Before 19A is committed there is no such commit, and the working tree's own HEAD
 * IS the last tree without the lever — which is exactly the baseline.
 */
function baselineRef(): string {
    const r = spawnSync(
        'git',
        ['log', '-S', 'observedFailures', '--format=%H', '--', 'src/task/final-gate.ts'],
        {encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    return sha ? `${sha}^` : 'HEAD'
}

async function baselineModules(): Promise<ArmModules> {
    const dir = ROOT.path('_baseline')
    fs.mkdirSync(dir, {recursive: true})
    const ref = baselineRef()
    const tar = spawnSync('git', ['archive', ref, 'src'], {
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024
    })
    if (tar.status !== 0) throw new Error(`git archive ${ref} src failed`)
    fs.writeFileSync(path.join(dir, 'b.tar'), tar.stdout)
    if (spawnSync('tar', ['-xf', path.join(dir, 'b.tar'), '-C', dir]).status !== 0) {
        throw new Error('tar extract failed')
    }
    const g = (await import(path.join(dir, 'src/task/final-gate.js'))) as {
        runFinalIntegrationGate: ArmModules['gate']
    }
    const f = (await import(path.join(dir, 'src/task/final-gate-fix.js'))) as {
        runFinalGateAutofix: ArmModules['autofix']
    }
    const s = (await import(path.join(dir, 'src/task/run-final-gate.js'))) as {
        runFinalGateStage: ArmModules['stage']
    }
    const w = (await import(path.join(dir, 'src/task/write-guard.js'))) as {
        parseTreeChanges: ArmModules['parse']
    }
    return {
        gate: g.runFinalIntegrationGate,
        autofix: f.runFinalGateAutofix,
        stage: s.runFinalGateStage,
        parse: w.parseTreeChanges
    }
}

const treatmentModules = (): ArmModules => ({
    gate: runFinalIntegrationGate,
    autofix: runFinalGateAutofix,
    stage: runFinalGateStage,
    parse: parseTreeChanges
})

// ─── the run ─────────────────────────────────────────────────────────────────

interface ArmResult {
    trail: string[]
    result: FinalGateStageResult
    firstGate: FinalGateOutcome
    /** Uncommitted paths left behind at the end (15A's invariant: must be none). */
    stranded: string[]
    fixAttempts: number
}

async function runArm(
    name: string,
    mods: ArmModules,
    opts: FixtureOpts & {blindEnumeration?: boolean}
): Promise<ArmResult> {
    const dir = makeFixture(name, opts)
    const handle = makeFakeCtx(dir)
    const trail: string[] = []
    let fixAttempts = 0
    let firstGate: FinalGateOutcome | null = null

    const bootDeps: BootDeps = {
        // The run-14 CONTROL seam: a box where no socket-enumeration tool exists.
        // `b0f90a7` made this return PASS-stamped-UNOBSERVED instead of FAIL, and
        // that must still be true after 19A.
        ...(opts.blindEnumeration === true ? {enumerationCapable: () => false} : {})
    }
    const gate = async (cwd: string): Promise<FinalGateOutcome> => {
        const out = await mods.gate(cwd, 300_000, 6_000, bootDeps, PLAN_TEXT)
        firstGate ??= out
        return out
    }

    /**
     * Run 21's fix child, scripted. It CHANGES the tree on every attempt — which is
     * what makes the attempt "tree-changing" and the demotion eligible — and it does
     * NOT fix the blank page, because run 21's attempts did not either: they went
     * after tests, bundler config and static serving. The defect is deterministic,
     * so the same failure comes back. That is the whole point.
     */
    const runChild = (): Promise<string> => {
        fixAttempts += 1
        writeFile(dir, `notes-attempt-${fixAttempts}.md`, `attempt ${fixAttempts}: adjusted the bundler config\n`)
        writeFile(dir, 'bunfig.toml', `# attempt ${fixAttempts}\n[install]\nexact = true\n`)
        return Promise.resolve('adjusted the bundler config and the static serving path')
    }

    const deps: FinalGateStageDeps = {
        finalGate: cwd => gate(cwd),
        finalGateFix: (_ctx, cwd, failReason) =>
            mods.autofix({
                cwd,
                failReason,
                runChild,
                gate: c => gate(c),
                discoverLabels: () => ['bun run test'],
                discard: c => {
                    git(c, ['checkout', '--', '.'])
                    git(c, ['clean', '-fdq'])
                    return Promise.resolve()
                },
                treeChanges: () =>
                    Promise.resolve(
                        mods.parse(git(dir, ['status', '--porcelain', '--', '.', ':(exclude).pi-tasks']))
                    )
            }),
        pendingChanges: cwd =>
            Promise.resolve(
                git(cwd, ['status', '--porcelain', '--', '.', ':(exclude).pi-tasks'])
                    .split('\n')
                    .map(l => l.slice(3).trim())
                    .filter(l => l.length > 0)
            ),
        commit: cwd => {
            git(cwd, ['add', '-A'])
            const r = spawnSync('git', ['commit', '-q', '-m', 'FINAL GATE AUTOFIX'], {cwd, encoding: 'utf8'})
            return Promise.resolve({committed: r.status === 0})
        },
        record: (_c, _id, line) => {
            trail.push(line)
            return Promise.resolve()
        }
    }

    // Choose AUTOFIX at every prompt, exactly as run 21's YOLO mode did.
    for (let i = 0; i < 6; i++) handle.queueSelect(FINAL_AUTOFIX_LABEL)
    const result = await mods.stage(handle.ctx, deps, {
        cwd: dir,
        runId: 'TASK_AUTO_0001',
        planText: PLAN_TEXT,
        taskCount: 17
    })
    const stranded = git(dir, ['status', '--porcelain', '--', '.', ':(exclude).pi-tasks'])
        .split('\n')
        .map(l => l.slice(3).trim())
        .filter(l => l.length > 0)
    return {
        trail,
        result,
        firstGate: firstGate ?? {ok: true, reason: 'gate never ran'},
        stranded,
        fixAttempts
    }
}

// ─── report ──────────────────────────────────────────────────────────────────

const DEMOTE_MARKER = 'check DEMOTED to UNOBSERVED'
const CONVERGED_MARKER = 'converged on all remaining checks'
const UNOBSERVED_LISTENER_MARKER = 'listener check UNOBSERVED'

function show(label: string, r: ArmResult): void {
    console.log(`  ${label}`)
    console.log(`      first gate ok=${r.firstGate.ok}  fix attempts=${r.fixAttempts}`)
    console.log(`          ${r.firstGate.reason.slice(0, 200).replace(/\n/g, ' | ')}`)
    if (r.firstGate.observedFailures) {
        console.log(`      observedFailures: ${r.firstGate.observedFailures.length}`)
    }
    console.log(`      run outcome: ${r.result.kind}`)
    console.log(`      stranded at end: ${r.stranded.length}`)
    for (const line of r.trail) console.log(`        · ${line.slice(0, 180)}`)
}

async function main(): Promise<void> {
    console.log('REPLAY — mx5 run 21, the whole final-gate resolution loop')
    console.log(`baseline src/ @ ${baselineRef()}`)
    console.log('ONE episode in 33 recorded gate runs. Frequency is not the case for 19A.')
    console.log('')

    const baseMods = await baselineModules()
    const treatMods = treatmentModules()

    console.log('RUN 21 — a served app whose client renders a BLANK page')
    const base = await runArm('run21-baseline', baseMods, {shape: 'blank-render'})
    show('baseline ', base)
    console.log('')
    const treat = await runArm('run21-treatment', treatMods, {shape: 'blank-render'})
    show('treatment', treat)

    console.log('\nRUN-14 CONTROL — a box with no ss/netstat/lsof, app never listens')
    const ctlBase = await runArm('run14-baseline', baseMods, {
        shape: 'never-listens',
        blindEnumeration: true
    })
    show('baseline ', ctlBase)
    console.log('')
    const ctlTreat = await runArm('run14-treatment', treatMods, {
        shape: 'never-listens',
        blindEnumeration: true
    })
    show('treatment', ctlTreat)

    const has = (r: ArmResult, m: string): boolean => r.trail.some(l => l.includes(m))
    const renderFailed = (r: ArmResult): boolean =>
        (r.firstGate.failures ?? [r.firstGate.reason]).some(f => f.includes('rendered body is EMPTY'))

    const checks: Array<[string, boolean]> = [
        // ── replay fidelity: the recorded episode must reproduce in baseline ──
        [
            'FIDELITY baseline: the render probe OBSERVES the blank page and the gate FAILS',
            !base.firstGate.ok && renderFailed(base)
        ],
        ['FIDELITY baseline: the check is DEMOTED to UNOBSERVED', has(base, DEMOTE_MARKER)],
        ['FIDELITY baseline: the run then CONVERGES on the remaining checks', has(base, CONVERGED_MARKER)],
        [
            'FIDELITY baseline: …and the run is announced COMPLETED — the run-21 outcome',
            base.result.kind === 'completed'
        ],

        // ── the lever ──
        [
            'TREATMENT: the same gate still FAILS on the same observed render failure',
            !treat.firstGate.ok && renderFailed(treat)
        ],
        ['TREATMENT: the check is NOT demoted', !has(treat, DEMOTE_MARKER)],
        ['TREATMENT: the run does NOT converge on a demotion', !has(treat, CONVERGED_MARKER)],
        ['TREATMENT: the run ends FAILED', treat.result.kind === 'failed'],
        [
            'TREATMENT: the gate marked the render failure as probe-OBSERVED',
            (treat.firstGate.observedFailures ?? []).some(f => f.includes('rendered body is EMPTY'))
        ],
        [
            'TREATMENT: baseline had no such channel at all (the arms really differ)',
            base.firstGate.observedFailures === undefined
        ],

        // ── the control: 19A must not break what the demote rule protected ──
        [
            'CONTROL baseline: run 14’s condition degrades to UNOBSERVED, not FAIL',
            ctlBase.firstGate.ok || !ctlBase.trail.some(l => l.includes('never opened a listening socket'))
        ],
        [
            'CONTROL treatment: it STILL degrades to UNOBSERVED — 19A did not break it',
            ctlTreat.firstGate.ok || !ctlTreat.trail.some(l => l.includes('never opened a listening socket'))
        ],
        [
            'CONTROL: the UNOBSERVED verdict is the PROBE’s own, in both arms',
            [ctlBase, ctlTreat].every(
                r =>
                    r.trail.some(l => l.includes(UNOBSERVED_LISTENER_MARKER))
                    || r.result.kind === 'completed'
            )
        ],
        [
            'CONTROL: neither arm demotes anything (there was nothing to demote)',
            !has(ctlBase, DEMOTE_MARKER) && !has(ctlTreat, DEMOTE_MARKER)
        ],

        // ── 15A's invariant, in every arm ──
        [
            '15A: no fix-pass repair is left stranded uncommitted in ANY arm',
            [base, treat, ctlBase, ctlTreat].every(r => r.stranded.length === 0)
        ]
    ]

    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
    ROOT.remove()
    const verdict = checks.every(([, ok]) => ok)
    console.log('')
    console.log(`REPLAY 19A: ${verdict ? 'PASS' : 'FAIL'}`)
    if (!verdict) {
        console.log(
            'If the CONTROL is what failed, 19A has broken the condition the demote rule was '
                + 'built to protect and MUST NOT SHIP.'
        )
    }
    process.exit(verdict ? 0 : 1)
}

void main()
