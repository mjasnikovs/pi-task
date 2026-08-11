/**
 * A/B for nexttask 15B — a launch script that exits non-zero because a variable
 * the tracked template DECLARES is absent from this box is an ENVIRONMENT GAP
 * (skip + UNOBSERVED + debt), not a FAIL.
 *
 * THE RECORDED EPISODE (mx5 run 20, `.pi-tasks/TASK_AUTO_0001.md`):
 *
 *     autofix attempt 3 failed — did not converge: launch script: `bun run seed`
 *     exited 1 — $ bun run src/server/seed.ts  Missing required environment
 *     variable: ADMIN_PHONE  error: script "seed" exited with code 1
 *
 * Attempt 3 had already passed every guard and fixed the failing test. Single-
 * failure phrasing, so this was the ONLY remaining failure — the run died on it.
 *
 * Deterministic: no model. Real `runFinalIntegrationGate`, real child processes,
 * real git fixtures. The baseline arm runs `src/` as of the commit BEFORE 15B
 * (see baselineRef), exported with `git archive`, so the comparison is shipped
 * code vs working tree.
 *
 *   bun run scripts/launch-config-gap-ab.ts
 *
 * FOUR ARMS, and the last three are controls that can each fail the lever on
 * their own. Every threshold below is fixed before the run.
 *
 *   (main)         seed requires ADMIN_PHONE/ADMIN_PASSWORD, .env.example declares
 *                  both, neither is in the env
 *                  baseline  → FAIL naming `bun run seed`
 *                  treatment → not-FAIL, verdict is NOT `PASS`, UNOBSERVED note
 *                              names both the script and the variable
 *   --undeclared   same, ADMIN_PHONE removed from .env.example
 *                  → must still FAIL (statically, via env-template-closure)
 *   --real-fault   seed.ts throws a TypeError on line 1, ALL env vars set
 *                  → must still FAIL. This is run 11's `.rows` bug; if it is
 *                    excused the whole 15B lever is refuted.
 *   --partial      seed.ts requires ADMIN_PHONE (declared, absent) AND throws
 *                  before reading it
 *                  → must still FAIL. Pre-registered: an absent variable is not a
 *                    licence to ignore an exit code the code caused. This arm is
 *                    the one that decides whether the rule is honest, and it is
 *                    why the rule carries a dynamic fifth condition (a probe
 *                    re-run with synthetic values) instead of four static ones.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {runFinalIntegrationGate, type FinalGateOutcome} from '../src/task/final-gate.js'
import {scratchRoot} from './scratch-repo.js'

const ROOT = scratchRoot('launch-config-gap-ab')

type GateFn = (
    cwd: string,
    timeoutMs?: number,
    bootGraceMs?: number,
    bootDeps?: Record<string, unknown>,
    planText?: string
) => Promise<FinalGateOutcome>

type Variant = 'main' | 'undeclared' | 'real-fault' | 'partial'

/** mx5's real `src/server/seed.ts`, trimmed to what the gate can reach here (no db). */
const SEED_OK = `const phone = process.env.ADMIN_PHONE;
const password = process.env.ADMIN_PASSWORD;

if (!phone) {
    console.error('Missing required environment variable: ADMIN_PHONE');
    process.exit(1);
}
if (!password) {
    console.error('Missing required environment variable: ADMIN_PASSWORD');
    process.exit(1);
}
console.log('Admin user created successfully');
`

/** run 11's `.rows` bug shape: a first-call TypeError, before anything else. */
const SEED_THROWS = `const rows = undefined;
console.log(rows.length);
`

/** Both at once: the TypeError fires BEFORE the required read is reached. */
const SEED_PARTIAL = `const rows = undefined;
console.log(rows.length);
const phone = process.env.ADMIN_PHONE;
if (!phone) {
    console.error('Missing required environment variable: ADMIN_PHONE');
    process.exit(1);
}
`

/**
 * A tree shaped like mx5 at the moment attempt 3 armed the check: a `seed` script
 * the design declared, `.env.example` declaring the admin credentials, and a
 * green static surface so `seed` is the only thing that can fail.
 */
function makeFixture(name: string, variant: Variant): string {
    return ROOT.repo(name, {
        files: {
            'package.json':
                JSON.stringify(
                    {
                        name: 'mx5-private',
                        private: true,
                        type: 'module',
                        scripts: {
                            // A discoverable, passing integration command. Without one
                            // the gate takes its zero-discovery early return and never
                            // reaches the launch-contract loop at all.
                            test: 'bun run src/passing.test.ts',
                            seed: 'bun run src/server/seed.ts'
                        }
                    },
                    null,
                    4
                ) + '\n',
            'src/server/seed.ts':
                variant === 'real-fault' ? SEED_THROWS
                : variant === 'partial' ? SEED_PARTIAL
                : SEED_OK,
            // The tracked template. `--undeclared` removes ADMIN_PHONE from it, which
            // is what makes findMissingEnvDeclarations fail the gate statically instead.
            '.env.example':
                variant === 'undeclared' ?
                    '# Admin user credentials for initial seed / auth\nADMIN_PASSWORD=change-me\n'
                :   '# Admin user credentials for initial seed / auth\nADMIN_PHONE=+12345678900\nADMIN_PASSWORD=change-me\n',
            'src/passing.test.ts': "console.log('suite ok')\n",
            // The declared launch contract the gate diffs against: one bare script
            // name per line, the shape readDeclaredScripts reads.
            '.pi-tasks/launch-contract.md': 'seed\n'
        },
        commit: 'task: seed script (TASK_0027)'
    }).dir
}

