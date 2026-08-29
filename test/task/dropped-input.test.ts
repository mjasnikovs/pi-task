import {afterEach, expect, test} from 'bun:test'
import {formatDroppedInput, reportDroppedInput} from '../../src/task/dropped-input.js'
import {getBridge} from '../../src/remote/bridge.js'
import {broadcast as wsBroadcast} from '../../src/remote/broadcast.js'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'

afterEach(() => {
    const b = getBridge()
    b.sent.length = 0
    b.broadcast = msg => wsBroadcast(msg)
})

test('nothing held, nothing said', () => {
    expect(formatDroppedInput([])).toBeNull()
})

test('the dropped text is quoted back so it can be re-sent by hand', () => {
    expect(formatDroppedInput(['also add retries'])).toContain('"also add retries"')
})

test('extra lines are counted, and long ones truncated', () => {
    const msg = formatDroppedInput(['x'.repeat(200), 'second'])!
    expect(msg).toContain('…')
    expect(msg).toContain('(+1 more)')
    expect(msg.length).toBeLessThan(160)
})

test('both surfaces are told', () => {
    const b = getBridge()
    b.broadcast = m => b.sent.push(m)
    const notified: Array<{msg: string; level: string}> = []
    const ctx = {
        ui: {notify: (msg: string, level: string) => notified.push({msg, level})}
    } as unknown as ExtensionCommandContext
    reportDroppedInput(['also add retries'], ctx)
    expect(notified).toHaveLength(1)
    expect(notified[0]!.level).toBe('warning')
    expect(b.sent.some(m => (m as {type: string}).type === 'notify')).toBe(true)
})

// A ctx captured before a session replacement throws on use; the browser copy
// must still go out.
test('a stale ctx does not swallow the remote notice', () => {
    const b = getBridge()
    b.broadcast = m => b.sent.push(m)
    const ctx = {
        ui: {
            notify: () => {
                throw new Error('stale ctx')
            }
        }
    } as unknown as ExtensionCommandContext
    expect(() => reportDroppedInput(['held'], ctx)).not.toThrow()
    expect(b.sent.some(m => (m as {type: string}).type === 'notify')).toBe(true)
})
