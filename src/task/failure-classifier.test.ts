import {describe, expect, test} from 'bun:test'
import {classifyFailure} from './failure-classifier.js'
import {LoopExhaustedError, USER_CANCELLED} from './child-runner.js'

describe('classifyFailure', () => {
    test('USER_CANCELLED message → cancelled', () => {
        const c = classifyFailure(new Error(USER_CANCELLED), false)
        expect(c.state).toBe('cancelled')
        expect(c.level).toBe('warning')
    })

    test('aborted flag → cancelled even on a generic error', () => {
        const c = classifyFailure(new Error('whatever'), true)
        expect(c.state).toBe('cancelled')
    })

    test('LoopExhaustedError → failed with loop_detected flash', () => {
        const err = new LoopExhaustedError('refine', [
            {call: {name: 'Read', args: {}}, count: 5, windowSize: 5},
            {call: {name: 'Read', args: {}}, count: 5, windowSize: 5},
            {call: {name: 'Read', args: {}}, count: 5, windowSize: 5}
        ])
        const c = classifyFailure(err, false)
        expect(c.state).toBe('failed')
        expect(c.flash).toBe('loop_detected')
        expect(c.reason).toMatch(/loop detected 3× in refine/)
    })

    test('no_verify_block → failed with matching flash', () => {
        const c = classifyFailure(new Error('no_verify_block'), false)
        expect(c.state).toBe('failed')
        expect(c.flash).toBe('no_verify_block')
        expect(c.reason).toBe('no_verify_block')
    })

    test('compose_invalid: <…> prefix → failed with detail in notify', () => {
        const c = classifyFailure(new Error('compose_invalid: spec is empty'), false)
        expect(c.state).toBe('failed')
        expect(c.flash).toBe('compose_invalid')
        expect(c.notify).toContain('spec is empty')
    })

    test('ECONNREFUSED → failed with model_unreachable flash', () => {
        const c = classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:11434'), false)
        expect(c.state).toBe('failed')
        expect(c.flash).toBe('model_unreachable')
    })

    test('fetch failed → also model_unreachable', () => {
        const c = classifyFailure(new Error('fetch failed: timeout'), false)
        expect(c.flash).toBe('model_unreachable')
    })

    test('generic error → failed with truncated reason', () => {
        const c = classifyFailure(new Error('x'.repeat(500)), false)
        expect(c.state).toBe('failed')
        expect(c.reason!.length).toBeLessThanOrEqual(200)
    })

    test('non-Error thrown value → failed using String(err)', () => {
        const c = classifyFailure('plain string', false)
        expect(c.state).toBe('failed')
        expect(c.notify).toContain('plain string')
    })
})
