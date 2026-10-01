/**
 * A/B for the off-tree pass: a final-gate autofix that changes nothing in the
 * repository, yet the gate it re-runs passes.
 *
 * The defect, from mx5-n TASK_AUTO_0001: the gate failed because `docker` was not
 * installed. The fix pass wrote a fake `docker` into a PATH directory outside the
 * repo and created a database by hand. The gate re-ran green, the trail said
 * "autofix converged", and the commit held no code change. A fresh clone fails the
 * same way.
 *
 * Every trial builds a scratch git repo whose `test` script runs `node check.js`,
 * then drives `runFinalGateAutofix` with the production gate, guards and helpers.
 * Only the fix child is scripted:
 *   off-tree    check.js needs a CLI that is not installed; the child writes a stub
 *               of it into a directory on PATH, outside the repo
 *   lint-fix    check.js rewrites a tracked file itself, then needs the CLI; the
 *               child writes only the stub, so the re-run starts on the tree the
 *               failing gate left behind
 *   repo-fix    check.js has a bug; the child fixes the file             (control)
 *   no-op       check.js has a bug; the child does nothing               (control)
 *   gate-edits  check.js regenerates a tracked file and fails; the child does
 *               nothing; the re-run passes on the regenerated file   (reported:
 *               flagged, since only the failing gate changed the repository)
 *   mixed       the stub, plus an unrelated README edit in the repo   (reported:
 *               any repo change gives the pass a new tree, so it is credited)
 * Both arms get the failing gate and the production deps from arm B (the gate
 * there also names the tree it judged); arm A ignores the fields it predates, so
 * only the decision code differs.
 * Order is ABBA by trial index.
 *
 * Scored per trial: credited = the fix result is ok with no UNOBSERVED note.
 * Verdict: ABSTAIN (exit 2) when arm A never credits an off-tree pass. PASS
 * (exit 0) when B credits no off-tree and no lint-fix trial (one-sided Fisher
 * p < 0.05 each), and both arms credit every repo-fix trial and no no-op trial.
 * FAIL (exit 1) otherwise.
 *
 * Usage:
 *   bun run scripts/ab-off-tree-pass.ts <scratch-dir> [trials=10]
 */
import {spawnSync} from 'node:child_process'
import {
    appendFileSync,
    chmodSync,
    existsSync,
    mkdirSync,
    rmSync,
    symlinkSync,
    writeFileSync
} from 'node:fs'
import * as path from 'node:path'

const REPO = path.resolve(import.meta.dir, '..')
const SCENARIOS = ['off-tree', 'lint-fix', 'repo-fix', 'no-op', 'gate-edits', 'mixed'] as const
type Scenario = (typeof SCENARIOS)[number]
type Arm = 'A' | 'B'
type Mods = {
    fix: typeof import('../src/task/final-gate-fix.js')
    gate: typeof import('../src/task/final-gate.js')
    deps: typeof import('../src/task/gate-deps.js')
}

function git(cwd: string, ...args: string[]): string {
    const r = spawnSync('git', args, {cwd, encoding: 'utf8'})
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
}

/** The commit before the one that gave the fix pass its off-tree probe. */
function baselineRef(): string {
    const added = git(
        REPO,
        'log',
        '--format=%H',
        '-S',
        'failedTrees?: string[]',
        '--',
        'src/task/final-gate-fix.ts'
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
    const at = (m: string) => import(path.join(root, 'src', m))
    return {
        fix: await at('task/final-gate-fix.ts'),
        gate: await at('task/final-gate.ts'),
        deps: await at('task/gate-deps.ts')
    }
}

const NEEDS_CLI = `const r = require('node:child_process').spawnSync('abtool', {stdio: 'inherit'})
if (r.error) {
    console.error('abtool: ' + r.error.code)
    process.exit(1)
}
process.exit(r.status ?? 1)
`
const BUGGY = "console.error('check: wrong answer')\nprocess.exit(1)\n"
const REGENERATES = `const fs = require('node:fs')
if (fs.readFileSync('gen.txt', 'utf8') === 'fresh\\n') process.exit(0)
fs.writeFileSync('gen.txt', 'fresh\\n')
console.error('gen.txt was stale; regenerated')
process.exit(1)
`
const CHECK: Record<Scenario, string> = {
    'off-tree': NEEDS_CLI,
    mixed: NEEDS_CLI,
    'repo-fix': BUGGY,
    'no-op': BUGGY,
    'gate-edits': REGENERATES,
    'lint-fix': `require('node:fs').writeFileSync('gen.txt', 'fresh\\n')\n${NEEDS_CLI}`
}

function project(dir: string, scenario: Scenario): void {
    rmSync(dir, {recursive: true, force: true})
    mkdirSync(dir, {recursive: true})
    writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({name: 'ab', private: true, scripts: {test: 'node check.js'}}, null, 2)
    )
    writeFileSync(path.join(dir, 'check.js'), CHECK[scenario])
    writeFileSync(path.join(dir, 'README.md'), '# ab\n')
    writeFileSync(path.join(dir, 'gen.txt'), 'stale\n')
    git(dir, 'init', '-q')
    git(dir, 'add', '.')
    git(dir, '-c', 'user.name=ab', '-c', 'user.email=ab@local', 'commit', '-qm', 'project')
}

