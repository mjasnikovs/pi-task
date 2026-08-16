/**
 * STEP 5 of nexttask 15 — the ONLY place 15A and 15B are tested together: replay
 * mx5 run 20's whole final-gate loop and ask whether it can now converge.
 *
 * WHAT RUN 20 DID (`~/hub/mx5/.pi-tasks/`, 2026-08-07, 8m16s):
 *
 *     08:34:30  final-gate: FAIL — 2 failures
 *     08:34:30  attempt 1/3 → DELETION GUARD, edits discarded
 *     08:36:47  attempt 2/3 → same three deletions, discarded again
 *     08:40:44  attempt 3/3 → did not converge: launch script: `bun run seed`
 *               exited 1 — Missing required environment variable: ADMIN_PHONE
 *     08:42:46  left failed — autofix budget spent
 *
 * Three files that regenerate on the next test run cost attempts 1 and 2, and a
 * variable `.env.example` itself declares cost attempt 3. Neither is a defect in
 * the shipped product.
 *
 * Deterministic: no model. The fix child is scripted to do exactly what run 20's
 * attempts did — repair `src/client/api.test.tsx`, add the missing `build`/`seed`
 * scripts, and `rm` the three tracked screenshots. Real git, a real
 * `runFinalIntegrationGate`, real child processes, the real `runFinalGateAutofix`
 * seam. The baseline arm is the commit before 15A (see baselineRef), so both
 * levers are absent from it.
 *
 *   bun run scripts/replay-run20-final-gate.ts
 *
 * Exit 0 iff:
 *   baseline   attempt 1 is REJECTED and its api.test.tsx repair is lost — the
 *              recorded defect reproduces
 *   treatment  attempt 1 KEEPS the repair, the gate converges, and the seed run
 *              reports UNOBSERVED rather than FAIL
 *   and, in BOTH arms, the launch-contract diff FAILS honestly on the FIRST gate:
 *              `build` and `seed` are genuinely absent from 3e87014's
 *              package.json, and that failure is real, not something 15B excuses.
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {runFinalIntegrationGate, type FinalGateOutcome} from '../src/task/final-gate.js'
import {runFinalGateAutofix, type FinalFixDeps, type FinalFixResult} from '../src/task/final-gate-fix.js'
import {parseTreeChanges, type TreeChangeSummary} from '../src/task/write-guard.js'
import {scratchGit as git, scratchRoot, writeFile} from './scratch-repo.js'

const ROOT = scratchRoot('replay-run20-final-gate')

/** The three run-20 screenshots, verbatim from final-gate-debug.log. */
const SCREENSHOTS = [
    'test-results/client-pages-AdminPage-Adm-89eae-nel-with-users-and-listings/admin-panel-default-actual.png',
    'test-results/client-pages-JoinPage-JoinPage-screenshot-baseline/JoinPage-screenshot-baseline-1-actual.png',
    'test-results/client-pages-LoginPage-LoginPage-screenshot-baseline/LoginPage-screenshot-baseline-1-actual.png'
]

/** mx5's own launch contract (`.pi-tasks/launch-contract.md`), verbatim. */
const LAUNCH_CONTRACT = ['lint', 'test', 'test:ct', 'dev', 'build', 'migrate', 'seed'].join('\n') + '\n'

