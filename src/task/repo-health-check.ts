/**
 * repo-health-check — the deterministic, whole-repo half of the verify gate.
 *
 * The failure this closes: the task's own composed VERIFY block is authored
 * per-task by a model, so what it covers varies. One task lints the whole repo;
 * the next ships a VERIFY of `tsc --noEmit` and no lint at all, and a lint-only
 * regression then passes its gate. The model gate is only ever as good as the
 * VERIFY block it happened to be handed.
 *
 * This check does NOT depend on that block. It discovers the project's OWN
 * whole-repo static-analysis command (the one a fresh checkout / CI would run) and
 * lets its REAL exit code decide — no model, so there is no per-file narrowing and
 * no "those errors aren't in my files" gray area. A non-zero exit becomes the
 * verify gate's `repo-health` FAIL (verify-work.ts), which reaches the
 * AUTOFIX / ACCEPT picker in verify-resolution.ts.
 *
 * Scope is STATIC ANALYSIS (lint / typecheck / clippy / vet) by default, never
 * `build`, `run`, or anything that boots a server. Static analysis is hermetic: it
 * needs no network, no service and no fixtures, so its absolute exit code decides.
 *
 * The TEST suite joins only under `withTests`, and only for the DIFFERENTIAL
 * (health-baseline.ts). MEASURED (mx5-n TASK_0004, 2026-09-17): a task turned a
 * green suite red, its spec called that a "known issue for the test owner", the
 * model gate passed it, and four tasks later the run stalled on an unsatisfiable
 * spec. A suite that needs a database fails the same way before and after the
 * task, which the differential reads as pre-existing — so running it here does
 * not blame code for a missing database, and DOES blame the task that broke a
 * suite the baseline saw green.
 *
 * Absence is a PASS, two ways: (1) no recognised manifest at all (a pure-docs or
 * config-only repo has nothing that can regress); (2) a manifest with no static-check
 * command wired up. A tool that is simply not installed (ENOENT / null exit) is an
 * environment gap, not a code fault, so that command is SKIPPED — only a command that
 * actually ran and returned non-zero fails the check.
 */
import {existsSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import {resolveRunner, runnerEnv} from './runner-resolve.js'
import {
    classifyCommandRun,
    spawnCommand,
    type CommandGapId,
    type CommandRunner
} from './command-run.js'

/**
 * What ONE discovered command did. `outcome` is `classifyCommandRun`'s verdict, so
 * a tool that could not run at all is `skip` rather than a zero-exit pass.
 *
 * This exists for the DIFFERENTIAL (health-baseline.ts): "was the repo already
 * failing?" is per command, not per overall verdict. Two runs can both be `ok:
 * false` while a different command failed in each — a task that broke typecheck in
 * a repo whose lint was already red — and the overall boolean calls that
 * pre-existing.
 */
export interface HealthCommandResult {
    /** The command line as run, e.g. `bun run lint`. The differential's join key. */
    cmd: string
    outcome: 'pass' | 'fail' | 'skip'
    /** Real exit status on a `fail`; null when nothing conclusive ran. */
    exitCode: number | null
    /** Absent on a record written before the suite joined the check, which ran
     *  statics only. A test red is judged, owed and repaired differently. */
    kind?: 'static' | 'test'
    /** Why nothing was observed, on a `skip`. The differential reads it: a runner
     *  that found no tests is a gap alone and a regression against a suite. */
    gap?: CommandGapId
    /** This command's own captured output, on a `fail` only. */
    output?: string
}

export interface HealthOutcome {
    /** true → every discovered check passed or could not run, or there was nothing
     *  to run. false → a discovered command actually ran and exited non-zero. */
    ok: boolean
    /** Human-readable reason. On a fail, names every failing command and its exit code. */
    reason: string
    /** Which manifest drove discovery, or null when none was found. */
    ecosystem: string | null
    /** Every discovered command, in run order. A red one does not stop the run: a
     *  command it skipped would be absent from both sides of the differential, which
     *  then cannot see that command break. */
    commands: HealthCommandResult[]
    /**
     * First lines of the first failing command's combined stderr+stdout — captured so a
     * FAIL is explainable from artifacts alone. The exit code alone does not say
     * what happened: eslint exits 1 for findings and 2 when it could not run at
     * all (a missing config, say), so "`bun run lint` exited 2" is unreproducible
     * after the fact unless the output was kept. Empty string on pass / skip.
     */
    output: string
}

/** How much of a failing command's output to keep — bounded so a wedged tool that
 *  spews megabytes cannot bloat the trail. stderr leads (a crash trace lives there). */
const HEALTH_OUTPUT_MAX_LINES = 40
const HEALTH_OUTPUT_MAX_CHARS = 4000

/** Combine a failing command's stderr+stdout into a bounded, first-N-lines snippet. */
export function captureHealthOutput(stdout: string, stderr: string): string {
    const combined = [stderr, stdout]
        .map(s => (s ?? '').trim())
        .filter(s => s.length > 0)
        .join('\n')
    if (combined.length === 0) return ''
    let snippet = combined.split('\n').slice(0, HEALTH_OUTPUT_MAX_LINES).join('\n')
    if (snippet.length > HEALTH_OUTPUT_MAX_CHARS)
        snippet = `${snippet.slice(0, HEALTH_OUTPUT_MAX_CHARS)}…`
    return snippet
}

/** One discovered command: the binary and its args, run from the repo root. */
export type HealthCommand = [bin: string, args: string[]]

function packageScripts(cwd: string): Record<string, string> {
    try {
        const j = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')) as {
            scripts?: Record<string, string>
        }
        return j.scripts ?? {}
    } catch {
        return {}
    }
}

