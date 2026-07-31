/**
 * STEP 0 for nexttask 5 — the BASE RATE of DISCARDED research-worker attempts:
 * how many worker runs restart, why, how much wall clock that burns, and how much
 * of it sits on the run's critical path.
 *
 * WHY IT EXISTS. mx5 run 18 burned 30 whole-worker wall-clock timeouts — 120
 * minutes of compute thrown away, 42% of all worker wall time — and NONE of it
 * appeared in a log line or a timing widget. `waitMs`/`workMs` describe the FINAL
 * attempt only, and 21 of the 23 affected workers returned `exit=0`, so the run
 * recorded them as clean successes. The figure was only recoverable by
 * subtracting each worker's reported wait+work from the timestamps of the `start`
 * and `done` lines around it. This script is that arithmetic, made repeatable —
 * and, once 5A's instrumentation is in the logs, made unnecessary.
 *
 * TWO MODES, one report:
 *
 *   INSTRUMENTED  the `done` line carries `attempts=N total=Mms` (5A landed).
 *                 Attempts and discarded time are READ, not inferred, and every
 *                 restart has its own `RESTART (attempt N discarded) reason=…`
 *                 line naming the cause.
 *   INFERRED      pre-5A logs. Unreported wall (wall − wait − work) is divided by
 *                 the 240s worker cap. `residual` reports how far off an exact
 *                 multiple each inference lands — run 18's discrepancies are exact
 *                 multiples of 240 000 ms, which is what identified the cause.
 *
 * The inferred mode is what makes the two comparable: re-run this against a
 * post-5A run and the same numbers come out of instrumentation instead of
 * arithmetic. Agreement between the two on a log that has both is the check that
 * 5A measures what the arithmetic measured.
 *
 * CONFOUND, reported separately, never silently folded in: runSpec can call
 * runWorker more than once per `start`/`done` window (the empty-section retry, the
 * zero-retrieval retry, the silent retry). Those extra runs are also unreported
 * wall clock, so a window carrying one is marked `retryGate` and its inference is
 * NOT counted toward the timeout base rate.
 *
 * CRITICAL PATH. Research workers run concurrently when
 * `parallelResearchWorkers` is on (run 18: `research 730.1s` over two workers
 * reading 239s each), so only the SLOWEST worker in a task extends the run. Its
 * discarded time is the part that actually costs wall clock; the rest is wasted
 * compute that overlapped something else.
 *
 * Run:
 *   bun run scripts/research-restart-baserate.ts [--tasks <dir>] [--verbose]
 */
