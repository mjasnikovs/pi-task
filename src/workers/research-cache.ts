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
 * the digests still describe the same dependency surface.
 *
 * PER-PACKAGE INVALIDATION (mx5 run 14). The first shape of that evidence was one md5
 * over the whole dependency block: any change anywhere ⇒ wipe. That gate can never hold
 * on the projects /task actually builds — a greenfield run ADDS dependencies every few
 * tasks (run 14: hono/zod at T10, shadcn at T25, playwright-ct at T28), so all five of
 * its resumes saw a moved fingerprint and the run ended with ONE cached entry. Adding a
 * package invalidates nothing that was already cached; only the package a digest is
 * ABOUT going stale does.
 *
 * So invalidation is now per entry. Every docs entry records the package it describes
 * and the version declared for it at store time (a structured field on the entry, not
 * something re-parsed out of the key — keys embed the tool name with a \0 separator and
 * are the wrong place to carry meaning). A resume keeps the run id and drops only the
 * entries whose package changed version or left the manifest.
 *
 * STALENESS TRADE, decided deliberately: search and fetch entries are kept
 * unconditionally, even across a dependency bump. A kept search result about package X
 * may describe an older X. That is accepted — docs is the version-sensitive channel (it
 * is version-pinned to the INSTALLED package since pi-worker fixes #1) and search is
 * discovery, where re-running every query on every resume costs far more than the rare
 * staleness costs. A run that must not tolerate it can disable the cache outright.
 *
 * A file written before per-entry provenance shipped (no `pkgv` marker) carries no way
 * to tell its docs entries apart, so it still falls back to a fresh id: every
 * inconclusive path costs time, never correctness.
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

/**
 * One cached worker result: the focused answer text plus its structured details, and —
 * for a package-scoped (docs) answer — the provenance a resume prunes on.
 */
interface CacheEntry {
    text: string
    details: unknown
    at: number
    /** The npm package this answer is ABOUT (docs entries only; absent ⇒ never pruned). */
    pkg?: string
    /**
     * The version range declared for `pkg` when the answer was produced. Absent when the
     * package was not in the manifest at all (a transitive or ambient lookup) — nothing
     * in package.json can then move under it, so such an entry is kept.
     */
    pkgVersion?: string
}

/**
 * Schema marker for per-entry package provenance. A file without it was written by a
 * version that stored no `pkg` on its entries, so its docs entries are indistinguishable
 * from its search entries and cannot be pruned selectively ⇒ no reuse.
 */
const PKG_PROVENANCE_VERSION = 2

interface CacheFile {
    runId: string
    entries: Record<string, CacheEntry>
    /** Present (=== PKG_PROVENANCE_VERSION) iff entries carry package provenance. */
    pkgv?: number
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
 * The project's declared dependency surface as a name→range map, flattened across every
 * dependency block (a package listed in two blocks resolves to the first range seen, in
 * block order — a real manifest does not disagree with itself, and a disagreement can
 * only make the comparison stricter, i.e. re-fetch).
 *
 * Returns undefined when the manifest is missing or unparseable: the caller then cannot
 * prove any package's version and must treat every package-scoped entry as unprovable.
 * Deliberately NOT the lockfile: it is rewritten by installs that change no resolved
 * version, which would drop digests for no correctness gain.
 */
export async function depsMap(cwd: string): Promise<Record<string, string> | undefined> {
    try {
        const raw = await fsp.readFile(path.join(cwd, 'package.json'), 'utf8')
        const pkg = JSON.parse(raw) as Record<string, unknown>
        const blocks = [
            'dependencies',
            'devDependencies',
            'peerDependencies',
            'optionalDependencies'
        ]
        const out: Record<string, string> = {}
        for (const block of blocks) {
            const deps = pkg[block]
            if (!deps || typeof deps !== 'object') continue
            for (const [name, range] of Object.entries(deps as Record<string, unknown>)) {
                if (typeof range === 'string' && !(name in out)) out[name] = range
            }
        }
        // No dependency block at all is a real, stable state (a dependency-free repo).
        return out
    } catch {
        return undefined
    }
}

/** The version declared for `pkg`, or undefined when it is not in the manifest. */
async function declaredVersion(cwd: string, pkg: string): Promise<string | undefined> {
    return (await depsMap(cwd))?.[pkg]
}

/**
 * Is this entry still current against the manifest as it stands now?
 *
 * - no `pkg` (search/fetch, and docs answers about nothing installable): KEPT — see the
 *   staleness trade in the file header.
 * - `pkg` with no recorded version (not in the manifest when stored): KEPT — nothing in
 *   package.json can have moved under it.
 * - `pkg` whose declared version is unchanged: KEPT.
 * - `pkg` whose version moved, which left the manifest, or an unreadable manifest
 *   (no evidence either way): DROPPED.
 */
function entryStillFresh(entry: CacheEntry, deps: Record<string, string> | undefined): boolean {
    if (entry.pkg === undefined || entry.pkgVersion === undefined) return true
    return deps?.[entry.pkg] === entry.pkgVersion
}

/**
 * Resume hook: keep the interrupted run's cache id and PRUNE the entries the manifest
 * has invalidated, rather than discarding the whole cache because anything moved. Returns
 * the id now stamped into the environment (reused or fresh), how many entries survived,
 * and how many were dropped; undefined id when caching is off.
 *
 * Falls through to a fresh id only where there is nothing to reuse or nothing to reason
 * with: caching disabled, no/corrupt cache file, or a file predating per-entry package
 * provenance (`pkgv`) whose docs entries cannot be told apart from its search entries.
 */
export async function resumeResearchRun(
    cwd: string,
    enabled: boolean
): Promise<{runId: string | undefined; reused: boolean; entries: number; dropped: number}> {
    if (!enabled) {
        delete process.env[RESEARCH_RUN_ID_ENV]
        return {runId: undefined, reused: false, entries: 0, dropped: 0}
    }
    const file = await readCacheFile(cwd)
    if (!file || file.pkgv !== PKG_PROVENANCE_VERSION) {
        return {runId: configureResearchRun(true), reused: false, entries: 0, dropped: 0}
    }
    const deps = await depsMap(cwd)
    const kept: Record<string, CacheEntry> = {}
    let dropped = 0
    for (const [key, entry] of Object.entries(file.entries)) {
        if (entryStillFresh(entry, deps)) kept[key] = entry
        else dropped++
    }
    // Persist the pruning now, so a crash between here and the first store cannot leave
    // stale digests behind under a reused id.
    if (dropped > 0) await writeCacheFile(cwd, {runId: file.runId, entries: kept, pkgv: file.pkgv})
    process.env[RESEARCH_RUN_ID_ENV] = file.runId
    return {runId: file.runId, reused: true, entries: Object.keys(kept).length, dropped}
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

/** Write the cache file atomic-ish, so a concurrent reader never sees it half-written. */
async function writeCacheFile(cwd: string, out: CacheFile): Promise<void> {
    try {
        await fsp.mkdir(tasksDir(cwd), {recursive: true})
        const tmp = `${researchCacheFile(cwd)}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
        await fsp.writeFile(tmp, JSON.stringify(out), 'utf8')
        await fsp.rename(tmp, researchCacheFile(cwd))
    } catch {
        // best-effort cache
    }
}

/**
 * Store a successful result under `key` for the current run. A file written for a
 * different run id is discarded and started fresh (first write of a new run drops the
 * prior run's contents — self-healing per-run isolation without an explicit clear).
 *
 * `pkg` is the npm package the answer is ABOUT, supplied by package-scoped tools (docs).
 * Its declared version is resolved HERE, at store time, so a package installed mid-run
 * is stamped with the version its own digest was taken against — not with whatever the
 * manifest happened to say at the run's first write. That is what makes a later resume
 * able to prune this one entry instead of the whole file.
 *
 * Best-effort: any failure is swallowed, leaving the caller's live result untouched.
 */
export async function storeResearch(
    cwd: string,
    runId: string,
    key: string,
    text: string,
    details: unknown,
    pkg?: string
): Promise<void> {
    try {
        const existing = await readCacheFile(cwd)
        const entries = existing && existing.runId === runId ? existing.entries : {}
        const pkgVersion = pkg === undefined ? undefined : await declaredVersion(cwd, pkg)
        entries[key] = {
            text,
            details,
            at: Date.now(),
            ...(pkg === undefined ? {} : {pkg}),
            ...(pkgVersion === undefined ? {} : {pkgVersion})
        }
        // Evict oldest by write time if over the cap.
        const keys = Object.keys(entries)
        if (keys.length > MAX_ENTRIES) {
            const ordered = keys.sort((a, b) => entries[a].at - entries[b].at)
            for (const k of ordered.slice(0, keys.length - MAX_ENTRIES)) delete entries[k]
        }
        await writeCacheFile(cwd, {runId, entries, pkgv: PKG_PROVENANCE_VERSION})
    } catch {
        // best-effort cache
    }
}