/** Does the Makefile define a `<target>:` rule? (so `make <target>` won't error out) */
function makeHasTarget(cwd: string, target: string): boolean {
    try {
        const mk = readFileSync(path.join(cwd, 'Makefile'), 'utf8')
        return new RegExp(`^${target}:`, 'm').test(mk)
    } catch {
        return false
    }
}

/**
 * Every file `discoverHealthCommands` consults. Exported because a verified
 * command is only as good as the manifest that vouched for it: `manifestHash`
 * (run-context.ts) hashes exactly this set, so a project that gains a `lint`
 * script invalidates the run's tooling verdicts and nothing else does.
 */
export const HEALTH_MANIFEST_FILES = [
    'package.json',
    'Makefile',
    'Cargo.toml',
    'pyproject.toml',
    'deno.json',
    'deno.jsonc',
    'go.mod'
] as const

/**
 * Discover the project's OWN whole-repo static-analysis commands. First manifest
 * that exists wins; returns only the STATIC commands actually available for that
 * ecosystem (never test/build/run). An empty list means "nothing static to run".
 */
export function discoverHealthCommands(cwd: string): {
    ecosystem: string | null
    cmds: HealthCommand[]
} {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        const cmds: HealthCommand[] = []
        // Only static-analysis scripts. `lint` commonly chains tsc (as in this
        // `prettier && eslint && tsc`), so a single `bun run lint` covers both.
        for (const name of ['lint', 'typecheck']) {
            if (s[name]) cmds.push(['bun', ['run', name]])
        }
        return {ecosystem: 'package.json', cmds}
    }
    if (existsSync(path.join(cwd, 'Makefile'))) {
        const cmds: HealthCommand[] = []
        if (makeHasTarget(cwd, 'lint')) cmds.push(['make', ['lint']])
        return {ecosystem: 'Makefile', cmds}
    }
    if (existsSync(path.join(cwd, 'Cargo.toml'))) {
        return {ecosystem: 'Cargo.toml', cmds: [['cargo', ['clippy', '--quiet']]]}
    }
    if (existsSync(path.join(cwd, 'pyproject.toml'))) {
        return {ecosystem: 'pyproject.toml', cmds: [['ruff', ['check', '.']]]}
    }
    if (existsSync(path.join(cwd, 'deno.json')) || existsSync(path.join(cwd, 'deno.jsonc'))) {
        return {ecosystem: 'deno', cmds: [['deno', ['lint']]]}
    }
    if (existsSync(path.join(cwd, 'go.mod'))) {
        return {ecosystem: 'go.mod', cmds: [['go', ['vet', './...']]]}
    }
    return {ecosystem: null, cmds: []}
}