/** mx5's `src/server/seed.ts`, trimmed to the part that decides the outcome. */
const SEED = `const phone = process.env.ADMIN_PHONE;
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

const readPkg = (dir: string): {scripts: Record<string, string>} =>
    JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {scripts: Record<string, string>}

/**
 * mx5 as of 3e87014: the five scripts that commit really had (`build` and `seed`
 * genuinely absent — `git show 3e87014:package.json`), the launch contract
 * declaring seven, `.env.example` declaring the admin credentials, a failing
 * client test, and the three Playwright failure screenshots TASK_0027's own
 * `git add -A` had just made tracked.
 */
function makeFixture(name: string): string {
    return ROOT.repo(name, {
        files: {
            'package.json':
                JSON.stringify(
                    {
                        name: 'mx5-private',
                        private: true,
                        type: 'module',
                        scripts: {
                            dev: 'bun run src/server/dev.ts',
                            migrate: 'bun run src/server/migrate.ts',
                            lint: "bun -e \"console.log('lint ok')\"",
                            test: 'bun run src/client/api.test.tsx',
                            'test:ct': "bun -e \"console.log('ct ok')\""
                        }
                    },
                    null,
                    4
                ) + '\n',
            // The failing client test run 20's attempt 1 repaired.
            'src/client/api.test.tsx':
                "console.error('api.test.tsx: expected 1, got 2');\nprocess.exit(1);\n",
            'src/server/seed.ts': SEED,
            'src/server/migrate.ts': "console.log('migrations up to date');\n",
            // Boot-class: stays alive past the grace window without listening (the
            // fixture declares no server framework dep and the replay passes no plan
            // text, so detectsServedApp is false and no listener is required).
            'src/server/dev.ts': 'setTimeout(() => {}, 60_000);\n',
            '.env.example':
                '# Database connection string\nDATABASE_URL=postgres://mx5:mx5@localhost:5432/mx5_dev\n'
                + '\n# Admin user credentials for initial seed / auth\nADMIN_PHONE=+12345678900\nADMIN_PASSWORD=change-me\n',
            '.pi-tasks/launch-contract.md': LAUNCH_CONTRACT,
            ...Object.fromEntries(SCREENSHOTS.map(s => [s, 'PNGDATA']))
        },
        commit: 'task: Polish — empty/error/loading states across all pages … (TASK_0027)'
    }).dir
}

interface ArmModules {
    gate: typeof runFinalIntegrationGate
    autofix: (deps: FinalFixDeps) => Promise<FinalFixResult>
    parse: (s: string) => TreeChangeSummary
}

/** The commit before 15A — the last one with NEITHER lever. */
function baselineRef(): string {
    const r = spawnSync(
        'git',
        ['log', '--diff-filter=A', '--format=%H', '--', 'src/task/regenerable-artifacts.ts'],
        {encoding: 'utf8'}
    )
    const sha = (r.stdout ?? '').trim().split('\n').filter(Boolean).pop()
    if (!sha) throw new Error('cannot locate the commit that added src/task/regenerable-artifacts.ts')
    return `${sha}^`
}

async function baselineModules(): Promise<ArmModules> {
    const dir = ROOT.path('_baseline')
    fs.mkdirSync(dir, {recursive: true})
    const ref = baselineRef()
    const tar = spawnSync('git', ['archive', ref, 'src'], {encoding: 'buffer', maxBuffer: 256 * 1024 * 1024})
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
    const w = (await import(path.join(dir, 'src/task/write-guard.js'))) as {
        parseTreeChanges: ArmModules['parse']
    }
    return {gate: g.runFinalIntegrationGate, autofix: f.runFinalGateAutofix, parse: w.parseTreeChanges}
}

interface ArmResult {
    firstGate: FinalGateOutcome
    attempt1: FinalFixResult
    repairKept: boolean
}

/** ADMIN_* scrubbed for the whole arm: this box genuinely does not supply them. */
async function withoutAdminEnv<T>(fn: () => Promise<T>): Promise<T> {
    const saved = {p: process.env.ADMIN_PHONE, w: process.env.ADMIN_PASSWORD}
    delete process.env.ADMIN_PHONE
    delete process.env.ADMIN_PASSWORD
    try {
        return await fn()
    } finally {
        if (saved.p === undefined) delete process.env.ADMIN_PHONE
        else process.env.ADMIN_PHONE = saved.p
        if (saved.w === undefined) delete process.env.ADMIN_PASSWORD
        else process.env.ADMIN_PASSWORD = saved.w
    }
}

async function runArm(name: string, mods: ArmModules): Promise<ArmResult> {
    const dir = makeFixture(name)
    return withoutAdminEnv(async () => {
        const firstGate = await mods.gate(dir, {timeoutMs: 120_000, bootGraceMs: 1_000, planText: ''})

        // ATTEMPT 1, scripted to do exactly what run 20's attempts did.
        const runChild = (): Promise<string> => {
            writeFile(dir, 'src/client/api.test.tsx', "console.log('api.test.tsx ok');\n")
            const pkg = readPkg(dir)
            pkg.scripts.build = 'bun run build.ts'
            pkg.scripts.seed = 'bun run src/server/seed.ts'
            writeFile(dir, 'package.json', JSON.stringify(pkg, null, 4) + '\n')
            writeFile(dir, 'build.ts', "console.log('build ok');\n")
            for (const s of SCREENSHOTS) fs.rmSync(path.join(dir, s))
            return Promise.resolve('repaired the failing assertion and added the missing scripts')
        }

        const deps: FinalFixDeps = {
            cwd: dir,
            failReason: firstGate.reason,
            runChild,
            gate: c => mods.gate(c, {timeoutMs: 120_000, bootGraceMs: 1_000, planText: ''}),
            discoverLabels: () => ['bun run test', 'bun run lint'],
            discard: c => {
                git(c, ['checkout', '--', '.'])
                git(c, ['clean', '-fdq'])
                return Promise.resolve()
            },
            treeChanges: () =>
                Promise.resolve(mods.parse(git(dir, ['status', '--porcelain', '--', '.', ':(exclude).pi-tasks'])))
        }
        const attempt1 = await mods.autofix(deps)
        const repairKept = fs.readFileSync(path.join(dir, 'src/client/api.test.tsx'), 'utf8').includes('ok')
        return {firstGate, attempt1, repairKept}
    })
}

function show(label: string, r: ArmResult): void {
    console.log(`  ${label}`)
    console.log(`      first gate ok=${r.firstGate.ok}`)
    console.log(`          ${r.firstGate.reason.slice(0, 220).replace(/\n/g, ' | ')}`)
    console.log(`      attempt 1  ok=${r.attempt1.ok}  guardTripped=${r.attempt1.guardTripped ?? false}`)
    console.log(`          ${r.attempt1.reason.slice(0, 220).replace(/\n/g, ' | ')}`)
    if (r.attempt1.unobserved) console.log(`      UNOBSERVED: ${r.attempt1.unobserved.slice(0, 220)}`)
    console.log(`      api.test.tsx repair kept: ${r.repairKept}`)
}

async function main(): Promise<void> {
    console.log('REPLAY — mx5 run 20 (3e87014), the whole final-gate loop')
    console.log('')
    const base = await runArm('baseline', await baselineModules())
    show(`baseline  (src/ @ ${baselineRef()})`, base)
    console.log('')
    const treat = await runArm('treatment', {
        gate: runFinalIntegrationGate,
        autofix: runFinalGateAutofix,
        parse: parseTreeChanges
    })
    show('treatment (working tree)', treat)

    // The launch-contract diff must FAIL honestly in BOTH arms: `build` and `seed`
    // really are absent from 3e87014's package.json, and 15B must not excuse that.
    const contractFails = (o: FinalGateOutcome): boolean =>
        !o.ok && /launch contract:.*build.*seed|launch contract:.*seed.*build/s.test(o.reason)

    const checks: Array<[string, boolean]> = [
        ['baseline: the first gate FAILS', !base.firstGate.ok],
        ['baseline: attempt 1 is REJECTED by the deletion guard', base.attempt1.guardTripped === true],
        ['baseline: the api.test.tsx repair is LOST — the recorded defect reproduces', !base.repairKept],
        ['treatment: the first gate FAILS too (no lever hides it)', !treat.firstGate.ok],
        ['BOTH arms: the launch-contract diff fails honestly on build + seed', contractFails(base.firstGate) && contractFails(treat.firstGate)],
        ['treatment: attempt 1 is NOT guard-rejected', treat.attempt1.guardTripped !== true],
        ['treatment: the api.test.tsx repair is KEPT', treat.repairKept],
        ['treatment: the gate CONVERGES', treat.attempt1.ok],
        [
            'treatment: the seed run reports UNOBSERVED, not FAIL, naming seed + ADMIN_PHONE',
            /launch script `seed` could not run here/.test(treat.attempt1.unobserved ?? '')
                && /ADMIN_PHONE/.test(treat.attempt1.unobserved ?? '')
        ],
        [
            'treatment: convergence is not a silent PASS — the UNOBSERVED note is carried',
            treat.attempt1.ok && (treat.attempt1.unobserved ?? '').length > 0
        ]
    ]

    console.log('')
    for (const [label, ok] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
    ROOT.remove()
    const verdict = checks.every(([, ok]) => ok)
    console.log('')
    console.log(`REPLAY: ${verdict ? 'PASS' : 'FAIL'}`)
    process.exit(verdict ? 0 : 1)
}

void main()
