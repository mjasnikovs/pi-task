/**
 * STEP 0 — base rate for YOLO AUTO-ACCEPT (nexttask 6), measured BEFORE any
 * change. Deterministic: reads recorded task specs, runs no model, no network,
 * writes nothing outside its own stdout.
 *
 * The defect (mx5 run 19): two of the three shipped defects were auto-ACCEPTED
 * under YOLO after ZERO unattended autofix attempts out of a budget of three,
 * and the durable trail says the opposite — "autofix budget spent, nobody to
 * ask". `autoFixNow` (src/task/task-gates.ts:545-549) is false for FOUR
 * different reasons and the single recorded line asserts only one of them.
 *
 * The question this script answers, before the lever exists: of every recorded
 * `auto-ACCEPTED despite verify FAIL`, how many were
 *
 *   UNOBSERVED       tooling absent — an unattended re-run cannot provision it
 *   FROZEN-BLOCKED   repo-health FAIL only fixable by editing a spec-frozen path
 *   BUDGET-SPENT     the trail's claim is TRUE (>= MAX_AUTO_AUTOFIX attempts)
 *   BUDGET-UNUSED    recommend=ACCEPT with the budget untouched  <-- the target
 *
 * BUDGET-UNUSED is the ceiling of what the lever can win, and every other
 * bucket is a line the truthful-trail fix (part 1) must name correctly.
 *
 * PRE-REGISTERED STOP RULE (nexttask 6): "if most accepts are UNOBSERVED or
 * frozen-blocked, the lever is worth little — say so and stop." This script
 * prints the verdict against that line.
 *
 * CORPUS. Every `<tree>/.pi-tasks/TASK_*.md` under ~/hub, ~/tmp, ~/.cache, plus
 * — for trees that TRACK `.pi-tasks/` (mx5 does) — every historical version of
 * those files, read as git BLOBS (`git rev-list --all --objects` +
 * `git cat-file --batch`). Nothing is ever checked out over a worktree: see
 * memory/open-debt-lifecycle-6a.md, where a replay that checked a tag out
 * rewrote mx5's live ledger.
 *
 * Accept events are keyed by tree + task id + the line's exact ISO timestamp,
 * so the same event recorded in N successive blobs collapses to one row.
 *
 * Run: bun run scripts/yolo-accept-baserate.ts
 *      bun run scripts/yolo-accept-baserate.ts --reasons   (full FAIL reasons)
 */
import {execFileSync, spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {MAX_AUTO_AUTOFIX} from '../src/task/task-gates.js'

const HOME = os.homedir()
const FULL_REASONS = process.argv.includes('--reasons')
const SEARCH_ROOTS = [path.join(HOME, 'hub'), path.join(HOME, 'tmp'), path.join(HOME, '.cache')]

// ─── corpus discovery ────────────────────────────────────────────────────────

/** Depth-limited walk for `<tree>/.pi-tasks` directories. */
function findTaskDirs(root: string, depth = 0, out: string[] = []): string[] {
    if (depth > 5) return out
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
            out.push(dir)
            continue
        }
        findTaskDirs(dir, depth + 1, out)
    }
    return out
}

/** A real project run vs a throwaway A/B trial tree. */
function poolOf(tree: string): 'PROJECT' | 'TRIAL' {
    const rel = path.relative(HOME, tree)
    if (rel.startsWith('hub' + path.sep)) return 'PROJECT'
    if (rel === path.join('tmp', 'fixcheck')) return 'PROJECT'
    return 'TRIAL'
}

function git(cwd: string, args: string[]): string | null {
    try {
        return execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024})
    } catch {
        return null
    }
}

/** One recorded task spec: its text plus where it came from. */
interface Doc {
    tree: string
    taskId: string
    text: string
}

const TASK_FILE_RE = /^TASK_[A-Za-z0-9_]+\.md$/

