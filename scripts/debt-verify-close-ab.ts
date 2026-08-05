/**
 * A/B — the VERIFY-COMMAND debt class (nexttask 5). Both arms in ONE process over
 * the recorded corpus, deterministic apart from the re-runs themselves.
 *
 *   baseline    recheckAcceptDebts as shipped: two auto-close classes
 *               (cross-task-deletion, `repo health:` statics).
 *   treatment   + the verify-command class: a debt whose reason quotes, verbatim in
 *               backticks, a line of its own task's VERIFY block carries that
 *               command; at run end the command is RE-RUN and the debt closes only
 *               on exit 0.
 *
 * PRE-REGISTERED METRIC: the open-debt SET at run end, per run, compared as sets.
 *
 *   PASS      mx5 run 19 closes TASK_0009 and ONLY TASK_0009, and every invariant
 *             below holds.                                                exit 0
 *   FAIL      it does not close, or anything else closes, or an invariant breaks.
 *                                                                         exit 1
 *   ABSTAIN   the recorded ledgers are unavailable — or the environment cannot
 *             OBSERVE the target command (mx5's Postgres is down, so the suite
 *             cannot run either way). Nothing was measured; nothing is claimed.
 *                                                                         exit 2
 *
 * INVARIANTS (each one asserted here, and pinned as a unit fixture in
 * src/task/accept-debt.test.ts):
 *
 *   inv-no-false-clear          a debt closes ONLY when its stored command ran and
 *                               exited 0 — env gap, timeout, missing command,
 *                               unparseable VERIFY or absent verifyCommand all keep
 *                               it open. Asserted here by re-running the WHOLE
 *                               corpus with the re-runner stubbed to fail, then to
 *                               gap: the treatment's open set must equal the
 *                               baseline's, everywhere, in both stubs.
 *   inv-prohibition-never-closes  a debt whose reason quotes a spec prohibition and
 *                               whose task's VERIFY passes must stay OPEN. Live
 *                               fixture: run 19's TASK_0019 (main.tsx edited under
 *                               a freeze). Its VERIFY is run for real here so the
 *                               fixture is evidence, not assumption.
 *   inv-existing-classes-kept    every close the two shipped classes make today is
 *                               still made, on identical inputs.
 *   inv-command-provenance       every stored command is byte-identical to a line of
 *                               the owning task's STRICT VERIFY block (closed fence).
 *   inv-no-write                 a re-run that changes tracked files cannot close a
 *                               debt (the shipped wrapper downgrades it to a gap).
 *                               Measured per re-run, in the clone.
 *   inv-bounded                  total re-runs per re-check are capped and a hung
 *                               command is a gap, never a close.
 *
 * ISOLATION. A VERIFY command is the project's own build/test command and may write.
 * Nothing is ever run in a corpus tree: each tree is cloned with
 * `cp -a --reflink=auto` into ~/.cache first (scripts/boot-skip-corpus.ts pattern —
 * btrfs, so the clone is near free) and every re-run happens in the clone.
 *
 * Run: bun run scripts/debt-verify-close-ab.ts
 */
import {execFileSync, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    parseAcceptDebts,
    readAcceptDebts,
    recheckAcceptDebts,
    recordYoloAcceptDebt,
    verifyCommandFromReason,
    writeAcceptDebts,
    type AcceptDebt,
    type VerifyRerunResult
} from '../src/task/accept-debt.js'
import {deriveOpenDebts, rerunDebtVerifyCommand} from '../src/task/final-gate.js'
import {parseVerifyBlockStrict} from '../src/task/spec-validation.js'

const HOME = os.homedir()
const MX5 = process.env.MX5_REPO ?? path.join(HOME, 'hub', 'mx5')

// ─── corpus (same discovery as the STEP 0 script) ────────────────────────────

const SEARCH_ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]

