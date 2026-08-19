import {describe, expect, test} from 'bun:test'
import {existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {makeLedger, type LedgerSpec} from './ledger.js'
import {tasksDir} from './task-io.js'

interface Rec {
    id: string
    note: string
}

/** Tab-separated `id\tnote`; a line without a tab is corrupt and skipped. */
function recSpec(over: Partial<LedgerSpec<Rec>> = {}): LedgerSpec<Rec> {
    return {
        file: 'ledger-test.md',
        max: 3,
        key: r => r.id.toLowerCase(),
        serialize: r => `${r.id}\t${r.note}`,
        parse: raw => {
            const out: Rec[] = []
            for (const line of raw.split('\n')) {
                const t = line.trim()
                if (t.length === 0) continue
                const i = t.indexOf('\t')
                if (i === -1) continue
                out.push({id: t.slice(0, i), note: t.slice(i + 1)})
            }
            return out
        },
        ...over
    }
}

function fresh(): string {
    return mkdtempSync(`${tmpdir()}/ledger-`)
}

describe('makeLedger', () => {
    test('path is the file under the tasks dir', () => {
        const cwd = fresh()
        expect(makeLedger(recSpec()).path(cwd)).toBe(path.join(tasksDir(cwd), 'ledger-test.md'))
    })

    test('reads empty (raw and parsed) when the file does not exist', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        expect(await l.readRaw(cwd)).toBe('')
        expect(await l.read(cwd)).toEqual([])
    })

    test('readRaw is the trimmed file text', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        mkdirSync(tasksDir(cwd), {recursive: true})
        writeFileSync(l.path(cwd), '\n a\tb \n\n')
        expect(await l.readRaw(cwd)).toBe('a\tb')
    })

    test('first append creates the tasks dir and writes lines + trailing newline', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        expect(existsSync(tasksDir(cwd))).toBe(false)
        await l.append(cwd, [{id: 'A', note: 'one'}])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('A\tone\n')
    })

    test('empty batch is a no-op — nothing is created', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        await l.append(cwd, [])
        expect(existsSync(l.path(cwd))).toBe(false)
    })

    test('dedupes by key: stored beats batch, first-in-batch beats later', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec({max: 10}))
        await l.append(cwd, [{id: 'A', note: 'stored'}])
        await l.append(cwd, [
            {id: 'a', note: 'batch-dup-of-stored'},
            {id: 'B', note: 'first'},
            {id: 'b', note: 'second'}
        ])
        expect(await l.read(cwd)).toEqual([
            {id: 'A', note: 'stored'},
            {id: 'B', note: 'first'}
        ])
    })

    test('cap keeps the newest max records and drops the oldest', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec({max: 3}))
        await l.append(cwd, [
            {id: '1', note: 'n'},
            {id: '2', note: 'n'}
        ])
        await l.append(cwd, [
            {id: '3', note: 'n'},
            {id: '4', note: 'n'}
        ])
        expect((await l.read(cwd)).map(r => r.id)).toEqual(['2', '3', '4'])
    })

    test('no max means uncapped', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec({max: undefined}))
        const many = Array.from({length: 50}, (_, i) => ({id: String(i), note: 'n'}))
        await l.append(cwd, many)
        expect(await l.read(cwd)).toHaveLength(50)
    })

    test('a corrupt line is skipped by the parser, and dropped on the next rewrite', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        mkdirSync(tasksDir(cwd), {recursive: true})
        writeFileSync(l.path(cwd), 'A\tone\nno-tab-here\nB\ttwo\n')
        expect((await l.read(cwd)).map(r => r.id)).toEqual(['A', 'B'])
        await l.append(cwd, [{id: 'C', note: 'three'}])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('A\tone\nB\ttwo\nC\tthree\n')
    })

    test("onNoop 'rewrite' (default) canonicalises the file when nothing new is added", async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec({max: 2}))
        mkdirSync(tasksDir(cwd), {recursive: true})
        writeFileSync(l.path(cwd), 'junk\nA\tone\nB\ttwo\nC\tthree\n')
        await l.append(cwd, [{id: 'a', note: 'dup'}])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('B\ttwo\nC\tthree\n')
    })

    test("onNoop 'skip' leaves the file untouched when nothing new is added", async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec({max: 2, onNoop: 'skip'}))
        mkdirSync(tasksDir(cwd), {recursive: true})
        const before = 'junk\nA\tone\nB\ttwo\nC\tthree\n'
        writeFileSync(l.path(cwd), before)
        await l.append(cwd, [{id: 'a', note: 'dup'}])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe(before)
        // …but a genuinely new record still merges, dedupes and caps.
        await l.append(cwd, [{id: 'D', note: 'four'}])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('C\tthree\nD\tfour\n')
    })

    test('write overwrites with exactly these records; empty list writes an empty file', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        await l.append(cwd, [{id: 'A', note: 'one'}])
        await l.write(cwd, [
            {id: 'X', note: 'x'},
            {id: 'Y', note: 'y'}
        ])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('X\tx\nY\ty\n')
        await l.write(cwd, [])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('')
        expect(await l.read(cwd)).toEqual([])
    })

    test('write creates the tasks dir on first use', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        await l.write(cwd, [{id: 'A', note: 'one'}])
        expect(readFileSync(l.path(cwd), 'utf8')).toBe('A\tone\n')
    })

    test('write and append errors are swallowed (tasks dir is a file)', async () => {
        const cwd = fresh()
        const l = makeLedger(recSpec())
        writeFileSync(tasksDir(cwd), 'not a directory')
        await expect(l.append(cwd, [{id: 'A', note: 'one'}])).resolves.toBeUndefined()
        await expect(l.write(cwd, [{id: 'A', note: 'one'}])).resolves.toBeUndefined()
        expect(await l.readRaw(cwd)).toBe('')
        expect(await l.read(cwd)).toEqual([])
    })
})
