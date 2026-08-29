/**
 * final-gate — the run-level integration gate /task-auto runs ONCE, after every
 * task is checked off and before the run is declared complete.
 *
 * Every other gate in this extension is per-task, so a run can finish with each
 * slice individually blessed while the ASSEMBLED project is dead. Per-task
 * repo-health covers the static half; nothing else runs the project's own
 * test/build/start commands against the finished whole.
 *
 * Like repo-health-check, whose discovery style it mirrors, it is deterministic:
 * no model, no per-file narrowing. It discovers the project's OWN commands and
 * lets their REAL exit codes decide. `runFinalIntegrationGate` runs the sections
 * in this order:
 *
 *   - static analysis (runRepoHealthCheck), then
 *   - the launch-contract diff and the `pre-discovery` closure scans, which need
 *     no runner at all, then
 *   - lockfile↔manifest consistency — a lockfile can carry a dependency no
 *     committed manifest declares, so the tree tests green here while a FRESH
 *     CHECKOUT cannot install; each ecosystem's own non-mutating "is the lock in
 *     sync" command decides, then
 *   - the project's own test and build commands, verbatim and unaided, then
 *   - the declared launch scripts, one-shot, then
 *   - one boot exercise of the start command. No ports, URLs or framework
 *     knowledge: fast non-zero exit → FAIL, quick exit 0 → PASS (CLI-style),
 *     still alive after the grace window → PASS, and the whole process group is
 *     killed, because scripts spawn children and a leaked child server masks
 *     every later boot check with a port collision, then
 *   - the blindness guard and the `post-boot` closure scans.
 *
 * EVERY section runs and the failures AGGREGATE into one ranked list; nothing
 * early-returns on the first failure.
 *
 * Environment-gap safety, same contract as repo-health-check: a command that
 * CANNOT run (ENOENT, exit 127 = command-not-found inside the script chain, or a
 * timeout) is an environment problem, not a code fault — SKIPPED, never failed.
 * Only a command that actually ran and exited non-zero fails the gate, and the
 * reason carries the tail of its real output so the user and a resume fix can act
 * on it. A test suite that needs a database still fails here when the database is
 * reachable-but-mis-wired, and the caller puts a human on that decision, so a
 * genuine external gap can be overridden.
 *
 * A skip is never silent: a DISCOVERED boot command that never ran is its own
 * verdict, kept outside the tally's dynamic counters so nothing else the gate
 * observed can cancel it.
 */
import {existsSync, readFileSync} from 'node:fs'
import * as path from 'node:path'
import {
    runRepoHealthCheck,
    discoverHealthCommands,
    type HealthCommand
} from './repo-health-check.js'
import {deriveOpenDebts, rerunDebtVerifyCommand, type AcceptDebt} from './accept-debt.js'
import {
    readDeclaredScripts,
    missingDeclaredScripts,
    runnableDeclaredScripts
} from './launch-contract.js'
import {
    readLaunchManifest,
    inertLaunchContractNote,
    packageScripts,
    makeHasTarget
} from './launch-manifest.js'
import {
    discoverBootCommand,
    detectsServedApp,
    runBootCheck,
    runBootSection,
    bootSkipVerdict,
    nonLaunchScriptReason,
    rejectedLaunchScript,
    parseSsListeners,
    parseNetstatListeners,
    parseLsofListeners,
    pickFreePort,
    preferredDeclaredPort,
    canEnumerateListeners,
    type BootDeps
} from './boot-probe.js'
import {readEnvNotes, parseEnvNotes, isExcuseNote} from './env-notes.js'
import {resolveRunner, runnerEnv} from './runner-resolve.js'
import {
    classifyCommandRun,
    spawnCommand,
    INFRA_GAP_OUTPUT_RE,
    type CommandRunner
} from './command-run.js'
import {findLaunchConfigGap, probeEnv, configGapUnobservedNote} from './launch-config-gap.js'
import {taskThatIntroduced} from './task-provenance.js'
import {findDanglingArtifacts, danglingGateFailureText} from './artifact-closure.js'
import {
    findMissingEnvDeclarations,
    envGateFailureText,
    scanEnvTemplateClosure,
    inertClosure,
    trackedFiles,
    type EnvClosure
} from './env-template-closure.js'
import {findMissingServeEntry, serveEntryGateFailureText} from './serve-entry.js'
import {makefileRecipe} from './command-shrink.js'
import {GateTally, observabilityGapFailure, unobservedVerdict} from './gate-tally.js'
import {VERIFY_FAIL_PREFIX} from './verify-work.js'

