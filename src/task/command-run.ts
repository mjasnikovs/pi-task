/**
 * command-run — running a project command under the gate's ENV-GAP CONTRACT, and
 * the single statement of what each way of ending means.
 *
 * The contract: a command that never ran tells you nothing about the code. A
 * missing runner, a 127 inside the script chain, a browser binary that was never
 * installed, a database that is not up on this box, a timeout — all of these are
 * facts about the ENVIRONMENT, and none of them may fail a gate or close a debt.
 * Only a command that demonstrably ran and exited non-zero for a reason of its
 * own is a failure, and only exit 0 is a pass.
 *
 * Why a module. That ladder was written three times inside final-gate.ts —
 * `runGateCommand`, `runVerifyCommandLine`, `rerunDebtVerifyCommand` — in the
 * same order with different labels, and the copies had already drifted (the
 * infrastructure pattern applied unconditionally in one and only on request in
 * another). repo-health-check.ts had solved exactly this shape years earlier:
 * `classifyHealthRun` is pure over a value, extracted so its sync and async
 * runners "cannot drift apart". The gate never adopted it.
 *
 * The second half is the seam. Classification is now pure over a `CommandRun`
 * value, and SPAWNING is a `CommandRunner` the caller injects. That is what lets
 * the gate's tests state a case as `{status: 1, stdout: "…"}` instead of writing
 * a real `node -e` child, creating a temp directory for it, and — for the three
 * cases only reachable that way — shadowing a binary on `process.env.PATH` and
 * resetting a module-level cache, which made those tests order-sensitive and
 * needed a Windows carve-out. Note the asymmetry this closes: `BootDeps` already
 * carried nine injectable probes for the gate's boot half while its command half
 * had none.
 */

import {spawnSync} from 'node:child_process'
import {isCommandNotFound, resolveRunner, runnerEnv} from './runner-resolve.js'

/** What one finished command looks like, stripped of how it was spawned. */
export interface CommandRun {
    /** The runner binary itself never started (ENOENT, no POSIX shell). */
    failedToStart: boolean
    /** Why it could not start — only meaningful with `failedToStart`. */
    failureMessage?: string
    /** Exit status, or null when the child was killed (timeout or signal). */
    status: number | null
    stdout: string
    stderr: string
}

/** Everything a runner needs to spawn one command. */
export interface CommandSpec {
    cwd: string
    bin: string
    args: string[]
    timeoutMs: number
    /**
     * Replaces the child's environment wholesale. Passed explicitly because bun's
     * spawnSync resolves the binary against a startup snapshot of the environment
     * rather than the live `process.env`.
     */
    env?: Record<string, string | undefined>
}

/**
 * The injectable half. The gate takes one of these so its tests can script
 * verdicts instead of paying process-spawn cost for every classification case.
 */
export type CommandRunner = (spec: CommandSpec) => CommandRun

/** The real runner. */
export const spawnCommand: CommandRunner = spec => {
    const r = spawnSync(spec.bin, spec.args, {
        cwd: spec.cwd,
        encoding: 'utf8',
        timeout: spec.timeoutMs,
        ...(spec.env ? {env: spec.env} : {})
    })
    return {
        failedToStart: r.error !== undefined && r.error !== null,
        ...(r.error ? {failureMessage: r.error.message} : {}),
        status: r.status,
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? ''
    }
}

/**
 * A non-zero exit whose output shows an EXTERNAL runtime dependency is missing, not
 * a code fault: a browser suite (Playwright/Cypress) whose browser binaries or system
 * libraries were never installed here (mx5 run 10 item 2: `test:ct` must run in the
 * gate, but on a box with no Playwright browsers it is an environment gap, not a FAIL).
 * These exit non-zero (not 127), so they need output-shape recognition to skip.
 */
export const ENV_GAP_OUTPUT_RE =
    /Executable doesn't exist|playwright install|browserType\.\w+: Executable|(?:wasn't|weren't) installed|Host system is missing dependencies|No usable sandbox|Cypress verification|Cypress executable (?:not found|was not found)|browser(?:s)? (?:is|are)? ?not installed/i

/**
 * A non-zero exit whose output shows the EXTERNAL INFRASTRUCTURE a launch script
 * talks to is absent HERE — a database/daemon that is not running or not
 * installed — rather than a fault in the script itself.
 *
 * NOT applied by default, and that is deliberate: a migrate/seed against no DB is
 * an environment gap on this box, but the same wording out of a `test` run is a
 * real failure the suite must own. Callers opt in per command by passing it in
 * `gapPatterns`, which is why that parameter exists rather than a boolean.
 */
export const INFRA_GAP_OUTPUT_RE =
    /ECONNREFUSED|connection refused|ENOTFOUND|EAI_AGAIN|is the server running|could not connect|cannot connect to the docker daemon|connect: connection|no such host/i

/** Which way a command failed to tell us anything. */
export type CommandGapId =
    | 'spawn-failed'
    | 'killed'
    | 'command-not-found'
    | 'missing-runtime'
    | 'infrastructure'

export type CommandVerdict =
    /** Nothing was observed. Never fails a gate, never closes a debt. */
    | {outcome: 'gap'; gap: CommandGapId; detail: string}
    | {outcome: 'pass'}
    | {outcome: 'fail'; status: number; tail: string}

/**
 * The gap ladder, in order. FIRST MATCH WINS.
 *
 * `spawn-failed` is first and is kept distinguishable from every other row by its
 * id: a tool-level gap (127 inside the chain, a missing browser, a timeout) means
 * the runner demonstrably RAN, and only genuine spawn failures feed the gate's
 * full-blindness guard (mx5 run 16 — see observabilityGapFailure).
 */
