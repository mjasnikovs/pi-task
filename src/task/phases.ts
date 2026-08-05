/**
 * Phase pipeline — the five phase functions (refine, research, grill, compose,
 * critique) plus the config table that drives the orchestrator loop.
 */

import {fileURLToPath} from 'node:url'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {docsFocused} from '../workers/docs-core.js'
import {fetchFocused} from '../workers/fetch-core.js'
import {formatNpmVersionSection} from '../workers/npm-version.js'
import {runWorker, type RunWorkerResult} from '../workers/pi-worker-core.js'
import {
    findPhantomImports,
    formatApiCorrections,
    rewritePhantomSpecifiers
} from '../workers/phantom-imports.js'
import {search as defaultSearch} from '../workers/search-core.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'
import type {SearchProvider} from '../workers/search-types.js'
import {extractEnrichTargets} from './enrichment.js'
import {
    fanoutTimeoutPolicy,
    workerCarryForward,
    workerProgressCeilingMs,
    projectDocsBudget,
    projectDocsBudgetNotice
} from './research-fanout-budget.js'
import {isIntegrationUnknown} from './unknown-routing.js'
import {
    extractUserDirectives,
    preserveDirectivesBlock,
    enforceDirectives
} from './user-directives.js'
import {demoteUnsourcedAttributions} from './context-attribution.js'
import {classifyContextSilence, countBullets} from './context-silence.js'
import {getFileInventory} from './file-inventory.js'
import {buildOrientation, orientationTier} from './orientation.js'
import {getConfig} from '../config/config.js'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {formatServiceBlock, formatFreshnessSkippedBlock} from './service-blocks.js'
import {gatherExternalContext, type ExternalContextDeps} from './external-context.js'
import {
    REFINE_PROMPT,
    RESEARCH_FILES_PROMPT,
    RESEARCH_APIS_PROMPT,
    RESEARCH_CONTEXT_PROMPT,
    RESEARCH_TOOLING_PROMPT,
    GRILL_GEN_PROMPT,
    GRILL_AUTO_ANSWER_PROMPT,
    GRILL_AUTO_FORMAT_HINT,
    COMPOSE_PROMPT,
    CRITIQUE_PROMPT,
    CRITIQUE_TRIAGE_PROMPT,
    VERIFY_TOOLING_PROMPT,
    MAX_GRILL_QUESTIONS,
    appendNoThink
} from './prompts.js'
import {
    appendGateRecord,
    readSection,
    removeTaskSection,
    setTaskSection,
    updateTaskFrontMatter
} from './task-io.js'
import {applyRefutations} from './refuted-constraint.js'
import {spawnSync} from 'node:child_process'
import {type PhaseName} from './task-types.js'
import {renderInlineMarkdown, stripInlineMarkdown} from './inline-markdown.js'
import {isDuplicateQuestion, MAX_DUP_STRIKES, DUP_REPROMPT_HINT} from './question-dedup.js'
import {type WidgetState} from './widget.js'
import {
    parseGrillQuestions,
    parseAutoAnswer,
    autoAnswerHasTag,
    parseVerifyToolingOutput,
    deriveTitle,
    type AutoAnswer
} from './parsers.js'
import {compressTitle} from './title-label.js'
import {
    parseVerifyBlock,
    validateSpecShape,
    stripSpecPreamble,
    isCritiqueClean
} from './spec-validation.js'
import {findSkipEscapes, skipEscapeDefectText} from './skip-escape.js'
import {findScriptEscapesInText, scriptEscapeDefectText} from './script-escape.js'
import {findSynthesizedWiring, wiringProbeText, readReferencedDocs} from './wiring-claims.js'
import {
    findAbsenceConflicts,
    absenceProbeText,
    siblingTitlesFromPlanContext
} from './verify-reconcile.js'
import {findFrozenPathConflicts, frozenConflictProbeText} from './frozen-conflict.js'
import {findSynthesizedApis, synthesizedApiReaskHint} from './api-synthesis.js'
import {
    findGrepOnlyVerify,
    grepOnlyVerifyDefectText,
    GREP_THEATER_RETRY_HINT
} from './verify-quality.js'
import {existsSync} from 'node:fs'
import {readContracts, buildContractsBlock, buildContractsVerifyBlock} from './contracts.js'
import {
    readRequirements,
    buildRequirementsBlock,
    buildOwnedRequirementsBlock,
    readOwnedRequirements,
    writeOwnedRequirements,
    ownedForTitle,
    appendOwnedConstraints,
    type OwnedRequirement
} from './requirements.js'
import {
    detachUnsatisfiableRequirements,
    claimPendingRequirements,
    unclaimedPendingRequirements,
    formatReassignActions
} from './owned-freeze-reassign.js'
import {trackedSourceOracle} from './owned-freeze-conflict.js'
import {
    runPhaseChild,
    runPhaseWithLoopGuard,
    runWithEmphasisRetry,
    prependHint,
    USER_CANCELLED,
    type PhaseDeps
} from './child-runner.js'
import {SessionUI} from '../remote/bridge.js'
import {isYoloMode, yoloPickAutoAnswer, YOLO_STAMP} from './yolo.js'

// ─── Re-export constants from their home modules ────────────────────────────

export {MAX_GRILL_QUESTIONS}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PhaseContext {
    cwd: string
    id: string
    ctx: ExtensionCommandContext
    widgetState: WidgetState
    rawPrompt: string
    refined: string
    research: string
    qa: string
    spec: string
    /**
     * Scope fence for a task that is one step of a /task-auto plan: names the
     * sibling steps so refine bounds this task's slice instead of re-expanding the
     * whole spec doc. Undefined for a bare /task run (prompt unchanged). Threaded
     * only into refine — its scoped output carries the boundary downstream.
     */
    planContext?: string
}

export type OutputField = 'refined' | 'research' | 'qa' | 'spec'

export interface PhaseConfig {
    name: PhaseName
    section: string
    field: OutputField
    run: (deps: PhaseDeps, pc: PhaseContext) => Promise<string>
}

// ─── Tooling helpers ─────────────────────────────────────────────────────────

/** Extract the TOOLING section commands from a research output string. */
export function extractToolingCommands(research: string): string[] | null {
    const toolingMatch = /^TOOLING\s*\n([\s\S]*?)(?=^[A-Z][A-Z-]+\s*$|(?![\s\S]))/m.exec(research)
    if (!toolingMatch) return null
    const block = toolingMatch[1]
    const commands: string[] = []
    for (const raw of block.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        // A section MARKER describes the worker, not a command. Without this the
        // "(none — the TOOLING worker ran …)" / "(degraded: …)" line is handed to the
        // verify child as a command to run, which can only be rejected — noise in the
        // prompt and one more thing that reads like a real tool in the task file.
        if (/^\((?:none —|degraded:)/.test(line)) continue
        const match = line.match(/^\S.*?\s{2,}(.+)$/)
        if (match) {
            commands.push(match[1].trim())
        } else {
            commands.push(line)
        }
    }
    return commands.length > 0 ? commands : null
}

/** Replace the TOOLING section in a research string with a VERIFIED-TOOLING section. */
export function replaceToolingWithVerified(research: string, verifiedCommands: string[]): string {
    const verifiedBlock =
        verifiedCommands.length > 0 ?
            verifiedCommands.map(cmd => `  ${cmd}`).join('\n')
        :   '  (none verified)'
    const replacement = `VERIFIED-TOOLING\n${verifiedBlock}`
    const replaced = research.replace(
        /^TOOLING\s*\n([\s\S]*?)(?=^[A-Z][A-Z-]+\s*$|$(?![\s\S]))/m,
        replacement + '\n\n'
    )
    if (replaced === research) {
        return research + `\n\n${replacement}`
    }
    return replaced
}

// ─── Phase functions ─────────────────────────────────────────────────────────

// Authoritative directive that travels with the refine orientation block. Refine
// runs BEFORE research, so on a "Scaffold project with package.json…" title it has
// no signal the file already exists and authors greenfield strip-constraints
// ("bun-plugin-tailwind the only dependency", "exactly N scripts") that compose
// then obeys over the research facts — the implementer executes a wholesale
// rewrite that drops every existing dependency and script (mx5 TASK_0001 emptied
// package.json; the REAL pipeline reproduced it 3/3 even with research surfacing
// the deps). Handing refine the manifest/config CONTENT up front, with this
// reframe, fixes it at the origin (A/B: 1/5 → 5/5 preserve, 5/5 end-to-end).
const REFINE_PRESERVE_DIRECTIVE =
    'EXISTING FILES ON DISK — AUTHORITATIVE (overrides any "scaffold / create / set '
    + 'up / initialize / from scratch / only / exactly / minimal" wording in the task '
    + 'below): the files shown in the PROJECT ORIENTATION block ALREADY EXIST. When '
    + 'the task says to scaffold, create, set up, initialize, or configure a file that '
    + 'already exists, your GOAL and CONSTRAINTS MUST frame it as an in-place UPDATE '
    + 'that PRESERVES every existing dependency, devDependency, script, field, and '
    + "compiler option — adding or changing only the task's explicit delta. Do NOT "
    + 'author any constraint that empties, reduces to a fixed/minimal set, renames, '
    + 'recreates, or drops existing entries (no "X is the only dependency", no '
    + '"exactly N scripts", no "produce exactly N files from scratch"). An existing '
    + 'entry is NEVER scope drift and is never removed because it "belongs to a later step".'

/**
 * Manifest + config content (orientation tiers 0–1) for refine, with the preserve
 * directive. Reuses the SAME orientation machinery research feeds its workers — not
 * a parallel reader — scoped to the "accumulative" files a from-scratch rewrite
 * silently destroys. '' (non-git/empty/orientation-off) leaves refine unchanged, so
 * a genuinely greenfield task is still free to create.
 */
export async function refineExistingFilesBlock(deps: PhaseDeps): Promise<string> {
    if (!getConfig().orientation) return ''
    const inventoryRaw = await getFileInventory(deps.cwd, deps.signal).catch(() => '')
    if (inventoryRaw.length === 0) return ''
    const paths = inventoryRaw
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && (orientationTier(l) === 0 || orientationTier(l) === 1))
    if (paths.length === 0) return ''
    const {block} = await buildOrientation(paths, async p => {
        try {
            return await readFile(resolve(deps.cwd, p), 'utf8')
        } catch {
            return null
        }
    })
    return block.trim().length === 0 ? '' : `${REFINE_PRESERVE_DIRECTIVE}\n\n${block.trim()}`
}

/**
 * The read-only cross-slice contract block (see contracts.ts) for a phase that
 * generates spec text — the verbatim interface facts the SOURCE design pins that
 * more than one slice touches. Empty when the registry is absent/empty (single
 * `/task` runs, or a design that pins no shared boundary), so this degrades to a
 * no-op. Best-effort: a read fault yields '' rather than blocking the phase.
 */
export async function phaseContractsBlock(deps: PhaseDeps): Promise<string> {
    const contracts = await readContracts(deps.cwd).catch(() => '')
    return buildContractsBlock(contracts)
}

/**
 * The carried-context blocks a GENERATIVE phase (refine, compose) receives: the
 * cross-slice contracts plus the carried cross-cutting requirements (mx5 run 11,
 * goals A/C — `.pi-tasks/requirements.md`, written at plan time). The verbatim
 * requirement quotes travel INTO every task's spec generation, so a mandated
 * methodology ("a test lands in the same change as each new route") reaches the
 * task's GOAL/CONSTRAINTS and its VERIFY — a pointer back to the spec doc
 * recovered the dropped §10 in only 1 of ~6 applicable run-11 tasks; content
 * travels, pointers don't. Both blocks are '' outside their runs, so a bare
 * /task is byte-identical to before.
 */
export async function phaseCarriedBlocks(deps: PhaseDeps): Promise<string> {
    const contracts = await phaseContractsBlock(deps)
    const requirements = buildRequirementsBlock(await readRequirements(deps.cwd).catch(() => ''))
    const owned = buildOwnedRequirementsBlock(await ownedForThisTask(deps))
    return [contracts, requirements, owned].filter(b => b.length > 0).join('\n')
}

/**
 * The owned (task-mapped) requirements for THIS task (mx5 run 16): matched by
 * the plan title the coverage map keyed them to, which is the task's stored
 * `raw prompt` section verbatim. Empty outside /task-auto runs, for spliced
 * repair tasks, and when the plan recorded no mapping — all of which degrade to
 * the pre-run-16 behavior. This is the BELT (prompt block, into refine +
 * compose); appendOwnedConstraints on the final spec is the BRACES — the belt
 * alone folded the clause in only 2/8 live reps per fixture.
 */
