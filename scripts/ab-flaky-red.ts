/**
 * A/B for the confirmed red (confirmingRunner) and the quiet-row blame (isQuietTestRow).
 *
 * The defect, from mx5-n TASK_0055: one component run of 55 failed once, the run
 * context cached that red by tree hash, and the checkpoint, the repair's own gate
 * and the next task's baseline all read it again without a run. The repair it
 * spliced was blamed on every spec file the runner's pass rows named.
 *
 * Arm A loads the gate code from the commit before the fix, arm B from this tree.
 *
 * Part 1, live. Real `bun test` suites in scratch git repos, driven through the
 * production `gateRepoHealth` under one open run context, asked four times on one
 * tree, as mx5-n asked: the task's own gate, the checkpoint, the repair's gate, the
 * next baseline. A trial counts the asks that read red.
 *   flaky  one test fails on a real coin, FLAKE of the time
 *   red    one test always fails   (control: B must stay red on every ask)
 *   green  every test passes       (control: both arms clean)
 * Order is ABBA by trial index.
 *
 * Part 2, replay. Real runner outputs through both arms' capture + healthReds and
 * classifyCommandRun: the three-file runs (test/task/__fixtures__/runner-multi-file.json),
 * the single-file runner reports, and every non-zero bash output of a recorded
 * mx5-n run. Blame is scored against the file that failed; every verdict flip and
 * every blame change outside the three-file runs is printed.
 *
 * Verdict: ABSTAIN (exit 2) when arm A never read the flaky suite red. PASS (exit 0)
 * when B's red trials drop with one-sided Fisher p < 0.05, both controls hold, B
 * blames exactly the failing file in every three-file run, and no classifier verdict
 * flips. FAIL (exit 1) otherwise.
 *
 * Usage:
 *   bun run scripts/ab-flaky-red.ts <scratch-dir> [sessions-dir] [trials=60]
 */
import {spawnSync} from 'node:child_process'
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    symlinkSync,
    writeFileSync
} from 'node:fs'
import * as path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const FLAKE = 0.25
const ASKS = ['task gate', 'checkpoint', 'repair gate', 'next baseline']

type Arm = 'A' | 'B'
type Mods = {
    gate: typeof import('../src/task/gate-deps.js')
    rc: typeof import('../src/task/run-context.js')
    health: typeof import('../src/task/repo-health-check.js')
    repair: typeof import('../src/task/health-repair.js')
    run: typeof import('../src/task/command-run.js')
}

function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8'})
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
}

/** The commit before the one that added the lever: stays right once the fix is committed. */
function baselineRef(): string {
    const added = git(
        REPO,
        'log',
        '--format=%H',
        '-S',
        'export function confirmingRunner',
        '--',
        'src/task/command-run.ts'
    )
        .split('\n')
        .filter(Boolean)
        .at(-1)
    return added ? `${added}^` : 'HEAD'
}

function baselineTree(scratch: string): string {
    const ref = baselineRef()
    const sha = git(REPO, 'rev-parse', ref)
    const dir = path.join(scratch, `baseline-${sha.slice(0, 7)}`)
    if (!existsSync(dir)) {
        git(REPO, 'worktree', 'add', '-q', '--detach', dir, sha)
        symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'))
    }
    console.log(`arm A: ${ref} = ${sha.slice(0, 7)}   arm B: working tree`)
    return dir
}

async function load(root: string): Promise<Mods> {
    const at = (m: string) => import(path.join(root, 'src/task', m))
    return {
        gate: await at('gate-deps.ts'),
        rc: await at('run-context.ts'),
        health: await at('repo-health-check.ts'),
        repair: await at('health-repair.ts'),
        run: await at('command-run.ts')
    }
}

function suite(scratch: string, kind: 'flaky' | 'red' | 'green'): string {
    const dir = path.join(scratch, `suite-${kind}`)
    if (existsSync(dir)) return dir
    mkdirSync(path.join(dir, 'test'), {recursive: true})
    writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({name: kind, private: true, scripts: {test: 'bun test'}}, null, 2)
    )
    const last =
        kind === 'flaky' ? `expect(Math.random() >= ${FLAKE}).toBe(true)`
        : kind === 'red' ? 'expect(1 + 1).toBe(3)'
        : 'expect(2).toBe(2)'
    writeFileSync(
        path.join(dir, 'test/alpha.test.ts'),
        "import {test, expect} from 'bun:test'\ntest('alpha', () => expect(1).toBe(1))\n"
    )
    writeFileSync(
        path.join(dir, 'test/beta.test.ts'),
        `import {test, expect} from 'bun:test'\ntest('beta', () => ${last})\n`
    )
    git(dir, 'init', '-q')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=ab', '-c', 'user.email=ab@local', 'commit', '-qm', 'suite')
    return dir
}

