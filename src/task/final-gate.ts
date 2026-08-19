/**
 * final-gate — the run-level integration gate /task-auto runs ONCE, after every
 * task is checked off and before the run is declared complete.
 *
 * The failure this closes (mx5 runs 3 and 5, validated): every existing gate is
 * per-task/per-slice, so a run can finish with each slice individually blessed
 * while the ASSEMBLED project is dead — statics green yet every protected route
 * 500ing, 105/174 tests failing across slices, later tasks breaking files earlier
 * tasks verified. Per-task repo-health closes the static half; nothing ever ran
 * the project's own test/build commands against the finished whole.
 *
 * Like repo-health-check (whose discovery style this mirrors), it is deterministic
 * — no model, no per-file narrowing, no "not my task" gray area. It discovers the
 * project's OWN integration commands (the ones a fresh checkout / CI would run)
 * and lets their REAL exit codes decide:
 *
 *   - static analysis first (runRepoHealthCheck — cheap, precise), then
 *   - lockfile↔manifest consistency (mx5 run 7, validated: the lockfile carried a
 *     dependency no committed manifest declared, so the tree tested green here
 *     but a FRESH CHECKOUT could not even install — each ecosystem's own offline
 *     "is the lock in sync" command decides), then
 *   - the project's own `test` and `build` commands, run verbatim and unaided, then
 *   - one boot exercise of the project's own start command (mx5 run 7, validated:
 *     every static and test gate green, yet `bun run start` died in ~1s on a
 *     self-inflicted EADDRINUSE — nothing had ever LAUNCHED the finished project).
 *     No ports, URLs, or framework knowledge: fast non-zero exit → FAIL, quick
 *     exit 0 → PASS (CLI-style), still alive after the grace window → PASS and
 *     the whole process group is killed (scripts spawn children; a leaked child
 *     server would mask every later boot check with a port collision).
 *
 * Environment-gap safety, same contract as repo-health-check: a command that
 * CANNOT run (ENOENT, exit 127 = command-not-found inside the script chain, or a
 * timeout) is an environment problem, not a code fault — it is SKIPPED, never
 * failed. Only a command that actually ran and exited non-zero fails the gate,
 * and the reason carries the tail of its real output so the user (and a resume
 * fix) can act on it. A test suite that needs a database will fail here when the
 * database is genuinely reachable-but-mis-wired — which is exactly the class the
 * per-task gates kept excusing — and the caller puts a human on the decision
 * (accept / leave failed), so a genuine external gap can still be overridden.
 *
 * A skip is never silent, though. A DISCOVERED boot command that never ran is its
 * own verdict (bootSkipVerdict, mx5 run 18) — nothing else the gate observed can
 * cancel it. Validation harnesses for that lever:
 *   scripts/boot-skip-baserate.ts      base rate, shipped gate, before the change
 *   scripts/boot-skip-verdict-ab.ts    two-armed deterministic A/B + invariants
 *   scripts/boot-skip-fp-suite.ts      zero-FP arms over every local repo
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
    bootSkipVerdict,
    nonLaunchScriptReason,
    rejectedLaunchScript,
    parseSsListeners,
    parseNetstatListeners,
    parseLsofListeners,
    pickFreePort,
    preferredDeclaredPort,
    canEnumerateListeners,
    recoverOrphanPort,
    defaultFindPortHolder,
    type BootDeps
} from './boot-probe.js'
import {readEnvNotes, parseEnvNotes, isExcuseNote} from './env-notes.js'
import {runRenderCheck} from './render-check.js'
import {runDeepRenderCheck} from './deep-render-check.js'
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

export interface FinalGateOutcome {
    /** true → statics and every runnable integration command passed (or nothing to run). */
    ok: boolean
    /**
     * On a fail: the exact command(s), exit code(s), and output tail(s) — the
     * MECHANICAL failures only. The accept-debt note is deliberately NOT folded in
     * here (mx5 run 11): this string seeds the final-gate AUTOFIX child's prompt,
     * and a debt included there is read as an instruction — the run-11 fix child
     * `rm`'d a sibling task's verified deliverable to satisfy a recorded claim. The
     * child cannot act on text it never receives; debts travel in `debtNote`.
     * With multiple failures this is the numbered, ranked list (see `failures`).
     */
    reason: string
    /**
     * On a fail: EVERY section failure individually, ranked most load-bearing
     * first — boot/render ("the app does not serve/render") outranks any single
     * test failure. The gate runs every section and aggregates rather than
     * early-returning (mx5 run 13: a bun-test glob failure shadowed the boot +
     * render probe, so the user accepted the FAIL having only ever seen 1 failing
     * CT test while the shipped app 404'd on every non-API GET). Callers trail
     * each entry and show the full list wherever an ACCEPT decision is made.
     */
    failures?: string[]
    /**
     * The SUBSET of `failures` that a PROBE returned after actually observing —
     * entries whose evidence is "we looked, and what we saw was bad", as opposed to
     * "we could not look" (nexttask 19A).
     *
     * The probes have always known this about themselves: `RenderOutcome` is
     * `pass | fail | skip`, `f648f5b` (2026-07-14) turned a render `skip` into
     * "render check UNOBSERVED: <reason>", and `b0f90a7` (2026-07-19) made an
     * unenumerable boot return PASS-stamped-UNOBSERVED rather than FAIL. What was
     * missing is that the outcome CLASS never travelled with the failure TEXT, so
     * the non-progress classifier downstream had to guess — and guessed by string
     * equality, which a deterministic un-fixed defect satisfies by definition.
     *
     * mx5 run 21: the render probe FAILED on a blank page, the same failure came
     * back from two tree-changing fix attempts (because the defect was real and
     * unfixed), the classifier read that as evidence against the INSTRUMENT, and
     * the run shipped a product whose every page was blank as `completed`.
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
     * ACCEPT-despite-verify-FAIL debts still open at run end (mx5 run 4 B3 / run 8
     * TASK_0012): tasks the user blessed as-is despite a verify-FAIL that a
     * deterministic re-check could not prove resolved. The caller surfaces them so a
     * run never completes silently carrying an accepted defect. Empty/absent = none.
     */
    openDebts?: AcceptDebt[]
    /**
     * Set (with the UNOBSERVED note) when the gate could not OBSERVE something it was
     * supposed to. Two independent triggers, either or both:
     *   - nothing dynamic ran at all — no command was discoverable, or every discovered
     *     one skipped as an environment gap (unobservedVerdict);
     *   - a served app's boot command was discovered and SKIPPED, whatever else ran
     *     (bootSkipVerdict, mx5 run 18 — test suites may not stand in for a launch).
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
 * THE MANIFEST ALLOWLIST BELOW IS NARROW, AND THAT IS A KNOWN, MEASURED GAP: a
 * C++/CMake project (no package.json) and a package.json whose only script is
 * `verify` both discover NOTHING here. That outcome is now reported as UNOBSERVED
 * rather than as a PASS (see unobservedVerdict), which makes the blindness loud and
 * durable — it does not remove it. The gap itself stands.
 *
 * The obvious fix — harvest each task's own `## verified tooling` section, which
 * DOES record the missing commands — was measured on 2026-07-27 and REFUTED. That
 * section is model-authored and, despite its name, unverified: on godot-engine it
 * yields 3 commands that exit 0 and 8 that exit non-zero, six of those for purely
 * fabricated reasons (recorded without a required argument, pointing at files that
 * do not exist, naming a test runner the project does not use) — so harvesting it
 * turns that project's PASS into a FAIL citing "No scene path provided", plus ~15
 * minutes of hang. Full numbers, the reproduction rig, and why no pre-execution
 * filter can separate a fabricated command from a real one:
 * scripts/harvest-verified-tooling-step0.ts. DO NOT re-propose the harvest without
 * first fixing the PROVENANCE of `## verified tooling` (record cwd + exit code at
 * authoring time); widening this allowlist tool-by-tool is not the fix either.
 */