async function ownedForThisTask(deps: PhaseDeps): Promise<OwnedRequirement[]> {
    try {
        const title = (await readSection(deps.cwd, deps.taskId, 'raw prompt')) ?? ''
        return ownedForTitle(await readOwnedRequirements(deps.cwd), title.trim())
    } catch {
        return []
    }
}

/** This task's plan title — the owned ledger's join key. */
async function planTitle(deps: PhaseDeps): Promise<string> {
    try {
        return ((await readSection(deps.cwd, deps.taskId, 'raw prompt')) ?? '').trim()
    } catch {
        return ''
    }
}

/** The `isSource` oracle production uses: git tracks the path in this tree. */
function repoSourceOracle(cwd: string): (p: string) => boolean {
    return trackedSourceOracle(p => {
        const r = spawnSync('git', ['ls-files', '--', p], {cwd, encoding: 'utf8', timeout: 4000})
        return {stdout: r.stdout ?? '', exitCode: r.status ?? 1}
    })
}

/**
 * DETACH (nexttask 2) — an owned requirement this task cannot satisfy, because a
 * category freeze in the very spec that carries it covers the only file that
 * could, stops being this task's obligation and is released to whichever later
 * task writes that file.
 *
 * Runs at the LAST spec-producing step, where the pair first exists: the stamped
 * bullet is written one statement earlier by `appendOwnedConstraints`, and a
 * critique-time probe measured 0/40 because the stamp did not exist yet. It
 * never edits prose and never asks a model — the run-18 rewrite lever resolved
 * 11 of 20 pairs by DELETING the authoritative clause. The quote stays in the
 * ledger throughout; only its owner changes.
 */
export async function resolveOwnedFreezeForThisTask(
    deps: PhaseDeps,
    spec: string
): Promise<string> {
    const ledger = await readOwnedRequirements(deps.cwd).catch(() => [])
    if (ledger.length === 0) return spec
    const title = await planTitle(deps)
    if (title.length === 0) return spec
    const res = detachUnsatisfiableRequirements({
        spec,
        title,
        ledger,
        isSource: repoSourceOracle(deps.cwd)
    })
    if (res.actions.length === 0) return spec
    deps.logDebug?.(formatReassignActions(res.actions))
    if (!res.actions.some(a => a.kind === 'detach')) return spec
    await writeOwnedRequirements(deps.cwd, res.ledger)
    return res.spec
}

/**
 * CLAIM (nexttask 2) — the other half. A requirement detached by an earlier task
 * becomes THIS task's own when its refined prompt says it writes the frozen
 * file. Run before compose builds its carried blocks, so the claimed obligation
 * rides the same belt every owned requirement does and the braces stamp it onto
 * this spec.
 *
 * The claimant is the only party that knows: at detach time the later tasks are
 * bare plan titles, and none of mx5 run 19's 26 titles contains the path. Over
 * the same run's 26 REFINED prompts, `writeIntent` picks out exactly the two
 * tasks that write the server file.
 */
export async function claimOwnedFreezeForThisTask(deps: PhaseDeps, refined: string): Promise<void> {
    const ledger = await readOwnedRequirements(deps.cwd).catch(() => [])
    if (unclaimedPendingRequirements(ledger).length === 0) return
    const title = await planTitle(deps)
    if (title.length === 0) return
    const res = claimPendingRequirements({intent: refined, title, ledger})
    if (res.actions.length === 0) return
    deps.logDebug?.(formatReassignActions(res.actions))
    await writeOwnedRequirements(deps.cwd, res.ledger)
}

export const phaseRefine = async (deps: PhaseDeps, raw: string, planContext?: string) => {
    const existingFiles = await refineExistingFilesBlock(deps).catch(() => '')
    const contracts = await phaseCarriedBlocks(deps)
    // Imperative tool directives the user wrote into the RAW prompt ("via web
    // search", "fetch <url>"). Refine paraphrases the task and a weak model drops
    // these some of the time (mx5 run 9: "via web search" vanished, the whole run
    // made 0 search calls). Hand them to refine as a MUST-PRESERVE block (belt) and
    // re-check the output below (lever). Empty on an ordinary prompt → refine unchanged.
    const directives = extractUserDirectives(raw)
    const directivesBlock = preserveDirectivesBlock(directives)
    const refined = await runPhaseWithLoopGuard(
        deps,
        'refine',
        'read',
        hint =>
            prependHint(
                hint,
                appendNoThink(
                    REFINE_PROMPT(raw, planContext, existingFiles, contracts, directivesBlock)
                )
            ),
        // refine's deliverable is a 4-section text rewrite that never strictly
        // needs a successful read — on a test-writing task against a large
        // existing codebase the model over-explores (re-reads source hunting for
        // the impl) and burns the loop budget. Degrade to a no-tools final
        // attempt instead of hard-failing the whole run. See TASK_0016 (mx5):
        // refine looped 3×/resume forever; the deliverable was always producible
        // from the title + design doc alone.
        {degradeOnExhaustion: true}
    )
    // Deterministic backstop: if the refined spec still dropped a directive, append
    // it verbatim rather than trusting the paraphrase. No model in this path.
    const {text, appended} = enforceDirectives(refined, directives)
    if (appended.length > 0) {
        deps.logDebug?.(
            `refine: re-attached ${appended.length} dropped user directive(s): `
                + appended.map(d => d.kind).join(', ')
        )
    }
    return text
}

export async function phaseVerifyTooling(deps: PhaseDeps, research: string): Promise<string> {
    const commands = extractToolingCommands(research)
    if (!commands || commands.length === 0) {
        return replaceToolingWithVerified(research, [])
    }

    const toolingList = commands.join('\n')
    let verifyOutput: string
    try {
        verifyOutput = await runPhaseChild(
            deps,
            'verify-tooling',
            'read,bash',
            appendNoThink(VERIFY_TOOLING_PROMPT(toolingList))
        )
    } catch {
        return replaceToolingWithVerified(research, commands)
    }

    const parsed = parseVerifyToolingOutput(verifyOutput)
    const verifiedSection =
        parsed.verified.length > 0 ? parsed.verified.join('\n')
        : parsed.rejected.length > 0 ? '(none verified)'
        : '(verification inconclusive)'

    await setTaskSection(deps.cwd, deps.taskId, 'verified tooling', verifiedSection)

    return replaceToolingWithVerified(research, parsed.verified)
}

export interface PhaseResearchDeps extends ExternalContextDeps {
    getFileInventory?: (cwd: string, signal?: AbortSignal) => Promise<string>
}

const DOCS_EXTENSION_PATH = fileURLToPath(new URL('../workers/docs-extension.js', import.meta.url))

/** pi-worker-search + pi-worker-fetch, loaded into the APIS research worker only
 *  when a Brave key is configured (the tool without a key just errors, and a weak
 *  model burns calls on it). Search being absent from the research toolset was
 *  STRUCTURAL: three consecutive audited runs made 0 search calls because the
 *  child literally did not have the tool. */
const SEARCH_EXTENSION_PATH = fileURLToPath(
    new URL('../workers/search-extension.js', import.meta.url)
)

/**
 * Is live web search configured for this process? The keyless providers (exa,
 * ddg) always are; only brave needs its API key — mirrors search-core's lookup.
 */
export function searchConfigured(
    getEnv: (k: string) => string | undefined = k => process.env[k],
    provider: SearchProvider = getConfig().searchProvider
): boolean {
    if (provider !== 'brave') return true
    return Boolean(getEnv('BRAVE_SEARCH_API_KEY') ?? getEnv('BRAVE_API_KEY'))
}

/** Extra prompt block for the APIS worker when search is available — trigger-framed
 *  (the validated shape for getting a local model to actually reach for search). */
export const RESEARCH_SEARCH_HINT =
    '\n\nLIVE WEB — use pi-worker-search for external facts your training data may have stale: '
    + 'the CURRENT version of a framework/runtime the task pins, a breaking API change you are '
    + 'not sure shipped, an error message you cannot explain from the code. Call '
    + '`pi-worker-search(query)` first, then `pi-worker-fetch(url)` on the result you want to '
    + 'read. Do NOT answer version or release questions from memory. Skip search entirely for '
    + "anything the project's own files or pi-worker-docs already answer."

/**
 * In-process guards loaded into the TOOLING worker only: block a re-read of any
 * file already read, and block any byte-identical grep/find/ls repeat, feeding
 * the model "you already have this, answer now" instead of letting it re-run.
 * TOOLING reads each file once and never needs an identical search twice in any
 * healthy recorded run, so neither rule has a legitimate false positive here.
 * See single-read-guard.ts.
 */
const SINGLE_READ_EXTENSION_PATH = fileURLToPath(
    new URL('../workers/single-read-extension.js', import.meta.url)
)

/**
 * Task-file heading under which a research worker's validated output is cached.
 * A resumed research phase reads these to skip workers that already succeeded,
 * instead of re-running all four from scratch when one of them fails — the
 * expensive case (e.g. 3 healthy workers thrown away because the 4th looped).
 */
function researchWorkerCacheHeading(section: string): string {
    return `research worker ${section}`
}

/**
 * The TOOLING worker only needs to know which verification commands the task
 * cares about — never the per-file edit list. Big refined prompts embed a long
 * bulleted "fix these files" checklist *inside* the GOAL block; handing that to
 * a weak local model drags it into reading/grepping source it doesn't need and
 * it loops (TASK_0017: read(sql-adapter.ts) ×5 → loop-kill → fails the phase).
 * So scope TOOLING's view to the GOAL prose, truncated at the first bullet.
 *
 * Fallbacks, in order: no bare `GOAL` header (free-form refined) → the whole
 * refined unchanged; a GOAL block with no bullets → the full GOAL block. The
 * GOAL boundary is the next bare ALL-CAPS header (CONSTRAINTS, KNOWN-UNKNOWNS,
 * …) or end of text. Verified against every recorded refined prompt: the
 * bullet-heavy failure case drops 3319→329 chars with zero source-file
 * mentions; the rest are unchanged or only lightly trimmed.
 */
export function scopedToolingGoal(refined: string): string {
    const m = /^GOAL[ \t]*\n([\s\S]*?)(?=\n[A-Z][A-Z][A-Z -]*[ \t]*\n|$(?![\s\S]))/m.exec(refined)
    if (!m) return refined
    const goal = m[1].trim()
    const firstBullet = goal.search(/\n[ \t]*[-*]\s/)
    return firstBullet === -1 ? goal : goal.slice(0, firstBullet).trim()
}

/**
 * Classify a research worker's result so the phase can react per-worker instead
 * of treating every failure the same. Two distinct failure shapes:
 *
 *   - 'runaway' (loop-kill OR per-worker wall-clock timeout): the worker explored
 *     too long and was killed *after* burning its MAX_LOOP_RESTARTS restarts. It
 *     did real work and left partial text; the other three workers are unaffected.
 *     Failing the whole task here would throw away every already-good worker AND
 *     abort the entire auto-run over the weakest section — and because the loop is
 *     deterministic, a resume just re-loops and re-fails. So this DEGRADES: keep
 *     the partial answer (marked), cache it, move on. A loop-kill is a SIGTERM
 *     (exit 143) OR a clean exit 0 with truncated text, so loopHit/timedOut — not
 *     exitCode — are the reliable signal and are checked first.
 *
 *   - 'fatal' (non-zero exit that isn't a loop-kill, a provider error behind an
 *     empty answer, or a leaked never-executed tool call): the output is
 *     untrustworthy in a way partial text can't paper over (broken env, model
 *     disconnect, wrong tool-call dialect). These still throw — degrading them
 *     would launder a real breakage into a plausible-looking section.
 *
 *   - 'empty' (clean exit 0, no provider error, no loop/timeout — the model simply
 *     wrote nothing): NOT a failure. On an extremely simple task ("create a folder
 *     with an index.html in it") three of the four workers have genuinely nothing
 *     to report, and each worker prompt tells the model to emit ONLY what this task
 *     touches and to drop everything else — so silence is the CORRECT answer and
 *     was killing the whole task at research (issue #10). Measured live on the
 *     issue's own prompt (30 reps/worker, local Qwen3.6-27B): every APIS answer was
 *     semantically "there is nothing here", and 2/30 were literally zero bytes on a
 *     clean exit — the other 28 survived only because the model happened to wrap the
 *     same non-answer in a parenthetical, which is model style, not signal. The
 *     caller retries once and then accepts an explicit empty section; what stays
 *     fatal is silence WITH a reported cause, which is the masked-disconnect case
 *     this branch was written for and which `modelError` now names outright.
 *
 * Returns null when the result is trustworthy.
 */
