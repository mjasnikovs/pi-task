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
    storeResearch
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