export interface FinalGateOutcome {
    /** true → statics and every runnable integration command passed (or nothing to run). */
    ok: boolean
    /**
     * On a fail: the exact command(s), exit code(s), and output tail(s) — the
     * MECHANICAL failures only. The accept-debt note is deliberately NOT folded in
     * here, because this string is what `buildFinalFixPrompt` puts in front of the
     * autofix child, and a recorded debt claim reaching a write-enabled child reads
     * as an instruction to act on it. The child cannot act on text it never
     * receives; debts travel in `debtNote`. With multiple failures this is the
     * numbered, ranked list (see `failures`).
     */
    reason: string
    /**
     * On a fail: EVERY section failure individually, ranked most load-bearing
     * first — boot/render ("the app does not serve/render") outranks any single
     * test failure. The gate aggregates rather than early-returning: the boot and
     * render probes run LAST, so a first-failure return would let any earlier test
     * failure shadow the one signal that answers "does the app serve anything at
     * all". Callers trail each entry and show the full list wherever an ACCEPT
     * decision is made.
     */
    failures?: string[]
    /**
     * The SUBSET of `failures` that a PROBE returned after actually observing —
     * entries whose evidence is "we looked, and what we saw was bad", as opposed to
     * "we could not look".
     *
     * The probes distinguish "we looked and it was bad" from "we could not look"
     * in their own outcomes; this field carries that class alongside the failure
     * TEXT. Without it the non-progress classifier downstream has only string
     * equality to go on, and a deterministic un-fixed defect satisfies string
     * equality by definition — so a real, still-broken check reads as an
     * unfalsifiable one and gets demoted to debt.
     *
     * Membership is by exact text identity with an entry of `failures` — never a
     * pattern, never a re-derivation. Absent/empty on a pass.
     */
    observedFailures?: string[]
    /**
     * Human-facing suffix listing the still-open accepted-defect claims (see
     * buildAcceptDebtNote) — for the picker question and the trail, NEVER for the
     * autofix seed. Absent when nothing is open.
     */
    debtNote?: string
    /**
     * ACCEPT-despite-verify-FAIL debts still open at run end: tasks the user
     * blessed as-is despite a verify-FAIL that a deterministic re-check could not
     * prove resolved. The caller surfaces them so a run never completes silently
     * carrying an accepted defect. Empty/absent = none.
     */
    openDebts?: AcceptDebt[]
    /**
     * Set (with the UNOBSERVED note) when the gate could not OBSERVE something it was
     * supposed to. Two independent triggers, either or both:
     *   - nothing dynamic ran at all — no command was discoverable, or every discovered
     *     one skipped as an environment gap (unobservedVerdict);
     *   - a served app's boot command was discovered and SKIPPED, whatever else ran.
     *
     * `ok` is still true (the statics did pass and there is nothing to fix), but this is
     * NOT a PASS: the caller must record it as UNOBSERVED, never as "checked and fine".
     * Absent ⇒ everything the gate meant to observe, it observed.
     */
    unobserved?: string
}

/**
 * The project's OWN whole-repo integration commands (test, then build — test
 * first because it is the richer signal and the more common script). First
 * manifest that exists wins, mirroring discoverHealthCommands. Empty means
 * "nothing to run" — the static half may still gate.
 *
 * THE MANIFEST ALLOWLIST BELOW IS NARROW, AND THAT IS A KNOWN GAP: a project with
 * no package.json, Makefile, Cargo.toml, go.mod or pyproject.toml discovers
 * NOTHING here, and so does a package.json whose only script is named something
 * else. That outcome is reported as UNOBSERVED rather than as a PASS (see
 * unobservedVerdict), which makes the blindness loud — it does not remove it.
 *
 * DO NOT close the gap by harvesting each task's own `## verified tooling`
 * section. That section is the parsed output of a model child (phases.ts writes
 * it from the verify-tooling worker), and despite its name nothing records the
 * cwd the command was tried in or the code it exited with — so a fabricated
 * command is indistinguishable from a real one before it runs, and running it is
 * how the gate would find out. Fix that provenance first. Widening this allowlist
 * tool-by-tool is not the fix either.
 */
export function discoverIntegrationCommands(cwd: string): {
    ecosystem: string | null
    cmds: HealthCommand[]
} {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        const cmds: HealthCommand[] = []
        // Every test-shaped script, not just the one literally named `test`: a
        // project's only browser-executing suite is often `test:ct` or similar, and
        // looking for `test` alone never runs it. Plain `test` leads, then every
        // `test:`/`test_`/`test-` prefixed name in declaration order (Array#sort is
        // stable), then `build`. Measured on a manifest declaring test:ct, build,
        // test_unit, test-e2e, test, testing and pretest, the result is exactly
        // test, test:ct, test_unit, test-e2e, build — `testing` and `pretest` do
        // not match. Env-gap SKIP still applies per command: a suite whose browser
        // or runtime is absent skips rather than fails (see runGateCommand).
        const testNames = Object.keys(s).filter(n => n === 'test' || /^test[:_-]/.test(n))
        testNames.sort((a, b) =>
            a === 'test' ? -1
            : b === 'test' ? 1
            : 0
        )
        for (const name of testNames) cmds.push(['bun', ['run', name]])
        if (s.build) cmds.push(['bun', ['run', 'build']])
        return {ecosystem: 'package.json', cmds}
    }
    if (existsSync(path.join(cwd, 'Makefile'))) {
        const cmds: HealthCommand[] = []
        for (const target of ['test', 'build']) {
            if (makeHasTarget(cwd, target)) cmds.push(['make', [target]])
        }
        return {ecosystem: 'Makefile', cmds}
    }
    if (existsSync(path.join(cwd, 'Cargo.toml'))) {
        return {
            ecosystem: 'Cargo.toml',
            cmds: [
                ['cargo', ['test', '--quiet']],
                ['cargo', ['build', '--quiet']]
            ]
        }
    }
    if (existsSync(path.join(cwd, 'go.mod'))) {
        return {
            ecosystem: 'go.mod',
            cmds: [
                ['go', ['test', './...']],
                ['go', ['build', './...']]
            ]
        }
    }
    if (existsSync(path.join(cwd, 'pyproject.toml'))) {
        return {ecosystem: 'pyproject.toml', cmds: [['pytest', ['-q']]]}
    }
    return {ecosystem: null, cmds: []}
}