function classifyResearchWorker(
    name: string,
    result: RunWorkerResult
): {kind: 'runaway'; reason: string} | {kind: 'fatal'; error: Error} | {kind: 'empty'} | null {
    if (result.loopHit) {
        const argsStr = JSON.stringify(result.loopHit.call.args)
        return {
            kind: 'runaway',
            reason:
                `stuck in a loop — called ${result.loopHit.call.name}(${argsStr}) `
                + `×${result.loopHit.count} in the last ${result.loopHit.windowSize} calls `
                + `and still looped after restarts`
        }
    }
    if (result.timedOut) {
        return {kind: 'runaway', reason: 'timed out after restarts'}
    }
    if (result.exitCode !== 0) {
        return {
            kind: 'fatal',
            error: new Error(
                `Research ${name} worker failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`
            )
        }
    }
    if (result.text.trim().length === 0) {
        // NOTHING CAME BACK — two different events wear the same face, and the whole
        // point of this branch is to tell them apart:
        //
        //   FAILED, cause reported: pi delivers a failed turn as an empty assistant
        //     message with stopReason "error" and exit 0, so the real cause used to be
        //     discarded and reported as the useless "produced no output". Name it.
        //   FAILED, child never spoke: no stdout at all means the child died before it
        //     could run (unresolvable provider, missing key, bad argv) — it never
        //     answered, so it cannot have answered "nothing".
        //   EMPTY: a child that streamed, exited 0, reported no error, and wrote no
        //     answer. The worker ran and the model had nothing to say — a real answer
        //     on a task that touches nothing, not a failure.
        if (result.modelError) {
            return {
                kind: 'fatal',
                error: new Error(
                    `Research ${name} worker: model error — ${result.modelError.slice(0, 200)}`
                )
            }
        }
        if (!result.sawOutput) {
            return {
                kind: 'fatal',
                error: new Error(
                    `Research ${name} worker produced no output — the child never wrote a `
                        + 'single byte, so it died before it could answer'
                        + (result.stderr ? `: ${result.stderr.slice(-300)}` : '')
                )
            }
        }
        return {kind: 'empty'}
    }
    if (result.leakedToolCall) {
        return {
            kind: 'fatal',
            error: new Error(
                `Research ${name} worker wrote a tool call as text instead of invoking it `
                    + `(${result.leakedToolCall.trim()}) — it never ran`
            )
        }
    }
    return null
}

/**
 * Build a degraded section body for a runaway worker: a one-line marker naming
 * the failure (so downstream phases and a human reading the task file know this
 * section is incomplete) followed by whatever partial answer the worker streamed
 * before it was killed. The marker is always present even when there is no
 * partial text, so an empty degrade is never mistaken for a real finding.
 */
export function degradedSectionBody(name: string, reason: string, partial: string): string {
    const marker = `(degraded: research ${name} worker ${reason}; this section may be incomplete)`
    const body = partial.trim()
    return body.length > 0 ? `${marker}\n\n${body}` : marker
}

/**
 * Dependency names declared by the project manifest, used by the CONTEXT post-check to
 * tell "this bullet is about an external library" from "this bullet is about our source".
 * A missing or malformed package.json yields none, which makes the post-check a no-op
 * rather than an error — a non-node project must still be able to run research.
 */
async function manifestDependencyNames(cwd: string): Promise<string[]> {
    try {
        const raw = await readFile(resolve(cwd, 'package.json'), 'utf8')
        const pkg = JSON.parse(raw) as {
            dependencies?: Record<string, string>
            devDependencies?: Record<string, string>
        }
        return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]
    } catch {
        return []
    }
}

/**
 * The body written for a research section the worker confirmed has no entries.
 *
 * Three states have to stay distinguishable to anyone — human or later phase —
 * reading a research section, so each carries its own marker:
 *   `(none — …)`     the worker RAN and answered "nothing applies" (this)
 *   `(degraded: …)`  the worker was killed mid-answer, text may be partial
 *                    (degradedSectionBody)
 *   section absent   the worker never got that far — the phase threw
 *
 * Naming the worker inside the marker keeps it true after assembly, where the
 * section headings are all that separate the four workers' output.
 */
export function emptySectionBody(name: string): string {
    return `(none — the ${name} worker ran and reported no entries for this task)`
}

/**
 * A worker answer that IS the word "nothing" and carries no other content:
 * `(none)`, `N/A`, `- none`, `(no content)`, `(no entries)`. Live workers write
 * these often on a task that touches nothing (measured on the issue's prompt:
 * `(no content)`, `(no response)`, a bare `(none)` from the gate's own retry),
 * and each one means exactly what an empty answer means — so they are recorded
 * with the same marker rather than passed through in whatever shape the model
 * happened to pick. Deliberately NARROW: it matches only a lone token, never
 * prose like "(no APIs to list — this task creates a plain HTML file …)", which
 * carries a reason worth keeping.
 */
const BARE_NONE_ANSWER =
    /^[-*\s]*\(?\s*(?:none|n\/?a|nothing|no (?:content|entries|response|items|results))\s*\.?\s*\)?\s*$/i

export function isBareNoneAnswer(text: string): boolean {
    return BARE_NONE_ANSWER.test(text.trim())
}

/**
 * Prepended on the ONE retry the empty-section gate triggers. A zero-byte answer is
 * ambiguous — a crashed worker looks exactly like a worker with nothing to say — so
 * the retry's only job is to remove the ambiguity: answer properly, or say "(none)"
 * in as many words.
 *
 * It must NOT turn into an invitation to skip the work: `(none)` is offered only
 * behind an explicit "after you have looked" condition, because this retry also
 * fires on a normal project where the first attempt died for an unrelated reason,
 * and an easy opt-out there would silence real research.
 *
 * MEASUREMENT OPEN. The recovery path's QUALITY on a real repo is being measured
 * (scripts live under /home/edgars/tmp/issue10: first FILES answer faulted to
 * empty, every other child live, against an uninterrupted control). First rep on
 * an earlier wording did NOT take the `(none)` exit but drifted into writing code
 * instead of listing paths — the deliverable-not-inputs failure the base prompt
 * already forbids below this preamble. Blast radius is bounded: the gate fires
 * only on a run that would otherwise have FAILED outright, so a mediocre recovered
 * section is strictly better than the dead task it replaces — but if the drift
 * reproduces, this preamble must restate the section's output contract, not just
 * demand an answer.
 */
const EMPTY_SECTION_PREAMBLE =
    'STOP. Your previous attempt returned an EMPTY answer — zero characters. An empty '
    + 'response cannot be accepted, because it is indistinguishable from a worker that '
    + 'crashed before it wrote anything. Answer again now, and do the research properly '
    + 'this time: look first, then write what you found, in the required format. Only if '
    + 'you have looked and there is genuinely nothing to report — the task touches no '
    + 'existing file, needs no external symbol, or the project has no such tooling — write '
    + 'exactly `(none)` and nothing else. Do not answer `(none)` to avoid the work, and '
    + 'never answer with silence.'

/**
 * Prepended to worker:apis's prompt on the ONE retry the zero-retrieval gate triggers. It
 * names the exact failure (a section written with no retrieval) so the correction is concrete,
 * and bounds the retrieval to the symbols about to be listed — a broad "read everything" here
 * would trade the memory-written section for the 37-read near-runaway at phases.ts's read tail.
 */
const APIS_ZERO_RETRIEVAL_PREAMBLE =
    'STOP. Your previous attempt at this task wrote a complete APIS section without calling a '
    + 'single retrieval tool — so every signature, type, and command in it was recalled from '
    + 'memory, unverified, and must not be trusted. This time you MUST verify before you write: '
    + 'call `pi-worker-docs` for each third-party package and each project symbol you are about '
    + 'to list (or `read`/`grep` the project source for project symbols), and write each entry '
    + 'from what the tool actually returned, not from memory. Look up only the symbols you will '
    + 'list — no more, no less; do not read the whole tree.'

/**
 * Prepended to worker:context's prompt on the ONE retry the silent-retry gate triggers. The
 * previous attempt produced ZERO bullets — STEP 0 (context-silence.ts) showed every such rep
 * across 48 live reps was a genuine loss (a loop-degrade or a hallucinated non-bullet
 * fragment), never a legitimate empty answer, because the same tree reliably yields 11–21
 * bullets. So this names that failure and steers away from the two shapes that caused it:
 * the repeated-grep thrash that trips the loop-killer, and emitting anything that is not a
 * bullet. It does NOT loosen the sourced-bullet invariant — it explicitly repeats that
 * external-API semantics stay open questions unless quoted.
 */
const CONTEXT_SILENT_RETRY_PREAMBLE =
    'STOP. Your previous attempt at this task produced ZERO usable bullets — either it thrashed '
    + 'the same search until it was killed, or it emitted text that was not a bullet list. That is '
    + 'a dropped section, not an empty one: this repository has architecture worth surfacing. This '
    + 'time, read a few key files (package.json, the entry point, the directory the task names), do '
    + 'NOT repeat an identical grep — if a search returns nothing, move on rather than retrying it, '
    + 'and once you have read enough, WRITE the bullet list and stop. Output ONLY `- <bullet>` lines, '
    + 'nothing else. Keep the same rules as before: state an external library/API behaviour as fact '
    + 'ONLY when quoting an EXTERNAL CONTEXT block; otherwise write it as an "unverified:" open '
    + 'question. One claim per bullet. Better to emit three sharp sourced bullets than to say nothing.'

