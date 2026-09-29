import {describe, expect, test} from 'bun:test'
import {
    buildHealthRepairFence,
    buildHealthRepairTitle,
    healthRedSubject,
    healthReds,
    parseHealthRepairTitle,
    checkpointMayRepair,
    owingTask,
    planCoversHealthRed
} from '../../src/task/health-repair.js'
import type {HealthOutcome} from '../../src/task/repo-health-check.js'

const CWD = '/home/u/proj'
const TRACKED = ['src/client/api.ts', 'src/server/index.ts', 'test/api.test.ts', 'go/pkg/x.go']

function red(cmd: string, output: string, exitCode = 1): HealthOutcome {
    return {
        ok: false,
        reason: `\`${cmd}\` exited ${exitCode}`,
        ecosystem: 'node',
        commands: [{cmd, outcome: 'fail', exitCode}],
        output
    }
}

describe('healthRedSubject', () => {
    test('eslint-style absolute paths resolve to tracked repo paths, once each', () => {
        const out = [
            `${CWD}/src/client/api.ts`,
            '  12:3  error  Unsafe assignment  @typescript-eslint/no-unsafe-assignment',
            '  40:1  error  Unsafe call        @typescript-eslint/no-unsafe-call',
            `${CWD}/src/client/api.ts`,
            `${CWD}/node_modules/hono/dist/client.js`
        ].join('\n')
        expect(healthRedSubject(red('bun run lint', out), CWD, TRACKED)).toEqual({
            command: 'bun run lint',
            exitCode: 1,
            files: ['src/client/api.ts']
        })
    })

    test('tsc, cargo and go shapes all resolve; an untracked path is noise', () => {
        const out = [
            'src/server/index.ts(7,5): error TS2322: nope',
            '  --> go/pkg/x.go:12:5',
            './test/api.test.ts:3:1: undefined: foo',
            'dist/bundle.js:1:1 something'
        ].join('\n')
        expect(healthRedSubject(red('go vet ./...', out), CWD, TRACKED)?.files).toEqual([
            'src/server/index.ts',
            'go/pkg/x.go',
            'test/api.test.ts'
        ])
    })

    test('no file named → command subject; no tracked list → command subject', () => {
        const out = 'error: something is wrong\n1 problem'
        expect(healthRedSubject(red('bun run lint', out), CWD, TRACKED)).toEqual({
            command: 'bun run lint',
            exitCode: 1,
            files: []
        })
        expect(
            healthRedSubject(red('bun run lint', `${CWD}/src/client/api.ts`), CWD, null)?.files
        ).toEqual([])
    })

    test('an ambiguous suffix resolves to nothing rather than a guess', () => {
        const tracked = ['a/src/x.ts', 'b/src/x.ts']
        expect(healthRedSubject(red('tsc', 'src/x.ts(1,1): error'), CWD, tracked)?.files).toEqual(
            []
        )
    })

    test('a result with no failing command is no subject', () => {
        expect(healthRedSubject({ok: false, commands: []}, CWD, TRACKED)).toBeNull()
        expect(healthRedSubject({ok: false}, CWD, TRACKED)).toBeNull()
    })

    // The largest regression the differential catches is the one that fails
    // nothing: the suite is gone, so `ok` is true and no command is `fail`. With
    // no subject, ACCEPT queued no repair for it and the checkpoint spliced none.
    test('a vanished suite is a subject, though nothing failed', () => {
        const health: HealthOutcome = {
            ok: true,
            reason: 'node: static checks and tests passed',
            ecosystem: 'node',
            commands: [
                {cmd: 'bun run lint', outcome: 'pass', exitCode: 0, kind: 'static'},
                // `runRepoHealthCheck` writes null for a skip, so a real vanished
                // suite never carries an exit code.
                {
                    cmd: 'bun run test',
                    outcome: 'skip',
                    exitCode: null,
                    kind: 'test',
                    gap: 'empty-suite'
                }
            ],
            output: ''
        }
        const vanished = healthRedSubject(health, CWD, TRACKED)
        expect(vanished).toEqual({
            command: 'bun run test',
            exitCode: null,
            files: [],
            kind: 'test',
            gap: 'empty-suite'
        })
        const title = buildHealthRepairTitle({...vanished!, owners: []})
        expect(title).toBe('repair `bun run test`: exits ? (no task in this run owns it)')
        expect(parseHealthRepairTitle(title)?.command).toBe('bun run test')
    })

    // Every command runs now, so two can be red at once. The subject's files come
    // from ITS output: a lint subject read from the suite's stack trace would pin
    // the repair to a test file the lint never named.
    test('the subject is the first red the caller may repair, read from its own output', () => {
        const health: HealthOutcome = {
            ok: false,
            reason: '',
            ecosystem: 'node',
            commands: [
                {
                    cmd: 'bun run test',
                    outcome: 'fail',
                    exitCode: 1,
                    kind: 'test',
                    output: `${CWD}/test/api.test.ts`
                },
                {
                    cmd: 'bun run lint',
                    outcome: 'fail',
                    exitCode: 1,
                    kind: 'static',
                    output: `${CWD}/src/client/api.ts`
                }
            ],
            output: `${CWD}/test/api.test.ts`
        }
        expect(healthRedSubject(health, CWD, TRACKED, c => c.kind !== 'test')).toEqual({
            command: 'bun run lint',
            exitCode: 1,
            files: ['src/client/api.ts'],
            kind: 'static'
        })
        expect(healthRedSubject(health, CWD, TRACKED, () => false)).toBeNull()
    })

    // A covered first red must not hide the next one: the checkpoint splices the
    // first red the plan does not already carry a repair for.
    test('every red the caller may repair, each read from its own output', () => {
        const health: HealthOutcome = {
            ok: false,
            reason: '',
            ecosystem: 'node',
            commands: [
                {cmd: 'bun run lint', outcome: 'fail', exitCode: 1, kind: 'static', output: ''},
                {
                    cmd: 'bun run test',
                    outcome: 'fail',
                    exitCode: 1,
                    kind: 'test',
                    output: `${CWD}/test/api.test.ts`
                }
            ],
            output: ''
        }
        const reds = healthReds(health, CWD, TRACKED)
        expect(reds.map(r => r.command)).toEqual(['bun run lint', 'bun run test'])
        const plan = [{title: 'repair `bun run lint`: exits 1 (x)'}]
        expect(reds.find(r => !planCoversHealthRed(plan, r))?.command).toBe('bun run test')
    })
})