/** Red asks out of the four, on one tree, in one run context. */
async function trial(m: Mods, cwd: string): Promise<number> {
    const rc = m.rc.openRunContext(cwd)
    try {
        let red = 0
        for (const _ of ASKS) if (!(await m.gate.gateRepoHealth(cwd)).ok) red++
        return red
    } finally {
        m.rc.closeRunContext(rc)
    }
}

function fisherOneSided(aHit: number, aN: number, bHit: number, bN: number): number {
    const logF = (n: number): number => {
        let s = 0
        for (let i = 2; i <= n; i++) s += Math.log(i)
        return s
    }
    const total = aHit + bHit
    const N = aN + bN
    const p = (x: number): number =>
        Math.exp(
            logF(aN)
                + logF(bN)
                + logF(total)
                + logF(N - total)
                - logF(N)
                - logF(x)
                - logF(aN - x)
                - logF(total - x)
                - logF(bN - total + x)
        )
    let sum = 0
    for (let x = aHit; x <= Math.min(aN, total); x++) if (total - x <= bN) sum += p(x)
    return sum
}

async function live(arms: Record<Arm, Mods>, scratch: string, trials: number, ledger: string) {
    const counts: Record<string, Record<Arm, number[]>> = {}
    for (const kind of ['flaky', 'red', 'green'] as const) {
        const cwd = suite(scratch, kind)
        const n = kind === 'flaky' ? trials : Math.max(4, Math.round(trials / 6))
        counts[kind] = {A: [], B: []}
        for (let i = 0; i < n; i++) {
            const order: Arm[] = i % 4 === 0 || i % 4 === 3 ? ['A', 'B'] : ['B', 'A']
            for (const arm of order) {
                const t0 = Date.now()
                const red = await trial(arms[arm], cwd)
                counts[kind][arm].push(red)
                appendFileSync(
                    ledger,
                    JSON.stringify({kind, arm, index: i, red, ms: Date.now() - t0}) + '\n'
                )
            }
        }
    }
    return counts
}

type Replay = {
    what: string
    status: number
    stdout: string
    stderr: string
    tracked?: string[]
    failing?: string
}

function realOutputs(sessionsDir: string | undefined): Replay[] {
    type Output = Omit<Replay, 'what'>
    const reports = JSON.parse(
        readFileSync(path.join(REPO, 'test/task/__fixtures__/runner-reports.json'), 'utf8')
    ) as {
        runners: Array<{runner: string; failing: Output; passing: Output}>
        greenExitZero: Array<Output & {what: string}>
        variants: Array<{what: string; failing: Output}>
    }
    const out: Replay[] = []
    for (const r of reports.runners) {
        out.push({what: `${r.runner} failing`, ...r.failing})
        out.push({what: `${r.runner} passing`, ...r.passing})
    }
    for (const r of reports.greenExitZero) out.push(r)
    for (const r of reports.variants) out.push({what: r.what, ...r.failing})
    if (!sessionsDir) return out
    for (const f of readdirSync(sessionsDir).filter(n => n.endsWith('.jsonl'))) {
        for (const line of readFileSync(path.join(sessionsDir, f), 'utf8').split('\n')) {
            if (!line.includes('"toolResult"')) continue
            const e = JSON.parse(line) as {
                message?: {role?: string; toolName?: string; content?: Array<{text?: string}>}
            }
            if (e.message?.role !== 'toolResult' || e.message.toolName !== 'bash') continue
            const text = (e.message.content ?? []).map(c => c.text ?? '').join('\n')
            const m = /\n*Command exited with code (\d+)\s*$/.exec(text)
            if (!m) continue
            out.push({
                what: `mx5-n ${f.slice(0, 19)}`,
                status: Number(m[1]),
                stdout: text.slice(0, m.index),
                stderr: ''
            })
        }
    }
    return out
}

function blame(m: Mods, r: Replay, tracked: string[]): string[] {
    const output = m.health.captureHealthOutput(r.stdout, r.stderr)
    const health = {
        ok: false,
        reason: 'red',
        ecosystem: 'node',
        commands: [
            {
                cmd: 'test',
                outcome: 'fail' as const,
                exitCode: r.status,
                kind: 'test' as const,
                output
            }
        ],
        output
    }
    return m.repair.healthReds(health, '/work', tracked)[0]?.files ?? []
}

