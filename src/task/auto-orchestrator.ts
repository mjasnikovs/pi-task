/**
 * /task-auto — plans a feature into a resumable list of task titles, then runs
 * each title through the existing single-task pipeline one at a time.
 *
 * This module currently holds the planning half (AutoDeps + planAuto). The run
 * loop, command handlers, and defaultDeps are added by the next task.
 */
import {existsSync} from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {gateRunTask, markResumable} from './orchestrator.js'
import {parseClarifyList, parseAutoAnswer, autoAnswerHasTag, deriveTitle} from './parsers.js'
import {renderInlineMarkdown, stripInlineMarkdown} from './inline-markdown.js'
import {
    AUTO_CLARIFY_PROMPT,
    AUTO_DECOMPOSE_PROMPT,
    DECOMPOSE_COVERAGE_PROMPT
} from './auto-prompts.js'
import {GRILL_AUTO_ANSWER_PROMPT, GRILL_AUTO_FORMAT_HINT} from './prompts.js'
import {isDuplicateQuestion, MAX_DUP_STRIKES, DUP_REPROMPT_HINT} from './question-dedup.js'
import {
    allocateAutoId,
    buildAutoBody,
    parseDecomposeList,
    parseCoverageVerdict,
    type CoverageVerdict,
    parseTaskList,
    checkOffTask,
    stampTaskInProgress,
    insertTaskAfter,
    findResumableAutoDetailed
} from './auto-io.js'
import {decideResume} from './resume-gap.js'
import {
    drainRepairQueue,
    mergeRepairCandidates,
    planHasRepairFor,
    parseRepairTitleFile,
    buildRepairTitle,
    buildRepairScopeFence,
    extractFailingCommand
} from './root-cause-repair.js'
import {
    writeTaskFile,
    readTaskFile,
    updateTaskFrontMatter,
    taskFilePath,
    tasksDir
} from './task-io.js'
import {readTextFile} from '../shared/fs-text.js'
import {findPhantomImports, rewritePhantomSpecifiers} from '../workers/phantom-imports.js'
import type {TaskFrontMatter} from './task-types.js'
import {runPhaseChild, prependHint, USER_CANCELLED, type PhaseDeps} from './child-runner.js'
import {requestCancel, resetCancel, isCancelRequested, cancelCheckpoint} from './cancel-points.js'
import {armCancelListener, disarmCancelListener} from './cancel-input.js'
import {refineExistingFilesBlock} from './phases.js'
import {SessionUI, registerBridgeCommand, publishLifecycleNotice} from '../remote/bridge.js'
import {pushNotify} from '../remote/push.js'
import {startAutoLoader, type ContextSnapshot} from './widget.js'
import {getParentContextWindow, resolveContextUsage} from './context-usage.js'
import {buildGateDeps, collectTreeChanges, type FinalGateFixFn} from './gate-deps.js'
import {runGatesForTask, type GateDeps} from './task-gates.js'
import {gitUnmergedPaths, gitStashRef} from './auto-commit.js'
import {runFinalIntegrationGate} from './final-gate.js'
import {describeDebt, recordFinalGateUnobservedDebt, type AcceptDebt} from './accept-debt.js'
import {
    applyDemotions,
    isNonProgress,
    normalizeFailureDetail,
    rankedFirstFailure,
    unobservedDebtReason
} from './final-gate-progress.js'
import {
    classifyFinalGateAnswer,
    MAX_FINAL_GATE_AUTOFIX,
    FINAL_LEAVE_LABEL,
    FINAL_LEAVE_VALUE,
    FINAL_ACCEPT_LABEL,
    FINAL_ACCEPT_VALUE,
    FINAL_AUTOFIX_LABEL,
    FINAL_AUTOFIX_VALUE,
    STRANDED_FIX_COMMIT,
    strandedFixNote
} from './final-gate-fix.js'
import {getConfig} from '../config/config.js'
import {isYoloMode, yoloPickAnswer, yoloFinalGateChoice, YOLO_STAMP} from './yolo.js'
import {configureResearchRun, resumeResearchRun} from '../workers/research-cache.js'
import {
    CONTRACT_EXTRACT_PROMPT,
    parseContractLines,
    keepGroundedContracts,
    appendContracts
} from './contracts.js'
import {reconcileTitleSources} from './decompose-fidelity.js'
import {mandatesTestsInSameChange, rewriteBatchTestPlan} from './batch-test-task.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    COVERAGE_MAP_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    capRequirements,
    enumerateObligationPassages,
    uncoveredPassages,
    extractionRetryHint,
    parseCoverageMap,
    accountCoverage,
    isCrossCuttingRequirement,
    appendCarriedRequirements,
    buildRequirementsLedger,
    type RequirementEntry,
    type CoverageAccounting
} from './requirements.js'
import {decideAdoption, groundedCoverage, type CoveragePlan} from './coverage-loop.js'
import {
    findSpecDanglingArtifacts,
    titlesCoverArtifact,
    danglingMissingText,
    danglingCarryText,
    type DanglingRef
} from './artifact-closure.js'
import {
    LAUNCH_EXTRACT_PROMPT,
    enumerateScriptCandidates,
    parseScriptLines,
    keepGroundedScripts,
    appendDeclaredScripts
} from './launch-contract.js'

// Hard ceiling on clarify questions per feature. The loop is open-ended (it stops
// when the model emits NONE), but a model that never says NONE would otherwise
// barrage the user — the real mx5 run asked 10, several of them redundant.
const MAX_CLARIFY_QUESTIONS = 8

// Bounded coverage-triage rounds after decompose: judge → reprompt-with-missing
// → judge again, at most. Two rounds so one flaky retry doesn't end the gate,
// while a judge that keeps flagging can't loop the plan phase forever. Each round
// spawns three model children (decompose + coverage-map + coverage-verdict), so
// the ceiling is also a latency/spawn budget, not just a correctness bound.
//
// Why 2 is safe to sit this low: when this number was picked (2026-07-03) adoption
// was LAST-WINS, so more rounds meant more chances to overwrite a good plan with a
// worse regeneration — the cap was protective. Adoption is now MONOTONE
// (coverage-loop.ts, 2026-07-15): a retry that drops owned coverage is rejected,
// never adopted, so extra rounds can only hold or grow coverage. The one gap that
// remained is that an adoption landing ON the last round can expose a NEW area with
// no round left to chase it — handled surgically by a single bonus round granted
// only in that exact case (see the loop), rather than by raising this ceiling for
// every run.
const MAX_COVERAGE_ROUNDS = 2

/** Reprompt prefix when the coverage triage found feature areas no task covers. */
function coverageRepromptHint(missing: string[]): string {
    return (
        '[SYSTEM NOTE: Your previous task list was INCOMPLETE — no task covered: '
        + missing.join('; ')
        + '. Regenerate the FULL ordered checkbox list for the ENTIRE feature: every '
        + 'task your previous list already had (reworded freely) PLUS tasks covering '
        + 'the areas above. Output every task, one "- [ ] " line each, nothing else.]'
    )
}

// Deterministic distrust floor for the coverage gate. The gate's judge is the
// same stochastic model as the decompose call it guards, and live (mx5 2026-07-08,
// A/B N=10) it rubber-stamps a 1-task plan for an 18KB spec 3/10 times — always
// as the bare "COVERAGE: COMPLETE" line, which is byte-identical to a legitimate
// verdict, so the rubber-stamp is NOT detectable from the judge's output. The
// distrust signal must come from the input: a plan this small for a spec this
// large is near-certainly the known degenerate-decompose flake (healthy runs on
// the same inputs produce 10–30 titles). The floor only ever forces a REGENERATION
// — it never rejects a plan on count alone (the v0.13.34 objection), so a model
// that insists twice still ships its small plan, with a warning.
const SUSPECT_PLAN_MAX_TITLES = 2
const SUSPECT_PLAN_MIN_SPEC_CHARS = 4000

function isSuspectPlan(titles: string[], featureForModel: string): boolean {
    return (
        titles.length > 0
        && titles.length <= SUSPECT_PLAN_MAX_TITLES
        && featureForModel.length >= SUSPECT_PLAN_MIN_SPEC_CHARS
    )
}

/** Reprompt prefix for a suspect (degenerate-count) list; unlike
 *  coverageRepromptHint there is no judge verdict yet, so no missing areas. */
function suspectPlanHint(count: number): string {
    return (
        `[SYSTEM NOTE: Your previous answer contained only ${count} task(s), which `
        + 'cannot decompose a feature specification of this size — it was almost '
        + 'certainly an incomplete generation. Regenerate the FULL ordered checkbox '
        + 'list for the ENTIRE feature, covering every part of the spec end to end. '
        + 'Output every task, one "- [ ] " line each, nothing else.]'
    )
}

/**
 * Injectable seams so the planner and loop are testable without spawning pi.
 * `runChild` is the planning-only seam used by planAuto; everything else (runTask,
 * commit, verify, enforce, recommend, revert) is the shared post-implementation
 * gate surface defined by {@link GateDeps} and built by {@link buildGateDeps}.
 */
export interface AutoDeps extends GateDeps {
    runChild: (name: string, tools: string, prompt: string) => Promise<string>
    /**
     * Paths with unmerged index entries (an in-progress merge conflict). The loop
     * refuses to START a task on a conflicted tree — mx5 run 6 ran a full impl turn
     * plus three verifies against one, with every commit doomed from the outset.
     * Absent (tests) → treated as clean.
     */
    unmergedPaths?: (cwd: string) => Promise<string[]>
    /**
     * Sha of refs/stash or null. Compared around each task so a stash pushed (or
     * consumed) during the task and left behind is called out — an orphan stash is
     * exactly the landmine that detonated as an unresolvable conflict in run 6.
     * Absent (tests) → the check is skipped.
     */
    stashRef?: (cwd: string) => Promise<string | null>
    /**
     * Whole-repo FINAL integration gate, run once when every task is checked off
     * and BEFORE the run is declared complete (see final-gate.ts): the project's
     * own static checks plus its own test/build commands, unaided. Absent (tests /
     * gate off) → the run completes as before.
     */
    finalGate?: (
        cwd: string,
        planText?: string
    ) => Promise<{
        ok: boolean
        reason: string
        failures?: string[]
        debtNote?: string
        openDebts?: AcceptDebt[]
    }>
    /**
     * Bounded model-driven fix pass for a final-gate FAIL (see final-gate-fix.ts),
     * offered as the picker's third option. Runs the fix child, applies the
     * command-shrink guard, and re-runs the gate; the result's `ok` means the gate
     * now passes. Absent (tests / no fix wiring) → the picker keeps only
     * Leave-failed / Accept, exactly the pre-autofix behavior.
     */
    finalGateFix?: FinalGateFixFn
    /**
     * Paths currently uncommitted in the working tree (`git status` shape), used to
     * detect SUB-FIXES a non-converging final-gate autofix left behind (mx5 run 13
     * PROMPT 4 item 3). Every task is committed by the time the final gate runs, so
     * anything dirty here is the fix pass's own work. Absent → the stranded-fix
     * handling is skipped entirely (prior behavior).
     */
    pendingChanges?: (cwd: string) => Promise<string[]>
}

// Matches pi's @-file completion token (a path after @, until whitespace).
const MENTION_RE = /(?:^|\s)@([^\s]+)/g

// Trailing punctuation a user naturally types AFTER an @-mention when it sits in
// prose — "Implement @design.md, reuse…" or "see @spec.md." — which the greedy
// [^\s]+ above would otherwise swallow into the path. Left unstripped, the
// resulting "design.md," resolves to no file, expansion is silently skipped, and
// the planner reasons over a one-line "Implement @design.md" with NO spec inline
// → it fabricates generic questions/tasks the spec never called for (validated:
// a stray comma turned a 32KB design into a contentless prompt). None of these
// chars are legitimate trailing characters of a referenced doc path.
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/** The cleaned path token of an @-mention: greedy match minus trailing prose punctuation. */
function mentionPath(token: string): string {
    return token.replace(MENTION_TRAILING_PUNCT, '')
}

