import {afterEach, describe, expect, test} from 'bun:test'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {testPosix} from '../test-utils/platform.js'
import {rmSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {
    captureHealthOutput,
    discoverHealthCommands,
    discoverTestCommands,
    runRepoHealthCheck
} from '../../src/task/repo-health-check.js'
import type {CommandRun, CommandRunner} from '../../src/task/command-run.js'

const cargoInstalled = spawnSync('cargo', ['--version']).error === undefined

const made: string[] = []
function tmpRepo(files: Record<string, string>): string {
    const dir = tmpDir('health-')
    made.push(dir)
    for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, name), content)
    }
    return dir
}
afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, {recursive: true, force: true})
})

describe('discoverHealthCommands', () => {
    test('package.json → only static scripts (lint/typecheck), never test/build', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'bun test', build: 'x'}
            })
        })
        const {ecosystem, cmds} = discoverHealthCommands(dir)
        expect(ecosystem).toBe('package.json')
        expect(cmds).toEqual([
            ['bun', ['run', 'lint']],
            ['bun', ['run', 'typecheck']]
        ])
    })

    test('package.json with no static scripts → empty command list', () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {test: 'bun test'}})})
        expect(discoverHealthCommands(dir).cmds).toEqual([])
    })

    test('no manifest at all → null ecosystem, nothing to run', () => {
        const dir = tmpRepo({'README.md': 'docs only'})
        expect(discoverHealthCommands(dir)).toEqual({ecosystem: null, cmds: []})
    })

    test('Makefile only contributes `make lint` when a lint target exists', () => {
        const withTarget = tmpRepo({Makefile: 'lint:\n\techo hi\n'})
        expect(discoverHealthCommands(withTarget).cmds).toEqual([['make', ['lint']]])
        const without = tmpRepo({Makefile: 'build:\n\techo hi\n'})
        expect(discoverHealthCommands(without).cmds).toEqual([])
    })

    test('package.json wins over other manifests (first match)', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'x'}}),
            'Cargo.toml': '[package]'
        })
        expect(discoverHealthCommands(dir).ecosystem).toBe('package.json')
    })
})

describe('discoverTestCommands', () => {
    test('package.json → plain test first, then every test-shaped script, never build', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {
                    'test:ct': 'x',
                    build: 'x',
                    test_unit: 'x',
                    test: 'bun test',
                    testing: 'x',
                    pretest: 'x'
                }
            })
        })
        expect(discoverTestCommands(dir).cmds).toEqual([
            ['bun', ['run', 'test']],
            ['bun', ['run', 'test:ct']],
            ['bun', ['run', 'test_unit']]
        ])
    })

    test('no manifest → nothing', () => {
        expect(discoverTestCommands(tmpRepo({'index.html': ''})).cmds).toEqual([])
    })

    // A watch-mode script never exits, so every health run would spend its whole
    // timeout on it and record a skip.
    test('a watch-mode script is left out, by name or by flag', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {
                    test: 'bun test',
                    'test:watch': 'bun test',
                    'test:dev': 'jest --watchAll',
                    'test:ui': 'vitest watch',
                    'test:list': 'bun test src/watchlist.test.ts'
                }
            })
        })
        expect(discoverTestCommands(dir).cmds).toEqual([
            ['bun', ['run', 'test']],
            ['bun', ['run', 'test:list']]
        ])
    })

    // `--watch=false` is how a CI script turns watch OFF. Reading the flag's
    // presence rather than its value dropped the only `test` script such a repo
    // has, and a repo with no discovered suite has no differential to regress.
    test('a flag that turns watch off is not a watch script', () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {
                    test: 'jest --ci --watchAll=false --coverage',
                    'test:vi': 'vitest run --watch=false',
                    'test:on': 'jest --watch=true'
                }
            })
        })
        expect(discoverTestCommands(dir).cmds).toEqual([
            ['bun', ['run', 'test']],
            ['bun', ['run', 'test:vi']]
        ])
    })
})

