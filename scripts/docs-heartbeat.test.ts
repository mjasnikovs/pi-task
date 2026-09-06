import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {format, moved, read, snapshot, type Reading, type Snapshot} from './docs-heartbeat.js'

let dir = ''

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'))
})
afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
})

const ledger = (rows: number): string => {
    const p = path.join(dir, 'ledger.jsonl')
    fs.writeFileSync(p, Array.from({length: rows}, (_, i) => `{"i":${i}}`).join('\n') + '\n')
    return p
}

const runDir = (specs: readonly string[]): string => {
    const r = path.join(dir, 'run')
    fs.mkdirSync(path.join(r, '.pi-tasks'), {recursive: true})
    specs.forEach((state, i) =>
        fs.writeFileSync(path.join(r, '.pi-tasks', `TASK_000${i + 1}.md`), `state: ${state}\n`)
    )
    return r
}

describe('read', () => {
    test('counts ledger rows', () => {
        expect(read(ledger(3)).lines).toBe(3)
    })

    test('an empty ledger is zero rows, not one', () => {
        const p = path.join(dir, 'empty.jsonl')
        fs.writeFileSync(p, '')
        expect(read(p).lines).toBe(0)
    })

    test('reports an absent target rather than throwing', () => {
        const r = read(path.join(dir, 'nope.jsonl'))
        expect(r.exists).toBe(false)
        expect(r.ageSec).toBeNull()
    })

    test('counts tasks and completions in a run directory', () => {
        const r = read(runDir(['completed', 'in_progress', 'completed']))
        expect(r.tasks).toBe(3)
        expect(r.tasksDone).toBe(2)
    })

    test('a run directory with no .pi-tasks yet reads zero, not absent', () => {
        const r = path.join(dir, 'fresh')
        fs.mkdirSync(r)
        expect(read(r).tasks).toBe(0)
        expect(read(r).exists).toBe(true)
    })

    test('age is measured from the newest write anywhere under a run', () => {
        const r = runDir(['in_progress'])
        expect(read(r, Date.now() + 30_000).ageSec).toBeGreaterThanOrEqual(29)
    })
})

describe('moved', () => {
    const reading = (over: Partial<Reading> = {}): Reading => ({
        target: 'a.jsonl',
        exists: true,
        lines: 5,
        bytes: 50,
        tasks: null,
        tasksDone: null,
        ageSec: 1,
        ...over
    })
    const snap = (rs: Reading[]): Snapshot => ({at: '', readings: rs, flatFor: 0})

    test('the first heartbeat always counts as progress', () => {
        expect(moved(null, [reading()])).toBe(true)
    })

    test('identical counters are not progress', () => {
        expect(moved(snap([reading()]), [reading()])).toBe(false)
    })

    test('one more row is progress', () => {
        expect(moved(snap([reading()]), [reading({lines: 6})])).toBe(true)
    })

    test('age alone is never progress — it moves on its own', () => {
        expect(moved(snap([reading({ageSec: 1})]), [reading({ageSec: 600})])).toBe(false)
    })

    test('a completion with no new task is progress', () => {
        const before = reading({lines: null, tasks: 3, tasksDone: 1})
        expect(moved(snap([before]), [reading({lines: null, tasks: 3, tasksDone: 2})])).toBe(true)
    })
})

describe('snapshot', () => {
    test('flatFor accumulates across consecutive silent readings', () => {
        const p = ledger(2)
        const a = snapshot([p], null)
        const b = snapshot([p], a)
        const c = snapshot([p], b)
        expect([a.flatFor, b.flatFor, c.flatFor]).toEqual([0, 1, 2])
    })

    test('any movement resets the streak to zero', () => {
        const p = ledger(2)
        const flat = snapshot([p], snapshot([p], null))
        expect(flat.flatFor).toBe(1)
        ledger(3)
        expect(snapshot([p], flat).flatFor).toBe(0)
    })
})

describe('format', () => {
    test('names the streak so a reader sees silence, not just a number', () => {
        const p = ledger(1)
        expect(format(snapshot([p], snapshot([p], null)))).toContain('FLAT x1')
    })

    test('a moving run reads PROGRESS', () => {
        expect(format(snapshot([ledger(1)], null))).toContain('PROGRESS')
    })

    test('an absent target is called out, not omitted', () => {
        expect(format(snapshot([path.join(dir, 'gone.jsonl')], null))).toContain('ABSENT')
    })
})