/**
 * Fire-and-forget debug line for the PLAN phase (clarify/decompose), which runs
 * before any task file — hence any per-task `TASK_XXXX-debug.log` — exists. Writes
 * to `.pi-tasks/plan-debug.log`; the `*-debug.log` suffix keeps it grep-compatible
 * with the per-task logs. Never throws (mkdir + append are best-effort).
 */
function logPlanDebug(cwd: string, msg: string): void {
    const line = `${new Date().toISOString()} ${msg}\n`
    const dir = tasksDir(cwd)
    fsp.mkdir(dir, {recursive: true})
        .then(() => fsp.appendFile(path.join(dir, 'plan-debug.log'), line))
        .catch(() => {})
}

/** Normalise a missing-area string for cross-round identity — lowercased alnum
 *  words, punctuation and quote-wrapping collapsed. Used only to tell whether an
 *  adopted plan introduced a NEW gap versus re-surfacing the same one (#2 bonus
 *  round); intentionally coarse, so trivial rewording of the same area does not
 *  read as new and buy an extra round. */
function normMissingArea(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
}

/**
 * Clarify's answer-side TRIAGE — the second stage /task-auto's clarify gate was
 * missing that /task's grill already had. /task-auto's clarify was single-stage:
 * it generated a question and went straight to the user, with the gen prompt's
 * own "do not re-ask what the spec settles" prose as the only guard — and a weak
 * local model ignores that prose, surfacing questions the inlined spec already
 * answers (the "use Hono's Bun adapter or node adapter?" question when the spec
 * pins the Bun adapter outright).
 *
 * grill is gen → AUTO-ANSWER triage → user; clarify was gen → user. This runs
 * grill's exact triage (ALREADY-DECIDED → FUNCTIONAL-REQUIREMENT → reversibility,
 * see GRILL_AUTO_ANSWER_PROMPT) against the inlined spec BEFORE a question reaches
 * the user. If the spec already settles the answer (or it's a cheap-to-undo
 * default the user would accept without thinking), the question is auto-resolved
 * and never shown — the resolved value still flows into the clarify transcript so
 * decompose sees the decision and the next gen call won't re-ask it. Only a
 * genuine UNKNOWN — a fork the spec leaves open — survives to the user.
 *
 * Returns the auto-resolved answer string when the question is settled, or null
 * to surface it. The source fed to the triage is the feature spec itself; there
 * is no per-feature research blob at this pre-decomposition stage (each task does
 * its own research downstream), so the "Research" slot is a stub. Best-effort: a
 * throw or an untagged reply falls back to surfacing the question (the prior
 * behavior), never dropping it silently.
 */
async function triageClarifyQuestion(
    deps: AutoDeps,
    cwd: string,
    featureForModel: string,
    existingFilesBlock: string,
    question: string
): Promise<string | null> {
    try {
        // Prepend the existing-files block (refine's REFINE_PRESERVE_DIRECTIVE +
        // manifest/config content) so a "scaffold/create/from scratch" question is
        // auto-resolved as an in-place UPDATE that PRESERVES what is on disk —
        // instead of "greenfield, from scratch", which the spec-only triage emitted
        // 13/15 of the time and would mint a destructive decompose decision that can
        // outrank refine's preserve directive (A/B live: 2/15 → 14/15 preserve).
        // Empty (greenfield repo / orientation off) → byte-identical to before.
        const source =
            existingFilesBlock.length > 0 ?
                `${existingFilesBlock}\n\n${featureForModel}`
            :   featureForModel
        const basePrompt = GRILL_AUTO_ANSWER_PROMPT(
            source,
            '(none — clarify runs before decomposition; each task researches itself later)',
            question
        )
        let text = await deps.runChild('clarify-triage', 'read', basePrompt)
        if (!autoAnswerHasTag(text)) {
            // No ANSWER/UNKNOWN/ALT tag — the model wrote prose. Reprompt once for
            // the tagged form before trusting parseAutoAnswer's lenient salvage,
            // exactly as phaseAutoAnswer does, so a preamble line can't masquerade
            // as a decision.
            text = await deps.runChild(
                'clarify-triage',
                'read',
                prependHint(GRILL_AUTO_FORMAT_HINT, basePrompt)
            )
        }
        const parsed = parseAutoAnswer(text)
        if (parsed.kind === 'answered') {
            logPlanDebug(
                cwd,
                `clarify-triage auto-resolved (spec-settled): ${question.replace(/\s+/g, ' ').slice(0, 100)}`
                    + ` → ${parsed.text.replace(/\s+/g, ' ').slice(0, 100)}`
            )
            return parsed.text
        }
        return null
    } catch {
        // Triage is a best-effort filter, not a gate: on any failure, surface the
        // question rather than silently dropping it.
        return null
    }
}

/**
 * Expand any @file references in the feature text by appending each referenced
 * file's contents, so the planning children (clarify, decompose) always see the
 * real spec inline instead of relying on the model to open the file itself.
 * Without this, clarify on a one-line "Implement @spec.md" tends to bail with
 * NONE because, to the model, the request looks small and unambiguous.
 * Unreadable mentions (typos, non-file @tokens) are left untouched; the feature
 * is returned verbatim when nothing readable is referenced.
 */
export async function expandFeatureMentions(cwd: string, feature: string): Promise<string> {
    const seen = new Set<string>()
    const blocks: string[] = []
    for (const m of feature.matchAll(MENTION_RE)) {
        const rel = mentionPath(m[1])
        if (rel === '' || seen.has(rel)) continue
        seen.add(rel)
        try {
            // Normalize CRLF/CR so an @-mentioned design doc saved on Windows
            // inlines with LF endings the downstream phase parsers expect.
            const body = await readTextFile(path.resolve(cwd, rel))
            if (body.trim().length > 0) {
                blocks.push(`--- contents of ${rel} ---\n${body.trim()}`)
            }
        } catch {
            // not a readable file — leave the @token in place, skip expansion
        }
    }
    return blocks.length === 0 ? feature : `${feature.trim()}\n\n${blocks.join('\n\n')}`
}

/**
 * The @file references in the feature that point at a readable file on disk —
 * the bare path tokens, deduped, in first-seen order. Unreadable mentions
 * (typos, non-file @tokens) are dropped so we never advertise a missing file as
 * an authoritative spec.
 */
export async function readableMentions(cwd: string, feature: string): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()
    for (const m of feature.matchAll(MENTION_RE)) {
        const rel = mentionPath(m[1])
        if (rel === '' || seen.has(rel)) continue
        seen.add(rel)
        try {
            await fsp.access(path.resolve(cwd, rel))
            out.push(rel)
        } catch {
            // not a readable file — don't thread it into task titles
        }
    }
    return out
}

/** A trailing "[decisions: …]" clause decompose may attach to a task line. */
const DECISIONS_RE = /\s*\[decisions:\s*(.+?)\]\s*$/i

/**
 * Thread the feature's spec references AND any per-task decisions into every
 * decomposed task title. A title is ALL a per-task pipeline ever sees, so both
 * the design doc the feature pointed at and the user's clarification choices have
 * to ride along or they're invisible downstream — this is how an "Implement
 * @design.md" run built a generic `posts` table the spec never mentioned, and how
 * a "do not use vite" clarification got silently overridden by the doc's own
 * vite.config.ts.
 *
 * Precedence is the crux: a clarification is a CORRECTION to a (possibly stale)
 * spec doc, so the decisions clause is marked as overriding the doc, while the doc
 * stays authoritative for everything the decisions don't touch. Decompose scopes
 * each decision to the task(s) it governs, so most titles carry none. No readable
 * refs and no decisions → title unchanged, so a doc-less /task-auto behaves
 * exactly as before.
 */
export function attachSpecRefs(titles: string[], refs: string[]): string[] {
    const list = refs.map(r => '@' + r).join(' ')
    return titles.map(t => {
        if (t.includes('| spec:') || t.includes('| decisions')) return t // already threaded
        const dm = DECISIONS_RE.exec(t)
        const base = dm ? t.slice(0, dm.index).trimEnd() : t
        const decisions = dm ? dm[1].trim() : ''
        let out = base
        if (decisions) {
            out += ` | decisions (explicit user choices — these OVERRIDE the spec doc wherever they conflict; follow them exactly): ${decisions}`
        }
        if (refs.length > 0) {
            out += ` | spec: ${list} — otherwise authoritative; read it and follow it over this title wherever they differ`
        }
        return out
    })
}

/**
 * Build the refine scope fence for step `currentIndex` of an N-step /task-auto
 * plan. Every per-step pipeline only ever sees its own title, so without this the
 * refine phase — told "the task title is only a pointer into that spec; follow the
 * spec" — re-expands the whole referenced design into one task (a real run
 * implemented all 24 steps under step 1). The fence lists the sibling steps by
 * number and forbids touching anything they own, so refine bounds this step's
 * slice. Validated on the local model: with the fence, refine's CONSTRAINTS gained
 * an explicit per-step deferral list and tool calls dropped 27→11.
 *
 * The plan listing strips the threaded "| decisions … | spec …" tail from each
 * title (keeps the human-readable head) so the model reads clean step names. The
 * authoritative spec ref still rides on THIS step's own title via attachSpecRefs.
 */
export function buildScopeFence(titles: string[], currentIndex: number): string {
    const n = titles.length
    const listing = titles
        .map((t, i) => {
            const head = t.split(' | ')[0].trim()
            const tag = i === currentIndex ? ' (THIS STEP)' : ''
            return `[${i + 1}]${tag} ${head}`
        })
        .join('\n')
    return (
        `PLAN CONTEXT — this task is STEP ${currentIndex + 1} of ${n} in an already-decomposed plan. `
        + `Each step below is implemented by its OWN separate run; the others are NOT your job and `
        + `are done in later runs. Implement ONLY the slice named in "Task" below.\n\n`
        + `The design/spec document the task references describes the WHOLE system across all ${n} `
        + `steps. Read it to get exact names, types, and signatures for YOUR step and to understand `
        + `how your step fits — but DO NOT design, scaffold, schema, route, page, query, component, or `
        + `test anything that belongs to another step listed below. Your GOAL / CONSTRAINTS / `
        + `KNOWN-UNKNOWNS must cover only THIS step's slice. Do not pull in tables, endpoints, pages, `
        + `components, or flows owned by a later step.\n\n`
        + `The full plan (these run separately — do NOT implement them here):\n${listing}`
    )
}

/**
 * The scope fence for step `currentIndex`, plus the REPAIR fence when that step is
 * a queued root-cause repair. A repair title ("repair test/teardown.ts: …") reads
 * to refine like any other feature step, and refine's job is to expand a title into
 * a full spec — which is exactly how "repair the teardown" becomes "overhaul the
 * test infrastructure" (the /task-auto drift lesson). The extra fence pins the one
 * editable file and pins VERIFY to the command the defect was failing.
 */
function buildStepFence(titles: string[], currentIndex: number): string {
    const base = buildScopeFence(titles, currentIndex)
    const repairFile = parseRepairTitleFile(titles[currentIndex] ?? '')
    if (!repairFile) return base
    return `${base}\n\n${buildRepairScopeFence(repairFile, extractFailingCommand(titles[currentIndex] ?? ''))}`
}

/**
 * Drain the gate's root-cause repair queue into the running plan: one scoped
 * repair step per accused FILE, spliced in directly after the step that just
 * finished.
 *
 * Three bounds, all mandatory (mx5 run 14 item 5 gray areas):
 *   - DEDUP by file — run 14's two `test/teardown.ts` debts must yield ONE repair
 *     step, not two. mergeRepairCandidates collapses the drained queue, and
 *     planHasRepairFor rejects a file the plan already carries a repair for.
 *   - CAP 1 per file per RUN — planHasRepairFor counts CHECKED-OFF entries too, so
 *     a repair step that itself failed is never re-spawned; it lands in the
 *     accept-debt ledger like any other task. That is what stops a repair loop.
 *   - MONOTONIC — insertTaskAfter only splices; no existing entry is rewritten,
 *     reordered or dropped (the run-12 replacement lesson).
 *
 * Best-effort throughout: a fault here must never fail the run that produced the
 * finding — the debt is already durably recorded either way.
 */
