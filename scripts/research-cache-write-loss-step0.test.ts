import {test, expect} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {keyForLogLine, analyseProject} from './research-cache-write-loss-step0.js'

test('a project-source docs lookup is not cache-eligible', () => {
    expect(keyForLogLine('pi-worker-docs: . "toListingCard fetchPhotos - helper functions"')).toBeNull()
})

test('a non-worker log line is ignored', () => {
    expect(keyForLogLine('read: src/server/db.ts')).toBeNull()
})

test('docs and search keys normalise phrasing the way the cache key does', () => {
    const a = keyForLogLine('pi-worker-docs: Hono "HC   Client Usage"')
    const b = keyForLogLine('pi-worker-docs: hono "hc client usage"')
    expect(a?.key).toBe(b?.key)
    expect(a?.exact).toBe(true)
})

test('a truncated query is flagged inexact, so its duplicates are suspected not asserted', () => {
    const trunc = keyForLogLine('pi-worker-docs: hono "Hono class constructor, basic app setup, serve function for…"')
    expect(trunc?.exact).toBe(false)
    // The ellipsis is not part of the key: two calls sharing the prefix collapse.
    expect(trunc?.key.endsWith('…')).toBe(false)
})

test('a fetch line is ALWAYS inexact — the log carries the URL, the key carries the query too', () => {
    const f = keyForLogLine('pi-worker-fetch: https://tailwindcss.com/docs/theme')
    expect(f?.tool).toBe('fetch')
    expect(f?.exact).toBe(false)
})

test('analyseProject counts eligible calls, retained keys and the implied loss', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-step0-'))
    const tasks = path.join(cwd, '.pi-tasks')
    fs.mkdirSync(tasks, {recursive: true})
    fs.writeFileSync(
        path.join(tasks, 'TASK_0001-debug.log'),
        [
            // Three eligible calls in one parallel batch, plus one '.' lookup that is not.
            '2026-07-25T08:00:00.000Z worker:apis: pi-worker-docs: hono "app.get"',
            '2026-07-25T08:00:00.000Z worker:apis: pi-worker-docs: zod "z.infer"',
            '2026-07-25T08:00:00.000Z worker:apis: pi-worker-docs: . "local symbol"',
            '2026-07-25T08:00:12.000Z worker:apis: writing answer…',
            // A repeat of the first key, in its own batch.
            '2026-07-25T08:00:20.000Z worker:apis: pi-worker-docs: hono "app.get"',
            '2026-07-25T08:00:33.000Z worker:apis: done exit=0'
        ].join('\n'),
        'utf8'
    )
    fs.writeFileSync(
        path.join(tasks, 'research-cache.json'),
        JSON.stringify({runId: 'r', pkgv: 2, entries: {'pi-worker-docs\0hono::app.get': {}}}),
        'utf8'
    )

    const row = analyseProject(cwd)
    expect(row.eligibleCalls).toBe(3)
    expect(row.distinctLB).toBe(2)
    expect(row.stored).toBe(1)
    expect(row.storedByTool).toEqual({docs: 1})
    expect(row.writeLossUB).toBe(1)
    expect(row.repeats).toBe(1)
    expect(row.exactRepeats).toBe(1)
    // Only the second batch is all-repeat, and it lasted 13s.
    expect(row.recoverableSecondsUB).toBe(13)
    expect(row.evictionPossible).toBe(false)
})

test('a project with no run at all reports zeroes rather than throwing', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-step0-empty-'))
    const row = analyseProject(cwd)
    expect(row.eligibleCalls).toBe(0)
    expect(row.stored).toBe(0)
    expect(row.writeLossUB).toBe(0)
})
