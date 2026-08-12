import {test, expect, describe} from 'bun:test'
import {
    classifyWorkerFailure,
    type WorkerFailureInput,
    type WorkerFailureKind
} from './worker-failure.js'

const clean = (over: Partial<WorkerFailureInput> = {}): WorkerFailureInput => ({
    exitCode: 0,
    aborted: false,
    ...over
})

/** Every kill path also aborts and exits non-zero — killProc flips both. */
const killed = (over: Partial<WorkerFailureInput>): WorkerFailureInput =>
    clean({aborted: true, exitCode: 143, ...over})

const loopHit = {call: {name: 'read', args: {path: 'a'}}, count: 3, windowSize: 5}

test('a child that finished under its own power has no failure', () => {
    expect(classifyWorkerFailure(clean())).toBeUndefined()
})

test('an empty answer is NOT a failure — whether it counts is the caller policy', () => {
    // Research accepts a genuinely empty section; the gate does not. Folding
    // that decision in here would move it out of the module that owns it.
    expect(classifyWorkerFailure(clean())).toBeUndefined()
})

describe('each cause is named even though the kill also set aborted + non-zero exit', () => {
    const cases: ReadonlyArray<[WorkerFailureKind, WorkerFailureInput]> = [
        ['stalled', killed({stalled: true})],
        ['command-timeout', killed({commandTimedOut: {toolName: 'bash', timeoutMs: 900_000}})],
        ['stream-stall', killed({streamStalled: {idleMs: 120_000}})],
        ['worker-timeout', killed({timedOut: true})],
        ['loop', killed({loopHit})],
        ['leaked-tool-call', clean({leakedToolCall: '<read path="a">'})],
        ['aborted', killed({})],
        ['exit', clean({exitCode: 2})]
    ]
    for (const [kind, input] of cases) {
        test(`${kind} is not swallowed by the abort it caused`, () => {
            expect(classifyWorkerFailure(input)?.kind).toBe(kind)
        })
    }
})

test('the detail each cause carries survives classification', () => {
    const cmd = classifyWorkerFailure(
        killed({commandTimedOut: {toolName: 'bash', timeoutMs: 900_000}})
    )
    expect(cmd).toEqual({kind: 'command-timeout', toolName: 'bash', timeoutMs: 900_000})

    const stall = classifyWorkerFailure(killed({streamStalled: {idleMs: 120_000}}))
    expect(stall).toEqual({kind: 'stream-stall', idleMs: 120_000})

    const loop = classifyWorkerFailure(killed({loopHit}))
    expect(loop).toMatchObject({kind: 'loop', hit: loopHit})

    expect(classifyWorkerFailure(clean({exitCode: 7}))).toEqual({kind: 'exit', code: 7})
})

describe('precedence is row order, and specific always beats generic', () => {
    test('a stall outranks the abort and exit code it produced', () => {
        expect(classifyWorkerFailure(killed({stalled: true}))?.kind).toBe('stalled')
    })

    test('a watchdog kill outranks the wall-clock timeout flag', () => {
        const both = killed({commandTimedOut: {toolName: 'bash', timeoutMs: 1}, timedOut: true})
        expect(classifyWorkerFailure(both)?.kind).toBe('command-timeout')
    })

    test('a stream stall outranks the wall-clock timeout flag', () => {
        const both = killed({streamStalled: {idleMs: 5}, timedOut: true})
        expect(classifyWorkerFailure(both)?.kind).toBe('stream-stall')
    })

    test('a dead backend outranks every other cause it also tripped', () => {
        const everything = killed({
            stalled: true,
            timedOut: true,
            streamStalled: {idleMs: 5},
            commandTimedOut: {toolName: 'bash', timeoutMs: 1}
        })
        expect(classifyWorkerFailure(everything)?.kind).toBe('stalled')
    })

    test('a non-zero exit with a real cause behind it reports the cause, not the exit', () => {
        expect(classifyWorkerFailure(killed({loopHit}))?.kind).toBe('loop')
    })
})
