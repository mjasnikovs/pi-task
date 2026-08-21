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

import {spawn} from 'node:child_process'
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
     * Replaces the child's environment wholesale. Passed explicitly because a
     * spawn resolves the binary against a startup snapshot of the environment
     * rather than the live `process.env`.
     */
    env?: Record<string, string | undefined>
    /** The caller's cancel. Kills the child; the run reads as `status: null`. */
    signal?: AbortSignal
}

/**
 * The injectable half. The gate takes one of these so its tests can script
 * verdicts instead of paying process-spawn cost for every classification case.
 *
 * ASYNC by contract. It was `(spec) => CommandRun`, so the only implementation
 * could be `spawnSync`, and the run-end gate blocked the event loop end to end:
 * repo-health under a 600s cap, then every lockfile/test/build/launch command
 * under a 900s cap, then every ACCEPT-debt re-run under a 300s cap, with no
 * loader able to paint through any of it. That freeze is MEASURED — 0 of 686
 * expected 100ms ticks fired during a 69s run — and `repo-health-check.ts`'s own
 * doc comment already told gate callers not to do it, while `final-gate.ts`'s
 * repo-health call did exactly that.
 */
export type CommandRunner = (spec: CommandSpec) => Promise<CommandRun>

/**
 * How much of ONE stream may be held in the HOST process, and how it is split.
 *
 * `spawnSync` bounded this at its 1 MB default `maxBuffer`. The async runner had
 * no bound at all: two strings grew in the TUI's own process for as long as a
 * command under the 900s cap kept talking.
 *
 * BOTH ENDS are kept, because both are read. `isCommandNotFound` and the two gap
 * regexes match wording a runner prints FIRST; `outputTail` and every failure
 * reason take the LAST 400 characters. A single-ended cap loses one of them.
 */
const OUTPUT_HEAD_CAP = 256 * 1024
const OUTPUT_TAIL_CAP = 768 * 1024

/** One stream, bounded, keeping its head and its tail with the middle elided. */
class BoundedOutput {
    private head = ''
    private tail = ''
    private total = 0

    push(chunk: string): void {
        this.total += chunk.length
        let rest = chunk
        if (this.head.length < OUTPUT_HEAD_CAP) {
            const room = OUTPUT_HEAD_CAP - this.head.length
            this.head += rest.slice(0, room)
            rest = rest.slice(room)
        }
        if (rest.length === 0) return
        this.tail = (this.tail + rest).slice(-OUTPUT_TAIL_CAP)
    }

    toString(): string {
        const elided = this.total - this.head.length - this.tail.length
        return elided > 0 ?
                `${this.head}\n…[${elided} characters elided]…\n${this.tail}`
            :   this.head + this.tail
    }
}

/**
 * After the child EXITS, how long its pipes may still deliver buffered data
 * before the run is reported. Not a wait for the pipes to CLOSE — that is the
 * bug below — just the turn or two the reader needs to hand over what it has.
 */
const DRAIN_MS = 50

/**
 * The real runner: one bounded child, output collected, never rejects.
 *
 * A kill — by the wall clock or by the caller's cancel — reads as `status: null`,
 * which the gap ladder already treats as "nothing was observed".
 *
 * THE RUN SETTLES ON THE CHILD, NOT ON THE PIPE. `close` fires only once every
 * stdio pipe has reached EOF, and a backgrounded grandchild INHERITS stdout: a
 * seed script that starts a daemon, a build that leaves a watcher, a launch
 * script. Waiting for `close` there is waiting for the grandchild, which no
 * timeout can reach — SIGKILL goes to the direct child and the inherited pipe
 * survives it. So `exit` settles the run, and the deadline settles it itself.
 */