export async function phaseResearch(
    deps: PhaseDeps,
    refined: string,
    researchDeps: PhaseResearchDeps = {}
): Promise<string> {
    const fileInventoryFn = researchDeps.getFileInventory ?? getFileInventory
    const externalContext = await gatherExternalContext(refined, deps, researchDeps)

    // Pre-compute the project file inventory once and hand it to every worker.
    // Workers can then jump straight to targeted read/grep on known paths
    // instead of each spawning its own discovery loop (find/ls). A '' result
    // (non-git repo, git missing, abort) silently falls back to the original
    // behavior.
    const inventoryRaw = await fileInventoryFn(deps.cwd, deps.signal).catch(() => '')
    const inventoryHeader =
        inventoryRaw.length > 0 ? `PROJECT FILE INVENTORY\n${inventoryRaw}\n\n` : ''

    // Pre-read the project's orientation core (manifest, config, domain types,
    // schema, entrypoints, API surface) ONCE and hand the full contents to the
    // READ-HEAVY workers in their header. The workers run as separate child
    // processes, so without this each one that explores re-reads the same hot
    // files cold. Bounded by a hard byte budget so it can't overflow on a large
    // repo; purely additive (nothing is blocked) so it can only remove a
    // redundant read, never hide a file.
    //
    // Applied to FILES and APIS only — NOT CONTEXT/TOOLING. Verified with a live
    // A/B on the local model (real pi, real repo): FILES and APIS are bimodal —
    // they sometimes answer from the inventory but sometimes spiral into heavy
    // reads (APIS hit 37 reads / 221s, a near-runaway), and pre-supplying the core
    // collapses that to 0 reads / ~3.5s with the model honoring "do not re-read"
    // (0 core re-reads in every ON run). CONTEXT works from inventory+grep and
    // reads ~0 files regardless, so the block was pure prefill and made it slower
    // in 5/5 reps; TOOLING is already scoped + single-read-guarded and saw no
    // benefit. So orientation only goes where reads actually happen.
    const orientationPaths =
        getConfig().orientation && inventoryRaw.length > 0 ?
            inventoryRaw.split('\n').filter(l => l.trim().length > 0)
        :   []
    const orientation = await buildOrientation(orientationPaths, async path => {
        try {
            return await readFile(resolve(deps.cwd, path), 'utf8')
        } catch {
            return null
        }
    }).catch(() => ({block: '', supplied: new Set<string>()}))
    if (orientation.supplied.size > 0) {
        deps.logDebug?.(`orientation: pre-supplied ${orientation.supplied.size} core files`)
    }

    const promptHeader = externalContext + inventoryHeader

    // Braces for the CONTEXT worker's LIVE-DATA RULE (the belt is the prompt itself).
    // Judged against the EXTERNAL CONTEXT this run actually gathered — the same string
    // the worker is handed below — and the manifest's dependency names.
    const manifestPackages = await manifestDependencyNames(deps.cwd)

    // PROMPT 4's spec-cited-URL lever is NOT WIRED HERE. It is built and unit-tested in
    // ./spec-urls.ts and its live A/B FAILED: baseline 2/20 vs treatment 3/20, Fisher
    // one-tailed p = 0.50, over two fixtures, with delivery into this very prompt proven
    // separately (scripts/spec-url-prompt-delivery-check.ts). Shipping it anyway would put
    // ~1000 characters of prefill into every APIS prompt for no measured benefit, which is
    // the pattern nexxtasks exists to prevent. To re-run the experiment, restore the block
    // this comment replaces — see the git history of this file and the PROMPT 4 entry in
    // nexxtasks.txt RESULTS.

    // nexttask 5B fan-out bounds. All four read their env ONCE per research
    // phase, so every worker in a run sees the same policy and a harness cannot
    // half-apply an arm. CAP, SCALE and carry-forward are null/false in the
    // shipped configuration; the progress deadline shipped ON (nexttask 9).
    const fanoutBudget = projectDocsBudget()
    const fanoutTimeout = fanoutTimeoutPolicy()
    const carryForward = workerCarryForward()
    const progressCeilingMs = workerProgressCeilingMs()
    // Which deadline policy was in force is a fact about how every number below
    // was produced. Run 18's 120 discarded minutes were only recoverable because
    // 5A started writing down what the workers actually did; a run whose logs do
    // not say which policy it ran under cannot be compared with one that does.
    deps.logDebug?.(
        progressCeilingMs === null ?
            'phase:research: worker deadline = fixed elapsed cap (progress deadline DISABLED)'
        :   `phase:research: worker deadline = no-progress, ceiling ${progressCeilingMs}ms`
    )

    let doneCount = 0
    const updateProgress = (): void => {
        doneCount++
        if (deps.onChildOutput) {
            deps.onChildOutput(`research (${doneCount}/${workerSpecs.length} workers done)`)
        }
    }

    // Per-worker timing split into wait (spawn → first byte) and work (first
    // byte → exit). With the default serial execution each split is a clean
    // per-worker measurement — waitMs the worker's own cold-start, workMs its
    // generation+tool-call cost. Under the opt-in parallel mode the numbers are
    // wall-clock-relative (queueing shows up in waitMs).
    //
    // Restarted attempts get their OWN row. Without one the widget contradicts
    // itself: mx5 run 18 printed `workers 722.2s` over a longest member reading
    // `worker:apis work 239.3s`, because wait/work describe the final attempt
    // while the phase clock counts all three. The discarded time is the whole
    // gap, so naming it is what closes the widget.
    const recordWorker = <
        T extends {waitMs: number; workMs: number; attempts: number; totalWallMs: number}
    >(
        label: string,
        p: Promise<T>
    ): Promise<T> =>
        p.then(r => {
            deps.recordSubStep?.(`${label} wait`, r.waitMs)
            deps.recordSubStep?.(`${label} work`, r.workMs)
            if (r.attempts > 1) {
                deps.recordSubStep?.(
                    `${label} discarded (${r.attempts - 1} restart${r.attempts > 2 ? 's' : ''})`,
                    Math.max(0, r.totalWallMs - r.waitMs - r.workMs)
                )
            }
            return r
        })

    // Run the four workers ONE AT A TIME. Settled by an A/B on the local
    // llama.cpp backend (single GPU, same task/model) — and the answer flips
    // with thinking:
    //   - thinking ON → parallel wins: long decodes batch well, 4 concurrent
    //     finish in ~max(worker), not the sum.
    //   - /no_think   → sequential wins: with short decodes the batching upside
    //     is gone, but 4 concurrent streams still split the one GPU and slow
    //     each other ~4x (context worker measured 27s solo vs 128s under load),
    //     so summed-but-fast (~100s) beats max-of-slowed (~130s).
    // Every worker runs /no_think (below), so sequential is the faster regime.
    // Do NOT switch the DEFAULT back to concurrent without re-running that A/B;
    // the opt-in `parallelResearchWorkers` config flag exists for backends that
    // genuinely serve parallel streams.
    //
    // `/no_think` is the big win: these are agentic exploration loops, and on a
    // reasoning model the child would otherwise emit a full <think> trace at
    // every tool step ("let me read X next…") — the single largest decode sink
    // in the pipeline. Stripping it cut each worker's decode 3-8x in the A/B.
    // The worker still calls as many tools as it wants; it just stops narrating
    // between them. See appendNoThink. Result order (files, apis, context,
    // tooling) is preserved for assembly.
    const workerSpecs: Array<{
        /** Section heading this worker's output is assembled under. */
        section: string
        label: string
        /** Static, or built from the sections completed so far (serial mode
         *  hands APIS the finished FILES map; parallel mode hands it nothing). */
        prompt: string | ((prior: ReadonlyArray<{name: string; text: string}>) => string)
        tools?: string
        extensions?: string[]
        /** Deterministic gate over the worker's own output, run BEFORE the section is
         *  persisted, so nothing it rejects survives into the cache or into compose. */
        postProcess?: (text: string) => string
        /** When set, a non-empty section produced with ZERO grounding-retrieval calls
         *  (groundingRetrievalCount === 0 — see isGroundingRetrieval) is re-run ONCE
         *  with this preamble prepended, forcing a retrieval-first pass. The retry
         *  replaces the original only if it actually retrieved; otherwise the original
         *  is kept (no regression, entry count preserved). Deterministic handle: a
         *  section built on zero retrieval is ungrounded by construction, no semantic
         *  judgement needed. */
        zeroRetrievalRetry?: string
        /** When set, a section that comes out SILENT — zero parseable bullets from a
         *  loop-degrade banner or a hallucinated non-bullet fragment (classifyContextSilence
         *  → genuineLoss) — is re-run ONCE with this preamble prepended. The retry replaces
         *  the original only if it produces bullets; otherwise the original is kept. A
         *  legitimately-empty section (honest "nothing to surface") is NOT retried. STEP 0
         *  established every silent worker:context rep was a genuine loss, not an empty
         *  answer (context-silence.ts). */
        retryIfSilent?: string
        /** This worker can issue project-source docs lookups, so the 5B fan-out
         *  bounds apply to it (see task/research-fanout-budget.ts). */
        fanoutBounded?: true
    }> = [
        {
            section: 'FILES',
            label: 'worker:files',
            // Read-heavy: gets the orientation core (see note above).
            prompt: appendNoThink(orientation.block + promptHeader + RESEARCH_FILES_PROMPT(refined))
        },
        {
            section: 'APIS',
            label: 'worker:apis',
            // Read-heavy: gets the orientation core (see note above). Search/fetch
            // ride along only when a Brave key exists — see SEARCH_EXTENSION_PATH.
            // FILES' finished map rides along when available (serial default), so
            // the worker doesn't re-derive where-things-live via docs-"."
            // queries the FILES worker just answered (run-7 F7: up to 10
            // duplicate `.`-decodes per task through the serial bottleneck).
            prompt: prior =>
                appendNoThink(
                    orientation.block
                        + promptHeader
                        + RESEARCH_APIS_PROMPT(
                            refined,
                            prior.find(s => s.name === 'FILES')?.text || undefined
                        )
                        + (searchConfigured() ? RESEARCH_SEARCH_HINT : '')
                        // 5B CAP arm — empty unless PI_TASK_PROJECT_DOCS_BUDGET is
                        // set. The tool-side half lives in pi-worker-docs.ts; a
                        // budget enforced without being announced would just read
                        // to the worker as a broken tool.
                        + (fanoutBudget === null ? '' : projectDocsBudgetNotice(fanoutBudget))
                ),
            tools:
                'read,grep,find,ls,pi-worker-docs'
                + (searchConfigured() ? ',pi-worker-search,pi-worker-fetch' : ''),
            fanoutBounded: true,
            extensions: [
                DOCS_EXTENSION_PATH,
                ...(searchConfigured() ? [SEARCH_EXTENSION_PATH] : [])
            ],
            // ZERO-RETRIEVAL GATE (mx5 run-15 F-1, distinct from the STAGE 1-3 stopping-point
            // thread). In a MINORITY of reps worker:apis emits a complete, plausible APIS section
            // having made ZERO retrieval tool calls — the whole thing recalled from memory.
            // The output contract at RESEARCH_APIS_PROMPT already INSTRUCTS tool use and the
            // worker skips it anyway (STAGE 2 proved a prompt line does not move grounding), so
            // this is a deterministic gate, not another instruction: groundingRetrievalCount === 0
            // on a non-empty section is ungrounded BY CONSTRUCTION — no semantic judgement, the
            // exact checkable handle STAGE 3's prose-clause gate lacked. The forced-retrieval
            // retry recovers a grounded section rather than silencing the worker (entry count
            // preserved). It bounds itself ("look up the symbols you will list — no more") away
            // from the near-runaway 37-read tail.
            //
            // EFFICACY NOT DEMONSTRATED — read before trusting this to matter. The live A/B
            // (scripts/live-apis-zero-retrieval-ab.ts) ABSTAINED, underpowered: the failure is
            // RARE and intermittent (base rate 0/40 one session, pooled ~5%), so the primary
            // reduction (baseline 1/40 zero-retrieval ships -> treatment 0/40) did NOT reach
            // significance (Fisher p = 0.50 — needs ~5 baseline ships, ~85 reps at ~6%). What IS
            // established: the gate is correct BY CONSTRUCTION; on the 3 firings observed it
            // recovered a grounded section every time; and it did NO harm (ungrounded-symbol rate
            // went DOWN not up, no entry collapse, no runaway, cost +4-6%). It is wired as a
            // harmless safety net, NOT a proven-effective lever — do not cite it as a measured win
            // (nexxtasks.txt "ZERO-RETRIEVAL GATE ... ABSTAIN"). A powered A/B is STILL OPEN.
            zeroRetrievalRetry: APIS_ZERO_RETRIEVAL_PREAMBLE
        },
        {
            section: 'CONTEXT',
            label: 'worker:context',
            prompt: appendNoThink(promptHeader + RESEARCH_CONTEXT_PROMPT(refined)),
            // Context owns architectural understanding, not path discovery —
            // FILES handles that. Dropping `find`/`ls` keeps the worker from
            // spawning long enumeration loops whose output then inflates
            // prefill on every subsequent round.
            //
            // RECORDED DECISION (mx5 run-15 F-1, PROMPT 1 item 4): this worker stays
            // ISOLATED — it is NOT given the APIS worker's output. It keeps `read,grep`
            // and is forbidden, by prompt and by the post-check below, from asserting
            // external-API behaviour it cannot see. Handing it the APIS section would
            // widen what it may assert without making any of it checkable here, and
            // APIS' own answers are the ones F-2 shows are type-only and unverified.
            tools: 'read,grep',
            // SILENT-RETRY GATE. STEP 0 measured this worker silent (zero bullets) in ~10%
            // of live reps (5/48, Wilson95 [4.5%, 22.2%]) and classified EVERY silent rep as
            // a genuine loss — a loop-degrade banner (60%) or a hallucinated non-bullet
            // fragment (40%) — never a legitimate empty answer, because the identical fixture
            // reliably yields 11–21 bullets. A silent section is therefore a dropped section;
            // retry once, keep the retry only if it emits bullets. See context-silence.ts.
            retryIfSilent: CONTEXT_SILENT_RETRY_PREAMBLE,
            // BRACES for the LIVE-DATA RULE. In run 15 this worker wrote, verbatim, "The
            // `hono` dependency is pinned at `^4.12.31` in package.json, and the external
            // context confirms `hc<AppType>` pattern with base URL `/api` ... works
            // correctly (per Hono RPC docs LIVE data)". It has read+grep only, so the
            // base-URL half came from memory; fused with the true version half under one
            // attribution it read as sourced, became a hard requirement in TASK_0027's
            // CONSTRAINTS and ACCEPTANCE, and every request went to /api/api/... ⇒ 404.
            // A flagged bullet is demoted to an OPEN QUESTION here — before the section is
            // persisted — so it cannot reach compose as fact. Demotion, not deletion: the
            // bullet count is preserved, because a silenced worker is a different
            // regression.
            postProcess: text => {
                const r = demoteUnsourcedAttributions(text, externalContext, manifestPackages)
                for (const f of r.demoted) {
                    deps.logDebug?.(
                        `worker:context: demoted unsourced attribution [${f.unsourced.join(',')}]`
                            + ` cue="${f.cue}" — ${f.bullet.slice(0, 160)}`
                    )
                }
                return r.text
            }
        },
        {
            section: 'TOOLING',
            label: 'worker:tooling',
            // Scope to the goal prose only — not the per-file edit checklist that
            // makes a weak model spelunk source and loop. See scopedToolingGoal.
            prompt: appendNoThink(
                promptHeader + RESEARCH_TOOLING_PROMPT(scopedToolingGoal(refined))
            ),
            // Block re-reads in-process so a weak model that wants to re-read the
            // same file is told to answer from what it has instead of looping.
            extensions: [SINGLE_READ_EXTENSION_PATH]
        }
    ]

    // Persisting a worker's section is a read-modify-write of the shared task
    // file, so writes are chained through one lock — a no-op in serial mode,
    // load-bearing in parallel mode where two workers can settle together.
    let persistChain: Promise<void> = Promise.resolve()
    const persistSection = (heading: string, text: string): Promise<void> => {
        const next = persistChain.then(() => setTaskSection(deps.cwd, deps.taskId, heading, text))
        persistChain = next.catch(() => {})
        return next
    }

    // One worker, cache-skip to persist: on a resume, a worker whose cached
    // output is already on disk is skipped — so when one worker fails and the
    // phase is re-run, the others don't burn minutes regenerating work that was
    // already good. Each worker is validated inline (not in a second pass), so
    // only trustworthy text is ever cached.
    //
    // A fatal failure (crash/empty/leak) still throws — the already-cached
    // workers survive for the resume. A runaway (loop/timeout) degrades to its
    // partial output instead, so one weak worker can't abort a whole auto-run;
    // the degraded section is cached too, so a resume doesn't re-loop it.
    const runSpec = async (
        spec: (typeof workerSpecs)[number],
        prior: ReadonlyArray<{name: string; text: string}>
    ): Promise<{name: string; text: string}> => {
        const cacheHeading = researchWorkerCacheHeading(spec.section)
        const cached = (await readSection(deps.cwd, deps.taskId, cacheHeading)) ?? ''
        if (cached.trim().length > 0) {
            deps.logDebug?.(`${spec.label}: cached — skipping re-run`)
            updateProgress()
            return {name: spec.section, text: cached.trim()}
        }

        deps.logDebug?.(`${spec.label}: start`)
        const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt
        const runOnce = (extraPreamble?: string): Promise<RunWorkerResult> =>
            recordWorker(
                spec.label,
                runWorker({
                    prompt: extraPreamble ? `${extraPreamble}\n\n${basePrompt}` : basePrompt,
                    cwd: deps.cwd,
                    signal: deps.signal,
                    spawn: deps.spawn,
                    ...(spec.tools ? {tools: spec.tools} : {}),
                    ...(spec.extensions ? {extensions: spec.extensions} : {}),
                    // 5B SCALE arm — null unless both env vars are set. Only the
                    // docs-capable worker can fan out, so only it can be scaled.
                    ...(spec.fanoutBounded && fanoutTimeout ? {fanoutTimeout} : {}),
                    // 5B RESCUE. Applies to EVERY research worker, not just the
                    // docs-capable one: any worker that gets killed loses its work
                    // the same way. carry-forward stays OFF unless asked for
                    // (measured harmful on its own); the progress deadline SHIPPED
                    // ON in nexttask 9 and is null only when explicitly disabled.
                    ...(carryForward ? {carryForward: true} : {}),
                    ...(progressCeilingMs !== null ?
                        {progressTimeoutCeilingMs: progressCeilingMs}
                    :   {}),
                    // One line per DISCARDED attempt. The `done` line below reports
                    // the final attempt only, so a worker that timed out twice at
                    // 240s and then answered used to log exactly like a clean one —
                    // 8 minutes of burned compute recoverable only by subtracting
                    // its own wait+work from the start/done timestamps.
                    onCarryForward: ci => {
                        deps.logDebug?.(
                            `${spec.label}: CARRY-FORWARD injected into attempt ${ci.attempt}`
                                + ` (${ci.chars} chars onto a ${ci.promptCharsBefore}-char prompt)`
                        )
                    },
                    onRestart: rs => {
                        deps.logDebug?.(
                            `${spec.label}: RESTART (attempt ${rs.attempt} discarded)`
                                + ` reason=${rs.reason} wall=${rs.wallMs}ms`
                                + ` wait=${rs.waitMs}ms work=${rs.workMs}ms`
                                + (rs.detail ? ` — ${rs.detail}` : '')
                        )
                        deps.onChildOutput?.(`${spec.label}: restart (${rs.reason})`)
                    },
                    onLine: line => {
                        // The one 'stream' site in this file: raw research-worker
                        // output. Every other logDebug here records a decision.
                        // onChildOutput drives the widget and is not gated.
                        deps.logDebug?.(`${spec.label}: ${line}`, 'stream')
                        deps.onChildOutput?.(`${spec.label}: ${line}`)
                    }
                })
            )
        let r = await runOnce()
        // EMPTY-SECTION GATE (issue #10). A worker that returns zero bytes on a clean run
        // used to fail the whole task ("Research APIS worker produced no output"), which is
        // exactly what an extremely simple task provokes: with nothing on disk to survey and
        // no external symbol in play, silence is the correct answer and the run died on it.
        // Retry ONCE — silence is genuinely ambiguous, and a worker that crashed before
        // writing deserves a second attempt — then accept an explicitly empty section. A
        // provider error behind the silence is classified fatal below and never reaches here.
        let confirmedEmpty = false
        if (classifyResearchWorker(spec.section, r)?.kind === 'empty') {
            deps.logDebug?.(
                `${spec.label}: EMPTY answer on a clean exit — retrying once before`
                    + ' accepting the section as having no entries'
            )
            deps.onChildOutput?.(`${spec.label}: empty — retrying`)
            const retry = await runOnce(EMPTY_SECTION_PREAMBLE)
            if (retry.text.trim().length > 0) {
                deps.logDebug?.(
                    `${spec.label}: retry answered (len=${retry.text.trim().length})`
                        + ' — replacing the empty section'
                )
                r = retry
            } else {
                confirmedEmpty = classifyResearchWorker(spec.section, retry)?.kind === 'empty'
                deps.logDebug?.(
                    `${spec.label}: retry STILL empty — `
                        + (confirmedEmpty ?
                            'the worker ran twice and reported no entries; recording the'
                            + ' section as empty (NOT a failure)'
                        :   'and this attempt did not run cleanly — failing the phase')
                )
                if (!confirmedEmpty) r = retry
            }
        }
        // ZERO-RETRIEVAL GATE — a deterministic handle, not another instruction. A non-empty
        // section produced with no grounding-retrieval call was written from memory; retry ONCE
        // with a forced retrieval-first pass and keep the retry only if it actually retrieved.
        if (
            spec.zeroRetrievalRetry
            && r.groundingRetrievalCount === 0
            && r.text.trim().length > 0
        ) {
            deps.logDebug?.(
                `${spec.label}: ZERO grounding-retrieval on a non-empty section`
                    + ' — every symbol is unverified memory; re-running once with a forced'
                    + ' retrieval-first pass'
            )
            deps.onChildOutput?.(`${spec.label}: zero-retrieval — retrying with forced retrieval`)
            const retry = await runOnce(spec.zeroRetrievalRetry)
            if (retry.groundingRetrievalCount > 0 && retry.text.trim().length > 0) {
                deps.logDebug?.(
                    `${spec.label}: retry grounded (${retry.groundingRetrievalCount} retrieval`
                        + ' calls) — replacing the memory-written section'
                )
                r = retry
            } else {
                deps.logDebug?.(
                    `${spec.label}: retry STILL zero-retrieval`
                        + ` (calls=${retry.groundingRetrievalCount}, len=${retry.text.trim().length})`
                        + ' — keeping the original (no regression, entry count preserved)'
                )
            }
        }
        // SILENT-RETRY GATE — a deterministic handle over the section body, not another
        // instruction. A section that parses to ZERO bullets from a loop-degrade banner or a
        // hallucinated non-bullet fragment (classifyContextSilence → genuineLoss) dropped
        // context that was there to surface; retry ONCE with a forced-emit preamble and keep
        // the retry only if it produces bullets. A legitimately-empty section (an honest
        // "nothing to surface") and a fatal failure are BOTH left alone — the former is not a
        // loss, the latter throws below and must stay a loud failure, not a silent retry.
        const silentBodyOf = (res: RunWorkerResult): string | null => {
            const f = classifyResearchWorker(spec.section, res)
            if (f?.kind === 'fatal') return null
            return f?.kind === 'runaway' ?
                    degradedSectionBody(spec.section, f.reason, res.text)
                :   res.text.trim()
        }
        // `confirmedEmpty` already spent a retry on exactly this ("you wrote nothing"), and
        // the worker answered "nothing applies" a second time — re-asking here would just
        // burn a third child for the same answer.
        if (spec.retryIfSilent && !confirmedEmpty) {
            const body = silentBodyOf(r)
            const verdict = body === null ? null : classifyContextSilence(body)
            if (verdict?.silent && verdict.genuineLoss) {
                deps.logDebug?.(
                    `${spec.label}: silent-retry first-silent cause=${verdict.cause}`
                        + ` — zero bullets, re-running once with a forced-emit preamble`
                )
                deps.onChildOutput?.(`${spec.label}: silent — retrying`)
                const retry = await runOnce(spec.retryIfSilent)
                const retryBody = silentBodyOf(retry)
                const retryBullets = retryBody === null ? 0 : countBullets(retryBody)
                if (retryBullets > 0) {
                    deps.logDebug?.(
                        `${spec.label}: silent-retry recovered bullets=${retryBullets}`
                            + ' — replacing the silent section'
                    )
                    r = retry
                } else {
                    deps.logDebug?.(
                        `${spec.label}: silent-retry still-silent`
                            + ` (bullets=${retryBullets}) — keeping the original`
                    )
                }
            }
        }
        deps.logDebug?.(
            `${spec.label}: done exit=${r.exitCode} wait=${r.waitMs}ms work=${r.workMs}ms`
                // attempts/total are the pair that makes wait+work honest: they are
                // the FINAL attempt's split, and only `total` sees the discarded ones.
                + ` attempts=${r.attempts} total=${r.totalWallMs}ms`
                + (r.restarts.length > 0 ?
                    ` restarts=[${r.restarts.map(x => x.reason).join(',')}]`
                :   '')
                // Attribution for the RESCUE arm: a run with zero restarts was
                // never killed (the progress deadline did it), while a run that
                // restarted and salvaged was killed but kept its work. Without
                // this the two are indistinguishable in the logs, and "0
                // timeouts" cannot be traced to the half that earned it.
                + (r.salvagedFromDiscardedAttempt ? ' salvaged=1' : '')
                + (r.stderr ? ` stderr=${r.stderr.slice(0, 300)}` : '')
                + (r.leakedToolCall ? ` leaked=${r.leakedToolCall.trim().slice(0, 80)}` : '')
        )
        updateProgress()

        const failure = classifyResearchWorker(spec.section, r)
        if (failure?.kind === 'fatal') throw failure.error
        // A worker that answers "nothing applies" is recorded the same way whether it
        // said so with zero bytes (confirmedEmpty) or with a bare "(none)"/"N/A" — the
        // two are the same answer, and only the marker makes either one distinguishable
        // from a worker that never answered at all.
        const rawText =
            failure?.kind === 'runaway' ? degradedSectionBody(spec.section, failure.reason, r.text)
            : confirmedEmpty || isBareNoneAnswer(r.text) ? emptySectionBody(spec.section)
            : r.text.trim()
        if (failure?.kind === 'runaway') {
            deps.logDebug?.(`${spec.label}: degraded — ${failure.reason}`)
        }
        if (!confirmedEmpty && isBareNoneAnswer(r.text)) {
            deps.logDebug?.(
                `${spec.label}: answered "${r.text.trim().slice(0, 40)}" — recording it as`
                    + ' an empty section (the worker ran and found nothing)'
            )
        }
        // Post-check the worker's own output before it is persisted, so the cache a
        // resume reads back is already gated. A degraded partial goes through it too —
        // a truncated section can still carry a laundered claim.
        const sectionText = spec.postProcess ? spec.postProcess(rawText) : rawText
        await persistSection(cacheHeading, sectionText)
        return {name: spec.section, text: sectionText}
    }

    const sections: Array<{name: string; text: string}> = []
    if (!getConfig().parallelResearchWorkers) {
        // Default: ONE AT A TIME (see the A/B note above the specs) — a fatal
        // failure throws before later workers run, and each worker can see the
        // finished sections before it (APIS builds on the FILES map).
        for (const spec of workerSpecs) {
            sections.push(await runSpec(spec, sections))
        }
    } else {
        // Opt-in for parallel-capable backends. allSettled (not all): every
        // worker runs to its own outcome first, so one fatal failure cannot
        // orphan the others' output — their sections persist for the resume
        // before the failure is thrown. Assembly order stays the spec order
        // regardless of completion order. No prior sections exist here, so
        // prompt builders get none (APIS runs map-less, as before this option).
        const settled = await Promise.allSettled(workerSpecs.map(spec => runSpec(spec, [])))
        for (const s of settled) {
            if (s.status === 'rejected') throw s.reason
        }
        for (const s of settled) {
            if (s.status === 'fulfilled') sections.push(s.value)
        }
    }

    // All workers succeeded — the assembled output below becomes the canonical
    // 'research' section (written by the orchestrator). The per-worker caches
    // exist only to survive a mid-phase failure, so drop them now to avoid
    // carrying every section twice in the task file.
    for (const spec of workerSpecs) {
        await removeTaskSection(deps.cwd, deps.taskId, researchWorkerCacheHeading(spec.section))
    }

    return sections.map(({name, text}) => `${name}\n${text}`).join('\n\n')
}

