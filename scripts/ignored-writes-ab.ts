/**
 * A/B for nexttask 4 — does the ignored-path channel turn mx5 run 19's
 * unreproducible PASS into an UNOBSERVED verdict with a durable debt, without
 * disturbing anything else?
 *
 *     baseline    tracked-only capture (the shipped pre-change deps: no
 *                 `ignoredSnapshot`, no `gateWithoutIgnored`)
 *     treatment   + ignored channel + trail + debt + UNOBSERVED downgrade
 *
 * Pre-registered metric, per entry: the tuple (gate verdict, open-debt set, trail
 * lines). Both arms run the SAME `runFinalGateAutofix` from src/ — only the two
 * optional deps differ, which is exactly the production difference.
 *
 * THE LEAD IS REPLAYED FOR REAL, NOT SIMULATED. `mx5-run19` is a CoW clone of
 * ~/hub/mx5 at its shipped state with `.env` removed (the pre-fix condition the
 * gate FAILed in), a fix child that reproduces the recorded repair — `.env.example`
 * plus the two ADMIN_* keys `src/server/seed.ts:24` requires — and a gate that
 * RUNS `bun run seed`, the command whose verdict the defect is about. Measured on
 * this box before the harness was written:
 *
 *     bun run seed  with .env      → exit 0   ("Admin user seeded successfully")
 *     bun run seed  with .env aside → exit 1  ("DATABASE_URL … is not set")
 *
 * DISCLOSED NARROWING: the injected gate runs `bun run seed`, not the full
 * `runFinalIntegrationGate`. The defect, the doc's PASS criterion and the
 * dependency probe are all about that one command's verdict; running the whole
 * gate would add lint/build/test/boot minutes to four gate invocations and change
 * nothing the metric reads.
 *
 * DISCLOSED DEPENDENCY: `bun run seed` needs a reachable Postgres. The harness
 * requires one at localhost:5432 with mx5's own dev credentials (its
 * docker-compose.dev.yml shape) and ABSTAINS if it is absent — it never starts or
 * stops a container itself, and it never touches ~/hub (every tree is a clone).
 *
 * The fixtures are not decoration: each one pins one pre-registered invariant
 * deterministically in milliseconds, where the real tree can only show the lead.
 *
 *     bun run scripts/ignored-writes-ab.ts
 */
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {runFinalGateAutofix, type FinalFixDeps, type FinalFixResult} from '../src/task/final-gate-fix.js'
import {
    collectIgnoredSnapshot,
    gatePassesWithoutIgnored,
    collectTreeChanges
} from '../src/task/gate-deps.js'
import {ignoredWriteTrailLine, ignoredWriteDebtReason} from '../src/task/write-guard.js'
import {recordDebt, readAcceptDebts} from '../src/task/accept-debt.js'

const HUB = path.join(os.homedir(), 'hub')
const WORK = path.join(os.homedir(), '.cache', 'pi-task-ignored-ab')
const SECRET_CANARY = 'hunter2'

type Arm = 'baseline' | 'treatment'
type Verdict = 'PASS' | 'UNOBSERVED' | 'FAIL'

interface Metric {
    verdict: Verdict
    /** Debt reasons the orchestrator branch would open, read back from the real ledger. */
    debts: string[]
    /** Lines the attempt wrote to the gate DEBUG LOG. */
    trail: string[]
    /** Lines the orchestrator branch would write to the task file's gate record. */
    gateRecord: string[]
    /** Paths reported as ignored writes (empty on baseline by construction). */
    ignoredWrites: string[]
}

function sh(cwd: string, argv: string[], env?: Record<string, string>): {code: number; out: string} {
    const r = spawnSync(argv[0]!, argv.slice(1), {
        cwd,
        encoding: 'utf8',
        env: {...process.env, ...env},
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024
    })
    return {code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '')}
}

// ── corpus entries ───────────────────────────────────────────────────────────