async function schedulePendingRepairs(
    cwd: string,
    id: string,
    afterIndex: number,
    ctx: ExtensionCommandContext,
    deps: AutoDeps
): Promise<void> {
    try {
        const pending = await drainRepairQueue(cwd)
        if (pending.length === 0) return
        const {body} = await readTaskFile(cwd, id)
        const titles = parseTaskList(body).map(e => e.title)
        let at = afterIndex
        for (const repair of mergeRepairCandidates(pending)) {
            if (planHasRepairFor(titles, repair.file)) continue
            const title = buildRepairTitle(repair)
            if (!(await insertTaskAfter(cwd, id, at, title))) continue
            titles.splice(at + 1, 0, title)
            at += 1
            await deps.record?.(
                cwd,
                id,
                `plan: inserted scoped repair step after step ${afterIndex + 1} — ${title}`
            )
            ctx.ui.notify(
                `${id}: queued a scoped repair for ${repair.file} (${repair.owner}'s file — root cause of ${repair.blamed.join(', ')}).`,
                'warning'
            )
        }
    } catch {
        // the plan is best-effort here; the underlying debt is already recorded
    }
}

/** Plan phase: clarify → decompose → write AUTO file. Returns the new id, or null. */
export async function planAuto(
    ctx: ExtensionCommandContext,
    cwd: string,
    feature: string,
    deps: AutoDeps
): Promise<string | null> {
    // clarify — sequential & adaptive: ask one question at a time, feeding every
    // answer back into the next call so later questions react to earlier ones
    // (e.g. a framework choice reshapes what gets asked). Each question is shown
    // exactly like /task's grill dialog: a binary fork offers two options (A/B),
    // otherwise the model's recommendation is shown as the input placeholder and
    // in the title. Nothing is pre-filled into the editor — submitting an empty
    // field is what accepts the recommendation (see the typed.length === 0 branch
    // below); typing overrides it. Each generated question first runs the
    // answer-side TRIAGE (triageClarifyQuestion): a question the inlined spec
    // already settles is auto-resolved and never shown — only genuine open forks
    // reach the user. The model emits NONE when nothing remains.
    const theme = ctx.ui.theme
    const ui = new SessionUI(ctx)
    // Inline any @file spec the user referenced so clarify/decompose reason over
    // the real content, not a one-line "Implement @file" that reads as trivial.
    const rawFeatureForModel = await expandFeatureMentions(cwd, feature)
    // Strike phantom runtime specifiers (`bun:sql`) out of the inlined spec BEFORE
    // clarify/decompose ever see it. Layer A only rewrites the per-task `refined`
    // text — which is DOWNSTREAM of here: clarify is the first phase and runs on
    // this raw inline, so the doc's affirmative `bun:sql` is parroted straight into
    // the very first clarifying question ("instantly bun:sql is back"). Apply the
    // same deterministic, no-LLM strike at the single point that feeds both planning
    // children. Silent + no-op when nothing is flagged or the runtime's types aren't
    // installed.
    const planPhantoms = findPhantomImports(rawFeatureForModel, cwd)
    const featureForModel =
        planPhantoms.length === 0 ?
            rawFeatureForModel
        :   rewritePhantomSpecifiers(rawFeatureForModel, planPhantoms)
    if (planPhantoms.length > 0) {
        logPlanDebug(
            cwd,
            `phantom specifiers rewritten in plan spec: ${planPhantoms.map(x => x.spec).join(', ')}`
        )
    }
    // Existing manifest/config on disk (REFINE_PRESERVE_DIRECTIVE + tier 0–1
    // content), computed ONCE and fed to every triage call so a "scaffold X"
    // question resolves to an in-place update instead of "greenfield". '' for a
    // greenfield/non-git repo or orientation off → triage stays spec-only.
    const existingFilesBlock = await refineExistingFilesBlock({
        cwd,
        taskId: '',
        signal: new AbortController().signal
    }).catch(() => '')
    const answers: string[] = []
    // Plain text of every question already shown, for the duplicate backstop.
    const askedQuestions: string[] = []
    // Deterministic guard against a model that ignores "never re-ask": consecutive
    // near-duplicate questions are reprompted with an explicit hint, and once it
    // strikes out (can't produce anything novel) we stop instead of barraging the
    // user with the same decision worded N ways. Also caps the absolute count.
    let dupStrikes = 0
    let dupHint: string | null = null
    // Open-ended: keep asking until the model emits NONE or the user dismisses —
    // but never past MAX_CLARIFY_QUESTIONS distinct questions.
    while (askedQuestions.length < MAX_CLARIFY_QUESTIONS) {
        const qRaw = await deps.runChild(
            'auto-clarify',
            'read',
            prependHint(dupHint, AUTO_CLARIFY_PROMPT(featureForModel, answers.join('\n')))
        )
        const parsed = parseClarifyList(qRaw)
        if (parsed.length === 0) break // NONE / nothing left to ask
        // Backstop: if the model re-asked a topic already settled, don't surface it.
        // Reprompt it to move on or finish; give up after MAX_DUP_STRIKES so a model
        // stuck on one fork can't loop forever.
        if (isDuplicateQuestion(askedQuestions, stripInlineMarkdown(parsed[0].question))) {
            dupStrikes++
            if (dupStrikes >= MAX_DUP_STRIKES) break
            dupHint = DUP_REPROMPT_HINT
            continue
        }
        dupStrikes = 0
        dupHint = null
        const {question, suggested, alt} = parsed[0]
        // Render markdown (bold/code) for the displayed prompt; keep plain text
        // for the editable default and the persisted file.
        const shownQ = renderInlineMarkdown(question, theme)
        const plainQ = stripInlineMarkdown(question)
        askedQuestions.push(plainQ)
        // Answer-side triage (grill parity): if the inlined spec already settles
        // this question, auto-resolve it and never show it. The resolved value is
        // recorded so decompose sees the decision and the next gen call's priorQA
        // won't re-ask it.
        const autoResolved = await triageClarifyQuestion(
            deps,
            cwd,
            featureForModel,
            existingFilesBlock,
            plainQ
        )
        if (autoResolved !== null) {
            answers.push(
                `Q${answers.length + 1}: ${plainQ}\n`
                    + `A${answers.length + 1}: ${autoResolved} (auto-resolved — already settled by the spec)`
            )
            continue
        }
        const plainSuggested = suggested === undefined ? undefined : stripInlineMarkdown(suggested)
        const plainAlt = alt === undefined ? undefined : stripInlineMarkdown(alt)
        // Identical to /task's grill dialog: a recommendation (or A/B fork)
        // becomes the boxed picker locally — each answer in its own bounding box,
        // the recommended one tinted green; an open question shows the bare text
        // prompt. No verbose "Recommended:" / "press Enter to accept" scaffolding.
        const twoOption = plainSuggested !== undefined && plainAlt !== undefined
        // YOLO: take the recommended option (index 0 / the green card) without ever
        // building the prompt. Clarify has no anti-synthesis channel — it runs before
        // any research — so the only step-aside here is a question that carries no
        // recommendation to take; that one is skipped rather than guessed.
        const yolo = yoloPickAnswer(isYoloMode(), {
            ...(plainSuggested !== undefined && {suggested: plainSuggested}),
            ...(plainAlt !== undefined && {alt: plainAlt})
        })
        if (yolo !== null) {
            const auto = yolo.kind === 'answer' ? yolo.answer : `(skipped — ${yolo.note})`
            answers.push(
                `Q${answers.length + 1}: ${plainQ}\n`
                    + `A${answers.length + 1}: ${auto} ${YOLO_STAMP}`
            )
            continue
        }
        const options =
            twoOption ?
                [
                    {
                        label: `A: ${renderInlineMarkdown(suggested!, theme)}`,
                        value: plainSuggested!
                    },
                    {label: `B: ${renderInlineMarkdown(alt!, theme)}`, value: plainAlt!}
                ]
            : plainSuggested !== undefined ?
                [{label: renderInlineMarkdown(suggested!, theme), value: plainSuggested}]
            :   undefined
        const a = await ui.ask({
            localTitle: shownQ,
            displayQuestion: shownQ,
            question: plainQ,
            recommended: plainSuggested,
            ...(plainAlt !== undefined && {recommended2: plainAlt}),
            allowSkip: plainSuggested === undefined && plainAlt === undefined,
            ...(options && {options})
        })
        if (a === undefined) {
            announceDone(ctx, '/task-auto cancelled.', 'warning')
            return null
        }
        const typed = a.trim()
        // The local picker resolves to the chosen option's full value, but a
        // remote user (or the picker's free-text fallback) may still type a bare
        // "A"/"B" — map those back to the option's full text. Mirrors phaseGrill.
        let answer: string
        if (typed.length === 0 && plainSuggested) {
            answer = `${plainSuggested} (accepted recommendation)`
        } else if (typed.length === 0) {
            answer = '(skipped)'
        } else if (twoOption && /^a[.)]?$/i.test(typed)) {
            answer = plainSuggested!
        } else if (twoOption && /^b[.)]?$/i.test(typed)) {
            answer = plainAlt!
        } else if (!twoOption && plainSuggested !== undefined && typed === plainSuggested) {
            // Single recommendation accepted by picking its (green) card in the
            // boxed picker — same provenance as an empty-submit accept.
            answer = `${plainSuggested} (accepted recommendation)`
        } else {
            answer = typed
        }
        answers.push(`Q${answers.length + 1}: ${plainQ}\nA${answers.length + 1}: ${answer}`)
    }
    if (answers.length === 0) {
        ctx.ui.notify('No clarifying questions needed — planning tasks…', 'info')
    }
    const clarifications = answers.join('\n')

    // Requirement extraction (mx5 run 11, goal A): grounded requirement units,
    // extracted from whatever structure the spec has, BEFORE decompose — they ride
    // into the decompose prompt as a ledger (structure-mirroring can't discharge
    // them) and drive the per-requirement coverage accounting below. Best-effort:
    // a fault leaves reqEntries empty and the whole channel degrades to the old
    // behavior (one-liners / doc-less features naturally yield few or none).
    let reqEntries: RequirementEntry[] = []
    try {
        // Recall floor: the obligation-marked passages ride into the prompt as a
        // checklist, and a marked passage that produced NO quote is hard evidence
        // for one forced re-extraction (measured live: 1/5 extractions missed the
        // entire marked testing section without this).
        const passages = enumerateObligationPassages(featureForModel)
        const extractOnce = async (hint: string | null): Promise<RequirementEntry[]> =>
            keepGroundedRequirements(
                parseRequirementLines(
                    await deps.runChild(
                        'requirement-extract',
                        '',
                        prependHint(hint, REQUIREMENT_EXTRACT_PROMPT(featureForModel, passages))
                    )
                ),
                featureForModel
            )
        reqEntries = await extractOnce(null)
        const uncovered = uncoveredPassages(passages, reqEntries)
        if (uncovered.length > 0) {
            logPlanDebug(
                cwd,
                `requirement extraction: ${uncovered.length} obligation-marked passage(s) `
                    + 'uncovered — forcing one re-extraction'
            )
            const retry = await extractOnce(extractionRetryHint(uncovered))
            // Union of both grounded passes (keepGrounded dedupes).
            reqEntries = keepGroundedRequirements([...reqEntries, ...retry], featureForModel)
        }
        // Bound with marked-passage priority — a plain first-N cap truncates the
        // doc's tail sections (measured live: an eager model fills 40 top-down).
        reqEntries = capRequirements(reqEntries, passages)
        logPlanDebug(
            cwd,
            `requirement extraction: ${reqEntries.length} grounded requirement(s) kept`
        )
    } catch {
        // best-effort channel
    }

    // Artifact-production closure, plan side (mx5 run 13, PROMPT 2): runtime
    // files the spec REFERENCES (server snippets, prose "serve the built
    // index.html") that neither its file tree, its parsed build outputs, nor the
    // existing scaffold produce. Sentence-grounded coverage credited the SERVING
    // side and reported "0 unowned" while nothing ever CREATED the file — so
    // these ride the coverage loop's `missing` list as unowned areas until some
    // task title claims the artifact (grounded in titles, which the coverage-map
    // model cannot fake — the run-12 lesson). Deterministic and best-effort.
    let specDangling: DanglingRef[] = []
    try {
        specDangling = findSpecDanglingArtifacts(featureForModel, rel =>
            existsSync(path.join(cwd, rel))
        )
        if (specDangling.length > 0) {
            logPlanDebug(
                cwd,
                `artifact closure: ${specDangling.length} dangling runtime artifact(s) in the `
                    + `spec: ${specDangling.map(d => d.path).join(', ')}`
            )
        }
    } catch {
        // best-effort channel
    }

    // Tests-in-the-same-change cadence (mx5 run 14, PROMPT item 6): when the
    // decisions mandate it, a whole-project batch test task contradicts them —
    // run 14 shipped one anyway (TASK_0037, 4.7h, yolo-accepted FAIL) because
    // decompose mirrors the spec's milestone shape. The decisions channel
    // OVERRIDES the spec doc, so this resolves toward the decision without asking.
    const noBatchTests = mandatesTestsInSameChange(clarifications, featureForModel)
    if (noBatchTests) {
        logPlanDebug(
            cwd,
            'decisions mandate tests-in-the-same-change — batch test tasks are banned '
                + 'from this plan (prompt rule + host rewrite)'
        )
    }

    // decompose
    const decomposePrompt = AUTO_DECOMPOSE_PROMPT(
        featureForModel,
        clarifications,
        buildRequirementsLedger(reqEntries),
        noBatchTests
    )
    // Parse + FIDELITY RECONCILIATION (mx5 run 11, goal B): ground each title's
    // [source: "…"] citation against the doc, strip the clause, and re-attach any
    // `+`-joined constraint fragment the paraphrased title dropped (the silently
    // stripped "+ tests" class). Applied to EVERY decompose output — initial,
    // suspect-retry, coverage-retry — so no path ships an unreconciled list.
    const parsePlan = (raw: string): string[] => {
        const plan = reconcileTitleSources(parseDecomposeList(raw), featureForModel)
        if (plan.sourced > 0 || plan.restored.length > 0) {
            logPlanDebug(
                cwd,
                `decompose fidelity: ${plan.sourced}/${plan.titles.length} titles cited a grounded source; `
                    + `${plan.restored.length} restoration(s)`
                    + plan.restored
                        .map(r => ` [task ${r.index + 1}: ${r.fragments.join(', ')}]`)
                        .join('')
            )
        }
        // Batch-test ban (item 6): drop or scope a whole-project "write all the
        // tests" task. Identity unless the cadence decision is present, and the
        // sweep replacement re-grounds every requirement the drop would cost — so
        // planned coverage cannot fall (run 12's lesson).
        const debatched = rewriteBatchTestPlan(
            plan.titles,
            clarifications,
            featureForModel,
            reqEntries.map(e => e.quote),
            isCrossCuttingRequirement
        )
        for (const a of debatched.actions) {
            logPlanDebug(
                cwd,
                `batch test task ${a.kind} (tests-in-same-change decision): "${a.title}"`
                    + (a.kind === 'scoped' ?
                        ` → scoped sweep over ${a.orphaned.length} orphaned requirement(s)`
                    :   ' — every requirement it touched is owned by another task')
            )
        }
        return debatched.titles
    }
    const listRaw = await deps.runChild('auto-decompose', 'read', decomposePrompt)
    let planTitles = parsePlan(listRaw)
    logPlanDebug(cwd, `decompose produced ${planTitles.length} title(s)`)
    // Distrust floor (see isSuspectPlan): a ≤2-title plan for a multi-KB spec is
    // regenerated once BEFORE the judge runs — the judge cannot be trusted to
    // catch it (3/10 live false-pass) and a hinted retry heals it reliably
    // (5/5 live). Longer list wins; a still-suspect plan falls through to the
    // judge loop as before, so this never blocks planning.
    if (isSuspectPlan(planTitles, featureForModel)) {
        logPlanDebug(
            cwd,
            `decompose suspect (${planTitles.length} title(s) for a ${featureForModel.length}-char spec)`
                + ` — raw output: ${listRaw.trim().slice(0, 300)}`
        )
        const retryRaw = await deps.runChild(
            'auto-decompose',
            'read',
            prependHint(suspectPlanHint(planTitles.length), decomposePrompt)
        )
        const retryTitles = parsePlan(retryRaw)
        logPlanDebug(cwd, `decompose suspect-retry produced ${retryTitles.length} title(s)`)
        if (retryTitles.length > planTitles.length) planTitles = retryTitles
    }
    // Coverage gate: a stochastic degenerate completion (live mx5: ONE task +
    // natural EOS for an 18KB design doc) is nonempty, so the length guard below
    // never fires and the whole run "completes" after one task. Judge the list
    // against the feature with a no-tools child; on INCOMPLETE, re-run decompose
    // with the missing areas as a hint. Best-effort so a triage fault never blocks
    // planning (mirrors triageClarifyQuestion).
    //
    // Two hard-won invariants (mx5 run 12: a complete full-stack plan — 31
    // requirements mapped, frontend pages present — was overwritten by a
    // backend-only regeneration and shipped with only a toast, driven by 3 NEGATIVE
    // requirements no task could own that kept the verdict INCOMPLETE forever):
    //   • MONOTONIC replacement (coverage-loop.ts): a retry that DROPS a requirement
    //     the current plan already owns is REJECTED, never adopted. Coverage can
    //     only hold or grow across rounds — a worse regeneration can no longer
    //     overwrite a better plan on the old `length*2` size floor alone.
    //   • SHIP THE BEST, not the last: because adoption is monotone, the working
    //     plan at exhaustion is the best-covered one seen, so it is what ships.
    // Fix A rides in accountCoverage: an un-ownable prohibition/global-policy
    // requirement is carried CROSS-CUTTING rather than fed back as a missing area,
    // so it no longer forces the loop to regenerate at all. The monotonic rule is
    // the hard backstop that holds even for un-ownable lines the classifier misses.
    //
    // Score one plan: the holistic judge (belt — catches areas the requirement
    // extraction itself missed) plus, when requirements were extracted, the
    // host-side per-requirement map (lever — every grounded requirement gets a
    // falsifiable TASK/CROSS/NONE verdict). Best-effort: a fault degrades a signal,
    // never blocks planning.
    const scorePlan = async (
        titles: string[]
    ): Promise<{
        plan: CoveragePlan
        accounting: CoverageAccounting | null
        suspect: boolean
        // The holistic-judge missing areas alone (NOT the quoted unmapped entries,
        // which the grounded accounting already carries). This is the belt-only
        // channel — areas requirement-extraction never captured, so nothing durable
        // sees them unless carried explicitly at exhaustion (see the carry below).
        judgeMissing: string[]
    }> => {
        let verdict: CoverageVerdict | null
        try {
            verdict = parseCoverageVerdict(
                await deps.runChild(
                    'decompose-coverage',
                    '',
                    DECOMPOSE_COVERAGE_PROMPT(featureForModel, clarifications, titles)
                )
            )
        } catch {
            verdict = null
        }
        const verdictMissing = verdict?.kind === 'incomplete' ? verdict.missing : []
        let acc: CoverageAccounting | null = null
        // The monotonic guard's owned-set is grounded DETERMINISTICALLY in
        // requirement↔title token overlap — NOT the coverage-map model's TASK
        // numbers. Live (Qwen3.6-27B) the model over-credits ownership, mapping a
        // "--json output" requirement to a generic "scaffold + argument parser"
        // task, so a plan with no --json task still "owned" it and the drop guard
        // went blind (treatment 1/5). Grounding the drop-signal in the titles the
        // model can't fake takes it back to 5/5. The model map still drives Fix A's
        // cross-cutting/unmapped accounting below (that only affects reprompt
        // aggressiveness, which the monotonic guard now backstops).
        const covered = groundedCoverage(
            reqEntries.map(e => e.quote),
            titles,
            isCrossCuttingRequirement
        )
        if (reqEntries.length > 0) {
            try {
                const mappings = parseCoverageMap(
                    await deps.runChild(
                        'coverage-map',
                        '',
                        COVERAGE_MAP_PROMPT(reqEntries, titles)
                    ),
                    reqEntries.length,
                    titles.length
                )
                acc = accountCoverage(reqEntries, mappings)
                logPlanDebug(
                    cwd,
                    `coverage-map (${titles.length} titles): ${acc.mapped.length} task-mapped, `
                        + `${acc.crossCutting.length} cross-cutting, ${acc.unmapped.length} unmapped; `
                        + `${covered.size} requirement(s) title-grounded`
                )
            } catch {
                // mapping fault — Fix A accounting degrades; the grounded owned-set
                // above still guards against drops.
            }
        }
        const missing = [...verdictMissing, ...(acc?.unmapped ?? []).map(e => `"${e.quote}"`)]
        // Unclaimed dangling artifacts are unowned areas: they force a coverage
        // round that assigns a producing task, and clear as soon as a title
        // names the file.
        for (const d of specDangling) {
            if (!titlesCoverArtifact(titles, d)) missing.push(danglingMissingText(d))
        }
        return {
            plan: {titles, covered, missing},
            accounting: acc,
            suspect: isSuspectPlan(titles, featureForModel),
            judgeMissing: verdictMissing
        }
    }

    const hasRequirements = reqEntries.length > 0
    // `best` is both the plan the next round reprompts FROM and the plan that
    // ships — kept identical because adoption is monotone (see coverage-loop.ts).
    let best = await scorePlan(planTitles)
    // The carried accounting (cross-cutting + unowned) for the plan that ships.
    let accounting: CoverageAccounting | null = best.accounting
    let round = 0
    // #2: the round cap can be lifted ONCE. An adoption is a fresh whole-plan roll,
    // so the plan that gets adopted can expose an uncovered area the pre-adoption
    // plan never had — and if that adoption lands on the last allowed round, the
    // loop breaks before the new gap ever gets a reprompt (mx5 2026-07-16: the
    // 55-title plan was adopted on the final round AND was the first to reveal §10's
    // test-infra gap; the cap fired the same instant, so it was never chased). Grant
    // exactly one bonus round when — and only when — an adoption introduces a NEW
    // missing area at the cap. Bounded to one so a judge that flags forever still
    // cannot loop the plan phase; a persistent (non-new) gap never re-triggers it.
    let roundCap = MAX_COVERAGE_ROUNDS
    let bonusRoundUsed = false
    for (;;) {
        if (best.plan.titles.length === 0) break
        if (best.plan.missing.length === 0) {
            logPlanDebug(
                cwd,
                'decompose-coverage: COMPLETE'
                    + (hasRequirements ?
                        ' — every grounded requirement is task-mapped or cross-cutting'
                    :   ' — accepting list')
            )
            // A COMPLETE on a still-suspect plan is the judge's known live false-pass
            // mode (bare verdict, indistinguishable from a real one). The plan still
            // ships — the floor never rejects on count — but never silently.
            if (best.suspect) {
                ctx.ui.notify(
                    `/task-auto: only ${best.plan.titles.length} task(s) planned for a large spec`
                        + ' and the regeneration did not grow the list — review the plan before running.',
                    'warning'
                )
            }
            break
        }
        if (round >= roundCap) break
        round++
        logPlanDebug(
            cwd,
            `decompose-coverage round ${round}: INCOMPLETE — missing: `
                + best.plan.missing.join('; ').slice(0, 300)
        )
        const retryTitles = parsePlan(
            await deps.runChild(
                'auto-decompose',
                'read',
                prependHint(coverageRepromptHint(best.plan.missing), decomposePrompt)
            )
        )
        logPlanDebug(cwd, `decompose retry produced ${retryTitles.length} title(s)`)
        const cand = await scorePlan(retryTitles)
        const decision = decideAdoption(best.plan, cand.plan, hasRequirements)
        if (decision.adopt) {
            // Snapshot the pre-adoption plan to decide whether this adoption earns a
            // bonus round. Two guards keep the bonus off generic judge churn: it must
            // be a real coverage GAIN (grounded covered-set strictly grew — a flaky
            // judge that just relabels the same-shaped plan's gap does not qualify),
            // and it must expose a NEW area (a gap already present is one we have or
            // will reprompt against anyway). Requirements-path only: without grounded
            // requirements "missing" is pure holistic-judge free-text that can change
            // every round, so there is no trustworthy "grew"/"new" signal to gate on.
            const priorCovered = best.plan.covered.size
            const priorMissing = new Set(best.plan.missing.map(normMissingArea))
            best = cand
            accounting = cand.accounting ?? accounting
            logPlanDebug(cwd, `decompose retry ADOPTED — ${decision.reason}`)
            if (
                !bonusRoundUsed
                && round >= roundCap
                && hasRequirements
                && cand.plan.covered.size > priorCovered
                && cand.plan.missing.some(m => !priorMissing.has(normMissingArea(m)))
            ) {
                bonusRoundUsed = true
                roundCap++
                logPlanDebug(
                    cwd,
                    'decompose-coverage: bonus round granted — adoption grew coverage and '
                        + 'exposed a new uncovered area at the cap'
                )
            }
        } else {
            // Rejected: keep the better current plan. The loop re-checks it at the
            // top (still incomplete ⇒ another bounded reprompt) but its coverage is
            // never sacrificed to a worse regeneration.
            logPlanDebug(
                cwd,
                `decompose retry REJECTED — ${decision.reason}`
                    + (decision.dropped.length > 0 ?
                        ` [would drop: ${decision.dropped
                            .map(i => `"${reqEntries[i].quote}"`)
                            .join('; ')
                            .slice(0, 200)}]`
                    :   '')
            )
        }
    }
    planTitles = best.plan.titles
    // Exhausted still INCOMPLETE: the best plan ships (the gate is best-effort), but
    // silently shipping a KNOWN-gapped plan is how mx5 run 5 lost its whole test
    // suite — tell the user what is still uncovered.
    const unresolvedMissing = best.plan.missing.length > 0 ? best.plan.missing : null
    if (unresolvedMissing !== null) {
        logPlanDebug(
            cwd,
            `decompose-coverage exhausted ${round} round(s) still INCOMPLETE — missing: `
                + unresolvedMissing.join('; ').slice(0, 300)
        )
        ctx.ui.notify(
            `/task-auto: no task fully owns — ${unresolvedMissing.join('; ').slice(0, 200)}. `
                + 'Carried into every task via .pi-tasks/requirements.md, but not as a dedicated '
                + 'task. To give it one, stop now and add it to the plan in .pi-tasks/; otherwise '
                + 'it proceeds.',
            'warning'
        )
    }
    // Carry what no single task owns (goal A(b)/(c)): cross-cutting requirements
    // become `.pi-tasks/requirements.md`, injected VERBATIM into every task's
    // refine/compose (run 11: §10's test-first cadence had no carrier — the "spec
    // is authoritative" pointer recovered it in 1 of ~6 tasks; content travels,
    // pointers don't). Requirements still unmapped after the rounds are carried
    // too — marked — and recorded user-visibly in the plan file, never dropped.
    //
    // #1: the holistic-judge missing areas are carried as a THIRD channel. They are
    // areas requirement-extraction never captured as a tracked entry (so the
    // grounded accounting is structurally blind to them), seen only by the judge —
    // exactly the class that, having no carrier, was warned-about then dropped (mx5
    // 2026-07-16, §10 test-infra). Carried independent of `accounting` so a mapping
    // fault (accounting === null) can't strand them either.
    const carriedCrossCutting = accounting?.crossCutting ?? []
    const carriedUnmapped = accounting?.unmapped ?? []
    const carriedJudge = best.judgeMissing
    // Dangling artifacts still unclaimed by any title of the SHIPPING plan are a
    // fourth channel: the producing obligation travels verbatim into every task
    // (whichever task builds the referencing side must also produce the file),
    // and the final gate re-checks the shipped tree regardless.
    const carriedDangling = specDangling
        .filter(d => !titlesCoverArtifact(planTitles, d))
        .map(danglingCarryText)
    if (
        carriedCrossCutting.length > 0
        || carriedUnmapped.length > 0
        || carriedJudge.length > 0
        || carriedDangling.length > 0
    ) {
        await appendCarriedRequirements(
            cwd,
            carriedCrossCutting,
            carriedUnmapped,
            carriedJudge,
            carriedDangling
        )
        const parts = [
            carriedCrossCutting.length > 0 ? `${carriedCrossCutting.length} cross-cutting` : '',
            carriedUnmapped.length > 0 ? `${carriedUnmapped.length} unowned` : '',
            carriedJudge.length > 0 ? `${carriedJudge.length} judge-flagged` : '',
            carriedDangling.length > 0 ? `${carriedDangling.length} dangling-artifact` : ''
        ].filter(p => p.length > 0)
        ctx.ui.notify(
            `/task-auto: carrying ${parts.join(', ')} requirement(s) into every task`
                + ' — see .pi-tasks/requirements.md.',
            'info'
        )
    }
    // Cross-slice contract registry (mx5 run 8, F3): now that the plan is settled,
    // extract the interface facts MORE THAN ONE slice must agree on — endpoint paths,
    // exported signatures, file layouts, env var names the DESIGN pins — into a
    // run-level artifact each downstream refine/compose/verify reads. The extraction
    // child EMITs `CONTRACT:` lines, but every quote is re-grounded HOST-SIDE against
    // the design (keepGroundedContracts): a fact the child paraphrased or invented is
    // not a substring of the doc and is dropped, so a fabricated contract — exactly
    // the F3 bug — can never enter the registry. Best-effort: any fault here is
    // swallowed (the registry is a sharpener, never a planning blocker).
    try {
        const contractRaw = await deps.runChild(
            'contract-extract',
            '',
            CONTRACT_EXTRACT_PROMPT(featureForModel, planTitles)
        )
        const grounded = keepGroundedContracts(parseContractLines(contractRaw), featureForModel)
        logPlanDebug(
            cwd,
            `contract extraction: ${grounded.length} grounded contract(s) kept`
                + ` from ${parseContractLines(contractRaw).length} emitted`
        )
        await appendContracts(cwd, grounded)
    } catch {
        // best-effort registry
    }

    // Launch contract (mx5 run 10 item 4): extract the package/build SCRIPTS the design
    // declares the project must expose (`migrate`/`seed` fell through decompose and
    // shipped missing, unchecked). Each emitted name is re-grounded against the design
    // (keepGroundedScripts — kept only if the design backticks it), so the final gate's
    // manifest diff can never false-flag a hallucinated script. Recall is mechanical
    // (mx5 run 11): enumerateScriptCandidates hands the child every backticked
    // script-shaped token near the word "script" as a checklist, so a script declared
    // far from the design's summary list (`test:ct` in §2 vs §9's five) can't be
    // missed by a weak model's recall — the child classifies, it no longer recalls.
    // Best-effort.
    try {
        const scriptRaw = await deps.runChild(
            'launch-extract',
            '',
            LAUNCH_EXTRACT_PROMPT(featureForModel, enumerateScriptCandidates(featureForModel))
        )
        const grounded = keepGroundedScripts(parseScriptLines(scriptRaw), featureForModel)
        logPlanDebug(
            cwd,
            `launch-contract extraction: ${grounded.length} grounded script(s) kept`
                + ` from ${parseScriptLines(scriptRaw).length} emitted`
        )
        await appendDeclaredScripts(cwd, grounded)
    } catch {
        // best-effort artifact
    }

    // Thread the feature's spec doc(s) into every title so each per-task
    // pipeline — which only ever sees its title — reads the real spec instead of
    // a lossy one-line paraphrase of it.
    const refs = await readableMentions(cwd, feature)
    const titles = attachSpecRefs(planTitles, refs)
    if (titles.length === 0) {
        announceDone(ctx, '/task-auto: no tasks produced from the feature.', 'warning')
        return null
    }

    // persist
    const id = await allocateAutoId(cwd)
    const now = new Date().toISOString()
    const fm: TaskFrontMatter = {
        id,
        state: 'in_progress',
        phase: 'done',
        created_at: now,
        updated_at: now,
        title: deriveTitle(feature)
    }
    // Durable, user-visible coverage record (goal A(c)): what was carried and what
    // stayed unowned lives in the plan file itself, not only in a transient toast.
    const coverageNote =
        accounting === null ? '' : (
            [
                `${reqEntries.length} grounded requirement(s): ${accounting.mapped.length} task-mapped, `
                    + `${accounting.crossCutting.length} cross-cutting (carried into every task via `
                    + `.pi-tasks/requirements.md), ${accounting.unmapped.length} unowned`,
                ...accounting.crossCutting.map(e => `- carried: "${e.quote}"`),
                ...accounting.unmapped.map(e => `- UNOWNED (no task covers this): "${e.quote}"`)
            ].join('\n')
        )
    await writeTaskFile(cwd, fm, buildAutoBody(feature, clarifications, titles, coverageNote))
    return id
}

