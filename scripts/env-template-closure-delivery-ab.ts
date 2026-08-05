/**
 * A/B-2 for nexttask 10 — the DELIVERY claim. A/B-1 proves the gate NAMES the
 * defect; this asks the only question that matters to the person who clones the
 * repo afterwards:
 *
 *     does `bun run seed` succeed against the COMMITTED tree?
 *
 * Measured by materialising the tree from git alone (tracked files, current
 * content), populating the environment from the TRACKED TEMPLATE ONLY, and
 * running it. mx5 run 19's autofix greened that command by writing `ADMIN_PHONE`
 * / `ADMIN_PASSWORD` into `.env` — gitignored (nexttask 4) — so the shipped tree
 * still could not seed and nothing at run end said why.
 *
 *     baseline    the gate as shipped: `bun run seed` exited 1, and that is all
 *                 the fix child is told.
 *     treatment   + the env-closure findings, ranked first: the template is named
 *                 as the wrong artifact, with the read sites.
 *
 * Both arms run the REAL `runFinalGateAutofix` with a REAL pi child against a
 * REAL clone of mx5 at dfbdd6f, with the full shipped write-guard stack
 * (deletion guard, shrink guard, ignored-path channel). The ONLY difference is
 * the gate the autofix is handed — which is exactly the production difference.
 *
 * Pre-registered metric: seed success on the committed tree.
 *
 *     PASS      treatment ≥ 9/12 vs baseline ≤ 3/12, p < 0.05 (Fisher exact).
 *     FAIL      anything else. Both proportions are reported either way.
 *
 * DISCLOSED NARROWING (the nexttask-4 precedent): the arm gate runs `bun run
 * seed` plus, in the treatment, the env-closure scan — not the whole
 * `runFinalIntegrationGate`. The defect, the metric and the fix child's seed are
 * all about that one command and that one artifact; lint/build/test/boot would
 * add minutes to every gate call in a loop that runs it up to three times per
 * trial and would change nothing the metric reads.
 *
 * DISCLOSED DEPENDENCY: `bun run seed` needs a reachable Postgres — mx5's own dev
 * container at localhost:5432. The harness ABSTAINS if it is absent, never starts
 * or stops a container, and never touches ~/hub (every tree is a CoW clone). The
 * measurement runs `bun run migrate` first: seed refuses to run before the users
 * table exists, and that is a prerequisite of the command, not part of the claim.
 *
 * ONE ATTEMPT PER TRIAL: `runFinalGateAutofix` runs one fix child and one gate
 * re-run per call, which is what the shipped one-attempt-before-accept path does
 * (`memory/yolo-accept-one-attempt-shipped.md`). Both arms get exactly one.
 *
 * DISCLOSED CONDITION: the clone's `.env` is REMOVED. It is gitignored, so it
 * does not exist in any tree anyone clones — leaving this box's copy in place
 * would measure the run-19 autofix's own leftovers.
 *
 * VERDICT (2026-08-05, n=12/arm, ~20 min): **FAIL — by one trial on the baseline
 * ceiling, with the mechanism confirmed.** Recorded unproven; the naming claim
 * (A/B-1) lands, the delivery claim does not.
 *
 *     seed OK on the COMMITTED tree   baseline  4/12   treatment 12/12   p=0.0007
 *     template gained both vars       baseline  4/12   treatment 12/12
 *     wrote a gitignored path         baseline 12/12   treatment  3/12
 *     inv-no-corpus-write HOLDS       inv-metric-from-git-only HOLDS
 *
 * The rule was `treatment ≥ 9/12 AND baseline ≤ 3/12 AND p < 0.05`. Treatment is
 * perfect and p clears by 70×; baseline came in at 4. That is the whole failure.
 * The threshold was NOT re-tuned after the fact — the true baseline is ~33%, not
 * ≤25%, and a rule fitted to data already seen is not a pre-registration.
 *
 * The two supporting rows are the doc's PASS reading verbatim. All 8 baseline
 * seed-FAILs show `changed[]` / `ignored[.env]`: not one tracked file moved, the
 * child papered over the gate with a gitignored `.env`. That is mx5 run 19,
 * reproduced 8 times. Every treatment trial changed `.env.example` and only that.
 *
 * UNREGISTERED FINDING, and the reason wiring is not merely a threshold argument:
 * treatment converged 3/12, and those 3 are EXACTLY the 3 that also wrote `.env`
 * — perfect correlation, no exceptions. `bun run seed` in the working tree reads a
 * real `.env`, so a child that correctly fixes only the template ships a working
 * tree and leaves the gate red. Wired as-is, the RIGHT fix ends the run in
 * FAIL/UNOBSERVED 9 times in 12. Measure that before wiring, do not patch it.
 *
 * INSTRUMENT FAULT, found by the first trial and fixed before the recorded run:
 * `ab-child.log` was written INSIDE the trial tree, where mx5's `.gitignore`
 * (`*.log`) made the harness's own writes register as the CHILD's ignored writes.
 * That pinned row 3 at 12/12 in both arms — the row that tells a clean template
 * fix apart from another `.env` write — so the PASS reading was unreachable by
 * construction. It also fed `gateWithoutIgnored`, downgrading converged PASSes
 * over a file the lever never touches. The log now lives outside the tree.
 *
 *     PI_BIN=$(command -v pi) bun run scripts/env-template-closure-delivery-ab.ts [TRIALS]
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {runFinalGateAutofix, type FinalFixDeps} from '../src/task/final-gate-fix.js'
import {runChild} from '../src/task/child-runner.js'
import {
    collectIgnoredSnapshot,
    collectTreeChanges,
    gatePassesWithoutIgnored
} from '../src/task/gate-deps.js'
import {
    discoverGateCommandLabels,
    discoverGateCommandBodies
} from '../src/task/final-gate.js'
import {findMissingEnvDeclarations, envGateFailureText} from '../src/task/env-template-closure.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'

const HUB = path.join(os.homedir(), 'hub')
const MX5 = path.join(HUB, 'mx5')
const COMMIT = 'dfbdd6f'
const WORK = path.join(os.homedir(), '.cache', 'pi-task-env-delivery-ab')
const CHILD_TIMEOUT_MS = 20 * 60_000
const CMD_TIMEOUT_MS = 3 * 60_000

type Arm = 'baseline' | 'treatment'

interface Trial {
    arm: Arm
    n: number
    /** The gate verdict the fix child was seeded with. */
    seededFailures: number
    /** Did the autofix report convergence? */
    fixOk: boolean
    fixReason: string
    /** Tracked files the child changed. */
    trackedChanged: string[]
    /** Ignored paths the child wrote (the run-19 escape hatch). */
    ignoredWrites: string[]
    /** Did the template gain the two variables? */
    templateDeclares: string[]
    /** THE METRIC. */
    seedOk: boolean
    seedTail: string
    ms: number
}

