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
 * Scope is deliberately STATIC ANALYSIS ONLY (lint / typecheck / clippy / vet), never
 * `test`, `build`, `run`, or anything that boots a server or needs a database. Those
 * depend on external services the verify prompt already carves out as an environment
 * gap, so running them here would blame code for a missing database. Static analysis
 * is hermetic: it needs no network, no service and no fixtures.
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
import {classifyCommandRun, spawnCommand, type CommandRunner} from './command-run.js'

export interface HealthOutcome {
    /** true → every discovered static check passed, or there was nothing to run.
     *  false → a discovered command actually ran and exited non-zero. */
    ok: boolean
    /** Human-readable reason. On a fail, names the exact command and exit code. */
    reason: string
    /** Which manifest drove discovery, or null when none was found. */
    ecosystem: string | null
    /**
     * First lines of the failing command's combined stderr+stdout — captured so a
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

/** The nothing-to-run outcome, shared by both runners. */
function noCommandOutcome(ecosystem: string | null): HealthOutcome {
    return {ok: true, reason: 'no repo-wide static-analysis command found', ecosystem, output: ''}
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
 *  - A command that ran and exited non-zero → the first such failure is returned.
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
    } = {}
): Promise<HealthOutcome> {
    const {ecosystem, cmds} = discoverHealthCommands(cwd)
    if (!ecosystem || cmds.length === 0) return noCommandOutcome(ecosystem)
    const run = opts.run ?? spawnCommand
    for (const [bin, args] of cmds) {
        opts.onCommand?.(`${bin} ${args.join(' ')}`)
        // Runner resolution: a PATH-stripped environment must not
        // silently skip the statics when the runner sits at a known install
        // location; the resolved dir also rides on PATH for the script chain.
        const runner = resolveRunner(bin)
        const r = await run({
            cwd,
            bin: runner.bin,
            args,
            timeoutMs: opts.timeoutMs ?? 600_000,
            env: runnerEnv(runner),
            ...(opts.signal === undefined ? {} : {signal: opts.signal})
        })
        // The DECISION comes from the shared ladder; the OUTPUT is this module's own
        // policy. `captureHealthOutput` keeps 40 lines of a linter's report where the
        // ladder's `tail` keeps 400 characters, and that difference is real — a
        // truncated lint report is unactionable. So the run is classified, not
        // consumed: the verdict decides, the raw streams are what we show.
        // `runtimeGap: false` — this ladder is NARROWER than the gate's. The
        // browser/runtime row was written for the gate's TEST commands; here the
        // commands are lint and typecheck, and its pattern matches ordinary
        // English, so a genuine report quoting "browsers are not installed" would
        // skip the static check and certify the repo healthy.
        const verdict = classifyCommandRun(r, [], {runtimeGap: false})
        if (verdict.outcome !== 'fail') continue
        return {
            ok: false,
            reason: `\`${bin} ${args.join(' ')}\` exited ${verdict.status}`,
            ecosystem,
            output: captureHealthOutput(r.stdout, r.stderr)
        }
    }
    return {ok: true, reason: `${ecosystem}: static checks passed`, ecosystem, output: ''}
}