export interface PhaseAutoAnswerDeps {
    docsFocused?: typeof docsFocused
    fetchFocused?: typeof fetchFocused
    searchFn?: (input: SearchCoreInput) => Promise<SearchCoreResult>
}

export async function phaseAutoAnswer(
    deps: PhaseDeps,
    refined: string,
    research: string,
    question: string,
    autoDeps: PhaseAutoAnswerDeps = {}
): Promise<AutoAnswer> {
    const docsFocusedFn = autoDeps.docsFocused ?? docsFocused
    const fetchFocusedFn = autoDeps.fetchFocused ?? fetchFocused
    try {
        const enrichTargets = extractEnrichTargets(question)
        const allTargets: Array<{kind: 'pkg'; pkg: string} | {kind: 'url'; url: string}> = [
            ...enrichTargets.packages.slice(0, 2).map(pkg => ({kind: 'pkg' as const, pkg})),
            ...enrichTargets.urls
                .slice(0, 2 - Math.min(enrichTargets.packages.length, 2))
                .map(url => ({kind: 'url' as const, url}))
        ]
        const cappedTargets = allTargets.slice(0, 2)

        const npmSections: string[] = []
        const docSections: string[] = []

        const searchFn = autoDeps.searchFn ?? defaultSearch
        const cappedServices = enrichTargets.services.slice(0, 2)

        // Fan out doc/url focused workers and service searches in parallel —
        // otherwise the user waits for max(docs, fetch) + search instead of
        // max(docs, fetch, search) on every grill auto-answer with at least
        // one service plus a package or url. Mirrors phaseResearch's pattern.
        const [, serviceResults] = await Promise.all([
            Promise.all(
                cappedTargets.map(async (t, idx) => {
                    if (t.kind === 'pkg') {
                        const r = await docsFocusedFn({
                            pkg: t.pkg,
                            query: question,
                            cwd: deps.cwd,
                            signal: deps.signal
                        }).catch(() => null)
                        if (r?.npmVersion) {
                            npmSections[idx] = formatNpmVersionSection(r.npmVersion)
                        }
                        if (r?.answer) {
                            docSections[idx] = `### docs: ${t.pkg}\n${r.answer}`
                        }
                    } else {
                        const r = await fetchFocusedFn({
                            url: t.url,
                            query: question,
                            cwd: deps.cwd,
                            signal: deps.signal
                        }).catch(() => null)
                        if (r?.answer) {
                            docSections[idx] = `### url: ${t.url}\n${r.answer}`
                        }
                    }
                })
            ),
            Promise.all(
                cappedServices.map(s =>
                    searchFn({
                        query: `${s.name} ${s.query}`,
                        count: 3,
                        signal: deps.signal
                    }).catch(() => null)
                )
            )
        ])

        const serviceSections: string[] = []
        const skipped: string[] = []
        for (let i = 0; i < cappedServices.length; i++) {
            const s = cappedServices[i]
            const r = serviceResults[i]
            if (r === null) continue
            if (r.kind === 'no_key') {
                skipped.push(s.name)
                continue
            }
            if (r.kind === 'error') continue
            serviceSections.push(formatServiceBlock(s.name, `${s.name} ${s.query}`, r.results))
        }
        if (skipped.length > 0) {
            serviceSections.push(formatFreshnessSkippedBlock(skipped))
        }

        // npm blocks lead so the model anchors on live version data first.
        const contextSections = [
            ...npmSections.filter(Boolean),
            ...docSections.filter(Boolean),
            ...serviceSections
        ]

        const externalContext =
            contextSections.length > 0 ?
                `EXTERNAL CONTEXT\n${contextSections.join('\n\n')}\n\n`
            :   ''

        const basePrompt = externalContext + GRILL_AUTO_ANSWER_PROMPT(refined, research, question)
        let text = await runPhaseChild(deps, 'grill-auto', 'read', basePrompt)
        if (!autoAnswerHasTag(text)) {
            // The model ignored the ANSWER/UNKNOWN/ALT format and wrote prose
            // (typically an "analysis" preamble). Reprompt once, forcing the
            // tagged form, before falling back to parseAutoAnswer's salvage —
            // otherwise a preamble line leaks out as the recommended answer.
            text = await runPhaseChild(
                deps,
                'grill-auto',
                'read',
                prependHint(GRILL_AUTO_FORMAT_HINT, basePrompt)
            )
        }
        let parsed = parseAutoAnswer(text)

        // Anti-synthesis guard (mx5 run 13, Bug A): the auto-answer invented
        // `Bun.mkdirSync` while research's APIS section carried the correct list,
        // and the invention was promoted into requirements + VERIFY. Deterministic
        // verbatim-substring check: an API-shaped identifier in the answer that is
        // absent from the research AND the question, in a namespace the research
        // claims to cover, triggers ONE re-ask with the verified research lines
        // injected. Still synthesizing after the re-ask ⇒ surface to the user as a
        // recommendation instead of silently promoting it (costs time, never work).
        if (parsed.kind === 'answered') {
            const synth = findSynthesizedApis(parsed.text, question, research)
            if (synth.length > 0) {
                deps.logDebug?.(
                    'grill-auto: unverified API identifier(s) in answer — '
                        + synth.map(f => f.identifier).join(', ')
                        + ' — re-asking with the research API list injected'
                )
                let reasked: AutoAnswer | null = null
                try {
                    const text2 = await runPhaseChild(
                        deps,
                        'grill-auto',
                        'read',
                        prependHint(synthesizedApiReaskHint(synth, research), basePrompt)
                    )
                    if (autoAnswerHasTag(text2)) reasked = parseAutoAnswer(text2)
                } catch {
                    reasked = null
                }
                if (
                    reasked === null
                    || (reasked.kind === 'answered'
                        && findSynthesizedApis(reasked.text, question, research).length > 0)
                ) {
                    const still = reasked ?? parsed
                    const suggested = still.kind === 'answered' ? still.text : parsed.text
                    deps.logDebug?.(
                        'grill-auto: answer still carries an unverified API — surfacing to user'
                    )
                    parsed = {
                        kind: 'unknown',
                        suggested,
                        raw: still.raw,
                        // Tagged so a call site can tell this producer from the other
                        // two: the suggestion is PROVEN to name an unverified API, so
                        // it may only be judged by a human (yolo.ts must not take it).
                        reason: 'api-synthesis'
                    }
                } else {
                    parsed = reasked
                }
            }
        }

        // Surviving-unknown routing: an integration / build-wiring unknown whose
        // wrong guess is a structural landmine must NOT be silently auto-answered.
        // We first try to ground it from fetched docs (the enrichment fan-out
        // above); only when NO doc/fetch worker produced a grounding section do we
        // refuse the guess and surface it to the user — carrying the model's
        // best-effort answer as the pre-filled recommendation so the user accepts
        // it with one keystroke or overrides it. Benign unknowns are untouched.
        const docResolved = docSections.filter(Boolean).length > 0
        if (parsed.kind === 'answered' && !docResolved && isIntegrationUnknown(question)) {
            deps.logDebug?.(
                `grill-auto: integration unknown unresolved by fetch — surfacing to user `
                    + `instead of auto-answering: ${question.replace(/\s+/g, ' ').slice(0, 120)}`
            )
            return {kind: 'unknown', suggested: parsed.text, raw: parsed.raw, reason: 'integration'}
        }
        return parsed
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {kind: 'unknown', raw: `(threw: ${msg})`, reason: 'threw'}
    }
}