function sh(
    cwd: string,
    bin: string,
    args: string[],
    timeout = CMD_TIMEOUT_MS
): {status: number | null; out: string} {
    const r = spawnSync(bin, args, {cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024})
    return {status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`}
}

const tail = (s: string, n = 300): string => s.replace(/\s+/g, ' ').trim().slice(-n)

/** A CoW clone of mx5 at the shipped commit, with the gitignored `.env` removed. */
function materialise(dir: string): void {
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(path.dirname(dir), {recursive: true})
    const cp = spawnSync('cp', ['-a', '--reflink=auto', MX5, dir], {encoding: 'utf8'})
    if (cp.status !== 0) throw new Error(`cp failed: ${cp.stderr}`)
    const co = sh(dir, 'git', ['-c', 'advice.detachedHead=false', 'checkout', '--force', COMMIT])
    if (co.status !== 0) throw new Error(`checkout failed: ${co.out}`)
    fs.rmSync(path.join(dir, '.env'), {force: true})
}

/** The arm's gate: `bun run seed`, plus (treatment) the env-closure scan ranked
 *  first — the same text and the same rank the wired gate produces. */
function armGate(arm: Arm) {
    return async (cwd: string): Promise<{ok: boolean; reason: string; failures?: string[]}> => {
        const failures: string[] = []
        if (arm === 'treatment') {
            const env = findMissingEnvDeclarations(cwd)
            for (const m of env.missing) failures.push(envGateFailureText(m, env.templates))
        }
        const seed = sh(cwd, 'bun', ['run', 'seed'])
        if (seed.status !== 0) {
            failures.push(`launch script: \`bun run seed\` exited ${seed.status} — …${tail(seed.out)}`)
        }
        if (failures.length === 0) return {ok: true, reason: 'statics + `bun run seed` passed'}
        return {
            ok: false,
            reason:
                failures.length === 1 ?
                    failures[0]
                :   `${failures.length} failures (ranked, most load-bearing first):\n${failures
                        .map((t, i) => `${i + 1}. ${t}`)
                        .join('\n')}`,
            failures
        }
    }
}

