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
import {crossTaskDeletionVerifyFindings, type CrossTaskDeletion} from './task-provenance.js'

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
    /** The deterministic cross-task deletion findings (see task-provenance.ts) that
     *  were live when this verdict was produced: sibling tasks' committed
     *  deliverables this task's diff deletes. Carried on a FAIL so the gate loop
     *  can record each as a durable debt if the user ACCEPTs anyway — the deletion
     *  then ships in the next commit and the final gate must re-check it. */
    crossTaskDeletions?: CrossTaskDeletion[]
    /**
     * WHICH KIND of FAIL this is, as data. Only meaningful when ok === false.
     *
     * `unobserved` was already carried as a typed field and read as one. Its
     * siblings were not: the repo-health class travelled only as the `repo health:`
     * PREFIX of `reason`, and three independent production sites recovered it by
     * re-typing that literal with two different matchers — the graduated lint-fix
     * gate, the frozen-blocked contradiction test, and the ONE auto-closing debt
     * class. A reword of the mint disabled all three, with no compile error and a
     * green suite. This is the `observedFailures` finding one altitude down: the
     * outcome CLASS never travelled with the failure TEXT, so every classifier
     * downstream had to guess.
     */
    failClass?: VerifyFailClass
}

/**
 * The kinds of verify FAIL. A new member is a compile error until it declares a
 * display prefix below.
 *
 * `static-checks` is the RUN-level twin of `repo-health`: `final-gate.ts` mints
 * `static checks: …` for the same concept at the other altitude, which is why
 * `isStaticClassDebt` was structurally blind to every run-level static failure
 * that reached the ledger.
 */
export type VerifyFailClass =
    'repo-health' | 'static-checks' | 'unobserved' | 'model-verdict' | 'harness-fault'

/**
 * The prefix each class MINTS, stated once.
 *
 * These strings are byte-frozen: the debt ledger stores `reason` verbatim, so a
 * reword would orphan every debt already on disk. The registry exists so minting
 * and matching cannot drift apart, not to make the wording editable.
 */
export const VERIFY_FAIL_PREFIX: Record<VerifyFailClass, string> = {
    'repo-health': 'repo health:',
    'static-checks': 'static checks:',
    unobserved: 'work unobserved:',
    'model-verdict': 'work did not verify:',
    'harness-fault': 'verification pass could not run:'
}

/**
 * The class of a FAIL — from the typed field when it is there, else from the
 * prefix the registry above owns.
 *
 * The prefix test survives in exactly ONE place instead of three. It has to
 * survive somewhere: `GateDeps.verify` is a seam, a debt read back off disk is a
 * bare string with no outcome attached, and the run-level gate mints its own
 * `static checks:` line through a different path entirely.
 */
export function verifyFailClass(
    o: Pick<VerifyOutcome, 'failClass' | 'reason'>
): VerifyFailClass | undefined {
    if (o.failClass) return o.failClass
    return failClassOfReason(o.reason ?? '')
}

/** The class a recorded reason STRING belongs to, by its minted prefix. */
export function failClassOfReason(reason: string): VerifyFailClass | undefined {
    const head = reason.trimStart().toLowerCase()
    for (const [cls, prefix] of Object.entries(VERIFY_FAIL_PREFIX) as Array<
        [VerifyFailClass, string]
    >) {
        if (head.startsWith(prefix.toLowerCase())) return cls
    }
    return undefined
}