interface Entry {
    label: string
    /** Build the tree to run in; returns its path. */
    materialize: (dir: string) => void
    /** The fix child: writes whatever the recorded/fixture pass wrote. */
    child: (cwd: string) => void
    /** The gate, as the arms see it. Called for the re-run AND for the probe. */
    gate: (cwd: string) => {ok: boolean; reason: string}
    /** What the entry is here to prove. */
    note: string
}

function gitInit(dir: string, files: Record<string, string>): void {
    fs.mkdirSync(dir, {recursive: true})
    for (const [rel, body] of Object.entries(files)) {
        const p = path.join(dir, rel)
        fs.mkdirSync(path.dirname(p), {recursive: true})
        fs.writeFileSync(p, body)
    }
    sh(dir, ['git', 'init', '-q'])
    sh(dir, ['git', 'add', '-A'])
    sh(dir, ['git', '-c', 'user.email=ab@pi', '-c', 'user.name=ab', 'commit', '-qm', 'init'])
}

const MX5 = path.join(HUB, 'mx5')

const ENTRIES: Entry[] = [
    {
        label: 'mx5-run19',
        note: 'THE LEAD — the autofix greened `bun run seed` by writing a gitignored .env',
        materialize: dir => {
            const r = spawnSync('cp', ['-a', '--reflink=auto', MX5, dir], {encoding: 'utf8'})
            if ((r.status ?? 1) !== 0) throw new Error(`clone failed: ${r.stderr}`)
            // The pre-fix condition: run 19's gate FAILed because seed had no env.
            fs.rmSync(path.join(dir, '.env'), {force: true})
            // The run's own artifacts must not travel into the replay's ledger.
            fs.rmSync(path.join(dir, '.pi-tasks'), {recursive: true, force: true})
            // `bun run migrate` runs BEFORE `bun run seed` in the real gate, and
            // seed.ts throws "the 'users' table does not exist" without it. Run it
            // here, from the TRACKED .env.example rather than an .env, so the
            // replay's precondition is the repository's own — not a leftover from
            // whoever set the database up by hand.
            const url = /^DATABASE_URL=(.+)$/m.exec(
                fs.readFileSync(path.join(dir, '.env.example'), 'utf8')
            )?.[1]
            if (!url) throw new Error('.env.example has no DATABASE_URL')
            const m = sh(dir, ['bun', 'run', 'migrate'], {DATABASE_URL: url})
            if (m.code !== 0) throw new Error(`ABSTAIN-migrate: ${m.out.slice(-300)}`)
        },
        child: cwd => {
            // The recorded repair: `.env.example` + the ADMIN_* keys seed.ts requires.
            // FIXTURE VALUES ONLY — the corpus's real credentials are never read here.
            const example = fs.readFileSync(path.join(cwd, '.env.example'), 'utf8')
            fs.writeFileSync(
                path.join(cwd, '.env'),
                `${example.trimEnd()}\nADMIN_PHONE=+10000000000\nADMIN_PASSWORD=${SECRET_CANARY}_ab\nADMIN_DISPLAY_NAME=Admin\n`
            )
        },
        gate: cwd => {
            const r = sh(cwd, ['bun', 'run', 'seed'])
            return {
                ok: r.code === 0,
                reason:
                    r.code === 0 ?
                        'statics + `bun run seed` passed'
                    :   `launch script: \`bun run seed\` exited ${r.code}`
            }
        }
    },
    {
        label: 'fx-build-output',
        note: 'inv-build-output-exempt — writes into dist/ and node_modules/ must be silent',
        materialize: dir =>
            gitInit(dir, {
                '.gitignore': 'dist/\nnode_modules/\n',
                'package.json': JSON.stringify({
                    name: 'fx',
                    scripts: {build: 'bun build src/x.ts --outdir=dist', check: 'true'}
                }),
                'src/x.ts': 'export const x = 1\n'
            }),
        child: cwd => {
            fs.mkdirSync(path.join(cwd, 'dist'), {recursive: true})
            fs.writeFileSync(path.join(cwd, 'dist/x.js'), 'export const x = 1\n')
            fs.mkdirSync(path.join(cwd, 'node_modules/left-pad'), {recursive: true})
            fs.writeFileSync(path.join(cwd, 'node_modules/left-pad/index.js'), 'module.exports=1\n')
        },
        gate: () => ({ok: true, reason: 'statics + `check` passed'})
    },
    {
        label: 'fx-fail-stays-fail',
        note: 'inv-no-verdict-inflation — a gate that FAILs after the fix may never become PASS',
        materialize: dir =>
            gitInit(dir, {
                '.gitignore': '.env\n',
                'package.json': JSON.stringify({name: 'fx', scripts: {check: 'false'}})
            }),
        child: cwd => fs.writeFileSync(path.join(cwd, '.env'), `SECRET=${SECRET_CANARY}\n`),
        gate: () => ({ok: false, reason: 'launch script: `check` exited 1'})
    },
    {
        label: 'fx-secret-echo',
        note: 'inv-no-secret-echo — a converged, dependent PASS must leak no file CONTENT',
        materialize: dir =>
            gitInit(dir, {
                '.gitignore': '.env\n',
                'package.json': JSON.stringify({name: 'fx', scripts: {check: 'true'}})
            }),
        child: cwd => fs.writeFileSync(path.join(cwd, '.env'), `SECRET=${SECRET_CANARY}\n`),
        // Passes only while .env exists — the dependency the probe must detect.
        gate: cwd => ({
            ok: fs.existsSync(path.join(cwd, '.env')),
            reason: 'statics + `check` passed'
        })
    },
    {
        label: 'fx-incidental',
        note: 'an ignored write the PASS does NOT depend on stays a PASS (no inflation of the rule)',
        materialize: dir =>
            gitInit(dir, {
                '.gitignore': 'scratch.log\n',
                'package.json': JSON.stringify({name: 'fx', scripts: {check: 'true'}})
            }),
        child: cwd => fs.writeFileSync(path.join(cwd, 'scratch.log'), 'noise\n'),
        gate: () => ({ok: true, reason: 'statics + `check` passed'})
    }
]