/** The two feature-level planning children, shown as steps in the loader. */
const AUTO_PLAN_STEPS: Record<string, {step: string; stepNum: number}> = {
    'auto-clarify': {step: 'clarify', stepNum: 1},
    'auto-decompose': {step: 'decompose', stepNum: 2},
    'decompose-coverage': {step: 'coverage', stepNum: 2},
    'contract-extract': {step: 'contracts', stepNum: 2}
}
const AUTO_PLAN_STEP_TOTAL = 2

function defaultDeps(
    ctx: ExtensionCommandContext,
    cwd: string,
    signal: AbortSignal,
    title: string
): AutoDeps {
    // Captured by the planning loader's getState so the widget mirrors the child's
    // latest output line and context usage, exactly like the single-task phase
    // widget. (The gate children manage their own loaders inside buildGateDeps.)
    let lastLine: string | undefined
    let contextUsage: ContextSnapshot | undefined
    const parentContextWindow = getParentContextWindow(ctx)

    const phaseDeps: PhaseDeps = {
        cwd,
        taskId: '',
        signal,
        onChildOutput: (line: string) => {
            lastLine = line
        },
        onContextUsage: snapshot => {
            contextUsage = resolveContextUsage(snapshot, contextUsage, parentContextWindow)
        }
    }
    return {
        // Planning-only seam. The shared gate surface (runTask/commit/verify/
        // enforce/recommend/revert) comes from buildGateDeps below — identical to
        // what /task builds, so both commands gate the same way.
        runChild: async (name, tools, prompt) => {
            // Planning children are slow LLM calls with no UI of their own; show
            // the same status block as /task so this never goes silent until the
            // drill dialog.
            lastLine = undefined
            contextUsage = undefined
            const startedAt = Date.now()
            const {step, stepNum} = AUTO_PLAN_STEPS[name] ?? {step: name, stepNum: 1}
            const stopLoader = startAutoLoader(ctx, () => ({
                title,
                step,
                stepNum,
                stepTotal: AUTO_PLAN_STEP_TOTAL,
                startedAt,
                lastLine,
                contextUsage
            }))
            try {
                return await runPhaseChild(phaseDeps, name, tools, prompt)
            } finally {
                stopLoader()
            }
        },
        ...buildGateDeps({signal, parentContextWindow, runTask: gateRunTask}),
        // Loop-level repo integrity + run-end gate glue (see AutoDeps docs).
        unmergedPaths: cwd2 => gitUnmergedPaths(cwd2, signal),
        stashRef: cwd2 => gitStashRef(cwd2, signal),
        // The final integration gate follows the `verify work` switch: it is the
        // run-level half of the same verification story.
        finalGate: (cwd2, planText) =>
            getConfig().verifyWork ?
                runFinalIntegrationGate(cwd2, undefined, undefined, undefined, planText)
            :   Promise.resolve({ok: true, reason: 'disabled'}),
        // Uncommitted paths, for the stranded-sub-fix handling around the final-gate
        // picker (mx5 run 13 PROMPT 4 item 3). Every task is committed by the time
        // the gate runs, so whatever is dirty here belongs to the fix pass.
        pendingChanges: async cwd2 => {
            const changes = await collectTreeChanges(cwd2, signal)
            return [...changes.modified, ...changes.added, ...changes.deleted].sort()
        }
    }
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let autoRunning = false

export function requestAutoCancel(): void {
    requestCancel()
}

/**
 * Announce a terminal /task-auto-overall outcome both in the terminal and to
 * subscribed devices. The push body reuses the exact terminal message, so a
 * backgrounded phone learns the same thing the TUI shows. Used ONLY at the
 * overall run's terminal points — never per internal task (those go through
 * runSingleTask without notifyFinish, so they stay silent).
 */
function announceDone(
    ctx: ExtensionCommandContext,
    msg: string,
    level: 'info' | 'warning' | 'error'
): void {
    ctx.ui.notify(msg, level)
    // ctx.ui.notify is terminal-only and pushNotify is a backgrounded-device web
    // push — neither shows up in a remote viewer that's watching live. Mirror it
    // into the session view too (errors become a persistent red bubble).
    publishLifecycleNotice(msg, level)
    void pushNotify('Task finished', msg, 'pi-end').catch(() => {})
}

export async function runAutoLoop(
    ctx: ExtensionCommandContext,
    cwd: string,
    id: string,
    deps: AutoDeps
): Promise<void> {
    resetCancel()
    // Each task runs in its own fresh session (deps.runTask → ctx.newSession),
    // which tears down the current session and leaves the ctx we passed in stale.
    // Adopt the replacement ctx the runner hands back and use it for all further
    // UI and the next task — reusing the captured ctx throws "stale ctx".
    let active = ctx
    try {
        for (;;) {
            if (cancelCheckpoint('loop-top')) {
                announceDone(active, `${id} cancelled — resume with /task-auto-resume.`, 'warning')
                return
            }
            const {body} = await readTaskFile(cwd, id)
            const entries = parseTaskList(body)
            const next = entries.find(e => !e.done)
            if (!next) {
                // FINAL INTEGRATION GATE: every task passed its own per-slice gates,
                // but per-slice green has shipped a dead app twice (mx5 runs 3 & 5:
                // statics clean, every protected route 500ing). Run the project's
                // OWN whole-repo commands once, unaided, before declaring the run
                // complete. On a FAIL the user decides: accept (complete anyway) or
                // leave the run failed — a resume re-enters this branch and re-runs
                // the gate, so fixing and resuming converges.
                // SAFE CHECKPOINT (pre-final-gate): every task is checked off and
                // committed and the whole-repo gate has not started. A resume
                // re-enters this same branch and runs the gate then, so the run is
                // left exactly where it was — not silently declared complete.
                if (cancelCheckpoint('pre-final-gate')) {
                    announceDone(
                        active,
                        `${id} cancelled before the final integration gate — resume with /task-auto-resume.`,
                        'warning'
                    )
                    return
                }
                if (deps.finalGate) {
                    active.ui.notify(`${id}: running final integration gate…`, 'info')
                    // Run-level gate trail on the parent task file — same durable
                    // auditability contract as the per-task `## gates` records.
                    const recGate = async (line: string): Promise<void> => {
                        try {
                            await deps.record?.(cwd, id, line)
                        } catch {
                            // recording must never break the gate
                        }
                    }
                    // Hand the parent plan (the task list) to the gate so it can tell a
                    // served app from a CLI: the boot check requires a listener only for
                    // the former (mx5 run 10 — a CSS watcher satisfied "still alive").
                    // Trail EVERY aggregated failure entry (mx5 run 13): the gate now
                    // runs all sections and ranks the list; a single sliced reason
                    // line would re-hide everything past the first entry.
                    const trailGateFail = async (f: {
                        reason: string
                        failures?: string[]
                    }): Promise<void> => {
                        const list = f.failures ?? [f.reason]
                        if (list.length <= 1) {
                            await recGate(`final-gate: FAIL — ${f.reason.slice(0, 300)}`)
                            return
                        }
                        await recGate(
                            `final-gate: FAIL — ${list.length} failures (ranked, most load-bearing first)`
                        )
                        for (const [i, entry] of list.entries()) {
                            await recGate(
                                `final-gate FAIL ${i + 1}/${list.length}: ${entry.slice(0, 300)}`
                            )
                        }
                    }
                    let fin = await deps.finalGate(cwd, body)
                    // Record the outcome symmetrically (mx5 run 10 item 7): only FAIL was
                    // ever trailed, so a PASSing gate was indistinguishable from a gate
                    // that never ran. The PASS reason names the commands that were run.
                    if (fin.ok) {
                        await recGate(`final-gate: PASS — ${fin.reason.slice(0, 300)}`)
                    } else {
                        await trailGateFail(fin)
                    }
                    // ACCEPT-debt re-check surfacing (mx5 run 4 B3 / run 8 TASK_0012):
                    // tasks the user accepted despite a verify-FAIL that the gate could
                    // not prove resolved against the current tree. Surface them at the
                    // gate moment — on PASS or FAIL — so a run never completes silently
                    // carrying an accepted defect. Informational: the per-task ACCEPT was
                    // already a human decision, so this reports, it does not re-fail.
                    if (fin.openDebts && fin.openDebts.length > 0) {
                        for (const d of fin.openDebts) {
                            await recGate(
                                `defect STILL OPEN — ${d.taskId || '(unknown task)'}: ${describeDebt(d)}: ${d.reason.slice(0, 240)}${
                                    d.conflict ? ` [CONFLICTING CLAIM — ${d.conflict}]` : ''
                                }`
                            )
                        }
                        active.ui.notify(
                            `${id}: ${fin.openDebts.length} recorded verify-FAIL defect(s) are STILL unresolved at run end — see the gate trail.`,
                            'warning'
                        )
                    }
                    // Resolution loop: Leave-failed (recommended) / Autofix (bounded,
                    // model-driven fix pass + gate re-run — run 7's gap: the picker
                    // had NO automated fix path) / Accept. The user always decides;
                    // after MAX_FINAL_GATE_AUTOFIX attempts that still FAIL the
                    // autofix card is withdrawn so the loop cannot run unbounded.
                    let fixAttempts = 0
                    // Sub-fixes a non-converging autofix attempt left uncommitted.
                    // Refreshed after every attempt; drives the picker note and the
                    // terminal commit (mx5 run 13 PROMPT 4 item 3, run 14 item 2b).
                    let stranded: string[] = []
                    const refreshStranded = async (): Promise<void> => {
                        if (!deps.pendingChanges) return
                        try {
                            stranded = await deps.pendingChanges(cwd)
                        } catch {
                            // Inconclusive: say nothing rather than claim a clean tree.
                            stranded = []
                        }
                    }
                    // NON-PROGRESS / UNFALSIFIABLE-CHECK state (mx5 run 14 item 2a).
                    // `prevFailSig` is the previous attempt's normalized ranked-first
                    // failure; `demoted` holds the signatures already carried as debt,
                    // so a re-run that still reports them does not re-fail the gate.
                    let prevFailSig: string | null = null
                    const demoted = new Set<string>()
                    // Set when a write-guard rejected an attempt whose edits could NOT
                    // be discarded: REJECTED edits are then sitting in the tree and
                    // must never be committed by the terminal paths below.
                    let rejectedEditsInTree = false
                    // Commit whatever guard-clean repairs the fix passes left, on ANY
                    // terminal non-converged outcome. Run 14 ended on LEAVE with 13
                    // real repairs dirty in the tree after an unattended run — the
                    // next checkout would have destroyed them silently.
                    const commitStranded = async (
                        outcome: 'accepted' | 'left-failed'
                    ): Promise<void> => {
                        if (stranded.length === 0) return
                        if (rejectedEditsInTree) {
                            await recGate(
                                `final-gate: NOT committing ${stranded.length} working-tree change(s) — a `
                                    + `write-guard rejected an attempt and its edits could not be discarded, `
                                    + `so the tree holds REJECTED edits: ${stranded.slice(0, 8).join(', ')}`
                            )
                            return
                        }
                        try {
                            const sha = await deps.commit(cwd, STRANDED_FIX_COMMIT(id, outcome))
                            await recGate(
                                `final-gate: committed ${stranded.length} stranded fix-pass change(s)`
                                    + `${sha ? ` as ${sha}` : ''} — ${stranded.slice(0, 8).join(', ')}`
                            )
                        } catch (err) {
                            // Never break the terminal path over this — but say so, so
                            // the changes are not silently lost.
                            await recGate(
                                `final-gate: could NOT commit ${stranded.length} stranded fix-pass `
                                    + `change(s) (${err instanceof Error ? err.message : String(err)}) — `
                                    + `they remain UNCOMMITTED in the working tree: ${stranded.slice(0, 8).join(', ')}`
                            )
                        }
                    }
                    while (!fin.ok) {
                        const canAutofix =
                            deps.finalGateFix !== undefined && fixAttempts < MAX_FINAL_GATE_AUTOFIX
                        // The picker question shows the debts (the HUMAN weighs them);
                        // the autofix seed below deliberately does not — mx5 run 11's
                        // fix child executed a debt claim as an `rm` instruction.
                        const question =
                            `Final integration gate FAILED for ${id}.\n\n${fin.reason}${fin.debtNote ?? ''}\n\n`
                            + 'All tasks are checked off — this is the whole-repo check '
                            + '(the project’s own test/build/static commands, run unaided).'
                            + (fixAttempts > 0 ?
                                `\n\nAutofix attempts so far: ${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX}.`
                            :   '')
                            // Never let a partial repair be invisible at the moment
                            // the human decides (run 13: a bunfig fix that made
                            // `bun run test` pass 116/116 was stranded by an ACCEPT).
                            + strandedFixNote(stranded)
                        // YOLO: keep autofixing WHILE the card is still offered — the
                        // loop withdraws it after MAX_FINAL_GATE_AUTOFIX, so the cap
                        // that bounds a non-converging fix pass still bounds this —
                        // then LEAVE the run failed. Never 'accept': an unattended run
                        // that could not green the whole-repo gate has not produced a
                        // working project, and mx5 run 13 shows what an accepted FAIL
                        // looks like afterwards (a shipped app that 404s at `/`).
                        const yoloFinal = yoloFinalGateChoice(isYoloMode(), canAutofix)
                        if (yoloFinal !== null) {
                            await recGate(
                                `final-gate: auto-chose ${yoloFinal.action.toUpperCase()} ${YOLO_STAMP}`
                            )
                        }
                        const answer =
                            yoloFinal !== null ?
                                yoloFinal.action === 'autofix' ?
                                    FINAL_AUTOFIX_VALUE
                                :   FINAL_LEAVE_VALUE
                            :   await new SessionUI(active).ask({
                                    localTitle:
                                        'Final integration gate failed — how should pi proceed?',
                                    displayQuestion: question,
                                    question,
                                    recommended: FINAL_LEAVE_LABEL,
                                    recommended2:
                                        canAutofix ? FINAL_AUTOFIX_LABEL : FINAL_ACCEPT_LABEL,
                                    allowSkip: false,
                                    options: [
                                        {label: FINAL_LEAVE_LABEL, value: FINAL_LEAVE_VALUE},
                                        ...(canAutofix ?
                                            [
                                                {
                                                    label: FINAL_AUTOFIX_LABEL,
                                                    value: FINAL_AUTOFIX_VALUE
                                                }
                                            ]
                                        :   []),
                                        {label: FINAL_ACCEPT_LABEL, value: FINAL_ACCEPT_VALUE}
                                    ]
                                })
                        const choice = classifyFinalGateAnswer(answer)
                        if (choice.action === 'accept') {
                            await recGate('final-gate: FAIL accepted by user')
                            // STRANDED SUB-FIXES: the run completes here, so anything
                            // the fix pass repaired but never committed would be lost
                            // to the next `git checkout` while HEAD keeps the defect
                            // it fixed. Commit it as its own, named commit — the
                            // ACCEPT is a decision about the FAILING gate, never an
                            // instruction to throw away work (mx5 run 13 item 3).
                            await commitStranded('accepted')
                            active.ui.notify(
                                `${id}: final integration gate FAIL accepted by user — completing.`
                                    + (stranded.length > 0 ?
                                        ` ${stranded.length} uncommitted fix-pass change(s) committed separately.`
                                    :   ''),
                                'warning'
                            )
                            break
                        }
                        if (choice.action === 'autofix' && canAutofix) {
                            fixAttempts += 1
                            await recGate(
                                `final-gate: user chose AUTOFIX (attempt ${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX})`
                            )
                            active.ui.notify(
                                `${id}: final-gate autofix (${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX}) — bounded fix pass, then the gate re-runs…`,
                                'info'
                            )
                            const seed =
                                choice.guidance ?
                                    `${fin.reason}\n\nUser guidance: ${choice.guidance}`
                                :   fin.reason
                            const fix = await deps.finalGateFix!(active, cwd, seed)
                            if (fix.ok) {
                                await deps.commit(cwd, `FINAL GATE AUTOFIX (${id})`)
                                await recGate(
                                    `final-gate: autofix converged — ${fix.reason.slice(0, 200)}`
                                )
                                active.ui.notify(
                                    `${id}: final integration gate PASSES after autofix — ${fix.reason.slice(0, 140)}`,
                                    'info'
                                )
                                fin = {ok: true, reason: fix.reason}
                                break
                            }
                            await recGate(
                                `final-gate: autofix attempt ${fixAttempts} failed — ${fix.reason.slice(0, 200)}`
                            )
                            // A guard that rejected an attempt WITHOUT discarding leaves
                            // rejected edits behind: the terminal paths must not commit
                            // the tree after that (the cheat guard stays intact).
                            if (fix.guardTripped === true && fix.editsDiscarded !== true) {
                                rejectedEditsInTree = true
                            }
                            // The attempt's edits survive a non-convergence (only a
                            // guard trip discards). Find out what they are NOW, so
                            // the next picker shows them and a terminal outcome commits them.
                            await refreshStranded()
                            if (stranded.length > 0) {
                                await recGate(
                                    `final-gate: autofix attempt ${fixAttempts} left ${stranded.length} `
                                        + `uncommitted change(s) — ${stranded.slice(0, 8).join(', ')}`
                                )
                            }
                            active.ui.notify(
                                `${id}: final-gate autofix did not converge — ${fix.reason.slice(0, 140)}`,
                                'warning'
                            )
                            // NON-PROGRESS CLASSIFIER (mx5 run 14 item 2a). An attempt
                            // that changed the tree, re-ran the gate, and got back the
                            // SAME ranked-first failure as the previous such attempt is
                            // evidence about the CHECK, not the fix: run 14 burned all
                            // three attempts on a boot probe that could not observe a
                            // listener in that sandbox at all. Demote that one check to
                            // UNOBSERVED-with-debt and let the REMAINING checks decide.
                            const detail = rankedFirstFailure({
                                reason: fix.gateReason,
                                failures: fix.gateFailures
                            })
                            const edited = fix.gateReason !== undefined && stranded.length > 0
                            if (
                                detail !== null
                                && isNonProgress({
                                    previousSignature: prevFailSig,
                                    currentDetail: detail,
                                    edited
                                })
                            ) {
                                demoted.add(normalizeFailureDetail(detail))
                                prevFailSig = null
                                const debtReason = unobservedDebtReason(detail)
                                await recordFinalGateUnobservedDebt(cwd, id, debtReason)
                                await recGate(
                                    `final-gate: check DEMOTED to UNOBSERVED after ${fixAttempts} tree-changing `
                                        + `attempts returned an identical failure — carried as debt (origin final-gate) `
                                        + `and re-checked by the next run's gate: ${detail.slice(0, 240)}`
                                )
                                active.ui.notify(
                                    `${id}: final-gate check is unfalsifiable in this environment — carried as debt; `
                                        + 'the remaining checks decide convergence.',
                                    'warning'
                                )
                            } else {
                                prevFailSig =
                                    detail !== null ? normalizeFailureDetail(detail) : null
                            }
                            // Convergence on the REMAINING checks: a demoted signature no
                            // longer counts against the gate. Nothing left ⇒ the run
                            // converges carrying the demotion as debt, and the fix passes'
                            // repairs are committed rather than stranded.
                            if (demoted.size > 0 && fix.gateReason !== undefined) {
                                const remaining = applyDemotions(
                                    fix.gateFailures ?? [fix.gateReason],
                                    demoted
                                )
                                if (remaining.length === 0) {
                                    await deps.commit(cwd, `FINAL GATE AUTOFIX (${id})`)
                                    const converged =
                                        `converged on all remaining checks; ${demoted.size} check(s) `
                                        + 'carried as UNOBSERVED debt (unfalsifiable in this environment)'
                                    await recGate(`final-gate: ${converged}`)
                                    active.ui.notify(
                                        `${id}: final integration gate converged — ${converged}.`,
                                        'warning'
                                    )
                                    fin = {ok: true, reason: converged}
                                    break
                                }
                            }
                            // Work from the FRESH gate failure when the fix pass got
                            // as far as re-running the gate; otherwise keep the last.
                            // The full ranked list rides along (and is re-trailed
                            // when fresh) so the next picker and the next fix seed
                            // still carry every entry, not just the first. The debt
                            // note is carried so the next picker still shows the
                            // open claims (the seed never includes it).
                            // Demoted checks are stripped from what rides forward, so the
                            // next picker and the next fix seed target only what is still
                            // falsifiable — never re-aiming the child at the check the
                            // classifier just proved it cannot move.
                            const freshFailures =
                                fix.gateReason !== undefined ? fix.gateFailures : fin.failures
                            const carried =
                                freshFailures !== undefined ?
                                    applyDemotions(freshFailures, demoted)
                                :   undefined
                            fin = {
                                ok: false,
                                reason:
                                    (
                                        demoted.size > 0
                                        && carried !== undefined
                                        && carried.length > 0
                                    ) ?
                                        carried[0]!
                                    :   (fix.gateReason ?? fin.reason),
                                failures: carried,
                                debtNote: fin.debtNote
                            }
                            if (
                                fix.gateReason !== undefined
                                && (fix.gateFailures?.length ?? 0) > 1
                            ) {
                                await trailGateFail(fin)
                            }
                            continue
                        }
                        // Leave failed — the dismissal default, unchanged from the
                        // two-option picker (an unavailable autofix demotes here too).
                        await recGate(
                            yoloFinal !== null ?
                                `final-gate: left failed — autofix budget spent, nobody to ask ${YOLO_STAMP}`
                            :   'final-gate: left failed (user)'
                        )
                        // Leaving the run failed is TERMINAL for an unattended run, so
                        // the fix passes' guard-clean repairs are committed here too —
                        // run 14 left 13 of them dirty for a `git checkout` to destroy
                        // (mx5 run 13 item 3, run 14 item 2b). The user still owns the
                        // outcome; they own it with the work in HEAD, named in the trail.
                        await commitStranded('left-failed')
                        await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                        announceDone(
                            active,
                            `${id} finished all tasks but FAILED the final integration gate — ${fin.reason.slice(0, 200)} — fix and /task-auto-resume (the gate re-runs).`
                                + (stranded.length > 0 ?
                                    ` NOTE: ${stranded.length} fix-pass change(s) were committed separately (${stranded.slice(0, 4).join(', ')}).`
                                :   ''),
                            'error'
                        )
                        return
                    }
                }
                await updateTaskFrontMatter(cwd, id, {state: 'completed'})
                announceDone(active, `${id} complete — all ${entries.length} tasks done.`, 'info')
                return
            }
            // REFUSE to start on a conflicted tree: an unmerged index dooms every
            // commit ahead and a `git add -A` would silently mis-resolve it. mx5
            // run 6 burned a full impl turn + three verify passes exactly here.
            const unmerged = deps.unmergedPaths ? await deps.unmergedPaths(cwd) : []
            if (unmerged.length > 0) {
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                announceDone(
                    active,
                    `${id} stopped before "${next.title}" — the repository has unresolved merge conflicts `
                        + `(${unmerged.slice(0, 3).join(', ')}${unmerged.length > 3 ? `, +${unmerged.length - 3} more` : ''}). `
                        + 'Resolve them (git status), then /task-auto-resume.',
                    'error'
                )
                return
            }
            // Progress line. `ctx.ui.notify` is terminal-only, so a remote viewer
            // never learns how far the run has gotten — mirror it into the session
            // view too (transient toast, same as announceDone's info path).
            const progressMsg = `${id}: task ${next.index + 1}/${entries.length} — ${next.title}`
            active.ui.notify(progressMsg, 'info')
            publishLifecycleNotice(progressMsg, 'info')
            // If this entry already has a stamped inner id, it was started in a
            // previous (interrupted) run — resume it from its saved phase rather
            // than spawning a fresh task. But the stamped inner file can be gone
            // (deleted, or never written because allocation was interrupted), and
            // resuming a missing file throws ENOENT deep in the runner — which used
            // to take pi down. So verify the file exists and otherwise fall back to
            // a fresh start. Either way an unstamped/restarted entry is (re)stamped
            // the moment its inner id exists, keeping the next interruption
            // resumable. This mirrors /task-resume's continue-don't-restart.
            let resumeId = next.producedId
            if (resumeId) {
                try {
                    await fsp.access(taskFilePath(cwd, resumeId))
                } catch {
                    resumeId = undefined
                }
            }
            // Before starting, fold any uncommitted work into its own checkpoint
            // commit so a dirty tree at the start of the run — or edits left behind
            // by an interrupted/failed task — land separately instead of being swept
            // into this task's snapshot. Best-effort and a no-op on a clean tree
            // (gitCommitAll commits nothing), so it only ever produces a commit when
            // there is stray work; the matching post-task commit below is the "after"
            // half. Only the success path is announced to keep the common no-op quiet.
            const checkpoint = await deps.commit(cwd, `chore: checkpoint before "${next.title}"`)
            if (checkpoint.committed) {
                active.ui.notify(
                    `${id}: checkpointed uncommitted work before "${next.title}".`,
                    'info'
                )
            }
            // Stash ref before the task: compared after the gates so a stash pushed
            // during the task (impl model or any child) and left behind is called
            // out instead of silently waiting to detonate in a later task.
            const stashBefore = deps.stashRef ? await deps.stashRef(cwd) : undefined
            // SAFE CHECKPOINT (pre-task): the tree is committed and no inner task
            // is stamped yet, so stopping here just leaves this entry unchecked —
            // a resume restarts it from scratch. Cheapest possible stop, and the
            // last one before we commit to a ~30-minute task.
            if (cancelCheckpoint('pre-task')) {
                announceDone(
                    active,
                    `${id} cancelled before "${next.title}" — resume with /task-auto-resume.`,
                    'warning'
                )
                return
            }
            const res = await deps.runTask(active, cwd, next.title, {
                resumeId,
                // Fence this step against re-expanding the whole referenced spec:
                // name the sibling steps so refine bounds this step's slice. Only
                // matters when refine runs fresh (a resumed task past refine ignores
                // it), but always supplied so a resume that restarts at refine is
                // fenced too.
                planContext: buildStepFence(
                    entries.map(e => e.title),
                    next.index
                ),
                onStart:
                    resumeId ? undefined : (
                        innerId => stampTaskInProgress(cwd, id, next.index, innerId, next.title)
                    )
            })
            active = res.ctx ?? active
            if (res.sessionCancelled) {
                announceDone(
                    active,
                    `${id} paused — could not start a session. Run /task-auto-resume to retry.`,
                    'warning'
                )
                return
            }
            if (res.interrupted) {
                // The user interrupted implementation (ESC) and then declined to
                // steer (empty steer prompt) — they want to stop here. Pause
                // without checking the task off, so /task-auto-resume re-delivers
                // this task's spec to finish it. (A plain ESC that the user
                // follows with steering text never reaches here — that loops on
                // the same task inside runSingleTask until a turn completes.)
                await markResumable(cwd, res.taskId)
                announceDone(
                    active,
                    `${id} paused at "${next.title}" — resume with /task-auto-resume.`,
                    'warning'
                )
                return
            }
            // A phase-boundary cancel surfaces here as a plain !res.ok: the runner
            // caught its own USER_CANCELLED and wrote state 'cancelled' (resumable)
            // to the inner file. Claim it BEFORE the failure branch, or a
            // user-requested stop is announced in red as "stopped … fix and
            // resume". The inner file is already resumable and the parent stays
            // in_progress, matching the loop-top cancel.
            if (!res.ok && isCancelRequested()) {
                announceDone(
                    active,
                    `${id} cancelled during "${next.title}" — resume with /task-auto-resume.`,
                    'warning'
                )
                return
            }
            if (!res.ok) {
                // Demote the INNER task file too: it reads `completed` from
                // spec-handoff, and leaving it that way is how a failed run's task
                // file claimed success in the run 6 audit.
                await markResumable(cwd, res.taskId)
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                // res.reason is set when the implementation turn itself died
                // (e.g. a context-overflow 400) — surface it so the real cause
                // isn't lost behind the generic "stopped" message.
                const why = res.reason ? ` — ${res.reason.slice(0, 160)}` : ''
                announceDone(
                    active,
                    `${id} stopped at "${next.title}"${why} — fix and run /task-auto-resume.`,
                    'error'
                )
                return
            }
            // GATE: actually RUN the task's verification against the just-finished
            // work, then hold the committed result to AGENTS.md / CLAUDE.md. Shared
            // verbatim with /task so both commands gate identically — see
            // runGatesForTask. `done` means the work verified (or was accepted),
            // was checked off + committed, and enforcement ran; every other kind is
            // a terminal stop this loop announces with its own /task-auto-resume
            // wording (the shared gate is command-agnostic).
            const gate = await runGatesForTask(active, deps, {
                cwd,
                taskId: res.taskId,
                title: next.title,
                tag: id,
                // Fence an AUTOFIX re-run against re-expanding the whole spec.
                planContext: buildStepFence(
                    entries.map(e => e.title),
                    next.index
                ),
                // res.ok === true means runner.run() completed, so res.taskId is the
                // allocated TASK_NNNN id (never empty here). The parent task-list
                // check-off runs after verify passes/accepts and before the commit,
                // so the commit captures the checked box too.
                onVerified: () => checkOffTask(cwd, id, next.index, res.taskId, next.title)
            })
            active = gate.ctx
            if (gate.kind === 'paused') {
                await markResumable(cwd, res.taskId)
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                announceDone(
                    active,
                    `${id} paused at "${next.title}" — verification failed and you dismissed the choice; resume with /task-auto-resume.`,
                    'warning'
                )
                return
            }
            if (gate.kind === 'session-cancelled') {
                announceDone(
                    active,
                    `${id} paused — could not start a session for autofix. Run /task-auto-resume to retry.`,
                    'warning'
                )
                return
            }
            if (gate.kind === 'interrupted') {
                await markResumable(cwd, res.taskId)
                announceDone(
                    active,
                    `${id} paused at "${next.title}" — resume with /task-auto-resume.`,
                    'warning'
                )
                return
            }
            if (gate.kind === 'failed') {
                await markResumable(cwd, res.taskId)
                await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                const why = gate.reason ? ` — ${gate.reason.slice(0, 160)}` : ''
                announceDone(
                    active,
                    `${id} stopped at "${next.title}"${why} — fix and run /task-auto-resume.`,
                    'error'
                )
                return
            }
            // ROOT-CAUSE REPAIR (mx5 run 14 item 5): the gate may have attributed a
            // FAIL to a pre-existing defect in a file some OTHER task created. It can
            // only QUEUE that finding — mutating the plan is this loop's job. Drain
            // the queue and splice a scoped repair step in right after the step that
            // just finished, so the defect is fixed BEFORE the next dependent task
            // trips over it too (run 14 recorded the same `test/teardown.ts` cause
            // twice, scheduled nothing, and the bug outlived ~24h of the run).
            await schedulePendingRepairs(cwd, id, next.index, active, deps)
            // gate.kind === 'done' → fall through to the next task, after checking
            // no landmine stash was left behind by anything that ran in between.
            if (deps.stashRef && stashBefore !== undefined) {
                const stashAfter = await deps.stashRef(cwd)
                if (stashAfter !== stashBefore) {
                    active.ui.notify(
                        `${id}: the git stash stack changed during "${next.title}" and was left that way — `
                            + 'inspect `git stash list`; an orphan stash later pops as an unresolvable conflict.',
                        'warning'
                    )
                }
            }
        }
    } catch (err) {
        // Safety net: no failure inside the loop may propagate out of runAutoLoop,
        // because the resume handler doesn't wrap this call and an unhandled
        // rejection crashes pi outright. Convert it into a failed run + notify,
        // mirroring the in-loop per-task failure path.
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) {
            announceDone(active, `${id} cancelled — resume with /task-auto-resume.`, 'warning')
            return
        }
        await updateTaskFrontMatter(cwd, id, {state: 'failed'}).catch(() => {})
        announceDone(active, `${id} stopped: ${msg} — fix and run /task-auto-resume.`, 'error')
    } finally {
        resetCancel()
    }
}

