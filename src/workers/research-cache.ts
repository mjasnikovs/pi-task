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
 * RESUME REUSE (mx5 run 13, measured from the file's own git history — the cache is
 * committed with every task, so the whole run is recoverable): a 32-task run built the
 * cache to 201 entries over 20 tasks under one run id, then three /task-auto-resume
 * invocations each stamped a fresh id and the first store of each dropped everything —
 * 201 → 11 → 3 → 5 → 8. The audit read the 8-entry tail and concluded the cache was
 * near-useless; it was in fact working, and the resume threw the work away. The old
 * comment called a resume re-fetch "only slightly less reuse", which holds for a
 * 5-task run and fails badly for a 32-task one.
 *
 * So a resume now REUSES the interrupted run's id — but only on POSITIVE evidence that
 * the digests still describe the same dependency surface. The staleness that matters is
 * a package version moving under a cached answer (a docs digest summarises the
 * INSTALLED types of a pinned package), so the file records a fingerprint of the
 * manifest's dependency block and a resume reuses the id only when that fingerprint is
 * unchanged. Missing, unparseable, or fingerprint-less file ⇒ fresh id and a re-fetch:
 * every inconclusive path costs time, never correctness.
 *
 * Stored under `.pi-tasks/` (sibling of env-notes.md / contracts.md), which the
 * git-state guard and discardEdits both exclude. Best-effort throughout: any I/O or
 * parse failure falls back to a live fetch — the cache only ever saves time, it can
 * never change an answer or block a worker.
 */
import {createHash} from 'node:crypto'
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
    /**
     * Fingerprint of the dependency surface the entries were produced against (see
     * depsFingerprint). Absent on files written before resume-reuse shipped, which is
     * treated as "cannot prove freshness" ⇒ no reuse.
     */
    deps?: string
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

/**
 * A stable fingerprint of the project's declared dependency surface — the only input a
 * cached docs digest actually depends on (a digest summarises a package's INSTALLED
 * types/README at a pinned version). Built from package.json's dependency blocks with
 * keys sorted, so formatting churn or an unrelated field edit does not invalidate it,
 * while any add/remove/version-bump does.
 *
 * Returns undefined when the manifest is missing or unparseable — the caller then has
 * NO positive evidence of freshness and must not reuse. Deliberately NOT the lockfile's
 * hash or mtime: a lockfile is rewritten by installs that do not change any resolved
 * version, which would defeat reuse for no correctness gain.
 */
export async function depsFingerprint(cwd: string): Promise<string | undefined> {
    try {
        const raw = await fsp.readFile(path.join(cwd, 'package.json'), 'utf8')
        const pkg = JSON.parse(raw) as Record<string, unknown>
        const blocks = [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies'
        ]
        const parts: string[] = []
        for (const block of blocks) {
            const deps = pkg[block]
            if (!deps || typeof deps !== 'object') continue
            const entries = Object.entries(deps as Record<string, unknown>)
                .filter(([, v]) => typeof v === 'string')
                .sort(([a], [b]) =>
                    a < b ? -1
                    : a > b ? 1
                    : 0
                )
                .map(([k, v]) => `${k}@${String(v)}`)
            if (entries.length > 0) parts.push(`${block}:${entries.join(',')}`)
        }
        // No dependency block at all is a real, stable state (a dependency-free repo) —
        // fingerprint it as such rather than failing, so reuse still works there.
        return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32)
    } catch {
        return undefined
    }
}

/**
 * Resume hook: reuse the interrupted run's cache id when — and only when — the file
 * proves it describes the same dependency surface. Returns the id now stamped into the
 * environment (reused or fresh), or undefined when caching is off.
 *
 * Every uncertain path falls through to a fresh id, which merely re-fetches:
 * caching disabled, no/corrupt cache file, a file with no fingerprint (written before
 * this shipped), an unreadable manifest, or a fingerprint that no longer matches.
 */
export async function resumeResearchRun(
    cwd: string,
    enabled: boolean
): Promise<{runId: string | undefined; reused: boolean; entries: number}> {
    if (!enabled) {
        delete process.env[RESEARCH_RUN_ID_ENV]
        return {runId: undefined, reused: false, entries: 0}
    }
    const file = await readCacheFile(cwd)
    const current = await depsFingerprint(cwd)
    if (file && file.deps !== undefined && current !== undefined && file.deps === current) {
        process.env[RESEARCH_RUN_ID_ENV] = file.runId
        return {runId: file.runId, reused: true, entries: Object.keys(file.entries).length}
    }
    return {runId: configureResearchRun(true), reused: false, entries: 0}
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
        // Stamp the dependency surface these entries were produced against, so a later
        // resume can prove they are still fresh. Unreadable manifest ⇒ field omitted,
        // which reads as "cannot prove freshness" and simply denies reuse.
        //
        // FROZEN at the run's first write, deliberately: if a task installs a package
        // mid-run and we re-fingerprinted here, the new fingerprint would bless digests
        // taken BEFORE the install as current. Keeping the original means a mid-run
        // install makes a later resume mismatch and re-fetch — the safe direction.
        const deps =
            existing && existing.runId === runId ? existing.deps : await depsFingerprint(cwd)
        const out: CacheFile = deps === undefined ? {runId, entries} : {runId, entries, deps}
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        // Atomic-ish write so a concurrent reader never sees a half-written file.
        const tmp = `${researchCacheFile(cwd)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(out), 'utf8')
        await fsp.rename(tmp, researchCacheFile(cwd))
    } catch {
        // best-effort cache
    }
}
