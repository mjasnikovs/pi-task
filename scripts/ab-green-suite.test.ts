import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {loadLedger, mixedPromptArms, resumableRows, section} from './ab-green-suite.js'

let dir = ''

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-green-'))
})
afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
})

describe('section', () => {
    // JavaScript has no `\Z`: the old terminator was a literal Z, and a section
    // ended at the first capital Z in its body.
    test('a body containing Z is read whole', () => {
        const md = '## research\nUse Zod for validation\nTIMESTAMPTZ columns\n## grill Q&A\nQ1: x\n'
        expect(section(md, 'research')).toBe('Use Zod for validation\nTIMESTAMPTZ columns')
    })

    test('the last section runs to the end of the file', () => {
        expect(section('## research\nZ at the end', 'research')).toBe('Z at the end')
    })
})

const row = (arm: 'A' | 'B', promptHash: string, reps = 8) => ({
    fingerprint: 'm',
    arm,
    reps,
    index: 0,
    slot: 0,
    promptHash,
    kind: '',
    decision: '',
    output: '',
    ms: 0
})

describe('loadLedger', () => {
    const write = (rows: object[]): string => {
        const file = path.join(dir, 'ledger.jsonl')
        fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
        return file
    }

    // A scorer change is a rescore, and it rescores whatever the ledger holds. The
    // prompt-hash guard belongs to resume, below; here it reported a complete
    // ledger as INCOMPLETE after a one-character prompt edit.
    test('every trial at the rep count, whatever prompt recorded it', () => {
        const file = write([row('A', 'a1'), row('A', 'old'), row('B', 'b1')])
        expect(loadLedger(file, 8)).toHaveLength(3)
    })

    test('a trial recorded at another rep count is another design', () => {
        const file = write([row('A', 'a1'), row('B', 'b1', 4)])
        expect(loadLedger(file, 8)).toHaveLength(1)
    })
})

describe('resumableRows', () => {
    // A trial run against an edited prompt, or another model, is a different
    // experiment: this run may not append to it.
    test('keeps only the current model and the current prompt of each arm', () => {
        const rows = [
            row('A', 'a1'),
            row('A', 'old'),
            row('B', 'b1'),
            {...row('B', 'b1'), fingerprint: 'other'}
        ]
        expect(resumableRows(rows, 'm', {A: 'a1', B: 'b1'}).map(r => `${r.arm}:${r.promptHash}`))
            .toEqual(['A:a1', 'B:b1'])
    })
})

describe('mixedPromptArms', () => {
    // Resume appends a whole fresh set after a prompt edit, so the ledger holds
    // both generations at the same reps. Rescore then reads 2*reps trials, never
    // trips the INCOMPLETE check, and computes one statistic over two experiments.
    test('an arm carrying two prompts is named', () => {
        expect(mixedPromptArms([row('A', 'a1'), row('A', 'old'), row('B', 'b1')])).toEqual(['A'])
    })

    test('the two arms differing from each other is the design, not a mix', () => {
        expect(mixedPromptArms([row('A', 'a1'), row('B', 'b1')])).toEqual([])
    })
})
