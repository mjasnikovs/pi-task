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

// `AGENT=1 bun test && playwright test` before the first component test exists,
// captured from mx5-n: the unit half passed and the empty half alone exited 1. The
// same half run alone is the whole-suite gap; chained, it was read as a fail, and a
// repair task was queued for a suite with nothing wrong in it.
describe('an empty part beside tests that all passed is a gap of its own', () => {
    const chained = ran({
        status: 1,
        stdout: 'bun test v1.3.14 (0d9b296a)\nError: No tests found\n\n',
        stderr:
            '$ AGENT=1 bun test && playwright test -c playwright-ct.config.ts\n\n 45 pass\n 0 fail\n'
            + ' 65 expect() calls\nRan 45 tests across 1 file. [35.00ms]\n'
            + 'error: script "test" exited with code 1\n'
    })

    test('a test command: part-empty-suite, not a fail', () => {
        expect(classifyCommandRun(chained, [], {emptySuite: true})).toMatchObject({
            outcome: 'gap',
            gap: 'part-empty-suite'
        })
    })

    test('a static command may not claim it', () => {
        expect(classifyCommandRun(chained).outcome).toBe('fail')
    })

    test.each([
        ['a runner row', 'No tests found\n 3 pass\n 1 fail'],
        ['an error count', 'No tests found\n 3 pass\n 0 fail\n 1 error'],
        ['a linter in the chain', 'No tests found\n 3 pass\n✖ 2 problems (2 errors, 0 warnings)'],
        ['a colour code glued to the count', 'No tests found\n 3 pass\n\x1b[31m1 fail\x1b[0m'],
        ['a build step that prints no count', 'No tests found\n 3 pass\nerror during build:'],
        [
            'eslint over its warning budget',
            'No tests found\n 3 pass\n✖ 3 problems (0 errors, 3 warnings)'
        ],
        ['a compiler error line', "No tests found\n 3 pass\nsrc/a.ts(1,7): error TS2322: Type 'x'"]
    ])('any failure beside it keeps the fail: %s', (_what, out) => {
        expect(
            classifyCommandRun(ran({status: 1, stdout: out}), [], {emptySuite: true}).outcome
        ).toBe('fail')
    })
})

