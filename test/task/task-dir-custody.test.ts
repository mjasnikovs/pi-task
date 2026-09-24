import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {pathToFileURL} from 'node:url'
import {createWriteTool, type ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {
    registerTaskDirCustody,
    releaseTaskDirCustody,
    restoreTaskDir,
    snapshotTaskDir,
    taskDirCustodyHeld,
    takeTaskDirCustody
} from '../../src/task/task-dir-custody.js'
import {tmpDir} from '../test-utils/tmp-dir.js'

const AUTO = 'TASK_AUTO_0001.md'
const HOST = '---\nid: TASK_AUTO_0001\nstate: running\n---\n\n# Plan\n'
const REPORT = '# Implementation report\n\nAll done.\n'

function repo(): {cwd: string; dir: string; read: (name: string) => string} {
    const cwd = tmpDir('pi-task-custody-')
    const dir = path.join(cwd, '.pi-tasks')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, AUTO), HOST)
    fs.writeFileSync(path.join(dir, 'requirements.md'), '- R1\n')
    return {cwd, dir, read: name => fs.readFileSync(path.join(dir, name), 'utf8')}
}

function fakePi(): {
    pi: ExtensionAPI
    emit: (name: string) => Promise<unknown>
} {
    const handlers = new Map<string, (e: unknown) => unknown>()
    const pi = {
        on: (name: string, fn: (e: unknown) => unknown) => {
            handlers.set(name, fn)
        }
    } as unknown as ExtensionAPI
    return {
        pi,
        emit: async name => handlers.get(name)?.({type: name})
    }
}

afterEach(async () => {
    await releaseTaskDirCustody()
})

describe('restoreTaskDir', () => {
    test("puts back a task file pi's own write tool overwrote, however the path was spelled", async () => {
        const spellings = [
            `.pi-tasks/${AUTO}`,
            // pi strips a leading `@` before it resolves the path.
            `@.pi-tasks/${AUTO}`,
            // and decodes a file URL only after that.
            (cwd: string) =>
                pathToFileURL(path.join(cwd, '.pi-tasks', AUTO)).href.replace(
                    '/.pi-tasks/',
                    '/%2Epi-tasks/'
                )
        ]
        for (const spelling of spellings) {
            const r = repo()
            const before = await snapshotTaskDir(r.cwd)
            const target = typeof spelling === 'string' ? spelling : spelling(r.cwd)
            await createWriteTool(r.cwd).execute('call-1', {path: target, content: REPORT})
            expect(r.read(AUTO)).toBe(REPORT)

            expect(await restoreTaskDir(r.cwd, before)).toEqual([AUTO])
            expect(r.read(AUTO)).toBe(HOST)
        }
    })

    test('puts back files changed or deleted by any other writer, bash included', async () => {
        const r = repo()
        const before = await snapshotTaskDir(r.cwd)
        fs.writeFileSync(path.join(r.dir, AUTO), REPORT)
        fs.rmSync(path.join(r.dir, 'requirements.md'))

        expect(await restoreTaskDir(r.cwd, before)).toEqual([AUTO, 'requirements.md'])
        expect(r.read(AUTO)).toBe(HOST)
        expect(r.read('requirements.md')).toBe('- R1\n')
    })

    test('reports nothing when nothing changed', async () => {
        const r = repo()
        expect(await restoreTaskDir(r.cwd, await snapshotTaskDir(r.cwd))).toEqual([])
    })

    test('keeps a file created since the snapshot', async () => {
        // A run started in the window allocates its own task file.
        const r = repo()
        const before = await snapshotTaskDir(r.cwd)
        fs.writeFileSync(path.join(r.dir, 'TASK_0011.md'), HOST)

        expect(await restoreTaskDir(r.cwd, before)).toEqual([])
        expect(r.read('TASK_0011.md')).toBe(HOST)
    })

    test('leaves the research cache to the tools that write it mid-turn', async () => {
        const r = repo()
        fs.writeFileSync(path.join(r.dir, 'research-cache.json'), '{"entries":{}}')
        const before = await snapshotTaskDir(r.cwd)
        fs.writeFileSync(path.join(r.dir, 'research-cache.json'), '{"entries":{"q":1}}')

        expect(await restoreTaskDir(r.cwd, before)).toEqual([])
        expect(r.read('research-cache.json')).toBe('{"entries":{"q":1}}')
    })

    test('a repo with no task dir snapshots empty and restores nothing', async () => {
        const cwd = tmpDir('pi-task-custody-')
        const before = await snapshotTaskDir(cwd)
        expect(before.size).toBe(0)
        expect(await restoreTaskDir(cwd, before)).toEqual([])
    })
})

describe('implementation-turn custody', () => {
    test('a turn is restored on release, and only then', async () => {
        const r = repo()
        await takeTaskDirCustody(r.cwd)
        fs.writeFileSync(path.join(r.dir, AUTO), REPORT)
        expect(r.read(AUTO)).toBe(REPORT)
        expect(taskDirCustodyHeld()).toBe(true)

        expect(await releaseTaskDirCustody()).toEqual([AUTO])
        expect(r.read(AUTO)).toBe(HOST)
        expect(taskDirCustodyHeld()).toBe(false)
    })

    test('a shutdown drops custody and touches no file', async () => {
        // A custody that outlived its turn would revert the next run's writes.
        const r = repo()
        const f = fakePi()
        registerTaskDirCustody(f.pi)
        await takeTaskDirCustody(r.cwd)
        fs.writeFileSync(path.join(r.dir, AUTO), REPORT)

        await f.emit('session_shutdown')
        expect(taskDirCustodyHeld()).toBe(false)
        expect(await releaseTaskDirCustody()).toEqual([])
        expect(r.read(AUTO)).toBe(REPORT)
    })

    test('taking custody again replaces the earlier snapshot', async () => {
        const r = repo()
        await takeTaskDirCustody(r.cwd)
        fs.writeFileSync(path.join(r.dir, AUTO), REPORT)
        await takeTaskDirCustody(r.cwd)

        expect(await releaseTaskDirCustody()).toEqual([])
        expect(r.read(AUTO)).toBe(REPORT)
    })
})