export async function phaseGrill(
    deps: PhaseDeps,
    ctx: ExtensionCommandContext,
    widgetState: WidgetState,
    refined: string,
    research: string
): Promise<string> {
    // Sequential & adaptive: ask one question at a time, feeding every answer
    // back into the next grill-gen call so later questions react to earlier ones
    // (drop resolved unknowns, surface forks an answer introduced). Each question
    // still gets a research-backed auto-answer — answered cheaply (skip the user)
    // or surfaced as a pre-filled recommendation. The model emits NONE when
    // nothing ambiguous remains. Kept in sync with /task-auto's clarify dialog.
    const theme = ctx.ui.theme
    const ui = new SessionUI(ctx)
    const out: string[] = [] // human-facing Q&A transcript (with auto-worker debug lines)
    const qa: string[] = [] // compact Q&A fed back into the next question
    const askedQuestions: string[] = [] // plain text of each question, for the dup backstop
    // Deterministic backstop against a model that ignores "never re-ask": a
    // near-duplicate question is reprompted (not auto-answered or shown), and after
    // MAX_DUP_STRIKES consecutive dups the loop stops. Each question otherwise runs
    // the research-backed auto-answer, which fans out doc/fetch/search workers — so
    // a re-ask isn't just an extra prompt, it's an expensive recompute. Capped at
    // MAX_GRILL_QUESTIONS so a model that never emits NONE can't run unbounded.
    let dupStrikes = 0
    let dupHint: string | null = null
    // Open-ended: keep asking until the model emits NONE or the user dismisses.
    for (let n = 0; n < MAX_GRILL_QUESTIONS; n++) {
        const tGenStart = Date.now()
        const genHint = dupHint
        const raw = await runPhaseWithLoopGuard(deps, 'grill-gen', 'read', hint =>
            prependHint(
                hint,
                prependHint(genHint, GRILL_GEN_PROMPT(refined, research, qa.join('\n')))
            )
        )
        deps.recordSubStep?.('gen', Date.now() - tGenStart)
        const questions = parseGrillQuestions(raw)
        if (questions.length === 0) break // NONE / nothing left to ask
        const q = questions[0]
        // Suppress a re-asked decision before paying for its auto-answer.
        if (isDuplicateQuestion(askedQuestions, stripInlineMarkdown(q))) {
            dupStrikes++
            if (dupStrikes >= MAX_DUP_STRIKES) break
            dupHint = DUP_REPROMPT_HINT
            n--
            continue
        }
        dupStrikes = 0
        dupHint = null
        askedQuestions.push(stripInlineMarkdown(q))

        widgetState.lastLine = `auto-answering Q${n + 1}…`
        const tAutoStart = Date.now()
        const auto = await phaseAutoAnswer(deps, refined, research, q)
        deps.recordSubStep?.('auto-answer', Date.now() - tAutoStart)

        // Render markdown (bold/code) for the displayed prompt; keep plain text
        // for the editable default and the persisted file.
        const shownQ = renderInlineMarkdown(q, theme)
        const plainQ = stripInlineMarkdown(q)
        out.push(`Q${n + 1}: ${plainQ}`)

        let answer: string
        if (auto.kind === 'answered') {
            answer = stripInlineMarkdown(auto.text)
            out.push(`A${n + 1}: ${answer} (auto)`)
        } else {
            const plainSuggested =
                auto.suggested === undefined ? undefined : stripInlineMarkdown(auto.suggested)
            const plainAlt = auto.alt === undefined ? undefined : stripInlineMarkdown(auto.alt)
            // A recommendation (or suggested+alt fork) becomes the boxed picker
            // locally — each answer in its own bounding box, the recommended one
            // tinted green; an open question shows the bare text prompt.
            const twoOption = plainSuggested !== undefined && plainAlt !== undefined
            // YOLO: take the recommended option and never build the prompt (which
            // is also what suppresses its notification — see yolo.ts). An answer the
            // anti-synthesis guard demoted, or a question with no recommendation at
            // all, is SKIPPED instead: costing the spec one unanswered fork is the
            // guard direction, promoting a hallucination is not.
            const yolo = yoloPickAutoAnswer(isYoloMode(), auto)
            if (yolo !== null) {
                answer =
                    yolo.kind === 'answer' ?
                        stripInlineMarkdown(yolo.answer)
                    :   `(skipped — ${yolo.note})`
                out.push(`A${n + 1}: ${answer} ${YOLO_STAMP}`)
                qa.push(`Q${n + 1}: ${plainQ}\nA${n + 1}: ${answer} ${YOLO_STAMP}`)
                continue
            }
            const options =
                twoOption ?
                    [
                        {
                            label: `A: ${renderInlineMarkdown(auto.suggested!, theme)}`,
                            value: plainSuggested!
                        },
                        {label: `B: ${renderInlineMarkdown(auto.alt!, theme)}`, value: plainAlt!}
                    ]
                : plainSuggested !== undefined ?
                    [{label: renderInlineMarkdown(auto.suggested!, theme), value: plainSuggested}]
                :   undefined
            widgetState.lastLine = `awaiting Q${n + 1}`
            const a = await ui.ask({
                localTitle: shownQ,
                displayQuestion: shownQ,
                question: plainQ,
                recommended: plainSuggested,
                recommended2: plainAlt,
                allowSkip: plainSuggested === undefined && plainAlt === undefined,
                ...(options && {options})
            })
            if (a === undefined) throw new Error(USER_CANCELLED)
            const typed = a.trim()
            // The local picker resolves to the chosen option's full value, but a
            // remote user (or the picker's free-text fallback) may still type a
            // bare "A"/"B" — map those back to the option's full text, since
            // storing the literal letter leaves the next grill-gen call a
            // dangling reference it can't decode.
            if (typed.length === 0 && plainSuggested) {
                answer = plainSuggested
            } else if (typed.length === 0) {
                answer = '(skipped)'
            } else if (twoOption && /^a[.)]?$/i.test(typed)) {
                answer = plainSuggested!
            } else if (twoOption && /^b[.)]?$/i.test(typed)) {
                answer = plainAlt!
            } else {
                answer = typed
            }
            out.push(`A${n + 1}: ${answer}`)
        }
        qa.push(`Q${n + 1}: ${plainQ}\nA${n + 1}: ${answer}`)
    }
    if (out.length === 0) return '(no questions produced)'
    return out.join('\n')
}