/**
 * THE METRIC. Materialise the tracked tree (current content — the run commits the
 * autofix's repairs), give it the template as its environment and nothing else,
 * and run the command.
 */
function deliverySeed(trialDir: string, measDir: string): {ok: boolean; out: string} {
    fs.rmSync(measDir, {recursive: true, force: true})
    fs.mkdirSync(measDir, {recursive: true})
    // What the RUN would commit: `git add -A` over everything but the task dir
    // (auto-commit's own pathspec). This is what makes a NEW file the fix child
    // wrote — say a `.env.template` it invented — count for the treatment, while
    // `.gitignore` still keeps `.env` out. Staging only; nothing is committed.
    sh(trialDir, 'git', ['add', '-A', '--', '.', ':(exclude).pi-tasks'])
    const ls = sh(trialDir, 'git', ['ls-files', '-z'])
    for (const rel of ls.out.split('\0').filter(p => p.length > 0)) {
        const src = path.join(trialDir, rel)
        const dst = path.join(measDir, rel)
        if (!fs.existsSync(src)) continue
        fs.mkdirSync(path.dirname(dst), {recursive: true})
        fs.copyFileSync(src, dst)
    }
    // node_modules is not tracked anywhere and is not what the claim is about;
    // the clone's own install is linked in so the command can run at all.
    fs.symlinkSync(path.join(trialDir, 'node_modules'), path.join(measDir, 'node_modules'))
    // The environment comes from the TRACKED TEMPLATE and nothing else.
    const template = path.join(measDir, '.env.example')
    if (!fs.existsSync(template)) return {ok: false, out: 'no tracked env template in the shipped tree'}
    fs.copyFileSync(template, path.join(measDir, '.env'))
    const migrate = sh(measDir, 'bun', ['run', 'migrate'])
    if (migrate.status !== 0) return {ok: false, out: `migrate: ${tail(migrate.out)}`}
    const seed = sh(measDir, 'bun', ['run', 'seed'])
    return {ok: seed.status === 0, out: tail(seed.out)}
}

