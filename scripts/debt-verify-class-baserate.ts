/**
 * STEP 0 — base rate for the VERIFY-COMMAND DEBT CLASS (nexttask 5), measured
 * BEFORE the close-side change. Deterministic, no model, no PI_BIN, no network
 * (the optional `--run` pass runs the project's own commands, nothing else).
 *
 * The defect (mx5 run 19): the run ended reporting "3 recorded verify-FAIL
 * defect(s) are STILL unresolved". One of the three — TASK_0009, whose reason
 * quotes `AGENT=1 bun test test/listings.test.ts` — had been FIXED by the
 * final-gate autofix eleven minutes earlier, and the gate's own re-run printed
 * `121 pass 0 fail`. The re-check did not miss it; it could not possibly have
 * seen it. `recheckAcceptDebts` auto-closes exactly two classes (cross-task
 * deletion, `repo health:` statics) and all three debts are `work unobserved:` /
 * `work did not verify:` — no reachable code path could ever close any of them.
 *
 * The proposed third class: a debt whose reason quotes, IN BACKTICKS, a string
 * that appears BYTE-IDENTICALLY in the owning task's VERIFY block. Store that
 * command at record time, re-run it at run end, close ONLY on exit 0.
 *
 * The pre-registered questions this script answers, before that code exists:
 *
 *   1. How many recorded debts are CLASSIFIABLE (their reason names a verbatim
 *      VERIFY command)? Per pool, per tree, per run.
 *   2. For those, what does the command do TODAY: pass / fail / env-gap?
 *   3. What do the UNCLASSIFIABLE ones look like — and, the question that
 *      decides whether this lever is safe at all, does any PROHIBITION-shaped
 *      debt classify? (A prohibition violation is permanent; its task's VERIFY
 *      can pass while the violation stands. Closing one is the single outcome
 *      this lever must never produce — `inv-prohibition-never-closes`.)
 *
 * PRE-REGISTERED TRIPWIRE (nexttask 5, STEP 0): if classification lands above
 * ~80% of all debts the matcher is too loose and the misses must be read by hand
 * before any of this is wired. The script prints the verdict against that line
 * and dumps every reason, classified or not, so "read them by hand" is a thing
 * that can actually be done from one run of it.
 *
 * CORPUS. Every `<tree>/.pi-tasks/accept-debt.md` under ~/hub, ~/tmp, ~/.cache —
 * plus, for trees that TRACK `.pi-tasks/` (mx5 does), every historical version of
 * that file in git, each paired with the task specs AS THEY WERE at that commit.
 * That is what recovers run 18 and run 17: the live file only ever holds the
 * newest run's ledger. Ledgers are read as git blobs, never by checking anything
 * out over a worktree (see memory/open-debt-lifecycle-6a.md — a replay that
 * checked a tag out rewrote mx5's live ledger).
 *
 * ISOLATION for `--run`. A VERIFY command is the project's own test/build command
 * and may WRITE. The corpus is evidence and must stay byte-identical, so nothing
 * runs in a source tree: each tree is materialised into a throwaway
 * `cp -a --reflink=auto` copy under ~/.cache first (same pattern as
 * scripts/boot-skip-corpus.ts — the corpus is on btrfs, so the clone is near
 * free) and the command runs there. `git status --porcelain` is captured before
 * and after inside the clone anyway, because that guard is part of the shipped
 * contract this measures.
 *
 * Run: bun run scripts/debt-verify-class-baserate.ts
 *      bun run scripts/debt-verify-class-baserate.ts --run     (executes the
 *          classified commands in throwaway clones; slow, needs the projects'
 *          own toolchains)
 */
import {execFileSync, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {parseAcceptDebts, verifyCommandFromReason, type AcceptDebt} from '../src/task/accept-debt.js'
import {runVerifyCommandLine} from '../src/task/final-gate.js'
import {parseVerifyBlock, parseVerifyBlockStrict} from '../src/task/spec-validation.js'

const HOME = os.homedir()
const DO_RUN = process.argv.includes('--run')
const PER_COMMAND_TIMEOUT_MS = 300_000

// ─── corpus discovery ────────────────────────────────────────────────────────

const SEARCH_ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]

/** Depth-limited walk for `<tree>/.pi-tasks/accept-debt.md`. */
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

/** A real project run vs a throwaway A/B trial tree (same split as nexttask 6). */
function poolOf(tree: string): 'PROJECT' | 'TRIAL' {
    const rel = path.relative(HOME, tree)
    if (rel.startsWith('hub' + path.sep)) return 'PROJECT'
    if (rel === path.join('tmp', 'fixcheck')) return 'PROJECT'
    return 'TRIAL'
}