function worktreeDocs(taskDir: string): Doc[] {
    const tree = path.dirname(taskDir)
    const out: Doc[] = []
    let names: string[]
    try {
        names = fs.readdirSync(taskDir)
    } catch {
        return out
    }
    for (const name of names) {
        if (!TASK_FILE_RE.test(name)) continue
        try {
            out.push({tree, taskId: name.replace(/\.md$/, ''), text: fs.readFileSync(path.join(taskDir, name), 'utf8')})
        } catch {
            // unreadable file: nothing to measure
        }
    }
    return out
}

/**
 * Every historical version of every `.pi-tasks/TASK_*.md` blob in a tree, read
 * without touching the working copy. Trees that do not track `.pi-tasks/`
 * return nothing and cost one `git rev-list`.
 */
function historyDocs(tree: string): Doc[] {
    if (!fs.existsSync(path.join(tree, '.git'))) return []
    const listing = git(tree, ['rev-list', '--all', '--objects', '--', '.pi-tasks'])
    if (listing === null) return []
    // blob sha -> task id (same blob can appear under several ids; keep the first)
    const blobs = new Map<string, string>()
    for (const line of listing.split('\n')) {
        const sp = line.indexOf(' ')
        if (sp < 0) continue
        const sha = line.slice(0, sp)
        const file = path.basename(line.slice(sp + 1))
        if (!TASK_FILE_RE.test(file)) continue
        if (!blobs.has(sha)) blobs.set(sha, file.replace(/\.md$/, ''))
    }
    if (blobs.size === 0) return []
    // One `cat-file --batch` for all of them: the corpus has thousands of blobs.
    const res = spawnSync('git', ['cat-file', '--batch'], {
        cwd: tree,
        input: [...blobs.keys()].join('\n') + '\n',
        maxBuffer: 1024 * 1024 * 1024
    })
    if (res.status !== 0 || !res.stdout) return []
    const out: Doc[] = []
    const buf = res.stdout
    let off = 0
    while (off < buf.length) {
        const nl = buf.indexOf(0x0a, off)
        if (nl < 0) break
        const header = buf.toString('utf8', off, nl)
        const [sha, type, sizeStr] = header.split(' ')
        if (type !== 'blob') break
        const size = Number(sizeStr)
        const start = nl + 1
        out.push({tree, taskId: blobs.get(sha) ?? 'TASK_?', text: buf.toString('utf8', start, start + size)})
        off = start + size + 1
    }
    return out
}

// ─── gate-log parsing ────────────────────────────────────────────────────────

