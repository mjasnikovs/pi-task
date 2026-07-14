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
    annotateDebtConflicts,
    buildAcceptDebtNote,
    describeDebt,
    extractExistenceClaims,
    isStaticClassDebt,
    parseAcceptDebts,
    readAcceptDebts,
    recheckAcceptDebts,
    recordAcceptDebt,
    recordEnforceRevertDebt,
    writeAcceptDebts,
    type AcceptDebt
} from './accept-debt.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-accept-debt-'))
}

// The verbatim mx5 run 10 TASK_0004 enforce re-verify FAIL — the terminal defect that
// was found 8.5h before run end and erased by the revert that found it.
const TASK_0004_DIAGNOSIS =
    'work did not verify: Missing server entry point (src/server/index.ts) and dev script in '
    + 'package.json — the Hono server cannot be started, so auth endpoints cannot be verified '
    + 'against a live HTTP serve'

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
        expect(note).toContain('UNRESOLVED VERIFY-FAIL DEBT still open (2)')
        expect(note).toContain('TASK_0012 — accepted despite verify-FAIL: frozen-path violation')
        expect(note).toContain('(unknown task) — accepted despite verify-FAIL: behavioral fail')
    })

    test('an enforce-revert debt is labelled distinctly from an accepted one', () => {
        const note = buildAcceptDebtNote([
            {taskId: 'TASK_0004', reason: TASK_0004_DIAGNOSIS, origin: 'enforce-revert'}
        ])
        expect(note).toContain('TASK_0004 — enforce re-verify FAILED then the edits were reverted')
        expect(note).toContain('Missing server entry point')
    })
})

// mx5 run 10 item 3: an enforce re-verify FAIL that indicts the ORIGINAL work must
// survive the revert as a durable, gate-re-checked defect.
describe('recordEnforceRevertDebt / origin round-trip', () => {
    test('records a 3-field origin-tagged row that reads back with origin set', async () => {
        const cwd = makeCwd()
        await recordEnforceRevertDebt(cwd, 'TASK_0004', TASK_0004_DIAGNOSIS)
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.taskId).toBe('TASK_0004')
        expect(debt.origin).toBe('enforce-revert')
        expect(debt.reason).toContain('Missing server entry point')
        // Stored as a 3-field tab row so old readers still parse id + reason.
        const raw = fs.readFileSync(acceptDebtFile(cwd), 'utf8')
        expect(raw.split('\t').length).toBe(3)
        expect(raw.trimEnd().endsWith('enforce-revert')).toBe(true)
    })

    test('legacy 2-field rows still parse (origin absent = accepted)', () => {
        const [d] = parseAcceptDebts('TASK_0012\tfrozen-path violation')
        expect(d.origin).toBeUndefined()
        expect(describeDebt(d)).toBe('accepted despite verify-FAIL')
    })

    test('an accepted debt and an enforce-revert debt with the same id/reason coexist', async () => {
        const cwd = makeCwd()
        await recordAcceptDebt(cwd, 'TASK_0004', 'the server cannot start')
        await recordEnforceRevertDebt(cwd, 'TASK_0004', 'the server cannot start')
        const debts = await readAcceptDebts(cwd)
        expect(debts).toHaveLength(2)
        expect(debts.map(d => d.origin ?? 'accepted').sort()).toEqual([
            'accepted',
            'enforce-revert'
        ])
    })

    test('a behavioral enforce-revert debt stays OPEN even when statics pass', () => {
        const debts: AcceptDebt[] = [
            {taskId: 'TASK_0004', reason: TASK_0004_DIAGNOSIS, origin: 'enforce-revert'}
        ]
        const {open, resolved} = recheckAcceptDebts(debts, {staticOk: true})
        expect(resolved).toHaveLength(0)
        expect(open).toHaveLength(1)
    })
})

