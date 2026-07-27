/**
 * STEP 0 rig for "research cache: fix the concurrent read-modify-write race"
 * (nexttask TASK 4).
 *
 * Quantifies the PRIZE before any lever is built, over already-completed
 * .pi-tasks runs, with no model time, re-runnably:
 *
 *   - cache-eligible worker calls (docs with module !== '.', search, fetch),
 *   - distinct attempted keys (a LOWER BOUND — see the truncation note below),
 *   - distinct keys actually retained in research-cache.json,
 *   - the implied write loss, and
 *   - the seconds a run would recover if that loss went to zero.
 *
 * METHOD CONSTRAINT, honoured here (the task states it explicitly): the true
 * duplicate rate CANNOT be read off the debug log for fetch. The log line prints
 * only the URL while the real cache key is `url::normalizeQuery(query)`, so two
 * calls to one URL asking different questions look like a duplicate and are not.
 * Retained keys are therefore always derived from research-cache.json itself,
 * never from the log.
 *
 * A SECOND truncation applies to docs and search: the log clamps the quoted
 * query to 60 characters (59 + ellipsis). Two distinct questions sharing a
 * 59-character prefix collapse into one attempted key here, so `distinctLB` is a
 * lower bound and the write loss derived from it is an UPPER bound. Calls whose
 * query was NOT truncated are counted separately as `exactRepeats` — those are
 * the only duplicates this rig can assert rather than suspect.
 *
 * WHY DUPLICATES ARE THE WHOLE STORY: a lost write costs nothing unless a LATER
 * call asks the same question. A key stored once and never asked again is worth
 * zero seconds whether it survived or not. So the recoverable time is bounded by
 * the repeat calls, not by the size of the loss.
 *
 * Usage:  bun run scripts/research-cache-write-loss-step0.ts <projectDir> [...]
 *         bun run scripts/research-cache-write-loss-step0.ts --json <projectDir>
 */

import {readFileSync, readdirSync, existsSync} from 'node:fs'
import path from 'node:path'

import {normalizeQuery} from '../src/workers/research-cache.js'

/** The log clamps a quoted query to this many characters, ellipsis included. */
export const LOG_QUERY_MAX = 60

/**
 * A batch shorter than this is treated as already-served (a cache hit returns
 * with no child spawn, so it lands in the same millisecond as the next line).
 * Only slower batches can have paid for a lookup.
 */
const SERVED_MS = 2

/**
 * Cap a single batch's contribution. The only clock available is the gap to the
 * worker's next log line, which includes the model's own turn time; capping
 * keeps one long think from dominating the estimate.
 */
const BATCH_CAP_S = 60

export interface Call {
    tool: 'docs' | 'search' | 'fetch'
    /** Reconstructed cache key, as close as the log allows. */
    key: string
    /** False when the log truncated the query, so `key` may merge distinct calls. */
    exact: boolean
    at: number
    /** Identifies the parallel tool-call batch this call belongs to. */
    batch: string
    repeat: boolean
}

export interface ProjectRow {
    project: string
    eligibleCalls: number
    /** Distinct attempted keys — a LOWER bound (see the truncation note). */
    distinctLB: number
    /** Distinct keys retained in research-cache.json. */
    stored: number
    storedByTool: Record<string, number>
    /** distinctLB - stored, floored at 0. An UPPER bound on lost writes. */
    writeLossUB: number
    /** Repeat calls at log granularity — an upper bound for fetch (URL only). */
    repeats: number
    /** Repeats whose query was not truncated: duplicates this rig can assert. */
    exactRepeats: number
    /** Seconds spent in batches where EVERY call was a repeat and none was served. */
    recoverableSecondsUB: number
    evictionPossible: boolean
}

/** MAX_ENTRIES in research-cache.ts; a run under it cannot have evicted. */
const MAX_ENTRIES = 250

interface RawLine {
    at: number
    worker: string
    rest: string
}

function parseLog(file: string): RawLine[] {
    const out: RawLine[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = /^(\S+Z) (worker:[a-z]+): (.*)$/.exec(line)
        if (m) out.push({at: Date.parse(m[1]), worker: m[2], rest: m[3]})
    }
    return out
}

/**
 * Reconstruct the cache key a logged call would have used. Returns null for a
 * line that is not a cache-eligible worker call — including `module === '.'`,
 * which pi-worker-docs deliberately declines to cache.
 */