function findLedgers(root: string, depth = 0, out: string[] = []): string[] {
    if (depth > 4) return out
    let entries: fs.Dirent[]
    try {
        entries = fs.readdirSync(root, {withFileTypes: true})
    } catch {
        return out
    }
    for (const e of entries) {
        if (!e.isDirectory()) continue
        if (e.name === 'node_modules' || e.name === '.git') continue
        const dir = path.join(root, e.name)
        if (e.name === '.pi-tasks') {
            const f = path.join(dir, 'accept-debt.md')
            if (fs.existsSync(f)) out.push(f)
            continue
        }
        findLedgers(dir, depth + 1, out)
    }
    return out
}

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    } catch {
        return null
    }
}

interface RunSnapshot {
    tree: string
    label: string
    project: boolean
    debts: AcceptDebt[]
    readSpec: (taskId: string) => string | null
}

function collectRuns(): RunSnapshot[] {
    const runs: RunSnapshot[] = []
    const trees = new Set<string>()
    for (const f of SEARCH_ROOTS.flatMap(r => findLedgers(r))) {
        const tasks = path.dirname(f)
        const tree = path.dirname(tasks)
        let raw: string
        try {
            raw = fs.readFileSync(f, 'utf8').trim()
        } catch {
            continue
        }
        if (raw.length === 0) continue
        trees.add(tree)
        runs.push({
            tree,
            label: `${path.basename(tree)}@worktree`,
            project: path.relative(HOME, tree).startsWith('hub' + path.sep),
            debts: parseAcceptDebts(raw),
            readSpec: id => {
                try {
                    return fs.readFileSync(path.join(tasks, `${id}.md`), 'utf8')
                } catch {
                    return null
                }
            }
        })
    }
    // Historical ledgers for trees that track `.pi-tasks/` (mx5 does): read as git
    // blobs, paired with the specs as they were at that commit. Never checked out.
    for (const tree of [...trees].filter(t =>
        path.relative(HOME, t).startsWith('hub' + path.sep)
    )) {
        if (!fs.existsSync(path.join(tree, '.git'))) continue
        const log = git(tree, ['log', '--all', '--format=%H', '--', '.pi-tasks/accept-debt.md'])
        for (const sha of (log ?? '').split('\n').map(s => s.trim()).filter(Boolean)) {
            const raw = git(tree, ['show', `${sha}:.pi-tasks/accept-debt.md`])
            if (raw === null || raw.trim().length === 0) continue
            runs.push({
                tree,
                label: `${path.basename(tree)}@${sha.slice(0, 7)}`,
                project: true,
                debts: parseAcceptDebts(raw.trim()),
                readSpec: id => git(tree, ['show', `${sha}:.pi-tasks/${id}.md`])
            })
        }
    }
    return runs
}

/**
 * Replay the RECORD side: the corpus ledgers predate the change, so the stored
 * `verifyCommand` field is absent everywhere. Re-derive it exactly the way
 * classifyVerifyCommand does — strict VERIFY parse, verbatim backtick match — from
 * the specs of that snapshot.
 */
function withVerifyCommands(run: RunSnapshot): AcceptDebt[] {
    return run.debts.map(d => {
        if (d.taskId.length === 0) return d
        const spec = run.readSpec(d.taskId)
        if (spec === null) return d
        const cmds = parseVerifyBlockStrict(spec)
        if (cmds === null || cmds.length === 0) return d
        const hit = verifyCommandFromReason(
            d.reason,
            cmds.map(c => c.raw)
        )
        return hit === null ? d : {...d, verifyCommand: hit}
    })
}

// ─── isolation ───────────────────────────────────────────────────────────────

function makeWorkRoot(): string {
    const base = path.join(HOME, '.cache', 'pi-task-debt-verify')
    fs.mkdirSync(base, {recursive: true})
    return fs.mkdtempSync(path.join(base, 'ab-'))
}

const clones = new Map<string, string | null>()
let workRoot: string | null = null

