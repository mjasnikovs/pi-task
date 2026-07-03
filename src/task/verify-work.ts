/**
 * Work verification for /task-auto.
 *
 * The root failure this addresses: pi-task never *runs* any verification. Each
 * task's composed spec carries a VERIFY block (and ACCEPTANCE criteria), but that
 * block is only authored and presence-checked — never executed. The task is then
 * marked `completed` at handoff. So a task whose implementation does not actually
 * work (a SPA that won't build, a route wired to a dead stub, a CI file nobody
 * runs) is indistinguishable from one that does.
 *
 * This pass closes that gap WITHOUT assuming any particular shape of project. It
 * does NOT hardcode `build`, an HTTP probe, a server boot, or a test command —
 * many tasks have none of those. Instead it hands the just-committed spec (GOAL /
 * ACCEPTANCE / VERIFY) to a fresh child of the SAME local model, gives it a `read`
 * and a `bash` tool in the real workspace, and lets the model do its job: run the
 * verification the spec already declares, observe the REAL output, and report a
 * PASS / FAIL verdict. If the spec's VERIFY is legitimately a no-op (config-only
 * change, re-read of a file), the model says so and that is a PASS.
 *
 * It must verify the REAL deliverable AS SHIPPED, not a run the verifier itself
 * prepared into passing. The failure class is broader than a bad VERIFY block: the
 * child has `bash`, so it can quietly make almost anything go green — export an env
 * var, source a config file, run a different command, rebuild in a scratch dir,
 * fabricate the artifact by hand — and then report PASS, masking a defect a fresh
 * checkout or CI run would hit. (This is exactly what sank an mx5 run: the verify
 * child `export`ed the test DB URL its own shell, watched the suite go green, and
 * passed a project whose documented command failed unaided.) The prompt therefore
 * anchors the child to ONE principle: run the project's own commands verbatim in the
 * tree as found, and treat any preparation/repair/substitution it had to perform to
 * reach green as ITSELF the defect — while still distinguishing a genuinely-absent
 * EXTERNAL service (an environment gap, not a code fault) from the project mis-wiring
 * how it connects. This generalises across languages and toolchains and assumes no
 * tests, build, or particular runtime.
 *
 * A/B-proven on the live local model (Qwen3.6-35B), 5 runs/arm on a work-around-to-pass
 * fixture (documented command fails unaided; greppable env file makes it pass): the old
 * prompt false-passed 2/5; the new prompt caught it 5/5, each time naming the unwired
 * config. Guards (3 runs/arm): a healthy project still PASSes 3/3 (no false-fail), a
 * genuinely-broken shipped build FAILs 3/3, and a genuine external-service gap — which
 * the OLD prompt wrongly blamed on the code 3/3 — now correctly PASSes 3/3.
 *
 * The sibling failure class is GREP-THEATER (mx5 run 2, TASK_0002): the composed VERIFY
 * block was grep-only, so the child "verified" a schema.sql containing INVALID SQL by
 * grepping for its own broken text — while a live PostgreSQL sat reachable in the same
 * container, never touched. The prompt now (a) says a grep-only VERIFY block does not cap
 * the obligation to execute/apply an executable artifact, and (b) requires PROBING a
 * declared external service before invoking the absent-service exception — reachable ⇒
 * the real verification must run against it. A/B on the faithful fixture (invalid
 * `generate always as` schema, grep-only VERIFY, unadvertised trust-auth PostgreSQL on
 * the default port, DATABASE_URL unset — exactly the mx5 shape): old prompt false-PASSed
 * 4/5; new prompt FAILed 5/5, each naming the real syntax error. Guards: explicit-URL
 * variant old 5/5 / new 5/5 correct-FAIL (no regression), valid schema 3/3 PASS (no
 * paranoia), unreachable-DB 2/3 PASS via the env-gap exception + 1 conservative FAIL
 * that still named the genuine SQL defect (safe direction — only false-PASS trashes work).
 *
 * It runs as a GATE right after the implementation turn, BEFORE the task is
 * checked off or committed. A FAIL stops the /task-auto run exactly like an
 * implementation failure: the task is left unchecked and uncommitted so
 * /task-auto-resume re-runs it, rather than blessing work that does not run.
 *
 * Tools: `read` + `bash` only. No `edit`/`write` — verification observes, it does
 * not fix (fixing committed work is the enforcement pass's job, and a verify pass
 * that also edits would blur "did it work" with "make it work"). `bash` is what
 * makes this real: it is the difference between reading the VERIFY block and
 * RUNNING it.
 *
 * Gated by the `verifyWork` config flag. With the flag off, or with no spec to
 * verify, this is a pass (ok: true).
 */
import {USER_CANCELLED} from './child-runner.js'

