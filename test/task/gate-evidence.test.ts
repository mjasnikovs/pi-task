/**
 * gate-evidence tests — the project's own checks run ONCE per tree, and never a
 * command that does not return.
 *
 * The run this came from spent 2755 s re-running the same suites inside gate
 * children, one session seven times over a tree that changed twice. So the
 * invocation COUNT is the assertion here, taken from a spy runner through the real
 * wiring (`buildVerifyProbes` → `RunContext.gateEvidenceFor` → `runGateEvidence`):
 * a second gate child on an unchanged tree must spawn nothing, and a tree that
 * moved must cost exactly one re-run.
 *
 * The other two properties are structural: a `serve` command is never launched (the
 * parent has nothing to kill a dev server with), and the output files land OUTSIDE
 * the worktree, where the git-state guard that restores the tree around every gate
 * child cannot reach them.
 */
import {afterEach, describe, expect, test} from 'bun:test'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {getConfig} from '../../src/config/config.js'
import {buildVerifyProbes, gateRepoHealth} from '../../src/task/gate-deps.js'
import {evidenceDir, runGateEvidence} from '../../src/task/gate-evidence.js'
import type {CommandRun, CommandRunner, CommandSpec} from '../../src/task/command-run.js'
import {
    checkIdentity,
    closeRunContext,
    openRunContext,
    NOT_RUN,
    type RunContext,
    type ToolingVerdict
} from '../../src/task/run-context.js'
import {buildVerifyPrompt} from '../../src/task/verify-work.js'
import {tmpDir} from '../test-utils/tmp-dir.js'
import {withTmpTaskDir} from '../test-utils/tmp-task-dir.js'

const savedXdg = process.env.XDG_STATE_HOME

afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = savedXdg
})

/** A runner that records the shell line it was asked to spawn. */
function spyRunner(reply: (line: string) => Partial<CommandRun> = () => ({})): {
    lines: string[]
    run: CommandRunner
} {
    const lines: string[] = []
    const run = (spec: CommandSpec): Promise<CommandRun> => {
        const line = spec.args[1] ?? ''
        lines.push(line)
        return Promise.resolve({
            failedToStart: false,
            status: 0,
            stdout: '',
            stderr: '',
            ...reply(line)
        })
    }
    return {lines, run}
}

/** A git repo (treeHash needs one) that is also this run's open context. */
async function withRun(
    verdicts: ToolingVerdict[],
    fn: (cwd: string, rc: RunContext) => Promise<void>
): Promise<void> {
    await withTmpTaskDir(async cwd => {
        process.env.XDG_STATE_HOME = tmpDir('gate-evidence-state-')
        spawnSync('git', ['init', '-q'], {cwd})
        fs.writeFileSync(path.join(cwd, 'src.ts'), 'export const a = 1\n')
        const rc = openRunContext(cwd)
        try {
            await rc.verifiedToolingFor(
                'TASK_0001',
                verdicts.map(v => v.cmd),
                () => Promise.resolve({verified: verdicts, rejected: []})
            )
            await fn(cwd, rc)
        } finally {
            closeRunContext(rc)
        }
    })
}

/** One gate session's evidence, through the wiring the gate itself uses. */
const evidenceOf = (cwd: string, run: CommandRunner): Promise<string[]> =>
    buildVerifyProbes({cwd, taskId: 'TASK_0001', spec: null, run}).evidence!()

const LINT: ToolingVerdict = {cmd: 'bun run lint', class: 'check'}
const BUILD: ToolingVerdict = {cmd: 'bun run build', class: 'build'}
const DEV: ToolingVerdict = {cmd: 'bun run dev', class: 'serve'}

describe('one run per tree', () => {
    test('two gate sessions on an unchanged tree run each command once', async () => {
        await withRun([LINT, BUILD], async cwd => {
            const {lines, run} = spyRunner()
            const first = await evidenceOf(cwd, run)
            const second = await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run build'])
            expect(second).toEqual(first)
        })
    })

    test('a tree change costs exactly one re-run', async () => {
        await withRun([LINT], async cwd => {
            const {lines, run} = spyRunner()
            await evidenceOf(cwd, run)
            // What a lint-fix or an autofix does between two gate sessions.
            fs.writeFileSync(path.join(cwd, 'src.ts'), 'export const a = 2\n')
            await evidenceOf(cwd, run)
            await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run lint'])
        })
    })

    test('two children asking at once still spawn one suite', async () => {
        await withRun([LINT], async cwd => {
            const {lines, run} = spyRunner()
            await Promise.all([evidenceOf(cwd, run), evidenceOf(cwd, run)])
            expect(lines).toEqual(['bun run lint'])
        })
    })

    test('a serve-class command is never launched', async () => {
        await withRun([LINT, DEV, BUILD], async cwd => {
            const {lines, run} = spyRunner()
            const findings = await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run build'])
            expect(findings.join('\n')).not.toContain('bun run dev')
        })
    })

    test('each command names itself while it runs', async () => {
        // The stage runs before the verify child exists, so this line is the only
        // thing on screen for as long as the project's own checks take.
        await withRun([LINT, BUILD], async cwd => {
            const named: string[] = []
            await buildVerifyProbes({
                cwd,
                taskId: 'TASK_0001',
                spec: null,
                run: spyRunner().run,
                onCommand: c => named.push(c)
            }).evidence!()
            expect(named).toEqual(['bun run lint', 'bun run build'])
        })
    })

    test("the real exit code replaces the verdict's NOT_RUN", async () => {
        await withRun([LINT], async (cwd, rc) => {
            expect(rc.verifiedTooling[0].exitCode).toBe(NOT_RUN)
            await evidenceOf(cwd, spyRunner(() => ({status: 2})).run)
            expect(rc.verifiedTooling[0].exitCode).toBe(2)
        })
    })
})