/**
 * Per-ecosystem lockfile↔manifest consistency checks. A check applies only when
 * BOTH the manifest and its lockfile exist — no lockfile means nothing to verify
 * — and every command is that ecosystem's own non-mutating "is the lock in sync
 * with the manifest" form.
 *
 * Four of the six were run against real throwaway projects, in sync and then with
 * one dependency added to the manifest only. Each exited 0 in sync and non-zero
 * on the desync, and left the lockfile byte-identical either way:
 * `bun install --frozen-lockfile --dry-run` 0/1, `npm ci --dry-run` 0/1 (and it
 * does not remove node_modules), `cargo metadata --locked` 0/101,
 * `uv lock --check` 0/1. The `go` and `poetry` rows could not be run here — those
 * binaries are not installed on this box — so they are asserted, not measured.
 * A desync does reach the network; only the in-sync path is offline.
 */
const LOCKFILE_CHECKS: Array<{manifest: string; lockfiles: string[]; cmd: HealthCommand}> = [
    {
        manifest: 'package.json',
        lockfiles: ['bun.lock', 'bun.lockb'],
        cmd: ['bun', ['install', '--frozen-lockfile', '--dry-run']]
    },
    {
        manifest: 'package.json',
        lockfiles: ['package-lock.json'],
        cmd: ['npm', ['ci', '--dry-run']]
    },
    {
        manifest: 'Cargo.toml',
        lockfiles: ['Cargo.lock'],
        cmd: ['cargo', ['metadata', '--locked', '--format-version', '1']]
    },
    {manifest: 'go.mod', lockfiles: ['go.sum'], cmd: ['go', ['mod', 'verify']]},
    {manifest: 'pyproject.toml', lockfiles: ['uv.lock'], cmd: ['uv', ['lock', '--check']]},
    {manifest: 'pyproject.toml', lockfiles: ['poetry.lock'], cmd: ['poetry', ['check', '--lock']]}
]

/** Every lockfile consistency check that applies to this tree (possibly none). */
export function discoverLockfileChecks(cwd: string): HealthCommand[] {
    const cmds: HealthCommand[] = []
    for (const {manifest, lockfiles, cmd} of LOCKFILE_CHECKS) {
        if (!existsSync(path.join(cwd, manifest))) continue
        if (!lockfiles.some(f => existsSync(path.join(cwd, f)))) continue
        cmds.push(cmd)
    }
    return cmds
}

/**
 * Labels (`bin args…`) of every command the gate CAN currently discover — the
 * static half (repo-health) plus the integration half. Pure discovery, nothing
 * runs. Used by the final-gate autofix shrink guard: a fix pass that makes a
 * previously-discoverable command undiscoverable (deleted the script/target) is
 * gaming the gate, not fixing the defect.
 */
export function discoverGateCommandLabels(cwd: string): string[] {
    const boot = discoverBootCommand(cwd)
    const labels = [
        ...discoverHealthCommands(cwd).cmds,
        ...discoverLockfileChecks(cwd),
        ...discoverIntegrationCommands(cwd).cmds,
        ...(boot ? [boot] : [])
    ].map(([bin, args]) => `${bin} ${args.join(' ')}`)
    return [...new Set(labels)]
}

/**
 * The RESOLVED BODY of every discoverable gate command, keyed by the same label
 * `discoverGateCommandLabels` produces.
 *
 * The label is what the gate CALLS; the body is what actually runs. A fix pass
 * can rewrite `scripts.test` to run one subdirectory and leave the label
 * `bun run test` identical, so the label guard sees nothing while the suite stops
 * covering the repository. The shrink guard compares these bodies (see
 * command-shrink.ts).
 *
 * A command with no indirection (`cargo test --quiet`, `pytest -q`) resolves to
 * itself: it cannot be narrowed without changing the label, which the label
 * guard already owns.
 */