describe('title grammar', () => {
    test('file form round-trips', () => {
        const title = buildHealthRepairTitle({
            command: 'bun run lint',
            exitCode: 1,
            files: ['src/client/api.ts', 'src/server/index.ts'],
            owners: ['TASK_0033']
        })
        expect(title).toBe(
            'repair src/client/api.ts, src/server/index.ts: `bun run lint` exits 1 (introduced by TASK_0033)'
        )
        expect(parseHealthRepairTitle(title)).toEqual({
            command: 'bun run lint',
            files: ['src/client/api.ts', 'src/server/index.ts']
        })
    })

    // The task that regressed the check is named apart from those that wrote the files.
    test('a regressing task is named as such, once', () => {
        const dbRed = {command: 'bun run test', exitCode: 1, files: ['src/db.ts']}
        expect(
            buildHealthRepairTitle({...dbRed, owners: ['TASK_0004'], regressedBy: 'TASK_0013'})
        ).toBe(
            'repair src/db.ts: `bun run test` exits 1 (introduced by TASK_0004; regressed by TASK_0013)'
        )
        expect(
            buildHealthRepairTitle({...dbRed, owners: ['TASK_0004'], regressedBy: 'TASK_0004'})
        ).toBe('repair src/db.ts: `bun run test` exits 1 (introduced by TASK_0004)')
        expect(
            buildHealthRepairTitle({...dbRed, files: [], owners: [], regressedBy: 'TASK_0013'})
        ).toBe('repair `bun run test`: exits 1 (regressed by TASK_0013)')
    })

    test('command form round-trips', () => {
        const title = buildHealthRepairTitle({
            command: 'cargo clippy --all-targets',
            exitCode: 101,
            files: [],
            owners: []
        })
        expect(title).toBe(
            'repair `cargo clippy --all-targets`: exits 101 (no task in this run owns it)'
        )
        expect(parseHealthRepairTitle(title)).toEqual({
            command: 'cargo clippy --all-targets',
            files: []
        })
    })

    // A repair titled "exits 0" tells its child the check already passes.
    test('a suite red by its own report says so, and still round-trips', () => {
        const title = buildHealthRepairTitle({
            command: 'bun run test',
            exitCode: 0,
            report: '1 fail',
            files: [],
            owners: ['TASK_0012']
        })
        expect(title).toBe(
            'repair `bun run test`: exits 0 but reported "1 fail" (introduced by TASK_0012)'
        )
        expect(parseHealthRepairTitle(title)).toEqual({command: 'bun run test', files: []})
    })

    test('a root-cause repair title and a feature title are not health repairs', () => {
        expect(parseHealthRepairTitle('repair test/teardown.ts: TRUNCATE bug')).toBeNull()
        expect(parseHealthRepairTitle('Implement `src/client/api.ts` — typed client')).toBeNull()
    })
})