/**
 * The line a spec would run, whichever runner spawned it: evidence hands `sh` the
 * line, the health check hands the resolved runner its argv.
 */
const spawnedLine = (spec: CommandSpec): string =>
    spec.bin === 'sh' ? (spec.args[1] ?? '') : [path.basename(spec.bin), ...spec.args].join(' ')

/** {@link spyRunner}, recording lines from both runners the gate uses. */
function lineSpy(reply: (line: string) => Partial<CommandRun> = () => ({})): {
    lines: string[]
    run: CommandRunner
} {
    const lines: string[] = []
    const run = (spec: CommandSpec): Promise<CommandRun> => {
        const line = spawnedLine(spec)
        lines.push(line)
        return Promise.resolve({
            failedToStart: false,
            status: 0,
            stdout: ' 3 pass\n',
            stderr: '',
            ...reply(line)
        })
    }
    return {lines, run}
}

/** Record `verdicts` as the TOOLING `taskId`'s research verified. */
const verifyFor = (rc: RunContext, verdicts: ToolingVerdict[], taskId = 'TASK_0001') =>
    rc.verifiedToolingFor(
        taskId,
        verdicts.map(v => v.cmd),
        () => Promise.resolve({verified: verdicts, rejected: []})
    )

const SCRIPTS = {lint: 'eslint .', test: 'AGENT=1 bun test'}

/** A run over a project whose manifest declares {@link SCRIPTS}. */
async function withProject(fn: (cwd: string, rc: RunContext) => Promise<void>): Promise<void> {
    await withRun([], async (cwd, rc) => {
        fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({scripts: SCRIPTS}))
        await fn(cwd, rc)
    })
}

const TEST: ToolingVerdict = {cmd: 'bun run test', class: 'check'}

describe('one execution per check per tree', () => {
    test('a gate runs the checks its own task named, not every spelling the run has seen', async () => {
        await withProject(async (cwd, rc) => {
            await verifyFor(rc, [{cmd: 'bun test', class: 'check'}], 'TASK_0001')
            await verifyFor(rc, [LINT], 'TASK_0002')
            const {lines, run} = lineSpy()
            await buildVerifyProbes({cwd, taskId: 'TASK_0002', spec: null, run}).evidence!()
            expect(lines).toEqual(['bun run lint'])
        })
    })

    test('a check the health gate just ran on this tree is read, not run again', async () => {
        await withProject(async (cwd, rc) => {
            await verifyFor(rc, [LINT, TEST])
            const {lines, run} = lineSpy()
            await gateRepoHealth(cwd, {run})
            const findings = await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run test'])
            expect(findings).toHaveLength(2)
            expect(findings.every(f => f.includes('exit 0'))).toBe(true)
        })
    })

    test('a script named by its body is the same check', async () => {
        await withProject(async (cwd, rc) => {
            await verifyFor(rc, [{cmd: 'AGENT=1 bun test', class: 'check'}])
            const {lines, run} = lineSpy()
            await gateRepoHealth(cwd, {run})
            await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run test'])
        })
    })

    test('a check that could not run is not handed on as a result', async () => {
        await withProject(async (cwd, rc) => {
            await verifyFor(rc, [TEST])
            const {lines, run} = lineSpy(line =>
                lines.length === 2 ?
                    {status: 127, stdout: '', stderr: `sh: 1: ${line}: not found\n`}
                :   {}
            )
            await gateRepoHealth(cwd, {run})
            await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run test', 'bun run test'])
        })
    })

    test('a tree the health gate did not see is checked again', async () => {
        await withProject(async (cwd, rc) => {
            await verifyFor(rc, [TEST])
            const {lines, run} = lineSpy()
            await gateRepoHealth(cwd, {run})
            fs.writeFileSync(path.join(cwd, 'src.ts'), 'export const a = 2\n')
            await evidenceOf(cwd, run)
            expect(lines).toEqual(['bun run lint', 'bun run test', 'bun run test'])
        })
    })
})

