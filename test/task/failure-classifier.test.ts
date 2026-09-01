import {describe, expect, test} from 'bun:test'
import {classifyFailure} from '../../src/task/failure-classifier.js'
import {BackendDownError, CommandTimeoutError} from '../../src/task/child-runner.js'
import {
    LoopExhaustedError,
    LeakedToolCallError,
    ModelError,
    USER_CANCELLED
} from '../../src/task/child-runner.js'

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

    test('LeakedToolCallError → failed with leaked_tool_call flash', () => {
        const err = new LeakedToolCallError('refine', '<tool_call>')
        const c = classifyFailure(err, false)
        expect(c.state).toBe('failed')
        expect(c.flash).toBe('leaked_tool_call')
        expect(c.reason).toMatch(/refine/)
        expect(c.notify).toMatch(/tool call/i)
    })

    test('ModelError → failed with model_error flash and the real cause surfaced', () => {
        const c = classifyFailure(new ModelError('refine', 'connection lost'), false)
        expect(c.state).toBe('failed')
        expect(c.flash).toBe('model_error')
        expect(c.reason).toMatch(/model_error in refine: connection lost/)
        expect(c.notify).toMatch(/connection lost/)
        expect(c.notify).toMatch(/restart the model/i)
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

describe('the terminal guard kills', () => {
    /**
     * REGRESSION (review finding 2). A dead-backend kill is the ONE case where we
     * positively know the model server did not answer. It must reach the user as
     * "model unreachable", with a flash id — not as a generic failure whose flash
     * is the first 80 characters of an English sentence.
     */
    test('a dead-backend kill is reported as model_unreachable', () => {
        const c = classifyFailure(new BackendDownError('refine'), false)
        expect(c.flash).toBe('model_unreachable')
    })

    test('a command-ceiling kill carries a flash id, not a sentence fragment', () => {
        const c = classifyFailure(
            new CommandTimeoutError('verify-tooling', {toolName: 'bash', timeoutMs: 900_000}),
            false
        )
        expect(c.flash).not.toContain(' ')
    })
})
