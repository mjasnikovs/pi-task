import {afterEach, expect, test} from 'bun:test'
import {
    beginRun,
    endRun,
    isRunActive,
    holdInput,
    heldInput,
    takeHeldInput,
    clearHeldInput,
    setHeldInputListener,
    resetMidRunInput
} from './mid-run-input.js'

afterEach(resetMidRunInput)

test('run bracketing is refcounted, so an inner task end does not clear the loop', () => {
    expect(isRunActive()).toBe(false)
    beginRun() // /task-auto's loop
    beginRun() // one task inside it
    endRun()
    expect(isRunActive()).toBe(true)
    endRun()
    expect(isRunActive()).toBe(false)
})

test('held lines are delivered once, oldest first, then gone', () => {
    beginRun()
    holdInput('use the other API')
    holdInput('  ') // blank: ignored
    holdInput('and add a test')
    expect(heldInput()).toEqual(['use the other API', 'and add a test'])
    expect(takeHeldInput()).toBe('use the other API\n\nand add a test')
    expect(heldInput()).toEqual([])
    expect(takeHeldInput()).toBeNull()
})

test('taking clears BEFORE delivery, so a failed steer cannot redeliver', () => {
    beginRun()
    holdInput('once only')
    takeHeldInput() // caller's own delivery may now throw
    expect(takeHeldInput()).toBeNull()
})

// The whole point of holding is to never replay into a finished run — the exact
// surprise the terminal queue produced (issue #8).
test('the last endRun drops anything still held instead of replaying it later', () => {
    beginRun()
    holdInput('never delivered')
    endRun()
    expect(heldInput()).toEqual([])
    expect(takeHeldInput()).toBeNull()
})

test('listener fires on run bracket, hold, take and clear so surfaces re-render', () => {
    let changes = 0
    setHeldInputListener(() => changes++)
    beginRun() // composer must switch to "held" mode before anything is typed
    expect(changes).toBe(1)
    beginRun() // nested: already in held mode, nothing to re-render
    expect(changes).toBe(1)
    holdInput('a')
    expect(changes).toBe(2)
    holdInput('')
    expect(changes).toBe(2) // blank changed nothing
    clearHeldInput()
    expect(changes).toBe(3)
    clearHeldInput()
    expect(changes).toBe(3) // already empty
    holdInput('b')
    takeHeldInput()
    expect(changes).toBe(5)
    endRun()
    expect(changes).toBe(5) // inner end: still in a run
    endRun()
    expect(changes).toBe(6) // back to ordinary messaging
})