export function discoverGateCommandBodies(cwd: string): Record<string, string> {
    const boot = discoverBootCommand(cwd)
    const cmds = [
        ...discoverHealthCommands(cwd).cmds,
        ...discoverLockfileChecks(cwd),
        ...discoverIntegrationCommands(cwd).cmds,
        ...(boot ? [boot] : [])
    ]
    const scripts = existsSync(path.join(cwd, 'package.json')) ? packageScripts(cwd) : {}
    let makefile: string | null = null
    if (existsSync(path.join(cwd, 'Makefile'))) {
        try {
            makefile = readFileSync(path.join(cwd, 'Makefile'), 'utf8')
        } catch {
            makefile = null
        }
    }
    const out: Record<string, string> = {}
    for (const [bin, args] of cmds) {
        const label = `${bin} ${args.join(' ')}`
        if (out[label] !== undefined) continue
        out[label] = resolveCommandBody(bin, args, scripts, makefile) ?? label
    }
    return out
}

/** `bun run test` → `scripts.test`; `make test` → the target's recipe lines. */
function resolveCommandBody(
    bin: string,
    args: string[],
    scripts: Record<string, string>,
    makefile: string | null
): string | null {
    if (args[0] === 'run' && args[1] !== undefined) return scripts[args[1]] ?? null
    if (bin === 'make' && args[0] !== undefined && makefile !== null) {
        return makefileRecipe(makefile, args[0])
    }
    return null
}

/**
 * Run one gate command with the env-gap contract: tool missing, timeout, or
 * command-not-found inside the script chain (127) → environment gap, not a code
 * fault → skipped (same contract as repo-health). Also skips a non-zero exit whose
 * output shows a missing browser/runtime (ENV_GAP_OUTPUT_RE) — or, when the caller
 * passes `extraGapRe` (launch scripts), missing external infrastructure. Only a
 * command that actually ran and exited non-zero for a real reason fails.
 */
async function runGateCommand(
    cwd: string,
    [bin, args]: HealthCommand,
    timeoutMs: number,
    extraGapRe?: RegExp,
    /** Replaces the child's environment wholesale (config-gap probe re-run only —
     *  see launch-config-gap.ts). Absent ⇒ `runnerEnv(runner)`, i.e. unchanged. */
    envOverride?: Record<string, string | undefined>,
    /** The spawner. Injected so the gate's own tests can script a verdict. */
    run: CommandRunner = spawnCommand,
    signal?: AbortSignal
): Promise<
    | {
          outcome: 'skip'
          /** true → the runner binary never spawned (ENOENT). Distinct from a
           *  tool-level gap (127 inside the chain, missing browser, timeout),
           *  where the runner demonstrably RAN: only spawn failures feed the
           *  full-blindness guard. */
          spawnFailed: boolean
      }
    | {outcome: 'pass'}
    | {outcome: 'fail'; status: number; tail: string}
> {
    // Runner resolution: a login-shell-stripped PATH left `bun`
    // unspawnable, so every dynamic check skipped and the gate went blind. The
    // resolved binary is spawned, and its directory rides on the child's PATH so
    // the SCRIPT CHAIN can re-invoke the runner (`bun run test` runs `bun test`
    // inside — a bare 127 there is the same blindness one level down).
    const runner = resolveRunner(bin)
    const verdict = classifyCommandRun(
        await run({
            cwd,
            bin: runner.bin,
            args,
            timeoutMs,
            env: envOverride ?? runnerEnv(runner),
            ...(signal === undefined ? {} : {signal})
        }),
        extraGapRe ? [extraGapRe] : []
    )
    if (verdict.outcome === 'gap') {
        return {outcome: 'skip', spawnFailed: verdict.gap === 'spawn-failed'}
    }
    return verdict
}

// `runVerifyCommandLine` and its outcome type live in command-run.ts with the
// other command drivers; re-exported because the gate's own test suite reaches
// them through this module.
export {runVerifyCommandLine, type VerifyRerunOutcome} from './command-run.js'

// The two verdict predicates — the full-blindness FAIL and the third,
// non-blocking UNOBSERVED verdict — live with the counters they read, in
// gate-tally.ts (GateTally). Re-exported for the gate's own test suite.
export {observabilityGapFailure, unobservedVerdict}

// File → introducing-task provenance lives in task-provenance.ts, next to the
// cross-task deletion guards that use it; re-exported for the gate's own tests.
export {taskThatIntroduced}

// The boot probe lives in boot-probe.ts. This module is its ONLY importer inside
// src/, so these re-exports exist for consumers outside it; of them, the gate's
// own test suite currently reaches only `bootSkipVerdict` through here.
export {
    discoverBootCommand,
    detectsServedApp,
    runBootCheck,
    runBootSection,
    bootSkipVerdict,
    nonLaunchScriptReason,
    rejectedLaunchScript,
    parseSsListeners,
    parseNetstatListeners,
    parseLsofListeners,
    pickFreePort,
    preferredDeclaredPort,
    canEnumerateListeners
}
export type {BootDeps}
export type {BootSectionVerdict} from './boot-probe.js'

// The ACCEPT-debt re-check (`deriveOpenDebts`, `rerunDebtVerifyCommand`) lives in
// accept-debt.ts with the ledger it reads and writes; re-exported because
// auto-orchestrator.ts imports `deriveOpenDebts` through this module.
export {deriveOpenDebts, rerunDebtVerifyCommand}