/** `- 2026-08-04T13:22:39.410Z verify: FAIL — …` */
const LOG_LINE_RE = /^- (\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/

interface LogLine {
    ts: string
    text: string
}

function gateLog(text: string): LogLine[] {
    const out: LogLine[] = []
    for (const raw of text.split('\n')) {
        const m = LOG_LINE_RE.exec(raw.trimEnd())
        if (m) out.push({ts: m[1], text: m[2]})
    }
    return out
}

type Bucket = 'UNOBSERVED' | 'FROZEN-BLOCKED' | 'BUDGET-SPENT' | 'BUDGET-UNUSED' | 'NO-RECOMMENDER'

interface AcceptEvent {
    tree: string
    pool: 'PROJECT' | 'TRIAL'
    /** `mx5@2026-08-04` — the tree plus the calendar day of the accept. */
    run: string
    taskId: string
    ts: string
    bucket: Bucket
    /** The recommend value the trail recorded, when the ordinary path ran. */
    recommend: string | null
    autoFixCount: number
    failReason: string
}

const RE_ACCEPT = /^resolution: auto-ACCEPTED despite verify FAIL/
const RE_AUTOFIX = /^resolution: auto-AUTOFIX \(recommended, unattended (\d+)\//
const RE_RECOMMEND = /^resolution: recommended ([A-Z]+)/
const RE_UNOBSERVED = /^resolution: verify UNOBSERVED/
const RE_FROZEN = /^resolution: repo-health FAIL is blocked by spec-frozen path/
const RE_FAIL = /^verify: FAIL — (.*)$/s
const RE_PASS = /^verify: PASS/

/**
 * Replay one task's gate log and emit a row per auto-ACCEPT, reconstructing the
 * state `autoFixNow` saw at that moment: how many unattended attempts had
 * already been spent, and which of the four branches actually produced the
 * accept. `autoFixCount` is per-task and never reset (task-gates.ts:444), so it
 * accumulates across the whole log.
 */
function eventsFor(doc: Doc): AcceptEvent[] {
    const out: AcceptEvent[] = []
    let autoFixCount = 0
    let failReason = ''
    let lastResolution: 'unobserved' | 'frozen' | 'recommend' | null = null
    let recommend: string | null = null
    for (const line of gateLog(doc.text)) {
        const fail = RE_FAIL.exec(line.text)
        if (fail) {
            failReason = fail[1]
            continue
        }
        if (RE_PASS.test(line.text)) {
            failReason = ''
            continue
        }
        const af = RE_AUTOFIX.exec(line.text)
        if (af) {
            autoFixCount = Number(af[1])
            continue
        }
        if (RE_UNOBSERVED.test(line.text)) {
            lastResolution = 'unobserved'
            recommend = null
            continue
        }
        if (RE_FROZEN.test(line.text)) {
            lastResolution = 'frozen'
            recommend = null
            continue
        }
        const rc = RE_RECOMMEND.exec(line.text)
        if (rc) {
            lastResolution = 'recommend'
            recommend = rc[1]
            continue
        }
        if (!RE_ACCEPT.test(line.text)) continue
        const bucket: Bucket =
            lastResolution === 'unobserved' ? 'UNOBSERVED'
            : lastResolution === 'frozen' ? 'FROZEN-BLOCKED'
            : lastResolution === null ? 'NO-RECOMMENDER'
            : autoFixCount >= MAX_AUTO_AUTOFIX ? 'BUDGET-SPENT'
            : 'BUDGET-UNUSED'
        out.push({
            tree: doc.tree,
            pool: poolOf(doc.tree),
            run: `${path.basename(doc.tree)}@${line.ts.slice(0, 10)}`,
            taskId: doc.taskId,
            ts: line.ts,
            bucket,
            recommend,
            autoFixCount,
            failReason
        })
    }
    return out
}

// ─── report ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
    return d === 0 ? '  n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`
}

function main(): void {
    const taskDirs = SEARCH_ROOTS.flatMap(r => findTaskDirs(r))
    const trees = [...new Set(taskDirs.map(d => path.dirname(d)))]
    const docs: Doc[] = []
    for (const dir of taskDirs) docs.push(...worktreeDocs(dir))
    for (const tree of trees) docs.push(...historyDocs(tree))

    // Dedupe events across blob generations: an accept is identified by the tree,
    // the task and the exact timestamp it was written at.
    const seen = new Map<string, AcceptEvent>()
    let tasksWithLog = 0
    let totalFails = 0
    for (const doc of docs) {
        const log = gateLog(doc.text)
        if (log.length > 0) tasksWithLog += 1
        totalFails += log.filter(l => RE_FAIL.test(l.text)).length
        for (const ev of eventsFor(doc)) {
            const key = `${ev.tree} ${ev.taskId} ${ev.ts}`
            if (!seen.has(key)) seen.set(key, ev)
        }
    }
    const events = [...seen.values()].sort((a, b) => (a.run + a.taskId).localeCompare(b.run + b.taskId))

    console.log('YOLO AUTO-ACCEPT — STEP 0 base rate (nexttask 6)')
    console.log(`corpus: ${trees.length} trees, ${docs.length} task-spec versions, ${tasksWithLog} with a gate log`)
    console.log(`        ${totalFails} recorded verify: FAIL lines, ${events.length} distinct auto-ACCEPT events`)
    console.log(`MAX_AUTO_AUTOFIX = ${MAX_AUTO_AUTOFIX}`)
    console.log('')

    const buckets: Bucket[] = ['UNOBSERVED', 'FROZEN-BLOCKED', 'BUDGET-SPENT', 'BUDGET-UNUSED', 'NO-RECOMMENDER']
    const pools = ['PROJECT', 'TRIAL'] as const
    console.log('bucket            all            PROJECT          TRIAL')
    for (const b of buckets) {
        const all = events.filter(e => e.bucket === b)
        const cells = pools.map(p => {
            const sub = events.filter(e => e.pool === p)
            const n = sub.filter(e => e.bucket === b).length
            return `${String(n).padStart(4)} ${pct(n, sub.length)}`
        })
        console.log(
            `${b.padEnd(16)} ${String(all.length).padStart(4)} ${pct(all.length, events.length)}   ${cells.join('   ')}`
        )
    }
    console.log('')

    // Per-run detail for the project pool: this is the evidence a human reads.
    const runs = [...new Set(events.filter(e => e.pool === 'PROJECT').map(e => e.run))].sort()
    console.log('PROJECT pool, per run:')
    for (const run of runs) {
        const rows = events.filter(e => e.run === run)
        console.log(`\n  ${run}  (${rows.length} accept${rows.length === 1 ? '' : 's'})`)
        for (const e of rows) {
            const rec = e.recommend ? ` recommend=${e.recommend}` : ''
            console.log(`    ${e.taskId}  ${e.bucket}  budget ${e.autoFixCount}/${MAX_AUTO_AUTOFIX}${rec}`)
            const reason = e.failReason.replace(/\s+/g, ' ')
            console.log(`      ${FULL_REASONS ? reason : reason.slice(0, 120)}`)
        }
    }
    console.log('')

    // Trial pool is huge and repetitive: summarise by (bucket, recommend) shape.
    const trialShapes = new Map<string, number>()
    for (const e of events.filter(x => x.pool === 'TRIAL')) {
        const k = `${e.bucket}  budget ${e.autoFixCount}/${MAX_AUTO_AUTOFIX}  recommend=${e.recommend ?? '-'}`
        trialShapes.set(k, (trialShapes.get(k) ?? 0) + 1)
    }
    console.log('TRIAL pool, by shape:')
    for (const [k, n] of [...trialShapes.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(5)}  ${k}`)
    }
    console.log('')

    // ── the pre-registered stop rule ─────────────────────────────────────────
    const unreachable = events.filter(e => e.bucket === 'UNOBSERVED' || e.bucket === 'FROZEN-BLOCKED').length
    const target = events.filter(e => e.bucket === 'BUDGET-UNUSED').length
    const spent = events.filter(e => e.bucket === 'BUDGET-SPENT').length
    console.log('CEILING')
    console.log(`  reachable by the lever (BUDGET-UNUSED)      ${target} / ${events.length}  ${pct(target, events.length)}`)
    console.log(`  unreachable (UNOBSERVED + FROZEN-BLOCKED)   ${unreachable} / ${events.length}  ${pct(unreachable, events.length)}`)
    console.log(`  trail claim already TRUE (BUDGET-SPENT)     ${spent} / ${events.length}  ${pct(spent, events.length)}`)
    console.log('')
    const mistrail = events.length - spent
    console.log(`  trail lines that MISSTATE the reason        ${mistrail} / ${events.length}  ${pct(mistrail, events.length)}`)
    console.log('')
    if (events.length === 0) {
        console.log('VERDICT: no auto-ACCEPT event in the corpus — nothing to measure.')
    } else if (unreachable > events.length / 2) {
        console.log('VERDICT: STOP — most accepts are UNOBSERVED or frozen-blocked; the lever is worth little.')
    } else {
        console.log(`VERDICT: PROCEED — ${target} of ${events.length} accepts sit on the branch the lever changes.`)
    }
}

main()
