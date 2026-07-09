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
import {buildEnvNotesBlock, ENV_NOTE_EMIT_INSTRUCTION, extractEnvNotes} from './env-notes.js'
import {buildContractsVerifyBlock} from './contracts.js'
import {findSkipEscapes, skipEscapeVerifyFindings} from './skip-escape.js'

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
    /** True when the FAIL is specifically an UNOBSERVED outcome (rule 5c): a
     *  spec-required behavioral check could not run because its tooling is absent.
     *  The gate routes this straight to the human picker instead of an unattended
     *  AUTOFIX re-run, which cannot provision a missing tool. Only meaningful when
     *  ok === false. */
    unobserved?: boolean
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
 * file — the rule alone got 2/5 attention on the local model. The findings are
 * pure git shape (test files the task itself changed), so the mandate is
 * language- and framework-agnostic.
 *
 * `prohibitionFindings` are the deterministic prohibition probe results (see
 * prohibition-probe.ts): spec-forbidden paths the task's diff modified anyway.
 * Same probe+rule design, same reason: the VIOLATION-EXCUSAL class (mx5 run 7:
 * child saw "Do NOT modify server-side code" violated, waived it as "additive,
 * tests pass", PASSed) needs both the no-waiver rule (4b) AND the concrete diff
 * fact — the baseline child usually never runs `git diff` at all, so without the
 * finding it cannot even SEE the violation. A/B on the live local model
 * (violated-but-working fixture, everything green, forbidden file modified
 * additively): old prompt 5/5 false-PASS (several runs affirmatively claimed the
 * forbidden file was untouched); rule+finding 5/5 FAIL naming the constraint.
 * Guard: honest-clean fixture (prohibition in spec, probe silent) 5/5 PASS — no
 * paranoia. Reverted-violation ≡ clean at the diff level (no entry → no finding).
 */
export function buildVerifyPrompt(
    spec: string,
    probeFindings?: string[],
    envNotes?: string,
    prohibitionFindings?: string[],
    skipEscapeFindings?: string[],
    contracts?: string,
    testAssemblyFindings?: string[],
    probeGamingFindings?: string[]
): string {
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
    const prohibitionBlock =
        prohibitionFindings && prohibitionFindings.length > 0 ?
            [
                'PROHIBITION NOTICE (deterministic, computed by the orchestrator from the',
                "spec's own constraint lines and the task's diff): this task MODIFIED paths",
                'the spec explicitly forbids modifying:',
                ...prohibitionFindings.map(f => `- ${f}`),
                'Read the exact constraint wording in the spec. Unless that wording itself',
                'states an exception that covers this change, this is a violated prohibition:',
                'rule 4b applies and the verdict is FAIL naming the forbidden path — even if',
                'every test passes and the change looks harmless.',
                ''
            ]
        :   []
    const probeGamingBlock =
        probeGamingFindings && probeGamingFindings.length > 0 ?
            [
                'CHECK-GAMING NOTICE (deterministic, computed by the orchestrator from the',
                "task's diff): these added lines state their own purpose is to make a CHECK",
                'pass (a test / verification / lint / gate), not to meet the requirement the',
                'check stands for:',
                ...probeGamingFindings.map(f => `- ${f}`),
                'A check is a MESSENGER for a requirement. Code written to quiet the messenger',
                'instead of meeting the requirement is a defect even when the check is green',
                '(run-8 F6: a handler returned 401 "so the verification test passes" while the',
                'real route stayed dead). Do NOT accept the passing check as proof. Read each',
                "line's surrounding code and confirm the UNDERLYING requirement is genuinely",
                'met — drive the real behavior directly (rule 4c). If the code only exists to',
                'satisfy the check while the requirement is unmet, that is a FAIL naming the',
                'gamed check and the unmet requirement.',
                ''
            ]
        :   []
    const skipEscapeBlock =
        skipEscapeFindings && skipEscapeFindings.length > 0 ?
            [
                "SKIP-ESCAPE NOTICE (deterministic, computed by the orchestrator from the spec's",
                'OWN VERIFY block): these VERIFY commands wrap a required check in a fallback that',
                'ANNOUNCES skipping it when a tool is absent — so the check can "pass" while never',
                'actually running:',
                ...skipEscapeFindings.map(f => `- ${f}`),
                'Do NOT accept a skipped check as a passed check. For each, determine whether it',
                'ACTUALLY ran and observed the real behavior. If its tool is absent so the required',
                'behavior was never observed, that area is UNOBSERVED (rule 5c) — verdict UNOBSERVED,',
                'not PASS. Only if you observe the required behavior another way (running the real',
                'artifact directly) may it count as verified.',
                ''
            ]
        :   []
    const testAssemblyBlock =
        testAssemblyFindings && testAssemblyFindings.length > 0 ?
            [
                'TEST-ASSEMBLY NOTICE (deterministic, computed by the orchestrator from pure',
                'import-graph shape): these test files rebuild production WIRING — they import the',
                'same leaf modules the shipped entry composes and assemble their OWN copy of it,',
                'instead of importing the production assembly:',
                ...testAssemblyFindings.map(f => `- ${f}`),
                'A green result on such a test proves that PRIVATE re-assembly, NOT the shipped',
                'wiring — the copy can be wired differently (a different mount prefix, order, or',
                'middleware) and pass while production is broken exactly at the seam the test was',
                'meant to cover (rule 3f below). Before you count the covered area verified, drive',
                'the behavior against the REAL shipped assembly/entry named above (start or invoke',
                "the production entry point, not the test's hand-built app). If the real assembly",
                'fails where the test passes, report FAIL and name the wiring seam.',
                ''
            ]
        :   []
    const envBlock = envNotes && envNotes.trim().length > 0 ? [buildEnvNotesBlock(envNotes)] : []
    const contractsBlock =
        contracts && contracts.trim().length > 0 ? [buildContractsVerifyBlock(contracts)] : []
    return [
        'You are a strict verification pass running right after an AI coding agent',
        'finished a task and committed it. The agent is known to mark work "done"',
        'without ever running it, so DO NOT trust that the implementation works —',
        'prove it by running the verification this task ships with.',
        '',
        'You have a `read` tool and a `bash` tool — nothing else. You can run any',
        'command and read any file. Your job is to VERIFY, not to fix: never modify',
        'the project tree (rule 3d governs the scratch files a probe may need).',
        '',
        'THE TASK SPEC (its ACCEPTANCE criteria and VERIFY block are the contract):',
        spec.trim(),
        '',
        ...envBlock,
        ...contractsBlock,
        ...probeBlock,
        ...prohibitionBlock,
        ...probeGamingBlock,
        ...skipEscapeBlock,
        ...testAssemblyBlock,
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
        '3c. TEST-AUTHORED REPAIR: rule 2 applies INSIDE the shipped test suite too. Before',
        '   trusting a green suite, READ its setup/bootstrap (beforeAll / fixtures / helpers /',
        '   conftest). Seeding ordinary test DATA is fine — but if the setup changes the',
        "   product's STRUCTURE or wiring to make the code runnable (ALTER TABLE / adding",
        "   columns, tables, or config that the project's own migrations and setup files never",
        '   create; monkey-patching or stubbing shipped code), the suite is repairing the',
        '   product in order to pass: its green result proves the repaired copy, NOT the',
        "   shipped artifact. Cross-check against the project's own provisioning: apply ONLY",
        "   the project's own setup commands (its migrations / seed scripts) to a scratch",
        '   database and check whether the tested behaviors are possible on what THEY produce.',
        '   If the tests patched a gap, report FAIL and name the missing production-side',
        '   change (e.g. the column no migration creates).',
        '',
        '3d. SELF-SUBSTITUTION: rules 3b/3c bind YOU as well. A small throwaway probe',
        '   script is fine, but it must (a) live in the system temp directory (/tmp),',
        '   NEVER inside the repository worktree, and (b) exercise the REAL shipped',
        '   artifact — import/require the real module, run the real entrypoint, hit the',
        "   real server. You must NEVER re-implement, copy, or paraphrase the artifact's",
        '   logic into a scratch file and test that copy: a green result on your own',
        '   copy proves only the copy, exactly like rule 3b. If the real artifact cannot',
        '   be exercised as shipped — its imports fail, the module will not load, the',
        '   server never starts, no entrypoint exists — that inability IS the defect:',
        '   report FAIL naming it. Do not stand up a substitute to get to green.',
        '',
        '3e. NEGATIVE CONTROL IS MANDATORY — a success you cannot make fail is not evidence,',
        '   and a check that only ever ran on the RIGHT input has not been shown to',
        '   discriminate working from broken. For EACH behavioral check whose passing outcome',
        '   you rely on (an endpoint returned success, a command exited 0, a call returned the',
        '   expected value) you MUST also run that SAME check with one input deliberately',
        '   wrong — a nonsense path, a bogus flag or subcommand, a malformed or absent',
        '   argument, a target that does not exist — recreating whatever setup the check needs',
        '   to do so (restart the server if a prior step killed it, re-invoke the command).',
        '   Require a DIFFERENT, failing outcome from the wrong input. If the wrong input',
        '   yields the SAME success (same status code, same body, same exit 0), the check',
        '   cannot tell working from broken: it is VOID and the behavior it was meant to prove',
        '   is UNVERIFIED — a FAIL naming the indiscriminate check (e.g. "a POST to a nonsense',
        '   path returns the same 200 and body as the real endpoint, so the route is unproven',
        '   — a catch-all fallback is masking it"). Skipping the control is not neutral: a',
        '   required behavior left without a discriminating check is UNVERIFIED, and',
        '   unverified is a FAIL, never a PASS. A wrong-input control exists for every',
        '   artifact — HTTP request, CLI invocation, library call, schema load, config parse.',
        '',
        '3f. TEST-REBUILT ASSEMBLY: a test proves only the copy if it RE-CONSTRUCTS wiring that',
        '   also exists in production — assembling its own app / entry point / config out of the',
        '   same leaf modules the shipped entry composes, instead of importing and exercising the',
        '   production assembly. Such a test can wire the leaves differently from production (a',
        '   different prefix, order, adapter, or middleware) and pass green while the SHIPPED',
        '   wiring is broken at exactly the seam the test was meant to cover — its green result',
        '   never touched the production assembly at all. Whenever a spec-required behavior is',
        '   covered ONLY by tests that build their own composition of the real modules, that',
        '   behavior is UNVERIFIED off those tests: exercise the REAL shipped entry/assembly (run',
        '   or invoke the production entry point, hit the real composed surface) and judge THAT.',
        '   If the real assembly fails where the copy passes, report FAIL naming the wiring seam',
        '   (e.g. "the entry mounts <module> at <X> but the test mounts it at <Y>, so the real',
        '   path is dead while the test is green").',
        '',
        '4. Treat the ACCEPTANCE criteria as the bar. If a command fails, or its real output',
        '   contradicts an ACCEPTANCE criterion, the work has NOT verified.',
        '',
        '4b. SPEC PROHIBITIONS ARE PART OF THE BAR — YOU HAVE NO WAIVER AUTHORITY: when the',
        '   spec explicitly forbids something ("Do NOT modify X", "MUST NOT touch Y") and the',
        '   shipped work does it anyway, that is a FAIL naming the violated constraint. You',
        '   may not excuse a violation because it is additive, small, harmless, an improvement,',
        '   or because every test still passes — "it works anyway" is exactly the waiver you do',
        "   not have; relaxing a constraint is the spec owner's call, not yours. Check the",
        "   task's own diff (git) against the spec's prohibitions — a forbidden file can be",
        '   modified without any test noticing. Only two outcomes are not a FAIL: the',
        '   violation was fully REVERTED (the shipped tree no longer violates), or the',
        '   prohibition\'s own wording states an exception ("except…", "beyond what is needed',
        '   for…") that covers the change — judged against that stated exception, not against',
        '   your view of harmlessness.',
        '',
        '4c. THE CHECK IS THE MESSENGER, NOT THE REQUIREMENT — code (or a comment) whose',
        '   stated purpose is to make a check PASS, rather than to satisfy the requirement the',
        '   check stands for, is a defect even when the check is green. The tell is the intent',
        '   written down: "return X so the test passes", "hardcode this to satisfy the linter",',
        '   "stub it out to appease CI". When you see such a line — or the CHECK-GAMING NOTICE',
        '   above names one — do NOT treat the passing check as proof the requirement is met.',
        '   Find the actual requirement the check was meant to prove and verify THAT directly',
        '   against the real artifact (rule 3e negative control is the sharpest tool: a handler',
        '   that answers the check-shaped request the same way for a WRONG input is gaming the',
        '   check, not implementing the behavior). If the requirement is genuinely unmet while',
        '   the check passes, the verdict is FAIL naming the gamed check and the real gap.',
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
        '5c. A SPEC-REQUIRED CHECK THAT DID NOT ACTUALLY RUN IS NOT VERIFIED. The env-gap',
        '   exception (rule 5) covers ONLY a genuinely EXTERNAL service the finished product',
        "   connects to (a database, an API host). It does NOT cover a check the SPEC's own",
        "   VERIFY block authored to OBSERVE the deliverable's required behavior. If such a",
        '   check did not actually execute — the tool or runner it needs is not installed, or',
        '   the VERIFY line short-circuits ITSELF with a skip-escape (`|| true`, `|| echo',
        '   skipping`, `2>/dev/null || exit 0`, `command -v X ||` …) so a missing tool passes',
        '   silently — then that behavior was NEVER OBSERVED. A skipped check is not a passed',
        '   check: you may not count the area as verified, and "correctly skipped" is NOT a',
        "   PASS. Do not let the work's own skip-escape waive the work's own gate. When a",
        '   REQUIRED behavior could not be observed because its observation tooling is absent,',
        '   the verdict is UNOBSERVED — report exactly what could not be observed and which',
        '   tool was missing, so a human decides whether to provision the tool or accept the',
        '   unproven behavior.',
        '   DISCRIMINATOR (rule 5 vs rule 5c) — when something needed is absent, ask which it',
        '   is: (rule 5, env-gap, do NOT fail the code) a SERVICE the FINISHED PRODUCT itself',
        '   connects to at runtime to FUNCTION — a database, an API host, a message broker —',
        '   whose absence is an environment gap; versus (rule 5c, UNOBSERVED) a HARNESS that',
        '   exists only to OBSERVE or DRIVE the product during a check — a browser driver, a',
        "   UI/terminal smoke, a snapshot or fuzz tool — whose absence leaves the product's own",
        '   behavior unproven. The product NEEDS the former to work at all; it needs the latter',
        '   only to be CHECKED. A command that fails because such a runtime SERVICE is absent',
        '   stays a rule-5 env-gap and is NOT UNOBSERVED; a required behavior you could not',
        '   OBSERVE because its test harness is absent IS UNOBSERVED.',
        '',
        '6. If the spec legitimately has no runnable verification at all (a pure docs / config',
        '   change with nothing to build or run), validating it cleanly is a PASS. This is NOT',
        '   the same as a required behavioral check that self-skipped or whose tool is absent',
        '   (that is UNOBSERVED, rule 5c) — "nothing to verify" means the spec never demanded',
        '   an observation, not that an observation was demanded and then dodged.',
        '',
        '7. Do NOT edit anything to make a check pass. Report what you actually saw.',
        '',
        'VERDICT DISCIPLINE: the verdict must follow mechanically from your findings. If ANY',
        'acceptance criterion is unmet — a required function absent, required data not persisted,',
        'a required behavior missing — the verdict is FAIL, even if typecheck and lint are green',
        'and even if the gap seems minor. Never downgrade an unmet criterion to a warning note.',
        'Before concluding PASS, confirm every behavioral check you relied on has its paired',
        'negative control (rule 3e) showing it CAN fail; a required behavior with no',
        'discriminating check is UNVERIFIED, and the verdict is FAIL.',
        '',
        ENV_NOTE_EMIT_INSTRUCTION,
        '',
        'When you are done, output EXACTLY ONE of these as the final line:',
        "  WORK-VERIFIED: PASS              (the project's own command, run unaided, met the spec)",
        '  WORK-VERIFIED: FAIL <text>      (the shipped command failed or did not meet the spec; say what failed)',
        '  WORK-VERIFIED: UNOBSERVED <text> (a spec-required behavioral check could not run because',
        '                                    its observation tooling is absent — the behavior is',
        '                                    unproven, not passed and not a code failure; rule 5c)',
        'Output the verdict line verbatim — it is parsed mechanically.'
    ].join('\n')
}

/**
 * Parse the child's verdict. Scans for the LAST `WORK-VERIFIED: PASS|FAIL|UNOBSERVED`
 * marker (the model discusses before concluding, and bash output may echo the word
 * "VERIFY", so a distinct token and last-match win matter).
 *
 * UNOBSERVED (rule 5c) is a distinct third outcome: a spec-required behavioral check
 * could not run because its observation tooling is absent, so the behavior is neither
 * proven nor shown broken. It is NOT a pass (`pass: false`) but carries `unobserved`
 * so the gate can route it straight to the human — an unattended AUTOFIX re-run cannot
 * provision a missing tool, so it must never auto-loop on this.
 *
 * No marker at all is NOT a pass: a verification that cannot state a verdict is a
 * gray area, and the contract is that unverified work is reported as such.
 */
export function parseVerifyVerdict(text: string): {
    pass: boolean
    unobserved?: boolean
    detail: string
} {
    const re = /WORK-VERIFIED:\s*(PASS|FAIL|UNOBSERVED)\b[ \t]*(.*)/gi
    let last: RegExpExecArray | null = null
    for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m
    if (!last) return {pass: false, detail: 'no verdict emitted'}
    const kind = last[1].toUpperCase()
    if (kind === 'PASS') return {pass: true, detail: ''}
    if (kind === 'UNOBSERVED') {
        return {
            pass: false,
            unobserved: true,
            detail: last[2].trim() || 'a required behavior could not be observed'
        }
    }
    return {pass: false, detail: last[2].trim() || 'unspecified failure'}
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
    /**
     * DETERMINISTIC prohibition probe (see prohibition-probe.ts): spec-forbidden
     * paths the task's diff modified anyway, injected as prompt findings under the
     * no-waiver rule (4b). Advisory, never auto-FAIL — real prohibitions can be
     * conditional prose. ABSENT or empty → no prohibition block. */
    prohibitionProbe?: () => Promise<string[]>
    /**
     * DETERMINISTIC test-assembly probe (see test-assembly.ts): authored test files
     * that rebuild production WIRING — importing the leaf modules the shipped entry
     * composes and assembling their own copy instead of the real assembly — become
     * prompt findings under rule 3f (F4 test-the-copy, 3rd recurrence). Pure import-
     * graph shape; the child then drives the real assembly before trusting the copy.
     * ABSENT or empty → no test-assembly block. */
    testAssemblyProbe?: () => Promise<string[]>
    /**
     * DETERMINISTIC probe-gaming probe (see probe-gaming.ts, run-8 F6): added lines
     * in the task's diff whose stated purpose is to make a CHECK pass instead of
     * meeting the requirement it stands for ("return 401 so the verification test
     * passes"). Injected as findings under rule 4c so the child confirms the
     * underlying requirement is genuinely met rather than trusting the green check.
     * Pure diff-text analysis; ABSENT or empty → no probe block. */
    probeGamingProbe?: () => Promise<string[]>
    /**
     * Result of the git-state guard for the MOST RECENT runChild call (see
     * git-state-guard.ts): did the child mutate repo state (stash/checkout/file
     * rewrites), which the guard then restored? A verdict computed on a mutated
     * tree is untrustworthy in BOTH directions — the mx5 run 6 child stashed the
     * work away and judged an empty tree — so it is discarded: the first mutated
     * run is retried once on the restored tree; a second mutation is a FAIL that
     * names the behavior. ABSENT → no guard (tests / non-git repos), unchanged. */
    mutationCheck?: () => {mutated: boolean; detail: string}
    /**
     * Per-run environment-facts cache (see env-notes.ts): `read` supplies the
     * facts earlier gate children discovered (inlined into the prompt with the
     * no-waiver caveat); `append` stores the `ENV-NOTE:` lines this child
     * emitted, host-side. ABSENT → no block, no capture (tests unchanged).
     * Facts only cut re-discovery time; verdict rules are unaffected.
     */
    envNotes?: {
        read: () => Promise<string>
        append: (notes: string[]) => Promise<void>
    }
    /**
     * Per-run cross-slice contract registry (see contracts.ts): `read` supplies the
     * verbatim interface facts the SOURCE design pins that more than one slice
     * touches, injected so the verify child checks THIS slice's boundary against
     * them (F3 seam bugs are locally right but globally wrong). ABSENT/empty → no
     * block (single `/task` runs, or a design pinning no shared boundary), unchanged.
     */
    contracts?: () => Promise<string>
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
    let prohibitions: string[] = []
    if (deps.prohibitionProbe) {
        try {
            prohibitions = await deps.prohibitionProbe()
        } catch {
            prohibitions = []
        }
    }
    // Test-assembly findings feed the prompt (rule 3f); a probe failure must never
    // block verification — it is an optional sharpener like the substitution probe.
    let testAssembly: string[] = []
    if (deps.testAssemblyProbe) {
        try {
            testAssembly = await deps.testAssemblyProbe()
        } catch {
            testAssembly = []
        }
    }
    // Probe-gaming findings feed the prompt (rule 4c, F6); a probe failure must never
    // block verification — an optional sharpener like the other diff-shape probes.
    let probeGaming: string[] = []
    if (deps.probeGamingProbe) {
        try {
            probeGaming = await deps.probeGamingProbe()
        } catch {
            probeGaming = []
        }
    }
    // Environment facts from earlier gate children (best-effort; a cache failure
    // must never block verification).
    let envNotes = ''
    if (deps.envNotes) {
        try {
            envNotes = await deps.envNotes.read()
        } catch {
            envNotes = ''
        }
    }
    // Cross-slice contracts from decompose-time extraction (best-effort; a read
    // fault must never block verification).
    let contracts = ''
    if (deps.contracts) {
        try {
            contracts = await deps.contracts()
        } catch {
            contracts = ''
        }
    }
    // DETERMINISTIC skip-escape finding, computed purely from the spec's own VERIFY
    // block (see skip-escape.ts): a required check wrapped in a skip-announcing `||`
    // fallback. Injected so rule 5c fires reliably — the model does not self-discover a
    // graceful skip-escape (A/B: rule alone ~1-3/5), but acts on a finding naming the
    // exact line, per the proven probe+rule pattern. Pure text analysis, no dep needed.
    const skipEscapes = skipEscapeVerifyFindings(findSkipEscapes(deps.spec))
    // A child that emits NO verdict never judged the work (budget/context death mid-
    // investigation — seen live: an 11-minute verify wandered, died verdict-less, and
    // the resulting FAIL burned a full implementation re-run on an unjudged artifact).
    // That is a verify-side fault, so retry the VERIFY once before reporting a FAIL.
    for (let attempt = 1; ; attempt++) {
        let text: string
        try {
            text = await deps.runChild(
                VERIFY_TOOLS,
                buildVerifyPrompt(
                    deps.spec,
                    findings,
                    envNotes,
                    prohibitions,
                    skipEscapes,
                    contracts,
                    testAssembly,
                    probeGaming
                ),
                deps.signal
            )
        } catch (err) {
            if (err instanceof Error && err.message === USER_CANCELLED) throw err
            const msg = err instanceof Error ? err.message : String(err)
            return {ok: false, reason: `verification pass could not run: ${msg}`}
        }
        // Capture the environment facts the child shared — regardless of verdict
        // (a FAIL run's discoveries are just as reusable).
        if (deps.envNotes) {
            try {
                await deps.envNotes.append(extractEnvNotes(text))
            } catch {
                // best-effort cache
            }
        }
        // A child that mutated the repo (git-state guard fired) judged a tree it had
        // itself changed — its verdict is meaningless in both directions, so discard
        // it BEFORE parsing. The guard already restored the state, so one retry runs
        // on the pristine tree; a child that mutates again is reported as the fault.
        const mutation = deps.mutationCheck?.()
        if (mutation?.mutated) {
            if (attempt === 1) continue
            return {
                ok: false,
                reason:
                    'verify child mutated repo state and its verdict was discarded '
                    + `(state restored: ${mutation.detail.slice(0, 200)})`
            }
        }
        const verdict = parseVerifyVerdict(text)
        if (verdict.pass) return {ok: true}
        if (verdict.detail === 'no verdict emitted' && attempt === 1) continue
        // UNOBSERVED (rule 5c): a spec-required behavioral check could not run because
        // its tooling is absent. Block like any FAIL, but flag it so the gate hands it
        // straight to the human — re-running the impl turn cannot install a missing tool.
        if (verdict.unobserved) {
            return {ok: false, unobserved: true, reason: `work unobserved: ${verdict.detail}`}
        }
        return {
            ok: false,
            reason: `work did not verify: ${verdict.detail}${
                verdict.detail === 'no verdict emitted' ? ' (after verify retry)' : ''
            }`
        }
    }
}

export {VERIFY_TOOLS}
