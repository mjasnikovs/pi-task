/**
 * gate-evidence — the project's own check and build commands, run ONCE per tree by
 * the parent, so a gate child reads a result instead of producing one.
 *
 * The failure this closes: the verify child is told to run the project's own
 * commands; so is the lint-fix child after it; so is the verify child after that.
 * One real run spent 2755 s inside gate children re-running the same suites 49
 * times, and a single gate session ran one of them seven times over a tree that
 * changed twice.
 *
 * What makes pre-supplying safe is the CLASS column the run context already holds:
 * `check` and `build` terminate on their own, `serve` does not, and a dev server
 * launched here would hang the gate before the child ever started. So `serve` is
 * never run — the filter lives in `RunContext.gateEvidenceFor`, which owns the
 * verdicts.
 *
 * Nothing observed is nothing claimed. A command that could not run on this machine
 * is recorded SKIPPED with the env-gap ladder's own reason (command-run.ts), never
 * as a failure: the ladder is the single statement of what an ending MEANS, and a
 * second statement of it here would drift from the gate's.
 *
 * The output files live in the run's state dir, OUTSIDE the worktree. The children
 * that read them run under the git-state guard, which restores the tree around
 * them; evidence written into the tree would be reverted between being produced and
 * being read.
 */
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import {
    classifyCommandRun,
    leadingBin,
    reportedSuffix,
    spawnCommand,
    type CommandRunner
} from './command-run.js'
import {resolveRunner, runnerEnv} from './runner-resolve.js'
import {NOT_RUN, type VerifiedCommand} from './run-context.js'
import {stateDir} from './state-dir.js'

/** One command the parent ran for the children, and where its full output went. */
export interface EvidenceCommand {
    cmd: string
    cwd: string
    /** Its real exit code, or {@link NOT_RUN} when `gap` says nothing was observed. */
    exitCode: number
    /** Absolute path — outside the worktree — of the file holding the full output. */
    outputPath: string
    /** The tree it was measured against; null when git could not say (see treeHash). */
    treeHash: string | null
    /** The env-gap ladder's reason nothing was observed. Absent ⇒ the command ran. */
    gap?: string
    /** The runner's failure summary, when it overruled an exit 0. */
    report?: string
}

/** What one gate session hands its children in place of a command to run. */
export interface GateEvidence {
    commands: EvidenceCommand[]
}

export interface EvidenceRunDeps {
    cwd: string
    /** Whose state dir the output files land in. */
    runId: string
    /** Already filtered to the classes that terminate (see RunContext). */
    commands: readonly VerifiedCommand[]
    treeHash: string | null
    /** Per-command ceiling. The same one a gate child's own bash tool gets: a
     *  command pre-run here must not be bounded more tightly than the same command
     *  run by the child, or the child would see a timeout the child cannot reproduce. */
    timeoutMs: number
    signal?: AbortSignal
    /** Called with each command as it STARTS. These are the project's own whole-repo
     *  checks and they run before the child exists, so without a live line naming
     *  the running one the gate's longest stage is also its quietest. */
    onCommand?: (cmd: string) => void
    /** The spawner. Injected so a session's command count is assertable. */
    run?: CommandRunner
}

/** Where a run's evidence output lives. */
export function evidenceDir(cwd: string, runId: string): string {
    return path.join(stateDir(cwd, runId), 'evidence')
}

/** The output file, readable on its own once the session that produced it is gone. */
function evidenceFile(cmd: string, ending: string, stdout: string, stderr: string): string {
    return [`$ ${cmd}`, ending, '', stdout, stderr].join('\n')
}

/**
 * Run each command and write its output to the run's state dir.
 *
 * Sequential: these are the project's own whole-repo checks, and running a
 * typecheck, a build and a test suite at once on the machine the user is working on
 * would make each of them slower and their results less reproducible.
 */
export async function runGateEvidence(deps: EvidenceRunDeps): Promise<GateEvidence> {
    if (deps.commands.length === 0) return {commands: []}
    const dir = evidenceDir(deps.cwd, deps.runId)
    await fsp.mkdir(dir, {recursive: true})
    const run = deps.run ?? spawnCommand
    const commands: EvidenceCommand[] = []
    for (const [i, v] of deps.commands.entries()) {
        const outputPath = path.join(dir, `${i + 1}.out`)
        deps.onCommand?.(v.cmd)
        // A verified command is a SHELL line, not an argv (`bun run lint`, `make -j2
        // build`), so it runs through `sh -c`; its leading word still resolves through
        // runner-resolve, or a login-shell-stripped PATH makes every command a gap.
        const bin = leadingBin(v.cmd)
        const runner = bin === null ? null : resolveRunner(bin)
        const r = await run({
            cwd: v.cwd,
            bin: 'sh',
            args: ['-c', v.cmd],
            label: v.cmd,
            timeoutMs: deps.timeoutMs,
            env: runner ? runnerEnv(runner) : {...process.env},
            ...(deps.signal === undefined ? {} : {signal: deps.signal})
        })
        const verdict = classifyCommandRun(r)
        const gap = verdict.outcome === 'gap' ? verdict.detail : undefined
        const report = verdict.outcome === 'fail' ? verdict.report : undefined
        await fsp.writeFile(
            outputPath,
            evidenceFile(
                r.ranAs ?? v.cmd,
                gap === undefined ?
                    `exit ${r.status}${reportedSuffix({report})}`
                :   `skipped — ${gap}`,
                r.stdout,
                r.stderr
            ),
            'utf8'
        )
        commands.push({
            cmd: v.cmd,
            cwd: v.cwd,
            exitCode: gap === undefined ? (r.status ?? NOT_RUN) : NOT_RUN,
            outputPath,
            treeHash: deps.treeHash,
            ...(gap === undefined ? {} : {gap}),
            ...(report === undefined ? {} : {report})
        })
    }
    return {commands}
}

/** One prompt line per command: what ran, how it ended, and the file the child
 *  reads instead of running it again. */
export function evidenceVerifyFindings(evidence: GateEvidence): string[] {
    return evidence.commands.map(
        c =>
            `\`${c.cmd}\` — ${c.gap === undefined ? `exit ${c.exitCode}${reportedSuffix(c)}` : `SKIPPED (${c.gap})`}`
            + ` — full output: ${c.outputPath}`
    )
}