export function discoverIntegrationCommands(cwd: string): {
    ecosystem: string | null
    cmds: HealthCommand[]
} {
    if (existsSync(path.join(cwd, 'package.json'))) {
        const s = packageScripts(cwd)
        const cmds: HealthCommand[] = []
        // Every test-shaped script, not just the one literally named `test` (mx5 run
        // 10: `test:ct` — 89 Playwright component tests, the ONLY client-executing
        // suite — never ran because the gate looked only for `test`/`build`). Plain
        // `test` leads (richer, most common), then `test:*`/`test-*` in declaration
        // order, then `build`. Env-gap SKIP still applies per command (a suite whose
        // browser/runtime is absent skips, it does not fail — see runGateCommand).
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
 * BOTH the manifest and its lockfile exist (no lockfile → nothing to verify),
 * and every command is the ecosystem's own non-mutating "is the lock in sync
 * with the manifest" form — validated to exit 0 fast on an in-sync tree and
 * non-zero on a genuine desync, without touching the tree or (when in sync)
 * the network.
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
 * The label is what the gate CALLS; the body is what actually runs. mx5 run 19's
 * autofix changed `scripts.test` from `AGENT=1 bun test` to `AGENT=1 bun test
 * ./test` — the label `bun run test` was identical before and after, so the
 * label guard saw nothing while the suite stopped covering the repository. The
 * shrink guard compares these bodies (see command-shrink.ts).
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
function runGateCommand(
    cwd: string,
    [bin, args]: HealthCommand,
    timeoutMs: number,
    extraGapRe?: RegExp,
    /** Replaces the child's environment wholesale (config-gap probe re-run only —
     *  see launch-config-gap.ts). Absent ⇒ `runnerEnv(runner)`, i.e. unchanged. */
    envOverride?: Record<string, string | undefined>,
    /** The spawner. Injected so the gate's own tests can script a verdict. */
    run: CommandRunner = spawnCommand
):
    | {
          outcome: 'skip'
          /** true → the runner binary never spawned (ENOENT). Distinct from a
           *  tool-level gap (127 inside the chain, missing browser, timeout),
           *  where the runner demonstrably RAN: only spawn failures feed the
           *  full-blindness guard (mx5 run 16 — see observabilityGapFailure). */
          spawnFailed: boolean
      }
    | {outcome: 'pass'}
    | {outcome: 'fail'; status: number; tail: string} {
    // Runner resolution (mx5 run 16): a login-shell-stripped PATH left `bun`
    // unspawnable, so every dynamic check skipped and the gate went blind. The
    // resolved binary is spawned, and its directory rides on the child's PATH so
    // the SCRIPT CHAIN can re-invoke the runner (`bun run test` runs `bun test`
    // inside — a bare 127 there is the same blindness one level down).
    const runner = resolveRunner(bin)
    const verdict = classifyCommandRun(
        run({cwd, bin: runner.bin, args, timeoutMs, env: envOverride ?? runnerEnv(runner)}),
        extraGapRe ? [extraGapRe] : []
    )
    if (verdict.outcome === 'gap') {
        return {outcome: 'skip', spawnFailed: verdict.gap === 'spawn-failed'}
    }
    return verdict
}

// `runVerifyCommandLine` and its outcome type live in command-run.ts with the
// other command drivers; re-exported so existing importers keep working.
export {runVerifyCommandLine, type VerifyRerunOutcome} from './command-run.js'

// The two verdict predicates — the run-16 full-blindness FAIL and the third,
// non-blocking UNOBSERVED verdict — live with the counters they read, in
// gate-tally.ts (GateTally). Re-exported so every existing importer keeps working.
export {observabilityGapFailure, unobservedVerdict}

// File → introducing-task provenance moved to task-provenance.ts (mx5 run-12
// PROMPT 2 extracted it for the cross-task deletion guards); re-exported so
// existing importers keep working.
export {taskThatIntroduced}

// The boot probe moved to boot-probe.ts (its own concern, 0 other importers inside
// src/). Re-exported so the seven validation harnesses under scripts/ — which have
// always imported exactly this surface and nothing else from the gate — keep
// working unchanged. Same pattern as taskThatIntroduced above.
export {
    discoverBootCommand,
    detectsServedApp,
    runBootCheck,
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

// The ACCEPT-debt re-check (`deriveOpenDebts`, `rerunDebtVerifyCommand`) lives in
// accept-debt.ts with the ledger it reads and writes; re-exported so the
// orchestrator and the harnesses under scripts/ keep working unchanged.
export {deriveOpenDebts, rerunDebtVerifyCommand}

/**
 * Where in the gate a closure scan runs. The two stages are NOT interchangeable
 * and neither is a scheduling preference:
 *
 *   - `pre-discovery` runs before the zero-discovery early return, so a project
 *     with no runnable command at all still FAILS the scan instead of returning
 *     UNOBSERVED. A static check needs no runner; that is the whole point of
 *     deciding it in exactly the environment where every dynamic probe went blind.
 *   - `post-boot` runs after the dynamic sections, which is where these scans'
 *     failures have always landed relative to command/launch/boot failures.
 *     Execution order is the aggregate's tiebreak within a rank, so moving a row
 *     between stages MOVES it in the user-visible failure list.
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
     * First, the driver's try/catch wraps the ITERATION, so a scan that produces
     * two findings and then faults still emits those two — precisely what the
     * three hand-written `for (… ) fail(…)` loops inside try blocks did. Second,
     * the three scans do not share a result shape (one nullable finding; a list;
     * a list plus the template set its formatter also needs), and folding scan
     * and format together lets each row keep its own arity instead of forcing a
     * lowest-common-denominator result type on all of them.
     */
    run: (input: ClosureScanInput) => Iterable<string>
}

/**
 * The run-level closure scans, in emission order within their stage.
 *
 * ONLY checks of this shape belong here. Four other checks in this gate are
 * deliberately NOT rows: repo-health returns {ok, reason} and formats inline;
 * the launch-contract diff branches on manifest kind and can emit a NOTE instead
 * of a failure; the launch config-gap produces neither a failure nor a note but
 * UN-COUNTS a dynamic observation; and the boot check is an async, stateful,
 * port-binding exercise. Squeezing any of those in would mean a row type with
 * more escape hatches than content.
 */
const CLOSURE_SCANS: ClosureScan[] = [
    {
        // Serve-entry closure (mx5 run 18, nexttask 2B): the tree builds a server
        // app, expects to serve (SPA fallback / static read / a design clause), and
        // NOTHING anywhere starts a listener — `src/server/index.ts` ended at
        // `export {app}`, so the product could not be started at all while every
        // dynamic probe went blind on a docker-less box. Static, deterministic,
        // milliseconds, and — unlike the boot check — decidable in exactly the
        // environment where the boot skipped. Hence `pre-discovery`: a project with
        // no runnable command at all must still fail this, not report UNOBSERVED.
        id: 'serve-entry',
        stage: 'pre-discovery',
        rank: 0,
        *run({cwd, planText}) {
            const found = findMissingServeEntry(cwd, planText)
            if (found) yield serveEntryGateFailureText(found)
        }
    },
    {
        // Artifact-production closure (mx5 run 13, PROMPT 2): a runtime file
        // reference with NO producer anywhere ships silently — the server read
        // `Bun.file('dist/index.html')` while the build emitted only app.css +
        // main.js, so every non-API GET 404'd behind 32/32 green checkoffs.
        // Deterministic scan of the shipped tree (literal refs only, positive
        // producer evidence required — see artifact-closure.ts); each dangle names
        // referencer + missing path.
        id: 'dangling-artifact',
        stage: 'post-boot',
        rank: 0,
        *run({cwd}) {
            for (const d of findDanglingArtifacts(cwd)) yield danglingGateFailureText(d)
        }
    },
    {
        // Env-template closure (mx5 run 19, nexttask 10): a shipped source file
        // requires an env var the shipped template never mentions. `seed.ts` read
        // `process.env.ADMIN_PHONE`/`ADMIN_PASSWORD`, `.env.example` declared
        // neither, `bun run seed` exited 1, and the autofix "fixed" it by writing
        // the GITIGNORED `.env` — so the committed tree still cannot seed and
        // nothing at run end said why. Same shape and rank as the dangling-artifact
        // scan above: naming the ARTIFACT that is wrong, statically, instead of only
        // the command that failed. The formatter needs the template set as well as
        // the finding, which is why scan and format are folded into one row.
        // Inert on any tree with no tracked template (ENOENT = pass).
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
 * Run the final gate: static analysis first, then the lockfile consistency
 * checks, then the discovered integration commands, then one boot exercise of
 * the start command — whole-repo, verbatim, unaided. Deterministic (no model).
 *
 * EVERY section runs and failures AGGREGATE (mx5 run 13): the gate used to
 * early-return on the first failing section, and the boot + render probe — built
 * after run 11 exactly for "app serves blank/nothing" — was ordered last, so any
 * earlier failure shadowed the most load-bearing signal. Run 13's user accepted
 * the FAIL having seen only 1 failing CT test while the app 404'd on every
 * non-API GET; boot/render never executed in any attempt. Now the outcome
 * carries the full ranked failure list (boot/render first — "the app does not
 * serve/render" outranks any single test), the ACCEPT decision is made on all of
 * it, and autofix converges only when the whole list is empty. Per-section
 * env-gap/INFRA_GAP skip semantics and orphan-port recovery are unchanged.
 */
/**
 * Everything the run-end gate needs beyond the tree it is judging.
 *
 * An options object rather than a positional tail: the production call site read
 * `runFinalIntegrationGate(cwd, undefined, undefined, undefined, planText)`, and
 * `bootGraceMs`/`timeoutMs` are adjacent numbers that swap without a type error.
 *
 * `run`, `envClosure` and `trackedFiles` are SEAMS, by the same test GateDeps
 * states: a scenario needs to substitute them. `runGateCommand`,
 * `runVerifyCommandLine` and `rerunDebtVerifyCommand` each already take a
 * `CommandRunner`; this is the fourth and last driver in the file, and without it
 * the config-gap branch below is unreachable in test — not by oversight, but
 * because reaching it needs a git-tracked env template, so every launch-contract
 * test (bare `makeDir`, no `git init`) misses it by construction.
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
    const stat = runRepoHealthCheck(cwd)
    // Debts are derived once, before any section runs, and ride on every verdict
    // shape (GateTally.verdict): `reason` stays the mechanical failure because it
    // seeds the autofix child's prompt — run 11's fix child executed a recorded
    // claim as an instruction.
    const debts = await deriveOpenDebts(cwd, stat.ok)
    // Every section below RECORDS into the tally (failures ranked, the four
    // dynamic counters, the notes) and the verdict is assembled ONCE at the end —
    // see gate-tally.ts for what each method means.
    const tally = new GateTally()
    if (!stat.ok) tally.fail(`static checks: ${stat.reason}`)
    // Launch-contract diff (mx5 run 10 item 4): the design declared `migrate`/`seed`
    // scripts that fell through decompose and shipped missing, unchecked. Diff the
    // plan-time-extracted declared scripts against the manifest; a missing one is a
    // launch-surface defect. FP-safe: empty declared list (nothing grounded) → no check.
    //
    // THE DIFF IS INERT WITHOUT A MANIFEST (nexttask 16A). It used to diff against
    // `Object.keys(packageScripts(cwd))`, whose catch returns {} — so a project with
    // NO package.json was indistinguishable from one with no scripts, and every
    // declared script was reported missing in wording naming a file the project was
    // never meant to have. Nothing upstream is npm-shaped (the extractor scrapes any
    // design that says "script"), and this text seeds the autofix child's prompt, so
    // on a CMake/cargo project the likely repair was to write a package.json.
    // readLaunchManifest resolves package.json, else a Makefile's targets, else
    // nothing — and nothing means no failure plus a note, never a silent pass.
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
            const r = runGateCommand(cwd, cmd, timeoutMs, undefined, undefined, runCmd)
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
    // EXECUTE the launch contract (mx5 run 11): every declared script that is
    // neither boot-class (the boot check below owns those) nor already covered by
    // the integration commands above RUNS as a one-shot, in declared order —
    // existence is not launchability (`migrate`/`seed` shipped as first-call
    // TypeErrors while the gate checked only that they exist). The env-gap
    // contract extends to missing external INFRASTRUCTURE (no DB/daemon on this
    // box → skip, not fail); a skip whose script also carries a standing EXCUSE
    // note (F7) is surfaced as an UNOBSERVED warning — the note may be covering a
    // real defect the gate could not reach here (run 11's "pre-existing .rows
    // bug" note excused the exact scripts that shipped broken).
    if (declared.length > 0) {
        const covered = cmds.flatMap(([bin, args]) =>
            (bin === 'bun' || bin === 'npm') && args[0] === 'run' && args[1] ? [args[1]] : []
        )
        const skippedLaunch: string[] = []
        // A declared script the manifest doesn't expose is already a launch-contract
        // failure above; executing it too would double-report (pre-aggregation the
        // contract diff early-returned, so this loop could assume presence).
        // EXECUTION STAYS npm-ONLY. The diff above now also speaks Makefile (16A),
        // but the runner below is literally `bun run <name>`; on a Makefile project
        // `present` is empty, so every declared target is skipped rather than run
        // through the wrong tool. Widening the RUNNER is a separate lever with its
        // own A/B, not a free rider on an inertness fix.
        const present = new Set(Object.keys(packageScripts(cwd)).map(s => s.toLowerCase()))
        const scripts = packageScripts(cwd)
        // CONFIG-GAP INPUTS (mx5 run 20), read once: the tracked file list and the
        // union of every tracked env template's declared variables. Both empty on a
        // non-git tree or a tree with no template, which makes the whole check inert
        // — a project with no template gains no excuse. See launch-config-gap.ts.
        const closure = envClosure(cwd)
        const trackedForGap = closure.templates.length > 0 ? (trackedFilesFn(cwd) ?? []) : []
        const launchTimeout = Math.min(timeoutMs, 180_000)
        for (const name of runnableDeclaredScripts(declared, covered)) {
            if (!present.has(name.toLowerCase())) continue
            const cmd: HealthCommand = ['bun', ['run', name]]
            const label = `${cmd[0]} ${cmd[1].join(' ')}`
            tally.attempted(cmd[0])
            const r = runGateCommand(
                cwd,
                cmd,
                launchTimeout,
                INFRA_GAP_OUTPUT_RE,
                undefined,
                runCmd
            )
            if (r.outcome === 'skip') {
                if (r.spawnFailed) tally.spawnFailure(cmd[0])
                skippedLaunch.push(name)
                continue
            }
            tally.observed()
            if (r.outcome === 'fail') {
                // A CONFIG GAP IS NOT A CODE FAULT (mx5 run 20). The run died on
                // `bun run seed` exiting 1 because ADMIN_PHONE — which the project's
                // own `.env.example` DECLARES — is absent from this box, and the only
                // way to supply it is a gitignored `.env` the commit cannot contain.
                // Four static conditions (findLaunchConfigGap) plus one dynamic one:
                // re-run with the variables supplied as synthetic placeholders, and
                // reclassify ONLY if that exits 0. A script that fails for its own
                // reasons fails again with the values present and stays a FAIL — an
                // absent variable is not a licence to ignore an exit code the code
                // caused. Nothing is parsed from the child's stderr: the wording is
                // the project's, not the harness's.
                const gap = findLaunchConfigGap({
                    cwd,
                    script: name,
                    body: scripts[name] ?? null,
                    tracked: trackedForGap,
                    declared: closure.declared,
                    env: process.env
                })
                if (gap) {
                    const probe = runGateCommand(
                        cwd,
                        cmd,
                        launchTimeout,
                        INFRA_GAP_OUTPUT_RE,
                        probeEnv(runnerEnv(resolveRunner(cmd[0])), gap),
                        runCmd
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
    // Boot + render ALWAYS runs (mx5 run 13): it is independent of test results by
    // construction, and it carries the run's most load-bearing signal — earlier
    // failures no longer shadow it. Its failures rank FIRST in the aggregate.
    // A boot that never RAN is its own verdict (mx5 run 18 — see bootSkipVerdict);
    // it lives outside the tally's dynamic counters on purpose, so the test/build
    // commands that did run cannot cancel it.
    //
    // ZERO DISCOVERY IS UNOBSERVED, NEVER A PASS (see unobservedVerdict, and the
    // zero-attempts branch of GateTally.verdict). Nothing was discovered, so nothing
    // ran, so the blindness guard below (attempted === 0 → null) does not fire — and
    // this outcome used to be reported as `PASS — no integration command found
    // (statics passed)`, i.e. "we never checked" reading identically to "we checked
    // and it was fine". IAR1 shipped that verdict TWICE while carrying open
    // verify-FAIL debt (its .pi-tasks/TASK_AUTO_0001.md:31 and TASK_AUTO_0002.md:37).
    // The outcome stays `ok: true` (non-blocking, justified at unobservedVerdict) but
    // is labelled, trailed and carried as debt by the caller. It needs no new command
    // source, so unlike the harvest lever refuted at discoverIntegrationCommands it
    // cannot inject a fabricated failure. The inert-contract note rides on it too: a
    // non-npm project carrying a launch contract usually discovers no command either,
    // and that is exactly the run whose silence must not read as "the contract was
    // checked and was fine".
    //
    // This return sits AFTER the launch-script loop, not before it: it used to fire
    // first, so a DECLARED launch script never ran on a tree with no discoverable
    // integration command (found and left unfixed in f5d7110). "Nothing to observe"
    // is a fact about the tally — no attempt, no failure — not about discovery, and
    // asking the tally makes the two paths see the same state. It still returns
    // before the boot `else` branch and the post-boot closure scans, whose stage is a
    // statement about when they are meaningful.
    if (!boot && tally.silent()) return tally.verdict(debts)
    if (boot) {
        const label = `${boot[0]} ${boot[1].join(' ')}`
        tally.attempted(boot[0])
        const expectServer = detectsServedApp(cwd, planText)
        // Render check (mx5 runs 8/11): for a served app, load the live page in a
        // headless browser and judge the RENDERED DOM — curl can't run JS, so a
        // blank-mount app passed every prior "renders" check. Default to the real
        // probe; tests inject their own. runRenderCheck env-gap-SKIPs when no
        // browser exists, so a box without one never gets a false FAIL.
        // Authenticated deep-render check (mx5 run 17): the page above renders, so
        // now sign in with the account the project's own dotenv declares (the same
        // ADMIN_PHONE/ADMIN_PASSWORD the launch contract's seed step consumes) and
        // require the session to actually work. WEB-ONLY by construction — it hangs
        // off the served-app branch and never runs for C++, Godot, CLI or library
        // projects. It may only FAIL when the SERVER authenticated us; no browser,
        // no credentials, an undrivable form or rejected credentials all skip as
        // env gaps (judgeDeepSession).
        const bootDepsWithRender: BootDeps = {
            ...bootDeps,
            renderProbe: bootDeps.renderProbe ?? runRenderCheck,
            deepRenderProbe: bootDeps.deepRenderProbe ?? (url => runDeepRenderCheck(url, cwd)),
            preferredPort: bootDeps.preferredPort ?? (() => preferredDeclaredPort(cwd))
        }
        let b = await runBootCheck(cwd, boot, bootGraceMs, {
            expectServer,
            deps: bootDepsWithRender
        })
        if (b.outcome === 'orphan-port') {
            b = await recoverOrphanPort(cwd, boot, b, bootGraceMs, bootDepsWithRender, expectServer)
        }
        if (b.outcome !== 'skip') tally.observed()
        else if (b.spawnFailed) tally.spawnFailure(boot[0])
        tally.bootUnobserved(
            bootSkipVerdict({
                label,
                skipped: b.outcome === 'skip',
                expectServer
            })
        )
        if (b.outcome === 'fail') {
            // OBSERVED (nexttask 19A). Every path that produces `fail` here is a
            // probe that looked: the render judge saw an empty body, the deep
            // session saw the authenticated half dead, the enumerator saw no
            // listener, or the launch command itself exited non-zero. The one
            // condition that means "we could not look" — no ss/netstat/lsof, mx5
            // run 14 — returns PASS stamped UNOBSERVED and never reaches here
            // (`b0f90a7`, final-gate.ts `if (!canEnumerate) return passAndKill(…)`).
            tally.failObserved(`boot check: \`${label}\` ${b.detail}`, 0)
        } else if (b.outcome === 'orphan-port') {
            // Could not clear the port. Distinct HARNESS diagnosis, never a bare app
            // FAIL: name the port and (when known) the process squatting on it.
            const holder =
                b.port !== null ? (bootDeps.findPortHolder ?? defaultFindPortHolder)(b.port) : null
            const who =
                holder ? ` — held by an orphaned process (pid ${holder.pid}: ${holder.command})`
                : b.port !== null ? ` — port ${b.port} is held by another process`
                : ''
            tally.fail(
                `boot check: \`${label}\` could not bind: orphaned process / port already in use${who} (harness condition, not an app fault)`,
                0
            )
        } else if (b.outcome === 'pass') {
            tally.ran(label)
            // A listener that served, but whose page could not be OBSERVED to render
            // (no browser, undeterminable port) → UNOBSERVED warning, not a silent pass.
            if (b.renderNote) tally.warn(b.renderNote)
        }
    } else {
        // Nothing to boot — but if the reason is that the project's only launch
        // script was REJECTED as not-a-launch (2A), that is not the same thing as a
        // project with no launch surface, and it must not degrade into silence.
        const rejected = rejectedLaunchScript(cwd)
        if (rejected && detectsServedApp(cwd, planText)) {
            tally.bootUnobserved(
                `boot check: this project's only launch script (\`${rejected.name}\`) is not a `
                    + `launch — ${rejected.reason} — so nothing was started and the app was never `
                    + 'observed to run.'
            )
        }
    }
    // Full-skip blindness guard (mx5 run 16): commands were discovered but every
    // one skipped → rank-0 failure, never a static-only PASS. Runner resolvability
    // is checked through resolveRunner so the failure text can name the missing
    // runner when that is the cause (the run-16 shape: login-shell PATH lost bun).
    const gap = tally.blindness(b => resolveRunner(b).ok)
    if (gap) tally.fail(gap, 0)
    // The remaining run-level closure scans — "the shipped tree references or
    // requires something it does not contain" — after every dynamic section, so
    // their failures keep their historical place in the aggregate (CLOSURE_SCANS:
    // 'post-boot').
    runClosureScans('post-boot', {cwd, planText}, (t, r) => tally.fail(t, r))
    return tally.verdict(debts)
}