/**
 * `test:watch`, `jest --watchAll`, `vitest watch`, `bun test --watch`.
 *
 * The flag is read by its VALUE, not its presence: `--watchAll=false` is how a CI
 * script turns watch off, and excluding it drops the only `test` script such a
 * repo has.
 */
function isWatchScript(name: string, body: string): boolean {
    return (
        /watch/i.test(name)
        || /(?:^|\s)--watch(?:All)?(?:=(?:true|1))?(?=\s|$)|(?:^|\s)watch(?=\s|$)/.test(body)
    )
}

/**
 * The project's OWN test commands, in the order the run-end gate runs them. One
 * statement for both gates: final-gate.ts appends `build` to this list for the
 * integration half, and `runRepoHealthCheck` runs it under `withTests` for the
 * per-task differential, so the two cannot drift apart.
 *
 * Every test-shaped script, not just the one literally named `test`: a project's
 * only browser-executing suite is often `test:ct`, and looking for `test` alone
 * never runs it. Plain `test` leads, then every `test:`/`test_`/`test-` name in
 * declaration order (Array#sort is stable). A watch-mode script is left out: it
 * never exits, so all it can add is a timeout.
 */
export function discoverTestCommands(cwd: string): {
    ecosystem: string | null
    cmds: HealthCommand[]
} {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        const names = Object.keys(s).filter(
            n => (n === 'test' || /^test[:_-]/.test(n)) && !isWatchScript(n, s[n])
        )
        names.sort((a, b) =>
            a === 'test' ? -1
            : b === 'test' ? 1
            : 0
        )
        return {ecosystem: 'package.json', cmds: names.map(n => ['bun', ['run', n]])}
    }
    if (existsSync(path.join(cwd, 'Makefile'))) {
        return {
            ecosystem: 'Makefile',
            cmds: makeHasTarget(cwd, 'test') ? [['make', ['test']]] : []
        }
    }
    if (existsSync(path.join(cwd, 'Cargo.toml'))) {
        return {ecosystem: 'Cargo.toml', cmds: [['cargo', ['test', '--quiet']]]}
    }
    if (existsSync(path.join(cwd, 'go.mod'))) {
        return {ecosystem: 'go.mod', cmds: [['go', ['test', './...']]]}
    }
    if (existsSync(path.join(cwd, 'pyproject.toml'))) {
        return {ecosystem: 'pyproject.toml', cmds: [['pytest', ['-q']]]}
    }
    return {ecosystem: null, cmds: []}
}

/** The nothing-to-run outcome, shared by both runners. */
function noCommandOutcome(ecosystem: string | null): HealthOutcome {
    return {
        ok: true,
        reason: 'no repo-wide static-analysis command found',
        ecosystem,
        commands: [],
        output: ''
    }
}

/** Progress hook: called with each command's label as it STARTS, so a caller can
 *  keep a live status line naming what is currently running. */
export type HealthProgress = (command: string) => void

/**
 * Run the discovered static checks whole-repo and let the real exit codes decide.
 *
 *  - No manifest / no static command  → ok (nothing can regress).
 *  - A command that CANNOT run (ENOENT / null exit / 127 inside the chain) → skipped,
 *    treated as an environment gap, not a fault.
 *  - A command that ran and exited non-zero → red. Every command still runs.
 *
 * This module owns DISCOVERY and its own output policy. Running a command and
 * deciding what its ending MEANS is `command-run.ts`'s — one statement of the
 * env-gap ladder, with an injectable runner, so a classification case needs no
 * real shell.
 *
 * `captureHealthOutput` stays this module's own: 40 lines of a linter's report is a
 * real difference from `outputTail`'s 400-character default, and that is a
 * parameter, not a thing to unify.
 *
 * `onCommand` lets the caller name the running command in a live status line — the
 * gate runs this immediately after the implementation turn ends, when the impl
 * widget has just been cleared.
 */