/**
 * Where in the gate a closure scan runs. The two stages are NOT interchangeable
 * and neither is a scheduling preference:
 *
 *   - `pre-discovery` runs before the zero-discovery early return, so a project
 *     with no runnable command at all still FAILS the scan instead of returning
 *     UNOBSERVED. A static check needs no runner; that is the whole point of
 *     deciding it in exactly the environment where every dynamic probe went blind.
 *   - `post-boot` runs after the dynamic sections. Execution order is the
 *     aggregate's tiebreak within a rank, so moving a row between stages MOVES it
 *     in the user-visible failure list.
 */
type ClosureScanStage = 'pre-discovery' | 'post-boot'

/** Everything a closure scan may look at. Static and synchronous by construction:
 *  a check that had to spawn something would belong in the dynamic sections
 *  above, not here — these run on trees where nothing is runnable. */
interface ClosureScanInput {
    cwd: string
    planText?: string
}

/**
 * One run-level closure scan: "the shipped tree references/requires something it
 * does not contain". Each row owns its scan, its formatting, its rank and its
 * position; the driver owns the fault isolation.
 */
interface ClosureScan {
    /** Stable identity — how the driver and its tests address a row. */
    id: string
    stage: ClosureScanStage
    /**
     * Rank in the aggregated failure list. All three rows are 0 because all three
     * say some form of "the app cannot be started / cannot serve what it
     * references / cannot be configured at all", which is the same load-bearing
     * class as boot/render. It is a per-row FIELD rather than a shared constant
     * so that a future scan whose finding is NOT of that class can say so in the
     * table instead of by getting a hand-typed argument right at a call site.
     */
    rank: number
    /**
     * Scan and format in one pass, yielding one ready-to-emit failure text per
     * finding.
     *
     * A GENERATOR rather than a function returning an array, for two reasons.
     * First, the driver's try/catch wraps the ITERATION, so a scan that yields two
     * findings and then throws still emits those two. Second, the three scans do
     * not share a result shape — one nullable finding, a list, and a list plus the
     * template set its formatter also needs — and folding scan and format together
     * lets each row keep its own arity instead of forcing a
     * lowest-common-denominator result type on all three.
     */
    run: (input: ClosureScanInput) => Iterable<string>
}

/**
 * The run-level closure scans, in emission order within their stage.
 *
 * ONLY checks of this shape belong here. Four other checks in this gate are
 * deliberately NOT rows: repo-health returns {ok, reason} and formats inline; the
 * launch-contract diff branches on manifest kind and can emit a NOTE instead of a
 * failure; the launch config-gap produces neither a failure nor a note but
 * UN-COUNTS a dynamic observation (`tally.unobserve()`); and the boot check is
 * async, stateful and port-binding. Squeezing any of those in would mean a row
 * type with more escape hatches than content.
 */
const CLOSURE_SCANS: ClosureScan[] = [
    {
        // Serve-entry closure: the tree builds a server app, expects to serve (SPA
        // fallback, a static read, a design clause), and NOTHING anywhere starts a
        // listener — a module that ends at `export {app}` cannot be started at all.
        // Static and synchronous, and unlike the boot check it is decidable in
        // exactly the environment where a boot would skip. Hence `pre-discovery`: a
        // project with no runnable command must still fail this rather than report
        // UNOBSERVED.
        id: 'serve-entry',
        stage: 'pre-discovery',
        rank: 0,
        *run({cwd, planText}) {
            const found = findMissingServeEntry(cwd, planText)
            if (found) yield serveEntryGateFailureText(found)
        }
    },
    {
        // Artifact-production closure: a runtime file reference with NO producer
        // anywhere ships silently — a server reading `dist/index.html` that no build
        // step emits 404s every request behind a fully green plan. Deterministic
        // scan of the shipped tree: literal references only, positive producer
        // evidence required (artifact-closure.ts). Each dangle names the referencer
        // and the missing path.
        id: 'dangling-artifact',
        stage: 'post-boot',
        rank: 0,
        *run({cwd}) {
            for (const d of findDanglingArtifacts(cwd)) yield danglingGateFailureText(d)
        }
    },
    {
        // Env-template closure: a shipped source file requires an env var the
        // shipped template never mentions. Without this the only symptom is the
        // script's own non-zero exit, which an autofix can silence by writing the
        // GITIGNORED `.env` — leaving a committed tree that still cannot run and
        // nothing at run end saying why. Same shape and rank as the
        // dangling-artifact scan: name the ARTIFACT that is wrong, statically,
        // rather than only the command that failed. The formatter needs the
        // template set as well as the finding, which is why scan and format are one
        // row. Inert on any tree with no tracked template.
        id: 'env-template',
        stage: 'post-boot',
        rank: 0,
        *run({cwd}) {
            const env = findMissingEnvDeclarations(cwd)
            for (const m of env.missing) yield envGateFailureText(m, env.templates)
        }
    }
]