// ─── Command handlers ────────────────────────────────────────────────────────

async function handleTaskAuto(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    const raw = args.trim()
    if (raw.length === 0) {
        ctx.ui.setEditorText('/task-auto ')
        ctx.ui.notify('Describe the feature after /task-auto (use @ for file completion).', 'info')
        return
    }
    autoRunning = true
    // Take delivery of a typed /task-auto-cancel for the WHOLE run, planning
    // included — planning is children too, so the host is not streaming and the
    // ordinary command path cannot reach us.
    armTerminalCancel(ctx)
    try {
        // Stamp a fresh per-run research-cache id (F10) BEFORE planning so enrichment and
        // every task's research phase share one run's cache; disabled ⇒ clears any token a
        // prior run left, so nothing is cached.
        configureResearchRun(getConfig().researchCache)
        const abort = new AbortController()
        const deps = defaultDeps(ctx, cwd, abort.signal, deriveTitle(raw))
        let id: string | null
        try {
            id = await planAuto(ctx, cwd, raw, deps)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (msg === USER_CANCELLED) {
                announceDone(ctx, '/task-auto cancelled.', 'warning')
                return
            }
            announceDone(ctx, `/task-auto planning failed: ${msg}`, 'error')
            return
        }
        if (!id) return
        // Check for a cancel that was requested during the planning phase before the
        // loop resets the flag.
        if (isCancelRequested()) {
            resetCancel()
            announceDone(ctx, '/task-auto cancelled.', 'warning')
            return
        }
        await runAutoLoop(ctx, cwd, id, deps)
    } finally {
        autoRunning = false
        disarmCancelListener()
    }
}

