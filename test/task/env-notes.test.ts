/**
 * env-notes tests — the per-run environment-facts cache gate children share.
 * Extraction, parsing, excuse-detection and the prompt block are pure;
 * read/append run against a real throwaway .pi-tasks dir (the artifact contract
 * is the point). Provenance + re-validation guards close a F7.
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    appendEnvNotes,
    buildEnvNotesBlock,
    ENV_NOTE_EMIT_INSTRUCTION,
    envNotesFile,
    extractEnvNotes,
    isExcuseNote,
    parseEnvNotes,
    readEnvNotes
} from '../../src/task/env-notes.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-env-notes-'))
}

describe('extractEnvNotes', () => {
    test('pulls ENV-NOTE lines, trimmed and deduplicated', () => {
        const text = [
            'checking the database…',
            'ENV-NOTE: postgres at localhost:5432 is NOT reachable on this machine',
            '  ENV-NOTE: bun 1.3.14 installed',
            'ENV-NOTE: postgres at localhost:5432 is NOT reachable on this machine',
            'WORK-VERIFIED: FAIL suite needs the db'
        ].join('\n')
        expect(extractEnvNotes(text)).toEqual([
            'postgres at localhost:5432 is NOT reachable on this machine',
            'bun 1.3.14 installed'
        ])
    })

    test('ignores over-long lines (prose, not facts) and non-marker text', () => {
        expect(extractEnvNotes(`ENV-NOTE: ${'x'.repeat(300)}`)).toEqual([])
        expect(extractEnvNotes('no notes here')).toEqual([])
        expect(extractEnvNotes('the string ENV-NOTE: mid-line does not count')).toEqual([])
    })
})

describe('parseEnvNotes', () => {
    test('splits fact from origin, tolerating legacy origin-less lines', () => {
        expect(
            parseEnvNotes('fact one\tTASK_0001\nlegacy fact\n  \nfact three\tTASK_0009')
        ).toEqual([
            {fact: 'fact one', origin: 'TASK_0001'},
            {fact: 'legacy fact', origin: ''},
            {fact: 'fact three', origin: 'TASK_0009'}
        ])
    })
})

describe('appendEnvNotes / readEnvNotes', () => {
    test('round-trips with origin, dedups on the fact, keeps the FIRST origin', async () => {
        const cwd = makeCwd()
        expect(await readEnvNotes(cwd)).toBe('')
        await appendEnvNotes(cwd, ['fact one', 'fact two'], 'TASK_0001')
        await appendEnvNotes(cwd, ['Fact One', 'fact three'], 'TASK_0005')
        // "Fact One" is a case-insensitive duplicate — dropped, one task origin kept.
        expect(parseEnvNotes(await readEnvNotes(cwd))).toEqual([
            {fact: 'fact one', origin: 'TASK_0001'},
            {fact: 'fact two', origin: 'TASK_0001'},
            {fact: 'fact three', origin: 'TASK_0005'}
        ])
        expect(envNotesFile(cwd)).toContain('.pi-tasks')
    })

    test('normalises stray tabs in a fact so the separator round-trips', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(cwd, ['a\tb\tc fact'], 'TASK_0002')
        expect(parseEnvNotes(await readEnvNotes(cwd))).toEqual([
            {fact: 'a b c fact', origin: 'TASK_0002'}
        ])
    })

    test('append with no origin stays origin-less (legacy behaviour)', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(cwd, ['bare fact'])
        expect(parseEnvNotes(await readEnvNotes(cwd))).toEqual([{fact: 'bare fact', origin: ''}])
    })

    test('keeps only the newest notes past the cap', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(
            cwd,
            Array.from({length: 45}, (_, i) => `fact ${i}`),
            'TASK_0001'
        )
        const notes = parseEnvNotes(await readEnvNotes(cwd))
        expect(notes).toHaveLength(40)
        expect(notes[0].fact).toBe('fact 5')
        expect(notes[39].fact).toBe('fact 44')
    })

    test('empty append is a no-op (no file created)', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(cwd, [])
        expect(fs.existsSync(envNotesFile(cwd))).toBe(false)
    })
})

describe('isExcuseNote', () => {
    test('flags standing-excuse wording (the run-8 F7 propagation smell)', () => {
        // Verbatim a F7 false facts and the excused-but-real schema mismatch.
        expect(
            isExcuseNote(
                'The project build tree-shakes all route components from the minified bundle — a pre-existing issue affecting ALL pages'
            )
        ).toBe(true)
        expect(
            isExcuseNote(
                'The single test failure is a pre-existing schema mismatch unrelated to the marketplace implementation'
            )
        ).toBe(true)
        expect(isExcuseNote("the spec's E2E test assuming port 5173 is not applicable")).toBe(true)
        expect(
            isExcuseNote('failures only in pre-existing test/config files outside the deliverable')
        ).toBe(true)
    })

    test('leaves benign environment facts alone (no false positive)', () => {
        // "5 pre-existing warnings" is a status count, not an excused failure.
        expect(
            isExcuseNote(
                'ESLint 10.x passes with 0 errors and 5 pre-existing warnings across the project'
            )
        ).toBe(false)
        expect(
            isExcuseNote('PostgreSQL 15 running on localhost:5432 with user mx5, database mx5_dev')
        ).toBe(false)
        expect(isExcuseNote('bun 1.3.14 installed')).toBe(false)
        expect(isExcuseNote('Server runs on port 3000 via bun run dev')).toBe(false)
    })
})

describe('buildEnvNotesBlock', () => {
    test('renders origin, marks excuse-class notes, carries every guard', () => {
        const raw = [
            'postgres absent\tTASK_0001',
            'build tree-shakes all route components — pre-existing issue affecting ALL pages\tTASK_0011'
        ].join('\n')
        const block = buildEnvNotesBlock(raw)
        // provenance
        expect(block).toContain('recorded by TASK_0001')
        expect(block).toContain('recorded by TASK_0011')
        // excuse-class only on the tree-shake note
        const treeLine = block.split('\n').find(l => l.includes('tree-shakes')) ?? ''
        const pgLine = block.split('\n').find(l => l.includes('postgres absent')) ?? ''
        expect(treeLine).toContain('EXCUSE-CLASS')
        expect(pgLine).not.toContain('EXCUSE-CLASS')
        // guards: no-waiver + re-validation + grep hygiene + escalation
        expect(block).toContain('NOT a license')
        expect(block).toContain('verify-as-shipped')
        expect(block).toContain('RE-VALIDATE')
        expect(block).toContain('EVIDENCE HYGIENE')
        expect(block).toMatch(/escalate/i)
    })

    test('origin-less (legacy) notes render as unrecorded', () => {
        expect(buildEnvNotesBlock('some legacy fact')).toContain('origin unrecorded')
    })

    test('empty notes → empty block', () => {
        expect(buildEnvNotesBlock('')).toBe('')
        expect(buildEnvNotesBlock('  \n ')).toBe('')
    })
})

describe('ENV_NOTE_EMIT_INSTRUCTION', () => {
    test('teaches the marker and fences off verdicts/excuses/grep-of-artifact', () => {
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('ENV-NOTE: <one-line fact>')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('never a task verdict')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toMatch(/pre-existing/i)
        expect(ENV_NOTE_EMIT_INSTRUCTION).toMatch(/minified/i)
    })
})