/**
 * A refutation is a DELETION. Where the run's own research explicitly says a
 * dependency refine invented is not needed, drop that token from CONSTRAINTS —
 * compose cannot forbid the design's own API "because the refined task
 * explicitly requires `argon2`" if the refined task no longer requires it.
 *
 * Applied to the REFINED TASK ITSELF, not to compose's copy of it, and that is
 * load-bearing: critique receives the refined task as GROUND TRUTH and is told
 * its CONSTRAINTS "MUST be preserved in spirit — do not silently drop or weaken
 * them", so a deletion visible only to compose is restored one phase later. Both
 * spec-producing phases have to see the same text.
 *
 * Purely subtractive and never touches an owned line (task/refuted-constraint.ts).
 * Idempotent, so a resumed run re-deriving `refined` from the task file lands in
 * the same place. The task file's `## refined prompt` is deliberately left as
 * refine wrote it; the drop is recorded on the `## gates` trail with both source
 * lines quoted, so the decision stays auditable after the fact.
 *
 * STEP 0 `scripts/refuted-constraint-baserate.ts`; A/B-1 `…-ab.ts` (PASS).
 */
export async function dropRefutedConstraints(
    deps: PhaseDeps,
    refined: string,
    research: string
): Promise<string> {
    const refuted = applyRefutations(refined, research)
    if (refuted.trail.length === 0) return refined
    for (const line of refuted.trail) {
        deps.logDebug?.(`compose: ${line}`)
        await appendGateRecord(deps.cwd, deps.taskId, line).catch(() => {})
    }
    return refuted.refined
}

export async function phaseCompose(
    deps: PhaseDeps,
    refined: string,
    research: string,
    qa: string
): Promise<string> {
    // CLAIM before the belt is built: an obligation an earlier task had to
    // detach (its own spec froze the only file that could satisfy it) becomes
    // this task's own when this task is the one that writes that file.
    await claimOwnedFreezeForThisTask(deps, refined).catch(() => {})
    const contracts = await phaseCarriedBlocks(deps)
    return runWithEmphasisRetry(
        deps,
        'compose',
        'read',
        problem => COMPOSE_PROMPT(refined, research, qa, problem, contracts),
        text => {
            // Trim any "here's the spec:" preamble before validating, so a
            // strippable lead-in doesn't burn a full retry — and the stored
            // value starts at GOAL.
            const stripped = stripSpecPreamble(text)
            const problem = validateSpecShape(stripped)
            if (problem) return {ok: false, problem}
            // validateSpecShape only checks the VERIFY *header* exists. The
            // critique gate and the handoff gate both require a *runnable*
            // fenced block (parseVerifyBlock). Enforce the same bar here so a
            // draft ending in a bare `VERIFY:` retries with emphasis now,
            // instead of passing compose and being rejected downstream — which
            // otherwise leaves a persisted VERIFY-less spec that resume can't
            // heal.
            if (parseVerifyBlock(stripped) === null) {
                return {ok: false, problem: 'VERIFY block has no runnable ```bash fenced commands'}
            }
            return {ok: true, value: stripped}
        },
        problem => new Error(`compose_invalid: ${problem}`)
    )
}

export async function phaseCritique(
    deps: PhaseDeps,
    spec: string,
    refined: string,
    qa: string,
    planContext?: string,
    research?: string,
    /**
     * An additional deterministic defect block, forced into the rewrite exactly
     * like the probes below and overriding a CLEAN triage the same way.
     *
     * This is the A/B seam for a probe that is not wired yet: the discipline
     * here is "wire only on PASS" (memory/prompt4-spec-urls-failed.md), so a
     * candidate probe has to be measurable through the SHIPPED critique path
     * rather than through a hand-copied replica of it, or the two arms differ by
     * more than the probe. Undefined in production.
     */
    extraDefects?: string | null
): Promise<string> {
    // Fast triage before the expensive full rewrite. The rewrite regenerates
    // the entire spec from scratch and is the costliest tail of the pipeline
    // (observed up to ~240s). Most compose drafts are already good, so we first
    // ask a cheap, short-output triage pass whether a rewrite is even needed.
    //
    // We only short-circuit when the draft already has a runnable VERIFY block
    // (parseVerifyBlock !== null): the final handoff gate rejects specs without
    // one, so returning a structurally-incomplete draft would just fail later.
    // When the draft is structurally sound and triage says CLEAN, return it as
    // is. Otherwise fall through to the rewrite, feeding the triage defects in
    // as a focus list. Triage failures are non-fatal — we just do the rewrite.
    // DETERMINISTIC skip-escape gate (run-8 F2): a required VERIFY check wrapped in a
    // skip-announcing `||` fallback (`… || echo "skipping (tool absent)"`) lets the
    // check pass while never running. FP-measured 0/20 on the historical specs. When
    // present, force the rewrite to strip it — never let the triage CLEAN short-circuit
    // ship a self-waiving VERIFY block — and feed the offending lines in as defects.
    const skipEscapes = findSkipEscapes(spec)
    const skipDefects = skipEscapes.length > 0 ? skipEscapeDefectText(skipEscapes) : null
    // The cross-slice contract registry (run-8 F3): the design's pinned interface
    // facts, quoted verbatim, that more than one slice touches. Threading them into
    // critique lets the triage/rewrite RECONCILE a synthesized wiring specific (a
    // fabricated uniform mount table) against the facts it must reproduce — the
    // generation-side complement of the verify-side boundary check. Empty (single
    // /task, or a design that pins no shared boundary) ⇒ no-op.
    const registryRaw = await readContracts(deps.cwd).catch(() => '')
    const contractsBlock = buildContractsVerifyBlock(registryRaw)
    // DETERMINISTIC synthesized-wiring probe (run-8 F3, generation side). The registry
    // alone is a WEAK catcher (live A/B: prompt+registry ~1/8) — the model's attention
    // goes to the obvious VERIFY weakness and it rarely does the path-composition
    // reasoning. The scanner NAMES the inferred mount mappings and juxtaposes the
    // verbatim pinned facts, forcing focused reconciliation (probe+rule pattern, same
    // lever as skip-escape / substitution-probe). FP-clean (1/18 files on the run-8
    // trees). Grounding = the registry ∪ any design doc the spec/refined @-reference.
    const wiring =
        registryRaw.trim().length > 0 ?
            findSynthesizedWiring(
                spec,
                registryRaw + '\n' + readReferencedDocs(deps.cwd, refined, spec),
                registryRaw
            )
        :   []
    const wiringProbe = wiring.length > 0 ? wiringProbeText(wiring, registryRaw) : null
    if (wiringProbe) {
        deps.logDebug?.(
            `synthesized wiring flagged in spec: ${wiring.map(w => w.line).join(' | ')}`
        )
    }
    // DETERMINISTIC plan-contradiction probe (mx5 run 11, goal D): a VERIFY line
    // asserting the ABSENCE of an artifact the plan pins elsewhere — a path a prior
    // task already shipped to disk, a sibling title's deliverable, a contract-pinned
    // boundary. Run 11: the scope fence leaked into TASK_0009's verify as "the admin
    // page must NOT exist" (TASK_0008's deliverable); the guaranteed FAIL became an
    // accepted debt that the final-gate autofix then "fixed" by deleting the sibling's
    // work. The conflict must die here, at spec time — forced into the rewrite like
    // the skip-escape finding; delete-tasks keep their check by declaring the delete.
    const absenceConflicts = findAbsenceConflicts(spec, {
        fileExists: p => existsSync(resolve(deps.cwd, p)),
        siblingTitles: siblingTitlesFromPlanContext(planContext),
        contracts: registryRaw
    })
    const absenceProbe = absenceConflicts.length > 0 ? absenceProbeText(absenceConflicts) : null
    if (absenceProbe) {
        deps.logDebug?.(
            'plan-contradiction flagged in VERIFY: '
                + absenceConflicts.map(c => `${c.assertion.target} (${c.against})`).join(' | ')
        )
    }
    // DETERMINISTIC unsatisfiable-pair probe (mx5 run 12 root cause): a blanket
    // frozen path ("Do NOT modify `tsconfig.json` … handled in steps 1–2") whose
    // registration edit the spec's OWN body — or the task's RESEARCH the spec was
    // composed from (live drafts sometimes drop the nuance while shipping the
    // freeze and the creation) — says the deliverable requires ("must also be
    // included …"). Shipped as-is, the created files turn the repo-wide static
    // check permanently red and no task is allowed to fix it — every later task
    // burns its AUTOFIX rounds on it. Forced into the rewrite like the other
    // probes: the rewrite must grant scoped ownership or drop the creation.
    const frozenConflicts = findFrozenPathConflicts(spec, research)
    const frozenProbe = frozenConflicts.length > 0 ? frozenConflictProbeText(frozenConflicts) : null
    if (frozenProbe) {
        deps.logDebug?.(
            'unsatisfiable freeze/requires-edit pair flagged in spec: '
                + frozenConflicts.map(c => c.path).join(' | ')
        )
    }
    // DETERMINISTIC grep-theater probe (mx5 run 13, Bug B): a VERIFY block that
    // grep-asserts the SOURCE of a runnable deliverable while every command in
    // the block is static inspection — the build script "verified" by three
    // greps that was never run, shipping broken for 14 tasks. Forced into the
    // rewrite like the skip-escape finding: VERIFY must EXECUTE the artifact
    // and assert an observable outcome of that run.
    const grepOnly = findGrepOnlyVerify(spec)
    const grepOnlyProbe = grepOnly.length > 0 ? grepOnlyVerifyDefectText(grepOnly) : null
    if (grepOnlyProbe) {
        deps.logDebug?.(
            'grep-theater VERIFY flagged in spec: ' + grepOnly.map(f => f.target).join(' | ')
        )
    }
    // DETERMINISTIC neutered-check-script probe (mx5 run 13, PROMPT 4 item 4): a
    // spec that DICTATES a check script which cannot fail — `"lint": "… || true"`,
    // or a checker laundered through an inverted grep. Whatever task implements
    // that spec writes the disarmed script into package.json, and from then on
    // every gate that runs it (repo-health verify, the final integration gate)
    // reads a constant. Cheapest to kill here, in the spec, before it is authored.
    const scriptEscapes = findScriptEscapesInText(spec)
    const scriptProbe = scriptEscapes.length > 0 ? scriptEscapeDefectText(scriptEscapes) : null
    if (scriptProbe) {
        deps.logDebug?.(
            'neutered check script dictated by spec: ' + scriptEscapes.map(f => f.name).join(' | ')
        )
    }
    let triageDefects: string | null = null
    if (parseVerifyBlock(spec) !== null) {
        const tTriage = Date.now()
        let verdict: string | null
        try {
            // No tools: triage judges only the spec/refined/qa text it is given.
            // Granting `read` here let it wander the repo to "verify" findings,
            // which made the supposedly-cheap pass cost as much as a rewrite
            // (observed ~133s). The judgement needs no file access.
            verdict = await runPhaseChild(
                deps,
                'critique-triage',
                '',
                appendNoThink(CRITIQUE_TRIAGE_PROMPT(spec, refined, qa, contractsBlock))
            )
        } catch {
            verdict = null
        }
        deps.recordSubStep?.('triage', Date.now() - tTriage)
        if (verdict !== null) {
            // A deterministic skip-escape, synthesized-wiring, plan-contradiction,
            // unsatisfiable-pair, grep-theater, or neutered-check-script finding
            // overrides a CLEAN triage: the draft must be rewritten to resolve it
            // even if the model judged the rest clean (the model does not
            // self-discover any of them reliably).
            if (isCritiqueClean(verdict)) {
                if (
                    skipDefects === null
                    && wiringProbe === null
                    && absenceProbe === null
                    && frozenProbe === null
                    && grepOnlyProbe === null
                    && scriptProbe === null
                    && (extraDefects ?? null) === null
                ) {
                    return spec
                }
            } else {
                triageDefects = verdict.trim()
            }
        }
    }
    // Merge the deterministic skip-escape + synthesized-wiring + plan-contradiction
    // + unsatisfiable-pair + grep-theater + neutered-script defects with any triage
    // defects for the rewrite (all are forced FOCUS items).
    const rewriteDefects =
        [
            skipDefects,
            wiringProbe,
            absenceProbe,
            frozenProbe,
            grepOnlyProbe,
            scriptProbe,
            extraDefects ?? null,
            triageDefects
        ]
            .filter(Boolean)
            .join('\n\n') || null

    const tRewrite = Date.now()
    try {
        return await runWithEmphasisRetry(
            deps,
            'critique',
            'read',
            problem => {
                const base = CRITIQUE_PROMPT(
                    spec,
                    refined,
                    qa,
                    problem === 'no_verify_block',
                    rewriteDefects,
                    contractsBlock
                )
                // Theater retry gets a targeted hint (the generic emphasis line
                // says "previous attempt had no VERIFY block", which is wrong
                // here — it had one, it just never ran the deliverable).
                return problem === 'verify_grep_theater' ?
                        prependHint(GREP_THEATER_RETRY_HINT, base)
                    :   base
            },
            text => {
                // The rewrite (thinking on) sometimes prepends narration before
                // GOAL; the prompt forbids it but this validator only checks for
                // a VERIFY block. Strip it so the delivered spec starts at GOAL.
                const stripped = stripSpecPreamble(text)
                if (parseVerifyBlock(stripped) === null) {
                    return {ok: false, problem: 'no_verify_block'}
                }
                // Detector-backed closure on the grep-theater defect: when the
                // draft was flagged, the rewrite must actually resolve it (live
                // A/B: 1/5 rewrites ignored the injected defect and re-shipped
                // the grep-only block). One emphasis retry with a targeted hint;
                // a second miss falls back to the draft in critiqueWithFallback.
                if (grepOnlyProbe !== null && findGrepOnlyVerify(stripped).length > 0) {
                    return {ok: false, problem: 'verify_grep_theater'}
                }
                return {ok: true, value: stripped}
            },
            problem => new Error(problem)
        )
    } finally {
        deps.recordSubStep?.('rewrite', Date.now() - tRewrite)
    }
}