function scriptedChild(scenario: Scenario, dir: string, bin: string) {
    return (): Promise<string> => {
        if (scenario === 'off-tree' || scenario === 'mixed' || scenario === 'lint-fix') {
            writeFileSync(path.join(bin, 'abtool'), '#!/bin/sh\nexit 0\n')
            chmodSync(path.join(bin, 'abtool'), 0o755)
        }
        if (scenario === 'mixed') writeFileSync(path.join(dir, 'README.md'), '# ab\n\nnotes\n')
        if (scenario === 'repo-fix') writeFileSync(path.join(dir, 'check.js'), 'process.exit(0)\n')
        return Promise.resolve('FINAL-GATE-FIX: DONE')
    }
}

async function trial(
    m: Mods,
    wiring: Mods['deps'],
    gate: Mods['gate'],
    scenario: Scenario,
    scratch: string,
    bin: string
) {
    const dir = path.join(scratch, 'project')
    project(dir, scenario)
    rmSync(bin, {recursive: true, force: true})
    mkdirSync(bin, {recursive: true})
    const before = await gate.runFinalIntegrationGate(dir)
    const out = await m.fix.runFinalGateAutofix(
        wiring.finalGateFixDeps({
            cwd: dir,
            failReason: before.reason,
            runChild: scriptedChild(scenario, dir, bin),
            failedTrees: [before.tree, before.leftTree].filter((t): t is string => t !== undefined)
        })
    )
    return {
        gateBefore: before.ok,
        ok: out.ok,
        unobserved: out.unobserved ?? null,
        credited: out.ok && out.unobserved === undefined
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

const scratch = path.resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: ab-off-tree-pass.ts <scratch-dir> [trials]')
const trials = Number(process.argv[3] ?? 10)
mkdirSync(scratch, {recursive: true})
const bin = path.join(scratch, 'bin')
process.env.PATH = `${bin}:${process.env.PATH}`
const arms: Record<Arm, Mods> = {A: await load(baselineTree(scratch)), B: await load(REPO)}
const ledger = path.join(scratch, `ledger-${Date.now()}.jsonl`)
const credited: Record<Scenario, Record<Arm, boolean[]>> = Object.fromEntries(
    SCENARIOS.map(s => [s, {A: [], B: []}])
) as never
for (const scenario of SCENARIOS) {
    for (let i = 0; i < trials; i++) {
        const order: Arm[] = i % 4 === 0 || i % 4 === 3 ? ['A', 'B'] : ['B', 'A']
        for (const arm of order) {
            const t0 = Date.now()
            const r = await trial(arms[arm], arms.B.deps, arms.B.gate, scenario, scratch, bin)
            credited[scenario][arm].push(r.credited)
            appendFileSync(
                ledger,
                JSON.stringify({scenario, arm, index: i, ...r, ms: Date.now() - t0}) + '\n'
            )
        }
    }
}
const count = (xs: boolean[]) => xs.filter(Boolean).length
for (const s of SCENARIOS) {
    console.log(
        `${s.padEnd(9)} credited A ${count(credited[s].A)}/${trials}  B ${count(credited[s].B)}/${trials}`
    )
}
console.log(`ledger: ${ledger}`)
const offA = count(credited['off-tree'].A)
if (offA === 0) {
    console.log('ABSTAIN: arm A never credited an off-tree pass')
    process.exit(2)
}
let caught = true
for (const s of ['off-tree', 'lint-fix'] as const) {
    const a = count(credited[s].A)
    const b = count(credited[s].B)
    const p = fisherOneSided(a, trials, b, trials)
    console.log(`${s} credited A ${a} → B ${b}, one-sided Fisher p=${p.toPrecision(3)}`)
    caught &&= b === 0 && p < 0.05
}
const controls =
    count(credited['repo-fix'].A) === trials
    && count(credited['repo-fix'].B) === trials
    && count(credited['no-op'].A) === 0
    && count(credited['no-op'].B) === 0
const pass = caught && controls
console.log(pass ? 'PASS' : `FAIL${controls ? '' : ' (a control moved)'}`)
process.exit(pass ? 0 : 1)