/** Does this class name a deterministic whole-repo static check, at either altitude? */
export function isStaticClass(cls: VerifyFailClass | undefined): boolean {
    return cls === 'repo-health' || cls === 'static-checks'
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
 * ─────────────────────────── THE PROBE TABLE ───────────────────────────
 *
 * Every deterministic probe that sharpens this prompt used to cost the same
 * ritual in four places: a `let x = []` + try/catch in runWorkVerification, a
 * positional parameter on buildVerifyPrompt, a `const xBlock =` ternary, and a
 * spread into the assembled prompt — plus its hand-numbered rule. Adding one
 * meant editing all of them and hoping none was missed; the ninth would not
 * even fit the signature (hence the `projectSurface` bag that used to group
 * three of them).
 *
 * Each probe is now an ADAPTER: one row carrying only what is specific to it —
 * its key (which names the thunk it reads from `deps.probes`), the empty value it
 * degrades to, how its raw result becomes finding lines, the notice block those
 * lines produce, and the numbered rule the notice routes the child to. The loop
 * owns the ritual. (Same shape as
 * LOCKFILE_CHECKS in final-gate.ts, where a whole package ecosystem is one row.)
 *
 * THIS PROMPT IS A MEASURED ARTIFACT — its wording is A/B-tested on the live
 * local model and the verdicts are recorded in VALIDATION-DEBT.md, so the table
 * must emit BYTE-IDENTICAL text for the same findings. Two orders are
 * load-bearing and they are NOT the same order:
 *   - NOTICE BLOCKS are emitted in TABLE order (the order the rows appear below).
 *   - RULES are emitted sorted by `ruleId`, because the 4b…4g band was
 *     hand-numbered long before this table existed and its numbering is what the
 *     notices cite ("rule 4b applies").
 * A row whose rule is woven into the numbered narrative elsewhere (3b inside the
 * substitution rules, 3f, 5c) carries `ruleId` for the reader and no `rule` text.
 */

/**
 * What each probe channel's RAW probe returns — the one place a channel's shape
 * is declared. `ProbeKey` is derived from it, so a channel exists exactly when it
 * has a row here; delete one and the compiler names its table row and its single
 * binding line in gate-deps' `buildVerifyProbes`.
 */
export interface ProbeRaw {
    substitution: string[]
    prohibition: string[]
    crossTaskDeletion: CrossTaskDeletion[]
    probeGaming: string[]
    skipEscape: string[]
    foreignPath: string[]
    scriptEscape: string[]
    runnerGlob: string[]
    testAssembly: string[]
}

/** Stable identity of one probe channel: table row ↔ findings-bag key. */
export type ProbeKey = keyof ProbeRaw

/**
 * The channels a CALLER binds — every key but `skipEscape`, which is pure text
 * analysis of `deps.spec` and is sourced inside its own table row, so it is never
 * absent and never bound from outside.
 */
export type BoundProbeKey = Exclude<ProbeKey, 'skipEscape'>

/**
 * The bound probes: one optional thunk per channel, typed to that channel's raw
 * shape. Built in ONE place (gate-deps' `buildVerifyProbes`); an absent key means
 * the row is skipped. Adding a probe is a `ProbeRaw` line, a table row, and a
 * binding line — nothing else.
 */
export type VerifyProbes = {[K in BoundProbeKey]?: () => Promise<ProbeRaw[K]>}

/** The finding lines each probe channel contributed. Absent/empty ⇒ no block. */
export type ProbeFindings = Partial<Record<ProbeKey, string[]>>

/** What one row's probe produced: the raw dep value plus its finding lines. */
interface ProbeResult {
    /** The probe's own return value (only the cross-task-deletion row's caller
     *  needs it — it rides on a FAIL outcome as structured debt input). */
    raw: unknown
    findings: string[]
}

/**
 * A probe adapter with its element type erased: the generic lives inside
 * `probeAdapter` below, so the table can hold rows whose probes return different
 * shapes (`string[]`, `CrossTaskDeletion[]`) without leaking type parameters.
 */
interface ProbeAdapter {
    key: ProbeKey
    /** True when the row reads its probe from `deps.probes` (i.e. a caller binds
     *  it); false for the row that sources itself from the spec. */
    bound: boolean
    /** Progress label for the deterministic stage. Absent ⇒ the row costs
     *  nothing observable (the skip-escape row is pure text analysis of the
     *  spec, not a git/fs call, and never had a stage of its own). */
    stage?: string
    /** Run this row against the deps: skipped when its dep field is absent,
     *  degraded to the row's empty value when the probe throws. Never throws. */
    run: (deps: VerificationDeps, onStage: (label: string) => void) => Promise<ProbeResult>
    /** The notice block these findings produce. Called only when non-empty. */
    block: (findings: string[]) => string[]
    /** The numbered rule this row's notice cites. */
    ruleId: string
    /** The rule's body, emitted (sorted by ruleId) into the 4b…4g band. Absent
     *  when the rule lives elsewhere in the numbered narrative. */
    rule?: string[]
}

/**
 * Build one row. Generic in the probe's return type so `empty`/`findings` stay
 * type-checked against the dep's real signature; the result is the erased
 * `ProbeAdapter` the table stores.
 */
function probeAdapter<K extends ProbeKey>(row: {
    key: K
    stage?: string
    /** Where this row's probe comes from. Default: `deps.probes[key]`, the thunk
     *  the caller bound. Only the skip-escape row overrides it (it reads the spec
     *  the deps already carry, so nothing needs binding). Absent ⇒ skipped. */
    source?: (deps: VerificationDeps) => (() => Promise<ProbeRaw[K]>) | undefined
    /** Value used when the probe is absent OR throws. */
    empty: ProbeRaw[K]
    /** Raw probe value → prompt finding lines. */
    findings: (raw: ProbeRaw[K]) => string[]
    block: (findings: string[]) => string[]
    ruleId: string
    rule?: string[]
}): ProbeAdapter {
    const {key, stage, block, ruleId, rule} = row
    const source =
        row.source
        ?? ((deps: VerificationDeps) =>
            // One channel per key, so the bag's entry for this key IS this row's
            // thunk; the cast only re-narrows what the mapped type already says.
            deps.probes?.[key as BoundProbeKey] as (() => Promise<ProbeRaw[K]>) | undefined)
    return {
        key,
        bound: !row.source,
        stage,
        block,
        ruleId,
        rule,
        run: async (deps, onStage) => {
            const probe = source(deps)
            // Probes are INDEPENDENTLY OPTIONAL: an absent probe is "skipped", and a
            // probe that throws degrades to its own empty value — it is a sharpener,
            // never a blocker, so a fault in one can neither block the gate nor
            // leak into another row.
            if (!probe) return {raw: row.empty, findings: row.findings(row.empty)}
            if (stage) onStage(stage)
            try {
                const raw = await probe()
                return {raw, findings: row.findings(raw)}
            } catch {
                return {raw: row.empty, findings: row.findings(row.empty)}
            }
        }
    }
}

/** Identity transform for the rows whose probe already returns finding lines. */
const asLines = (raw: string[]): string[] => raw

/**
 * The table. ROW ORDER IS THE NOTICE-BLOCK ORDER IN THE PROMPT — do not reorder
 * without re-running the byte-identity check.
 */
const PROBE_ADAPTERS: readonly ProbeAdapter[] = [
    /**
     * Deterministic self-verification probe (see substitution-probe.ts): the
     * TEST-THE-COPY class is caught 5/5 only when the prompt carries both the rule
     * (3b) AND a concrete finding naming the suspect file — the rule alone got 2/5
     * attention on the local model. The findings are pure git shape (test files the
     * task itself changed), so the mandate is language- and framework-agnostic.
     */
    probeAdapter({
        key: 'substitution',
        stage: 'substitution probe',
        empty: [],
        findings: asLines,
        ruleId: '3b',
        block: findings => [
            'SELF-VERIFICATION NOTICE (deterministic, computed by the orchestrator from the diff):',
            'this task wrote or changed the very tests whose green result would bless it:',
            ...findings.map(f => `- ${f}`),
            'A green run of self-authored tests is NOT sufficient verification. Before any PASS',
            'you MUST confirm these tests exercise the REAL shipped artifact: drive 1-2 tested',
            'behaviors directly against the real app / module / entry point and judge what IT',
            'returns. Tests that intercept, re-implement, or stub the artifact prove only the',
            'copy (rule 3b below).',
            ''
        ]
    }),
    /**
     * Deterministic prohibition probe (see prohibition-probe.ts): spec-forbidden
     * paths the task's diff modified anyway. Same probe+rule design, same reason:
     * the VIOLATION-EXCUSAL class (mx5 run 7: child saw "Do NOT modify server-side
     * code" violated, waived it as "additive, tests pass", PASSed) needs both the
     * no-waiver rule (4b) AND the concrete diff fact — the baseline child usually
     * never runs `git diff` at all, so without the finding it cannot even SEE the
     * violation. A/B on the live local model (violated-but-working fixture,
     * everything green, forbidden file modified additively): old prompt 5/5
     * false-PASS (several runs affirmatively claimed the forbidden file was
     * untouched); rule+finding 5/5 FAIL naming the constraint. Guard: honest-clean
     * fixture (prohibition in spec, probe silent) 5/5 PASS — no paranoia.
     * Reverted-violation ≡ clean at the diff level (no entry → no finding).
     */
    probeAdapter({
        key: 'prohibition',
        stage: 'prohibition probe',
        empty: [],
        findings: asLines,
        ruleId: '4b',
        block: findings => [
            'PROHIBITION NOTICE (deterministic, computed by the orchestrator from the',
            "spec's own constraint lines and the task's diff): this task MODIFIED paths",
            'the spec explicitly forbids modifying:',
            ...findings.map(f => `- ${f}`),
            'Read the exact constraint wording in the spec. Unless that wording itself',
            'states an exception that covers this change, this is a violated prohibition:',
            'rule 4b applies and the verdict is FAIL naming the forbidden path — even if',
            'every test passes and the change looks harmless.',
            ''
        ],
        rule: [
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
            '   your view of harmlessness.'
        ]
    }),
    /**
     * Deterministic cross-task deletion probe (see task-provenance.ts, mx5 run 12
     * PROMPT 2): tracked files the task's diff DELETES whose introducing task (git
     * provenance) differs from the current task. The only row whose probe does NOT
     * return finding lines — the structured value also rides on a FAIL outcome so
     * an ACCEPT records each deletion as a durable debt.
     */
    probeAdapter({
        key: 'crossTaskDeletion',
        stage: 'cross-task deletion probe',
        empty: [],
        findings: crossTaskDeletionVerifyFindings,
        ruleId: '4d',
        block: findings => [
            'CROSS-TASK DELETION NOTICE (deterministic, computed by the orchestrator from',
            "git provenance over the task's diff): this task's work DELETED committed",
            'deliverable(s) that a DIFFERENT, already-completed task introduced:',
            ...findings.map(f => `- ${f}`),
            "A sibling task's verified, committed deliverable is not this task's to remove.",
            'Deleting the file a checker complains about is the cheapest way to turn a red',
            'check green — the finding vanishes with the file — and it destroys finished',
            'work (rule 4d). A green check suite on the shrunken tree is NOT a waiver.',
            "Unless THIS task's spec explicitly REQUIRES removing exactly that file, the",
            'verdict is FAIL naming the deleted file and its owning task — even if every',
            'check passes and the deletion made them pass.',
            ''
        ],
        rule: [
            "4d. A SIBLING TASK'S COMMITTED DELIVERABLE IS NOT THIS TASK'S TO DELETE — check the",
            "   task's own diff (git) for DELETED tracked files. A file that a DIFFERENT completed",
            "   task introduced and committed, deleted by this task's work, is finished work",
            '   destroyed — usually to make a red check go green (the file the checker complains',
            '   about simply disappears; that is quieting the messenger, rule 4c, not fixing the',
            '   defect). A passing check suite on the shrunken tree is not a waiver. Only two',
            "   outcomes are not a FAIL: THIS task's spec explicitly requires that removal, or",
            '   the deletion is a genuine relocation (the same file lives on elsewhere in the',
            '   tree). Otherwise the verdict is FAIL naming the deleted file and the task that',
            '   owns it.'
        ]
    }),
    /**
     * Deterministic probe-gaming probe (see probe-gaming.ts, run-8 F6): added lines
     * whose stated purpose is to make a CHECK pass instead of meeting the
     * requirement it stands for ("return 401 so the verification test passes").
     */
    probeAdapter({
        key: 'probeGaming',
        stage: 'probe-gaming probe',
        empty: [],
        findings: asLines,
        ruleId: '4c',
        block: findings => [
            'CHECK-GAMING NOTICE (deterministic, computed by the orchestrator from the',
            "task's diff): these added lines state their own purpose is to make a CHECK",
            'pass (a test / verification / lint / gate), not to meet the requirement the',
            'check stands for:',
            ...findings.map(f => `- ${f}`),
            'A check is a MESSENGER for a requirement. Code written to quiet the messenger',
            'instead of meeting the requirement is a defect even when the check is green',
            '(run-8 F6: a handler returned 401 "so the verification test passes" while the',
            'real route stayed dead). Do NOT accept the passing check as proof. Read each',
            "line's surrounding code and confirm the UNDERLYING requirement is genuinely",
            'met — drive the real behavior directly (rule 4c). If the code only exists to',
            'satisfy the check while the requirement is unmet, that is a FAIL naming the',
            'gamed check and the unmet requirement.',
            ''
        ],
        rule: [
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
            '   the check passes, the verdict is FAIL naming the gamed check and the real gap.'
        ]
    }),
    /**
     * DETERMINISTIC skip-escape finding, computed purely from the spec's own VERIFY
     * block (see skip-escape.ts): a required check wrapped in a skip-announcing `||`
     * fallback. Injected so rule 5c fires reliably — the model does not self-discover
     * a graceful skip-escape (A/B: rule alone ~1-3/5), but acts on a finding naming
     * the exact line, per the proven probe+rule pattern. Pure text analysis over
     * `deps.spec`, so this row needs no dep and reports no stage: it is the one probe
     * that is never absent and never costs a git call.
     */
    probeAdapter({
        key: 'skipEscape',
        source: deps => () =>
            Promise.resolve(skipEscapeVerifyFindings(findSkipEscapes(deps.spec ?? ''))),
        empty: [],
        findings: asLines,
        ruleId: '5c',
        block: findings => [
            "SKIP-ESCAPE NOTICE (deterministic, computed by the orchestrator from the spec's",
            'OWN VERIFY block): these VERIFY commands wrap a required check in a fallback that',
            'ANNOUNCES skipping it when a tool is absent — so the check can "pass" while never',
            'actually running:',
            ...findings.map(f => `- ${f}`),
            'Do NOT accept a skipped check as a passed check. For each, determine whether it',
            'ACTUALLY ran and observed the real behavior. If its tool is absent so the required',
            'behavior was never observed, that area is UNOBSERVED (rule 5c) — verdict UNOBSERVED,',
            'not PASS. Only if you observe the required behavior another way (running the real',
            'artifact directly) may it count as verified.',
            ''
        ]
    }),
    /**
     * Deterministic sandbox-path-leak probe (see foreign-path.ts, mx5 run 13 PROMPT
     * 4 item 1): absolute paths this task committed that exist only inside the
     * authoring child's own environment — `/workspace/src/shared` in a vite alias —
     * while the real file sits at `src/shared` here.
     */
    probeAdapter({
        key: 'foreignPath',
        stage: 'foreign-path probe',
        empty: [],
        findings: asLines,
        ruleId: '4e',
        block: findings => [
            'SANDBOX PATH LEAK NOTICE (deterministic, computed by the orchestrator by',
            "resolving every absolute path in the task's diff against THIS machine): this",
            'task committed absolute paths that do not exist here, while the real file they',
            'name sits inside this repo:',
            ...findings.map(f => `- ${f}`),
            "These are paths from the authoring agent's OWN environment, baked into a file",
            'that ships. The command that reads such a path does not fail a check — it fails',
            'to BUILD, so the checks that would have caught it never run and report nothing',
            '(mx5 run 13: a leaked `/workspace` vite alias made `test:ct` collect 63 tests',
            'and run 0, and the suite stayed dead for the rest of the run). A green or',
            'EMPTY result from any command that reads these files is therefore NOT evidence.',
            'Run the affected command yourself and confirm it actually EXECUTES work — count',
            'the tests/steps that ran, not the exit code. Unless the leaked path resolves on',
            'this machine, the verdict is FAIL naming the file and the path (rule 4e).',
            ''
        ],
        rule: [
            '4e. AN ABSOLUTE PATH TO PROJECT FILES IS A DEFECT — a committed path like',
            "   `/workspace/src/shared` or `/home/<someone>/proj/src` names the authoring agent's",
            '   OWN machine, not this one. Its distinctive damage is that it breaks the run BEFORE',
            '   any check reports: a bad alias/config path makes the tool fail to RESOLVE or BUILD,',
            '   so a suite "passes" having executed nothing. Treat a command that reports no',
            '   failures but also no WORK — 0 tests run, 0 files emitted, an empty report — as',
            '   unverified, never as green. Confirm the count of things that actually ran. A path',
            '   to project-internal files must be relative to the file that carries it, or computed',
            '   at runtime; if one does not resolve here, the verdict is FAIL naming file and path.'
        ]
    }),
    /**
     * Deterministic neutered-check-script probe (see script-escape.ts, mx5 run 13
     * PROMPT 4 item 4): check-class scripts in a manifest THIS task changed whose
     * exit status cannot be non-zero (`… || true`, an inverted-grep launder). The
     * damage is second-order — the script still "passes" — which is exactly why the
     * child cannot discover it by running the check.
     */
    probeAdapter({
        key: 'scriptEscape',
        stage: 'script-escape probe',
        empty: [],
        findings: asLines,
        ruleId: '4f',
        block: findings => [
            'NEUTERED CHECK SCRIPT NOTICE (deterministic, computed by the orchestrator from',
            'the manifest THIS task changed): these check scripts cannot report failure —',
            'their exit status is 0 no matter what the checker finds:',
            ...findings.map(f => `- ${f}`),
            'You CANNOT discover this by running the script: it passes, which is the whole',
            'defect (mx5 run 13 shipped a `lint` whose typecheck was disarmed by an inverted',
            'grep and a `|| true` tail; every gate that ran it reported success without',
            'measuring anything). A green result from one of these scripts is NOT evidence',
            'for any acceptance criterion. To judge the area it claims to cover, run the',
            'underlying checker DIRECTLY and unmodified (e.g. `tsc --noEmit` rather than',
            '`npm run lint`) and judge THAT output. Unless the task spec explicitly requires',
            'the script to tolerate failure, the verdict is FAIL naming the script (rule 4f).',
            ''
        ],
        rule: [
            '4f. A CHECK THAT CANNOT FAIL PROVES NOTHING — before you cite a check script',
            "   (`npm run lint`, `bun run test`) as evidence, read its DEFINITION in the project's",
            '   manifest. A script ending in `|| true`, `; exit 0`, or piping a checker into an',
            '   inverted grep exits 0 unconditionally: its green result is a constant, not a',
            '   measurement, and running it again only reproduces the constant. When a script is',
            '   built that way, run the underlying checker directly and judge its real output; and',
            '   unless the spec required that tolerance, the script itself is a defect — the',
            '   verdict is FAIL naming it.'
        ]
    }),
    /**
     * Deterministic test-runner glob-collision probe (see runner-globs.ts, mx5 runs
     * 7 AND 13, PROMPT 4 item 2): the manifest declares two runners whose file sets
     * are not provably disjoint, so the scanning one imports the other's specs and
     * dies during COLLECTION.
     */
    probeAdapter({
        key: 'runnerGlob',
        stage: 'runner-glob probe',
        empty: [],
        findings: asLines,
        ruleId: '4g',
        block: findings => [
            'TEST-RUNNER GLOB COLLISION NOTICE (deterministic, computed by the orchestrator',
            "from the manifest's declared runners and their config): two test runners claim",
            'the same files:',
            ...findings.map(f => `- ${f}`),
            "The scanning runner will import the other's spec files and abort on a module",
            'loaded outside its own runner — so the suite dies WHOLESALE rather than',
            'reporting failures (this is the THIRD occurrence: mx5 runs 7 and 13). Run both',
            'test commands yourself and confirm each collects and runs its own files and only',
            'its own. A run that errors during collection has verified nothing, whatever its',
            'exit code says (rule 4g).',
            ''
        ],
        rule: [
            '4g. TWO RUNNERS, ONE FILE SET, NO RESULTS — when a project declares more than one',
            '   test runner, check that each collects only its own files. A runner that scans for',
            "   `*.test.*` / `*.spec.*` project-wide will import another runner's specs and abort",
            '   during COLLECTION. That failure mode looks nothing like a test failure: you get an',
            '   import error, or a suite that reports zero tests. Always read how many tests each',
            '   command actually COLLECTED and RAN; zero collected is never a pass.'
        ]
    }),
    /**
     * Deterministic test-assembly probe (see test-assembly.ts): authored test files
     * that rebuild production WIRING — importing the leaf modules the shipped entry
     * composes and assembling their own copy instead of the real assembly — under
     * rule 3f (F4 test-the-copy, 3rd recurrence). Pure import-graph shape.
     */
    probeAdapter({
        key: 'testAssembly',
        stage: 'test-assembly probe',
        empty: [],
        findings: asLines,
        ruleId: '3f',
        block: findings => [
            'TEST-ASSEMBLY NOTICE (deterministic, computed by the orchestrator from pure',
            'import-graph shape): these test files rebuild production WIRING — they import the',
            'same leaf modules the shipped entry composes and assemble their OWN copy of it,',
            'instead of importing the production assembly:',
            ...findings.map(f => `- ${f}`),
            'A green result on such a test proves that PRIVATE re-assembly, NOT the shipped',
            'wiring — the copy can be wired differently (a different mount prefix, order, or',
            'middleware) and pass while production is broken exactly at the seam the test was',
            'meant to cover (rule 3f below). Before you count the covered area verified, drive',
            'the behavior against the REAL shipped assembly/entry named above (start or invoke',
            "the production entry point, not the test's hand-built app). If the real assembly",
            'fails where the test passes, report FAIL and name the wiring seam.',
            ''
        ]
    })
]

/**
 * The channels a caller must bind — the table rows that read `deps.probes`, in
 * table order. Exported so the one binder (gate-deps' `buildVerifyProbes`) can be
 * checked against the table rather than against a hand-kept list.
 */
export const BOUND_PROBE_KEYS: readonly BoundProbeKey[] = PROBE_ADAPTERS.filter(a => a.bound).map(
    a => a.key as BoundProbeKey
)

/**
 * Build the verification child's prompt. Kept pure so the wording is unit-tested
 * without spawning pi. The contract: run the spec's own verification in the real
 * workspace, judge against ACCEPTANCE, and end on exactly one verdict line.
 *
 * `findings` is the probe bag: one key per PROBE_ADAPTERS row (see the table
 * above for what each channel means and the A/B evidence behind it). A key that
 * is absent or empty emits no block — the probes are independently optional.
 */
export function buildVerifyPrompt(
    spec: string,
    findings: ProbeFindings = {},
    context: {
        /** Environment facts earlier gate children discovered — see env-notes.ts. */
        envNotes?: string
        /** Cross-slice interface facts the design pins — see contracts.ts. */
        contracts?: string
    } = {}
): string {
    const {envNotes, contracts} = context
    // NOTICE BLOCKS in table order; RULES sorted by their hand-assigned number.
    const noticeBlocks = PROBE_ADAPTERS.flatMap(adapter => {
        const lines = findings[adapter.key]
        return lines && lines.length > 0 ? adapter.block(lines) : []
    })
    const probeRules = PROBE_ADAPTERS.filter(a => a.rule)
        .sort((a, b) =>
            a.ruleId < b.ruleId ? -1
            : a.ruleId > b.ruleId ? 1
            : 0
        )
        .flatMap(a => [...(a.rule ?? []), ''])
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
        ...noticeBlocks,
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
        // The 4b…4g band: one rule per probe row that owns a numbered rule, emitted
        // in rule-number order (see the table above — NOT the notice-block order).
        ...probeRules,
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
     * Progress hook for the DETERMINISTIC stage — the repo-health run plus the
     * `probes` below, all of which run BEFORE the child (and therefore before the
     * child's own status widget exists). Called with a short label as each step
     * starts, so the caller can keep a live line on screen through what was
     * otherwise the run's longest stretch of dead air (MEASURED at 15–69s per
     * repo-health run). ABSENT → no progress reporting, same behaviour as before. */
    onStage?: (stage: string) => void
    /**
     * The DETERMINISTIC probes, one optional thunk per channel (see `PROBE_ADAPTERS`
     * above for what each channel is and which rule its findings cite; the
     * substitution, prohibition, test-assembly, probe-gaming, cross-task-deletion,
     * foreign-path, script-escape and runner-glob probes all live here). Bound in
     * ONE place — gate-deps' `buildVerifyProbes` — and consumed by the table: an
     * absent key skips its row, a throwing thunk degrades to the row's empty value.
     * ABSENT → no probe blocks at all (tests / callers that wire none). */
    probes?: VerifyProbes
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
    const stage = (label: string): void => {
        try {
            deps.onStage?.(label)
        } catch {
            // progress reporting must never break the gate
        }
    }
    if (deps.repoHealth) {
        stage('repo health')
        const h = await deps.repoHealth()
        if (!h.ok) {
            return {ok: false, failClass: 'repo-health', reason: `repo health: ${h.reason}`}
        }
    }
    if (!deps.spec || deps.spec.trim().length === 0) {
        return {ok: true, reason: 'no spec to verify'}
    }
    // Every deterministic probe, one table row each (see PROBE_ADAPTERS): the row
    // knows which dep it reads, what it degrades to, and which notice block its
    // findings become. Each is an optional SHARPENER — an absent dep is skipped and
    // a throwing probe degrades to its empty value, so no probe can block the gate.
    const findings: ProbeFindings = {}
    const rawResults = new Map<ProbeKey, unknown>()
    for (const adapter of PROBE_ADAPTERS) {
        const result = await adapter.run(deps, stage)
        findings[adapter.key] = result.findings
        rawResults.set(adapter.key, result.raw)
    }
    // The one probe whose RAW value is needed beyond the prompt: cross-task deletion
    // findings ride on a FAIL outcome (structured) so an ACCEPT can record them as
    // durable debts. The row's `empty` is `[]`, so this is always an array.
    const crossDeletions = (rawResults.get('crossTaskDeletion') ?? []) as CrossTaskDeletion[]
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
    // A child that emits NO verdict never judged the work (budget/context death mid-
    // investigation — seen live: an 11-minute verify wandered, died verdict-less, and
    // the resulting FAIL burned a full implementation re-run on an unjudged artifact).
    // That is a verify-side fault, so retry the VERIFY once before reporting a FAIL.
    for (let attempt = 1; ; attempt++) {
        let text: string
        try {
            text = await deps.runChild(
                VERIFY_TOOLS,
                buildVerifyPrompt(deps.spec, findings, {envNotes, contracts}),
                deps.signal
            )
        } catch (err) {
            if (err instanceof Error && err.message === USER_CANCELLED) throw err
            const msg = err instanceof Error ? err.message : String(err)
            return {
                ok: false,
                failClass: 'harness-fault',
                reason: `${VERIFY_FAIL_PREFIX['harness-fault']} ${msg}`
            }
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
        // Structured cross-task deletion findings ride on every FAIL outcome: if the
        // human ACCEPTs the failing artifact, the deletions ship in the next commit
        // and the gate loop must record each as a durable debt (see task-gates.ts).
        const deletions = crossDeletions.length > 0 ? {crossTaskDeletions: crossDeletions} : {}
        // UNOBSERVED (rule 5c): a spec-required behavioral check could not run because
        // its tooling is absent. Block like any FAIL, but flag it so the gate hands it
        // straight to the human — re-running the impl turn cannot install a missing tool.
        if (verdict.unobserved) {
            return {
                ok: false,
                unobserved: true,
                failClass: 'unobserved',
                reason: `work unobserved: ${verdict.detail}`,
                ...deletions
            }
        }
        return {
            ok: false,
            failClass: 'model-verdict',
            reason: `work did not verify: ${verdict.detail}${
                verdict.detail === 'no verdict emitted' ? ' (after verify retry)' : ''
            }`,
            ...deletions
        }
    }
}

export {VERIFY_TOOLS}