// ── one arm over one entry ───────────────────────────────────────────────────

async function runArm(entry: Entry, arm: Arm, degrade = false): Promise<Metric> {
    const dir = path.join(WORK, `${entry.label}-${arm}${degrade ? '-degraded' : ''}`)
    fs.rmSync(dir, {recursive: true, force: true})
    entry.materialize(dir)
    const trail: string[] = []
    const log = (m: string): void => {
        trail.push(m)
    }

    const deps: FinalFixDeps = {
        cwd: dir,
        failReason: 'replayed gate failure',
        runChild: async () => {
            entry.child(dir)
            return 'fix applied'
        },
        gate: async cwd => entry.gate(cwd),
        discoverLabels: () => ['check'],
        treeChanges: () => collectTreeChanges(dir),
        log,
        ...(arm === 'treatment' ?
            {
                // inv-degrade: the degraded run models a git that cannot answer
                // `--ignored=matching` at all (older git, no git) — the shipped
                // collector returns {} there, so this is the same object shape.
                ignoredSnapshot: degrade ? async () => ({}) : () => collectIgnoredSnapshot(dir),
                gateWithoutIgnored: (paths: string[]) =>
                    gatePassesWithoutIgnored(dir, paths, async c => entry.gate(c), log)
            }
        :   {})
    }

    const fix: FinalFixResult = await runFinalGateAutofix(deps)

    // The orchestrator branch this harness mirrors (auto-orchestrator.ts, the
    // `finalGateFix` result handling): trail + durable debt on any ignored write,
    // UNOBSERVED whenever the result carries a note. Mirrored rather than called —
    // driving the whole orchestrator would need a TUI, a model and a full run.
    const gateRecord: string[] = []
    if (fix.ignoredWrites && fix.ignoredWrites.length > 0) {
        gateRecord.push(ignoredWriteTrailLine(fix.ignoredWrites))
        if (fix.ignoredDependent !== false) {
            await recordDebt(
                dir,
                'AB',
                ignoredWriteDebtReason(fix.ignoredWrites, fix.ignoredDependent),
                'final-gate'
            )
        }
    }
    if (fix.ok && fix.unobserved) {
        await recordDebt(dir, 'AB', fix.unobserved, 'final-gate')
    }
    const debts = (await readAcceptDebts(dir)).map(d => d.reason)

    return {
        verdict: !fix.ok ? 'FAIL' : fix.unobserved ? 'UNOBSERVED' : 'PASS',
        debts,
        // Two distinct production artifacts: the gate DEBUG LOG (deps.log, written
        // inside the fix pass) and the task file's gate RECORD (recGate, written by
        // the orchestrator branch mirrored above). Kept separate so neither is
        // double-counted.
        trail,
        gateRecord,
        ignoredWrites: fix.ignoredWrites ?? []
    }
}

