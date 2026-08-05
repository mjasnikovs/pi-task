/**
 * STEP 0 for nexttask 9 — how much research wall clock is DISCARDED, across every
 * recorded run in the corpus, not just the one run that motivated the lever.
 *
 * WHAT IT MEASURES. A research worker that hits the 240s cap is killed and its
 * attempt is thrown away whole; the re-spawn starts from nothing. Since 5A landed,
 * every such kill writes its own line and that line carries the discarded attempt's
 * own wall clock:
 *
 *     worker:apis: RESTART (attempt 1 discarded) reason=worker-timeout
 *                  wall=240017ms wait=807ms work=239210ms — cap 240000ms
 *
 * So the discarded time is READ, not inferred — this script is deliberately the
 * narrow, instrumented half of `scripts/research-restart-baserate.ts`, which also
 * carries the pre-5A arithmetic and the fan-out correlation. What it adds is the
 * denominator and the breadth: `phase:research: done ms=` per task gives the
 * research wall the discard is a fraction OF, and it runs over every checkout that
 * has task logs rather than one.
 *
 * WHY THE BREADTH IS THE POINT. The prize is the discarded fraction. If that
 * fraction is an mx5 phenomenon, the honest claim is "this fixes mx5-shaped
 * workloads", not "this fixes research" — and STEP 0 is where that gets settled,
 * before a model is booted.
 *
 * READ-ONLY: parses logs, touches nothing.
 *
 * Run:
 *   bun run scripts/research-discard-baserate.ts [corpusDir …] [--verbose]
 *
 * A corpusDir may be either a `.pi-tasks` directory or a checkout containing one.
 * With no dirs given, every `~/hub/&#42;/.pi-tasks` holding task logs is used.
 */
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const explicit = argv.filter(a => !a.startsWith('--'))

/** `<ts> worker:<label>: RESTART (attempt N discarded) reason=R wall=Wms …` */
const RESTART =
    /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (worker:[a-z]+): RESTART \(attempt (\d+) discarded\) reason=(\S+) wall=(\d+)ms/
/** `<ts> phase:research: done ms=N` */
const RESEARCH_DONE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) phase:research: done ms=(\d+)/
/** `<ts> worker:<label>: done exit=… total=Nms` — the surviving attempt plus its restarts. */
const WORKER_DONE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (worker:[a-z]+): done .*\btotal=(\d+)ms/

interface Restart {
    task: string
    label: string
    attempt: number
    reason: string
    wallMs: number
}

interface Corpus {
    name: string
    dir: string
    tasks: number
    /** `phase:research` windows that reported a duration. */
    researchPhases: number
    researchMs: number
    /** Worker windows that reported `total=` (5A instrumentation present). */
    workerRuns: number
    workerMs: number
    restarts: Restart[]
}

function scan(dir: string, name: string): Corpus | null {
    const files = readdirSync(dir)
        .filter(f => /^TASK_[\dA-Z_]+-debug\.log$/.test(f))
        .sort()
    if (files.length === 0) return null
    const c: Corpus = {
        name,
        dir,
        tasks: files.length,
        researchPhases: 0,
        researchMs: 0,
        workerRuns: 0,
        workerMs: 0,
        restarts: []
    }
    for (const f of files) {
        const task = f.replace('-debug.log', '')
        for (const line of readFileSync(path.join(dir, f), 'utf8').split('\n')) {
            // Anchored at the timestamp so a RESTART inside a quoted bash body or a
            // `verify` line cannot be counted as a worker kill.
            const r = RESTART.exec(line)
            if (r) {
                c.restarts.push({
                    task,
                    label: r[2]!,
                    attempt: Number(r[3]),
                    reason: r[4]!,
                    wallMs: Number(r[5])
                })
                continue
            }
            const p = RESEARCH_DONE.exec(line)
            if (p) {
                c.researchPhases++
                c.researchMs += Number(p[2])
                continue
            }
            const w = WORKER_DONE.exec(line)
            if (w) {
                c.workerRuns++
                c.workerMs += Number(w[3])
            }
        }
    }
    return c
}

function resolveCorpora(): Corpus[] {
    const dirs: Array<[string, string]> = []
    if (explicit.length > 0) {
        for (const a of explicit) {
            const abs = path.resolve(a)
            const d = path.basename(abs) === '.pi-tasks' ? abs : path.join(abs, '.pi-tasks')
            if (!existsSync(d)) {
                console.error(`no .pi-tasks under ${abs}`)
                continue
            }
            dirs.push([path.basename(path.dirname(d)), d])
        }
    } else {
        const hub = path.join(os.homedir(), 'hub')
        if (!existsSync(hub)) {
            console.error(`no corpus given and ${hub} does not exist`)
            process.exit(2)
        }
        for (const entry of readdirSync(hub).sort()) {
            const d = path.join(hub, entry, '.pi-tasks')
            if (existsSync(d) && statSync(d).isDirectory()) dirs.push([entry, d])
        }
    }
    return dirs.map(([n, d]) => scan(d, n)).filter((c): c is Corpus => c !== null)
}

