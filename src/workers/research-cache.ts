/**
 * research-cache — a per-run cache of docs/search/fetch worker RESULTS, shared
 * across the sibling task pipelines of one /task-auto run.
 *
 * The failure this serves (mx5 run 8, F10): the research phase alone burned 75 of
 * 363 minutes because ~20 sibling task pipelines each re-fetched the SAME external
 * docs and re-ran the SAME searches (the tailwind CLI docs fetched anew for task
 * after task). Each of those worker results is a deterministic function of (tool,
 * package/url, query) that does not change within a run — so the first pipeline to
 * ask a question can answer every later one from a shared digest instead of a fresh
 * network round-trip plus child-summariser spawn.
 *
 * SCOPE — stable external lookups only: npm-package docs, web search, web fetch. A
 * PROJECT-SOURCE (`.`) docs lookup is deliberately NOT cached: the working tree
 * mutates as tasks implement, so a `.` answer from an early task can be stale by a
 * later one (the docs SQLite index already keys those on file mtime). Only a result
 * the tool marks successful is cached — an error, an empty result, or an abort is
 * never memoised, so a transient failure cannot poison the run.
 *
 * PER-RUN ISOLATION: the orchestrator stamps a FRESH run id into the environment
 * (PI_TASK_RUN_ID) at the start of every /task-auto invocation; the research-worker
 * children inherit it. The cache file records the run id it was written for, and any
 * read or write for a different id discards the stale contents. So a long-lived host
 * process running many /task-auto runs never serves one run's digest to another, and
 * a run started with the feature flag OFF (no id in the environment) does not cache
 * at all — the cache is inert unless the orchestrator turned it on for this run.
 *
 * Stored under `.pi-tasks/` (sibling of env-notes.md / contracts.md), which the
 * git-state guard and discardEdits both exclude. Best-effort throughout: any I/O or
 * parse failure falls back to a live fetch — the cache only ever saves time, it can
 * never change an answer or block a worker.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {tasksDir} from '../task/task-io.js'

const RESEARCH_CACHE_FILE = 'research-cache.json'
/** The env var the orchestrator stamps with the per-run id children inherit. */
export const RESEARCH_RUN_ID_ENV = 'PI_TASK_RUN_ID'
/**
 * Cap stored entries so a chatty run cannot grow the file unboundedly; the newest
 * (by write time) are kept. Sized well above a 20-task run's distinct external
 * lookups (dozens), so a real run never evicts a still-useful digest.
 */
const MAX_ENTRIES = 250

/** One cached worker result: the focused answer text plus its structured details. */
interface CacheEntry {
    text: string
    details: unknown
    at: number
}

interface CacheFile {
    runId: string
    entries: Record<string, CacheEntry>
}

export function researchCacheFile(cwd: string): string {
    return path.join(tasksDir(cwd), RESEARCH_CACHE_FILE)
}

/**
 * The current run's id, or undefined when caching is off (the orchestrator did not
 * stamp one for this run). A worker treats undefined as "do not cache".
 */
export function researchRunId(): string | undefined {
    const v = process.env[RESEARCH_RUN_ID_ENV]?.trim()
    return v && v.length > 0 ? v : undefined
}

/** A fresh, per-invocation run token — stable within one run, unique across runs. */
export function newRunToken(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Orchestrator hook: called once at the start of every /task-auto invocation. When
 * caching is enabled it stamps a FRESH token (so a long-lived host never reuses a
 * prior run's token, and planAuto + the task loop of THIS run share one id); when
 * disabled it clears any token a prior run left, so the workers cache nothing.
 */
export function configureResearchRun(enabled: boolean): string | undefined {
    if (!enabled) {
        delete process.env[RESEARCH_RUN_ID_ENV]
        return undefined
    }
    const token = newRunToken()
    process.env[RESEARCH_RUN_ID_ENV] = token
    return token
}

/**
 * Normalise a query/module string for the cache KEY: collapse whitespace and
 * lowercase, so trivially-varied phrasings of the same question share a digest. The
 * stored value is the real answer, so a case/spacing collision only means two ways
 * of asking the same thing resolve to the same (correct) result.
 */
export function normalizeQuery(s: string): string {
    return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

async function readCacheFile(cwd: string): Promise<CacheFile | null> {
    try {
        const raw = await fsp.readFile(researchCacheFile(cwd), 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (
            parsed
            && typeof parsed === 'object'
            && typeof (parsed as CacheFile).runId === 'string'
            && typeof (parsed as CacheFile).entries === 'object'
            && (parsed as CacheFile).entries !== null
        ) {
            return parsed as CacheFile
        }
    } catch {
        // missing or corrupt ⇒ treated as empty
    }
    return null
}

/**
 * Look up a cached result for `key` in the current run. Returns undefined on a miss,
 * a stale-run file (different id ⇒ another run's digest, ignored), or any failure.
 */
export async function lookupResearch(
    cwd: string,
    runId: string,
    key: string
): Promise<{text: string; details: unknown} | undefined> {
    const file = await readCacheFile(cwd)
    if (!file || file.runId !== runId) return undefined
    const entry = file.entries[key]
    return entry ? {text: entry.text, details: entry.details} : undefined
}

/**
 * Store a successful result under `key` for the current run. A file written for a
 * different run id is discarded and started fresh (first write of a new run drops the
 * prior run's contents — self-healing per-run isolation without an explicit clear).
 * Best-effort: any failure is swallowed, leaving the caller's live result untouched.
 */
export async function storeResearch(
    cwd: string,
    runId: string,
    key: string,
    text: string,
    details: unknown
): Promise<void> {
    try {
        const existing = await readCacheFile(cwd)
        const entries = existing && existing.runId === runId ? existing.entries : {}
        entries[key] = {text, details, at: Date.now()}
        // Evict oldest by write time if over the cap.
        const keys = Object.keys(entries)
        if (keys.length > MAX_ENTRIES) {
            const ordered = keys.sort((a, b) => entries[a].at - entries[b].at)
            for (const k of ordered.slice(0, keys.length - MAX_ENTRIES)) delete entries[k]
        }
        const out: CacheFile = {runId, entries}
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        // Atomic-ish write so a concurrent reader never sees a half-written file.
        const tmp = `${researchCacheFile(cwd)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(out), 'utf8')
        await fsp.rename(tmp, researchCacheFile(cwd))
    } catch {
        // best-effort cache
    }
}