import {readdirSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const args = process.argv.slice(2)
const tasksDir =
    args.includes('--tasks') ?
        path.resolve(args[args.indexOf('--tasks') + 1]!)
    :   path.join(os.homedir(), 'hub', 'mx5', '.pi-tasks')
const verbose = args.includes('--verbose')

/** RESEARCH_WORKER_TIMEOUT_MS — the quantum every inferred discrepancy is a multiple of. */
const WORKER_TIMEOUT_MS = 240_000

interface WorkerRun {
    task: string
    label: string
    startMs: number
    doneMs: number
    /** done-line wait+work: the FINAL attempt's split. */
    reportedMs: number
    exitCode: number
    /** Read from `attempts=` when present (5A), else inferred from the timeout quantum. */
    attempts: number
    instrumented: boolean
    /** Restart causes: read from the done line's `restarts=[…]`, or inferred as timeouts. */
    reasons: string[]
    /** How far the unreported wall is from an exact multiple of the cap (inferred mode). */
    residualMs: number
    /** `.`-module (project-source) pi-worker-docs lookups inside the window. */
    projectLookups: number
    /** package-scoped pi-worker-docs lookups inside the window. */
    packageLookups: number
    /** A phase-level retry (empty / zero-retrieval / silent) ran inside this window. */
    retryGate: boolean
    degraded: boolean
}

const wallMs = (r: WorkerRun): number => r.doneMs - r.startMs
const discardedMs = (r: WorkerRun): number => Math.max(0, wallMs(r) - r.reportedMs)

const TS = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (worker:[a-z]+): (.*)$/

function parseLog(file: string, task: string): WorkerRun[] {
    const runs: WorkerRun[] = []
    // One open window per label — workers of different kinds interleave freely in
    // parallel mode, so the window has to be keyed, not assumed sequential.
    const open = new Map<string, WorkerRun>()
    const lastDone = new Map<string, WorkerRun>()
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = TS.exec(line)
        if (!m) continue
        const [, ts, label, rest] = m as unknown as [string, string, string, string]
        const at = Date.parse(ts)
        if (rest === 'start') {
            open.set(label, {
                task,
                label,
                startMs: at,
                doneMs: at,
                reportedMs: 0,
                exitCode: 0,
                attempts: 1,
                instrumented: false,
                reasons: [],
                residualMs: 0,
                projectLookups: 0,
                packageLookups: 0,
                retryGate: false,
                degraded: false
            })
            continue
        }
        // A `degraded` line can land on EITHER side of its own `done` line
        // (TASK_0024: apis logs done→degraded, context logs degraded→done), so it
        // is attached to the open window if there is one and to the label's last
        // finished run otherwise.
        const cur = open.get(label) ?? (rest.startsWith('degraded — ') ? lastDone.get(label) : undefined)
        if (!cur) continue
        if (rest.startsWith('pi-worker-docs: ')) {
            // `pi-worker-docs: . "query"` = project source; anything else is a package.
            if (rest.startsWith('pi-worker-docs: . ')) cur.projectLookups++
            else cur.packageLookups++
            continue
        }
        // Phase-level re-runs of the WHOLE worker (each is its own runWorker call).
        if (/retrying|retry answered|retry STILL|silent-retry/.test(rest)) {
            cur.retryGate = true
            continue
        }
        if (rest.startsWith('degraded — ')) {
            cur.degraded = true
            continue
        }
        if (rest.startsWith('RESTART ')) {
            // 5A instrumentation: authoritative, one line per discarded attempt.
            const reason = /reason=(\S+)/.exec(rest)?.[1] ?? 'unknown'
            cur.reasons.push(reason)
            cur.instrumented = true
            continue
        }
        if (!rest.startsWith('done ')) continue
        open.delete(label)
        cur.doneMs = at
        cur.exitCode = Number(/exit=(-?\d+)/.exec(rest)?.[1] ?? '0')
        const wait = Number(/wait=(\d+)ms/.exec(rest)?.[1] ?? '0')
        const work = Number(/work=(\d+)ms/.exec(rest)?.[1] ?? '0')
        cur.reportedMs = wait + work
        const attemptsField = /attempts=(\d+)/.exec(rest)?.[1]
        if (attemptsField) {
            cur.instrumented = true
            cur.attempts = Number(attemptsField)
            const listed = /restarts=\[([^\]]*)\]/.exec(rest)?.[1]
            if (listed) cur.reasons = listed.split(',').filter(Boolean)
        } else {
            // INFERRED: unreported wall, in units of the worker cap.
            const unreported = discardedMs(cur)
            const n = Math.round(unreported / WORKER_TIMEOUT_MS)
            cur.attempts = 1 + Math.max(0, n)
            cur.residualMs = unreported - n * WORKER_TIMEOUT_MS
            cur.reasons = Array.from({length: Math.max(0, n)}, () => 'worker-timeout(inferred)')
        }
        lastDone.set(label, cur)
        runs.push(cur)
    }
    return runs
}

const files = readdirSync(tasksDir)
    .filter(f => /^TASK_\d+-debug\.log$/.test(f))
    .sort()
if (files.length === 0) {
    console.error(`no TASK_*-debug.log under ${tasksDir}`)
    process.exit(2)
}

const runs = files.flatMap(f => parseLog(path.join(tasksDir, f), f.replace('-debug.log', '')))
// Run wall clock = first to last timestamp across the task logs, NOT the worker
// windows: research is one phase among several, and the critical-path share has
// to be a share of the whole run.
const allStamps = files.flatMap(f =>
    readFileSync(path.join(tasksDir, f), 'utf8')
        .split('\n')
        .map(l => /^(\d{4}-\d\d-\d\dT[\d:.]+Z) /.exec(l)?.[1])
        .filter((x): x is string => x !== undefined)
        .map(Date.parse)
)
const min = (xs: number[]): number => xs.reduce((a, b) => Math.min(a, b), Infinity)
const max = (xs: number[]): number => xs.reduce((a, b) => Math.max(a, b), -Infinity)
const mins = (ms: number): string => (ms / 60_000).toFixed(1)

// Per task, the worker that finished LAST is the one whose restarts extended the
// run (parallel research); its discarded time is critical-path time.
const byTask = new Map<string, WorkerRun[]>()
for (const r of runs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r])
const criticalOf = (rs: WorkerRun[]): WorkerRun =>
    rs.reduce((a, b) => (wallMs(b) > wallMs(a) ? b : a))

const restarted = runs.filter(r => r.attempts > 1)
const cleanExitRestarted = restarted.filter(r => r.exitCode === 0)
const totalRestarts = runs.reduce((n, r) => n + (r.attempts - 1), 0)
const confounded = restarted.filter(r => r.retryGate && !r.instrumented)
const critical = [...byTask.values()].map(criticalOf)
const criticalRestarts = critical.reduce((n, r) => n + (r.attempts - 1), 0)
const criticalDiscarded = critical.reduce((ms, r) => ms + discardedMs(r), 0)
const runWall = max(allStamps) - min(allStamps)
const instrumented = runs.filter(r => r.instrumented).length

