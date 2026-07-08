/**
 * /task-auto — plans a feature into a resumable list of task titles, then runs
 * each title through the existing single-task pipeline one at a time.
 *
 * This module currently holds the planning half (AutoDeps + planAuto). The run
 * loop, command handlers, and defaultDeps are added by the next task.
 */
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
    findResumableAuto
} from './auto-io.js'
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
import {refineExistingFilesBlock} from './phases.js'
import {SessionUI, registerBridgeCommand, publishLifecycleNotice} from '../remote/bridge.js'
import {pushNotify} from '../remote/push.js'
import {startAutoLoader, type ContextSnapshot} from './widget.js'
import {getParentContextWindow, resolveContextUsage} from './context-usage.js'
import {buildGateDeps, type FinalGateFixFn} from './gate-deps.js'
import {runGatesForTask, type GateDeps} from './task-gates.js'
import {gitUnmergedPaths, gitStashRef} from './auto-commit.js'
import {runFinalIntegrationGate} from './final-gate.js'
import {
    classifyFinalGateAnswer,
    MAX_FINAL_GATE_AUTOFIX,
    FINAL_LEAVE_LABEL,
    FINAL_LEAVE_VALUE,
    FINAL_ACCEPT_LABEL,
    FINAL_ACCEPT_VALUE,
    FINAL_AUTOFIX_LABEL,
    FINAL_AUTOFIX_VALUE
} from './final-gate-fix.js'
import {getConfig} from '../config/config.js'

// Hard ceiling on clarify questions per feature. The loop is open-ended (it stops
// when the model emits NONE), but a model that never says NONE would otherwise
// barrage the user — the real mx5 run asked 10, several of them redundant.
const MAX_CLARIFY_QUESTIONS = 8

// Bounded coverage-triage rounds after decompose: judge → reprompt-with-missing
// → judge again, at most. Two rounds so one flaky retry doesn't end the gate,
// while a judge that keeps flagging can't loop the plan phase forever.
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
    finalGate?: (cwd: string) => Promise<{ok: boolean; reason: string}>
    /**
     * Bounded model-driven fix pass for a final-gate FAIL (see final-gate-fix.ts),
     * offered as the picker's third option. Runs the fix child, applies the
     * command-shrink guard, and re-runs the gate; the result's `ok` means the gate
     * now passes. Absent (tests / no fix wiring) → the picker keeps only
     * Leave-failed / Accept, exactly the pre-autofix behavior.
     */
    finalGateFix?: FinalGateFixFn
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

    // decompose
    const decomposePrompt = AUTO_DECOMPOSE_PROMPT(featureForModel, clarifications)
    const listRaw = await deps.runChild('auto-decompose', 'read', decomposePrompt)
    let planTitles = parseDecomposeList(listRaw)
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
        const retryTitles = parseDecomposeList(retryRaw)
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
    // A retry is adopted whenever it is NON-DEGENERATE — not only when it is
    // strictly longer. The retry was generated WITH the judge's missing areas in
    // its prompt, so it is the better-informed list, and the NEXT round's judge
    // (not raw length) decides whether the gaps actually closed. Length survives
    // only as a collapse floor against the one-task flake this gate exists for.
    // mx5 run 5 (live): the hinted retry ADDED the flagged test-suite task but came
    // back 29 titles vs the original 30 — strictly-longer discarded it, round 2
    // re-judged the same unchanged list, and the known-incomplete plan shipped
    // with no warning.
    let unresolvedMissing: string[] | null = null
    for (let round = 0; round < MAX_COVERAGE_ROUNDS && planTitles.length > 0; round++) {
        let verdict: CoverageVerdict | null
        try {
            verdict = parseCoverageVerdict(
                await deps.runChild(
                    'decompose-coverage',
                    '',
                    DECOMPOSE_COVERAGE_PROMPT(featureForModel, clarifications, planTitles)
                )
            )
        } catch {
            // Judge fault: unknown coverage, not known-missing — stay silent.
            unresolvedMissing = null
            break
        }
        if (verdict === null || verdict.kind === 'complete') {
            unresolvedMissing = null
            logPlanDebug(
                cwd,
                `decompose-coverage round ${round + 1}: `
                    + (verdict === null ? 'no verdict — accepting list' : 'COMPLETE')
            )
            // A COMPLETE on a still-suspect plan is the judge's known live
            // false-pass mode (bare verdict, indistinguishable from a real one).
            // The plan still ships — the floor never rejects on count — but
            // never silently: the user decides whether to trust it.
            if (isSuspectPlan(planTitles, featureForModel)) {
                ctx.ui.notify(
                    `/task-auto: only ${planTitles.length} task(s) planned for a large spec`
                        + ' and the regeneration did not grow the list — review the plan before running.',
                    'warning'
                )
            }
            break
        }
        unresolvedMissing = verdict.missing
        logPlanDebug(
            cwd,
            `decompose-coverage round ${round + 1}: INCOMPLETE — missing: `
                + verdict.missing.join('; ').slice(0, 300)
        )
        const retryRaw = await deps.runChild(
            'auto-decompose',
            'read',
            prependHint(coverageRepromptHint(verdict.missing), decomposePrompt)
        )
        const retryTitles = parseDecomposeList(retryRaw)
        logPlanDebug(cwd, `decompose retry produced ${retryTitles.length} title(s)`)
        if (retryTitles.length > 0 && retryTitles.length * 2 >= planTitles.length) {
            planTitles = retryTitles
        } else {
            logPlanDebug(
                cwd,
                `decompose retry discarded as degenerate (${retryTitles.length} vs ${planTitles.length} titles)`
            )
        }
    }
    // Rounds exhausted with the last judgment still INCOMPLETE: the plan ships (the
    // gate is best-effort), but silently shipping a KNOWN-gapped plan is how mx5
    // run 5 lost its whole test suite — tell the user what the judge last flagged.
    if (unresolvedMissing !== null) {
        logPlanDebug(
            cwd,
            `decompose-coverage exhausted ${MAX_COVERAGE_ROUNDS} round(s) still INCOMPLETE — missing: `
                + unresolvedMissing.join('; ').slice(0, 300)
        )
        ctx.ui.notify(
            `/task-auto: plan may be missing coverage — ${unresolvedMissing.join('; ').slice(0, 200)} — review the plan before running.`,
            'warning'
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
    await writeTaskFile(cwd, fm, buildAutoBody(feature, clarifications, titles))
    return id
}

/** The two feature-level planning children, shown as steps in the loader. */
const AUTO_PLAN_STEPS: Record<string, {step: string; stepNum: number}> = {
    'auto-clarify': {step: 'clarify', stepNum: 1},
    'auto-decompose': {step: 'decompose', stepNum: 2},
    'decompose-coverage': {step: 'coverage', stepNum: 2}
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
        finalGate: cwd2 =>
            getConfig().verifyWork ?
                runFinalIntegrationGate(cwd2)
            :   Promise.resolve({ok: true, reason: 'disabled'})
    }
}