/** One recorded ledger + the task specs that were alongside it. */
interface RunSnapshot {
    tree: string
    pool: 'PROJECT' | 'TRIAL'
    /** `mx5@worktree` / `mx5@a9c6145` — one recorded run of that tree. */
    label: string
    ledgerRaw: string
    /** The task spec text for an id, as of this snapshot. Null when absent. */
    readSpec: (taskId: string) => string | null
}

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
    } catch {
        return null
    }
}

function worktreeSnapshot(ledgerFile: string): RunSnapshot | null {
    const tasks = path.dirname(ledgerFile)
    const tree = path.dirname(tasks)
    let raw: string
    try {
        raw = fs.readFileSync(ledgerFile, 'utf8').trim()
    } catch {
        return null
    }
    if (raw.length === 0) return null
    return {
        tree,
        pool: poolOf(tree),
        label: `${path.basename(tree)}@worktree`,
        ledgerRaw: raw,
        readSpec: id => {
            try {
                return fs.readFileSync(path.join(tasks, `${id}.md`), 'utf8')
            } catch {
                return null
            }
        }
    }
}

/**
 * Historical ledgers from git. Only meaningful where `.pi-tasks/` is tracked;
 * everywhere else this returns nothing and costs one `git log`.
 */
function historySnapshots(tree: string): RunSnapshot[] {
    if (!fs.existsSync(path.join(tree, '.git'))) return []
    const log = git(tree, ['log', '--all', '--format=%H', '--', '.pi-tasks/accept-debt.md'])
    if (log === null) return []
    const out: RunSnapshot[] = []
    for (const sha of log.split('\n').map(s => s.trim()).filter(Boolean)) {
        const raw = git(tree, ['show', `${sha}:.pi-tasks/accept-debt.md`])
        if (raw === null || raw.trim().length === 0) continue
        out.push({
            tree,
            pool: poolOf(tree),
            label: `${path.basename(tree)}@${sha.slice(0, 7)}`,
            ledgerRaw: raw.trim(),
            readSpec: id => git(tree, ['show', `${sha}:.pi-tasks/${id}.md`])
        })
    }
    return out
}

// ─── classification ──────────────────────────────────────────────────────────

type MissCause =
    | 'no-task-id'
    | 'no-task-file'
    | 'no-verify-block'
    | 'unterminated-verify-fence'
    | 'no-backticks'
    | 'backticks-do-not-match'

interface Row {
    snapshot: RunSnapshot
    debt: AcceptDebt
    verifyCommands: string[]
    /** The verbatim VERIFY line the reason names, or null. */
    command: string | null
    miss: MissCause | null
    /** Does the reason read as a PROHIBITION/constraint violation? (Audit only —
     *  never an input to classification; see the safety question above.) */
    prohibitionShaped: boolean
}

/**
 * Reason text that reads as a permanent CONSTRAINT violation rather than a
 * failing command: a frozen/prohibited path was edited, a spec prohibition was
 * broken. Used ONLY to audit the classifier (does this lever ever tag one?), so
 * it is deliberately generous — a false positive here costs nothing but a line in
 * the report, while a miss would hide the exact risk being measured.
 */
const PROHIBITION_RE =
    /\b(?:prohibit\w*|forbidd?\w*|not allowed|must not|may not|do not modify|frozen|freeze|violat\w*|out of scope|scope fence)\b/i