// Real runs of each runner, one passing and one failing test each, and green runs
// that exit 0 while mentioning failure (see the fixture's header).
const reports = JSON.parse(
    readFileSync(path.join(import.meta.dir, '__fixtures__/runner-reports.json'), 'utf8')
) as {
    runners: Array<{runner: string; failing: RunnerRun; passing: RunnerRun}>
    greenExitZero: Array<RunnerRun & {what: string}>
    variants: Array<{what: string; failing: RunnerRun; passing?: RunnerRun}>
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

    // Each is a runner's other way of reporting a red run: a suite-level error, a
    // step, a reporter or flag that reshapes the summary.
    test.each(reports.variants.map(v => [v.what, v] as const))('%s', (_what, v) => {
        expect(v.failing.status).not.toBe(0)
        const swallowed = ran({stdout: v.failing.stdout, stderr: v.failing.stderr})
        expect(classifyCommandRun(swallowed)).toMatchObject({outcome: 'fail', status: 0})
        if (v.passing === undefined) return
        const green = ran({stdout: v.passing.stdout, stderr: v.passing.stderr})
        expect(classifyCommandRun(green)).toEqual({outcome: 'pass'})
    })

    test('a summary is one line: a count on the next line is not its count', () => {
        expect(classifyCommandRun(ran({stdout: 'Tests:\n  2 failed to parse\n'}))).toEqual({
            outcome: 'pass'
        })
    })

    // A tested CLI or a logger can print node's failed-test shape on a green run.
    test("a ✖ line outside node's dot report is not a report", () => {
        expect(classifyCommandRun(ran({stdout: 'fixtures\n✖ rejects bad input (3ms)\n'}))).toEqual({
            outcome: 'pass'
        })
    })

    test('a node dot report piped through a CRLF writer still reads as failed', () => {
        const dot = reports.variants.find(v => v.what === 'node:test dot reporter')!.failing
        const stdout = dot.stdout.replace(/\n/g, '\r\n')
        expect(classifyCommandRun(ran({stdout}))).toMatchObject({outcome: 'fail', status: 0})
    })

    test('the verdict quotes a failed test by its whole name', () => {
        const multi = reports.variants.find(v => v.what.endsWith('a test name over two lines'))!
        expect(classifyCommandRun(ran({stdout: multi.failing.stdout}))).toMatchObject({
            report: '✖ multi line (0.18323ms)'
        })
    })

    test('the verdict quotes the failed test, not a todo listed before it', () => {
        const todoFirst = reports.variants.find(v => v.what.endsWith('both named over two lines'))!
        expect(classifyCommandRun(ran({stdout: todoFirst.failing.stdout}))).toMatchObject({
            report: '✖ bad name (0.100229ms)'
        })
    })

    test('a test name line that starts with a space is still part of the name', () => {
        const spaced = reports.variants.find(v =>
            v.what.endsWith('second line starts with a space')
        )!
        expect(classifyCommandRun(ran({stdout: spaced.failing.stdout}))).toMatchObject({
            report: '✖ a b (0.57739ms)'
        })
    })

    test('a test name line that starts with two spaces is still part of the name', () => {
        const spaced = reports.variants.find(v => v.what.endsWith('starts with two spaces'))!
        expect(classifyCommandRun(ran({stdout: spaced.failing.stdout}))).toMatchObject({
            report: '✖ a b (0.560859ms)'
        })
    })

    test('a test name line over an indented line and a ✖ line is still part of the name', () => {
        const crossed = reports.variants.find(v =>
            v.what.endsWith('a test name over an indented line and a ✖ line')
        )!
        expect(classifyCommandRun(ran({stdout: crossed.failing.stdout}))).toMatchObject({
            report: '✖ a b ✖ c (0.58892ms)'
        })
    })

    test('the verdict quotes the failed test after a todo named over a ✖ line', () => {
        const todoFirst = reports.variants.find(v =>
            v.what.endsWith('a todo named over an indented line and a ✖ line')
        )!
        expect(classifyCommandRun(ran({stdout: todoFirst.failing.stdout}))).toMatchObject({
            report: '✖ d (0.11967ms)'
        })
    })

    // node prints nothing after the list, so the next command's output follows it directly.
    test.each([
        '✖ 1 task skipped\n',
        '✖ lint step skipped\n  see docs\n',
        '✖ 3 problems (0 errors, 3 warnings)\n  0 errors and 3 warnings potentially fixable\n\n    ✔ does things (123ms)\n    ✔ more\n'
    ])("a ✖ line printed right after node's dot report is not a failed test: %j", after => {
        const todo = reports.greenExitZero.find(
            g => g.what === 'node:test dot reporter, a failing todo test'
        )!
        const stdout = `${todo.stdout}${after}`
        expect(classifyCommandRun(ran({stdout}))).toEqual({outcome: 'pass'})
    })

    test("a ✖ line on stderr is not a failed test in node's dot report on stdout", () => {
        const todo = reports.greenExitZero.find(
            g => g.what === 'node:test dot reporter, a failing todo test'
        )!
        const stderr = '✖ lint warn\n  slow rule (12ms)\n'
        expect(classifyCommandRun(ran({stdout: todo.stdout, stderr}))).toEqual({outcome: 'pass'})
    })

    test("a ✖ line between two green dot reports does not take the second one's todo", () => {
        const todo = reports.greenExitZero.find(
            g => g.what === 'node:test dot reporter, a failing todo test'
        )!
        const stdout = `${todo.stdout}✖ 1 task skipped\n${todo.stdout}`
        expect(classifyCommandRun(ran({stdout}))).toEqual({outcome: 'pass'})
    })

    test('a failed test in a second dot report after a green one still reads as failed', () => {
        const todo = reports.greenExitZero.find(
            g => g.what === 'node:test dot reporter, a failing todo test'
        )!
        const dot = reports.variants.find(v => v.what === 'node:test dot reporter')!.failing
        expect(classifyCommandRun(ran({stdout: `${todo.stdout}${dot.stdout}`}))).toMatchObject({
            report: '✖ bad (0.59335ms)'
        })
    })

    test('the quoted report is bounded like the tail', () => {
        const name = `x\n\n${'x'.repeat(1_000_000)}`
        const stdout = `X\n\nFailed tests:\n\n✖ ${name} (1ms)\n  Error: x\n`
        expect(classifyCommandRun(ran({stdout}))).toMatchObject({
            report: `✖ x ${'x'.repeat(396)}…`
        })
    })

    test('a bounded report never ends in half a character', () => {
        const stdout = `X\n\nFailed tests:\n\n✖ ${'x'.repeat(397)}${'😀'.repeat(10)} (1ms)\n  Error: x\n`
        expect(classifyCommandRun(ran({stdout}))).toMatchObject({
            report: `✖ ${'x'.repeat(397)}…`
        })
    })

    // The rows are read on every clean exit, so their cost must not grow with the
    // square of the output: blank padding is ordinary in test logs.
    test('a long run of blank lines is read in linear time', () => {
        const stdout = `x\n${'   \n'.repeat(100_000)}done\n`
        expect(classifyCommandRun(ran({stdout}))).toEqual({outcome: 'pass'})
    })

    // A regex scan of the list gives up silently past JavaScriptCore's backtrack limit.
    test('a failed test after a todo report of any length is still read', () => {
        const stdout = `XX\n\nFailed tests:\n\n⚠ later # TODO\n${'  \n'.repeat(1_100_000)}✖ real (1ms)\n  Error: x\n`
        expect(classifyCommandRun(ran({stdout}))).toMatchObject({outcome: 'fail', status: 0})
    })

    test('repeated headings are read in linear time', () => {
        const stdout = `${'Failed tests:\n\n✖ stray\n'.repeat(300_000)}X\n\nFailed tests:\n\n✖ real (1ms)\n  Error: x\n`
        expect(classifyCommandRun(ran({stdout}))).toMatchObject({outcome: 'fail', status: 0})
    })
})

describe('outputTail', () => {
    test('joins stdout and stderr onto one line', () => {
        expect(outputTail('out', 'err')).toBe('out err')
    })

    test('empty output is empty, not whitespace', () => {
        expect(outputTail('', '')).toBe('')
    })

    test('a truncated tail never starts in half a character', () => {
        const tail = outputTail(`${'😀'.repeat(10)}x`, '', 4)
        expect(tail).toBe('…😀x')
    })

    test('long output is truncated from the FRONT, marked with an ellipsis', () => {
        const tail = outputTail('x'.repeat(500), '', 100)
        expect(tail.startsWith('…')).toBe(true)
        expect(tail.length).toBe(101)
    })
})