// ─── Conflicting-claim classification (mx5 run 11) ───────────────────────────
//
// The three VERBATIM debts from the run-11 ledger (~/hub/mx5/.pi-tasks/
// accept-debt.md). Only T9 is an existence-as-failure claim indicting a sibling's
// deliverable — the final-gate autofix child, seeded with it, ran
// `rm src/client/pages/admin.tsx` and destroyed TASK_0008's verified work.
const RUN11_T1 =
    'work did not verify: src/server/db.ts imports {SQL} (uppercase class constructor) instead '
    + 'of the spec-mandated {sql} (lowercase tagged template function); the constraint '
    + 'explicitly requires "import { sql } from \'bun\'" and the acceptance criteria state '
    + 'db.ts must use that exact import form'
const RUN11_T7 =
    'work did not verify: src/client/api.ts was modified (import path changed from '
    + "'../server/index.js' to './routes.js') despite the spec's prohibition \"Preserve all "
    + 'existing files: src/client/api.ts" with no exception covering this change'
const RUN11_T9 =
    'work did not verify: Verification check #7 fails: src/client/pages/admin.tsx exists '
    + '(introduced by prior TASK_0008, not this task). The shipped verification script exits '
    + 'with code 1 at the admin page existence gate.'

describe('extractExistenceClaims', () => {
    test('run-11 T9: the path whose existence IS the failure is extracted', () => {
        expect(extractExistenceClaims(RUN11_T9)).toEqual(['src/client/pages/admin.tsx'])
    })

    test('run-11 T1/T7: paths merely MENTIONED (import form, prohibition) never qualify', () => {
        expect(extractExistenceClaims(RUN11_T1)).toEqual([])
        expect(extractExistenceClaims(RUN11_T7)).toEqual([])
    })

    test('"must not exist" phrasing also qualifies; bare mentions do not', () => {
        expect(extractExistenceClaims('src/pages/admin.tsx must not exist per scope')).toEqual([
            'src/pages/admin.tsx'
        ])
        expect(extractExistenceClaims('the file src/pages/admin.tsx still exists')).toEqual([
            'src/pages/admin.tsx'
        ])
        expect(extractExistenceClaims('src/pages/admin.tsx renders a blank page')).toEqual([])
    })
})

describe('annotateDebtConflicts', () => {
    const introducedBy = (p: string): string | null =>
        p === 'src/client/pages/admin.tsx' ? 'TASK_0008' : null

    test('run-11 ledger: exactly T9 is annotated, T1/T7 pass through untouched (0 FP)', () => {
        const debts: AcceptDebt[] = [
            {taskId: 'TASK_0001', reason: RUN11_T1, origin: 'enforce-revert'},
            {taskId: 'TASK_0007', reason: RUN11_T7},
            {taskId: 'TASK_0009', reason: RUN11_T9}
        ]
        const out = annotateDebtConflicts(debts, introducedBy)
        expect(out[0].conflict).toBeUndefined()
        expect(out[1].conflict).toBeUndefined()
        expect(out[2].conflict).toContain("TASK_0008's committed deliverable")
        expect(out[2].conflict).toContain('do NOT delete')
        // Annotation copies; originals keep their fields.
        expect(out[2].taskId).toBe('TASK_0009')
        expect(out[2].reason).toBe(RUN11_T9)
    })

    test("a claim naming the debt task's OWN file is self-consistent — no conflict", () => {
        const out = annotateDebtConflicts(
            [{taskId: 'TASK_0008', reason: RUN11_T9.replace('check #7', 'check #1')}],
            introducedBy
        )
        expect(out[0].conflict).toBeUndefined()
    })

    test('unknown introducer (file predates the run / not a task commit) → no conflict', () => {
        const out = annotateDebtConflicts([{taskId: 'TASK_0009', reason: RUN11_T9}], () => null)
        expect(out[0].conflict).toBeUndefined()
    })
})

describe('buildAcceptDebtNote — conflicting claims', () => {
    test('a conflicting debt carries its contradiction inline; the header disclaims instructions', () => {
        const note = buildAcceptDebtNote([
            {
                taskId: 'TASK_0009',
                reason: RUN11_T9,
                conflict:
                    "`src/client/pages/admin.tsx` is TASK_0008's committed deliverable — do NOT delete"
            }
        ])
        expect(note).toContain('⚠ CONFLICTING CLAIM')
        expect(note).toContain("TASK_0008's committed deliverable")
        expect(note).toContain('not instructions to edit code')
    })
})
