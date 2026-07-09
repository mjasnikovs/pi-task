/**
 * accept-debt tests — the durable ledger of tasks the user ACCEPTED despite a
 * verify-FAIL (mx5 run 4 B3 / run 8 TASK_0012). Parsing, the FP-safe re-check, and
 * the report block are pure; record/read/write/prune run against a real throwaway
 * .pi-tasks dir (the artifact contract is the point).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    acceptDebtFile,
    buildAcceptDebtNote,
    isStaticClassDebt,
    parseAcceptDebts,
    readAcceptDebts,
    recheckAcceptDebts,
    recordAcceptDebt,
    writeAcceptDebts,
    type AcceptDebt
} from './accept-debt.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-accept-debt-'))
}

describe('parseAcceptDebts', () => {
    test('splits task id from reason, tolerating id-less lines', () => {
        expect(
            parseAcceptDebts(
                'TASK_0012\tfrozen-path violation\n  \nreason-only\nTASK_0009\trepo health: lint'
            )
        ).toEqual([
            {taskId: 'TASK_0012', reason: 'frozen-path violation'},
            {taskId: '', reason: 'reason-only'},
            {taskId: 'TASK_0009', reason: 'repo health: lint'}
        ])
    })

    test('empty raw → no records', () => {
        expect(parseAcceptDebts('')).toEqual([])
    })
})

describe('recordAcceptDebt / readAcceptDebts', () => {
    test('appends a durable record under .pi-tasks/', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'TASK_0012', 'modified src/main.tsx which the spec froze')
        expect(fs.existsSync(acceptDebtFile(cwd))).toBe(true)
        expect(await readAcceptDebts(cwd)).toEqual([
            {taskId: 'TASK_0012', reason: 'modified src/main.tsx which the spec froze'}
        ])
    })

    test('flattens newlines/tabs and caps the reason length', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'T1', `line one\n\tline two   with    spaces`)
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.reason).toBe('line one line two with spaces')
        // A tab in the stored reason would corrupt the id/reason split — none survives.
        expect(fs.readFileSync(acceptDebtFile(cwd), 'utf8').split('\n')[0]).toBe(
            'T1\tline one line two with spaces'
        )
    })

    test('caps very long reasons to 300 chars', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'T1', 'x'.repeat(500))
        expect((await readAcceptDebts(cwd))[0].reason.length).toBe(300)
    })

    test('dedups the same task+reason but keeps distinct ones', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'T1', 'same reason')
        await recordAcceptDebt(cwd, 'T1', 'same reason')
        await recordAcceptDebt(cwd, 'T1', 'other reason')
        await recordAcceptDebt(cwd, 'T2', 'same reason')
        expect(await readAcceptDebts(cwd)).toEqual([
            {taskId: 'T1', reason: 'same reason'},
            {taskId: 'T1', reason: 'other reason'},
            {taskId: 'T2', reason: 'same reason'}
        ])
    })

    test('an empty reason records nothing', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'T1', '   \n  ')
        expect(await readAcceptDebts(cwd)).toEqual([])
    })

    test('reading a cwd with no ledger yet → empty list', async () => {
        expect(await readAcceptDebts(makeCwd())).toEqual([])
    })
})

describe('writeAcceptDebts (prune)', () => {
    test('overwrites with exactly the given records', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'T1', 'a')
        await recordAcceptDebt(cwd, 'T2', 'b')
        await writeAcceptDebts(cwd, [{taskId: 'T2', reason: 'b'}])
        expect(await readAcceptDebts(cwd)).toEqual([{taskId: 'T2', reason: 'b'}])
    })

    test('empty list clears the ledger', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'T1', 'a')
        await writeAcceptDebts(cwd, [])
        expect(await readAcceptDebts(cwd)).toEqual([])
    })
})

describe('isStaticClassDebt', () => {
    test('matches the repo-health FAIL prefix only', () => {
        expect(isStaticClassDebt('repo health: bun run lint exited 1 — foo')).toBe(true)
        expect(isStaticClassDebt('  repo health: tsc failed')).toBe(true)
        // The frozen-path / behavioral / model-judged classes are NOT static-class.
        expect(isStaticClassDebt('modified a frozen path src/main.tsx')).toBe(false)
        expect(isStaticClassDebt('upload endpoint returned HTML not JSON')).toBe(false)
        expect(isStaticClassDebt('note: repo health mentioned mid-sentence')).toBe(false)
    })
})

describe('recheckAcceptDebts (FP-safe re-check)', () => {
    const staticDebt: AcceptDebt = {taskId: 'T9', reason: 'repo health: lint exited 1'}
    const frozenDebt: AcceptDebt = {taskId: 'T12', reason: 'modified frozen path src/main.tsx'}

    test('static-class debt is RESOLVED when statics now pass', () => {
        const {open, resolved} = recheckAcceptDebts([staticDebt, frozenDebt], {staticOk: true})
        expect(resolved).toEqual([staticDebt])
        // The frozen-path (behavioral) debt can never be auto-closed — always surfaced.
        expect(open).toEqual([frozenDebt])
    })

    test('static-class debt stays OPEN when statics still fail', () => {
        const {open, resolved} = recheckAcceptDebts([staticDebt, frozenDebt], {staticOk: false})
        expect(resolved).toEqual([])
        expect(open).toEqual([staticDebt, frozenDebt])
    })

    test('nothing recorded → nothing open (clean)', () => {
        expect(recheckAcceptDebts([], {staticOk: true})).toEqual({open: [], resolved: []})
    })
})

describe('buildAcceptDebtNote', () => {
    test('empty when nothing is open', () => {
        expect(buildAcceptDebtNote([])).toBe('')
    })

    test('lists each open debt with its task id and reason', () => {
        const note = buildAcceptDebtNote([
            {taskId: 'TASK_0012', reason: 'frozen-path violation'},
            {taskId: '', reason: 'behavioral fail'}
        ])
        expect(note).toContain('ACCEPTED VERIFY-FAIL DEBT still open (2)')
        expect(note).toContain('TASK_0012 — accepted despite verify-FAIL: frozen-path violation')
        expect(note).toContain('(unknown task) — accepted despite verify-FAIL: behavioral fail')
    })
})