// ── invariants ───────────────────────────────────────────────────────────────

interface InvResult {
    name: string
    held: boolean
    detail: string
}

/** inv-tracked-unchanged, measured on every corpus repo AND every A/B tree: the
 *  tracked change set the deletion guard / frozen revert / probe scan consume is
 *  byte-identical whether or not the ignored channel ran. */
async function invTrackedUnchanged(): Promise<InvResult> {
    const trees = [
        ...fs
            .readdirSync(HUB)
            .map(d => path.join(HUB, d))
            .filter(d => fs.existsSync(path.join(d, '.git'))),
        ...fs
            .readdirSync(WORK)
            .map(d => path.join(WORK, d))
            .filter(d => fs.existsSync(path.join(d, '.git')))
    ]
    const bad: string[] = []
    for (const t of trees) {
        const before = JSON.stringify(await collectTreeChanges(t))
        await collectIgnoredSnapshot(t) // the treatment's extra work
        const after = JSON.stringify(await collectTreeChanges(t))
        if (before !== after) bad.push(path.basename(t))
    }
    return {
        name: 'inv-tracked-unchanged',
        held: bad.length === 0,
        detail: `${trees.length} trees, tracked change set identical${bad.length > 0 ? ` EXCEPT ${bad.join(', ')}` : ''}`
    }
}

/** inv-stranded-commit-safe: `git add -A` (what commitStranded runs) can never
 *  stage an ignored path — measured, not asserted. */
function invStrandedCommitSafe(): InvResult {
    const dir = path.join(WORK, 'inv-stranded')
    fs.rmSync(dir, {recursive: true, force: true})
    gitInit(dir, {'.gitignore': '.env\n', 'a.txt': 'a\n'})
    fs.writeFileSync(path.join(dir, '.env'), `SECRET=${SECRET_CANARY}\n`)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a2\n')
    sh(dir, ['git', 'add', '-A'])
    const staged = sh(dir, ['git', 'diff', '--cached', '--name-only']).out.trim().split('\n')
    return {
        name: 'inv-stranded-commit-safe',
        held: !staged.includes('.env'),
        detail: `staged: ${staged.filter(s => s.length > 0).join(', ') || '(none)'}`
    }
}

/**
 * inv-carry-across-attempts: attempt 1 writes the ignored file and does NOT
 * converge; attempt 2 changes something else and the gate passes. Attempt 2's own
 * before/after diff sees nothing (the file was already there), so without the
 * accumulator the loop's converged PASS would rest on an unrecorded ignored write.
 * Two real sequential `runFinalGateAutofix` calls, exactly as the resolution loop
 * makes them.
 */