/**
 * Run every closure scan belonging to `stage`, in table order, feeding each
 * finding to `fail` at the row's own rank.
 *
 * FAULT ISOLATION IS PER ROW, not per stage: each row gets its own try/catch, so
 * a scanner that throws contributes nothing and every LATER row still runs. One
 * shared try would silently turn a fault in the first scan into blanket silence
 * from the rest — the gate would keep working and keep missing defects it can
 * decide. `scans` is injectable so that property can be tested with a row built
 * to throw, without mocking the real scanners.
 */
function runClosureScans(
    stage: ClosureScanStage,
    input: ClosureScanInput,
    fail: (text: string, rank: number) => void,
    scans: readonly ClosureScan[] = CLOSURE_SCANS
): void {
    for (const scan of scans) {
        if (scan.stage !== stage) continue
        try {
            for (const text of scan.run(input)) fail(text, scan.rank)
        } catch {
            // best-effort scan — a scanner fault must never break the gate
        }
    }
}

export {CLOSURE_SCANS, runClosureScans}
export type {ClosureScan, ClosureScanInput, ClosureScanStage}

/**
 * Everything the run-end gate needs beyond the tree it is judging.
 *
 * An options object rather than a positional tail, because `bootGraceMs` and
 * `timeoutMs` are adjacent numbers that would swap without a type error.
 *
 * `run`, `envClosure` and `trackedFiles` are test SEAMS. Without `run`, the
 * config-gap branch below is unreachable from a test: reaching it needs a
 * git-tracked env template, and the launch-contract tests build a bare directory
 * with no `git init`, so they miss it by construction.
 */
export interface FinalGateOptions {
    timeoutMs?: number
    bootGraceMs?: number
    bootDeps?: BootDeps
    planText?: string
    /** Spawner for the lockfile / integration / launch-script sections. Boot
     *  spawns through `bootDeps`, which has its own probes. */
    run?: CommandRunner
    /** The tracked env-template closure. Default reads git, degrading to inert. */
    envClosure?: (cwd: string) => EnvClosure
    /** The repo's tracked file list, or null when it cannot be determined. */
    trackedFiles?: (cwd: string) => string[] | null
    /**
     * The run's cancel. Reaches every command the gate spawns — repo-health, the
     * lockfile, integration and launch sections, and the ACCEPT-debt re-runs. It
     * only works because `CommandRunner` is async: a synchronous spawn never gives
     * the event loop a turn in which to notice an abort.
     */
    signal?: AbortSignal
}