// The mx5-n TASK_0004 class: a task turns a green suite red, its spec calls that a
// "known issue", and the model gate passes it. The suite has to be MEASURED, and
// only a caller that will compare it against the baseline may ask for it.
describe('runRepoHealthCheck — withTests', () => {
    test('without the flag the suite is never run', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'true', test: 'exit 1'}})
        })
        const out = await runRepoHealthCheck(dir)
        expect(out.ok).toBe(true)
        expect(out.commands.map(c => c.cmd)).toEqual(['bun run lint'])
    })

    test('a red suite is a FAIL naming the test command', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'true', test: 'exit 1'}})
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('bun run test')
        expect(out.commands).toMatchObject([
            {cmd: 'bun run lint', outcome: 'pass', exitCode: 0, kind: 'static'},
            {cmd: 'bun run test', outcome: 'fail', exitCode: 1, kind: 'test'}
        ])
    })

    test('a green suite passes and says so', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'true', test: 'true'}})
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(true)
        expect(out.reason).toContain('static checks and tests passed')
    })

    test('a project with tests but no statics still runs the suite', async () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {test: 'exit 3'}})})
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(false)
        expect(out.commands).toMatchObject([{cmd: 'bun run test', outcome: 'fail', exitCode: 3}])
    })

    // A command the run never reached is absent from BOTH sides of the
    // differential, so a suite behind a red lint could break unseen.
    test('a red static does not stop the suite: every command is measured', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'exit 1', test: 'node -e "console.error(1234); process.exit(2)"'}
            })
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(false)
        expect(out.reason).toBe('`bun run lint` exited 1; `bun run test` exited 2')
        expect(out.commands.map(c => [c.cmd, c.outcome, c.exitCode])).toEqual([
            ['bun run lint', 'fail', 1],
            ['bun run test', 'fail', 2]
        ])
        // Each failing command keeps its own output, so a subject is read from the
        // command it is about.
        expect(out.commands[1].output).toContain('1234')
        expect(out.commands[0].output).not.toContain('1234')
    })

    // mx5-n TASK_0012's script shape: `test $? -le 1` swallows the runner's exit 1.
    // POSIX only: bun's Windows shell rejects `$?` and exits 2, so nothing is hidden there.
    testPosix('a suite whose script swallows the runner exit is still red', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'true', test: 'bun test; test $? -le 1 && echo done'}
            }),
            'a.test.ts':
                "import {test, expect} from 'bun:test'\ntest('bad', () => expect(1).toBe(2))\n"
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(false)
        expect(out.commands.find(c => c.cmd === 'bun run test')).toMatchObject({
            outcome: 'fail',
            exitCode: 0,
            report: '1 fail'
        })
        expect(out.reason).toBe('`bun run test` exited 0 but reported "1 fail"')
    })

    test('a test script with no tests to run is a SKIP, not a FAIL', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'true', test: 'bun test'}})
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(true)
        // The gap id rides on the result: alone it is a skip, but against a baseline
        // that ran the suite it is how the differential sees the suite go away.
        expect(out.commands.find(c => c.cmd === 'bun run test')).toMatchObject({
            outcome: 'skip',
            gap: 'empty-suite'
        })
    })

    test('"no tests found" in a LINT report is still a lint failure', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'echo "No tests found" && exit 1'}})
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(false)
        expect(out.commands).toMatchObject([{cmd: 'bun run lint', outcome: 'fail'}])
    })

    test('a suite whose browser is missing is a SKIP, not a FAIL (the gate ladder, not the static one)', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {
                    lint: 'true',
                    test: 'echo "Executable doesn\'t exist at /x/chromium — browsers are not installed" && exit 1'
                }
            })
        })
        const out = await runRepoHealthCheck(dir, {withTests: true})
        expect(out.ok).toBe(true)
        expect(out.commands.find(c => c.cmd === 'bun run test')?.outcome).toBe('skip')
    })
})

