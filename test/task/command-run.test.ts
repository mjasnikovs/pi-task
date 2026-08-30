import {test, expect, describe} from 'bun:test'
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
