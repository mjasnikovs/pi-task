import {test, expect, afterEach} from 'bun:test'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    RESEARCH_RUN_ID_ENV,
    researchRunId,
    newRunToken,
    configureResearchRun,
    normalizeQuery,
    researchCacheFile,
    lookupResearch,
    storeResearch,
    depsMap,
    resumeResearchRun
} from './research-cache.js'

function tmpCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'research-cache-'))
}

const saved = process.env[RESEARCH_RUN_ID_ENV]
afterEach(() => {
    if (saved === undefined) delete process.env[RESEARCH_RUN_ID_ENV]
    else process.env[RESEARCH_RUN_ID_ENV] = saved
})

// ─── run id / env plumbing ───────────────────────────────────────────────────

test('researchRunId returns undefined when the env var is absent or blank', () => {
    delete process.env[RESEARCH_RUN_ID_ENV]
    expect(researchRunId()).toBeUndefined()
    process.env[RESEARCH_RUN_ID_ENV] = '   '
    expect(researchRunId()).toBeUndefined()
})

test('newRunToken produces distinct tokens', () => {
    const a = newRunToken()
    const b = newRunToken()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(0)
})

test('configureResearchRun(true) stamps a fresh token; (false) clears it', () => {
    const t1 = configureResearchRun(true)
    expect(t1).toBeDefined()
    expect(process.env[RESEARCH_RUN_ID_ENV]).toBe(t1!)
    // A second enable overwrites with a different token (per-invocation freshness).
    const t2 = configureResearchRun(true)
    expect(t2).not.toBe(t1)
    expect(researchRunId()).toBe(t2!)
    // Disable clears it entirely so nothing caches.
    expect(configureResearchRun(false)).toBeUndefined()
    expect(researchRunId()).toBeUndefined()
})

// ─── normalizeQuery ──────────────────────────────────────────────────────────

test('normalizeQuery collapses whitespace and lowercases', () => {
    expect(normalizeQuery('  React   Hooks\n Guide ')).toBe('react hooks guide')
    expect(normalizeQuery('SAME')).toBe(normalizeQuery('same'))
})

// ─── store / lookup round-trip ───────────────────────────────────────────────

test('store then lookup returns the cached text and details for the same run', async () => {
    const cwd = tmpCwd()
    await storeResearch(cwd, 'run-1', 'demo k1', 'the answer', {n: 5})
    const hit = await lookupResearch(cwd, 'run-1', 'demo k1')
    expect(hit).toEqual({text: 'the answer', details: {n: 5}})
    // A different key in the same run is a miss.
    expect(await lookupResearch(cwd, 'run-1', 'demo k2')).toBeUndefined()
})

test('lookup for a DIFFERENT run id is a miss (per-run isolation, no cross-run leak)', async () => {
    const cwd = tmpCwd()
    await storeResearch(cwd, 'run-A', 'demo k', 'answer A', {})
    expect(await lookupResearch(cwd, 'run-B', 'demo k')).toBeUndefined()
    // The old run's entry is still on disk but never served to run-B.
    expect(await lookupResearch(cwd, 'run-A', 'demo k')).toEqual({text: 'answer A', details: {}})
})

test('a store under a new run id discards the prior run entries (self-heal on first write)', async () => {
    const cwd = tmpCwd()
    await storeResearch(cwd, 'run-A', 'demo old', 'stale', {})
    await storeResearch(cwd, 'run-B', 'demo new', 'fresh', {})
    const file = JSON.parse(await fsp.readFile(researchCacheFile(cwd), 'utf8')) as {
        runId: string
        entries: Record<string, unknown>
    }
    expect(file.runId).toBe('run-B')
    expect(Object.keys(file.entries)).toEqual(['demo new'])
    expect(await lookupResearch(cwd, 'run-B', 'demo old')).toBeUndefined()
})

test('lookup on a missing or corrupt file is a miss, not a throw', async () => {
    const cwd = tmpCwd()
    expect(await lookupResearch(cwd, 'run-1', 'k')).toBeUndefined()
    await fsp.mkdir(path.dirname(researchCacheFile(cwd)), {recursive: true})
    await fsp.writeFile(researchCacheFile(cwd), '{ not json', 'utf8')
    expect(await lookupResearch(cwd, 'run-1', 'k')).toBeUndefined()
})

