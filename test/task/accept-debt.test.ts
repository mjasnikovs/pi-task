/**
 * accept-debt tests — the durable ledger of tasks the user ACCEPTED despite a
 * verify-FAIL. Parsing, the FP-safe re-check, and
 * the report block are pure; record/read/write/prune run against a real throwaway
 *.pi-tasks dir (the artifact contract is the point).
 */
import {describe, expect, test} from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    acceptDebtFile,
    annotateDebtConflicts,
    buildAcceptDebtNote,
    crossTaskDeletionReason,
    describeDebt,
    extractExistenceClaims,
    isStaticClassDebt,
    parseAcceptDebts,
    readAcceptDebts,
    recheckAcceptDebts,
    recordDebt,
    extractDeletedDebtPath,
    writeAcceptDebts,
    classifyVerifyCommand,
    verifyCommandFromReason,
    type AcceptDebt
} from '../../src/task/accept-debt.js'

function makeCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-accept-debt-'))
}

// The verbatim one task enforce re-verify FAIL — the terminal defect that
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

describe("recordDebt (origin 'accepted') / readAcceptDebts", () => {
    test('appends a durable record under .pi-tasks/', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0012', 'modified src/main.tsx which the spec froze', 'accepted')
        expect(fs.existsSync(acceptDebtFile(cwd))).toBe(true)
        expect(await readAcceptDebts(cwd)).toEqual([
            {taskId: 'TASK_0012', reason: 'modified src/main.tsx which the spec froze'}
        ])
    })

    test('flattens newlines/tabs and caps the reason length', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'T1', `line one\n\tline two   with    spaces`, 'accepted')
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.reason).toBe('line one line two with spaces')
        // A tab in the stored reason would corrupt the id/reason split — none survives.
        expect(fs.readFileSync(acceptDebtFile(cwd), 'utf8').split('\n')[0]).toBe(
            'T1\tline one line two with spaces'
        )
    })

    test('caps very long reasons to 300 chars', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'T1', 'x'.repeat(500), 'accepted')
        expect((await readAcceptDebts(cwd))[0].reason.length).toBe(300)
    })

    test('dedups the same task+reason but keeps distinct ones', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'T1', 'same reason', 'accepted')
        await recordDebt(cwd, 'T1', 'same reason', 'accepted')
        await recordDebt(cwd, 'T1', 'other reason', 'accepted')
        await recordDebt(cwd, 'T2', 'same reason', 'accepted')
        expect(await readAcceptDebts(cwd)).toEqual([
            {taskId: 'T1', reason: 'same reason'},
            {taskId: 'T1', reason: 'other reason'},
            {taskId: 'T2', reason: 'same reason'}
        ])
    })

    test('an empty reason records nothing', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'T1', '   \n  ', 'accepted')
        expect(await readAcceptDebts(cwd)).toEqual([])
    })

    test('reading a cwd with no ledger yet → empty list', async () => {
        expect(await readAcceptDebts(makeCwd())).toEqual([])
    })
})

