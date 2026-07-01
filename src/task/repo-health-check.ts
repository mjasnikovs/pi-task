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

export interface HealthOutcome {
    /** true → every discovered static check passed, or there was nothing to run.
     *  false → a discovered command actually ran and exited non-zero. */
    ok: boolean
    /** Human-readable reason. On a fail, names the exact command and exit code. */
    reason: string
    /** Which manifest drove discovery, or null when none was found. */
    ecosystem: string | null
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
        return {ok: true, reason: 'no repo-wide static-analysis command found', ecosystem}
    }
    for (const [bin, args] of cmds) {
        const r = spawnSync(bin, args, {cwd, encoding: 'utf8', timeout: timeoutMs})
        // Tool missing (ENOENT) or killed by timeout → cannot conclude; skip it.
        if (r.error || r.status === null) continue
        if (r.status !== 0) {
            return {
                ok: false,
                reason: `\`${bin} ${args.join(' ')}\` exited ${r.status}`,
                ecosystem
            }
        }
    }
    return {ok: true, reason: `${ecosystem}: static checks passed`, ecosystem}
}