function cloneOf(tree: string): string | null {
    const cached = clones.get(tree)
    if (cached !== undefined) return cached
    workRoot ??= makeWorkRoot()
    const dest = path.join(workRoot, `${path.basename(tree)}-${clones.size}`)
    const r = spawnSync('cp', ['-a', '--reflink=auto', tree, dest], {encoding: 'utf8'})
    const clone = r.status === 0 ? dest : null
    clones.set(tree, clone)
    return clone
}

// ─── arms ────────────────────────────────────────────────────────────────────

const keyOf = (d: AcceptDebt): string => `${d.taskId}|${d.origin ?? 'accepted'}|${d.reason}`

interface ArmResult {
    open: Set<string>
    resolved: Set<string>
    trail: string[]
}

function arm(
    debts: AcceptDebt[],
    tree: string,
    rerun: ((cmd: string, d: AcceptDebt) => VerifyRerunResult) | undefined
): ArmResult {
    const r = recheckAcceptDebts(debts, {
        // Favourable to the OLD classes on both sides: statics assumed passing, so
        // anything the shipped classes could ever close, they do close here.
        staticOk: true,
        fileExists: rel => fs.existsSync(path.join(tree, rel)),
        ...(rerun ? {rerunVerify: rerun} : {})
    })
    return {
        open: new Set(r.open.map(keyOf)),
        resolved: new Set(r.resolved.map(keyOf)),
        trail: r.trail
    }
}

const sameSet = (a: Set<string>, b: Set<string>): boolean =>
    a.size === b.size && [...a].every(x => b.has(x))

// ─── report ──────────────────────────────────────────────────────────────────

const failures: string[] = []
const abstains: string[] = []
function check(name: string, ok: boolean, detail: string): void {
    console.log(`   ${ok ? 'HOLDS ' : 'BREAK '} ${name.padEnd(28)} ${detail}`)
    if (!ok) failures.push(`${name}: ${detail}`)
}