/**
 * The commit BEFORE 15B landed, located by when this lever's module was first
 * added. NOT `HEAD`: the sibling 15A A/B used HEAD and, the moment its fix was
 * committed, the "baseline" arm started loading the FIXED code — both arms became
 * the treatment and the A/B silently stopped measuring anything. A baseline ref
 * that moves with the fix is not a baseline.
 */
function baselineRef(): string {
    const r = spawnSync(
        'git',
        ['log', '--diff-filter=A', '--format=%H', '--', 'src/task/launch-config-gap.ts'],
        {encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    if (!sha) throw new Error('cannot locate the commit that added src/task/launch-config-gap.ts')
    return `${sha}^`
}

/** `src/` at `baselineRef()`, whole module graph, imported from a temp dir. */
async function headGate(): Promise<GateFn> {
    const dir = ROOT.path('_head')
    fs.mkdirSync(dir, {recursive: true})
    const ref = baselineRef()
    const tar = spawnSync('git', ['archive', ref, 'src'], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024})
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

/** Run one gate over one fixture with ADMIN_* scrubbed from the environment. */
async function run(gate: GateFn, dir: string, variant: Variant): Promise<FinalGateOutcome> {
    const saved = {phone: process.env.ADMIN_PHONE, password: process.env.ADMIN_PASSWORD}
    if (variant === 'real-fault') {
        // The control's whole point: every variable IS present, so the only reason
        // to exit non-zero is the code.
        process.env.ADMIN_PHONE = '+15550001111'
        process.env.ADMIN_PASSWORD = 'set-for-the-real-fault-arm'
    } else {
        delete process.env.ADMIN_PHONE
        delete process.env.ADMIN_PASSWORD
    }
    try {
        return await gate(dir, 120_000, 1_000, {}, '')
    } finally {
        if (saved.phone === undefined) delete process.env.ADMIN_PHONE
        else process.env.ADMIN_PHONE = saved.phone
        if (saved.password === undefined) delete process.env.ADMIN_PASSWORD
        else process.env.ADMIN_PASSWORD = saved.password
    }
}

const failsOnSeed = (o: FinalGateOutcome): boolean =>
    !o.ok && /launch script: `bun run seed`/.test(o.reason)

function show(label: string, o: FinalGateOutcome): void {
    console.log(`    ${label.padEnd(10)} ok=${o.ok}  unobserved=${o.unobserved ? 'yes' : 'no'}`)
    console.log(`               reason: ${o.reason.slice(0, 150).replace(/\n/g, ' | ')}`)
    if (o.unobserved) console.log(`               UNOBSERVED: ${o.unobserved.slice(0, 200)}`)
}

async function main(): Promise<void> {
    const head = await headGate()
    const checks: Array<[string, boolean]> = []

    // ── MAIN ────────────────────────────────────────────────────────────────
    console.log('MAIN — mx5 attempt 3: seed declared, ADMIN_PHONE declared in .env.example, absent here')
    const baseMain = await run(head, makeFixture('main-base', 'main'), 'main')
    const treatMain = await run(runFinalIntegrationGate, makeFixture('main-treat', 'main'), 'main')
    show('baseline', baseMain)
    show('treatment', treatMain)
    checks.push(['baseline FAILS on `bun run seed`', failsOnSeed(baseMain)])
    checks.push(['treatment does NOT fail on seed', !failsOnSeed(treatMain)])
    checks.push([
        'treatment verdict is NOT a PASS — it carries an UNOBSERVED note naming the SCRIPT and the VARIABLE',
        /launch script `seed` could not run here/.test(treatMain.unobserved ?? '')
            && /ADMIN_PHONE/.test(treatMain.unobserved ?? '')
    ])
    checks.push([
        'baseline reported no such note (the arms differ on the thing under test)',
        !/could not run here/.test(baseMain.unobserved ?? '')
    ])

    // ── CONTROL: --undeclared ───────────────────────────────────────────────
    console.log('')
    console.log('CONTROL --undeclared — ADMIN_PHONE removed from .env.example')
    const undeclared = await run(runFinalIntegrationGate, makeFixture('undeclared', 'undeclared'), 'undeclared')
    show('treatment', undeclared)
    checks.push([
        '--undeclared still FAILS (statically, via env closure)',
        !undeclared.ok && /env closure: `ADMIN_PHONE`/.test(undeclared.reason)
    ])

    // ── CONTROL: --real-fault ───────────────────────────────────────────────
    console.log('')
    console.log("CONTROL --real-fault — seed.ts throws a TypeError, all env vars SET (run 11's `.rows` bug)")
    const realFault = await run(runFinalIntegrationGate, makeFixture('real-fault', 'real-fault'), 'real-fault')
    show('treatment', realFault)
    checks.push(['--real-fault still FAILS on seed', failsOnSeed(realFault)])

    // ── CONTROL: --partial ──────────────────────────────────────────────────
    console.log('')
    console.log('CONTROL --partial — requires ADMIN_PHONE (declared, absent) AND throws before reading it')
    const partial = await run(runFinalIntegrationGate, makeFixture('partial', 'partial'), 'partial')
    show('treatment', partial)
    checks.push([
        '--partial still FAILS — an absent var is no licence to ignore an exit code the code caused',
        failsOnSeed(partial)
    ])

    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
    ROOT.remove()
    const verdict = checks.every(([, ok]) => ok)
    console.log('')
    console.log(`VERDICT: ${verdict ? 'PASS' : 'FAIL'}`)
    process.exit(verdict ? 0 : 1)
}

void main()