/**
 * The verification child gets exactly two tools: `read` and `bash`.
 *
 *  - `bash` IS the point: it lets the child actually execute the spec's VERIFY
 *    commands (or whatever check the ACCEPTANCE criteria imply) and see the real
 *    exit codes and output, rather than reasoning about whether the code "looks"
 *    correct.
 *  - `read` lets it inspect a file the VERIFY output points at (a build error's
 *    source line, a config it just validated) to characterise a failure precisely.
 *  - No `edit`/`write`: this pass reports a verdict, it does not change the tree.
 *    Keeping it read-only means a verify run can never itself introduce a change
 *    that needs re-verifying, and never scaffolds the junk-file runaway that the
 *    enforce pass had to drop `write` to stop.
 */
const VERIFY_TOOLS = 'read,bash'

export interface VerifyOutcome {
    /** true → the work verified (or verification disabled / nothing to verify).
     *  false → the child reported the work does NOT satisfy its spec, or the pass
     *  could not run / produced no verdict. */
    ok: boolean
    /** Short, human-readable reason. Always set when ok === false; on the pass
     *  path set to the no-op cause ('disabled', 'no spec to verify'). */
    reason?: string
}

/**
 * Slice the delivered spec (GOAL / CONSTRAINTS / ACCEPTANCE / VERIFY) out of a
 * task file body. The composed spec lives under a `## spec` header and runs until
 * the next top-level `## ` section (`## phase timings`). Returns null when no spec
 * section is present (e.g. a task that never reached compose), which the caller
 * treats as a pass — there is nothing to verify against.
 */
export function extractSpecForVerification(taskBody: string): string | null {
    const lines = taskBody.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
        if (/^##\s+spec\s*$/i.test(lines[i])) {
            start = i + 1
            break
        }
    }
    if (start === -1) return null
    let end = lines.length
    for (let i = start; i < lines.length; i++) {
        if (/^##\s+\S/.test(lines[i])) {
            end = i
            break
        }
    }
    const spec = lines.slice(start, end).join('\n').trim()
    return spec.length > 0 ? spec : null
}

/**
 * Build the verification child's prompt. Kept pure so the wording is unit-tested
 * without spawning pi. The contract: run the spec's own verification in the real
 * workspace, judge against ACCEPTANCE, and end on exactly one verdict line.
 *
 * `probeFindings` are the deterministic self-verification probe results (see
 * substitution-probe.ts): the TEST-THE-COPY class is caught 5/5 only when the
 * prompt carries both the rule (3b) AND a concrete finding naming the suspect
 * file — the rule alone got 2/5 attention on the live model. The findings are
 * pure git shape (test files the task itself changed), so the mandate is
 * language- and framework-agnostic.
 */