// ─── Critique with fallback ──────────────────────────────────────────────────

export async function critiqueWithFallback(d: PhaseDeps, p: PhaseContext): Promise<string> {
    try {
        return await phaseCritique(d, p.spec, p.refined, p.qa, p.planContext, p.research)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg !== 'no_verify_block' && msg !== 'verify_grep_theater') throw err
        // Fall back to the compose draft — but only if it actually carries a
        // runnable VERIFY block. Critique reaches its rewrite path precisely
        // when the compose draft lacked one (triage is skipped in that case),
        // so returning that same draft would persist a VERIFY-less spec the
        // handoff gate rejects and resume can't heal. Compose now enforces a
        // parseable VERIFY, so this should hold; keep the guard so a regression
        // fails the run cleanly instead of shipping a broken spec.
        // (verify_grep_theater: both rewrite attempts kept a grep-only VERIFY;
        // the draft carries the same defect but is the validated-shape fallback
        // — deliver it rather than fail the run. The guard costs time, never work.)
        if (parseVerifyBlock(p.spec) === null) throw err
        p.ctx.ui.notify(
            msg === 'verify_grep_theater' ?
                'Critique rewrite kept a grep-only VERIFY — using compose draft. Consider adding a command that RUNS the deliverable.'
            :   "Critique couldn't produce a VERIFY block — using compose draft. Edit the spec manually if needed.",
            'warning'
        )
        return p.spec
    }
}

// ─── Phase config table ──────────────────────────────────────────────────────

export const PHASES: PhaseConfig[] = [
    {
        name: 'refine',
        section: 'refined prompt',
        field: 'refined',
        run: async (d, p) => {
            const refined = await phaseRefine(d, p.rawPrompt, p.planContext)
            // Subtractively strike any phantom runtime specifier (`bun:sql`) the
            // refine carried up verbatim from the spec doc, BEFORE it flows to
            // research/grill/compose. An appended correction alone loses: the
            // affirmative survives into the composed GOAL and on to the implementer
            // (proven: compose re-leaks it 4/4). Rewriting the source so compose has
            // nothing to contradict is the fix. Silent + no-op when nothing is wrong
            // or the runtime's types aren't installed.
            const phantoms = findPhantomImports(refined, d.cwd)
            if (phantoms.length === 0) return refined
            d.logDebug?.(
                `phantom specifiers rewritten in refined: ${phantoms.map(x => x.spec).join(', ')}`
            )
            return rewritePhantomSpecifiers(refined, phantoms)
        }
    },
    {
        name: 'research',
        section: 'research',
        field: 'research',
        run: async (d, p) => {
            const tResearch = Date.now()
            const rawResearch = await phaseResearch(d, p.refined)
            d.recordSubStep?.('workers', Date.now() - tResearch)
            const tVerify = Date.now()
            const out = await phaseVerifyTooling(d, rawResearch)
            d.recordSubStep?.('verify-tooling', Date.now() - tVerify)
            // Deterministically verify every runtime builtin specifier the refined
            // task names (`bun:sql`, `node:…`) against the installed types. A doc can
            // confidently name a module that does not exist; left unchecked it rides
            // through every phase and the implementer fabricates a `declare module`
            // shim to compile it. Append the corrections so compose folds them into
            // CONSTRAINTS. No LLM cost and silent when nothing is wrong.
            const corrections = formatApiCorrections(findPhantomImports(p.refined, d.cwd))
            if (corrections) {
                d.logDebug?.(`phantom imports flagged:\n${corrections}`)
                return `${out}\n\n${corrections}`
            }
            return out
        }
    },
    {
        name: 'grill',
        section: 'grill Q&A',
        field: 'qa',
        run: (d, p) => phaseGrill(d, p.ctx, p.widgetState, p.refined, p.research)
    },
    {
        name: 'compose',
        section: 'spec',
        field: 'spec',
        run: async (d, p) => {
            p.refined = await dropRefutedConstraints(d, p.refined, p.research)
            return await phaseCompose(d, p.refined, p.research, p.qa)
        }
    },
    {
        name: 'critique',
        section: 'spec',
        field: 'spec',
        run: async (d, p) => {
            const spec = await critiqueWithFallback(d, p)
            // BRACES (mx5 run 16): after the LAST spec-producing step, append any
            // owned design obligation the spec still omits as a CONSTRAINTS
            // bullet. The belt block upstream is obeyed ~25% (measured); a
            // host-side append is obeyed by construction. Idempotent: quotes the
            // spec already carries (belt-obeying reps) are skipped.
            const owned = await ownedForThisTask(d)
            if (owned.length === 0) return spec
            const out = appendOwnedConstraints(spec, owned)
            if (out !== spec) {
                d.logDebug?.(
                    'owned-requirements braces: appended omitted design obligation(s) to CONSTRAINTS'
                )
            }
            // An owned obligation whose only file this spec also FREEZES is
            // unsatisfiable here; move it to the pending task that writes that
            // file rather than shipping a requirement no one can meet.
            return await resolveOwnedFreezeForThisTask(d, out)
        }
    }
]

// INTEGRATION-DEPTH APPEND (2026-07-27): the lever proposed for this exact site —
// deterministically append a known-runnable integration command to the VERIFY block
// whenever a task's ACCEPTANCE claims runtime behaviour — is REFUTED at STEP 0 and was
// NOT built. Nothing below is wired; this is the record.
//
// The defect is real and reproduces on four unrelated stacks. Measured with
// scripts/verify-integration-depth-step0.ts (published metric regex in that file;
// re-runnable, no model time): VERIFY blocks that boot or hit the real integrated
// product — mx5 7/41, IAR1 3/10, godot-engine 2/20, runner 0/2, total 12/73 (16.4%).
// That total OVERSTATES the truth: godot's two hits only match because the block greps
// a URL out of CLAUDE.md, and IAR1's TASK_0006 curls a GitHub tarball to check a hash,
// so genuine product integration is ~9/73 (~12%). The addressable class — runtime claim
// in ACCEPTANCE, a boot command available with provenance, static-only VERIFY anyway —
// is 29/73 (39.7%), clearing the task's 25% kill condition, but 27 of those 29 are mx5.
//
// What kills the lever is its input, not its premise. It needs a command that is
// (1) provenance-bearing, (2) proven runnable, (3) terminating, and (4) integration-
// shaped. Measured on scratch clones with scripts/integration-command-provenance.ts,
// that intersection is EMPTY on every stack available here:
//   mx5    `bun run dev` is the only command matching the metric and it does not
//          terminate (probe killed it at 60s) — appending it hangs the verify child
//          until the 15-minute command watchdog and then FAILs. Every command that DOES
//          terminate (`bun run build` exit 0) fails the metric.
//   godot  `godot --headless --quit` (0.8s, exit 0) and the real GUT runner (1.7s,
//          exit 0) are both appendable — and neither matches the metric, which is
//          web-shaped (curl/localhost/PORT=/run dev/http://). Nothing appendable can
//          move the registered metric on a non-web stack, so the two-stack A/B the
//          task requires is unsatisfiable by construction, not by sample size.
//   IAR1   no candidate at all: cmake is absent from this box (the N5 finding).
// R4 forbids swapping the metric after seeing results, so a broadened "boots the real
// product" metric is a separate pre-registered experiment, not a rescue of this one.
//
// The deeper finding: on the stack holding 93% of the addressable mass, integration is
// not a COMMAND. mx5's 7 integrated blocks are whole task-specific procedures — pick a
// free port (3911/41234/42421/3001), export DATABASE_URL, boot, seed, log in, assert N
// endpoints, tear down. A host-side append cannot synthesize that from provenance
// (launch-contract.md records script NAMES only — no port, no health URL), and
// synthesizing it from the task's own `## verified tooling` is the N5 fabrication road.
// That machinery already exists in ONE place that owns ports, seeding and teardown: the
// final gate's render check. The mx5-class defect belongs there (nexttask TASK 6), not
// in per-task VERIFY blocks.
//
// Durable assets kept: both rigs above and their unit tests. Do NOT wire an append here
// without a command source that satisfies all four properties at once.

export async function postCommitPhase(
    phase: PhaseConfig,
    deps: PhaseDeps,
    pc: PhaseContext,
    out: string
): Promise<void> {
    if (phase.name !== 'refine') return
    const title = deriveTitle(out)
    pc.widgetState.title = title
    // Compress the (often paragraph-long) title into a short display label. This
    // is best-effort and self-falls-back to a truncation, so it never blocks the
    // pipeline — but persist title first so a label failure can't lose the title.
    await updateTaskFrontMatter(pc.cwd, pc.id, {title})
    const label = await compressTitle(deps, title)
    pc.widgetState.label = label
    await updateTaskFrontMatter(pc.cwd, pc.id, {label})
}
