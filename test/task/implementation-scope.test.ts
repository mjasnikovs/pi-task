import {afterEach, describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {enterImplementationTurn} from '../../src/task/implementation-scope.js'
import {disarmImplWidget, implWidgetArmed} from '../../src/task/impl-widget.js'
import {
    disarmImplementationGuard,
    implementationGuardArmed
} from '../../src/task/implementation-guards.js'
import {queueRecoveryTurn} from '../../src/task/recovery-turn.js'
import {releaseTaskDirCustody, taskDirCustodyHeld} from '../../src/task/task-dir-custody.js'
import {recoveryTurns} from '../test-utils/recovery-turns.js'
import {tmpDir} from '../test-utils/tmp-dir.js'

const meta = {taskId: 'TASK_0007', title: 'Add dark mode'}
const cwd = tmpDir('pi-task-scope-')

afterEach(async () => {
    disarmImplWidget()
    disarmImplementationGuard()
    await releaseTaskDirCustody()
    recoveryTurns().shutdown()
})

const scopeArmed = (): boolean[] => [
    implWidgetArmed(),
    implementationGuardArmed(),
    taskDirCustodyHeld()
]

describe('implementation-turn bracket', () => {
    test('enter arms the widget, the guard and the task-dir custody together', async () => {
        await enterImplementationTurn(meta, {oneShot: true, cwd})
        expect(implWidgetArmed()).toBe(true)
        expect(implementationGuardArmed()).toBe(true)
        expect(taskDirCustodyHeld()).toBe(true)
    })

    test('leave disarms all three', async () => {
        const leave = await enterImplementationTurn(meta, {oneShot: false, cwd})
        await leave()
        expect(implWidgetArmed()).toBe(false)
        expect(implementationGuardArmed()).toBe(false)
        expect(taskDirCustodyHeld()).toBe(false)
    })

    test('leave gives back the task dir and names what it restored', async () => {
        const repo = tmpDir('pi-task-scope-')
        const file = path.join(repo, '.pi-tasks', 'TASK_0007.md')
        fs.mkdirSync(path.dirname(file))
        fs.writeFileSync(file, 'host')
        const leave = await enterImplementationTurn(meta, {oneShot: false, cwd: repo})
        fs.writeFileSync(file, 'report')

        expect(await leave()).toEqual(['TASK_0007.md'])
        expect(fs.readFileSync(file, 'utf8')).toBe('host')
    })

    test('leave is idempotent and does not reach a bracket entered since', async () => {
        const stale = await enterImplementationTurn(meta, {oneShot: true, cwd})
        await stale()
        await stale()
        expect(implWidgetArmed()).toBe(false)
        expect(implementationGuardArmed()).toBe(false)
        expect(taskDirCustodyHeld()).toBe(false)

        await enterImplementationTurn(meta, {oneShot: true, cwd})
        await stale()
        expect(implWidgetArmed()).toBe(true)
        expect(implementationGuardArmed()).toBe(true)
        expect(taskDirCustodyHeld()).toBe(true)
    })

    test('a one-shot bracket ends once the turn is over, and names what it restored', async () => {
        const r = recoveryTurns()
        const repo = tmpDir('pi-task-scope-')
        const file = path.join(repo, '.pi-tasks', 'TASK_0007.md')
        fs.mkdirSync(path.dirname(file))
        fs.writeFileSync(file, 'host')
        await enterImplementationTurn(meta, {oneShot: true, cwd: repo})
        fs.writeFileSync(file, 'report')

        await r.settle()
        expect(scopeArmed()).toEqual([false, false, false])
        expect(fs.readFileSync(file, 'utf8')).toBe('host')
        expect(r.notices.join('\n')).toContain('TASK_0007.md')
    })

    test("a one-shot bracket holds through a watchdog's recovery turn", async () => {
        const r = recoveryTurns()
        await enterImplementationTurn(meta, {oneShot: true, cwd})
        queueRecoveryTurn('bash was cancelled')
        await r.settle()
        expect(scopeArmed()).toEqual([true, true, true])
        await r.input('bash was cancelled')
        r.start()
        await r.settle()
        expect(scopeArmed()).toEqual([false, false, false])
    })

    test('an awaited bracket outlives every turn until leave', async () => {
        const r = recoveryTurns()
        await enterImplementationTurn(meta, {oneShot: false, cwd})
        await r.settle()
        expect(scopeArmed()).toEqual([true, true, true])
    })

    test('an earlier one-shot bracket does not end an awaited one entered since', async () => {
        const r = recoveryTurns()
        await enterImplementationTurn(meta, {oneShot: true, cwd})
        await enterImplementationTurn(meta, {oneShot: false, cwd})
        await r.settle()
        expect(scopeArmed()).toEqual([true, true, true])
    })

    test('a recovery turn left over from an earlier turn does not end a new bracket', async () => {
        const r = recoveryTurns()
        queueRecoveryTurn('bash was cancelled')
        await r.settle() // posted, then never started
        await enterImplementationTurn(meta, {oneShot: true, cwd})
        await r.input('the spec')
        expect(scopeArmed()).toEqual([true, true, true])
    })
})