export function buildVerifyPrompt(spec: string, probeFindings?: string[]): string {
    const probeBlock =
        probeFindings && probeFindings.length > 0 ?
            [
                'SELF-VERIFICATION NOTICE (deterministic, computed by the orchestrator from the diff):',
                'this task wrote or changed the very tests whose green result would bless it:',
                ...probeFindings.map(f => `- ${f}`),
                'A green run of self-authored tests is NOT sufficient verification. Before any PASS',
                'you MUST confirm these tests exercise the REAL shipped artifact: drive 1-2 tested',
                'behaviors directly against the real app / module / entry point and judge what IT',
                'returns. Tests that intercept, re-implement, or stub the artifact prove only the',
                'copy (rule 3b below).',
                ''
            ]
        :   []
    return [
        'You are a strict verification pass running right after an AI coding agent',
        'finished a task and committed it. The agent is known to mark work "done"',
        'without ever running it, so DO NOT trust that the implementation works —',
        'prove it by running the verification this task ships with.',
        '',
        'You have a `read` tool and a `bash` tool — nothing else. You can run any',
        'command and read any file, but you CANNOT edit or create files. Your job is',
        'to VERIFY, not to fix.',
        '',
        'THE TASK SPEC (its ACCEPTANCE criteria and VERIFY block are the contract):',
        spec.trim(),
        '',
        ...probeBlock,
        'How to verify — verify the REAL, shipped deliverable exactly as an unaided fresh',
        'checkout (or CI run) would experience it:',
        '',
        "1. Run the project's OWN commands — the verbatim scripts / targets / binaries it",
        '   ships (package.json scripts, Makefile targets, the command the spec names) —',
        '   exactly as written, in the workspace as you found it. Judge the artifact or',
        "   output they actually PRODUCE. The project's own command and its real output are",
        "   the bar; also run the spec's VERIFY block, but it does not override that bar.",
        '',
        '2. Do NOT prepare, repair, reconfigure, or stand in for the run to make a check',
        '   pass. Concretely, to reach a green result you must NOT: set or export an',
        '   environment variable, source an env file, add or change a flag, edit or replace',
        '   the command, install or add a dependency / plugin / import / config the project',
        '   lacks, create or pre-populate files or state by hand, or rebuild / compile in a',
        '   scratch dir or with options the project does not itself use. If a check only goes',
        '   green AFTER you intervene like that, then the very thing you had to do IS the',
        '   defect: the project does not work as shipped. Report FAIL and name the missing or',
        '   broken wiring exactly (e.g. "shipped command `<cmd>` fails unaided because <why>").',
        '',
        '3. Presence of a token / directive / string in a SOURCE file is NOT verification.',
        '   Judge the produced artifact and the real runtime behavior. A raw build directive',
        '   that SURVIVES into the built output means the build never ran — that is a FAIL.',
        "   The spec's VERIFY block does not cap this obligation: if that block only greps or",
        '   reads source files but the deliverable can be EXECUTED or APPLIED on this machine',
        '   (a script, a schema, a server, a config a tool can load), you must ALSO execute or',
        '   apply it and judge the real result. Grep-only checks passing while the artifact was',
        '   never executed is NOT a PASS — a static match cannot prove an artifact works, only',
        '   running it can.',
        '',
        '3b. SUBSTITUTION: a test suite (or any check) shipped by the work counts as verification',
        "   ONLY if it exercises the real shipped code paths. If the work's own tests re-implement",
        '   logic inline, intercept or stub the artifact behind their own server or handlers, or',
        '   import the real module and then never call it, a green suite proves only the copy —',
        '   NOT the deliverable. Spot-check this: pick 1-2 tested behaviors and drive the REAL',
        '   shipped artifact directly (the real app / module / entry point). If the real artifact',
        '   fails where the tests pass, report FAIL and name the bypass.',
        '',
        '4. Treat the ACCEPTANCE criteria as the bar. If a command fails, or its real output',
        '   contradicts an ACCEPTANCE criterion, the work has NOT verified.',
        '',
        '5. The ONLY thing you may assume is already provided is a genuinely EXTERNAL running',
        '   service or network resource (a database server, an API host) that the project',
        '   documents as a prerequisite. Before you rely on that assumption, PROBE for the',
        '   service with a cheap real check using the connection details the project/spec',
        '   already declares (attempt the connection: pg_isready, a client one-liner, curl',
        '   with a short timeout). If the probe shows the service IS reachable, the exception',
        '   does NOT apply — you must run the real verification against it (apply the schema,',
        '   run the suite, hit the endpoint) and judge the real result; falling back to static',
        '   checks with the service available is NOT verification. Only if a command fails',
        '   purely because such an external service is genuinely ABSENT from this machine —',
        '   and NOT because the project misconfigures how it connects — note that as an',
        '   environment gap and judge the rest; do not fail the code for it. But a command',
        '   that fails because of how the PROJECT ITSELF is wired (config it owns but does',
        '   not load, a wrong default, a command that cannot run unaided) is a defect, not an',
        '   environment gap.',
        '',
        '5b. EXTERNAL SERVICE STATE IS PART OF "AS SHIPPED": you may probe and read an external',
        '   service, but you must NOT create, alter, or repair its schema or data to make the',
        '   artifact work — no ALTER TABLE, CREATE TABLE, manual INSERT/UPDATE fixes, or ad-hoc',
        "   DDL. You may apply only the project's OWN migration/schema files, exactly as shipped.",
        "   If the shipped code needs schema or data that the project's own files do not create,",
        '   that is a FAIL naming the gap. Any schema surgery you performed to reach green IS the',
        '   defect.',
        '',
        '6. If the spec legitimately has no runnable verification (a pure docs / config change',
        '   with nothing to build or run), validating it cleanly is a PASS.',
        '',
        '7. Do NOT edit anything to make a check pass. Report what you actually saw.',
        '',
        'VERDICT DISCIPLINE: the verdict must follow mechanically from your findings. If ANY',
        'acceptance criterion is unmet — a required function absent, required data not persisted,',
        'a required behavior missing — the verdict is FAIL, even if typecheck and lint are green',
        'and even if the gap seems minor. Never downgrade an unmet criterion to a warning note.',
        '',
        'When you are done, output EXACTLY ONE of these as the final line:',
        "  WORK-VERIFIED: PASS              (the project's own command, run unaided, met the spec)",
        '  WORK-VERIFIED: FAIL <text>      (the shipped command failed or did not meet the spec; say what failed)',
        'Output the verdict line verbatim — it is parsed mechanically.'
    ].join('\n')
}