// ─── Loop ────────────────────────────────────────────────────────────────────

let cancelRequested = false
let autoRunning = false

export function requestAutoCancel(): void {
    cancelRequested = true
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
    cancelRequested = false
    // Each task runs in its own fresh session (deps.runTask → ctx.newSession),
    // which tears down the current session and leaves the ctx we passed in stale.
    // Adopt the replacement ctx the runner hands back and use it for all further
    // UI and the next task — reusing the captured ctx throws "stale ctx".
    let active = ctx
    try {
        for (;;) {
            if (cancelRequested) {
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
                    let fin = await deps.finalGate(cwd)
                    if (!fin.ok) await recGate(`final-gate: FAIL — ${fin.reason.slice(0, 300)}`)
                    // Resolution loop: Leave-failed (recommended) / Autofix (bounded,
                    // model-driven fix pass + gate re-run — run 7's gap: the picker
                    // had NO automated fix path) / Accept. The user always decides;
                    // after MAX_FINAL_GATE_AUTOFIX attempts that still FAIL the
                    // autofix card is withdrawn so the loop cannot run unbounded.
                    let fixAttempts = 0
                    while (!fin.ok) {
                        const canAutofix =
                            deps.finalGateFix !== undefined && fixAttempts < MAX_FINAL_GATE_AUTOFIX
                        const question =
                            `Final integration gate FAILED for ${id}.\n\n${fin.reason}\n\n`
                            + 'All tasks are checked off — this is the whole-repo check '
                            + '(the project’s own test/build/static commands, run unaided).'
                            + (fixAttempts > 0 ?
                                `\n\nAutofix attempts so far: ${fixAttempts}/${MAX_FINAL_GATE_AUTOFIX}.`
                            :   '')
                        const answer = await new SessionUI(active).ask({
                            localTitle: 'Final integration gate failed — how should pi proceed?',
                            displayQuestion: question,
                            question,
                            recommended: FINAL_LEAVE_LABEL,
                            recommended2: canAutofix ? FINAL_AUTOFIX_LABEL : FINAL_ACCEPT_LABEL,
                            allowSkip: false,
                            options: [
                                {label: FINAL_LEAVE_LABEL, value: FINAL_LEAVE_VALUE},
                                ...(canAutofix ?
                                    [{label: FINAL_AUTOFIX_LABEL, value: FINAL_AUTOFIX_VALUE}]
                                :   []),
                                {label: FINAL_ACCEPT_LABEL, value: FINAL_ACCEPT_VALUE}
                            ]
                        })
                        const choice = classifyFinalGateAnswer(answer)
                        if (choice.action === 'accept') {
                            await recGate('final-gate: FAIL accepted by user')
                            active.ui.notify(
                                `${id}: final integration gate FAIL accepted by user — completing.`,
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
                            active.ui.notify(
                                `${id}: final-gate autofix did not converge — ${fix.reason.slice(0, 140)}`,
                                'warning'
                            )
                            // Work from the FRESH gate failure when the fix pass got
                            // as far as re-running the gate; otherwise keep the last.
                            fin = {ok: false, reason: fix.gateReason ?? fin.reason}
                            continue
                        }
                        // Leave failed — the dismissal default, unchanged from the
                        // two-option picker (an unavailable autofix demotes here too).
                        await recGate('final-gate: left failed (user)')
                        await updateTaskFrontMatter(cwd, id, {state: 'failed'})
                        announceDone(
                            active,
                            `${id} finished all tasks but FAILED the final integration gate — ${fin.reason.slice(0, 200)} — fix and /task-auto-resume (the gate re-runs).`,
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
            active.ui.notify(
                `${id}: task ${next.index + 1}/${entries.length} — ${next.title}`,
                'info'
            )
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
            const res = await deps.runTask(active, cwd, next.title, {
                resumeId,
                // Fence this step against re-expanding the whole referenced spec:
                // name the sibling steps so refine bounds this step's slice. Only
                // matters when refine runs fresh (a resumed task past refine ignores
                // it), but always supplied so a resume that restarts at refine is
                // fenced too.
                planContext: buildScopeFence(
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
                planContext: buildScopeFence(
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
        cancelRequested = false
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
    const abort = new AbortController()
    const deps = defaultDeps(ctx, cwd, abort.signal, deriveTitle(raw))
    let id: string | null
    try {
        id = await planAuto(ctx, cwd, raw, deps)
    } catch (err) {
        autoRunning = false
        const msg = err instanceof Error ? err.message : String(err)
        if (msg === USER_CANCELLED) {
            announceDone(ctx, '/task-auto cancelled.', 'warning')
            return
        }
        announceDone(ctx, `/task-auto planning failed: ${msg}`, 'error')
        return
    }
    if (!id) {
        autoRunning = false
        return
    }
    // Check for a cancel that was requested during the planning phase before the
    // loop resets the flag.
    if (cancelRequested) {
        cancelRequested = false
        autoRunning = false
        announceDone(ctx, '/task-auto cancelled.', 'warning')
        return
    }
    await runAutoLoop(ctx, cwd, id, deps)
    autoRunning = false
}

async function handleTaskAutoResume(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    await ctx.waitForIdle()
    const cwd = ctx.cwd
    const id = await findResumableAuto(cwd)
    if (!id) {
        ctx.ui.notify('No resumable /task-auto run.', 'info')
        return
    }
    ctx.ui.notify(`Resuming ${id}…`, 'info')
    await updateTaskFrontMatter(cwd, id, {state: 'in_progress'})
    autoRunning = true
    const abort = new AbortController()
    // Resume only runs the loop (runTask); no planning children, so the loader
    // title is unused here — pass the id for clarity if that ever changes.
    await runAutoLoop(ctx, cwd, id, defaultDeps(ctx, cwd, abort.signal, id))
    autoRunning = false
}

// eslint-disable-next-line @typescript-eslint/require-await
async function handleTaskAutoCancel(_args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!autoRunning) {
        ctx.ui.notify('No /task-auto loop is running.', 'info')
        return
    }
    requestAutoCancel()
    ctx.ui.notify('Stopping /task-auto after the current task…', 'warning')
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerTaskAuto(pi: ExtensionAPI): void {
    registerBridgeCommand(pi, 'task-auto', {
        description: 'Plan a feature into tasks and run them. Usage: /task-auto <feature>',
        handler: handleTaskAuto
    })
    registerBridgeCommand(pi, 'task-auto-resume', {
        description: 'Resume the active /task-auto run.',
        handler: handleTaskAutoResume
    })
    registerBridgeCommand(pi, 'task-auto-cancel', {
        description: 'Stop the running /task-auto loop after the current task.',
        handler: handleTaskAutoCancel
    })
}