describe('planCoversHealthRed', () => {
    const lintRed = {command: 'bun run lint', exitCode: 1, files: ['src/client/api.ts']}
    const plan = (...titles: string[]): Array<{title: string}> => titles.map(title => ({title}))

    test('covered by the same command, by a shared file, or by a root-cause repair', () => {
        expect(planCoversHealthRed(plan('repair `bun run lint`: exits 1 (x)'), lintRed)).toBe(true)
        expect(
            planCoversHealthRed(
                plan('repair src/other.ts, src/client/api.ts: `tsc --noEmit` exits 2 (x)'),
                lintRed
            )
        ).toBe(true)
        expect(planCoversHealthRed(plan('repair src/client/api.ts: some defect'), lintRed)).toBe(
            true
        )
    })

    test('not covered by a different command over different files, nor by prose', () => {
        expect(
            planCoversHealthRed(plan('repair src/other.ts: `tsc --noEmit` exits 2 (x)'), lintRed)
        ).toBe(false)
        expect(planCoversHealthRed(plan('Fix src/client/api.ts lint'), lintRed)).toBe(false)
    })

    // A repair that turned its check green is done with it. The same check red
    // again later is a new regression, and only a repair that FAILED may stop the
    // next one from being spliced.
    test('a repair that closed debts no longer covers; one that failed still does', () => {
        const done = [
            {title: 'repair `bun run lint`: exits 1 (x)', done: true, producedId: 'TASK_0004'}
        ]
        expect(planCoversHealthRed(done, lintRed, new Set(['TASK_0004']))).toBe(false)
        expect(planCoversHealthRed(done, lintRed, new Set(['TASK_0002']))).toBe(true)
        expect(planCoversHealthRed(done, lintRed)).toBe(true)
    })
})

// mx5-n: TASK_0005 repaired TASK_0004's red `bun run test` and failed. Eight
// tasks later TASK_0013 broke the suite again, and TASK_0005's entry "covered"
// it: no repair ran, and three root-cause repairs chased the fallout for hours.
describe('a repair covers only reds that existed when it ran', () => {
    const suiteRed = {command: 'bun run test', exitCode: 1, files: [], kind: 'test' as const}
    const repair = 'repair `bun run test`: exits 1 (x)'
    const done = (title: string, producedId?: string) => ({
        title,
        done: true,
        ...(producedId === undefined ? {} : {producedId})
    })
    const owing = done('B', 'TASK_0013')
    const covers = (entries: {title: string; producedId?: string}[], owedBy = 'TASK_0013') =>
        planCoversHealthRed(entries, suiteRed, new Set(), owedBy)

    test('a repair that ran before the task that owes the red does not cover it', () => {
        expect(covers([done(repair, 'TASK_0005'), owing])).toBe(false)
    })

    // Abandoned before an id was allocated: it never tried this red either.
    test('nor does one checked off above it with no task id', () => {
        expect(covers([done(repair), owing])).toBe(false)
    })

    test('a repair that ran after it, or is the owing task, still covers: no loop', () => {
        expect(covers([owing, done(repair, 'TASK_0014')])).toBe(true)
        expect(covers([done(repair, 'TASK_0013')])).toBe(true)
    })

    test('a queued repair that has not run covers', () => {
        expect(covers([owing, {title: repair}])).toBe(true)
    })

    test('an owing task from outside this plan leaves every entry covering', () => {
        expect(covers([done(repair, 'TASK_0005'), owing], 'TASK_0001')).toBe(true)
    })

    test('owingTask is the latest regression of the command; a found red owes nothing', () => {
        const debts = [
            {
                taskId: 'TASK_0004',
                reason: 'test suite: `bun run test` exited 1',
                origin: 'yolo-accepted'
            },
            {
                taskId: 'TASK_0013',
                reason: 'test suite: `bun run test` exited 1',
                origin: 'yolo-accepted'
            },
            {
                taskId: 'TASK_0014',
                reason: 'test suite: `bun run test` exited 1 — already failing before this task',
                origin: 'inherited-health'
            },
            {
                taskId: 'TASK_0020',
                reason: 'test suite: `bun run lint` exited 1',
                origin: 'yolo-accepted'
            },
            {taskId: '', reason: 'test suite: `bun run test` exited 1'}
        ]
        expect(owingTask(suiteRed, debts)).toBe('TASK_0013')
        expect(owingTask({...suiteRed, command: 'bun run build'}, debts)).toBeNull()
    })

    // An abandoned entry's debt quotes its title, and a title can quote a command.
    test('only a regression of the check owes it, never a debt that merely quotes it', () => {
        const debts = [
            {
                taskId: 'TASK_0013',
                reason: 'test suite: `bun run test` exited 1',
                origin: 'yolo-accepted'
            },
            {
                taskId: 'TASK_0020',
                reason: '"repair `bun run test`: exits 1 (x)" was abandoned after 3 attempts',
                origin: 'abandoned'
            },
            {
                taskId: 'TASK_AUTO_0099',
                reason: 'test suite: `bun run test` exited 1',
                origin: 'accepted'
            }
        ]
        expect(owingTask(suiteRed, debts)).toBe('TASK_0013')
    })

    // mx5-n: TASK_0016 tripped over TASK_0004's db.ts and recorded it as root cause.
    // Counted as TASK_0016's regression, it made TASK_0014's repair stale.
    test('a task that tripped over the red, blaming another task, does not owe it', () => {
        const debts = [
            {
                taskId: 'TASK_0013',
                reason: 'test suite: `bun run test` exited 1',
                origin: 'yolo-accepted'
            },
            {
                taskId: 'TASK_0016',
                reason: 'test suite: `bun run test` exited 1 — ROOT CAUSE: `src/db.ts` (introduced by TASK_0004, not touched by this task)',
                origin: 'root-cause'
            }
        ]
        expect(owingTask(suiteRed, debts)).toBe('TASK_0013')
    })

    test('a suite that lost a part is owed by the task that lost it, not a later red', () => {
        const debts = [
            {
                taskId: 'TASK_0009',
                reason: 'test suite: `bun run test` found no tests in part of its suite',
                origin: 'accepted'
            },
            {taskId: 'TASK_0011', reason: 'test suite: `bun run test` exited 1', origin: 'accepted'}
        ]
        const part = {...suiteRed, exitCode: null, gap: 'part-empty-suite' as const}
        expect(owingTask(part, debts)).toBe('TASK_0009')
        expect(owingTask(suiteRed, debts)).toBe('TASK_0011')
    })
})