describe('checkIdentity', () => {
    test('a script run by any package manager is its body', () => {
        for (const line of ['bun run test', 'npm run test', 'pnpm test', 'yarn  test'])
            expect(checkIdentity(line, SCRIPTS)).toBe('AGENT=1 bun test')
    })

    test('trailing arguments follow the body', () => {
        expect(checkIdentity('bun run test --bail', SCRIPTS)).toBe('AGENT=1 bun test --bail')
    })

    test("`bun test` is bun's runner, not the test script", () => {
        expect(checkIdentity('bun test', SCRIPTS)).toBe('bun test')
    })

    test('a line naming no script is its own identity', () => {
        expect(checkIdentity('bun run tsc --noEmit', SCRIPTS)).toBe('bun run tsc --noEmit')
        expect(checkIdentity('npx  tsc --noEmit', SCRIPTS)).toBe('npx tsc --noEmit')
    })
})

describe('what the child is handed', () => {
    test('each command reports its exit code and a readable output path', async () => {
        await withRun([LINT], async (cwd, rc) => {
            const {run} = spyRunner(() => ({status: 1, stdout: 'src.ts:3 no-unused-vars\n'}))
            const findings = await evidenceOf(cwd, run)
            const out = path.join(evidenceDir(cwd, rc.runId), '1.out')
            expect(findings).toEqual([`\`bun run lint\` — exit 1 — full output: ${out}`])
            expect(fs.readFileSync(out, 'utf8')).toContain('src.ts:3 no-unused-vars')

            const prompt = buildVerifyPrompt('GOAL\nx', {evidence: findings})
            expect(prompt).toContain('EVIDENCE (deterministic, run by the orchestrator')
            expect(prompt).toContain(out)
            // Rule 1 moves with the evidence, or the numbered instruction tells the
            // child to re-run exactly what the block above it just reported.
            expect(prompt).toContain('have ALREADY BEEN RUN against this')
            expect(prompt).toContain('TARGETED')
            expect(prompt).not.toContain("1. Run the project's OWN commands")
        })
    })

    test('a command absent on this machine renders as skipped, not failed', async () => {
        await withRun([{cmd: 'cargo clippy', class: 'check'}], async cwd => {
            const {run} = spyRunner(() => ({
                status: 127,
                stderr: 'sh: line 1: cargo: command not found\n'
            }))
            const findings = await evidenceOf(cwd, run)
            expect(findings[0]).toContain('SKIPPED (command not found (127))')
            expect(findings[0]).not.toContain('exit 127')
            expect(buildVerifyPrompt('GOAL\nx', {evidence: findings})).toContain(
                'SKIPPED (command not found (127))'
            )
        })
    })

    test('without evidence the child is told to run the commands itself', async () => {
        const prompt = buildVerifyPrompt('GOAL\nx')
        expect(prompt).toContain("1. Run the project's OWN commands")
        expect(prompt).not.toContain('EVIDENCE (deterministic')
    })

    test('the output files live outside the worktree the git-state guard restores', async () => {
        await withRun([LINT], async (cwd, rc) => {
            await evidenceOf(cwd, spyRunner().run)
            const dir = evidenceDir(cwd, rc.runId)
            expect(fs.existsSync(path.join(dir, '1.out'))).toBe(true)
            expect(path.relative(cwd, dir).startsWith('..')).toBe(true)
        })
    })

    test('a project with no verified check or build command writes nothing at all', async () => {
        await withRun([DEV], async (cwd, rc) => {
            const {lines, run} = spyRunner()
            expect(await evidenceOf(cwd, run)).toEqual([])
            expect(lines).toEqual([])
            expect(fs.existsSync(evidenceDir(cwd, rc.runId))).toBe(false)
        })
    })
})

describe('runGateEvidence on its own', () => {
    test('a runner that cannot be resolved is a gap, not a verdict', async () => {
        await withTmpTaskDir(async cwd => {
            process.env.XDG_STATE_HOME = tmpDir('gate-evidence-state-')
            const evidence = await runGateEvidence({
                cwd,
                runId: 'r1',
                commands: [
                    {
                        cmd: 'bun run lint',
                        cwd,
                        class: 'check',
                        exitCode: NOT_RUN,
                        verifiedAt: 0,
                        manifestHash: 'h'
                    }
                ],
                treeHash: null,
                // The ceiling the gate wiring passes; this spy never consults it.
                timeoutMs: getConfig().requestTimeoutMs,
                run: () =>
                    Promise.resolve({
                        failedToStart: true,
                        failureMessage: 'spawn sh ENOENT',
                        status: null,
                        stdout: '',
                        stderr: ''
                    })
            })
            expect(evidence.commands[0].exitCode).toBe(NOT_RUN)
            expect(evidence.commands[0].gap).toContain('runner did not spawn')
            expect(evidence.commands[0].treeHash).toBeNull()
            expect(fs.readFileSync(evidence.commands[0].outputPath, 'utf8')).toContain('skipped —')
        })
    })
})
