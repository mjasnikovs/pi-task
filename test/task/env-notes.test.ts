/**
 * env-notes tests — the per-run environment-facts cache gate children share.
 *
 * Extraction, parsing, excuse-detection and the prompt block are pure, so they
 * are asserted directly. read/append run against a real throwaway .pi-tasks
 * dir, because the on-disk line shape IS the contract between runs.
 *
 * The hazard the provenance and re-validation guards exist for: a "fact" one
 * task recorded is read by later ones as settled, so a false one — or a real one
 * that has since been fixed — spreads. Hence every note names who recorded it,
 * and the block tells a reader to re-validate rather than take it.
 *
 * The SUBJECT is what stops the other half of that hazard: twenty children
 * re-measuring one database wrote twenty slots of one fact, oldest included. The
 * fixture here is the real 40-note cache a 21-task run left behind.
 */
import {describe, expect, test} from 'bun:test'
import {tmpDir} from '../test-utils/tmp-dir.js'
import * as fs from 'node:fs'
import * as nodePath from 'node:path'
import {
    appendEnvNotes,
    buildEnvNotesBlock,
    deriveSubject,
    ENV_NOTE_EMIT_INSTRUCTION,
    envNotesFile,
    extractEnvNotes,
    isExcuseNote,
    parseEnvNotes,
    readEnvNotes
} from '../../src/task/env-notes.js'

function makeCwd(): string {
    return tmpDir('pi-env-notes-')
}

const MX5_NOTES = nodePath.join(import.meta.dir, '__fixtures__', 'mx5-env-notes.md')

describe('extractEnvNotes', () => {
    test('pulls ENV-NOTE lines, trimmed and deduplicated', () => {
        const text = [
            'checking the database…',
            'ENV-NOTE: postgres at localhost:5432 is NOT reachable on this machine',
            '  ENV-NOTE: bun 1.3.14 installed',
            'ENV-NOTE: postgres at localhost:5432 is NOT reachable on this machine',
            'WORK-VERIFIED: FAIL suite needs the db'
        ].join('\n')
        expect(extractEnvNotes(text).map(n => n.fact)).toEqual([
            'postgres at localhost:5432 is NOT reachable on this machine',
            'bun 1.3.14 installed'
        ])
    })

    test('takes the subject the child named, and derives one when it did not', () => {
        const text = [
            'ENV-NOTE[postgres]: reachable at localhost:5432, database mx5 present',
            'ENV-NOTE: `bun run lint` exits 0 on the current tree'
        ].join('\n')
        expect(extractEnvNotes(text)).toEqual([
            {
                subject: 'postgres',
                fact: 'reachable at localhost:5432, database mx5 present'
            },
            {subject: 'bun', fact: '`bun run lint` exits 0 on the current tree'}
        ])
    })

    test('reads a retraction as one', () => {
        expect(extractEnvNotes('ENV-NOTE-RESOLVED[docker]: compose v2 is present now')).toEqual([
            {subject: 'docker', fact: 'compose v2 is present now', resolved: true}
        ])
    })

    test('ignores over-long lines (prose, not facts) and non-marker text', () => {
        expect(extractEnvNotes(`ENV-NOTE: ${'x'.repeat(300)}`)).toEqual([])
        expect(extractEnvNotes('no notes here')).toEqual([])
        expect(extractEnvNotes('the string ENV-NOTE: mid-line does not count')).toEqual([])
    })
})

describe('deriveSubject', () => {
    test('names the service, then the command, then the leading words', () => {
        expect(deriveSubject('dev Postgres at postgres://user:pw@localhost:5432 serves mx5')).toBe(
            'localhost:5432'
        )
        expect(deriveSubject('on this tree `AGENT=1 bun test` collects 30 files')).toBe('bun')
        expect(deriveSubject('bare `./node_modules/.bin/tsc` is what compiles here')).toBe('tsc')
        expect(deriveSubject('the shared zod schema enforces a password minimum')).toBe(
            'shared zod'
        )
    })
})

describe('parseEnvNotes', () => {
    test('reads the full record, and legacy one/two-field lines', () => {
        const raw = [
            'fact one\tTASK_0001\trun-9\tpostgres',
            'legacy fact',
            '  ',
            'fact three\tTASK_0009'
        ].join('\n')
        expect(parseEnvNotes(raw)).toEqual([
            {fact: 'fact one', origin: 'TASK_0001', runId: 'run-9', subject: 'postgres'},
            {fact: 'legacy fact', origin: '', runId: '', subject: 'legacy fact'},
            {fact: 'fact three', origin: 'TASK_0009', runId: '', subject: 'fact three'}
        ])
    })
})