export async function runRepoHealthCheck(
    cwd: string,
    opts: {
        timeoutMs?: number
        signal?: AbortSignal
        onCommand?: HealthProgress
        /** The spawner. Injected so a verdict is testable without a real shell. */
        run?: CommandRunner
        /** Also run the project's test commands, after the statics. Only a caller
         *  that will judge the result DIFFERENTIALLY may set this — see the header. */
        withTests?: boolean
    } = {}
): Promise<HealthOutcome> {
    const statics = discoverHealthCommands(cwd)
    const tests = opts.withTests ? discoverTestCommands(cwd) : {ecosystem: null, cmds: []}
    const ecosystem = statics.ecosystem ?? tests.ecosystem
    const cmds: Array<{bin: string; args: string[]; test: boolean}> = [
        ...statics.cmds.map(([bin, args]) => ({bin, args, test: false})),
        ...tests.cmds.map(([bin, args]) => ({bin, args, test: true}))
    ]
    if (!ecosystem || cmds.length === 0) return noCommandOutcome(ecosystem)
    const run = opts.run ?? spawnCommand
    const commands: HealthCommandResult[] = []
    for (const {bin, args, test} of cmds) {
        const cmd = `${bin} ${args.join(' ')}`
        opts.onCommand?.(cmd)
        // Runner resolution: a PATH-stripped environment must not
        // silently skip the statics when the runner sits at a known install
        // location; the resolved dir also rides on PATH for the script chain.
        const runner = resolveRunner(bin)
        const r = await run({
            cwd,
            bin: runner.bin,
            args,
            label: cmd,
            timeoutMs: opts.timeoutMs ?? 600_000,
            env: runnerEnv(runner),
            ...(opts.signal === undefined ? {} : {signal: opts.signal})
        })
        // The DECISION comes from the shared ladder; the OUTPUT is this module's own
        // policy. `captureHealthOutput` keeps 40 lines of a linter's report where the
        // ladder's `tail` keeps 400 characters, and that difference is real — a
        // truncated lint report is unactionable. So the run is classified, not
        // consumed: the verdict decides, the raw streams are what we show.
        // `runtimeGap` and `emptySuite` only for a TEST command. Both rows read the
        // command's output, and on lint and typecheck a genuine report quoting
        // "browsers are not installed" would skip the static check and certify
        // the repo healthy.
        const verdict = classifyCommandRun(r, [], {runtimeGap: test, emptySuite: test})
        const kind = test ? 'test' : 'static'
        if (verdict.outcome !== 'fail') {
            const passed = verdict.outcome === 'pass'
            commands.push({
                cmd,
                outcome: passed ? 'pass' : 'skip',
                exitCode: passed ? 0 : null,
                kind,
                ...(verdict.outcome === 'gap' ? {gap: verdict.gap} : {})
            })
            continue
        }
        commands.push({
            cmd,
            outcome: 'fail',
            exitCode: verdict.status,
            kind,
            output: captureHealthOutput(r.stdout, r.stderr)
        })
    }
    const firstFail = commands.find(c => c.outcome === 'fail')
    if (firstFail) {
        return {
            ok: false,
            reason: describeHealthFailures(commands),
            ecosystem,
            commands,
            output: firstFail.output ?? ''
        }
    }
    return {
        ok: true,
        reason: `${ecosystem}: static checks${tests.cmds.length > 0 ? ' and tests' : ''} passed`,
        ecosystem,
        commands,
        output: ''
    }
}

/** A command the repo owes an answer for: it failed, or its suite went missing. */
export function isHealthRed(c: HealthCommandResult): boolean {
    return c.outcome === 'fail' || c.gap === 'empty-suite'
}

/** "`bun run lint` exited 1; `bun run test` exited 1" — every failing command. */
export function describeHealthFailures(commands: readonly HealthCommandResult[]): string {
    return commands
        .filter(isHealthRed)
        .map(c =>
            c.outcome === 'fail' ?
                `\`${c.cmd}\` exited ${c.exitCode}`
            :   `\`${c.cmd}\` found no tests to run`
        )
        .join('; ')
}
