/**
 * When a kill and the command's own exit meet, which one decides the status. A fake
 * child sets the order of events, which real processes only hit by chance.
 */
import {describe, expect, test} from 'bun:test'
import type {ChildProcess} from 'node:child_process'
import {spawnCommand} from '../../src/task/command-run.js'
import {makeProc} from '../test-utils/fake-spawn.js'

function fakeRun(platform: NodeJS.Platform) {
    const child = makeProc()
    const controller = new AbortController()
    const run = spawnCommand(
        {cwd: '.', bin: 'check', args: [], timeoutMs: 60_000, signal: controller.signal},
        {spawn: () => child as unknown as ChildProcess, platform}
    )
    const endPipes = (): void => {
        child.stdout!.emit('end')
        child.stderr!.emit('end')
    }
    return {child, run, cancel: () => controller.abort(), endPipes}
}

describe('a kill and an exit that meet', () => {
    test('win32: the exit code 1 a kill leaves reads as killed, an exit 0 still passes', async () => {
        for (const [code, status] of [
            [1, null],
            [0, 0]
        ] as const) {
            const {child, run, cancel, endPipes} = fakeRun('win32')
            cancel()
            child.emit('exit', code, null)
            endPipes()
            expect((await run).status).toBe(status)
        }
    })

    test("posix: a code that arrives after the kill is the command's own", async () => {
        const {child, run, cancel, endPipes} = fakeRun('linux')
        cancel()
        child.emit('exit', 1, null)
        endPipes()
        expect((await run).status).toBe(1)
    })

    test('a cancel after the command exited keeps its status, though its pipes stay open', async () => {
        const {child, run, cancel} = fakeRun('win32')
        child.emit('exit', 1, null)
        cancel()
        expect((await run).status).toBe(1)
    })
})
