import {test, expect, describe} from 'bun:test'
import {readFileSync} from 'node:fs'
import * as path from 'node:path'
import {
    classifyCommandRun,
    outputTail,
    INFRA_GAP_OUTPUT_RE,
    type CommandRun,
    type CommandGapId
} from '../../src/task/command-run.js'

const ran = (over: Partial<CommandRun> = {}): CommandRun => ({
    failedToStart: false,
    status: 0,
    stdout: '',
    stderr: '',
    ...over
})

// classifyCommandRun is pure: exit status, signal and output in, verdict out.
// So every case below is a LITERAL. The same rules expressed as branches inside
// each caller could only be exercised by spawning a real child into a temp
// directory — and some of them only by shadowing a binary on PATH and resetting
// a module cache, which is order-sensitive and not portable.

test('exit 0 is the only pass', () => {
    expect(classifyCommandRun(ran())).toEqual({outcome: 'pass'})
})

test('a real non-zero exit fails, carrying the output tail', () => {
    const v = classifyCommandRun(ran({status: 1, stderr: '3 tests failed'}))
    expect(v).toEqual({outcome: 'fail', status: 1, tail: '3 tests failed'})
})

describe('the env-gap contract — a command that told us nothing never fails a gate', () => {
    const cases: ReadonlyArray<[CommandGapId, CommandRun]> = [
        ['spawn-failed', ran({failedToStart: true, failureMessage: 'ENOENT', status: null})],
        ['killed', ran({status: null})],
        ['command-not-found', ran({status: 127, stderr: 'bun: command not found'})],
        [
            'missing-runtime',
            ran({status: 1, stderr: "Executable doesn't exist at /ms-playwright/chromium"})
        ]
    ]
    for (const [gap, run] of cases) {
        test(`${gap} is a gap, not a failure`, () => {
            const v = classifyCommandRun(run)
            expect(v.outcome).toBe('gap')
            expect(v.outcome === 'gap' && v.gap).toBe(gap)
        })
    }
})

test('spawn-failed stays distinguishable from every other gap', () => {
    // Load-bearing: `spawn-failed` is the ONLY gap that reaches the gate's
    // blindness guard — final-gate.ts:417 passes `verdict.gap === 'spawn-failed'`
    // through, and gate-tally separates "discovered but every one failed to
    // spawn" from every other outcome. A 127 inside the script chain, a missing
    // browser and a timeout all mean the runner demonstrably RAN.
    const spawnFailed = classifyCommandRun(ran({failedToStart: true, status: null}))
    expect(spawnFailed.outcome === 'gap' && spawnFailed.gap === 'spawn-failed').toBe(true)
    for (const run of [ran({status: null}), ran({status: 127, stderr: 'not found'})]) {
        const v = classifyCommandRun(run)
        expect(v.outcome === 'gap' && v.gap === 'spawn-failed').toBe(false)
    }
})

describe('infrastructure is opt-in per command, not global', () => {
    const dbDown = ran({status: 1, stderr: 'Error: connect ECONNREFUSED 127.0.0.1:5432'})

    test('a launch script that opted in treats an unreachable database as a gap', () => {
        const v = classifyCommandRun(dbDown, [INFRA_GAP_OUTPUT_RE])
        expect(v.outcome).toBe('gap')
        expect(v.outcome === 'gap' && v.gap).toBe('infrastructure')
    })

    test('the SAME output out of an ordinary test run is a real failure', () => {
        // The reason this is a parameter and not a boolean: a migrate/seed against
        // no DB is an environment gap on this box, but a `test` run that cannot
        // reach its database is a failure the suite must own.
        expect(classifyCommandRun(dbDown).outcome).toBe('fail')
    })
})

test('a PASSING command that merely mentions a gap shape is still a pass', () => {
    // Gap patterns describe output, and passing output can legitimately talk about
    // databases and browsers ("skipping: browsers are not installed").
    const v = classifyCommandRun(
        ran({status: 0, stdout: 'note: browsers are not installed, skipped 2 suites'}),
        [INFRA_GAP_OUTPUT_RE]
    )
    expect(v).toEqual({outcome: 'pass'})
})

test('gap precedence: the most specific cause wins', () => {
    // A killed child whose partial output happens to look like a missing browser
    // is reported as killed — it never finished, so its output proves nothing.
    const v = classifyCommandRun(ran({status: null, stderr: "Executable doesn't exist"}))
    expect(v.outcome === 'gap' && v.gap).toBe('killed')
})

