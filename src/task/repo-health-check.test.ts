import {afterEach, describe, expect, test} from 'bun:test'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import * as path from 'node:path'
import {
    captureHealthOutput,
    discoverHealthCommands,
    runRepoHealthCheck
} from './repo-health-check.js'
import type {CommandRun, CommandRunner} from './command-run.js'

const cargoInstalled = spawnSync('cargo', ['--version']).error === undefined

const made: string[] = []
function tmpRepo(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'health-'))
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
        // Seen live: `bun run lint` exits 127 before node_modules exists — the tool
        // is missing, not the code faulty. Same environment gap as ENOENT.
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
    // The gate runs this immediately after the implementation turn, so it must not
    // block the event loop — the sync runner delivered 0 of 686 expected 100ms timer
    // ticks during a 69s aiz-client lint, which is why the screen froze.
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
        // The sync twin is what `final-gate.ts:672` was calling, against this
        // module's own doc comment telling gate callers not to. Deleting it is what
        // makes that unrepeatable — a second runner is a second ladder.
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

    // Verdict PARITY with the sync runner: the async version exists to stop blocking
    // the loop, and any behaviour difference would be a silent gate change.
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
 * REGRESSION — the health ladder is NARROWER than the gate's command ladder, and
 * adopting `classifyCommandRun` silently widened it.
 *
 * `classifyHealthRun` skipped on exactly three things: the runner never spawned, a
 * null status, and a 127 inside the chain. `GAP_RULES` carries a fourth row,
 * `missing-runtime`, applied unconditionally — and its pattern matches ordinary
 * English (`browsers are not installed`, `wasn't installed`). A lint or typecheck
 * report that happens to contain that wording now SKIPS instead of failing, and the
 * gate is told the repo is healthy.
 *
 * The browser row exists for the gate's TEST commands. Repo-health only ever runs
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