async function runTrial(arm: Arm, n: number): Promise<Trial> {
    const t0 = Date.now()
    const dir = path.join(WORK, `${arm}-t${n}`)
    materialise(dir)
    // OUTSIDE the tree. Written inside it, this log is itself gitignored (`*.log`),
    // so `collectIgnoredSnapshot` counted the harness's own writes as the CHILD's:
    // every trial in both arms reported an ignored write, which is the row that is
    // supposed to tell `.env` apart from a clean template fix, and it also fed
    // `gateWithoutIgnored`, downgrading converged PASSes for a file the lever
    // never touched.
    const logPath = path.join(WORK, `${arm}-t${n}.log`)
    fs.writeFileSync(logPath, '')
    const log = (m: string): void => {
        fs.appendFileSync(logPath, `${new Date().toISOString()} ${m}\n`)
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), CHILD_TIMEOUT_MS)
    const gate = armGate(arm)
    const first = await gate(dir)

    const deps: FinalFixDeps = {
        cwd: dir,
        signal: abort.signal,
        failReason: first.reason,
        runChild: async (tools, prompt, signal) => {
            log(`=== child start (tools=${tools}) ===`)
            const r = await runChild(dir, tools, prompt, signal ?? abort.signal, l => log(l))
            log(`=== child end exit=${r.exitCode} ===`)
            if (r.modelError) throw new Error(`model error: ${r.modelError}`)
            if (r.exitCode !== 0) throw new Error(`child exited ${r.exitCode}: ${r.stderr}`)
            return r.text
        },
        gate,
        discoverLabels: discoverGateCommandLabels,
        discoverBodies: discoverGateCommandBodies,
        treeChanges: () => collectTreeChanges(dir),
        ignoredSnapshot: () => collectIgnoredSnapshot(dir),
        gateWithoutIgnored: paths => gatePassesWithoutIgnored(dir, paths, gate, log),
        log
    }

    let fixOk = false
    let fixReason: string
    let ignoredWrites: string[] = []
    try {
        const res = await runFinalGateAutofix(deps)
        fixOk = res.ok
        fixReason = res.reason ?? ''
        ignoredWrites = res.ignoredWrites ?? []
    } catch (e) {
        fixReason = `THREW: ${e instanceof Error ? e.message : String(e)}`
    } finally {
        clearTimeout(timer)
    }

    const status = sh(dir, 'git', ['status', '--porcelain'])
    const trackedChanged = status.out
        .split('\n')
        .filter(l => l.trim().length > 0 && !l.startsWith('??'))
        .map(l => l.slice(3).trim())
    const templateText = (() => {
        try {
            return fs.readFileSync(path.join(dir, '.env.example'), 'utf8')
        } catch {
            return ''
        }
    })()
    const templateDeclares = ['ADMIN_PHONE', 'ADMIN_PASSWORD'].filter(v =>
        new RegExp(`^\\s*${v}\\s*=`, 'm').test(templateText)
    )
    const delivery = deliverySeed(dir, path.join(WORK, `${arm}-t${n}-committed`))
    return {
        arm,
        n,
        seededFailures: first.failures?.length ?? (first.ok ? 0 : 1),
        fixOk,
        fixReason: tail(fixReason, 160),
        trackedChanged,
        ignoredWrites,
        templateDeclares,
        seedOk: delivery.ok,
        seedTail: delivery.out,
        ms: Date.now() - t0
    }
}

// ── Fisher exact (one-sided), same helper shape the other harnesses use ───────

function logFactorial(n: number): number {
    let s = 0
    for (let i = 2; i <= n; i++) s += Math.log(i)
    return s
}

function fisherOneSided(a: number, b: number, c: number, d: number): number {
    // P(X >= a) for the 2×2 table [[a,b],[c,d]]
    const n = a + b + c + d
    const rowsCols = (x: number, y: number, z: number, w: number): number =>
        Math.exp(
            logFactorial(x + y)
                + logFactorial(z + w)
                + logFactorial(x + z)
                + logFactorial(y + w)
                - logFactorial(n)
                - logFactorial(x)
                - logFactorial(y)
                - logFactorial(z)
                - logFactorial(w)
        )
    let p = 0
    const maxA = Math.min(a + b, a + c)
    for (let i = a; i <= maxA; i++) {
        p += rowsCols(i, a + b - i, a + c - i, d - (i - a))
    }
    return p
}

