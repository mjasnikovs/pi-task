/**
 * env-notes tests — the per-run environment-facts cache gate children share.
 * Extraction and the prompt block are pure; read/append run against a real
 * throwaway .pi-tasks dir (the artifact contract is the point).
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
    readEnvNotes
} from './env-notes.js'

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

describe('appendEnvNotes / readEnvNotes', () => {
    test('round-trips, deduplicates across appends, and lives under .pi-tasks', async () => {
        const cwd = makeCwd()
        expect(await readEnvNotes(cwd)).toBe('')
        await appendEnvNotes(cwd, ['fact one', 'fact two'])
        await appendEnvNotes(cwd, ['Fact One', 'fact three'])
        expect(await readEnvNotes(cwd)).toBe('fact one\nfact two\nfact three')
        expect(envNotesFile(cwd)).toContain('.pi-tasks')
    })

    test('keeps only the newest notes past the cap', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(
            cwd,
            Array.from({length: 45}, (_, i) => `fact ${i}`)
        )
        const lines = (await readEnvNotes(cwd)).split('\n')
        expect(lines).toHaveLength(40)
        expect(lines[0]).toBe('fact 5')
        expect(lines[39]).toBe('fact 44')
    })

    test('empty append is a no-op (no file created)', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(cwd, [])
        expect(fs.existsSync(envNotesFile(cwd))).toBe(false)
    })
})

describe('buildEnvNotesBlock', () => {
    test('lists the facts and carries the no-waiver caveat', () => {
        const block = buildEnvNotesBlock('postgres absent\nbun 1.3.14 installed')
        expect(block).toContain('- postgres absent')
        expect(block).toContain('- bun 1.3.14 installed')
        expect(block).toContain('NOT a license')
        expect(block).toContain('verify-as-shipped')
    })

    test('empty notes → empty block', () => {
        expect(buildEnvNotesBlock('')).toBe('')
        expect(buildEnvNotesBlock('  \n ')).toBe('')
    })
})

describe('ENV_NOTE_EMIT_INSTRUCTION', () => {
    test('teaches the marker and fences off verdicts/spec content', () => {
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('ENV-NOTE: <one-line fact>')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('never task')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('verdicts')
    })
})