async function main(): Promise<void> {
    const runs = collectRuns()
    const mx5Run19 = runs.find(r => r.tree === MX5 && r.label.endsWith('@worktree'))
    console.log('A/B — VERIFY-COMMAND debt class (nexttask 5)')
    console.log(`corpus: ${runs.length} recorded run snapshot(s)`)
    if (runs.length === 0 || !mx5Run19) {
        console.log('ABSTAIN — the recorded ledgers are unavailable (mx5 run 19 ledger not found).')
        process.exit(2)
    }

    // ── inertness: with nothing observable, treatment MUST equal baseline ─────
    console.log('')
    console.log('── inv-no-false-clear (whole corpus, re-runner stubbed)')
    for (const stub of [
        {name: 'always FAIL', fn: (): VerifyRerunResult => ({outcome: 'fail', detail: 'stub'})},
        {name: 'always GAP', fn: (): VerifyRerunResult => ({outcome: 'gap', detail: 'stub'})}
    ]) {
        let diverged = 0
        let classified = 0
        for (const run of runs) {
            const withCmd = withVerifyCommands(run)
            classified += withCmd.filter(d => d.verifyCommand !== undefined).length
            const base = arm(run.debts, run.tree, undefined)
            const treat = arm(withCmd, run.tree, stub.fn)
            if (!sameSet(base.open, treat.open)) diverged++
        }
        check(
            'inv-no-false-clear',
            diverged === 0,
            `${stub.name}: ${diverged} run(s) diverged from baseline `
                + `(${classified} classified debt(s) across the corpus)`
        )
    }

    // ── inv-existing-classes-kept + inv-command-provenance, whole corpus ──────
    console.log('')
    console.log('── inv-existing-classes-kept / inv-command-provenance (whole corpus)')
    let lostClose = 0
    let badProvenance = 0
    let provenanceChecked = 0
    for (const run of runs) {
        const withCmd = withVerifyCommands(run)
        const base = arm(run.debts, run.tree, undefined)
        // Treatment with an always-gap re-runner: the OLD classes must still make
        // every close they made, independently of anything the new class does.
        const treat = arm(withCmd, run.tree, () => ({outcome: 'gap'}))
        for (const k of base.resolved) if (!treat.resolved.has(k)) lostClose++
        for (const d of withCmd) {
            if (d.verifyCommand === undefined) continue
            provenanceChecked++
            const spec = run.readSpec(d.taskId)
            const cmds = spec === null ? null : parseVerifyBlockStrict(spec)
            const lines = (cmds ?? []).map(c => c.raw)
            if (!lines.includes(d.verifyCommand)) badProvenance++
        }
    }
    check('inv-existing-classes-kept', lostClose === 0, `${lostClose} shipped close(s) lost`)
    check(
        'inv-command-provenance',
        badProvenance === 0,
        `${provenanceChecked} stored command(s) checked against their spec's closed VERIFY fence, `
            + `${badProvenance} not byte-identical`
    )

    // ── inv-bounded: the re-run budget caps a big ledger ─────────────────────
    console.log('')
    console.log('── inv-bounded')
    const many: AcceptDebt[] = Array.from({length: 10}, (_, i) => ({
        taskId: `TASK_${String(i).padStart(4, '0')}`,
        reason: 'work did not verify: `bun test` fails',
        origin: 'yolo-accepted' as const,
        verifyCommand: 'bun test'
    }))
    let calls = 0
    const capped = recheckAcceptDebts(many, {
        staticOk: true,
        rerunVerify: () => {
            calls++
            return {outcome: 'gap', detail: 'stub'}
        }
    })
    check(
        'inv-bounded',
        calls <= 3 && capped.open.length === 10,
        `10 classified debts → ${calls} re-run(s), ${capped.open.length} still open`
    )

    // ── the headline: mx5 run 19, executed for real ──────────────────────────
    console.log('')
    console.log('── mx5 run 19 — the pre-registered metric (real re-runs, in a clone)')
    const clone = cloneOf(mx5Run19.tree)
    if (clone === null) {
        console.log('ABSTAIN — could not clone the mx5 tree; nothing was measured.')
        process.exit(2)
    }
    console.log(`   clone: ${clone}`)
    const withCmd = withVerifyCommands(mx5Run19)
    for (const d of withCmd) {
        console.log(
            `   ${d.taskId.padEnd(12)} ${(d.origin ?? 'accepted').padEnd(16)} `
                + (d.verifyCommand ? `→ \`${d.verifyCommand}\`` : '→ (no command named)')
        )
    }
    const base = arm(mx5Run19.debts, mx5Run19.tree, undefined)
    const observed: Array<{taskId: string; outcome: string; detail: string}> = []
    const treat = arm(withCmd, mx5Run19.tree, (cmd, d) => {
        // The SHIPPED wrapper — env-gap contract plus the no-write guard — pointed at
        // the clone. Nothing about the measurement path is a copy of the product.
        const r = rerunDebtVerifyCommand(clone, cmd)
        observed.push({taskId: d.taskId, outcome: r.outcome, detail: r.detail ?? ''})
        return r
    })
    for (const o of observed) {
        console.log(`   re-ran for ${o.taskId}: ${o.outcome.toUpperCase()} ${o.detail.slice(0, 200)}`)
    }
    for (const line of treat.trail) console.log(`   trail: ${line}`)

    const closed = [...base.open].filter(k => !treat.open.has(k))
    const closedIds = closed.map(k => k.split('|')[0])
    console.log(`   baseline open: ${base.open.size}   treatment open: ${treat.open.size}`)
    console.log(`   closed by the treatment: ${closedIds.length > 0 ? closedIds.join(', ') : '(none)'}`)

    // inv-no-write, measured on the real re-runs.
    const mutating = observed.filter(o => /CHANGED tracked files/.test(o.detail))
    check(
        'inv-no-write',
        mutating.length === 0,
        mutating.length === 0 ?
            `${observed.length} re-run(s), none changed tracked state`
        :   `${mutating.length} re-run(s) mutated the tree and were downgraded to gaps`
    )

    // inv-prohibition-never-closes — TASK_0019 is the live fixture.
    const t19Open = [...treat.open].some(k => k.startsWith('TASK_0019|'))
    check(
        'inv-prohibition-never-closes',
        t19Open,
        t19Open ?
            'TASK_0019 (main.tsx edited under a spec freeze) stays OPEN'
        :   'TASK_0019 CLOSED — an outright FAIL of this task'
    )
    // …and it is evidence only if its VERIFY really does pass today.
    const spec19 = mx5Run19.readSpec('TASK_0019')
    const v19 = spec19 === null ? null : parseVerifyBlockStrict(spec19)
    for (const c of v19 ?? []) {
        const r = rerunDebtVerifyCommand(clone, c.raw)
        console.log(
            `   TASK_0019 VERIFY \`${c.raw.slice(0, 70)}\` → ${r.outcome.toUpperCase()} `
                + `${(r.detail ?? '').slice(0, 120)}`
        )
    }

    // The target: did the environment even observe the command?
    const target = observed.find(o => o.taskId === 'TASK_0009')
    if (target === undefined) {
        abstains.push('run 19 TASK_0009 carries no stored command — nothing was re-run')
    } else if (target.outcome === 'gap') {
        abstains.push(
            `run 19's target command was INCONCLUSIVE here (${target.detail.slice(0, 160)}) — `
                + 'the environment could not observe it, so the metric was not measured'
        )
    }
    check(
        'metric: closes TASK_0009',
        closedIds.length === 1 && closedIds[0] === 'TASK_0009',
        `closed = [${closedIds.join(', ')}], expected exactly [TASK_0009]`
    )

    // ── end-to-end through the SHIPPED seam, in the clone ────────────────────
    //
    // Everything above drives recheckAcceptDebts directly. This drives the two
    // functions a real run actually calls — recordYoloAcceptDebt (record side, which
    // classifies against the task spec on disk) and deriveOpenDebts (close side,
    // which re-runs and PRUNES the ledger) — so the wiring is measured, not assumed.
    // Runs last: it rewrites the clone's ledger, which is a tracked file in mx5.
    console.log('')
    console.log('── end-to-end: recordYoloAcceptDebt → deriveOpenDebts, in the clone')
    {
        await writeAcceptDebts(clone, [])
        for (const d of mx5Run19.debts) {
            await recordYoloAcceptDebt(clone, d.taskId, d.reason)
        }
        const stored = await readAcceptDebts(clone)
        const storedCmds = stored.filter(d => d.verifyCommand !== undefined)
        console.log(
            `   recorded ${stored.length} debt(s); ${storedCmds.length} carry a command: `
                + storedCmds.map(d => `${d.taskId}=\`${d.verifyCommand}\``).join(', ')
        )
        const derived = await deriveOpenDebts(clone, true)
        for (const line of derived.trail ?? []) console.log(`   trail: ${line}`)
        const openIds = derived.openDebts.map(d => d.taskId).sort()
        const ledgerIds = (await readAcceptDebts(clone)).map(d => d.taskId).sort()
        check(
            'end-to-end close',
            openIds.join(',') === 'TASK_0001,TASK_0019'
                && ledgerIds.join(',') === 'TASK_0001,TASK_0019',
            `open after derive = [${openIds.join(', ')}], pruned ledger = [${ledgerIds.join(', ')}]`
        )
    }
    finish()
}

function finish(): never {
    console.log('')
    if (abstains.length > 0 && failures.every(f => f.startsWith('metric:'))) {
        console.log('VERDICT: ABSTAIN')
        for (const a of abstains) console.log(`   ${a}`)
        console.log(`   (clone left at ${workRoot} — delete when done)`)
        process.exit(2)
    }
    if (failures.length > 0) {
        console.log('VERDICT: FAIL')
        for (const f of failures) console.log(`   ${f}`)
        console.log(`   (clone left at ${workRoot} — delete when done)`)
        process.exit(1)
    }
    console.log('VERDICT: PASS — run 19 closes TASK_0009 and only TASK_0009; all invariants hold.')
    console.log(`   (clone left at ${workRoot} — delete when done)`)
    process.exit(0)
}

void main()