const corpora = resolveCorpora()
if (corpora.length === 0) {
    console.error('no corpus directory contained TASK_*-debug.log files')
    process.exit(2)
}

const mins = (ms: number): string => (ms / 60_000).toFixed(1)
const pct = (num: number, den: number): string =>
    den > 0 ? `${((num / den) * 100).toFixed(0)}%` : '—'
const timeoutMs = (rs: Restart[]): number =>
    rs.filter(r => r.reason === 'worker-timeout').reduce((s, r) => s + r.wallMs, 0)

console.log('=== research discard base rate (5A RESTART instrumentation, read-only)\n')

for (const c of corpora) {
    const byReason = new Map<string, Restart[]>()
    for (const r of c.restarts) byReason.set(r.reason, [...(byReason.get(r.reason) ?? []), r])
    const discarded = c.restarts.reduce((s, r) => s + r.wallMs, 0)
    console.log(`--- ${c.name}  (${c.dir})`)
    console.log(
        `    ${c.tasks} task logs, ${c.researchPhases} research phases, `
            + `${c.workerRuns} instrumented worker runs`
    )
    if (c.restarts.length === 0) {
        // A corpus with no `total=`/`RESTART` lines predates 5A. Its zero is BLIND —
        // the discards there were never written down — and must not be read as
        // evidence that the fault is absent.
        console.log(
            c.workerRuns === 0 ?
                '    restarts: NOT MEASURABLE — pre-5A logs, no RESTART instrumentation.'
                    + ` The ${mins(c.researchMs)} min of research here is BLIND, not clean.`
            :   `    restarts: NONE — 0.0 min discarded of ${mins(c.researchMs)} min research (0%)`
        )
    } else {
        for (const [reason, rs] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
            const labels = new Map<string, number>()
            for (const r of rs) labels.set(r.label, (labels.get(r.label) ?? 0) + 1)
            const by = [...labels]
                .sort((a, b) => b[1] - a[1])
                .map(([l, n]) => `${n} ${l}`)
                .join(', ')
            console.log(
                `    ${reason.padEnd(16)} ${String(rs.length).padStart(3)} restarts  `
                    + `${mins(rs.reduce((s, r) => s + r.wallMs, 0)).padStart(6)} min  (${by})`
            )
        }
        console.log(
            `    DISCARDED ${mins(discarded)} min of ${mins(c.researchMs)} min research `
                + `= ${pct(discarded, c.researchMs)}`
                + `  |  worker-timeout alone: ${mins(timeoutMs(c.restarts))} min `
                + `= ${pct(timeoutMs(c.restarts), c.researchMs)}`
        )
    }
    if (verbose) {
        for (const r of c.restarts) {
            console.log(
                `      ${r.task.padEnd(12)} ${r.label.padEnd(15)} attempt ${r.attempt} `
                    + `${r.reason.padEnd(15)} ${(r.wallMs / 1000).toFixed(0).padStart(4)}s`
            )
        }
    }
    console.log('')
}

console.log('=== CORPUS TOTAL ===')
const allRestarts = corpora.flatMap(c => c.restarts)
const allDiscarded = allRestarts.reduce((s, r) => s + r.wallMs, 0)
const allResearch = corpora.reduce((s, c) => s + c.researchMs, 0)
console.log(`  corpora with logs                 ${corpora.length}`)
console.log(`  research phases                   ${corpora.reduce((s, c) => s + c.researchPhases, 0)}`)
console.log(`  research wall                     ${mins(allResearch)} min`)
console.log(`  discarded attempts                ${allRestarts.length}`)
console.log(
    `  ... worker-timeout                ${allRestarts.filter(r => r.reason === 'worker-timeout').length}`
)
console.log(`  discarded wall                    ${mins(allDiscarded)} min = ${pct(allDiscarded, allResearch)}`)
console.log(
    `  ... worker-timeout alone          ${mins(timeoutMs(allRestarts))} min `
        + `= ${pct(timeoutMs(allRestarts), allResearch)}`
)
console.log('')
console.log('  per-corpus discarded fraction (the size of the prize, per workload):')
for (const c of [...corpora].sort(
    (a, b) =>
        (b.restarts.reduce((s, r) => s + r.wallMs, 0) / Math.max(1, b.researchMs))
        - (a.restarts.reduce((s, r) => s + r.wallMs, 0) / Math.max(1, a.researchMs))
)) {
    const d = c.restarts.reduce((s, r) => s + r.wallMs, 0)
    console.log(
        `    ${c.name.padEnd(14)} ${pct(d, c.researchMs).padStart(4)}  `
            + `(${mins(d)} / ${mins(c.researchMs)} min, ${c.restarts.length} restarts, ${c.tasks} tasks)`
    )
}