describe('writeAcceptDebts (prune)', () => {
    test('overwrites with exactly the given records', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'T1', 'a', 'accepted')
        await recordDebt(cwd, 'T2', 'b', 'accepted')
        await writeAcceptDebts(cwd, [{taskId: 'T2', reason: 'b'}])
        expect(await readAcceptDebts(cwd)).toEqual([{taskId: 'T2', reason: 'b'}])
    })

    test('empty list clears the ledger', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'T1', 'a', 'accepted')
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

    test('static-class debt is RESOLVED when statics now pass', async () => {
        const {open, resolved} = await recheckAcceptDebts([staticDebt, frozenDebt], {
            staticOk: true
        })
        expect(resolved).toEqual([staticDebt])
        // The frozen-path (behavioral) debt can never be auto-closed — always surfaced.
        expect(open).toEqual([frozenDebt])
    })

    test('static-class debt stays OPEN when statics still fail', async () => {
        const {open, resolved} = await recheckAcceptDebts([staticDebt, frozenDebt], {
            staticOk: false
        })
        expect(resolved).toEqual([])
        expect(open).toEqual([staticDebt, frozenDebt])
    })

    test('nothing recorded → nothing open (clean)', async () => {
        expect(await recheckAcceptDebts([], {staticOk: true})).toEqual({
            open: [],
            resolved: [],
            trail: []
        })
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

// item 3: an enforce re-verify FAIL that indicts the ORIGINAL work must
// survive the revert as a durable, gate-re-checked defect.
describe("recordDebt origin 'enforce-revert' / origin round-trip", () => {
    test('records a 3-field origin-tagged row that reads back with origin set', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0004', TASK_0004_DIAGNOSIS, 'enforce-revert')
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
        await recordDebt(cwd, 'TASK_0004', 'the server cannot start', 'accepted')
        await recordDebt(cwd, 'TASK_0004', 'the server cannot start', 'enforce-revert')
        const debts = await readAcceptDebts(cwd)
        expect(debts).toHaveLength(2)
        expect(debts.map(d => d.origin ?? 'accepted').sort()).toEqual([
            'accepted',
            'enforce-revert'
        ])
    })

    test('a behavioral enforce-revert debt stays OPEN even when statics pass', async () => {
        const debts: AcceptDebt[] = [
            {taskId: 'TASK_0004', reason: TASK_0004_DIAGNOSIS, origin: 'enforce-revert'}
        ]
        const {open, resolved} = await recheckAcceptDebts(debts, {staticOk: true})
        expect(resolved).toHaveLength(0)
        expect(open).toHaveLength(1)
    })
})

// The eight per-origin recorders (recordFinalGateUnobservedDebt, recordAcceptDebt, …)
// carried their class in the NAME, so collapsing them into one recordDebt moved that
// class into a parameter — and the parameter defaulted to 'accepted'. One migrated
// call in scripts/ignored-writes-ab.ts lost its argument and the default absorbed it
// silently: a run-level 'final-gate' demotion was written to the ledger as a human
// 'accepted'. The two classes assert opposite things — 'accepted' says a person
// weighed the failing artifact and shipped it anyway; 'final-gate' says the gate gave
// up after two tree-changing fix attempts failed identically. describeDebt prints a
// different one-liner for each and the final gate re-checks BY class, so the swap
// rewrites the audit trail of what actually happened.
//
// `origin` is now a required parameter — the compiler is the real guard, and these
// tests pin the behaviour it protects.
describe("recordDebt origin 'final-gate' (the class a default must never absorb)", () => {
    test('a final-gate demotion reads back as final-gate, not accepted', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'AB', 'gate PASS depended on an ignored path: .env', 'final-gate')
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.origin).toBe('final-gate')
        // The distinction is not internal: the two classes surface as different text.
        expect(describeDebt(debt)).not.toBe(describeDebt({...debt, origin: 'accepted'}))
    })

    test('the same id/reason under both origins stays two rows, never deduped into one', async () => {
        const cwd = makeCwd()
        const reason = 'gate PASS depended on an ignored path: .env'
        await recordDebt(cwd, 'AB', reason, 'final-gate')
        await recordDebt(cwd, 'AB', reason, 'accepted')
        // 'accepted' serialises as the legacy 2-field row, so it reads back undefined.
        expect((await readAcceptDebts(cwd)).map(d => d.origin ?? 'accepted').sort()).toEqual([
            'accepted',
            'final-gate'
        ])
    })
})

// ─── Conflicting-claim classification ───────────────────────────
//
// Three VERBATIM debts off a real ledger. Only T9 is an existence-as-failure claim indicting a sibling's
// deliverable — the final-gate autofix child, seeded with it, ran
// `rm src/client/pages/admin.tsx` and destroyed a task's verified work.
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

// a / PROMPT 1 layer B: a repo-health FAIL whose only fix is an edit to a
// path this task's spec froze — recorded when the gate loop routes to the picker.
describe("recordDebt origin 'frozen-blocked' / origin round-trip", () => {
    const REASON =
        'repo health: `bun run lint` exited 1 — frozen-path: static findings implicate spec-frozen path(s) (tsconfig.json)'

    test('records a 3-field origin-tagged row that reads back with origin set', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0021', REASON, 'frozen-blocked')
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.taskId).toBe('TASK_0021')
        expect(debt.origin).toBe('frozen-blocked')
        expect(debt.reason).toContain('tsconfig.json')
        const raw = fs.readFileSync(acceptDebtFile(cwd), 'utf8')
        expect(raw.trimEnd().endsWith('frozen-blocked')).toBe(true)
    })

    test('is static-class: auto-closes when the run-end static check passes', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0021', REASON, 'frozen-blocked')
        const debts = await readAcceptDebts(cwd)
        expect((await recheckAcceptDebts(debts, {staticOk: true})).resolved).toHaveLength(1)
        expect((await recheckAcceptDebts(debts, {staticOk: false})).open).toHaveLength(1)
    })

    test('describeDebt names the cross-task contradiction', () => {
        const [d] = parseAcceptDebts(`TASK_0021\t${REASON}\tfrozen-blocked`)
        expect(d.origin).toBe('frozen-blocked')
        expect(describeDebt(d)).toContain('cross-task contradiction')
    })

    test('dedup: routing the same contradiction twice records one row', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0021', REASON, 'frozen-blocked')
        await recordDebt(cwd, 'TASK_0021', REASON, 'frozen-blocked')
        expect(await readAcceptDebts(cwd)).toHaveLength(1)
    })
})