test('entries accumulate across stores within one run', async () => {
    const cwd = tmpCwd()
    await storeResearch(cwd, 'r', 'a', '1', {})
    await storeResearch(cwd, 'r', 'b', '2', {})
    expect(await lookupResearch(cwd, 'r', 'a')).toEqual({text: '1', details: {}})
    expect(await lookupResearch(cwd, 'r', 'b')).toEqual({text: '2', details: {}})
})

test('the cache file lives under .pi-tasks/', () => {
    expect(researchCacheFile('/proj')).toBe(path.join('/proj', '.pi-tasks', 'research-cache.json'))
})

test('store is best-effort — an unwritable tasks dir does not throw', async () => {
    const cwd = tmpCwd()
    // Make .pi-tasks a FILE so mkdir/write fail; store must swallow and not throw.
    await fsp.writeFile(path.join(cwd, '.pi-tasks'), 'x', 'utf8')
    await storeResearch(cwd, 'r', 'k', 'v', {})
    expect(await lookupResearch(cwd, 'r', 'k')).toBeUndefined()
})

// ─── resume reuse (mx5 run 13: three resumes discarded a 201-entry cache) ─────
// ─── per-package invalidation (mx5 run 14: a greenfield run installs as it goes,
//     so a whole-file freshness gate wiped the cache on all five of its resumes) ──

const DOCS_HONO = 'pi-worker-docs hono::hc client'
const DOCS_ZOD = 'pi-worker-docs zod::parse'
const SEARCH_KEY = 'pi-worker-search exa::hono deploy guide'

async function writeManifest(cwd: string, deps: Record<string, string>): Promise<void> {
    await fsp.writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify({name: 'x', dependencies: deps}),
        'utf8'
    )
}

async function seed(cwd: string, deps: Record<string, string> | null): Promise<void> {
    if (deps !== null) await writeManifest(cwd, deps)
    process.env[RESEARCH_RUN_ID_ENV] = 'run-orig'
    await storeResearch(cwd, 'run-orig', DOCS_HONO, 'answer', {}, 'hono')
}

test('depsMap flattens every dependency block and is undefined without a manifest', async () => {
    const cwd = tmpCwd()
    await fsp.writeFile(
        path.join(cwd, 'package.json'),
        JSON.stringify({
            name: 'x',
            dependencies: {hono: '^4.6.0'},
            devDependencies: {'@playwright/test': '^1.48.0'}
        }),
        'utf8'
    )
    expect(await depsMap(cwd)).toEqual({hono: '^4.6.0', '@playwright/test': '^1.48.0'})
    // A dependency-free repo is a real, stable state — an empty map, not "unknown".
    const bare = tmpCwd()
    await fsp.writeFile(path.join(bare, 'package.json'), '{"name":"x"}', 'utf8')
    expect(await depsMap(bare)).toEqual({})
    // An absent manifest is unknown — nothing about any package can be proved.
    expect(await depsMap(tmpCwd())).toBeUndefined()
})

test('a resume REUSES the interrupted run id when the dependency surface is unchanged', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0'})
    const res = await resumeResearchRun(cwd, true)
    expect(res).toMatchObject({reused: true, runId: 'run-orig', entries: 1, dropped: 0})
    // The whole point: the digest survives the resume.
    expect(await lookupResearch(cwd, res.runId!, DOCS_HONO)).toEqual({text: 'answer', details: {}})
})

test('a resume drops ONLY the docs entries whose own package moved, keeping the rest', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0', zod: '^3.23.0'})
    await storeResearch(cwd, 'run-orig', DOCS_ZOD, 'zod answer', {}, 'zod')
    await storeResearch(cwd, 'run-orig', SEARCH_KEY, 'search answer', {})

    // zod bumps; hono untouched. Pre-fix (whole-file fingerprint) this wiped all three.
    await writeManifest(cwd, {hono: '^4.6.0', zod: '^3.24.0'})
    const res = await resumeResearchRun(cwd, true)
    expect(res).toMatchObject({reused: true, runId: 'run-orig', entries: 2, dropped: 1})

    expect(await lookupResearch(cwd, 'run-orig', DOCS_HONO)).toBeDefined()
    expect(await lookupResearch(cwd, 'run-orig', SEARCH_KEY)).toBeDefined()
    expect(await lookupResearch(cwd, 'run-orig', DOCS_ZOD)).toBeUndefined()
    // The pruning is persisted, not just filtered in memory.
    const file = JSON.parse(await fsp.readFile(researchCacheFile(cwd), 'utf8')) as {
        entries: Record<string, unknown>
    }
    expect(Object.keys(file.entries).sort()).toEqual([DOCS_HONO, SEARCH_KEY].sort())
})

