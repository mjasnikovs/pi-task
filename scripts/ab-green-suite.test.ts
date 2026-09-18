import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {loadLedger, section} from './ab-green-suite.js'

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

describe('loadLedger', () => {
    const row = (arm: 'A' | 'B', promptHash: string) =>
        JSON.stringify({fingerprint: 'm', arm, reps: 8, index: 0, slot: 0, promptHash, output: ''})

    // A trial run against an edited prompt is a different experiment.
    test('keeps only the trials that measured the current prompt of their arm', () => {
        const file = path.join(dir, 'ledger.jsonl')
        fs.writeFileSync(file, [row('A', 'a1'), row('A', 'old'), row('B', 'b1')].join('\n') + '\n')
        const rows = loadLedger(file, 8, {A: 'a1', B: 'b1'})
        expect(rows.map(r => `${r.arm}:${r.promptHash}`)).toEqual(['A:a1', 'B:b1'])
    })
})