describe("recordDebt origin 'cross-task-deletion' / re-check by file existence (mx5 run 12 PROMPT 2)", () => {
    test('records a machine-parseable origin-tagged row naming path and owner', async () => {
        const cwd = makeCwd()
        await recordDebt(
            cwd,
            'TASK_0021',
            crossTaskDeletionReason({path: 'playwright/index.ts', owner: 'TASK_0020'}),
            'cross-task-deletion'
        )
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.taskId).toBe('TASK_0021')
        expect(debt.origin).toBe('cross-task-deletion')
        expect(debt.reason).toContain('`playwright/index.ts`')
        expect(debt.reason).toContain('TASK_0020')
        expect(extractDeletedDebtPath(debt.reason)).toBe('playwright/index.ts')
        expect(describeDebt(debt)).toContain('DELETED')
    })

    test('extractDeletedDebtPath: only the fixed record shape parses', () => {
        expect(extractDeletedDebtPath('deleted `a/b.ts` — TASK_0002…')).toBe('a/b.ts')
        expect(extractDeletedDebtPath('the file a/b.ts was deleted')).toBeNull()
        expect(extractDeletedDebtPath('')).toBeNull()
    })

    test('resolved iff the deleted file is back in the tree; never closed by staticOk', async () => {
        const cwd = makeCwd()
        await recordDebt(
            cwd,
            'TASK_0021',
            crossTaskDeletionReason({path: 'playwright/index.ts', owner: 'TASK_0020'}),
            'cross-task-deletion'
        )
        const debts = await readAcceptDebts(cwd)
        // Still missing: stays open even when statics pass (not a static-class debt).
        const still = await recheckAcceptDebts(debts, {staticOk: true, fileExists: () => false})
        expect(still.open).toHaveLength(1)
        expect(still.resolved).toHaveLength(0)
        // Restored: the deterministic existence check closes it.
        const restored = await recheckAcceptDebts(debts, {
            staticOk: false,
            fileExists: rel => rel === 'playwright/index.ts'
        })
        expect(restored.resolved).toHaveLength(1)
        expect(restored.open).toHaveLength(0)
        // No fileExists wired (older caller): surfaced, never silently closed.
        const noDep = await recheckAcceptDebts(debts, {staticOk: true})
        expect(noDep.open).toHaveLength(1)
    })

    test('a throwing fileExists is inconclusive — the debt stays open', async () => {
        const cwd = makeCwd()
        await recordDebt(
            cwd,
            'TASK_0021',
            crossTaskDeletionReason({path: 'a/b.ts', owner: 'TASK_0002'}),
            'cross-task-deletion'
        )
        const debts = await readAcceptDebts(cwd)
        const out = await recheckAcceptDebts(debts, {
            staticOk: true,
            fileExists: () => {
                throw new Error('fs broke')
            }
        })
        expect(out.open).toHaveLength(1)
    })
})