async function handleTaskAutoResume(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    // `--unattended` is the boot-hook path: no human decided to continue this
    // run, so it resumes in-flight states only and refuses the rest by name.
    const unattended = /(^|\s)--unattended(\s|$)/.test(args)
    const candidate = await findResumableAutoDetailed(cwd)
    const decision = decideResume(candidate, Date.now(), unattended)
    ctx.ui.notify(decision.banner, decision.level)
    // An unattended refusal happens with nobody watching the terminal — the
    // remote view is the only surface that will still be there in the morning.
    if (unattended) publishLifecycleNotice(decision.banner, decision.level)
    if (!decision.resume || !candidate) return
    const id = candidate.id
    await updateTaskFrontMatter(cwd, id, {state: 'in_progress'})
    autoRunning = true
    armTerminalCancel(ctx)
    try {
        // Reuse the interrupted run's research-cache id, dropping only the entries whose
        // own package moved version (F10). mx5 run 13 resumed three times and each
        // resume's fresh id discarded a working 201-entry cache; run 14 then showed a
        // whole-file freshness gate can never hold on a greenfield run that installs
        // packages as it goes, so invalidation is per entry. See resumeResearchRun.
        const research = await resumeResearchRun(cwd, getConfig().researchCache)
        if (research.reused) {
            logPlanDebug(
                cwd,
                `research cache: resume reused ${research.entries} entr(ies), `
                    + `dropped ${research.dropped} stale`
            )
        }
        const abort = new AbortController()
        // Resume only runs the loop (runTask); no planning children, so the loader
        // title is unused here — pass the id for clarity if that ever changes.
        await runAutoLoop(ctx, cwd, id, defaultDeps(ctx, cwd, abort.signal, id))
    } finally {
        autoRunning = false
        disarmCancelListener()
    }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function handleTaskAutoCancel(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!autoRunning) {
        ctx.ui.notify('No /task-auto loop is running.', 'info')
        return
    }
    requestAutoCancel()
    ctx.ui.notify(CANCEL_ACK, 'warning')
}

