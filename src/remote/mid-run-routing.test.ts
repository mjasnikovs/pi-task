/**
 * Where a plain browser line goes, per session state — exercising the SHIPPED
 * routePlainLine, not a copy of it. The three-way decision is the whole of issue
 * #8: before it, an idle-mid-run line opened a second turn beside the run and
 * killed it live on pi 0.82.1 ("TASK_0001 failed: Agent is already processing").
 */
import {afterEach, expect, test} from 'bun:test'
import {routePlainLine} from './register.js'
import {getBridge} from './bridge.js'
import {broadcast as wsBroadcast} from './broadcast.js'
import {setAgentIdle} from './state.js'
import {_setSink, reset as resetSessionState} from './session-state.js'
import {beginRun, endRun, heldInput, resetMidRunInput} from '../task/mid-run-input.js'

afterEach(() => {
    const b = getBridge()
    b.sent.length = 0
    b.broadcast = msg => wsBroadcast(msg)
    resetMidRunInput()
    resetSessionState()
    _setSink(wsBroadcast)
    setAgentIdle(true)
})

function collect(): {sent: Array<{text: string; opts?: unknown}>; send: typeof noop} {
    const sent: Array<{text: string; opts?: unknown}> = []
    const send = (text: string, opts?: {deliverAs: 'steer' | 'followUp'}) => {
        sent.push({text, opts})
    }
    return {sent, send}
}
const noop = (_t: string, _o?: {deliverAs: 'steer' | 'followUp'}): void => {}

test('no run: a plain line is sent as an ordinary message', () => {
    _setSink(() => {})
    setAgentIdle(true)
    const {sent, send} = collect()
    routePlainLine('hello', send)
    expect(sent).toEqual([{text: 'hello', opts: undefined}])
    expect(heldInput()).toEqual([])
})

test('live turn: a plain line steers it', () => {
    _setSink(() => {})
    setAgentIdle(false)
    beginRun()
    const {sent, send} = collect()
    routePlainLine('use the other API', send)
    expect(sent).toEqual([{text: 'use the other API', opts: {deliverAs: 'steer'}}])
    expect(heldInput()).toEqual([])
    endRun()
})

// The regression. Idle + run active is MOST of a run: the spec phases and every
// gate are child processes, so the host session sits idle while the run works.
test('idle mid-run: a plain line is HELD, never sent', () => {
    _setSink(() => {})
    setAgentIdle(true)
    beginRun()
    const {sent, send} = collect()
    routePlainLine('also add retries', send)
    expect(sent).toEqual([])
    expect(heldInput()).toEqual(['also add retries'])
    endRun()
})

test('held lines still reach the transcript, so the user sees what they typed', () => {
    const frames: Array<{type: string}> = []
    _setSink(msg => frames.push(msg as {type: string}))
    setAgentIdle(true)
    beginRun()
    routePlainLine('also add retries', noop)
    expect(frames.some(f => f.type === 'user_message')).toBe(true)
    endRun()
})