describe("recordDebt origin 'yolo-accepted' — an auto-pick never masquerades as a human call", () => {
    test("round-trips through parseAcceptDebts as 'yolo-accepted', NOT 'accepted'", async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0007', 'boot check: GET / returned 404', 'yolo-accepted')
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.taskId).toBe('TASK_0007')
        expect(debt.origin).toBe('yolo-accepted')
        // The whitelist is the load-bearing part: an origin missing from it silently
        // degrades to legacy 'accepted' = "a human decided this".
        expect(debt.origin).not.toBe('accepted')
        expect(parseAcceptDebts(fs.readFileSync(acceptDebtFile(cwd), 'utf8'))[0].origin).toBe(
            'yolo-accepted'
        )
    })

    test('the surfaced report says plainly that nobody weighed it', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0007', 'repo health: `bun run lint` exited 1', 'yolo-accepted')
        const [debt] = await readAcceptDebts(cwd)
        expect(describeDebt(debt)).toMatch(/YOLO/)
        expect(describeDebt(debt)).toMatch(/unattended|no human/i)
        expect(buildAcceptDebtNote([debt])).toContain('TASK_0007')
    })

    test('re-checked like any other debt: static-class closes on a clean tree, others stay open', async () => {
        const cwd = makeCwd()
        await recordDebt(cwd, 'TASK_0007', 'repo health: `bun run lint` exited 1', 'yolo-accepted')
        await recordDebt(cwd, 'TASK_0008', 'the edit listing page renders blank', 'yolo-accepted')
        const debts = await readAcceptDebts(cwd)
        const {open, resolved} = await recheckAcceptDebts(debts, {staticOk: true})
        expect(resolved.map(d => d.taskId)).toEqual(['TASK_0007'])
        expect(open.map(d => d.taskId)).toEqual(['TASK_0008'])
    })
})

/**
 * The VERIFY-COMMAND class. A debt whose reason quotes —
 * verbatim, in backticks — a line of its OWN task's VERIFY block carries that command
 * in the ledger, and the run-end re-check settles it by RUNNING it. reported
 * one task "STILL OPEN" eleven minutes after the autofix fixed exactly the thing its
 * reason named, and the gate's own re-run printed `121 pass 0 fail`; no reachable code
 * path could have closed it, because neither existing class can reach a
 * `work did not verify:` reason.
 *
 * The six invariants below are the whole safety argument. Each is also asserted over
 * the recorded corpus by scripts/debt-verify-close-ab.ts; these are the deterministic
 * copies that cannot drift with a corpus tree.
 */
