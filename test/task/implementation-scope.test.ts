import {afterEach, describe, expect, test} from 'bun:test'
import {enterImplementationTurn} from '../../src/task/implementation-scope.js'
import {disarmImplWidget, implWidgetArmed} from '../../src/task/impl-widget.js'
import {
    disarmImplementationGuard,
    implementationGuardArmed
} from '../../src/task/implementation-guards.js'

const meta = {taskId: 'TASK_0007', title: 'Add dark mode'}

afterEach(() => {
    disarmImplWidget()
    disarmImplementationGuard()
})

describe('implementation-turn bracket', () => {
    test('enter arms the widget and the guard together', () => {
        enterImplementationTurn(meta, {oneShot: true})
        expect(implWidgetArmed()).toBe(true)
        expect(implementationGuardArmed()).toBe(true)
    })

    test('leave disarms both', () => {
        const leave = enterImplementationTurn(meta, {oneShot: false})
        leave()
        expect(implWidgetArmed()).toBe(false)
        expect(implementationGuardArmed()).toBe(false)
    })

    test('leave is idempotent and does not reach a bracket entered since', () => {
        const stale = enterImplementationTurn(meta, {oneShot: true})
        stale()
        stale()
        expect(implWidgetArmed()).toBe(false)
        expect(implementationGuardArmed()).toBe(false)

        enterImplementationTurn(meta, {oneShot: true})
        stale()
        expect(implWidgetArmed()).toBe(true)
        expect(implementationGuardArmed()).toBe(true)
    })
})
