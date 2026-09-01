/**
 * /task-auto — plans a feature into a resumable list of task titles, then runs
 * each title through the existing single-task pipeline one at a time.
 *
 * The whole command lives here: the planning half (orient → elicit → decompose →
 * cover → planAuto), the run loop (runAutoLoop), the production dependency table
 * (defaultDeps), and the three command handlers registerTaskAuto wires up —
 * /task-auto, /task-auto-resume and /task-auto-cancel.
 */
import {existsSync} from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type {ExtensionAPI, ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {gateRunTask, markResumable} from './orchestrator.js'
import {RUN_END_POLICY, runSucceeded} from './run-end.js'
import {parseAutoAnswer, autoAnswerHasTag, deriveTitle} from './parsers.js'
import {renderInlineMarkdown, stripInlineMarkdown} from './inline-markdown.js'
import {
    AUTO_CLARIFY_PROMPT,
    AUTO_DECOMPOSE_PROMPT,
    DECOMPOSE_COVERAGE_PROMPT
} from './auto-prompts.js'
import {GRILL_AUTO_ANSWER_PROMPT, GRILL_AUTO_FORMAT_HINT} from './prompts.js'
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
import {decideResume, UNATTENDED_STATES} from './resume-gap.js'
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
import {BackendDownError, prependHint, USER_CANCELLED, type PhaseDeps} from './child-runner.js'
import {requestCancel, resetCancel, isCancelRequested, cancelCheckpoint} from './cancel-points.js'
import {withRun, announceTerminal} from './run-bracket.js'
import {refineExistingFilesBlock, SINGLE_READ_EXTENSION_PATH} from './phases.js'
import {SessionUI, registerBridgeCommand, publishLifecycleNotice} from '../remote/bridge.js'
import {getParentContextWindow} from './context-usage.js'
import {ChildStatus, runPlanningChild, statusCallbacks} from './child-status.js'
import {buildGateDeps, collectTreeChanges} from './gate-deps.js'
import {runGatesForTask, type GateDeps} from './task-gates.js'
import {runFinalGateStage, type FinalGateStageDeps} from './run-final-gate.js'
import {gitUnmergedPaths, gitStashRef} from './auto-commit.js'
import {runFinalIntegrationGate, deriveOpenDebts} from './final-gate.js'
import {spawnCommand} from './command-run.js'
import {getConfig} from '../config/config.js'
import {debugLogLevel, shouldLogDebug} from './debug-log.js'
import {isYoloMode, yoloPickAnswer} from './yolo.js'
import {QaTranscript, CLARIFY_QA_POLICY} from './qa-transcript.js'
import {makeQuestionSource} from './question-source.js'
import {CoverageLedger} from './plan-rounds.js'
import {CLARIFY_QUALITY_RULES, PLAN_FORMAT_HINT} from './plan-session.js'
import {configureResearchRun, resumeResearchRun} from '../workers/research-cache.js'
import {
    CONTRACT_EXTRACT_PROMPT,
    parseContractLines,
    keepGroundedContracts,
    appendContracts
} from './contracts.js'
import {reconcileTitleSources} from './decompose-fidelity.js'
import {
    granularityFloor,
    granularitySplitHint,
    isPlanShapeQuestion,
    isTooCoarse,
    planShapeIsHostsToAnswer,
    PLAN_SHAPE_ANSWER
} from './decompose-granularity.js'
import {mandatesTestsInSameChange, rewriteBatchTestPlan} from './batch-test-task.js'
import {
    REQUIREMENT_EXTRACT_PROMPT,
    COVERAGE_MAP_PROMPT,
    parseRequirementLines,
    keepGroundedRequirements,
    capRequirements,
    writeOwnedRequirements,
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
import {groundedCoverage, type ScoredPlan} from './coverage-loop.js'
import {settleQuestion} from './question-dialog.js'
import {TERMINAL_OUTCOMES, formatAt, formatWhy} from './terminal-outcome.js'
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
// barrage the user with redundant questions.
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
// same stochastic model as the decompose call it guards, and it will sometimes
// rubber-stamp a one-task plan for a whole design document — as the bare
// "COVERAGE: COMPLETE" line, byte-identical to a legitimate verdict, so the
// rubber-stamp is NOT detectable from the judge's output. The
// distrust signal must come from the input: a plan this small for a spec this
// large is near-certainly a degenerate generation rather than a real plan. The
// floor only ever forces a REGENERATION — it never rejects a plan on count alone,
// so a model that insists twice still ships its small plan, with a warning. Nine
// tests pin the behaviour, including that a still-suspect plan ships and that a
// shorter retry keeps the original list.
const SUSPECT_PLAN_MAX_TITLES = 2
const SUSPECT_PLAN_MIN_SPEC_CHARS = 4000

/**
 * Extra retries granted when the plan is EMPTY rather than merely small. One
 * hinted retry heals a small-but-nonempty plan; an empty generation is a harder
 * fault that can recur back-to-back, and falling through with zero titles aborts
 * the whole run rather than merely shipping a thin plan — so it is worth more
 * than one roll of the dice.
 */
const EMPTY_PLAN_RETRIES = 2

/**
 * An empty list is NEVER a valid decomposition of any feature request, at any spec
 * size. A predicate opening with `titles.length > 0` lets zero titles escape
 * entirely: not "suspect", so the suspect-retry never fires, the coverage loop
 * breaks immediately on `titles.length === 0`, and the run aborts with "no tasks
 * produced from the feature". A single degenerate
 * generation killed the whole run with no retry, which is the opposite of how the
 * same fault is treated one title higher.
 */
function isSuspectPlan(titles: string[], featureForModel: string): boolean {
    if (titles.length === 0) return true
    return (
        titles.length <= SUSPECT_PLAN_MAX_TITLES
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
 * `runChild` is the planning-only seam used by planAuto; everything else is one of
 * two shared gate surfaces — the per-task one ({@link GateDeps}, driven by
 * runGatesForTask) and the run-end one ({@link FinalGateStageDeps}, driven by
 * runFinalGateStage) — both built by {@link buildGateDeps} / defaultDeps. Only the
 * loop's own repo-integrity probes are declared here.
 */
export interface AutoDeps extends GateDeps, FinalGateStageDeps {
    runChild: (name: string, tools: string, prompt: string) => Promise<string>
    /**
     * Paths with unmerged index entries (an in-progress merge conflict). The loop
     * refuses to START a task on a conflicted tree: a full implementation turn
     * and its verifies run against one with every commit doomed from the outset.
     * Absent (tests) → treated as clean.
     */
    unmergedPaths?: (cwd: string) => Promise<string[]>
    /**
     * Sha of refs/stash or null. Compared around each task so a stash pushed (or
     * consumed) during the task and left behind is called out — an orphan stash is
     * exactly the landmine that detonates as an unresolvable conflict later.
     * Absent (tests) → the check is skipped.
     */
    stashRef?: (cwd: string) => Promise<string | null>
}

// Matches pi's @-file completion token (a path after @, until whitespace).
const MENTION_RE = /(?:^|\s)@([^\s]+)/g

// Trailing punctuation a user naturally types AFTER an @-mention when it sits in
// prose — "Implement @design.md, reuse…" or "see @spec.md." — which the greedy
// [^\s]+ above would otherwise swallow into the path. Left unstripped, the
// resulting "design.md," resolves to no file, expansion is silently skipped, and
// the planner reasons over a one-line "Implement @design.md" with NO spec inline
// → it fabricates generic questions and tasks the spec never called for.
//
// Measured against a real file: the greedy token from "Implement @design.md,
// reuse the parser" is `design.md,`, which does not exist; stripped, `design.md`
// does. None of these chars are legitimate trailing characters of a doc path.
const MENTION_TRAILING_PUNCT = /[.,;:!?)\]}>"']+$/

/** The cleaned path token of an @-mention: greedy match minus trailing prose punctuation. */
function mentionPath(token: string): string {
    return token.replace(MENTION_TRAILING_PUNCT, '')
}

/**
 * Every plan-debug write not yet on disk, chained.
 *
 * Fire-and-forget is right for production — a plan must never wait on its own
 * trail — but it leaves nothing to synchronise on, so a test that reads
 * `plan-debug.log` back races the append that writes it and fails on ENOENT.
 * Chaining gives {@link flushPlanDebug} something to await, and it also
 * serialises concurrent appends, which is what keeps a line whole.
 */
let planDebugChain: Promise<unknown> = Promise.resolve()

/** Wait for every plan-debug line written so far to reach disk. Tests only. */
export function flushPlanDebug(): Promise<unknown> {
    return planDebugChain
}

/**
 * Fire-and-forget debug line for the PLAN phase (clarify/decompose). It is the
 * only trail that phase has: planning runs before any task file exists, so there
 * is no per-task `TASK_NNNN-debug.log` to write into yet. This goes to
 * `.pi-tasks/plan-debug.log`, whose `*-debug.log` suffix matches the pattern
 * debug-log.ts documents, so one grep still finds every log. Never throws — the
 * mkdir and the append are both best-effort.
 *
 * Every call site records a plan DECISION (how many titles a round produced,
 * whether a retry was adopted, which clarify answer was auto-resolved), so all of
 * them are `'event'` and survive at the default level. No model chatter reaches
 * this file.
 */
function logPlanDebug(cwd: string, msg: string): void {
    if (!shouldLogDebug('event', debugLogLevel())) return
    const line = `${new Date().toISOString()} ${msg}\n`
    const dir = tasksDir(cwd)
    planDebugChain = planDebugChain
        .then(() => fsp.mkdir(dir, {recursive: true}))
        .then(() => fsp.appendFile(path.join(dir, 'plan-debug.log'), line))
        .catch(() => {})
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
        // most of the time, minting a destructive decompose decision that can
        // outrank refine's preserve directive.
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
 * decomposed task title. A title is ALL a per-task pipeline ever sees, so both the
 * design doc the feature pointed at and the user's clarification choices have to
 * ride along or they are invisible downstream — a task that cannot see the doc
 * invents its own schema, and one that cannot see "do not use vite" is overridden
 * by whatever the doc's own config says.
 *
 * Precedence is the crux: a clarification is a CORRECTION to a possibly stale spec
 * doc, so the decisions clause is marked as overriding the doc while the doc stays
 * authoritative for everything the decisions do not touch. The emitted order puts
 * decisions first, then the spec ref. Decompose scopes each decision to the tasks
 * it governs, so most titles carry none.
 *
 * Run: with no refs and no decisions the title comes back unchanged, and
 * re-threading an already-threaded list is a no-op.
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
 * spec" — re-expands the whole referenced design into a single task, implementing
 * the entire plan under step one. The fence lists the sibling steps by number and
 * forbids touching anything they own, so refine bounds this step's slice.
 *
 * The plan listing strips the threaded "| decisions … | spec …" tail from each
 * title and keeps the human-readable head, so the model reads clean step names,
 * and it marks the current one "(THIS STEP)" — both confirmed by building a fence
 * over threaded titles. The authoritative spec ref still rides on THIS step's own
 * title via attachSpecRefs.
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
 * test infrastructure". The extra fence pins the one editable file, and pins VERIFY
 * to the failing command WHEN the title carries one: `extractFailingCommand` reads
 * a backticked runner command out of the defect text, so a defect quoting
 * `bun run test` yields it while a plain-prose defect yields undefined and only the
 * file pin applies.
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
 * Three bounds, all mandatory:
 *   - DEDUP by file — two debts naming the same file must yield ONE repair
 *     step, not two. mergeRepairCandidates collapses the drained queue, and
 *     planHasRepairFor rejects a file the plan already carries a repair for.
 *   - CAP 1 per file per RUN — planHasRepairFor counts CHECKED-OFF entries too, so
 *     a repair step that itself failed is never re-spawned; it lands in the
 *     accept-debt ledger like any other task. That is what stops a repair loop.
 *     Both bounds run as described: three candidates over two files merge to two,
 *     and a plan carrying an already-`[x]` repair for a file still answers true.
 *   - MONOTONIC — insertTaskAfter only splices; no existing entry is rewritten,
 *     reordered or dropped.
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

/**
 * What ORIENT establishes about the feature before anyone is asked anything: the
 * spec text the planning children will actually read, and the requirement ledger
 * derived from it. Every later stage reads these; none of them writes one.
 */
export interface OrientedFeature {
    /** The inlined spec, with phantom runtime specifiers struck out. */
    featureForModel: string
    /** Manifest/config already on disk, fed to every triage call. '' when absent. */
    existingFilesBlock: string
    /** Grounded requirement units extracted from the spec. */
    reqEntries: RequirementEntry[]
    /** How many of those a single task could own (cross-cutting ones excluded). */
    ownableRequirements: number
    /** The task-count floor those ownable requirements imply. 0 ⇒ no channel. */
    coarseFloor: number
}

/**
 * ORIENT — read the feature, strike what must never reach a planning child, and
 * derive the requirement ledger. Depends on nothing but the feature and the tree,
 * which is why it runs before clarify: the plan-shape fork below needs a real
 * count to judge with. Every fallible part is best-effort; a fault degrades the
 * channel it belongs to and never fails planning.
 */
export async function orientFeature(
    cwd: string,
    feature: string,
    deps: AutoDeps
): Promise<OrientedFeature> {
    // Inline any @file spec the user referenced so clarify/decompose reason over
    // the real content, not a one-line "Implement @file" that reads as trivial.
    const rawFeatureForModel = await expandFeatureMentions(cwd, feature)
    // Strike phantom runtime specifiers (`bun:sql`) out of the inlined spec BEFORE
    // clarify/decompose ever see it. Layer A only rewrites the per-task `refined`
    // text — which is DOWNSTREAM of here: clarify is the first phase and runs on
    // this raw inline, so the doc's affirmative `bun:sql` is parroted straight into
    // the very first clarifying question. Apply the
    // same deterministic, no-LLM strike at the single point that feeds both planning
    // children. Silent + no-op when nothing is flagged or the runtime's types aren't
    // installed.
    const planPhantoms = await findPhantomImports(rawFeatureForModel, cwd)
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
    // Requirement extraction: grounded requirement units,
    // extracted from whatever structure the spec has, BEFORE decompose — they ride
    // into the decompose prompt as a ledger (structure-mirroring can't discharge
    // them) and drive the per-requirement coverage accounting below.
    //
    // Best-effort: a fault leaves reqEntries empty and the whole channel degrades to
    // the old behavior (one-liners / doc-less features naturally yield few or none).
    let reqEntries: RequirementEntry[] = []
    try {
        // Recall floor: the obligation-marked passages ride into the prompt as a
        // checklist, and a marked passage that produced NO quote is hard evidence
        // for one forced re-extraction: without it an extraction can miss an
        // entire marked section.
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
        // Bound with marked-passage priority. A plain first-N cap truncates the
        // doc's tail sections, because an eager extraction fills the budget from the
        // top down and never reaches them.
        reqEntries = capRequirements(reqEntries, passages, featureForModel)
        logPlanDebug(
            cwd,
            `requirement extraction: ${reqEntries.length} grounded requirement(s) kept`
        )
    } catch (e) {
        // Best-effort covers a child that answered badly. It must NOT cover a user
        // ESC or a dead backend: planning would continue on an EMPTY ledger, moving
        // the granularity floor and shipping a degraded plan instead of a cancel or
        // a failure. Same rule as verify-resolution.ts.
        if (e instanceof BackendDownError) throw e
        if (e instanceof Error && e.message === USER_CANCELLED) throw e
        // Best-effort, but not silent: nothing else records a guard kill here.
        logPlanDebug(cwd, `requirement extraction: skipped — ${(e as Error).message}`)
    }

    // Granularity floor: without it the plan's task COUNT is set by an
    // auto-resolved clarify line the user never sees, so the same spec and the same
    // code can plan coarse one run and fine the next. Derive the floor from the
    // requirements a task can own instead, so an unreviewable "one task per
    // milestone" decision cannot collapse the plan; it also gates whether the
    // plan-shape fork below is the host's to answer at all. Measured:
    // granularityFloor is 0 for three or fewer ownable requirements — no channel —
    // and roughly half the count above that.
    const ownableRequirements = reqEntries.filter(e => !isCrossCuttingRequirement(e.quote)).length
    const coarseFloor = granularityFloor(ownableRequirements)
    if (coarseFloor > 0) {
        logPlanDebug(
            cwd,
            `granularity floor: ${ownableRequirements} ownable requirement(s) ⇒ at least `
                + `${coarseFloor} task(s)`
        )
    }
    return {featureForModel, existingFilesBlock, reqEntries, ownableRequirements, coarseFloor}
}

/**
 * ELICIT — clarify, sequential & adaptive: ask one question at a time, feeding every
 * answer back into the next call so later questions react to earlier ones (e.g. a
 * framework choice reshapes what gets asked). Each question is shown exactly like
 * /task's grill dialog: a binary fork offers two options (A/B), otherwise the model's
 * recommendation is shown as the input placeholder and in the title. Nothing is
 * pre-filled into the editor — submitting an empty field is what accepts the
 * recommendation; typing overrides it. Each generated question first runs the
 * answer-side TRIAGE (triageClarifyQuestion): a question the inlined spec already
 * settles is auto-resolved and never shown — only genuine open forks reach the user.
 * The model emits NONE when nothing remains.
 *
 * The ONLY stage that ASKS the user anything, and so the only one that can be
 * dismissed — the others only notify, which cannot be. `null` means the user
 * cancelled and the cancellation has already been announced.
 * Every other outcome is a transcript, possibly empty.
 */
export async function elicitClarifications(
    ctx: ExtensionCommandContext,
    cwd: string,
    deps: AutoDeps,
    oriented: OrientedFeature
): Promise<string | null> {
    const {featureForModel, existingFilesBlock, ownableRequirements} = oriented
    const theme = ctx.ui.theme
    const ui = new SessionUI(ctx)
    // ONE record, one numbering, one provenance table (task/qa-transcript.ts).
    // Clarify's generator DOES see provenance — a question the triage already
    // settled must read as settled so it is not re-asked — which is the one thing
    // it and grill genuinely disagree about, and is now a named policy field.
    const transcript = new QaTranscript(CLARIFY_QA_POLICY)
    // Deterministic guard against a model that ignores "never re-ask": consecutive
    // near-duplicate questions are reprompted with an explicit hint, and once it
    // strikes out (can't produce anything novel) we stop instead of barraging the
    // user with the same decision worded N ways. Also caps the absolute count.
    // The generate → parse → pick → dedupe → re-prompt state machine is
    // task/question-source.ts, shared with the plan session. A second copy here
    // would drift from the sibling, and the shared source buys two things: it
    // PICKS a question rather than taking the first parsed line, so an analysis
    // note is never shown as the question and its SUGGESTED is not lost; and an
    // unparseable reply costs one format re-prompt instead of ending clarify
    // outright and decomposing the feature with ZERO clarifications.
    //
    // Of plan's three quality rules only the DEFERRAL guard crosses. Checked:
    // PLAN_QUALITY_RULES holds three ('no SUGGESTED', 'SUGGESTED deferred the
    // decision', 'fork-shaped question with no ALT') and CLARIFY_QUALITY_RULES
    // holds exactly the middle one. The other two cost an extra child call every
    // time they fire, so moving them is its own change to make and measure.
    const source = makeQuestionSource({
        generate: hint =>
            deps.runChild(
                'auto-clarify',
                'read',
                prependHint(hint, AUTO_CLARIFY_PROMPT(featureForModel, transcript.forGenerator()))
            ),
        formatHint: PLAN_FORMAT_HINT,
        rules: CLARIFY_QUALITY_RULES,
        cap: MAX_CLARIFY_QUESTIONS,
        log: msg => logPlanDebug(cwd, `clarify: ${msg}`)
    })
    for (;;) {
        const drawn = await source.next()
        if (drawn.kind === 'exhausted') break
        const {question, suggested, alt} = drawn.q
        // Render markdown (bold/code) for the displayed prompt; keep plain text
        // for the editable default and the persisted file.
        const shownQ = renderInlineMarkdown(question, theme)
        const plainQ = drawn.plain
        // PLAN SHAPE is the host's call, not the triage's — the same spec off the
        // same base commit can plan far coarser or finer depending on this one
        // answer (see decompose-granularity.ts).
        // The triage answers this fork for itself every time and stamps it
        // "already settled by the spec" while the spec settles no such thing, so the
        // single most load-bearing decision in a run was an invisible coin flip.
        // Answer it deterministically instead: same channel, same transcript, but a
        // fixed value the user can read in the AUTO file and override next run.
        if (planShapeIsHostsToAnswer(ownableRequirements) && isPlanShapeQuestion(plainQ)) {
            logPlanDebug(
                cwd,
                `plan-shape question answered host-side (not the triage): ${plainQ.replace(/\s+/g, ' ').slice(0, 120)}`
            )
            transcript.add('host-set', plainQ, PLAN_SHAPE_ANSWER)
            continue
        }
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
            transcript.add('auto-resolved', plainQ, autoResolved)
            continue
        }
        // YOLO: take the recommended option (index 0 / the green card) without ever
        // building the prompt. Clarify has no anti-synthesis channel — it runs before
        // any research — so the only step-aside here is a question that carries no
        // recommendation to take; that one is skipped rather than guessed.
        const outcome = await settleQuestion({
            ui,
            transcript,
            plain: plainQ,
            shown: shownQ,
            ...(suggested !== undefined && {suggested}),
            ...(alt !== undefined && {alt}),
            render: md => renderInlineMarkdown(md, theme),
            yolo: yoloPickAnswer(isYoloMode(), {
                ...(suggested !== undefined && {suggested: stripInlineMarkdown(suggested)}),
                ...(alt !== undefined && {alt: stripInlineMarkdown(alt)})
            })
        })
        if (outcome === 'cancelled') {
            announceDone(ctx, '/task-auto cancelled.', 'warning')
            return null
        }
    }
    if (transcript.length === 0) {
        ctx.ui.notify('No clarifying questions needed — planning tasks…', 'info')
    }
    return transcript.forRecord()
}

/**
 * What DECOMPOSE settles: the task list, plus the two things the coverage loop
 * needs to ask for a better one. `decomposePrompt` and `parsePlan` are returned
 * rather than rebuilt because COVER re-prompts with the identical prompt and must
 * reconcile the reply identically — rebuilding either is how the two paths drift.
 */
export interface DecomposedPlan {
    /** The reconciled, de-batched task titles. May be empty. */
    planTitles: string[]
    /** The exact prompt that produced them, for COVER's re-prompt. */
    decomposePrompt: string
    /** Parse + fidelity-reconcile + de-batch, applied to EVERY decompose output. */
    parsePlan: (raw: string) => string[]
}

/**
 * DECOMPOSE — turn the settled feature into a task list, then defend that list's
 * SHAPE: a plan under the granularity floor is sent back once to be split, and a
 * suspect (empty or tiny) plan is regenerated on its own separate budget. Neither
 * guard can block planning — a plan that survives both falls through to the judge.
 */
export async function decomposePlan(
    cwd: string,
    deps: AutoDeps,
    oriented: OrientedFeature,
    clarifications: string
): Promise<DecomposedPlan> {
    const {featureForModel, reqEntries, ownableRequirements, coarseFloor} = oriented
    // Tests-in-the-same-change cadence: when the
    // decisions mandate it, a whole-project batch test task contradicts them, and
    // one still ships because
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
    // Parse + FIDELITY RECONCILIATION: ground each title's
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
        // planned coverage cannot fall.
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
    // BRACES for the floor: the prompt clause alone is a preference the model can
    // ignore, so a plan under the floor is sent back ONCE to be split (never
    // regenerated — a fresh roll can drop a covered area). Longer plan
    // wins; a still-coarse plan falls through to the coverage judge as before, so
    // this can never block planning.
    if (isTooCoarse(planTitles.length, coarseFloor)) {
        logPlanDebug(
            cwd,
            `plan under the granularity floor (${planTitles.length} < ${coarseFloor}) — `
                + 'reprompting once to split'
        )
        const splitRaw = await deps.runChild(
            'auto-decompose',
            'read',
            prependHint(
                granularitySplitHint(planTitles.length, ownableRequirements),
                decomposePrompt
            )
        )
        const splitTitles = parsePlan(splitRaw)
        logPlanDebug(cwd, `granularity split-retry produced ${splitTitles.length} title(s)`)
        if (splitTitles.length > planTitles.length) planTitles = splitTitles
    }
    // Distrust floor (see isSuspectPlan): a ≤2-title plan for a multi-KB spec is
    // regenerated once BEFORE the judge runs — the judge cannot be trusted to
    // catch it, and a hinted retry heals it reliably.
    // Longer list wins; a still-suspect plan falls through to the
    // judge loop as before, so this never blocks planning.
    // An EMPTY plan gets extra attempts (see EMPTY_PLAN_RETRIES): falling through
    // with zero titles aborts the whole run, so one roll of the dice is not enough.
    // A merely-small plan keeps its single retry — it still ships if the retry does
    // not help, so spending more children on it buys nothing.
    //
    // The two budgets are tracked SEPARATELY on purpose. A single counter bounded by
    // `plan.length === 0 ? EMPTY_PLAN_RETRIES : 0` re-reads the bound against the
    // CURRENT plan, so an empty draw that healed to a still-suspect 1-title plan saw
    // the bound collapse to 0 and skipped the small-plan retry that an identical
    // 1-title FIRST draw would have received. Same end state, different treatment,
    // purely because of how it got there.
    let emptyAttempts = 0
    let smallRetryUsed = false
    while (isSuspectPlan(planTitles, featureForModel)) {
        if (planTitles.length === 0) {
            if (emptyAttempts > EMPTY_PLAN_RETRIES) break
            emptyAttempts++
        } else {
            if (smallRetryUsed) break
            smallRetryUsed = true
        }
        logPlanDebug(
            cwd,
            `decompose suspect (${planTitles.length} title(s) for a ${featureForModel.length}-char spec)`
                + `${emptyAttempts > 1 ? ` — empty retry ${emptyAttempts}` : ''}`
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
    return {planTitles, decomposePrompt, parsePlan}
}

/** What COVER settles: the plan that ships, and the accounting behind it. */
export interface CoveredPlan {
    /** The best-covered plan seen across the rounds — adoption is monotone. */
    best: ScoredPlan
    /** That plan's titles, which is what everything downstream persists. */
    planTitles: string[]
}

/**
 * COVER — judge the plan against the feature and re-prompt for a better one, up to
 * a bounded number of rounds. Adoption is MONOTONE: a retry that drops a
 * requirement the current plan owns is rejected, so coverage can only hold or grow,
 * and the plan at exhaustion is the best one seen rather than the last one drawn.
 * Best-effort throughout — a fault degrades a signal, it never blocks planning.
 */
export async function coverPlan(
    ctx: ExtensionCommandContext,
    cwd: string,
    deps: AutoDeps,
    oriented: OrientedFeature,
    clarifications: string,
    decomposed: DecomposedPlan,
    specDangling: DanglingRef[]
): Promise<CoveredPlan> {
    const {featureForModel, reqEntries} = oriented
    const {decomposePrompt, parsePlan} = decomposed
    let planTitles = decomposed.planTitles
    // Coverage gate: a degenerate completion — ONE task and a natural EOS for a
    // whole design document — is nonempty, so the length guard below
    // never fires and the whole run "completes" after one task. Judge the list
    // against the feature with a no-tools child; on INCOMPLETE, re-run decompose
    // with the missing areas as a hint. Best-effort so a triage fault never blocks
    // planning (mirrors triageClarifyQuestion).
    //
    // Two invariants. Without them a complete full-stack plan is overwritten by a
    // narrower regeneration, driven by a handful of NEGATIVE requirements that no
    // task can own and that therefore keep the verdict INCOMPLETE forever:
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
    const scorePlan = async (titles: string[]): Promise<ScoredPlan> => {
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
        // went blind. Grounding the drop-signal in the titles the model cannot
        // fake restores it. The model map still drives Fix A's
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
    //
    // It is also the ONLY handle on the accounting. A second one carried
    // alongside is how a requirement gets attached to the wrong task — see the
    // ScoredPlan doc comment.
    // The record, and the decisions it makes: task/plan-rounds.ts. This was five
    // locals threaded by closure through a ~90-line loop, plus a
    // snapshot-before-overwrite pair that existed only because the bonus-round
    // decision was made downstream from the evidence it needed.
    const rounds = new CoverageLedger(await scorePlan(planTitles), {
        cap: MAX_COVERAGE_ROUNDS,
        hasRequirements
    })
    for (;;) {
        const best = rounds.best()
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
        if (!rounds.mayRetry()) break
        const round = rounds.startRound()
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
        // Compare, replace the plan WHOLE, and decide the bonus round — one call,
        // so there is no window in which a snapshot and a replacement disagree.
        const outcome = rounds.consider(await scorePlan(retryTitles))
        if (outcome.adopted) {
            logPlanDebug(cwd, `decompose retry ADOPTED — ${outcome.decision.reason}`)
            if (outcome.grantedBonusRound) {
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
                `decompose retry REJECTED — ${outcome.decision.reason}`
                    + (outcome.decision.dropped.length > 0 ?
                        ` [would drop: ${outcome.decision.dropped
                            .map(i => `"${reqEntries[i].quote}"`)
                            .join('; ')
                            .slice(0, 200)}]`
                    :   '')
            )
        }
    }
    const best = rounds.best()
    const round = rounds.round()
    planTitles = best.plan.titles
    // Exhausted still INCOMPLETE: the best plan ships (the gate is best-effort), but
    // silently shipping a KNOWN-gapped plan is how a run loses a whole area of
    // work — tell the user what is still uncovered.
    const unresolvedMissing = rounds.unresolved()
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
    return {best, planTitles}
}

/** Plan phase: clarify → decompose → write AUTO file. Returns the new id, or null. */
export async function planAuto(
    ctx: ExtensionCommandContext,
    cwd: string,
    feature: string,
    deps: AutoDeps
): Promise<string | null> {
    // ORIENT. Reads the feature and the tree, asks nobody anything.
    const oriented = await orientFeature(cwd, feature, deps)
    // The floor and the ownable count are DECOMPOSE's to enforce; what the tail of
    // this function still reads is the spec text and the requirement ledger.
    const {featureForModel, reqEntries} = oriented

    // ELICIT. The only stage that talks to the user.
    const clarifications = await elicitClarifications(ctx, cwd, deps, oriented)
    if (clarifications === null) return null // dismissed; already announced

    // Artifact-production closure, plan side: runtime
    // files the spec REFERENCES (server snippets, prose "serve the built
    // index.html") that neither its file tree, its parsed build outputs, nor the
    // existing scaffold produce. Sentence-grounded coverage credited the SERVING
    // side and reported "0 unowned" while nothing ever CREATED the file — so
    // these ride the coverage loop's `missing` list as unowned areas until some
    // task title claims the artifact (grounded in titles, which the coverage-map
    // model cannot fake — the lesson). Deterministic and best-effort.
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

    // DECOMPOSE. Produces the task list and the means to ask for a better one.
    const decomposedPlan = await decomposePlan(cwd, deps, oriented, clarifications)
    // COVER. Judges the plan and re-prompts for a better one, monotonically.
    const covered = await coverPlan(
        ctx,
        cwd,
        deps,
        oriented,
        clarifications,
        decomposedPlan,
        specDangling
    )
    const best = covered.best
    const planTitles = covered.planTitles
    // Carry what no single task owns (goal A(b)/(c)): cross-cutting requirements
    // become `.pi-tasks/requirements.md`, injected VERBATIM into every task's
    // refine/compose. A rule stated only in the spec body has no carrier, and a
    // "spec is authoritative" pointer recovers it in a minority of tasks: content
    // travels, pointers do not. Requirements still unmapped after the rounds are carried
    // too — marked — and recorded user-visibly in the plan file, never dropped.
    //
    // #1: the holistic-judge missing areas are carried as a THIRD channel. They are
    // areas requirement-extraction never captured as a tracked entry (so the
    // grounded accounting is structurally blind to them), seen only by the judge —
    // exactly the class that, having no carrier, is warned about and then
    // dropped. Carried independent of `accounting` so a mapping
    // fault (accounting === null) can't strand them either.
    const carriedCrossCutting = best.accounting?.crossCutting ?? []
    const carriedUnmapped = best.accounting?.unmapped ?? []
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
    // Thread the feature's spec doc(s) into every title so each per-task
    // pipeline — which only ever sees its title — reads the real spec instead of
    // a lossy one-line paraphrase of it.
    const refs = await readableMentions(cwd, feature)
    const titles = attachSpecRefs(planTitles, refs)
    if (titles.length === 0) {
        announceDone(ctx, '/task-auto: no tasks produced from the feature.', 'warning')
        return null
    }

    // The two grounded extractions below run AFTER the empty-plan guard on purpose.
    // They each spawn a child and each APPEND to a run-level artifact; on the
    // empty-plan path the plan is discarded one line later, so running them first
    // burned two model calls and left contracts.md / launch-contract.md carrying
    // facts for a run that never produced a task.

    // Cross-slice contract registry: now that the plan is settled,
    // extract the interface facts MORE THAN ONE slice must agree on — endpoint paths,
    // exported signatures, file layouts, env var names the DESIGN pins — into a
    // run-level artifact each downstream refine/compose/verify reads. The extraction
    // child EMITs `CONTRACT:` lines, but every quote is re-grounded HOST-SIDE against
    // the design (keepGroundedContracts): a fact the child paraphrased or invented is
    // not a substring of the doc and is dropped, so a fabricated contract — exactly
    // the F3 bug — can never enter the registry. Best-effort: any fault here is
    // swallowed (the registry is a sharpener, never a planning blocker).
    await runGroundedExtraction({
        cwd,
        runChild: deps.runChild,
        child: 'contract-extract',
        noun: 'contract',
        label: 'contract extraction',
        prompt: CONTRACT_EXTRACT_PROMPT(featureForModel, planTitles),
        parse: parseContractLines,
        ground: emitted => keepGroundedContracts(emitted, featureForModel),
        append: appendContracts
    })

    // Launch contract: extract the package/build SCRIPTS the design
    // declares the project must expose (`migrate`/`seed` fell through decompose and
    // shipped missing, unchecked). Each emitted name is re-grounded against the design
    // (keepGroundedScripts — kept only if the design backticks it), so the final gate's
    // manifest diff can never false-flag a hallucinated script. Recall is mechanical
    //: enumerateScriptCandidates hands the child every backticked
    // script-shaped token near the word "script" as a checklist, so a script declared
    // far from the design's summary list (`test:ct` in §2 vs §9's five) can't be
    // missed by a weak model's recall — the child classifies, it no longer recalls.
    // Best-effort.
    await runGroundedExtraction({
        cwd,
        runChild: deps.runChild,
        child: 'launch-extract',
        noun: 'script',
        label: 'launch-contract extraction',
        prompt: LAUNCH_EXTRACT_PROMPT(featureForModel, enumerateScriptCandidates(featureForModel)),
        parse: parseScriptLines,
        ground: emitted => keepGroundedScripts(emitted, featureForModel),
        append: appendDeclaredScripts
    })

    // Persist the TASK-MAPPED requirements keyed by the (spec-ref-attached) title
    // each task will carry. With only cross-cutting entries travelling, the
    // mapped ones shape the title list and then vanish, and a task can narrow a
    // requirement out of its own spec with nothing to stop it.
    // Inert until the owned-requirements injection is wired into the phase
    // prompts; recorded regardless so the plan's mapping is auditable per run.
    if (best.accounting && best.accounting.mapped.length > 0) {
        await writeOwnedRequirements(
            cwd,
            best.accounting.mapped
                .filter(m => m.task >= 1 && m.task <= titles.length)
                .map(m => ({quote: m.req.quote, anchor: m.req.anchor, title: titles[m.task - 1]}))
        )
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
    const shipped = best.accounting
    const coverageNote =
        shipped === null ? '' : (
            [
                `${reqEntries.length} grounded requirement(s): ${shipped.mapped.length} task-mapped, `
                    + `${shipped.crossCutting.length} cross-cutting (carried into every task via `
                    + `.pi-tasks/requirements.md), ${shipped.unmapped.length} unowned`,
                ...shipped.crossCutting.map(e => `- carried: "${e.quote}"`),
                ...shipped.unmapped.map(e => `- UNOWNED (no task covers this): "${e.quote}"`)
            ].join('\n')
        )
    await writeTaskFile(cwd, fm, buildAutoBody(feature, clarifications, titles, coverageNote))
    return id
}

/**
 * One best-effort, HOST-GROUNDED extraction: ask a child to emit lines, drop
 * every line the design does not literally contain, log the kept/emitted split,
 * and append what survives to a run-level artifact.
 *
 * The grounding step is the reason this shape exists rather than a plain child
 * call. A child asked for interface facts will paraphrase and occasionally invent
 * them, and an invented fact in a run-level registry is read as
 * authoritative by every downstream refine/compose/verify. So nothing the child
 * says is trusted: `ground` re-checks each emitted line against the design text
 * host-side, and only substrings survive.
 *
 * Best-effort by contract. These artifacts SHARPEN planning; none of them gates
 * it, so a fault here is swallowed rather than failing a run that is otherwise
 * fine — which is why the whole body sits in one `catch {}`.
 *
 * The two call sites (contracts, launch scripts) were byte-identical apart from
 * the four values this row carries, and the contracts copy parsed its child's
 * output twice — once for the artifact and once for the log count — because the
 * duplication made the second parse easy to miss.
 */
async function runGroundedExtraction<T>(row: {
    cwd: string
    runChild: (name: string, tools: string, prompt: string) => Promise<string>
    /** Child name — also the key AUTO_PLAN_STEPS renders in the loader. */
    child: string
    /** Singular noun for the log line ("contract", "script"). */
    noun: string
    /** Log prefix naming the step. */
    label: string
    prompt: string
    parse: (raw: string) => T[]
    /** Keep only what the design itself backs. Runs host-side, never the child. */
    ground: (emitted: T[]) => T[]
    append: (cwd: string, kept: T[]) => Promise<void>
}): Promise<void> {
    try {
        const emitted = row.parse(await row.runChild(row.child, '', row.prompt))
        const grounded = row.ground(emitted)
        logPlanDebug(
            row.cwd,
            `${row.label}: ${grounded.length} grounded ${row.noun}(s) kept`
                + ` from ${emitted.length} emitted`
        )
        await row.append(row.cwd, grounded)
    } catch {
        // best-effort artifact — never a planning blocker
    }
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
    // The planning loader mirrors the child's latest output line and context
    // usage, exactly like the single-task phase widget. (The gate children have
    // their own ChildStatus inside buildGateDeps.)
    const parentContextWindow = getParentContextWindow(ctx)
    const status = new ChildStatus({parentContextWindow})

    const phaseDeps: PhaseDeps = {
        cwd,
        // No task file, so appendLoopEvent swallows its ENOENT. Its docblock
        // allows that because "the kill is already reported through the debug
        // log" — which is why logDebug below is not optional here.
        taskId: '',
        signal,
        logDebug: msg => logPlanDebug(cwd, msg),
        // IN-RUN thrash guard for the planning children: without it a decompose
        // child can re-read its design document until it fills the whole context
        // window, and never return. Every planning child
        // gets its source doc INLINED in its prompt, so a second read of a file
        // it has already opened can only be thrash — which makes the read-once
        // block safe here in a way it is not for a phase that must explore.
        childExtensions: [SINGLE_READ_EXTENSION_PATH],
        ...statusCallbacks(status)
    }
    return {
        // Planning-only seam. The shared gate surface (runTask/commit/verify/
        // enforce/recommend/revert) comes from buildGateDeps below — identical to
        // what /task builds, so both commands gate the same way.
        //
        // Planning children are slow LLM calls with no UI of their own; the
        // shared loader shows the same status block as /task so this never goes
        // silent until the drill dialog.
        runChild: (name, tools, prompt) =>
            runPlanningChild({
                ctx,
                status,
                phaseDeps,
                name,
                tools,
                prompt,
                loader: {
                    title,
                    step: n => ({
                        ...(AUTO_PLAN_STEPS[n] ?? {step: n, stepNum: 1}),
                        stepTotal: AUTO_PLAN_STEP_TOTAL
                    })
                }
            }),
        ...buildGateDeps({signal, parentContextWindow, runTask: gateRunTask}),
        // Loop-level repo integrity + run-end gate glue (see AutoDeps docs).
        unmergedPaths: cwd2 => gitUnmergedPaths(cwd2, signal),
        stashRef: cwd2 => gitStashRef(cwd2, signal),
        // The final integration gate follows the `verify work` switch: it is the
        // run-level half of the same verification story.
        finalGate: (cwd2, planText) =>
            getConfig().verifyWork ?
                runFinalIntegrationGate(cwd2, {planText, signal})
            :   Promise.resolve({ok: true, reason: 'disabled'}),
        // Uncommitted paths, for the stranded-sub-fix handling around the final-gate
        // picker. Every task is committed by the time
        // the gate runs, so whatever is dirty here belongs to the fix pass.
        pendingChanges: async cwd2 => {
            const changes = await collectTreeChanges(cwd2, signal)
            return [...changes.modified, ...changes.added, ...changes.deleted].sort()
        },
        // Re-derive the debt ledger against the FINAL tree after a converged
        // autofix. Only ever reached from inside the gate's own
        // resolution loop, so it needs no `verify work` switch of its own.
        // Same section, same cancel: this re-runs every ACCEPT-debt VERIFY command
        // against the final tree, each under its own 300s cap.
        recheckOpenDebts: (cwd2, staticOk) => deriveOpenDebts(cwd2, staticOk, spawnCommand, signal)
    }
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let autoRunning = false

export function requestAutoCancel(): void {
    requestCancel()
}

/**
 * Report a stash pushed during one task and left behind.
 *
 * An orphan stash later pops as an unresolvable conflict, so the capture before
 * the task and this check after it are ONE fact — which is why the call sits in a
 * `finally` rather than on the fall-through, where it would only run when the task
 * succeeded. Best-effort: never throws, so it cannot mask the outcome of the
 * attempt it closes.
 */
async function reportStashDrift(
    active: ExtensionCommandContext,
    deps: Pick<AutoDeps, 'stashRef'>,
    cwd: string,
    id: string,
    title: string,
    before: string | null | undefined
): Promise<void> {
    if (!deps.stashRef || before === undefined) return
    try {
        const after = await deps.stashRef(cwd)
        if (after === before) return
        active.ui.notify(
            `${id}: the git stash stack changed during "${title}" and was left that way — `
                + 'inspect `git stash list`; an orphan stash later pops as an unresolvable conflict.',
            'warning'
        )
    } catch {
        // a git failure here is inconclusive, never a report
    }
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
    announceTerminal(ctx, msg, level)
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
                // but per-slice green can still ship a dead app — every slice's own
                // checks clean while the assembled whole does not serve. The run-level stage
                // runs the project's OWN whole-repo commands once, unaided, before the
                // run is declared complete, and resolves a FAIL with the user. It
                // touches none of this loop's per-task state — see run-final-gate.ts —
                // and every outcome it returns is terminal: a resume re-enters this
                // same branch and re-runs the gate, so fixing and resuming converges.
                const stage = await runFinalGateStage(active, deps, {
                    cwd,
                    runId: id,
                    // The parent plan (the task list) is what lets the gate tell a
                    // served app from a CLI — the boot check requires a listener only
                    // for the former.
                    planText: body,
                    taskCount: entries.length
                })
                if (stage.kind === 'cancelled') {
                    announceDone(active, stage.message, 'warning')
                    return
                }
                if (stage.kind === 'failed') {
                    await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                    announceDone(active, stage.message, 'error')
                    return
                }
                await updateTaskFrontMatter(cwd, id, {state: 'completed'})
                announceDone(active, stage.message, stage.level)
                return
            }
            // REFUSE to start on a conflicted tree: an unmerged index dooms every
            // commit ahead and a `git add -A` would silently mis-resolve it.
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
            try {
                // SAFE CHECKPOINT (pre-task): the tree is committed and no inner task
                // is stamped yet, so stopping here just leaves this entry unchecked —
                // a resume restarts it from scratch. The cheapest possible stop, and
                // the last one before a whole task is under way.
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
                // One dispatch over the named ending. The runner NAMES how the run
                // ended, so nothing here has to infer a user stop from a fault by
                // consulting a module global — the way that inference went wrong was
                // announcing a cancel in red as "stopped … fix and resume" and
                // overwriting the inner file's `cancelled` with `failed`.
                // Resumability is RUN_END_POLICY's call (shared with /task's loop);
                // only the wording is this command's.
                if (!runSucceeded(res.end)) {
                    const policy = RUN_END_POLICY[res.end.kind]
                    // Demote the INNER task file: it reads `completed` from
                    // spec-handoff, and leaving it that way is how a failed run's task
                    // file claims success after the run failed.
                    if (policy.resumable) await markResumable(cwd, res.taskId)
                    // The PLAN fails only on a fault. A declined-steer interrupt leaves
                    // it in progress so /task-auto-resume re-delivers this task's spec.
                    if (policy.failsRun) await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                    const why =
                        res.end.kind === 'failed' && res.end.reason ?
                            ` — ${res.end.reason.slice(0, 160)}`
                        :   ''
                    const msg =
                        res.end.kind === 'no-session' ?
                            `${id} paused — could not start a session. Run /task-auto-resume to retry.`
                        : res.end.kind === 'cancelled' ?
                            `${id} cancelled during "${next.title}" — resume with /task-auto-resume.`
                        : res.end.kind === 'interrupted' ?
                            // The user interrupted implementation (ESC) and then declined
                            // to steer — they want to stop here. Paused without checking
                            // the task off, so /task-auto-resume re-delivers this task's
                            // spec. (A plain ESC followed by steering text never reaches
                            // here — that loops inside runSingleTask until a turn ends.)
                            `${id} paused at "${next.title}" — resume with /task-auto-resume.`
                        :   `${id} stopped at "${next.title}"${why} — fix and run /task-auto-resume.`
                    announceDone(active, msg, policy.level)
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
                // Every terminal gate outcome — what to demote, what to fail, what to
                // say — comes from TERMINAL_OUTCOMES, shared verbatim with /task's
                // loop. `done` alone is not terminal here: it falls through to the
                // next task.
                if (gate.kind !== 'done') {
                    const outcome = TERMINAL_OUTCOMES[gate.kind]
                    if (outcome.markResumable) await markResumable(cwd, res.taskId)
                    if (outcome.failParent) {
                        await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                    }
                    announceDone(
                        active,
                        outcome.message({
                            tag: id,
                            at: formatAt(next.title),
                            why: formatWhy(gate.kind === 'failed' ? gate.reason : undefined),
                            resumeCmd: '/task-auto-resume'
                        }),
                        outcome.level
                    )
                    return
                }
                // ROOT-CAUSE REPAIR: the gate may have attributed a
                // FAIL to a pre-existing defect in a file some OTHER task created. It can
                // only QUEUE that finding — mutating the plan is this loop's job. Drain
                // the queue and splice a scoped repair step in right after the step that
                // just finished, so the defect is fixed BEFORE the next dependent task
                // trips over it too. Recording the same cause twice and scheduling
                // nothing lets one defect outlive most of a run.
                await schedulePendingRepairs(cwd, id, next.index, active, deps)
            } finally {
                // EVERY exit from this attempt passes here — the two mid-attempt
                // returns and a throw included. Sitting at the end of the
                // fall-through instead, below the capture and three returns, it
                // would run only when the task SUCCEEDED and the gate said
                // `done`. On a failed or interrupted task the user is told to run
                // /task-auto-resume, straight onto the landmine the guard exists to
                // name. The pairing is structural now, not positional.
                await reportStashDrift(active, deps, cwd, id, next.title, stashBefore)
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
    // The whole loop owns the session, not just the task inside it — and the
    // bracket takes delivery of a typed /task-auto-cancel for the WHOLE run,
    // planning included: planning is children too, so the host is not streaming
    // and the ordinary command path cannot reach us.
    try {
        await withRun(ctx, {onCancel: terminalCancel}, async () => {
            // Stamp a fresh per-run research-cache id BEFORE planning so enrichment and
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
        })
    } finally {
        autoRunning = false
    }
}

async function handleTaskAutoResume(args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    // `--unattended` is the boot-hook path: no human decided to continue this
    // run, so it resumes in-flight states only and refuses the rest by name.
    const unattended = /(^|\s)--unattended(\s|$)/.test(args)
    // Unattended asks a narrower question — "is there an IN-FLIGHT run?" — so it
    // searches those states directly. Picking the newest human-resumable run and
    // refusing it on state let a failed run shadow an in-flight one behind it.
    // With nothing in flight, fall back to the newest resumable run so the refusal
    // still names it instead of claiming there is nothing here.
    const eligible =
        unattended ?
            await findResumableAutoDetailed(cwd, UNATTENDED_STATES)
        :   await findResumableAutoDetailed(cwd)
    const candidate = eligible ?? (unattended ? await findResumableAutoDetailed(cwd) : null)
    const decision = decideResume(candidate, Date.now(), unattended)
    ctx.ui.notify(decision.banner, decision.level)
    // An unattended refusal happens with nobody watching the terminal — the
    // remote view is the only surface that will still be there in the morning.
    if (unattended) publishLifecycleNotice(decision.banner, decision.level)
    if (!decision.resume || !candidate) return
    const id = candidate.id
    await updateTaskFrontMatter(cwd, id, {state: 'in_progress'})
    autoRunning = true
    // The whole loop owns the session, not just the task inside it.
    try {
        await withRun(ctx, {onCancel: terminalCancel}, async () => {
            // Reuse the interrupted run's research-cache id, dropping only the entries whose
            // own package moved version. A fresh id per resume discards the whole
            // working cache, and a whole-file freshness gate can never hold on a
            // greenfield run that installs packages as it goes — so invalidation is
            // per entry. See resumeResearchRun.
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
        })
    } finally {
        autoRunning = false
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
 * loop — the run bracket's `onCancel`. The armed listener watches raw stdin, so
 * it works during the spec phases and the gates — the windows where pi would
 * otherwise queue the line until after the run (see cancel-input.ts). The
 * remote path is unaffected: dispatchRemoteLine invokes the handler directly.
 */
function terminalCancel(live: ExtensionCommandContext): void {
    requestAutoCancel()
    // `live` is the ctx the listener is currently installed on — the captured
    // one is stale the moment a task replaces the session.
    try {
        live.ui.notify(CANCEL_ACK, 'warning')
    } catch {
        /* the acknowledgement must never break the cancel itself */
    }
    publishLifecycleNotice(CANCEL_ACK, 'warning')
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