/**
 * What the user is told the moment the request lands. Deliberately does NOT
 * promise "after the current task": the request is now honoured at the next safe
 * checkpoint (see cancel-points.ts), which mid-spec-pipeline is the end of the
 * current phase, not the end of the task.
 */
const CANCEL_ACK = 'Stopping /task-auto at the next safe checkpoint…'

/**
 * Deliver a /task-auto-cancel typed in the terminal while a run owns the main
 * loop. `armCancelListener` watches raw stdin, so it works during the spec
 * phases and the gates — the windows where pi would otherwise queue the line
 * until after the run (see cancel-input.ts). The remote path is unaffected:
 * dispatchRemoteLine invokes the handler directly.
 */
function armTerminalCancel(ctx: ExtensionCommandContext): void {
    armCancelListener(ctx, live => {
        requestAutoCancel()
        // `live` is the ctx the listener is currently installed on — the captured
        // one is stale the moment a task replaces the session.
        try {
            live.ui.notify(CANCEL_ACK, 'warning')
        } catch {
            /* the acknowledgement must never break the cancel itself */
        }
        publishLifecycleNotice(CANCEL_ACK, 'warning')
    })
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerTaskAuto(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-auto', {
        description: 'Plan a feature into tasks and run them. Usage: /task-auto <feature>',
        handler: handleTaskAuto
    })
    registerBridgeCommand(pi, 'task-auto-resume', {
        description:
            'Resume the active /task-auto run. Usage: /task-auto-resume [--unattended] '
            + '(--unattended is for boot hooks: in-flight runs only, never a failed one).',
        handler: handleTaskAutoResume
    })
    registerBridgeCommand(pi, 'task-auto-cancel', {
        description: 'Stop the running /task-auto loop after the current task.',
        handler: handleTaskAutoCancel
    })
}
