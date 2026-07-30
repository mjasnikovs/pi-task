/**
 * repo-health-check — the deterministic, whole-repo half of the verify gate.
 *
 * The failure this closes (proven on the mx5 run): the verify gate ran only the
 * task's OWN composed VERIFY block, and that block is authored per-task by the local
 * model — so it is inconsistent. Some tasks lint the whole repo, some (TASK_0021)
 * ship a VERIFY of `tsc --noEmit` ONLY, with no lint at all. A/B on the live model,
 * 5 runs/arm on the real dirty tree: the tsc-only task false-PASSed 5/5 while
 * `bun run lint` reported 11 errors. The model gate is only ever as good as the
 * VERIFY block it happened to be handed.
 *
 * This check does NOT depend on that block. It discovers the project's OWN
 * whole-repo static-analysis command (the one a fresh checkout / CI would run) and
 * lets its REAL exit code decide — no model, so there is no per-file narrowing and
 * no "those errors aren't in my files" gray area. A non-zero exit is a FAIL that the
 * caller turns into the existing verify-FAIL outcome (→ the AUTOFIX / ACCEPT /
 * dismiss picker; the user decides).
 *
 * Scope is deliberately STATIC ANALYSIS ONLY (lint / typecheck / clippy / vet), never
 * `test`, `build`, `run`, or anything that boots a server or needs a database. Those
 * depend on external services the verify prompt already carves out as an environment
 * gap — running them here would re-introduce the false-FAIL that once wrongly blamed
 * code for a missing DB. Static analysis is hermetic: it needs no network, no service,
 * no fixtures, and it is exactly the class of the reported defect.
 *
 * Absence is a PASS, two ways: (1) no recognised manifest at all (a pure-docs or
 * config-only repo has nothing that can regress); (2) a manifest with no static-check
 * command wired up. A tool that is simply not installed (ENOENT / null exit) is an
 * environment gap, not a code fault, so that command is SKIPPED — only a command that
 * actually ran and returned non-zero fails the check.
 */
import {spawnSync} from 'node:child_process'
import {existsSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import {resolveRunner, runnerEnv, isCommandNotFound} from './runner-resolve.js'

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
     * FAIL is explainable from artifacts alone. Run-8 F8: five enforce passes were
     * discarded on "`bun run lint` exited 2" and the cause was unreproducible
     * post-run because only the exit code was recorded (exit 2 is the linter's
     * CRASH class; findings exit 1 — the captured output is what tells them apart).
     * Empty string on pass / skip.
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
        // Only static-analysis scripts. `lint` commonly chains tsc (as in mx5's
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
 * Run the discovered static checks whole-repo and let the real exit codes decide.
 * Deterministic and synchronous under the hood (a wrapper keeps the caller async).
 *
 *  - No manifest / no static command  → ok (nothing can regress).
 *  - A command that CANNOT run (ENOENT / null exit — tool not installed) → skipped,
 *    treated as an environment gap, not a fault.
 *  - A command that ran and exited non-zero → the first such failure is returned.
 *
 * A generous per-command timeout guards against a wedged tool; a timeout is treated
 * as an inconclusive skip, not a fault (it is an environment problem, not the code's).
 */
export function runRepoHealthCheck(cwd: string, timeoutMs = 600_000): HealthOutcome {
    const {ecosystem, cmds} = discoverHealthCommands(cwd)
    if (!ecosystem || cmds.length === 0) {
        return {
            ok: true,
            reason: 'no repo-wide static-analysis command found',
            ecosystem,
            output: ''
        }
    }
    for (const [bin, args] of cmds) {
        // Runner resolution (mx5 run 16): a PATH-stripped environment must not
        // silently skip the statics when the runner sits at a known install
        // location; the resolved dir also rides on PATH for the script chain.
        const runner = resolveRunner(bin)
        const r = spawnSync(runner.bin, args, {
            cwd,
            encoding: 'utf8',
            timeout: timeoutMs,
            env: runnerEnv(runner)
        })
        // Tool missing (ENOENT) or killed by timeout → cannot conclude; skip it.
        if (r.error || r.status === null) continue
        // "Command not found" INSIDE the script chain (e.g. `bun run lint` before
        // node_modules exists — seen live failing TASK_0001's first verify). Same
        // environment gap as ENOENT, just surfaced through the runner's shell —
        // as exit 127 where a posix shell ran it, else by the runner's own wording
        // (Windows bun reports the miss itself and exits 1).
        if (isCommandNotFound(r.status, `${r.stdout ?? ''}\n${r.stderr ?? ''}`)) continue
        if (r.status !== 0) {
            return {
                ok: false,
                reason: `\`${bin} ${args.join(' ')}\` exited ${r.status}`,
                ecosystem,
                output: captureHealthOutput(r.stdout, r.stderr)
            }
        }
    }
    return {ok: true, reason: `${ecosystem}: static checks passed`, ecosystem, output: ''}
}