const GAP_RULES: ReadonlyArray<{
    id: CommandGapId
    detail: (run: CommandRun) => string
    applies: (run: CommandRun, output: string, gapPatterns: readonly RegExp[]) => boolean
}> = [
    {
        id: 'spawn-failed',
        detail: run =>
            run.failureMessage ?
                `runner did not spawn (${run.failureMessage})`
            :   'runner did not spawn',
        applies: run => run.failedToStart
    },
    {
        id: 'killed',
        detail: () => 'killed (timeout or signal)',
        applies: run => run.status === null
    },
    {
        id: 'command-not-found',
        detail: () => 'command not found (127)',
        applies: (run, output) => isCommandNotFound(run.status, output)
    },
    {
        id: 'missing-runtime',
        detail: () => 'missing browser/runtime',
        applies: (_run, output) => ENV_GAP_OUTPUT_RE.test(output)
    },
    {
        id: 'infrastructure',
        detail: () => 'external infrastructure unreachable',
        applies: (_run, output, gapPatterns) => gapPatterns.some(re => re.test(output))
    }
]

/** Last ~`limit` chars of the command's combined output, one line, for the reason. */
export function outputTail(stdout: string, stderr: string, limit = 400): string {
    const combined = `${stdout}\n${stderr}`.trim()
    if (combined.length === 0) return ''
    const tail = combined.slice(-limit).replace(/\s+/g, ' ').trim()
    return combined.length > limit ? `…${tail}` : tail
}

/**
 * Decide what one finished command proved. Pure — no spawning, no filesystem, no
 * clock — so every case is stateable as a literal.
 *
 * `gapPatterns` are the EXTRA output shapes this particular command may treat as
 * an environment gap (see INFRA_GAP_OUTPUT_RE). Empty for an ordinary check.
 */
export function classifyCommandRun(
    run: CommandRun,
    gapPatterns: readonly RegExp[] = []
): CommandVerdict {
    // A clean exit is a pass before any gap shape is consulted: gap patterns
    // describe output, and passing output can legitimately mention a database or
    // a browser.
    if (!run.failedToStart && run.status === 0) return {outcome: 'pass'}
    const output = `${run.stdout}\n${run.stderr}`
    for (const rule of GAP_RULES) {
        if (rule.applies(run, output, gapPatterns)) {
            return {outcome: 'gap', gap: rule.id, detail: rule.detail(run)}
        }
    }
    // Only reachable with a real non-zero status: `failedToStart` and a null
    // status are both gap rows above.
    return {
        outcome: 'fail',
        status: run.status ?? -1,
        tail: outputTail(run.stdout, run.stderr)
    }
}

/**
 * How a re-run of ONE recorded VERIFY command line ended.
 *   pass — it ran and exited 0. The ONLY outcome that may close a debt.
 *   fail — it ran and exited non-zero for a real reason. Debt stays open.
 *   gap  — nothing was observed: the shell/runner never spawned, 127 inside the
 *          chain, a timeout, a missing browser, or absent external infrastructure.
 *          INCONCLUSIVE, so the debt stays open (surface, never re-hide).
 */
export type VerifyRerunOutcome =
    | {outcome: 'pass'}
    | {outcome: 'fail'; status: number; tail: string}
    | {outcome: 'gap'; detail: string}

/** The command word of a shell line, past any leading `VAR=value` assignments. */
function leadingBin(line: string): string | null {
    for (const tok of line.trim().split(/\s+/)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue
        return tok
    }
    return null
}

/**
 * Re-run one VERIFY-block command line (nexttask 5) under the gate's existing
 * env-gap contract, so a debt whose reason NAMES that command can be closed by the
 * command itself rather than by a judgement about it.
 *
 * Runs through `sh -c` because a VERIFY line is a shell line, not an argv: run 19's
 * is `AGENT=1 bun test test/listings.test.ts`, and env prefixes, `&&` and redirects
 * are all ordinary there. The leading command word is still resolved through
 * runner-resolve so a login-shell-stripped PATH cannot make every re-run look like a
 * gap (mx5 run 16's blindness, one level down).
 *
 * The asymmetry is the point: only exit 0 is conclusive. Every other ending — real
 * failure, missing tool, unreachable database, timeout, no POSIX shell — leaves the
 * debt exactly as open as it was.
 */
export function runVerifyCommandLine(
    cwd: string,
    line: string,
    timeoutMs: number,
    extraGapRe?: RegExp,
    /** The spawner. Injected so a re-run's outcome can be tested without one. */
    run: CommandRunner = spawnCommand
): VerifyRerunOutcome {
    const bin = leadingBin(line)
    const runner = bin === null ? null : resolveRunner(bin)
    // A VERIFY line is a SHELL line, not an argv — env prefixes, `&&` and
    // redirects are all ordinary there — so the runner spawns `sh -c`.
    const verdict = classifyCommandRun(
        run({
            cwd,
            bin: 'sh',
            args: ['-c', line],
            timeoutMs,
            env: runner ? runnerEnv(runner) : {...process.env}
        }),
        // Infrastructure counts as a gap on EVERY debt re-run, not only on
        // request: an unreachable database cannot tell us whether the code is
        // fixed, and the asymmetry below means an inconclusive re-run simply
        // leaves the debt as open as it was.
        extraGapRe ? [INFRA_GAP_OUTPUT_RE, extraGapRe] : [INFRA_GAP_OUTPUT_RE]
    )
    if (verdict.outcome === 'gap') return {outcome: 'gap', detail: verdict.detail}
    return verdict
}