export const spawnCommand: CommandRunner = spec =>
    new Promise<CommandRun>(resolve => {
        const out = new BoundedOutput()
        const err = new BoundedOutput()
        let settled = false
        let exitStatus: number | null = null
        let exited = false
        let endedStreams = 0
        let drain: ReturnType<typeof setTimeout> | undefined
        const child = spawn(spec.bin, spec.args, {
            cwd: spec.cwd,
            // stdin CLOSED. `spawnSync` gave the child none; the default `spawn`
            // stdio is a live pipe nobody ever ends, so a check that reads stdin —
            // a `cat`-style pipeline, a tool that prompts, a pager — blocked until
            // the kill timer: 600s for repo-health, 900s for a gate command.
            stdio: ['ignore', 'pipe', 'pipe'],
            ...(spec.env ? {env: spec.env} : {})
        })
        const done = (status: number | null, failure?: string): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            clearTimeout(drain)
            spec.signal?.removeEventListener('abort', killAndSettle)
            resolve({
                failedToStart: failure !== undefined,
                ...(failure === undefined ? {} : {failureMessage: failure}),
                status,
                stdout: out.toString(),
                stderr: err.toString()
            })
        }
        const expectedStreams = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0)
        const settleIfDrained = (): void => {
            if (exited && endedStreams >= expectedStreams) done(exitStatus)
        }
        const kill = (): void => {
            try {
                child.kill('SIGKILL')
            } catch {
                /* already gone */
            }
        }
        /**
         * The deadline and the cancel both END the run. The kill only reaches the
         * direct child, so this cannot wait to observe its effect — it kills, gives
         * the pipes one drain, and reports `status: null` regardless.
         */
        const killAndSettle = (): void => {
            kill()
            clearTimeout(drain)
            drain = setTimeout(() => done(null), DRAIN_MS)
        }
        // NOT unref'd. With `spawnSync`'s own `timeout` gone this timer is the only
        // bound left on every gate command, repo-health command and ACCEPT-debt
        // re-run — and an unref'd timer is MEASURED in this repo never to fire at
        // all on Windows (0/20s), which would leave all of them unbounded. It is
        // cleared the moment the run settles, so it holds the loop open only while
        // a command the caller is awaiting anyway is still running.
        const timer = setTimeout(killAndSettle, spec.timeoutMs)
        if (spec.signal) {
            if (spec.signal.aborted) killAndSettle()
            else spec.signal.addEventListener('abort', killAndSettle, {once: true})
        }
        child.stdout?.on('data', (d: Buffer) => out.push(d.toString()))
        child.stderr?.on('data', (d: Buffer) => err.push(d.toString()))
        child.stdout?.on('end', () => {
            endedStreams++
            settleIfDrained()
        })
        child.stderr?.on('end', () => {
            endedStreams++
            settleIfDrained()
        })
        child.on('error', (e: Error) => done(null, e.message))
        child.on('exit', (code: number | null) => {
            exited = true
            exitStatus = code
            // Both ends of the same question: settle now if the pipes are already
            // at EOF, otherwise settle after one short drain rather than waiting on
            // whoever else is holding them.
            settleIfDrained()
            if (!settled) {
                clearTimeout(drain)
                drain = setTimeout(() => done(exitStatus), DRAIN_MS)
            }
        })
    })

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
 * Which gap rows may be claimed by a command's OUTPUT rather than by the fact
 * that it never ran. Only these can be WRONG about a command that did run, which
 * is why they are the ones a caller opts into.
 */
export interface ClassifyOptions {
    /**
     * May this command's output claim a MISSING BROWSER/RUNTIME?
     *
     * True by default: the row exists for the gate's TEST commands, where a
     * Playwright suite on a box with no browsers is an environment gap.
     *
     * False for the static ladder. `ENV_GAP_OUTPUT_RE` matches ordinary English
     * — `browsers are not installed`, `wasn't installed` — and repo-health runs
     * lint and typecheck only, which have no browsers to miss. A real lint report
     * that happens to quote that wording would otherwise SKIP the static check
     * and tell the gate the repo is healthy.
     */
    runtimeGap?: boolean
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
    gapPatterns: readonly RegExp[] = [],
    opts: ClassifyOptions = {}
): CommandVerdict {
    // A clean exit is a pass before any gap shape is consulted: gap patterns
    // describe output, and passing output can legitimately mention a database or
    // a browser.
    if (!run.failedToStart && run.status === 0) return {outcome: 'pass'}
    const output = `${run.stdout}\n${run.stderr}`
    const runtimeGap = opts.runtimeGap ?? true
    for (const rule of GAP_RULES) {
        if (rule.id === 'missing-runtime' && !runtimeGap) continue
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
export async function runVerifyCommandLine(
    cwd: string,
    line: string,
    timeoutMs: number,
    extraGapRe?: RegExp,
    /** The spawner. Injected so a re-run's outcome can be tested without one. */
    run: CommandRunner = spawnCommand,
    signal?: AbortSignal
): Promise<VerifyRerunOutcome> {
    const bin = leadingBin(line)
    const runner = bin === null ? null : resolveRunner(bin)
    // A VERIFY line is a SHELL line, not an argv — env prefixes, `&&` and
    // redirects are all ordinary there — so the runner spawns `sh -c`.
    const verdict = classifyCommandRun(
        await run({
            cwd,
            bin: 'sh',
            args: ['-c', line],
            timeoutMs,
            env: runner ? runnerEnv(runner) : {...process.env},
            ...(signal === undefined ? {} : {signal})
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