function replay(arms: Record<Arm, Mods>, sessionsDir: string | undefined) {
    const multi = JSON.parse(
        readFileSync(path.join(REPO, 'test/task/__fixtures__/runner-multi-file.json'), 'utf8')
    ) as {
        runs: Required<Replay>[]
    }
    const exact: Record<Arm, number> = {A: 0, B: 0}
    for (const r of multi.runs) {
        const a = blame(arms.A, r, r.tracked)
        const b = blame(arms.B, r, r.tracked)
        const ok = (f: string[]) => f.length === 1 && f[0] === r.failing
        if (ok(a)) exact.A++
        if (ok(b)) exact.B++
        console.log(`  ${r.what.padEnd(22)} A ${JSON.stringify(a)}  B ${JSON.stringify(b)}`)
    }
    const corpus = realOutputs(sessionsDir)
    let flips = 0
    let blameChanged = 0
    for (const r of corpus) {
        const run = {failedToStart: false, status: r.status, stdout: r.stdout, stderr: r.stderr}
        for (const opts of [{}, {emptySuite: true}]) {
            const a = arms.A.run.classifyCommandRun(run, [], opts)
            const b = arms.B.run.classifyCommandRun(run, [], opts)
            if (JSON.stringify(a) !== JSON.stringify(b)) {
                flips++
                console.log(`  FLIP ${r.what}: ${a.outcome} → ${b.outcome}`)
            }
        }
        // Every repo-relative path the output names counts as tracked, so a dropped name shows.
        const named = [...`${r.stdout}\n${r.stderr}`.matchAll(/(?:[\w.@-]+\/)+[\w.@-]+\.\w+/g)].map(
            x => x[0].replace(/^\/work\/|^\/workspace\//, '')
        )
        const a = blame(arms.A, r, named)
        const b = blame(arms.B, r, named)
        if (JSON.stringify(a) !== JSON.stringify(b)) {
            blameChanged++
            console.log(`  BLAME ${r.what}: A ${JSON.stringify(a)} → B ${JSON.stringify(b)}`)
        }
    }
    return {exact, n: multi.runs.length, corpus: corpus.length, flips, blameChanged}
}

async function main(): Promise<void> {
    const [scratchArg, sessionsDir, trialsArg] = process.argv.slice(2)
    if (!scratchArg) throw new Error('usage: ab-flaky-red.ts <scratch-dir> [sessions-dir] [trials]')
    const scratch = path.resolve(scratchArg)
    mkdirSync(scratch, {recursive: true})
    const trials = Number(trialsArg ?? 60)
    const arms: Record<Arm, Mods> = {A: await load(baselineTree(scratch)), B: await load(REPO)}
    const ledger = path.join(scratch, `ledger-${Date.now()}.jsonl`)

    console.log('\nPart 2 — replay over real runner output')
    const rp = replay(arms, sessionsDir)

    console.log(`\nPart 1 — live, ${ASKS.length} asks per trial on one tree (${ASKS.join(', ')})`)
    const c = await live(arms, scratch, trials, ledger)
    const redTrials = (xs: number[]) => xs.filter(x => x > 0).length
    const asks = (xs: number[]) => xs.reduce((s, x) => s + x, 0)
    for (const kind of Object.keys(c))
        for (const arm of ['A', 'B'] as const)
            console.log(
                `  ${kind.padEnd(5)} ${arm}: red trials ${redTrials(c[kind][arm])}/${c[kind][arm].length}, red asks ${asks(c[kind][arm])}/${c[kind][arm].length * ASKS.length}`
            )

    const fl = c.flaky
    const p = fisherOneSided(redTrials(fl.A), fl.A.length, redTrials(fl.B), fl.B.length)
    const redHeld = (['A', 'B'] as const).every(
        a => asks(c.red[a]) === c.red[a].length * ASKS.length
    )
    const greenHeld = (['A', 'B'] as const).every(a => asks(c.green[a]) === 0)
    console.log(
        `\n  flaky red trials A ${redTrials(fl.A)} → B ${redTrials(fl.B)}, one-sided Fisher p=${p.toPrecision(3)} (unpaired, independent trials)`
    )
    console.log(`  controls: red stays red ${redHeld}, green stays green ${greenHeld}`)
    console.log(
        `  blame exact on three-file runs: A ${rp.exact.A}/${rp.n}, B ${rp.exact.B}/${rp.n}`
    )
    console.log(
        `  replay corpus ${rp.corpus} real outputs: ${rp.flips} verdict flips, ${rp.blameChanged} blame changes`
    )
    console.log(`  ledger ${ledger}`)

    if (redTrials(fl.A) === 0) {
        console.log('ABSTAIN — arm A never read the flaky suite red; the lever was not exercised')
        process.exit(2)
    }
    const pass = p < 0.05 && redHeld && greenHeld && rp.exact.B === rp.n && rp.flips === 0
    console.log(pass ? 'PASS' : 'FAIL')
    process.exit(pass ? 0 : 1)
}

if (import.meta.main) await main()