async function main(): Promise<void> {
    const trials = Number(process.argv[2] ?? 12)
    if (!process.env.PI_BIN) {
        console.error('FATAL: PI_BIN is not set — refusing to run (self-spawn fork-bomb guard).')
        process.exit(1)
    }
    if (!fs.existsSync(MX5)) {
        report({outcome: 'ABSTAIN', lines: ['ABSTAIN — ~/hub/mx5 is not present']})
        return
    }
    // Postgres reachability, checked once, before any model time is spent.
    // A socket that is CLOSED again: `Bun.connect` leaves the connection open, so
    // the probe process outlived its own timeout and the harness ABSTAINed against
    // a Postgres that was up and reachable the whole time.
    const probe = spawnSync(
        'bun',
        [
            '-e',
            'const net=require("net");await new Promise((res,rej)=>{const s=net.connect(5432,"127.0.0.1",()=>{s.end();res()});s.on("error",rej)})'
        ],
        {encoding: 'utf8', timeout: 10_000}
    )
    if (probe.status !== 0) {
        report({
            outcome: 'ABSTAIN',
            lines: ['ABSTAIN — no Postgres at localhost:5432; `bun run seed` cannot be measured']
        })
        return
    }
    fs.mkdirSync(WORK, {recursive: true})

    const results: Trial[] = []
    // Interleaved, so any drift in the model server hits both arms equally.
    for (let n = 1; n <= trials; n++) {
        for (const arm of ['baseline', 'treatment'] as Arm[]) {
            const t = await runTrial(arm, n)
            results.push(t)
            console.log(
                `${arm.padEnd(9)} t${String(n).padStart(2)}  seed ${t.seedOk ? 'OK  ' : 'FAIL'}  `
                    + `fix ${t.fixOk ? 'converged' : 'no       '}  template[${t.templateDeclares.join(',')}]  `
                    + `ignored[${t.ignoredWrites.join(',')}]  ${(t.ms / 1000).toFixed(0)}s`
            )
        }
    }

    const of = (arm: Arm): Trial[] => results.filter(r => r.arm === arm)
    const okOf = (arm: Arm): number => of(arm).filter(r => r.seedOk).length
    const b = okOf('baseline')
    const t = okOf('treatment')
    const p = fisherOneSided(t, trials - t, b, trials - b)
    const templateFixed = (arm: Arm): number =>
        of(arm).filter(r => r.templateDeclares.length === 2).length
    const envWrote = (arm: Arm): number => of(arm).filter(r => r.ignoredWrites.length > 0).length

    const invariants: Invariant[] = [
        {
            label: 'inv-no-corpus-write',
            ok: sh(MX5, 'git', ['rev-parse', 'HEAD']).out.trim().startsWith(COMMIT),
            detail: '~/hub/mx5 still sits at the recorded commit'
        },
        {
            label: 'inv-metric-from-git-only',
            ok: results.every(r => r.seedTail.length > 0 || r.seedOk),
            detail: 'every measurement ran against a tree materialised from tracked files'
        }
    ]

    const outcome: Outcome =
        b === trials ? 'ABSTAIN'
        : t >= Math.ceil(0.75 * trials) && b <= Math.floor(0.25 * trials) && p < 0.05 && invariants.every(i => i.ok) ?
            'PASS'
        :   'FAIL'

    const lines = [
        '',
        '# A/B-2 — env-template closure, DELIVERY (nexttask 10)',
        `mx5@${COMMIT}, n=${trials} per arm, real pi child, real gate loop`,
        '',
        `seed OK on the COMMITTED tree   baseline ${b}/${trials}   treatment ${t}/${trials}   p=${p.toFixed(4)}`,
        `template gained both vars       baseline ${templateFixed('baseline')}/${trials}   treatment ${templateFixed('treatment')}/${trials}`,
        `wrote a gitignored path         baseline ${envWrote('baseline')}/${trials}   treatment ${envWrote('treatment')}/${trials}`,
        '',
        ...results.map(
            r =>
                `  ${r.arm.padEnd(9)} t${String(r.n).padStart(2)}  seed ${r.seedOk ? 'OK' : 'FAIL'}  `
                + `changed[${r.trackedChanged.join(' ')}]  ignored[${r.ignoredWrites.join(' ')}]  ${r.seedTail.slice(-120)}`
        ),
        '',
        ...invariants.map(i => `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'} ${i.label} — ${i.detail}`),
        '',
        `${outcome} — pre-registered: treatment ≥ ${Math.ceil(0.75 * trials)}/${trials}, baseline ≤ ${Math.floor(0.25 * trials)}/${trials}, p < 0.05`,
        `work root ${WORK}`
    ]
    report({outcome, lines})
}

await main()