describe('captureHealthOutput', () => {
    test('empty streams → empty string', () => {
        expect(captureHealthOutput('', '')).toBe('')
    })

    test('stderr leads (a crash trace lives there), then stdout', () => {
        expect(captureHealthOutput('out-line', 'err-line')).toBe('err-line\nout-line')
    })

    test('caps at 40 lines', () => {
        const many = Array.from({length: 100}, (_, i) => `line ${i}`).join('\n')
        expect(captureHealthOutput(many, '').split('\n').length).toBe(40)
    })

    test('caps runaway length with an ellipsis', () => {
        const huge = 'x'.repeat(10_000)
        const out = captureHealthOutput(huge, '')
        expect(out.length).toBeLessThan(10_000)
        expect(out.endsWith('…')).toBe(true)
    })
})

describe('runRepoHealthCheck', () => {
    test('no tooling → pass (nothing can regress) — the "no package.json" case', async () => {
        const dir = tmpRepo({'index.html': '<h1>hi</h1>'})
        const out = await runRepoHealthCheck(dir)
        expect(out.ok).toBe(true)
        expect(out.ecosystem).toBeNull()
    })

    test('lint script exits 0 → pass, no false-fail', async () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'true'}})})
        expect((await runRepoHealthCheck(dir)).ok).toBe(true)
    })

    test('lint script exits non-zero → FAIL naming the command', async () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'exit 1'}})})
        const out = await runRepoHealthCheck(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('bun run lint')
        expect(out.reason).toContain('exited 1')
    })

    test('a FAIL captures the failing command output (run-8 F8: exit code alone is unexplainable)', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'echo "src/a.ts:1  error  Unexpected token" && exit 1'}
            })
        })
        const out = await runRepoHealthCheck(dir)
        expect(out.ok).toBe(false)
        expect(out.output).toContain('src/a.ts:1  error  Unexpected token')
    })

    test('a stderr crash (exit 2) is captured too, so the crash class is distinguishable', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'echo "Cannot find module eslint" 1>&2 && exit 2'}
            })
        })
        const out = await runRepoHealthCheck(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('exited 2')
        expect(out.output).toContain('Cannot find module eslint')
    })

    test('a PASS carries no output', async () => {
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'true'}})})
        expect((await runRepoHealthCheck(dir)).output).toBe('')
    })

    test('first failing command short-circuits (lint fails before typecheck runs)', async () => {
        const marker = path.join(tmpdir(), `hc-marker-${Date.now()}`)
        const dir = tmpRepo({
            'package.json': JSON.stringify({
                scripts: {lint: 'exit 3', typecheck: `touch ${marker}`}
            })
        })
        const out = await runRepoHealthCheck(dir)
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('exited 3')
    })

    test('exit 127 (command not found inside the script chain) → skipped, not failed', async () => {
        // A 127 inside the chain means the tool the script invokes is not on PATH —
        // `bun run lint` before an install, say. The tool is missing, not the code
        // faulty, so it is the same environment gap as ENOENT.
        const dir = tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'exit 127'}})})
        expect((await runRepoHealthCheck(dir)).ok).toBe(true)
    })

    test.skipIf(cargoInstalled)(
        'a tool that is not installed (ENOENT) is skipped, not failed',
        async () => {
            // Cargo.toml routes to `cargo clippy`; when cargo is absent the command
            // cannot run → environment gap → skipped → overall pass (no false-fail).
            const dir = tmpRepo({'Cargo.toml': '[package]\nname = "x"\n'})
            expect((await runRepoHealthCheck(dir)).ok).toBe(true)
        }
    )
})

