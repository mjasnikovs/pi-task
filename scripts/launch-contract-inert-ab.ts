/**
 * A/B for nexttask 16A — the launch-contract diff must go INERT on a project with
 * no npm manifest, instead of reporting every declared script as missing from a
 * `package.json` that does not exist.
 *
 * THE DEFECT, by construction. Nothing upstream of the diff is npm-shaped:
 * `enumerateScriptCandidates` scrapes backticked tokens out of any design paragraph
 * containing the word "script", and `keepGroundedScripts` can only DROP a name. The
 * diff end hardcoded the ecosystem anyway — `packageScripts`' catch returns `{}`, so
 * "no package.json" and "a package.json with no scripts" were the same input. A
 * CMake/cargo/poetry design saying *"the Makefile must expose `build`, `test`,
 * `migrate`"* therefore got all three reported missing, at rank 1, in wording naming
 * a file the project was never meant to have — and that wording seeds the autofix
 * child's prompt, whose likeliest repair is to write a package.json.
 *
 * IAR1 is how close this came: `plan-debug.log:10` records "launch-contract
 * extraction: 0 grounded script(s) kept from 3 emitted" — a non-npm project that
 * reached extraction and was saved only by its design not backticking the names in
 * a "script" paragraph. There is NO observed occurrence; this A/B is a construction
 * proof, which is the bar 16A gets because its fix is INERTNESS — the strictly
 * smaller behaviour, which cannot invent a failure.
 *
 * Deterministic: no model, no network calls of our own. Real
 * `runFinalIntegrationGate` in both arms, real child processes, real git fixtures.
 * The baseline arm is `src/` at BASELINE (see baselineRef) exported with
 * `git archive`, so this compares shipped code to the working tree.
 *
 *     bun run scripts/launch-contract-inert-ab.ts
 *
 * THREE FIXTURES, pre-registered, and the third can fail the lever on its own:
 *
 *   (a) CMake project, no package.json, contract = build,test,migrate
 *       baseline  → FAILS naming all three against "package.json"
 *       treatment → NO launch-contract failure, and an UNOBSERVED note saying the
 *                   contract was recorded and NOT checked here
 *   (b) Makefile project (targets build,test — no migrate), same contract
 *       treatment → FAILS naming `migrate` ONLY, and says "Makefile"
 *       baseline  → FAILS naming all three, against "package.json"
 *   (c) THE FP SUITE — mx5's real package.json and real launch-contract.md at
 *       3e87014 (`git show`n out of ~/hub/mx5, never transcribed): the run-20 miss
 *       of `build` and `seed` is a TRUE positive.
 *       BOTH arms must fail IDENTICALLY — the whole ranked failure list, not just
 *       the contract line. If the treatment alters mx5's verdict in any way, this
 *       change scoped nothing and broke the check.
 *
 * Fixture (c) carries mx5's two REAL artifacts, not its whole tree: the diff under
 * test consumes exactly the manifest's `scripts` keys and the recorded contract, and
 * a 4-minute clone of the app around them would only add noise both arms share.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    runFinalIntegrationGate,
    type FinalGateOutcome,
    type FinalGateOptions
} from '../src/task/final-gate.js'
import {scratchRoot} from './scratch-repo.js'

const REPO = path.resolve(import.meta.dir, '..')
const MX5 = path.join(os.homedir(), 'hub', 'mx5')
/** The mx5 commit whose manifest is missing `build` and `seed` (run 20, TASK_0027). */
const MX5_REF = '3e87014'
const ROOT = scratchRoot('launch-contract-inert-ab')

type GateFn = (cwd: string, opts?: FinalGateOptions) => Promise<FinalGateOutcome>

/**
 * The commit BEFORE the lever landed, located by when its module was ADDED — not
 * `HEAD`, which contains the lever the moment it is committed and would compare the
 * fix against itself (`memory/ab-baseline-ref-must-not-move.md`). Before that commit
 * exists, HEAD *is* the pre-lever tree and is used, loudly.
 */