export function keyForLogLine(rest: string): {tool: Call['tool']; key: string; exact: boolean} | null {
    const m = /^pi-worker-(docs|fetch|search): (.*)$/.exec(rest)
    if (!m) return null
    const tool = m[1] as Call['tool']
    const arg = m[2]
    if (tool === 'docs') {
        const d = /^(\S+) "(.*)"$/.exec(arg)
        if (!d || d[1] === '.') return null
        const exact = !d[2].endsWith('…')
        return {tool, key: `docs\0${normalizeQuery(d[1])}\0${normalizeQuery(d[2].replace(/…$/, ''))}`, exact}
    }
    if (tool === 'search') {
        const s = /^"(.*)"$/.exec(arg)
        if (!s) return null
        const exact = !s[1].endsWith('…')
        return {tool, key: `search\0${normalizeQuery(s[1].replace(/…$/, ''))}`, exact}
    }
    // fetch: the log carries the URL only, never the query half of the key, so a
    // URL match is a SUSPECTED duplicate and can never be an asserted one.
    return {tool, key: `fetch\0${arg.trim()}`, exact: false}
}

export function analyseProject(dir: string): ProjectRow {
    const tasks = path.join(dir, '.pi-tasks')
    const calls: Call[] = []
    const batchSeconds = new Map<string, number | null>()

    const logs = existsSync(tasks) ? readdirSync(tasks).filter(f => f.endsWith('-debug.log')) : []
    for (const f of logs) {
        const lines = parseLog(path.join(tasks, f))
        for (let i = 0; i < lines.length; i++) {
            const parsed = keyForLogLine(lines[i].rest)
            if (!parsed) continue
            // Parallel tool calls in one turn share a worker and a millisecond;
            // they run concurrently, so they cost one batch, not one each.
            const batch = `${f}|${lines[i].worker}|${lines[i].at}`
            if (!batchSeconds.has(batch)) {
                let secs: number | null = null
                for (let j = i + 1; j < lines.length; j++) {
                    if (lines[j].worker === lines[i].worker && lines[j].at > lines[i].at) {
                        secs = (lines[j].at - lines[i].at) / 1000
                        break
                    }
                }
                batchSeconds.set(batch, secs)
            }
            calls.push({...parsed, at: lines[i].at, batch, repeat: false})
        }
    }

    // The cache is shared across the whole run, so duplicates are global, not
    // per-task: order every call by wall clock before deciding what repeats.
    calls.sort((a, b) => a.at - b.at)
    const seen = new Set<string>()
    const byBatch = new Map<string, Call[]>()
    for (const c of calls) {
        c.repeat = seen.has(c.key)
        seen.add(c.key)
        const list = byBatch.get(c.batch)
        if (list) list.push(c)
        else byBatch.set(c.batch, [c])
    }

    let stored = 0
    const storedByTool: Record<string, number> = {}
    try {
        const raw = JSON.parse(readFileSync(path.join(tasks, 'research-cache.json'), 'utf8')) as {
            entries?: Record<string, unknown>
        }
        for (const k of Object.keys(raw.entries ?? {})) {
            stored++
            // Keys are `${toolName}\0${rawKey}` (shared.ts makeWorkerTool).
            const tool = k.split('\0')[0].replace('pi-worker-', '')
            storedByTool[tool] = (storedByTool[tool] ?? 0) + 1
        }
    } catch {
        // no cache file ⇒ nothing retained
    }

    let recoverable = 0
    for (const [batch, cs] of byBatch) {
        const secs = batchSeconds.get(batch)
        if (secs === null || secs === undefined) continue
        if (secs * 1000 < SERVED_MS) continue // already served from cache
        if (!cs.every(c => c.repeat)) continue // a genuine miss sets the batch's pace
        recoverable += Math.min(secs, BATCH_CAP_S)
    }

    return {
        project: path.basename(dir),
        eligibleCalls: calls.length,
        distinctLB: seen.size,
        stored,
        storedByTool,
        writeLossUB: Math.max(0, seen.size - stored),
        repeats: calls.filter(c => c.repeat).length,
        exactRepeats: calls.filter(c => c.repeat && c.exact).length,
        recoverableSecondsUB: Math.round(recoverable),
        evictionPossible: stored >= MAX_ENTRIES
    }
}

function main(): void {
    const args = process.argv.slice(2)
    const asJson = args.includes('--json')
    const dirs = args.filter(a => a !== '--json')
    if (dirs.length === 0) {
        console.error('usage: research-cache-write-loss-step0.ts [--json] <projectDir> [...]')
        process.exit(2)
    }
    const rows = dirs.map(analyseProject)
    if (asJson) {
        console.log(JSON.stringify(rows, null, 2))
        return
    }
    for (const r of rows) {
        console.log(`── ${r.project}`)
        console.log(`   eligible calls        ${r.eligibleCalls}`)
        console.log(`   distinct attempted    ${r.distinctLB}  (lower bound: log truncates at ${LOG_QUERY_MAX})`)
        console.log(`   retained in cache     ${r.stored}  ${JSON.stringify(r.storedByTool)}`)
        console.log(`   implied write loss    ${r.writeLossUB}  (upper bound; eviction possible: ${r.evictionPossible})`)
        console.log(`   repeat calls          ${r.repeats}  (asserted, untruncated: ${r.exactRepeats})`)
        console.log(`   recoverable seconds   ${r.recoverableSecondsUB}s  (upper bound)`)
    }
}

if (import.meta.main) main()