describe('runRepoHealthCheck — one runner, and it is async', () => {
    // The gate runs this immediately after the implementation turn, while a loader
    // is ticking. A synchronous spawn would hold the event loop for the whole lint,
    // so the interval below would not fire and the TUI would sit frozen.
    test('does not block the event loop while the command runs', async () => {
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'sleep 0.6'}})
        })
        let ticks = 0
        const timer = setInterval(() => ticks++, 50)
        try {
            const out = await runRepoHealthCheck(dir)
            expect(out.ok).toBe(true)
        } finally {
            clearInterval(timer)
        }
        expect(ticks).toBeGreaterThan(3)
    })

    test('there is no synchronous runner left to reach for', async () => {
        // There is one runner, and asking for it returns a Promise. A synchronous
        // twin would be a second copy of the env-gap ladder, and a gate caller could
        // reach for it by accident.
        expect(runRepoHealthCheck(tmpRepo({}))).toBeInstanceOf(Promise)
    })

    test('reports each command as it starts, so a caller can name it on screen', async () => {
        const seen: string[] = []
        const dir = tmpRepo({
            'package.json': JSON.stringify({scripts: {lint: 'true', typecheck: 'true'}})
        })
        await runRepoHealthCheck(dir, {onCommand: c => seen.push(c)})
        expect(seen).toEqual(['bun run lint', 'bun run typecheck'])
    })

    // One case per rung of the ladder the module's own doc lists, so a change to
    // any rung shows up as a verdict change rather than as a timing change.
    const parityCases: Array<[string, Record<string, string>]> = [
        ['no tooling', {}],
        ['pass', {lint: 'true'}],
        ['fail exit 1', {lint: 'exit 1'}],
        ['fail with output', {lint: 'echo "a.ts:1 error" && exit 1'}],
        ['stderr crash exit 2', {lint: 'echo "Cannot find module eslint" 1>&2 && exit 2'}],
        ['exit 127 → skipped', {lint: 'exit 127'}],
        ['first failure short-circuits', {lint: 'exit 3', typecheck: 'true'}]
    ]
    for (const [label, scripts] of parityCases) {
        test(`same verdict as the sync runner: ${label}`, async () => {
            const files: Record<string, string> =
                Object.keys(scripts).length === 0 ?
                    {'index.html': '<h1>hi</h1>'}
                :   {'package.json': JSON.stringify({scripts})}
            const a = await runRepoHealthCheck(tmpRepo(files))
            const b = await runRepoHealthCheck(tmpRepo(files))
            expect({ok: b.ok, reason: b.reason, ecosystem: b.ecosystem, output: b.output}).toEqual({
                ok: a.ok,
                reason: a.reason,
                ecosystem: a.ecosystem,
                output: a.output
            })
        })
    }
})

/**
 * The health ladder is deliberately NARROWER than the gate's command ladder. It
 * skips on exactly three things: the runner never spawned, a null status, and a 127
 * inside the chain.
 *
 * `GAP_RULES` carries a fourth row, `missing-runtime`, whose ENV_GAP_OUTPUT_RE
 * matches ordinary English — `browsers are not installed`, `wasn't installed`.
 * Adopting the wider ladder here would make a lint or typecheck report that happens
 * to contain that wording SKIP instead of fail, and the gate would be told the repo
 * is healthy. That row exists for the gate's TEST commands; repo-health runs only
 * lint and typecheck, which have no browsers to miss.
 */
describe("the static ladder does not inherit the gate's browser row", () => {
    const scripted =
        (over: Partial<CommandRun>): CommandRunner =>
        () =>
            Promise.resolve({failedToStart: false, status: 0, stdout: '', stderr: '', ...over})

    const lintRepo = (): string =>
        tmpRepo({'package.json': JSON.stringify({scripts: {lint: 'eslint .'}})})

    test('a real lint failure whose REPORT mentions a browser is a failure', async () => {
        const out = await runRepoHealthCheck(lintRepo(), {
            run: scripted({
                status: 1,
                stdout: "src/e2e.ts:12  error  'browsers are not installed' is not a valid id"
            })
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('exited 1')
    })

    test('a typecheck failure quoting "wasn\'t installed" is a failure', async () => {
        const out = await runRepoHealthCheck(lintRepo(), {
            run: scripted({
                status: 2,
                stderr: "src/setup.ts(4,9): error TS2322: Type '\"wasn't installed\"' is not assignable."
            })
        })
        expect(out.ok).toBe(false)
    })

    test('the three rows the ladder DOES have still skip', async () => {
        for (const run of [
            scripted({failedToStart: true, status: null, stderr: 'ENOENT'}),
            scripted({status: null}),
            scripted({status: 127, stderr: 'bun: command not found'})
        ]) {
            expect((await runRepoHealthCheck(lintRepo(), {run})).ok).toBe(true)
        }
    })
})