describe('verify-command debt class', () => {
    const SPEC = [
        'GOAL',
        'ship the listings routes',
        '',
        'VERIFY:',
        '```sh',
        '# comment lines are not commands',
        'bunx tsc --noEmit',
        'AGENT=1 bun test test/listings.test.ts',
        '```',
        '',
        '## gate trail',
        '- verify: FAIL — repo health: `bun run lint` exited 2'
    ].join('\n')
    const REASON =
        'work did not verify: The VERIFY block command `AGENT=1 bun test '
        + 'test/listings.test.ts` fails unaided because no `.env` file exists'

    async function withSpec(taskId: string, spec: string): Promise<string> {
        const cwd = makeCwd()
        fs.mkdirSync(path.join(cwd, '.pi-tasks'), {recursive: true})
        fs.writeFileSync(path.join(cwd, '.pi-tasks', `${taskId}.md`), spec, 'utf8')
        return cwd
    }

    test('extracts ONLY a backticked span that is a verbatim VERIFY line', async () => {
        const cmds = ['bunx tsc --noEmit', 'AGENT=1 bun test test/listings.test.ts']
        expect(verifyCommandFromReason(REASON, cmds)).toBe('AGENT=1 bun test test/listings.test.ts')
        // A near-miss is a miss: no prefix, no paraphrase, no substring.
        expect(verifyCommandFromReason('… `bun test test/listings.test.ts` fails', cmds)).toBeNull()
        expect(verifyCommandFromReason('… `AGENT=1 bun test` fails', cmds)).toBeNull()
        // Un-quoted mention is not a claim about a command ('s one task reads
        // exactly this way and must NOT classify).
        expect(verifyCommandFromReason('bunx tsc --noEmit could not run', cmds)).toBeNull()
        expect(verifyCommandFromReason(REASON, [])).toBeNull()
    })

    test('records the command, and it round-trips through the ledger', async () => {
        const cwd = await withSpec('TASK_0009', SPEC)
        await recordDebt(cwd, 'TASK_0009', REASON, 'yolo-accepted')
        const [debt] = await readAcceptDebts(cwd)
        expect(debt.verifyCommand).toBe('AGENT=1 bun test test/listings.test.ts')
        expect(debt.origin).toBe('yolo-accepted')
        // 4 tab-separated fields on disk, and legacy 2/3-field records still parse.
        expect(fs.readFileSync(acceptDebtFile(cwd), 'utf8').split('\t')).toHaveLength(4)
        const legacy = parseAcceptDebts('T1\treason only\nT2\tanother\tyolo-accepted')
        expect(legacy.map(d => d.verifyCommand)).toEqual([undefined, undefined])
        // The plain 'accepted' origin survives the positional 4-field shape.
        const accepted = parseAcceptDebts('T3\twhy\taccepted\tbun test')
        expect(accepted[0].origin).toBeUndefined()
        expect(accepted[0].verifyCommand).toBe('bun test')
    })

    test('inv-command-provenance — an UNCLOSED VERIFY fence stores nothing', async () => {
        // one task.md opens ```sh and never closes it, so the lenient
        // parser hands back the phase timings and every appended gate-trail line as
        // "commands" — including a sentence quoting `bun run lint`. Storing that would
        // be provenance this project invented.
        const runaway = SPEC.replace('```\n\n## gate trail', '\n## gate trail')
        const cwd = await withSpec('TASK_0001', runaway)
        expect(await classifyVerifyCommand(cwd, 'TASK_0001', REASON)).toBeNull()
        expect(
            await classifyVerifyCommand(cwd, 'TASK_0001', 'repo health: `bun run lint` exited 2')
        ).toBeNull()
        // No spec at all, and no task id, are the same story: nothing to stand behind.
        expect(await classifyVerifyCommand(cwd, 'TASK_0404', REASON)).toBeNull()
        expect(await classifyVerifyCommand(cwd, '', REASON)).toBeNull()
    })

    // ───  ────────────────────────────────────────────────────────
    //
    // The auto-close rests entirely on a ZERO exit meaning "the check passed". A
    // command whose exit status is destroyed by its own construction makes that
    // meaningless. 16 of the 612 store-eligible VERIFY lines on this box are that
    // shape — 12 of them in one real project, a CMake/C++ OBS plugin with no database, no
    // frontend and no HTTP server. Refusing to store one leaves the debt OPEN and
    // surfaced, which is strictly the smaller claim.

    const UNFAILABLE_SPEC = [
        'GOAL',
        'build the plugin',
        '',
        'VERIFY:',
        '```sh',
        'cmake --build build && ctest --test-dir build',
        'test -f "$SO_LIB" && echo "PASS: lib exists" || echo "FAIL: not found"',
        '```'
    ].join('\n')

    test('19C: a VERIFY command that cannot fail is NOT stored', async () => {
        const cwd = await withSpec('TASK_0003', UNFAILABLE_SPEC)
        const unfailable = 'test -f "$SO_LIB" && echo "PASS: lib exists" || echo "FAIL: not found"'
        expect(
            await classifyVerifyCommand(
                cwd,
                'TASK_0003',
                `work did not verify: The VERIFY block command \`${unfailable}\` fails unaided`
            )
        ).toBeNull()
    })

    test('19C: a real command in the SAME block is still stored — the refusal is narrow', async () => {
        const cwd = await withSpec('TASK_0003', UNFAILABLE_SPEC)
        const real = 'cmake --build build && ctest --test-dir build'
        expect(
            await classifyVerifyCommand(
                cwd,
                'TASK_0003',
                `work did not verify: The VERIFY block command \`${real}\` fails unaided`
            )
        ).toBe(real)
    })

    test('19C: a debt already carrying an unfailable command can never auto-close', async () => {
        const debt: AcceptDebt = {
            taskId: 'TASK_0003',
            reason: 'work did not verify: the shared library was not produced',
            origin: 'yolo-accepted',
            verifyCommand: 'test -f "$SO_LIB" && echo "PASS" || echo "FAIL"'
        }
        // The re-run seam says PASS — because the shell really does exit 0 here.
        // That is the defect, and it must no longer be able to close anything.
        const out = await recheckAcceptDebts([debt], {
            staticOk: true,
            rerunVerify: async () => ({outcome: 'pass'})
        })
        expect(out.resolved).toHaveLength(0)
        expect(out.open.map(d => d.taskId)).toEqual(['TASK_0003'])
    })

    test('inv-no-false-clear — only a ZERO exit closes; fail/gap/absent never do', async () => {
        const debt: AcceptDebt = {
            taskId: 'TASK_0009',
            reason: REASON,
            origin: 'yolo-accepted',
            verifyCommand: 'AGENT=1 bun test test/listings.test.ts'
        }
        const noCommand: AcceptDebt = {taskId: 'TASK_0019', reason: 'main.tsx was modified'}
        const closes = await recheckAcceptDebts([debt, noCommand], {
            staticOk: true,
            rerunVerify: async () => ({outcome: 'pass'})
        })
        expect(closes.resolved.map(d => d.taskId)).toEqual(['TASK_0009'])
        expect(closes.trail.join(' ')).toContain('RESOLVED')
        for (const r of [
            {outcome: 'fail' as const, detail: 'exit 1'},
            {outcome: 'gap' as const, detail: 'command not found (127)'},
            {outcome: 'gap' as const, detail: 'killed (timeout or signal)'}
        ]) {
            const out = await recheckAcceptDebts([debt, noCommand], {
                staticOk: true,
                rerunVerify: async () => r
            })
            expect(out.resolved).toEqual([])
            expect(out.open.map(d => d.taskId)).toEqual(['TASK_0009', 'TASK_0019'])
        }
        // No re-runner wired, or no stored command: the class is inert, not lenient.
        expect((await recheckAcceptDebts([debt], {staticOk: true})).open).toHaveLength(1)
        expect(
            (
                await recheckAcceptDebts([noCommand], {
                    staticOk: true,
                    rerunVerify: async () => ({outcome: 'pass'})
                })
            ).open
        ).toHaveLength(1)
        // A throwing re-runner observed nothing, so it proves nothing.
        const faulted = await recheckAcceptDebts([debt], {
            staticOk: true,
            rerunVerify: async () => {
                throw new Error('spawn exploded')
            }
        })
        expect(faulted.resolved).toEqual([])
    })

    test('inv-prohibition-never-closes — a prohibition debt stays open even when its VERIFY passes', async () => {
        // one task: `main.tsx` was edited under a spec freeze. The violation
        // is permanent; the task's VERIFY (tsc, eslint, a CT spec) can pass all day.
        // It never classifies, because the reason quotes a PATH, not a command — and
        // even with the re-runner passing everything it is handed, it stays open.
        const t19: AcceptDebt = {
            taskId: 'TASK_0019',
            reason:
                'work did not verify: main.tsx was modified by this task, violating the spec '
                + 'prohibition "Do not modify `main.tsx`, router shell, nav components"',
            origin: 'yolo-accepted'
        }
        expect(verifyCommandFromReason(t19.reason, ['bunx tsc --noEmit', 'bun test'])).toBeNull()
        const out = await recheckAcceptDebts([t19], {
            staticOk: true,
            rerunVerify: async () => ({outcome: 'pass'})
        })
        expect(out.resolved).toEqual([])
        expect(out.open).toEqual([t19])
    })

    test('inv-existing-classes-kept — the two shipped classes decide exactly what they did', async () => {
        const staticClass: AcceptDebt = {
            taskId: 'T9',
            reason: 'repo health: `bun run lint` exited 1',
            // Even carrying a command, a static-class debt is settled by the statics —
            // the new class runs nothing here.
            verifyCommand: 'bun run lint'
        }
        const deletion: AcceptDebt = {
            taskId: 'T4',
            reason: 'deleted `src/pages/Admin.tsx` — TASK_0008’s committed deliverable',
            origin: 'cross-task-deletion'
        }
        let ran = 0
        const out = await recheckAcceptDebts([staticClass, deletion], {
            staticOk: true,
            fileExists: () => true,
            rerunVerify: async () => {
                ran++
                return {outcome: 'fail'}
            }
        })
        expect(out.resolved.map(d => d.taskId).sort()).toEqual(['T4', 'T9'])
        expect(ran).toBe(0)
    })

    test('inv-bounded — the per-run re-run budget caps the work and never closes past it', async () => {
        const many: AcceptDebt[] = Array.from({length: 10}, (_, i) => ({
            taskId: `T${i}`,
            reason: 'work did not verify: `bun test` fails',
            origin: 'yolo-accepted' as const,
            verifyCommand: 'bun test'
        }))
        let ran = 0
        const out = await recheckAcceptDebts(many, {
            staticOk: true,
            rerunVerify: async () => {
                ran++
                return {outcome: 'gap', detail: 'stub'}
            }
        })
        expect(ran).toBeLessThanOrEqual(3)
        expect(out.open).toHaveLength(10)
        expect(out.trail.some(l => /re-run budget/.test(l))).toBe(true)
    })
})
