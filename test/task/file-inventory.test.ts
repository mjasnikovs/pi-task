import {describe, expect, test} from 'bun:test'
import {capInventory, getFileInventory, stripTasksDir} from '../../src/task/file-inventory.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'
import {spawnSync} from 'node:child_process'
import {getEventListeners} from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'

describe('capInventory', () => {
    test('passes through unchanged when line count is at or under the limit', () => {
        const raw = 'a\nb\nc'
        expect(capInventory(raw, 10)).toBe('a\nb\nc')
    })

    test('truncates and adds a count note when over the limit', () => {
        const raw = 'a\nb\nc\nd\ne'
        const out = capInventory(raw, 3)
        expect(out).toContain('a\nb\nc')
        expect(out).toMatch(/\(truncated: 2 more files\)/)
    })

    test('handles empty input', () => {
        expect(capInventory('', 10)).toBe('')
    })

    test('drops blank lines so the limit is applied to real paths only', () => {
        const raw = 'a\n\nb\n\nc'
        expect(capInventory(raw, 10)).toBe('a\nb\nc')
    })
})

describe('stripTasksDir', () => {
    test('drops .pi-tasks/ paths but keeps everything else', () => {
        const raw = ['.pi-tasks/.ignore', '.pi-tasks/TASK_0001.md', 'src/app.ts', 'README.md'].join(
            '\n'
        )
        expect(stripTasksDir(raw)).toBe('src/app.ts\nREADME.md')
    })

    test('does not drop lookalike paths that merely contain the dir name', () => {
        const raw = ['src/.pi-tasks/x.ts', 'my.pi-tasks/y.ts'].join('\n')
        expect(stripTasksDir(raw)).toBe(raw)
    })
})

describe('getFileInventory', () => {
    test('returns empty string for a non-git directory', async () => {
        await withTmpTaskDir(async cwd => {
            const out = await getFileInventory(cwd)
            expect(out).toBe('')
        })
    })

    test('returns tracked files from a real git repo', async () => {
        // Skip if git isn't on PATH — the helper deliberately swallows errors
        // and returns '', so testing the success path requires git.
        if (spawnSync('which', ['git']).status !== 0) return
        await withTmpTaskDir(async cwd => {
            spawnSync('git', ['init', '-q'], {cwd})
            spawnSync('git', ['config', 'user.email', 't@t'], {cwd})
            spawnSync('git', ['config', 'user.name', 't'], {cwd})
            fs.writeFileSync(path.join(cwd, 'a.ts'), '')
            fs.writeFileSync(path.join(cwd, 'b.ts'), '')
            spawnSync('git', ['add', '.'], {cwd})
            spawnSync('git', ['commit', '-q', '-m', 'init'], {cwd})
            const out = await getFileInventory(cwd)
            const paths = out.split('\n').sort()
            expect(paths).toEqual(['a.ts', 'b.ts'])
        })
    })

    test('excludes committed .pi-tasks files from the inventory', async () => {
        if (spawnSync('which', ['git']).status !== 0) return
        await withTmpTaskDir(async cwd => {
            spawnSync('git', ['init', '-q'], {cwd})
            spawnSync('git', ['config', 'user.email', 't@t'], {cwd})
            spawnSync('git', ['config', 'user.name', 't'], {cwd})
            fs.mkdirSync(path.join(cwd, '.pi-tasks'))
            fs.writeFileSync(path.join(cwd, '.pi-tasks', 'TASK_0001.md'), 'task')
            fs.writeFileSync(path.join(cwd, '.pi-tasks', '.ignore'), '*\n')
            fs.writeFileSync(path.join(cwd, 'a.ts'), '')
            spawnSync('git', ['add', '-A'], {cwd})
            spawnSync('git', ['commit', '-q', '-m', 'init'], {cwd})
            // Sanity: the task files ARE committed (so they remain committable).
            const tracked = spawnSync('git', ['ls-files'], {cwd, encoding: 'utf8'}).stdout
            expect(tracked).toContain('.pi-tasks/TASK_0001.md')
            // But the inventory handed to workers must not mention them.
            const out = await getFileInventory(cwd)
            expect(out.split('\n').sort()).toEqual(['a.ts'])
        })
    })
})

/**
 * `getFileInventory` receives the run-long orchestrator signal, so — exactly as
 * in runChild (GitHub issue #9) — a listener left behind by a normally finished
 * `git ls-files` would retain that child for the rest of the run.
 */
describe('getFileInventory abort-listener lifecycle', () => {
    test('detaches its abort listener once git finishes', async () => {
        if (spawnSync('which', ['git']).status !== 0) return
        const controller = new AbortController()
        await withTmpTaskDir(async cwd => {
            spawnSync('git', ['init', '-q'], {cwd})
            for (let i = 0; i < 5; i++) {
                await getFileInventory(cwd, controller.signal)
            }
        })
        expect(controller.signal.aborted).toBe(false)
        expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
    })

    test('returns empty and adds no listener when the signal is already aborted', async () => {
        if (spawnSync('which', ['git']).status !== 0) return
        const controller = new AbortController()
        controller.abort()
        await withTmpTaskDir(async cwd => {
            spawnSync('git', ['init', '-q'], {cwd})
            await getFileInventory(cwd, controller.signal)
        })
        expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
    })
})