// A test runner that found nothing to run observed nothing. The same words in a
// lint report are the report, so only a test command may claim this row.
describe('an empty suite is a gap only when a test command says it', () => {
    test.each([
        'error: 0 test files matching **{.test,.spec}.{js,ts}',
        'No tests found, exiting with code 1',
        'No test files found, exiting with code 1',
        'no tests ran in 0.01s'
    ])('%s', out => {
        const run = ran({status: 1, stderr: out})
        expect(classifyCommandRun(run, [], {emptySuite: true})).toMatchObject({
            outcome: 'gap',
            gap: 'empty-suite'
        })
        expect(classifyCommandRun(run).outcome).toBe('fail')
    })
})

// A monorepo suite runs every package: one that has no tests prints the phrase,
// and a real failure elsewhere in the same run must still fail.
describe('an empty-suite phrase beside tests that ran is not a gap', () => {
    test.each([
        'packages/a: No tests found, exiting with code 1\npackages/b:\n 3 pass\n 1 fail',
        'No tests found\nTests:       1 failed, 3 passed, 4 total',
        'No test files found\n Tests  1 failed | 3 passed (4)',
        'no tests ran in 0.01s\n1 failing',
        'no tests ran\n--- FAIL: TestParse (0.00s)'
    ])('%s', out => {
        expect(
            classifyCommandRun(ran({status: 1, stdout: out}), [], {emptySuite: true})
        ).toMatchObject({
            outcome: 'fail'
        })
    })
})

// Real runs of eleven runners, one passing and one failing test each, and three
// green runs that exit 0 while mentioning failure (see the fixture's header).
const reports = JSON.parse(
    readFileSync(path.join(import.meta.dir, '__fixtures__/runner-reports.json'), 'utf8')
) as {
    runners: Array<{runner: string; failing: RunnerRun; passing: RunnerRun}>
    greenExitZero: Array<RunnerRun & {what: string}>
}
interface RunnerRun {
    status: number
    stdout: string
    stderr: string
}

// mx5-n TASK_0012: `"test": "AGENT=1 bun test; test $? -le 1 && …"` exits 0 over a
// failing bun suite, and the gate called the suite green.
describe("a clean exit is not a pass when the runner's own report says tests failed", () => {
    test.each(reports.runners.map(r => [r.runner, r] as const))('%s', (_runner, r) => {
        expect(r.failing.status).not.toBe(0)
        const swallowed = ran({stdout: r.failing.stdout, stderr: r.failing.stderr})
        expect(classifyCommandRun(swallowed)).toMatchObject({outcome: 'fail', status: 0})
        const green = ran({stdout: r.passing.stdout, stderr: r.passing.stderr})
        expect(classifyCommandRun(green)).toEqual({outcome: 'pass'})
    })

    test.each(reports.greenExitZero.map(g => [g.what, g] as const))(
        '%s stays a pass',
        (_what, g) => {
            expect(g.status).toBe(0)
            expect(classifyCommandRun(ran({stdout: g.stdout, stderr: g.stderr}))).toEqual({
                outcome: 'pass'
            })
        }
    )

    test('the verdict quotes the report line, so the reason is not "exited 0"', () => {
        const bun = reports.runners.find(r => r.runner === 'bun')!.failing
        expect(classifyCommandRun(ran({stdout: bun.stdout, stderr: bun.stderr}))).toMatchObject({
            outcome: 'fail',
            status: 0,
            report: '1 fail'
        })
    })

    test('a non-zero exit keeps its own status', () => {
        const bun = reports.runners.find(r => r.runner === 'bun')!.failing
        expect(classifyCommandRun(ran({status: 1, stderr: bun.stderr}))).toMatchObject({
            outcome: 'fail',
            status: 1
        })
    })
})

describe('outputTail', () => {
    test('joins stdout and stderr onto one line', () => {
        expect(outputTail('out', 'err')).toBe('out err')
    })

    test('empty output is empty, not whitespace', () => {
        expect(outputTail('', '')).toBe('')
    })

    test('long output is truncated from the FRONT, marked with an ellipsis', () => {
        const tail = outputTail('x'.repeat(500), '', 100)
        expect(tail.startsWith('…')).toBe(true)
        expect(tail.length).toBe(101)
    })
})