// A red suite at a checkpoint is repairable only when a task was accepted for
// making it red that way: a database may be down here, and a part-empty suite
// passed every test it ran.
describe('checkpointMayRepair', () => {
    const part = {
        command: 'bun run test',
        exitCode: null,
        files: [],
        kind: 'test' as const,
        gap: 'part-empty-suite' as const
    }
    const failRow = {command: 'bun run test', exitCode: 1, files: [], kind: 'test' as const}
    const oldRed = [
        {taskId: 'TASK_0004', reason: 'test suite: `bun run test` exited 1', origin: 'accepted'}
    ]
    const lostHalf = [
        {
            taskId: 'TASK_0009',
            reason: 'test suite: `bun run test` found no tests in part of its suite',
            origin: 'accepted'
        }
    ]

    test('a failing suite with an owed regression is repairable', () => {
        expect(checkpointMayRepair(failRow, oldRed)).toBe(true)
        expect(checkpointMayRepair(failRow, [])).toBe(false)
    })

    test('an inherited red, a static debt, or another command owes nothing', () => {
        expect(
            checkpointMayRepair(failRow, [
                {
                    reason: 'test suite: `bun run test` exited 1 — already failing before this task',
                    origin: 'inherited-health'
                },
                {reason: 'repo health: `bun run lint` exited 1', origin: 'accepted'},
                {reason: 'test suite: `bun run test:e2e` exited 1', origin: 'accepted'}
            ])
        ).toBe(false)
    })

    test('a part-empty suite is repairable only for the regression that emptied it', () => {
        expect(checkpointMayRepair(part, oldRed)).toBe(false)
        expect(checkpointMayRepair(part, lostHalf)).toBe(true)
    })

    test('a static check is always repairable', () => {
        expect(
            checkpointMayRepair(
                {command: 'bun run lint', exitCode: 1, files: [], kind: 'static'},
                []
            )
        ).toBe(true)
    })
})

describe('buildHealthRepairFence', () => {
    test('pins the files, forbids suppression, pins VERIFY to the command', () => {
        const fence = buildHealthRepairFence({
            command: 'bun run lint',
            files: ['src/client/api.ts']
        })
        expect(fence).toContain('`src/client/api.ts` is the ONLY')
        expect(fence).toContain('Do NOT suppress')
        expect(fence).toContain('The VERIFY block MUST be exactly: `bun run lint`')
    })

    test('command form pins only what the command reports', () => {
        const fence = buildHealthRepairFence({command: 'go vet ./...', files: []})
        expect(fence).toContain('Modify only the files the command reports')
    })

    // mx5-n TASK_0006 greened `bun run test` with a shim in gitignored node_modules/,
    // and the gate closed two debts on a check that is red on a fresh checkout.
    test('the fix must live in tracked files', () => {
        const fence = buildHealthRepairFence({command: 'bun run test', files: []})
        expect(fence).toContain('Put the fix in files the repository tracks')
    })

    // A declared dependency missing from node_modules is red until an install, and
    // a fresh checkout installs: forbidding it leaves the repair nothing to do.
    test("the project's own install or build is not a forbidden fix", () => {
        const fence = buildHealthRepairFence({command: 'bun run test', files: []})
        expect(fence).toContain("Running the project's own install or build is allowed")
    })
})