export async function runFinalIntegrationGate(
    cwd: string,
    opts: FinalGateOptions = {}
): Promise<FinalGateOutcome> {
    const {
        timeoutMs = 900_000,
        bootGraceMs = 10_000,
        bootDeps = {},
        planText,
        run: runCmd = spawnCommand,
        envClosure = (c: string) => {
            try {
                return scanEnvTemplateClosure(c)
            } catch {
                return inertClosure()
            }
        },
        trackedFiles: trackedFilesFn = trackedFiles
    } = opts
    // ASYNC so the event loop keeps turning while the project's own lint runs: a
    // loader can paint and a cancel can reach the child.
    const stat = await runRepoHealthCheck(cwd, {
        run: runCmd,
        ...(opts.signal === undefined ? {} : {signal: opts.signal})
    })
    // Debts are derived ONCE, before any section runs, and ride on every verdict
    // shape (GateTally.verdict). `reason` stays purely mechanical because it seeds
    // the autofix child's prompt, and a write-enabled child reads a recorded claim
    // as an instruction.
    const debts = await deriveOpenDebts(cwd, stat.ok, runCmd, opts.signal)
    // Every section below RECORDS into the tally (failures ranked, the four
    // dynamic counters, the notes) and the verdict is assembled ONCE at the end —
    // see gate-tally.ts for what each method means.
    const tally = new GateTally()
    // The prefix comes from VERIFY_FAIL_PREFIX so this run-level mint and the
    // task-level `repo health:` one stay linked: both are the deterministic
    // whole-repo static check, and `isStaticClassDebt` must recognise a debt that
    // entered the ledger through EITHER altitude.
    if (!stat.ok) tally.fail(`${VERIFY_FAIL_PREFIX['static-checks']} ${stat.reason}`)
    // Launch-contract diff: a design can declare scripts that fall through
    // decompose and ship missing, unchecked. Diff the plan-time-extracted declared
    // scripts against the manifest; a missing one is a launch-surface defect.
    // FP-safe: an empty declared list means nothing was grounded, so no check runs.
    //
    // THE DIFF MUST NOT RUN WITHOUT A MANIFEST. `packageScripts` catches and
    // returns {}, so diffing against its keys makes a project with NO package.json
    // indistinguishable from one with no scripts — every declared script reported
    // missing, naming a file the project was never meant to have. The extractor
    // upstream scrapes any design that says "script", nothing about it is
    // npm-shaped, and this text seeds the autofix child's prompt, so on a
    // CMake/cargo project the repair it invites is to write a package.json.
    // readLaunchManifest resolves package.json, else a Makefile's targets, else
    // nothing — and nothing means a note, never a failure and never a silent pass.
    const declared = await readDeclaredScripts(cwd)
    if (declared.length > 0) {
        const manifest = readLaunchManifest(cwd)
        if (manifest.kind === 'none') {
            tally.contractNote(inertLaunchContractNote(declared, manifest))
        } else {
            const missing = missingDeclaredScripts(declared, manifest.names)
            if (missing.length > 0) {
                tally.fail(
                    `launch contract: the design declares script(s) the shipped ${manifest.file} does not expose: ${missing.join(', ')} (declared: ${declared.join(', ')})`
                )
            }
        }
    }
    // Run-level closure scans that must be decided BEFORE the zero-discovery early
    // return below — a static check needs no runner (CLOSURE_SCANS: 'pre-discovery').
    runClosureScans('pre-discovery', {cwd, planText}, (t, r) => tally.fail(t, r))
    const lockCmds = discoverLockfileChecks(cwd)
    const {cmds} = discoverIntegrationCommands(cwd)
    const boot = discoverBootCommand(cwd)
    for (const {prefix, list} of [
        {prefix: 'lockfile check: ', list: lockCmds},
        {prefix: '', list: cmds}
    ]) {
        for (const cmd of list) {
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            tally.attempted(cmd[0])
            const r = await runGateCommand(
                cwd,
                cmd,
                timeoutMs,
                undefined,
                undefined,
                runCmd,
                opts.signal
            )
            if (r.outcome === 'skip') {
                if (r.spawnFailed) tally.spawnFailure(cmd[0])
                continue
            }
            tally.observed()
            if (r.outcome === 'fail') {
                tally.fail(
                    `${prefix}\`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`
                )
                continue
            }
            tally.ran(label)
        }
    }
    // EXECUTE the launch contract: every declared script that is neither
    // boot-class (the boot check below owns those) nor already covered by the
    // integration commands above RUNS as a one-shot, in declared order. Existence
    // is not launchability — a script can be present in the manifest and throw on
    // its first call. The env-gap contract extends to missing external
    // INFRASTRUCTURE here (no DB or daemon on this box → skip, not fail), and a
    // skip whose script also carries a standing EXCUSE note is surfaced as an
    // UNOBSERVED warning: the note may be covering a real defect the gate could
    // not reach.
    if (declared.length > 0) {
        const covered = cmds.flatMap(([bin, args]) =>
            (bin === 'bun' || bin === 'npm') && args[0] === 'run' && args[1] ? [args[1]] : []
        )
        const skippedLaunch: string[] = []
        // A declared script the manifest doesn't expose is already a
        // launch-contract failure above; executing it too would double-report.
        // EXECUTION STAYS npm-ONLY: the runner below is literally `bun run <name>`,
        // so on a Makefile project `present` is empty from `packageScripts` and
        // every declared target is skipped rather than run through the wrong tool.
        // The diff above does speak Makefile; widening the RUNNER to match is a
        // separate change.
        const present = new Set(Object.keys(packageScripts(cwd)).map(s => s.toLowerCase()))
        const scripts = packageScripts(cwd)
        // CONFIG-GAP INPUTS, read once: the tracked file list and the union of every
        // tracked env template's declared variables. Both are empty on a non-git tree
        // or one with no template, which makes the whole check inert there — a
        // project with no template gains no excuse. See launch-config-gap.ts.
        const closure = envClosure(cwd)
        const trackedForGap = closure.templates.length > 0 ? (trackedFilesFn(cwd) ?? []) : []
        const launchTimeout = Math.min(timeoutMs, 180_000)
        for (const name of runnableDeclaredScripts(declared, covered)) {
            if (!present.has(name.toLowerCase())) continue
            const cmd: HealthCommand = ['bun', ['run', name]]
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            tally.attempted(cmd[0])
            const r = await runGateCommand(
                cwd,
                cmd,
                launchTimeout,
                INFRA_GAP_OUTPUT_RE,
                undefined,
                runCmd,
                opts.signal
            )
            if (r.outcome === 'skip') {
                if (r.spawnFailed) tally.spawnFailure(cmd[0])
                skippedLaunch.push(name)
                continue
            }
            tally.observed()
            if (r.outcome === 'fail') {
                // A CONFIG GAP IS NOT A CODE FAULT. A script can exit non-zero only
                // because a variable its own committed template DECLARES is absent
                // from this box, where the only way to supply it is a gitignored
                // `.env` no commit can contain. findLaunchConfigGap decides the
                // static half; the dynamic half is this re-run with the variables
                // supplied as synthetic placeholders, and the reclassification
                // happens ONLY if that exits 0. A script that fails for its own
                // reasons fails again with the values present and stays a FAIL: an
                // absent variable is not a licence to ignore an exit code the code
                // caused. Nothing is parsed from the child's stderr.
                const gap = findLaunchConfigGap({
                    cwd,
                    script: name,
                    body: scripts[name] ?? null,
                    tracked: trackedForGap,
                    declared: closure.declared,
                    env: process.env
                })
                if (gap) {
                    const probe = await runGateCommand(
                        cwd,
                        cmd,
                        launchTimeout,
                        INFRA_GAP_OUTPUT_RE,
                        probeEnv(runnerEnv(resolveRunner(cmd[0])), gap),
                        runCmd,
                        opts.signal
                    )
                    if (probe.outcome === 'pass') {
                        // Nothing about this script was OBSERVED: the real run could
                        // not reach it and the probe run is a diagnostic, never an
                        // observation. So it un-counts, exactly like a skip.
                        tally.unobserve()
                        skippedLaunch.push(name)
                        tally.configGap(configGapUnobservedNote(gap))
                        continue
                    }
                }
                tally.fail(
                    `launch script: \`${label}\` exited ${r.status}${r.tail ? ` — ${r.tail}` : ''}`
                )
                continue
            }
            tally.ran(label)
        }
        if (skippedLaunch.length > 0) {
            const notes = parseEnvNotes(await readEnvNotes(cwd)).filter(n => isExcuseNote(n.fact))
            for (const name of skippedLaunch) {
                const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
                const excuse = notes.find(n => re.test(n.fact))
                if (excuse) {
                    tally.warn(
                        `launch script \`${name}\` could not run here (environment gap) and a `
                            + `standing excuse note covers it ("${excuse.fact.slice(0, 160)}") — `
                            + `UNOBSERVED: verify it by hand before trusting the launch surface`
                    )
                }
            }
        }
    }
    // Boot + render ALWAYS runs. It is independent of test results by
    // construction and carries the run's most load-bearing signal, so its failures
    // rank FIRST in the aggregate and earlier failures cannot shadow it. A boot
    // that never RAN is its own verdict, kept outside the tally's dynamic counters
    // on purpose, so the test/build commands that did run cannot cancel it.
    //
    // ZERO DISCOVERY IS UNOBSERVED, NEVER A PASS (see unobservedVerdict and the
    // zero-attempts branch of GateTally.verdict). Nothing discovered means nothing
    // ran, so the blindness guard below cannot fire either —
    // `observabilityGapFailure` returns null the moment `attempted === 0`. Calling
    // that a PASS makes "we never checked" read identically to "we checked and it
    // was fine", and a run can ship that verdict while carrying open verify-FAIL
    // debt. The outcome stays `ok: true` and non-blocking, but is labelled,
    // trailed and carried as debt by the caller. It needs no new command source, so
    // unlike the harvest refused at discoverIntegrationCommands it cannot inject a
    // fabricated failure. The inert-contract note rides on it: a non-npm project
    // carrying a launch contract usually discovers no command either, and that is
    // exactly the run whose silence must not read as "the contract was checked and
    // was fine".
    //
    // This return sits AFTER the launch-script loop, not before it. Firing first, a
    // DECLARED launch script would never run on a tree with no discoverable
    // integration command. The condition asks the TALLY — no attempt and no failure
    // — rather than asking discovery, so both paths see the same state. It still
    // returns before the boot section and the post-boot closure scans.
    if (!boot && tally.silent()) return tally.verdict(debts)
    // The boot CONCEPT lives in boot-probe.ts (runBootSection): discovery,
    // served-app detection, the probe defaults, the boot check, orphan-port
    // recovery, the port-holder diagnosis, the skip verdict and the
    // rejected-launch-script branch. What is left here is only the recording of
    // its result into the tally.
    const bootSection = await runBootSection(cwd, {
        ...(planText === undefined ? {} : {planText}),
        ...(bootGraceMs === undefined ? {} : {graceMs: bootGraceMs}),
        deps: bootDeps
    })
    if (bootSection.attempted) tally.attempted(bootSection.attempted)
    if (bootSection.observed) tally.observed()
    else if (bootSection.spawnFailedBin) tally.spawnFailure(bootSection.spawnFailedBin)
    tally.bootUnobserved(bootSection.unobservedNote ?? null)
    if (bootSection.failure) {
        const {detail, rank, observed} = bootSection.failure
        if (observed) tally.failObserved(detail, rank)
        else tally.fail(detail, rank)
    }
    if (bootSection.ranLabel) tally.ran(bootSection.ranLabel)
    for (const w of bootSection.warnings) tally.warn(w)
    // Full-skip blindness guard: commands were discovered but every one skipped →
    // rank-0 failure, never a static-only PASS. Runner resolvability is checked
    // through resolveRunner so the failure text can name the missing runner when
    // that is the cause.
    const gap = tally.blindness(b => resolveRunner(b).ok)
    if (gap) tally.fail(gap, 0)
    // The remaining run-level closure scans — "the shipped tree references or
    // requires something it does not contain" — after every dynamic section, which
    // is where their failures sit in the aggregate's within-rank order
    // (CLOSURE_SCANS: 'post-boot').
    runClosureScans('post-boot', {cwd, planText}, (t, r) => tally.fail(t, r))
    return tally.verdict(debts)
}