async function invCarryAcrossAttempts(): Promise<InvResult> {
    const run = async (carry: boolean): Promise<Verdict> => {
        const dir = path.join(WORK, `inv-carry-${carry ? 'on' : 'off'}`)
        fs.rmSync(dir, {recursive: true, force: true})
        gitInit(dir, {
            '.gitignore': '.env\n',
            'package.json': JSON.stringify({name: 'fx', scripts: {check: 'true'}}),
            'src/a.ts': 'export const a = 1\n'
        })
        // The gate needs BOTH the ignored .env and a tracked repair; attempt 1
        // provides only the first, so it fails, and its .env survives.
        const gate = (cwd: string): {ok: boolean; reason: string} => ({
            ok: fs.existsSync(path.join(cwd, '.env')) && fs.existsSync(path.join(cwd, 'src/b.ts')),
            reason: 'statics + `check` passed'
        })
        const base = (child: () => void, known: string[]): FinalFixDeps => ({
            cwd: dir,
            failReason: 'replayed',
            runChild: async () => {
                child()
                return 'fix applied'
            },
            gate: async c => gate(c),
            discoverLabels: () => ['check'],
            treeChanges: () => collectTreeChanges(dir),
            ignoredSnapshot: () => collectIgnoredSnapshot(dir),
            gateWithoutIgnored: paths => gatePassesWithoutIgnored(dir, paths, async c => gate(c)),
            ...(carry && known.length > 0 ? {ignoredKnown: known} : {})
        })
        const first = await runFinalGateAutofix(
            base(() => fs.writeFileSync(path.join(dir, '.env'), `SECRET=${SECRET_CANARY}\n`), [])
        )
        const second = await runFinalGateAutofix(
            base(
                () => fs.writeFileSync(path.join(dir, 'src/b.ts'), 'export const b = 2\n'),
                first.ignoredWrites ?? []
            )
        )
        return !second.ok ? 'FAIL' : second.unobserved ? 'UNOBSERVED' : 'PASS'
    }
    const withCarry = await run(true)
    const without = await run(false)
    return {
        name: 'inv-carry-across-attempts',
        held: withCarry === 'UNOBSERVED' && without === 'PASS',
        detail: `attempt 2 verdict: with carry ${withCarry}, without carry ${without} (the gap the accumulator closes)`
    }
}

/** inv-degrade: with the ignored channel unable to answer, the treatment arm's
 *  metric is byte-identical to baseline. */
async function invDegrade(entry: Entry): Promise<InvResult> {
    const base = await runArm(entry, 'baseline')
    const deg = await runArm(entry, 'treatment', true)
    const same =
        base.verdict === deg.verdict
        && JSON.stringify(base.debts) === JSON.stringify(deg.debts)
        && JSON.stringify(base.trail) === JSON.stringify(deg.trail)
    return {
        name: 'inv-degrade',
        held: same,
        detail: `${entry.label}: baseline ${base.verdict}/${base.debts.length} debts vs degraded ${deg.verdict}/${deg.debts.length} debts`
    }
}

// ── main ─────────────────────────────────────────────────────────────────────

function postgresReachable(): boolean {
    const r = spawnSync('pg_isready', ['-h', 'localhost', '-p', '5432'], {encoding: 'utf8'})
    return (r.status ?? 1) === 0
}