test('ADDING a package invalidates nothing — the run-14 failure mode', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0'})
    await storeResearch(cwd, 'run-orig', SEARCH_KEY, 'search answer', {})
    // A later task installs shadcn/playwright, as every greenfield run does.
    await writeManifest(cwd, {hono: '^4.6.0', zod: '^3.23.0', '@playwright/test': '^1.48.0'})
    expect(await resumeResearchRun(cwd, true)).toMatchObject({
        reused: true,
        runId: 'run-orig',
        entries: 2,
        dropped: 0
    })
})

test('a docs entry whose package LEFT the manifest is dropped', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0'})
    await writeManifest(cwd, {zod: '^3.23.0'})
    expect(await resumeResearchRun(cwd, true)).toMatchObject({entries: 0, dropped: 1})
})

test('an entry stored while its package was NOT declared survives (nothing can move under it)', async () => {
    const cwd = tmpCwd()
    await writeManifest(cwd, {hono: '^4.6.0'})
    process.env[RESEARCH_RUN_ID_ENV] = 'run-orig'
    // A transitive/ambient package: pkg recorded, no declared version to compare.
    await storeResearch(cwd, 'run-orig', 'pi-worker-docs undici::fetch', 'a', {}, 'undici')
    await writeManifest(cwd, {hono: '^4.7.0'})
    expect(await resumeResearchRun(cwd, true)).toMatchObject({entries: 1, dropped: 0})
})

test('an unreadable manifest drops package-scoped entries but keeps search/fetch', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0'})
    await storeResearch(cwd, 'run-orig', SEARCH_KEY, 'search answer', {})
    await fsp.rm(path.join(cwd, 'package.json'))
    expect(await resumeResearchRun(cwd, true)).toMatchObject({
        reused: true,
        entries: 1,
        dropped: 1
    })
    expect(await lookupResearch(cwd, 'run-orig', SEARCH_KEY)).toBeDefined()
})

test('a mid-run install is stamped at STORE time, so its own digest survives the next resume', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0'})
    // A task installs sharp mid-run and a digest is taken against the installed version.
    await writeManifest(cwd, {hono: '^4.6.0', sharp: '^0.33.0'})
    await storeResearch(cwd, 'run-orig', 'pi-worker-docs sharp::resize', 'a2', {}, 'sharp')
    // Both entries describe the current manifest ⇒ both survive (the old frozen
    // whole-file fingerprint denied reuse outright here).
    expect(await resumeResearchRun(cwd, true)).toMatchObject({
        reused: true,
        entries: 2,
        dropped: 0
    })
})

test('a resume takes a FRESH id when the cache predates package provenance', async () => {
    // No `pkgv` marker (written by an older version) ⇒ docs entries are indistinguishable
    // from search entries, so nothing can be pruned selectively.
    const legacy = tmpCwd()
    await fsp.mkdir(path.dirname(researchCacheFile(legacy)), {recursive: true})
    await fsp.writeFile(
        researchCacheFile(legacy),
        JSON.stringify({runId: 'run-old', entries: {k: {text: 't', details: {}, at: 1}}}),
        'utf8'
    )
    expect((await resumeResearchRun(legacy, true)).reused).toBe(false)

    // No cache file at all.
    expect((await resumeResearchRun(tmpCwd(), true)).reused).toBe(false)
})

test('resume with caching disabled clears the token and reuses nothing', async () => {
    const cwd = tmpCwd()
    await seed(cwd, {hono: '^4.6.0'})
    const res = await resumeResearchRun(cwd, false)
    expect(res.runId).toBeUndefined()
    expect(res.reused).toBe(false)
    expect(process.env[RESEARCH_RUN_ID_ENV]).toBeUndefined()
})