function baselineRef(): {ref: string; pinned: boolean} {
    const r = spawnSync(
        'git',
        ['log', '--diff-filter=A', '--format=%H', '--', 'src/task/launch-manifest.ts'],
        {cwd: REPO, encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    return sha ? {ref: `${sha}^`, pinned: true} : {ref: 'HEAD', pinned: false}
}

/** `src/` at a ref, whole module graph, imported from a temp dir. */
async function gateAt(ref: string): Promise<GateFn> {
    const dir = ROOT.path('_baseline')
    fs.mkdirSync(dir, {recursive: true})
    const tar = spawnSync('git', ['archive', ref, 'src'], {
        cwd: REPO,
        encoding: 'buffer',
        maxBuffer: 256 * 1024 * 1024
    })
    if (tar.status !== 0) throw new Error(`git archive ${ref} src failed`)
    fs.writeFileSync(path.join(dir, 'head.tar'), tar.stdout)
    if (spawnSync('tar', ['-xf', path.join(dir, 'head.tar'), '-C', dir]).status !== 0) {
        throw new Error('tar extract failed')
    }
    const mod = (await import(path.join(dir, 'src/task/final-gate.js'))) as {
        runFinalIntegrationGate: GateFn
    }
    return mod.runFinalIntegrationGate
}

// ── fixtures ──────────────────────────────────────────────────────────────────

const CONTRACT_ABC = 'build\ntest\nmigrate\n'

/** (a) IAR1's shape: a CMake project that recorded a contract. No manifest at all. */
function makeCmake(name: string): string {
    return ROOT.repo(name, {
        files: {
            'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(iar1 CXX)\n',
            'src/main.cpp': 'int main() { return 0; }\n',
            '.pi-tasks/launch-contract.md': CONTRACT_ABC
        },
        commit: 'fixture: cmake project with a launch contract'
    }).dir
}

/** (b) The same contract against a Makefile that exposes two of the three. */
function makeMakefile(name: string): string {
    return ROOT.repo(name, {
        files: {
            Makefile:
                'CC := gcc\n\n.PHONY: build test\n\nbuild:\n\t$(CC) -o app src/main.c\n\ntest:\n\t./app --selftest\n',
            'src/main.c': 'int main(void) { return 0; }\n',
            '.pi-tasks/launch-contract.md': CONTRACT_ABC
        },
        commit: 'fixture: makefile project with a launch contract'
    }).dir
}

/** mx5's REAL file at MX5_REF — never a transcription. */
function mx5File(rel: string): string {
    const r = spawnSync('git', ['show', `${MX5_REF}:${rel}`], {cwd: MX5, encoding: 'utf8'})
    if (r.status !== 0 || !r.stdout) throw new Error(`cannot read ${rel} at ${MX5_REF}: ${r.stderr}`)
    return r.stdout
}

/** (c) The FP suite: mx5's real manifest + real contract, the true positive. */
function makeMx5(name: string): string {
    return ROOT.repo(name, {
        files: {
            'package.json': mx5File('package.json'),
            '.pi-tasks/launch-contract.md': mx5File('.pi-tasks/launch-contract.md')
        },
        commit: 'fixture: mx5 manifest + launch contract at ' + MX5_REF
    }).dir
}

// ── run ───────────────────────────────────────────────────────────────────────

const CONTRACT_RE = /^launch contract: /
const listOf = (o: FinalGateOutcome): string[] => o.failures ?? (o.ok ? [] : [o.reason])

/**
 * Two arms get two directories and two clocks. Absolute paths, their basenames
 * (failure text is tail-truncated, so a fragment can start mid-path) and duration
 * literals are normalised out; nothing else is rewritten, so a real difference in
 * WHAT failed still shows.
 */
function normalise(dir: string, s: string): string {
    return s
        .split(dir)
        .join('<TREE>')
        .split(path.basename(dir))
        .join('<TREE>')
        .replace(/\[\d+(?:\.\d+)?\s*m?s\]/g, '[<T>]')
        .replace(/\b\d+(?:\.\d+)?\s*m?s\b/g, '<T>')
}

async function run(gate: GateFn, dir: string): Promise<{ok: boolean; failures: string[]; unobserved: string}> {
    const o = await gate(dir, {timeoutMs: 120_000, bootGraceMs: 1_000, planText: ''})
    return {
        ok: o.ok,
        failures: listOf(o).map(f => normalise(dir, f)),
        unobserved: normalise(dir, o.unobserved ?? '')
    }
}

function show(label: string, r: {ok: boolean; failures: string[]; unobserved: string}): void {
    console.log(`    ${label.padEnd(10)} ok=${r.ok}  failures=${r.failures.length}`)
    for (const f of r.failures) console.log(`               - ${f.slice(0, 220).replace(/\n/g, ' | ')}`)
    if (r.unobserved) console.log(`               UNOBSERVED: ${r.unobserved.slice(0, 240)}`)
}

const contractLine = (r: {failures: string[]}): string =>
    r.failures.find(f => CONTRACT_RE.test(f)) ?? ''

async function main(): Promise<void> {
    const {ref, pinned} = baselineRef()
    const baseline = await gateAt(ref)
    const checks: Array<[string, boolean]> = []
    console.log(
        `baseline ${ref}${pinned ? ' (pinned to the lever module\'s add-commit^)' : ' — NOT YET PINNED: the lever module is uncommitted, so HEAD is the pre-lever tree'}`
    )

    // ── (a) no manifest at all ──────────────────────────────────────────────
    console.log('\n(a) CMake project, no package.json, contract = build, test, migrate')
    const aBase = await run(baseline, makeCmake('cmake-base'))
    const aTreat = await run(runFinalIntegrationGate, makeCmake('cmake-treat'))
    show('baseline', aBase)
    show('treatment', aTreat)
    checks.push([
        '(a) baseline FAILS, naming all three against a package.json that does not exist',
        !aBase.ok
            && /package\.json does not expose: build, test, migrate/.test(contractLine(aBase))
    ])
    checks.push(['(a) treatment reports NO launch-contract failure', contractLine(aTreat) === ''])
    checks.push(['(a) treatment does not FAIL at all', aTreat.ok])
    checks.push([
        '(a) treatment leaves a note: contract recorded, NOT checked, names all three',
        /launch contract:/.test(aTreat.unobserved)
            && /NOT checked/.test(aTreat.unobserved)
            && /build, test, migrate/.test(aTreat.unobserved)
    ])

    // ── (b) Makefile ────────────────────────────────────────────────────────
    console.log('\n(b) Makefile project, targets build + test, same contract')
    const bBase = await run(baseline, makeMakefile('make-base'))
    const bTreat = await run(runFinalIntegrationGate, makeMakefile('make-treat'))
    show('baseline', bBase)
    show('treatment', bTreat)
    checks.push([
        '(b) baseline FAILS naming all three, against "package.json"',
        !bBase.ok && /package\.json does not expose: build, test, migrate/.test(contractLine(bBase))
    ])
    checks.push([
        '(b) treatment FAILS naming `migrate` ONLY, and says "Makefile"',
        !bTreat.ok && /Makefile does not expose: migrate \(declared: /.test(contractLine(bTreat))
    ])

    // ── (c) FP suite: mx5's real miss ───────────────────────────────────────
    console.log(`\n(c) FP SUITE — mx5's real package.json + launch-contract.md at ${MX5_REF}`)
    const cBase = await run(baseline, makeMx5('mx5-base'))
    const cTreat = await run(runFinalIntegrationGate, makeMx5('mx5-treat'))
    show('baseline', cBase)
    show('treatment', cTreat)
    const identical =
        cBase.ok === cTreat.ok
        && cBase.failures.length === cTreat.failures.length
        && cBase.failures.every((f, i) => f === cTreat.failures[i])
    checks.push([
        '(c) baseline FAILS on mx5, naming build and seed (the run-20 TRUE positive)',
        !cBase.ok && /package\.json does not expose: build, seed/.test(contractLine(cBase))
    ])
    checks.push([
        '(c) treatment is BYTE-IDENTICAL to baseline — whole ranked list, same verdict',
        identical
    ])
    if (!identical) {
        for (const added of cTreat.failures.filter(x => !cBase.failures.includes(x))) {
            console.log(`      + ${added}`)
        }
        for (const gone of cBase.failures.filter(x => !cTreat.failures.includes(x))) {
            console.log(`      - ${gone}`)
        }
    }

    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
    const verdict = checks.every(([, ok]) => ok)
    console.log('')
    console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}   (no rate claim — 0 observed occurrences; construction proof)`)
    ROOT.remove()
    process.exit(verdict ? 0 : 1)
}

void main()