async function main(): Promise<void> {
    if (!fs.existsSync(MX5)) {
        console.log('ABSTAIN — ~/hub/mx5 (the recorded run 19 tree) is not available')
        process.exit(2)
    }
    if (!postgresReachable()) {
        console.log(
            'ABSTAIN — the mx5 replay needs a Postgres at localhost:5432 with mx5 dev\n'
                + '          credentials (its docker-compose.dev.yml shape). Nothing was started.'
        )
        process.exit(2)
    }
    // A database that is up but not mx5's own (wrong role, wrong db) cannot host
    // the replay; `bun run migrate` says so precisely, and an ABSTAIN is the only
    // honest answer — never a FAIL blamed on the lever.
    const abstain = (err: unknown): never => {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`ABSTAIN — the mx5 replay could not be prepared: ${msg}`)
        process.exit(2)
    }
    fs.mkdirSync(WORK, {recursive: true})

    const results = new Map<string, {baseline: Metric; treatment: Metric}>()
    for (const e of ENTRIES) {
        try {
            const baseline = await runArm(e, 'baseline')
            const treatment = await runArm(e, 'treatment')
            results.set(e.label, {baseline, treatment})
        } catch (err) {
            if (String(err).includes('ABSTAIN-migrate')) abstain(err)
            throw err
        }
    }

    console.log('# A/B — ignored-path channel\n')
    for (const e of ENTRIES) {
        const r = results.get(e.label)!
        console.log(`## ${e.label} — ${e.note}`)
        const fmt = (m: Metric): string =>
            `verdict ${m.verdict.padEnd(10)} debts ${m.debts.length}  debug-log ${m.trail.length}  gate-record ${m.gateRecord.length}`
        console.log(`   baseline   ${fmt(r.baseline)}`)
        console.log(
            `   treatment  ${fmt(r.treatment)}` +
                (r.treatment.ignoredWrites.length > 0 ?
                    `  ignored [${r.treatment.ignoredWrites.join(', ')}]`
                :   '')
        )
        for (const t of [...r.treatment.trail, ...r.treatment.gateRecord]) {
            console.log(`     trail: ${t.slice(0, 150)}`)
        }
        console.log('')
    }

    // ── pre-registered invariants ────────────────────────────────────────────
    const invs: InvResult[] = []

    const lead = results.get('mx5-run19')!
    invs.push({
        name: 'inv-no-verdict-inflation',
        held: [...results.values()].every(
            r => !(r.baseline.verdict === 'FAIL' && r.treatment.verdict !== 'FAIL')
        ),
        detail: [...results.entries()]
            .map(([l, r]) => `${l}:${r.baseline.verdict}→${r.treatment.verdict}`)
            .join(' ')
    })
    const bo = results.get('fx-build-output')!
    invs.push({
        name: 'inv-build-output-exempt',
        held:
            bo.treatment.ignoredWrites.length === 0
            && bo.treatment.verdict === bo.baseline.verdict
            && bo.treatment.debts.length === 0
            && bo.treatment.trail.length === bo.baseline.trail.length
            && bo.treatment.gateRecord.length === 0,
        detail: `dist/ + node_modules/ writes → ${bo.treatment.ignoredWrites.length} findings, ${bo.treatment.debts.length} debts, verdict ${bo.treatment.verdict}`
    })
    invs.push(await invTrackedUnchanged())
    const allText = JSON.stringify([...results.values()])
    invs.push({
        name: 'inv-no-secret-echo',
        held: !allText.includes(SECRET_CANARY),
        detail:
            allText.includes(SECRET_CANARY) ?
                'the canary appears in a trail line, a debt or a verdict'
            :   `canary never appears in ${allText.length} chars of arm output`
    })
    invs.push(invStrandedCommitSafe())
    invs.push(await invCarryAcrossAttempts())
    invs.push(await invDegrade(ENTRIES.find(e => e.label === 'fx-secret-echo')!))

    console.log('## invariants')
    for (const i of invs) {
        console.log(`   ${i.held ? 'HOLD ' : 'BREAK'} ${i.name.padEnd(28)} ${i.detail}`)
    }

    // ── verdict ──────────────────────────────────────────────────────────────
    const leadMoved =
        lead.baseline.verdict === 'PASS'
        && lead.treatment.verdict === 'UNOBSERVED'
        && lead.treatment.debts.some(d => d.includes('.env'))
        && lead.treatment.trail.some(t => t.includes('IGNORED path'))
    const allHeld = invs.every(i => i.held)
    console.log('')
    console.log(
        `LEAD: run 19's \`bun run seed\` PASS → ${lead.treatment.verdict}` +
            `, debt naming .env ${lead.treatment.debts.some(d => d.includes('.env')) ? 'OPENED' : 'MISSING'}`
    )
    if (leadMoved && allHeld) {
        console.log('\nPASS — the lead moved PASS → UNOBSERVED with a debt, and every invariant holds.')
        process.exit(0)
    }
    console.log(
        `\nFAIL — ${!leadMoved ? 'the lead did not move as pre-registered' : 'an invariant broke'}.`
    )
    process.exit(1)
}

void main()