describe('appendEnvNotes / readEnvNotes', () => {
    test('round-trips, and a later note about a SUBJECT replaces the earlier one', async () => {
        const cwd = makeCwd()
        expect(await readEnvNotes(cwd)).toBe('')
        await appendEnvNotes(
            cwd,
            [
                {subject: 'postgres', fact: 'postgres absent'},
                {subject: 'bun', fact: 'bun 1.3 installed'}
            ],
            'TASK_0001',
            'run-1'
        )
        await appendEnvNotes(
            cwd,
            [{subject: 'Postgres', fact: 'postgres reachable at 5432 after all'}],
            'TASK_0005',
            'run-1'
        )
        expect(parseEnvNotes(await readEnvNotes(cwd))).toEqual([
            {fact: 'bun 1.3 installed', origin: 'TASK_0001', runId: 'run-1', subject: 'bun'},
            {
                fact: 'postgres reachable at 5432 after all',
                origin: 'TASK_0005',
                runId: 'run-1',
                subject: 'Postgres'
            }
        ])
        expect(envNotesFile(cwd)).toContain('.pi-tasks')
    })

    test('a retraction marks the subject resolved and drops it from the block', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(
            cwd,
            [{subject: 'docker', fact: 'docker compose v2 absent'}],
            'TASK_0001',
            'run-1'
        )
        expect(buildEnvNotesBlock(await readEnvNotes(cwd), 'run-1')).toContain('compose v2 absent')
        await appendEnvNotes(
            cwd,
            [{subject: 'docker', fact: 'docker compose v2 present (ps exits 0)', resolved: true}],
            'TASK_0007',
            'run-1'
        )
        expect(parseEnvNotes(await readEnvNotes(cwd))[0].resolvedBy).toBe('TASK_0007')
        expect(buildEnvNotesBlock(await readEnvNotes(cwd), 'run-1')).toBe('')
    })

    test('normalises stray tabs in a fact so the separator round-trips', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(cwd, [{subject: 'tabs', fact: 'a\tb\tc fact'}], 'TASK_0002', 'run-1')
        expect(parseEnvNotes(await readEnvNotes(cwd))).toEqual([
            {fact: 'a b c fact', origin: 'TASK_0002', runId: 'run-1', subject: 'tabs'}
        ])
    })

    test('append with no origin stays origin-less (legacy behaviour)', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(cwd, [{subject: 'bare', fact: 'bare fact'}])
        expect(parseEnvNotes(await readEnvNotes(cwd))).toEqual([
            {fact: 'bare fact', origin: '', runId: '', subject: 'bare'}
        ])
    })

    test('keeps only the newest notes past the cap', async () => {
        const cwd = makeCwd()
        await appendEnvNotes(
            cwd,
            Array.from({length: 45}, (_, i) => ({subject: `subject ${i}`, fact: `fact ${i}`})),
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

    test('the real 40-note cache collapses to under ten subjects', async () => {
        const cwd = makeCwd()
        const facts = fs
            .readFileSync(MX5_NOTES, 'utf8')
            .split('\n')
            .filter(l => l.trim().length > 0)
            .map(l => l.split('\t')[0])
        expect(facts).toHaveLength(40)
        // Emitted the way the children that wrote them did: bare, one at a time.
        for (const fact of facts) {
            await appendEnvNotes(cwd, [{subject: deriveSubject(fact), fact}], 'TASK_0033', 'run-1')
        }
        const notes = parseEnvNotes(await readEnvNotes(cwd))
        expect(notes.length).toBeLessThan(10)
        // The database and the suite are ONE note each, and the surviving one is the
        // last measurement rather than the first.
        const db = notes.filter(n => n.subject === 'localhost:5432')
        expect(db).toHaveLength(1)
        expect(db[0].fact).toBe(facts[facts.length - 1])
    })
})

describe('isExcuseNote', () => {
    test('flags standing-excuse wording (the run-8 F7 propagation smell)', () => {
        // The excuse shape: a real-sounding diagnosis whose function is to explain
        // away a failure as pre-existing and out of scope.
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

    test("this run's notes lead; earlier runs' get their own list", () => {
        const raw = [
            'measured just now\tTASK_0009\trun-2\tnow',
            'measured last week\tTASK_0001\trun-1\tthen'
        ].join('\n')
        const block = buildEnvNotesBlock(raw, 'run-2')
        const lines = block.split('\n')
        const heading = lines.findIndex(l => l.includes('From EARLIER runs'))
        expect(heading).toBeGreaterThan(-1)
        expect(lines.findIndex(l => l.includes('measured just now'))).toBeLessThan(heading)
        expect(lines.findIndex(l => l.includes('measured last week'))).toBeGreaterThan(heading)
    })

    test('with nothing from this run, earlier notes are the list (no empty heading)', () => {
        const block = buildEnvNotesBlock('older fact\tTASK_0001\trun-1\tolder', 'run-2')
        expect(block).toContain('older fact')
        expect(block).not.toContain('From EARLIER runs')
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
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('ENV-NOTE[<subject>]: <one-line fact>')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('ENV-NOTE-RESOLVED[<subject>]')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toContain('never a task verdict')
        expect(ENV_NOTE_EMIT_INSTRUCTION).toMatch(/pre-existing/i)
        expect(ENV_NOTE_EMIT_INSTRUCTION).toMatch(/minified/i)
    })
})