console.log(`=== research-worker restart base rate — ${tasksDir}`)
console.log(`  logs: ${files.length} task files, ${runs.length} worker runs`)
console.log(
    `  mode: ${instrumented}/${runs.length} runs INSTRUMENTED (5A attempts=/RESTART lines)`
        + `, ${runs.length - instrumented} INFERRED from the ${WORKER_TIMEOUT_MS / 1000}s cap`
)
console.log('')
console.log(
    '  task         worker           attempts  wall(s)  reported(s)  discarded(s)  proj  pkg  exit'
)
for (const r of runs) {
    if (!verbose && r.attempts === 1) continue
    console.log(
        `  ${r.task.padEnd(12)} ${r.label.padEnd(16)} `
            + `${String(r.attempts).padStart(8)} `
            + `${(wallMs(r) / 1000).toFixed(0).padStart(8)} `
            + `${(r.reportedMs / 1000).toFixed(0).padStart(12)} `
            + `${(discardedMs(r) / 1000).toFixed(0).padStart(13)} `
            + `${String(r.projectLookups).padStart(5)} `
            + `${String(r.packageLookups).padStart(4)} `
            + `${String(r.exitCode).padStart(5)}`
            + (r.degraded ? '  DEGRADED' : '')
            + (r.retryGate ? '  [phase-retry in window]' : '')
            + (!r.instrumented && Math.abs(r.residualMs) > 15_000 ?
                `  [residual ${(r.residualMs / 1000).toFixed(0)}s — NOT a clean multiple]`
            :   '')
    )
}

const wallTotal = runs.reduce((ms, r) => ms + wallMs(r), 0)
const reportedTotal = runs.reduce((ms, r) => ms + r.reportedMs, 0)
console.log('\n=== BASE RATE ===')
console.log(`  worker runs                                   ${runs.length}`)
console.log(`  runs with >=1 discarded attempt               ${restarted.length}`)
console.log(`  ... of those, reporting exit=0 (look clean)   ${cleanExitRestarted.length}`)
console.log(`  ... of those, degraded after the full budget  ${restarted.filter(r => r.degraded).length}`)
console.log(`  TOTAL discarded attempts                      ${totalRestarts}`)
console.log(
    `  discarded wall clock                          ${mins(wallTotal - reportedTotal)} min`
        + ` of ${mins(wallTotal)} min worker wall`
        + ` (${(((wallTotal - reportedTotal) / Math.max(1, wallTotal)) * 100).toFixed(0)}%)`
)
console.log(
    `  ON THE CRITICAL PATH (slowest worker per task) ${criticalRestarts} discarded attempts,`
        + ` ${mins(criticalDiscarded)} min = ${((criticalDiscarded / Math.max(1, runWall)) * 100).toFixed(1)}%`
        + ` of the ${mins(runWall)} min run`
)
if (confounded.length > 0) {
    console.log(
        `  CONFOUND: ${confounded.length} inferred window(s) also contain a phase-level`
            + ' retry (empty / zero-retrieval / silent), whose extra runWorker call is'
            + ' unreported wall too — those inferences are not clean timeouts:'
    )
    for (const c of confounded) console.log(`    - ${c.task} ${c.label}`)
}

// Fan-out correlation (SEAM B): project-source lookups vs worker wall clock. The
// lever 5B exists for the high-fan-out tail, so the base rate has to show it.
const apis = runs.filter(r => r.label === 'worker:apis')
if (apis.length >= 3) {
    const xs = apis.map(r => r.projectLookups)
    const ys = apis.map(r => wallMs(r) / 1000)
    const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length
    const mx = mean(xs)
    const my = mean(ys)
    const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i]! - my), 0)
    const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0))
    const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0))
    console.log(
        `\n  worker:apis fan-out vs wall: r = ${(cov / (sx * sy || 1)).toFixed(3)} (n = ${apis.length});`
            + ` ${apis.reduce((n, r) => n + r.projectLookups, 0)} project-source lookups,`
            + ` ${apis.reduce((n, r) => n + r.packageLookups, 0)} package lookups`
    )
    const lo = apis.filter(r => r.projectLookups <= 4)
    const hi = apis.filter(r => r.projectLookups >= 46)
    console.log(
        `    <=4 lookups: ${lo.filter(r => r.attempts > 1).length}/${lo.length} restarted`
            + ` | >=46 lookups: ${hi.filter(r => r.attempts > 1).length}/${hi.length} restarted`
    )
}