/**
 * Parse the child's verdict. Scans for the LAST `WORK-VERIFIED: PASS|FAIL` marker
 * (the model discusses before concluding, and bash output may echo the word
 * "VERIFY", so a distinct token and last-match win matter).
 *
 * No marker at all is NOT a pass: a verification that cannot state a verdict is a
 * gray area, and the contract is that unverified work is reported as such.
 */
export function parseVerifyVerdict(text: string): {pass: boolean; detail: string} {
    const re = /WORK-VERIFIED:\s*(PASS|FAIL)\b[ \t]*(.*)/gi
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) return {pass: false, detail: 'no verdict emitted'}
    const pass = last[1].toUpperCase() === 'PASS'
    return {pass, detail: pass ? '' : last[2].trim() || 'unspecified failure'}
}

export interface VerificationDeps {
    cwd: string
    signal?: AbortSignal
    /** The composed spec (GOAL/ACCEPTANCE/VERIFY) of the task just committed. When
     *  null/empty the pass is a no-op (ok: true). */
    spec: string | null
    /** Runs the verification child and returns its assistant text. Injected so
     *  the orchestrator wires the real child runner and tests use a fake. */
    runChild: (tools: string, prompt: string, signal?: AbortSignal) => Promise<string>
    /**
     * DETERMINISTIC whole-repo static-analysis gate (see repo-health-check.ts). Runs
     * the project's OWN lint/typecheck command and lets its real exit code decide —
     * independent of the model-authored VERIFY block, so a repo-wide lint failure can
     * never be narrowed away to "not my files". A non-zero result short-circuits to a
     * FAIL (the existing verify-FAIL outcome → the AUTOFIX/ACCEPT/dismiss picker).
     * Injected so tests fake it; ABSENT → skipped (a pass), keeping the pass path a
     * pure no-op for callers/tests that do not wire it. */
    repoHealth?: () => Promise<{ok: boolean; reason: string}>
    /**
     * DETERMINISTIC substitution probe (see substitution-probe.ts): scans the task's
     * changed test files for test-the-copy shapes and returns finding lines to inject
     * into the child's prompt. A/B-proven load-bearing: the prompt rule alone caught
     * the class 2/5, rule + probe finding 5/5. ABSENT or empty → no probe block. */
    probe?: () => Promise<string[]>
}

/**
 * Run the verification pass for one task. A missing spec is a pass. Otherwise run
 * the child against the real workspace and turn its verdict into an ok/blocked
 * outcome. Never throws (except a user cancel, which propagates so the loop's
 * USER_CANCELLED handler reports a clean "cancelled — resume").
 */
export async function runWorkVerification(deps: VerificationDeps): Promise<VerifyOutcome> {
    // DETERMINISTIC gate FIRST: run the project's own whole-repo static analysis and
    // let its exit code decide, before spending a model turn. This catches the class
    // the model gate misses — a task whose composed VERIFY block never lints (proven
    // 5/5 false-PASS live) — because it does not depend on that block. A fail is the
    // ordinary verify-FAIL outcome, so it flows into the existing resolution picker.
    // Absent dep, or a no-op result (no tooling to run), falls through to the model.
    if (deps.repoHealth) {
        const h = await deps.repoHealth()
        if (!h.ok) return {ok: false, reason: `repo health: ${h.reason}`}
    }
    if (!deps.spec || deps.spec.trim().length === 0) {
        return {ok: true, reason: 'no spec to verify'}
    }
    // Substitution probe findings feed the prompt; a probe failure must never block
    // verification (it is an optional sharpener, the gate still runs without it).
    let findings: string[] = []
    if (deps.probe) {
        try {
            findings = await deps.probe()
        } catch {
            findings = []
        }
    }
    // A child that emits NO verdict never judged the work (budget/context death mid-
    // investigation — seen live: an 11-minute verify wandered, died verdict-less, and
    // the resulting FAIL burned a full implementation re-run on an unjudged artifact).
    // That is a verify-side fault, so retry the VERIFY once before reporting a FAIL.
    for (let attempt = 1; ; attempt++) {
        let text: string
        try {
            text = await deps.runChild(
                VERIFY_TOOLS,
                buildVerifyPrompt(deps.spec, findings),
                deps.signal
            )
        } catch (err) {
            if (err instanceof Error && err.message === USER_CANCELLED) throw err
            const msg = err instanceof Error ? err.message : String(err)
            return {ok: false, reason: `verification pass could not run: ${msg}`}
        }
        const verdict = parseVerifyVerdict(text)
        if (verdict.pass) return {ok: true}
        if (verdict.detail === 'no verdict emitted' && attempt === 1) continue
        return {
            ok: false,
            reason: `work did not verify: ${verdict.detail}${
                verdict.detail === 'no verdict emitted' ? ' (after verify retry)' : ''
            }`
        }
    }
}

export {VERIFY_TOOLS}