function classify(snapshot: RunSnapshot, debt: AcceptDebt): Row {
    const base = {snapshot, debt, prohibitionShaped: PROHIBITION_RE.test(debt.reason)}
    if (debt.taskId.length === 0) {
        return {...base, verifyCommands: [], command: null, miss: 'no-task-id'}
    }
    const spec = snapshot.readSpec(debt.taskId)
    if (spec === null) return {...base, verifyCommands: [], command: null, miss: 'no-task-file'}
    const parsed = parseVerifyBlockStrict(spec)
    if (parsed === null || parsed.length === 0) {
        // An unclosed fence is reported separately: the lenient parser DOES return
        // commands there (everything to EOF), so this bucket is exactly the set of
        // specs where a looser matcher would have invented provenance.
        const lenient = parseVerifyBlock(spec)
        const miss: MissCause =
            parsed === null && lenient !== null && lenient.length > 0 ?
                'unterminated-verify-fence'
            :   'no-verify-block'
        return {...base, verifyCommands: [], command: null, miss}
    }
    const verifyCommands = parsed.map(c => c.raw)
    const command = verifyCommandFromReason(debt.reason, verifyCommands)
    if (command !== null) return {...base, verifyCommands, command, miss: null}
    return {
        ...base,
        verifyCommands,
        command: null,
        miss: /`[^`]+`/.test(debt.reason) ? 'backticks-do-not-match' : 'no-backticks'
    }
}

// ─── the `--run` pass ────────────────────────────────────────────────────────

/** A scratch root on the same filesystem as the corpus (btrfs → reflink clones). */
function makeWorkRoot(): string {
    const base = path.join(HOME, '.cache', 'pi-task-debt-verify')
    fs.mkdirSync(base, {recursive: true})
    return fs.mkdtempSync(path.join(base, 'step0-'))
}

function cloneTree(tree: string, dest: string): boolean {
    const r = spawnSync('cp', ['-a', '--reflink=auto', tree, dest], {encoding: 'utf8'})
    return r.status === 0
}

function porcelain(cwd: string): string {
    return git(cwd, ['status', '--porcelain']) ?? '(git status unavailable)'
}

interface RunResult {
    outcome: 'pass' | 'fail' | 'gap'
    detail: string
    /** Did the re-run itself change tracked state? (`inv-no-write`.) */
    mutated: boolean
}

async function runOne(clone: string, command: string): Promise<RunResult> {
    const before = porcelain(clone)
    const r = (await runVerifyCommandLine(clone, command, PER_COMMAND_TIMEOUT_MS))
    const after = porcelain(clone)
    const mutated = before !== after
    if (r.outcome === 'pass') return {outcome: 'pass', detail: 'exit 0', mutated}
    if (r.outcome === 'gap') return {outcome: 'gap', detail: r.detail, mutated}
    return {outcome: 'fail', detail: `exit ${r.status} — ${r.tail.slice(0, 160)}`, mutated}
}

// ─── report ──────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
    return total === 0 ? '  n/a' : `${((100 * n) / total).toFixed(1)}%`
}

function short(s: string, n = 150): string {
    return s.length > n ? `${s.slice(0, n)}…` : s
}

async function main(): Promise<void> {
    const snapshots: RunSnapshot[] = []
    const seenTrees = new Set<string>()
    for (const f of SEARCH_ROOTS.flatMap(r => findLedgers(r))) {
        const s = worktreeSnapshot(f)
        if (!s) continue
        snapshots.push(s)
        seenTrees.add(s.tree)
    }
    for (const tree of [...seenTrees].filter(t => poolOf(t) === 'PROJECT')) {
        snapshots.push(...historySnapshots(tree))
    }

    // Dedup identical (tree, taskId, origin, reason): the same debt re-committed
    // across several snapshots is ONE recorded debt, not evidence repeated.
    const rows: Row[] = []
    const seen = new Set<string>()
    for (const s of snapshots) {
        for (const d of parseAcceptDebts(s.ledgerRaw)) {
            const key = `${s.tree}\t${d.taskId}\t${d.origin ?? 'accepted'}\t${d.reason}`
            if (seen.has(key)) continue
            seen.add(key)
            rows.push(classify(s, d))
        }
    }

    const project = rows.filter(r => r.snapshot.pool === 'PROJECT')
    const trial = rows.filter(r => r.snapshot.pool === 'TRIAL')
    // The TRIAL pool is the same 1-3 task fixture run dozens of times; its raw
    // count overstates independence, so it is also reported deduped by content.
    const trialDeduped = [
        ...new Map(
            trial.map(r => [`${r.debt.taskId}\t${r.debt.origin}\t${r.debt.reason}`, r])
        ).values()
    ]

    console.log('VERIFY-COMMAND DEBT CLASS — STEP 0 base rate (nexttask 5)')
    console.log(
        `corpus: ${snapshots.length} recorded ledger snapshot(s) across ${seenTrees.size} tree(s); `
            + `${rows.length} distinct debt(s)`
    )
    console.log(`run pass: ${DO_RUN ? 'ON (--run, throwaway clones)' : 'off (classification only)'}`)
    console.log('')

    const report = (name: string, set: Row[]): void => {
        const hit = set.filter(r => r.command !== null)
        console.log(`── ${name}: ${set.length} debt(s)`)
        console.log(`   CLASSIFIABLE (reason names a verbatim VERIFY line): ${hit.length}  (${pct(hit.length, set.length)})`)
        const causes = new Map<MissCause, number>()
        for (const r of set) if (r.miss) causes.set(r.miss, (causes.get(r.miss) ?? 0) + 1)
        console.log('   misses by cause:')
        for (const c of [
            'no-task-id',
            'no-task-file',
            'no-verify-block',
            'unterminated-verify-fence',
            'no-backticks',
            'backticks-do-not-match'
        ] as MissCause[]) {
            console.log(`      ${c.padEnd(24)} ${causes.get(c) ?? 0}`)
        }
        const proh = set.filter(r => r.prohibitionShaped)
        const prohHit = proh.filter(r => r.command !== null)
        console.log(
            `   prohibition-shaped reasons: ${proh.length}, of which CLASSIFIED: ${prohHit.length}`
                + (prohHit.length > 0 ? '   ← READ THESE BY HAND' : '')
        )
        console.log('')
    }

    report('PROJECT pool (real multi-task runs)', project)
    report('TRIAL pool (A/B trees, raw)', trial)
    report('TRIAL pool (deduped by task+origin+reason)', trialDeduped)

    console.log('── PROJECT pool, every debt')
    for (const r of project) {
        console.log(
            `   ${r.snapshot.label.padEnd(22)} ${(r.debt.taskId || '(none)').padEnd(12)} `
                + `${(r.debt.origin ?? 'accepted').padEnd(18)} `
                + (r.command !== null ? `CLASSIFIED → \`${r.command}\`` : `miss:${r.miss}`)
                + (r.prohibitionShaped ? '  [prohibition-shaped]' : '')
        )
        console.log(`        reason: ${short(r.debt.reason, 220)}`)
        if (r.command === null && r.verifyCommands.length > 0) {
            console.log(`        VERIFY: ${r.verifyCommands.map(c => `\`${c}\``).join('  ')}`)
        }
    }
    console.log('')

    console.log('── TRIAL pool (deduped), every debt')
    for (const r of trialDeduped) {
        console.log(
            `   ${r.snapshot.label.padEnd(22)} ${(r.debt.taskId || '(none)').padEnd(12)} `
                + (r.command !== null ? `CLASSIFIED → \`${r.command}\`` : `miss:${r.miss}`)
        )
        console.log(`        reason: ${short(r.debt.reason)}`)
    }
    console.log('')

    // ─── what do the classified commands do TODAY? ───────────────────────────
    if (DO_RUN) {
        const hits = project.filter(r => r.command !== null)
        console.log(`── RUN PASS — ${hits.length} classified PROJECT command(s), in throwaway clones`)
        const root = makeWorkRoot()
        const clones = new Map<string, string | null>()
        for (const r of hits) {
            let clone = clones.get(r.snapshot.tree)
            if (clone === undefined) {
                const dest = path.join(root, path.basename(r.snapshot.tree))
                clone = cloneTree(r.snapshot.tree, dest) ? dest : null
                clones.set(r.snapshot.tree, clone)
                console.log(`   clone ${path.relative(HOME, r.snapshot.tree)} → ${clone ?? 'FAILED'}`)
            }
            if (clone === null) {
                console.log(`   ${r.snapshot.label} ${r.debt.taskId}: SKIPPED (clone failed)`)
                continue
            }
            const res = (await runOne(clone, r.command!))
            console.log(
                `   ${r.snapshot.label.padEnd(22)} ${r.debt.taskId.padEnd(12)} `
                    + `\`${r.command}\` → ${res.outcome.toUpperCase()} (${short(res.detail, 180)})`
                    + (res.mutated ? '   ⚠ MUTATED TRACKED STATE' : '')
            )
        }
        console.log(`   (clones left at ${root} — delete when done reading)`)
        console.log('')
    }

    // ─── verdict against the pre-registered tripwire ─────────────────────────
    const all = [...project, ...trialDeduped]
    const rate = all.length === 0 ? 0 : (100 * all.filter(r => r.command !== null).length) / all.length
    console.log('── VERDICT (pre-registered tripwire: >~80% classified ⇒ matcher too loose)')
    console.log(`   overall classified (PROJECT + deduped TRIAL): ${rate.toFixed(1)}%`)
    if (rate > 80) {
        console.log('   ABOVE the line — do NOT proceed on this number. Read the misses by hand.')
    } else {
        console.log('   below the line — the matcher is selective, as designed.')
    }
    const prohClassified = all.filter(r => r.prohibitionShaped && r.command !== null)
    console.log(
        `   prohibition-shaped debts that CLASSIFIED: ${prohClassified.length}`
            + (prohClassified.length === 0 ?
                ' — no corpus debt trips inv-prohibition-never-closes at record time.'
            :   ' — EACH ONE IS A CANDIDATE FALSE CLOSE; read them above before wiring.')
    )
}

void main()
