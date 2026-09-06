/**
 * HEARTBEAT — a periodic, monotonic reading of a measurement in flight.
 *
 * WHAT IT IS NOT. It never kills anything and it holds no threshold. Every
 * clock-driven kill this project has tried has been refuted: a fixed wall clock
 * on a read-only worker turned out to be a hardware test, and a planning guard's
 * own refusals made up 197 of the 200 calls it fired on. A heartbeat is an
 * OBSERVER, so the interval it runs on is a reporting cadence and not a bound on
 * anyone's work.
 *
 * WHY COUNTERS AND NOT LIVENESS. A live process proves nothing here. The recorded
 * ways these runs die are all quiet: a tmux server that dropped the environment so
 * the answer log stays empty, defunct `pi` processes that outlive a killed run, a
 * dropped provider whose children exit 0 with no text. All of those leave a
 * healthy-looking process and a counter that stops moving. So the reading is the
 * counter, and the verdict is whether it moved since last time.
 *
 * The state file is what makes a single reading mean anything: it carries the
 * previous snapshot, so `flatFor` counts CONSECUTIVE silent heartbeats. That
 * number is evidence. What to do about it stays with the person reading it.
 */
import fs from 'node:fs'
import path from 'node:path'

/** One watched path at one moment. */
export interface Reading {
    target: string
    exists: boolean
    /** JSONL rows for a log or ledger; `null` for a directory. */
    lines: number | null
    bytes: number
    /** `.pi-tasks/TASK_0*.md` present and completed; `null` for a file. */
    tasks: number | null
    tasksDone: number | null
    /** Seconds since the newest write under this target. `null` when absent. */
    ageSec: number | null
}

export interface Snapshot {
    at: string
    readings: Reading[]
    /** Consecutive heartbeats in which nothing under any target moved. */
    flatFor: number
}

const countLines = (p: string): number => {
    const t = fs.readFileSync(p, 'utf8')
    return t.trim().length === 0 ? 0 : t.trim().split('\n').length
}

const newestMtimeMs = (dir: string): number => {
    let newest = 0
    for (const e of fs.readdirSync(dir, {withFileTypes: true, recursive: true})) {
        const full = path.join(e.parentPath ?? dir, e.name)
        if (!e.isFile()) continue
        try {
            newest = Math.max(newest, fs.statSync(full).mtimeMs)
        } catch {
            // A file the run deleted between readdir and stat. Not a heartbeat's problem.
        }
    }
    return newest
}

export function read(target: string, now: number = Date.now()): Reading {
    const base: Reading = {
        target,
        exists: false,
        lines: null,
        bytes: 0,
        tasks: null,
        tasksDone: null,
        ageSec: null
    }
    if (!fs.existsSync(target)) return base

    const st = fs.statSync(target)
    if (st.isDirectory()) {
        const specs = fs.existsSync(path.join(target, '.pi-tasks')) ?
            fs
                .readdirSync(path.join(target, '.pi-tasks'))
                .filter(f => /^TASK_0\d+\.md$/.test(f))
                .map(f => path.join(target, '.pi-tasks', f))
        :   []
        const done = specs.filter(f => /^state: completed$/m.test(fs.readFileSync(f, 'utf8')))
        const newest = newestMtimeMs(target)
        return {
            ...base,
            exists: true,
            tasks: specs.length,
            tasksDone: done.length,
            ageSec: newest === 0 ? null : Math.round((now - newest) / 1000)
        }
    }
    return {
        ...base,
        exists: true,
        lines: countLines(target),
        bytes: st.size,
        ageSec: Math.round((now - st.mtimeMs) / 1000)
    }
}

/** Did any counter move? Age is excluded on purpose — it moves on its own. */
export function moved(prev: Snapshot | null, next: readonly Reading[]): boolean {
    if (!prev) return true
    const key = (r: Reading): string => `${r.target}:${r.lines}:${r.bytes}:${r.tasks}:${r.tasksDone}`
    const before = new Set(prev.readings.map(key))
    return next.some(r => !before.has(key(r)))
}

export function snapshot(
    targets: readonly string[],
    prev: Snapshot | null,
    now: number = Date.now()
): Snapshot {
    const readings = targets.map(t => read(t, now))
    return {
        at: new Date(now).toISOString(),
        readings,
        flatFor: moved(prev, readings) ? 0 : (prev?.flatFor ?? 0) + 1
    }
}

export function format(s: Snapshot): string {
    const rows = s.readings.map(r => {
        if (!r.exists) return `  ${r.target}  ABSENT`
        const age = r.ageSec === null ? 'age=?' : `age=${r.ageSec}s`
        if (r.tasks !== null) return `  ${r.target}  tasks=${r.tasksDone}/${r.tasks} ${age}`
        return `  ${r.target}  rows=${r.lines} bytes=${r.bytes} ${age}`
    })
    const verdict = s.flatFor === 0 ? 'PROGRESS' : `FLAT x${s.flatFor}`
    return [`${s.at.slice(11, 19)}  ${verdict}`, ...rows].join('\n')
}

export function loadState(p: string | null): Snapshot | null {
    if (!p || !fs.existsSync(p)) return null
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as Snapshot
    } catch {
        // A truncated state file loses one comparison, never the reading itself.
        return null
    }
}

function main(): void {
    const argv = process.argv.slice(2)
    const targets: string[] = []
    let state: string | null = null
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--state') state = argv[++i]
        else if (argv[i].startsWith('--')) throw new Error(`docs-heartbeat: unknown flag ${argv[i]}`)
        else targets.push(argv[i])
    }
    if (targets.length === 0) throw new Error('docs-heartbeat: give at least one file or run directory')

    const s = snapshot(targets, loadState(state))
    if (state) fs.writeFileSync(state, JSON.stringify(s), 'utf8')
    console.log(format(s))
}

if (import.meta.main) {
    try {
        main()
    } catch (e: unknown) {
        console.error(e instanceof Error ? e.message : String(e))
        process.exit(1)
    }
}
