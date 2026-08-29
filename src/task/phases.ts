/**
 * Phase pipeline — the five phase functions (refine, research, grill, compose,
 * critique) plus the config table that drives the orchestrator loop.
 */

import {fileURLToPath} from 'node:url'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {docsFocused} from '../workers/docs-core.js'
import {fetchFocused} from '../workers/fetch-core.js'
import {runWorker, type RunWorkerInput} from '../workers/pi-worker-core.js'
import {
    findPhantomImports,
    formatApiCorrections,
    rewritePhantomSpecifiers
} from '../workers/phantom-imports.js'
import {searchProviderKey, type SearchProvider} from '../workers/search-types.js'
import {channelSet} from '../workers/worker-channels.js'
import {
    snapshotLeverEnv,
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
import {getFileInventory} from './file-inventory.js'
import {buildOrientation, orientationTier} from './orientation.js'
import {getConfig} from '../config/config.js'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {buildExternalContext, gatherExternalContext} from './external-context.js'
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
    MAX_GRILL_QUESTIONS
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
    validateRefineShape,
    stripSpecPreamble,
    isCritiqueClean
} from './spec-validation.js'
import {collectCritiqueDefects} from './critique-probes.js'
import {settleQuestion} from './question-dialog.js'
import {findSynthesizedApis, synthesizedApiReaskHint} from './api-synthesis.js'
import {GREP_THEATER_RETRY_HINT} from './verify-quality.js'
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
    thinkingForChild,
    runPhaseChild,
    runWithEmphasisRetry,
    prependHint,
    USER_CANCELLED,
    type PhaseDeps
} from './child-runner.js'
import {
    runResearchWorker,
    researchWorkerCacheHeading,
    type ResearchWorkerSpec
} from './research-worker.js'
import {SessionUI} from '../remote/bridge.js'
import {isYoloMode, yoloPickAutoAnswer} from './yolo.js'
import {QaTranscript, GRILL_QA_POLICY} from './qa-transcript.js'

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
    /**
     * The pure, idempotent transform this phase performs on `PhaseContext` fields
     * OTHER than its own `field` — the phase's CARRY. Mutates `pc` and returns the
     * trail lines the decision produced; it performs no I/O of its own.
     *
     * A carry runs on BOTH arms of the orchestrator loop: before `run` on the live
     * path, and in place of `run` on the resume path. That is the whole point. A
     * row's `section` is what resume restores from disk, and it restores exactly
     * ONE field — so a phase that settles a second field and does not declare it
     * here silently loses that work on every resume past it. Compose is the case
     * that matters: it drops constraints research REFUTED from `refined`, critique
     * re-reads `refined` as GROUND TRUTH under a prompt that says CONSTRAINTS "MUST
     * be preserved", and `## refined prompt` on disk is deliberately left as refine
     * wrote it. A resume at critique used to hand the refuted constraint straight
     * back — the mx5 run-19 defect, restored by the very machinery that closed it.
     *
     * The trail is returned rather than written so the replay cannot duplicate a
     * gate line the live run already recorded.
     */
    carry?: (deps: PhaseDeps, pc: PhaseContext) => Promise<string[]>
    run: (deps: PhaseDeps, pc: PhaseContext) => Promise<string>
    /**
     * What this phase must do once its output is PERSISTED — after the section
     * write, so a fault here cannot lose the output. A row field rather than a
     * `phase.name !== 'refine'` test inside one function, so the compiler can tell
     * you which rows have a post-commit effect.
     */
    postCommit?: (deps: PhaseDeps, pc: PhaseContext, out: string) => Promise<void>
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
    const refined = await runPhaseChild(
        deps,
        'refine',
        'read',
        REFINE_PROMPT(raw, planContext, existingFiles, contracts, directivesBlock),
        // refine's deliverable is a 4-section text rewrite that never strictly
        // needs a successful read — on a test-writing task against a large
        // existing codebase the model over-explores (re-reads source hunting for
        // the impl) and burns the loop budget. Degrade to a no-tools final
        // attempt instead of hard-failing the whole run. See TASK_0016 (mx5):
        // refine looped 3×/resume forever; the deliverable was always producible
        // from the title + design doc alone.
        {degradeOnExhaustion: true, verb: 'restart'}
    )
    // Shape check, REPORTED not enforced. Refine's four sections are what
    // extractCapsSection, scopedToolingGoal, deriveTitle and extractEnrichTargets
    // each look for, and all four fail SILENTLY when one is missing — so the loss
    // was previously invisible. Deliberately not a retry or a throw: refine's
    // output is usable prose even when a heading is gone (the four consumers
    // degrade, they do not break), and a run must not die over a heading. This
    // puts the miss in the debug log where an audit can find it.
    const shape = validateRefineShape(refined)
    if (shape) deps.logDebug?.(`refine: ${shape}`)
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
            VERIFY_TOOLING_PROMPT(toolingList)
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

/**
 * The worker channels the APIS research worker is given.
 *
 * `pi-worker-search` + `pi-worker-fetch` ride along only when the configured
 * engine is usable (a keyless engine always is; brave needs its key). A tool
 * without a key just errors, and a weak model burns calls on it — while search
 * being ABSENT was structural in the other direction: three consecutive audited
 * runs made 0 search calls because the child literally did not have the tool.
 *
 * Both halves of "given a channel" — the tools string and the `-e` path — come
 * from the same rows, so they cannot disagree.
 */
export function apisWorkerChannels(): {tools: string; extensions: string[]} {
    return channelSet([
        'pi-worker-docs',
        ...(searchConfigured() ? ['pi-worker-search', 'pi-worker-fetch'] : [])
    ])
}

/**
 * Is live web search configured for this process? The keyless providers (exa,
 * ddg) always are; only brave needs its API key.
 */
export function searchConfigured(
    getEnv: (k: string) => string | undefined = k => process.env[k],
    provider: SearchProvider = getConfig().searchProvider
): boolean {
    // Asks the SAME row `search()` asks. This used to re-state brave's env pair
    // under a comment saying it "mirrors search-core's lookup" — two statements of
    // one fact, and the one that decides whether the APIS worker is even handed the
    // search tool.
    return searchProviderKey(provider, getEnv) !== null
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
export const SINGLE_READ_EXTENSION_PATH = fileURLToPath(
    new URL('../workers/single-read-extension.js', import.meta.url)
)

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

export async function phaseResearch(deps: PhaseDeps, refined: string): Promise<string> {
    const fileInventoryFn = deps.getFileInventory ?? getFileInventory
    const runWorkerFn =
        deps.runWorker ?? ((_label: string, input: RunWorkerInput) => runWorker(input))
    const externalContext = await gatherExternalContext(refined, deps)

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
    const leverEnv = snapshotLeverEnv()
    const fanoutBudget = projectDocsBudget(leverEnv)
    const progressCeilingMs = workerProgressCeilingMs(leverEnv)
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
    // llama.cpp backend (single GPU, same task/model) — and the answer FLIPS
    // with thinking:
    //   - thinking ON  → parallel wins: long decodes batch well, 4 concurrent
    //     finish in ~max(worker), not the sum.
    //   - thinking OFF → sequential wins: with short decodes the batching upside
    //     is gone, but 4 concurrent streams still split the one GPU and slow
    //     each other ~4x (context worker measured 27s solo vs 128s under load),
    //     so summed-but-fast (~100s) beats max-of-slowed (~130s).
    //
    // KNOWN-OPEN, AND THIS IS THE HONEST STATE OF IT. That A/B was run when
    // every worker carried Qwen3's `/no_think` prompt suffix, so "thinking OFF"
    // was assumed and sequential followed. The suffix has since been measured
    // INERT — with server thinking on and `/no_think` still in the prompt,
    // Qwen3.8 emitted a median 17k-char trace anyway (n=25) — and it has been
    // removed in favour of the `research` reasoning group (config/reasoning.ts).
    // So the arm this default was chosen under may never have been the arm that
    // ran, and the group's level is now a user-visible setting rather than a
    // constant.
    //
    // The default stays SEQUENTIAL because that is the measured-safe arm on a
    // single-GPU box and because flipping a shipped default on an invalidated
    // premise would be replacing one unmeasured claim with another. The
    // parallel x reasoning-level interaction is unmeasured; re-run the A/B
    // before changing this, and treat `parallelResearchWorkers` as the opt-in
    // for backends that genuinely serve parallel streams.
    //
    // Result order (files, apis, context, tooling) is preserved for assembly.
    // Resolved once: `searchConfigured()` reads the environment, and the tools
    // string and the `-e` paths must be derived from the SAME answer.
    const apisChannels = apisWorkerChannels()
    const workerSpecs: Array<{
        /** Section heading this worker's output is assembled under. */
        section: string
        /** The worker's child NAME — what the loader, the debug trail and the A/B
         *  ledgers print, and the key into `REASONING_GROUP_BY_CHILD`, so it also
         *  decides the worker's own reasoning cell. */
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
            prompt: orientation.block + promptHeader + RESEARCH_FILES_PROMPT(refined)
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
                + (fanoutBudget === null ? '' : projectDocsBudgetNotice(fanoutBudget)),
            // The tools string and the `-e` paths are ONE fact — which worker
            // channels this research worker is given — and used to be two literals
            // kept in step by eye. `channelSet` derives both from the same rows.
            tools: `read,grep,find,ls,${apisChannels.tools}`,
            fanoutBounded: true,
            extensions: apisChannels.extensions,
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
            prompt: promptHeader + RESEARCH_CONTEXT_PROMPT(refined),
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
            prompt: promptHeader + RESEARCH_TOOLING_PROMPT(scopedToolingGoal(refined)),
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

    /**
     * This phase's binding of the research-worker driver: everything about THIS
     * RUN, gathered once, so each of the four rows is plain data.
     */
    const drive = (
        spec: ResearchWorkerSpec,
        prior: ReadonlyArray<{name: string; text: string}>
    ): Promise<{name: string; text: string}> =>
        runResearchWorker(
            spec,
            {
                runWorker: runWorkerFn,
                contextWindow: deps.contextWindow ?? 'unknown',
                cwd: deps.cwd,
                taskId: deps.taskId,
                signal: deps.signal,
                spawn: deps.spawn,
                // ONE CELL PER WORKER since 2026-08-28. The four workers used to
                // share the `research` cell on the grounds that they are the same
                // job over four questions; the run logs disagree. The cells DO NOT
                // ship identical — the evidence is on each of them in reasoning.ts.
                thinkingFor: thinkingForChild,
                logDebug: deps.logDebug,
                onChildOutput: deps.onChildOutput,
                record: recordWorker,
                onDone: updateProgress,
                readCached: async heading =>
                    (await readSection(deps.cwd, deps.taskId, heading)) ?? '',
                persistSection,
                leverEnv
            },
            prior
        )

    const sections: Array<{name: string; text: string}> = []
    if (!getConfig().parallelResearchWorkers) {
        // Default: ONE AT A TIME (see the A/B note above the specs) — a fatal
        // failure throws before later workers run, and each worker can see the
        // finished sections before it (APIS builds on the FILES map).
        for (const spec of workerSpecs) {
            sections.push(await drive(spec, sections))
        }
    } else {
        // Opt-in for parallel-capable backends. allSettled (not all): every
        // worker runs to its own outcome first, so one fatal failure cannot
        // orphan the others' output — their sections persist for the resume
        // before the failure is thrown. Assembly order stays the spec order
        // regardless of completion order. No prior sections exist here, so
        // prompt builders get none (APIS runs map-less, as before this option).
        const settled = await Promise.allSettled(workerSpecs.map(spec => drive(spec, [])))
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

export async function phaseAutoAnswer(
    deps: PhaseDeps,
    refined: string,
    research: string,
    question: string
): Promise<AutoAnswer> {
    const docsFocusedFn = deps.docsFocused ?? docsFocused
    const fetchFocusedFn = deps.fetchFocused ?? fetchFocused
    try {
        // Same assembly as the research phase (see external-context.ts); what
        // differs is POLICY and the worker variant, and both are arguments now.
        // The caps exist because this runs per grill question in front of a
        // waiting user; there is deliberately no version-lookup fan-out, no body
        // truncation (the focused child already answers in a paragraph) and no
        // timing sub-step here.
        //
        // `groundingBodies` counts the doc/url bodies that made it into the block:
        // the surviving-unknown routing below asks "did any doc/fetch worker
        // produce a grounding section?", which is exactly this and nothing about
        // npm-version or service blocks.
        let groundingBodies = 0
        const countBody = (body: string | undefined): string | undefined => {
            if (body !== undefined) groundingBodies += 1
            return body
        }
        const externalContext = await buildExternalContext(
            question,
            deps,
            {
                docs: async pkg => {
                    const r = await docsFocusedFn({
                        pkg,
                        query: question,
                        cwd: deps.cwd,
                        signal: deps.signal
                    })
                    return {npmVersion: r.npmVersion, body: countBody(r.answer || undefined)}
                },
                url: async url => {
                    const r = await fetchFocusedFn({
                        url,
                        query: question,
                        cwd: deps.cwd,
                        signal: deps.signal
                    })
                    return {body: countBody(r.answer || undefined)}
                },
                search: deps.searchFn
            },
            {targetCap: 2, serviceCap: 2}
        )

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
        const docResolved = groundingBodies > 0
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
    // ONE record, two renderings (task/qa-transcript.ts): `forRecord()` is what
    // compose and critique are handed, `forGenerator()` is what the next grill-gen
    // call sees. The provenance rule below used to be a comment 12 lines under a
    // push that broke it.
    const transcript = new QaTranscript(GRILL_QA_POLICY)
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
        const raw = await runPhaseChild(
            deps,
            'grill-gen',
            'read',
            prependHint(genHint, GRILL_GEN_PROMPT(refined, research, transcript.forGenerator())),
            {verb: 'restart'}
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

        if (auto.kind === 'answered') {
            transcript.add('auto', plainQ, stripInlineMarkdown(auto.text))
        } else {
            // YOLO: take the recommended option and never build the prompt (which
            // is also what suppresses its notification — see yolo.ts). An answer the
            // anti-synthesis guard demoted, or a question with no recommendation at
            // all, is SKIPPED instead: costing the spec one unanswered fork is the
            // guard direction, promoting a hallucination is not.
            //
            // Grill's generator sees NO provenance — its feedback is fed verbatim
            // into the next grill-gen prompt, where a suffix would describe how the
            // answer was obtained rather than what it was. That is
            // `GRILL_QA_POLICY.generatorSeesProvenance: false`, stated once.
            const outcome = await settleQuestion({
                ui,
                transcript,
                plain: plainQ,
                shown: shownQ,
                ...(auto.suggested !== undefined && {suggested: auto.suggested}),
                ...(auto.alt !== undefined && {alt: auto.alt}),
                render: md => renderInlineMarkdown(md, theme),
                yolo: yoloPickAutoAnswer(isYoloMode(), auto),
                onAsk: () => {
                    widgetState.lastLine = `awaiting Q${n + 1}`
                }
            })
            if (outcome === 'cancelled') throw new Error(USER_CANCELLED)
        }
    }
    if (transcript.length === 0) return '(no questions produced)'
    return transcript.forRecord()
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
    await recordPhaseTrail(deps, 'compose', refuted.trail)
    return refuted.refined
}

/**
 * COMPOSE's carry: the refutation drop, as a `PhaseConfig.carry`.
 *
 * Same transform as `dropRefutedConstraints` over the same pure core, minus the
 * recording — the caller decides whether this application is the live one or a
 * resume replay. `dropRefutedConstraints` stays exported and unchanged for the
 * harnesses under `scripts/` that drive the drop directly.
 */
export function composeCarry(_deps: PhaseDeps, pc: PhaseContext): Promise<string[]> {
    // Not `async`, and that is the shape rather than an oversight: this carry
    // performs no I/O at all, which is what lets the resume path replay it.
    const refuted = applyRefutations(pc.refined, pc.research)
    if (refuted.trail.length === 0) return Promise.resolve([])
    pc.refined = refuted.refined
    return Promise.resolve(refuted.trail)
}

/** Write a carry's trail to the debug log and the task file's `## gates` section. */
export async function recordPhaseTrail(
    deps: PhaseDeps,
    phaseName: string,
    trail: string[]
): Promise<void> {
    for (const line of trail) {
        deps.logDebug?.(`${phaseName}: ${line}`)
        await appendGateRecord(deps.cwd, deps.taskId, line).catch(() => {})
    }
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
     * here is "wire only on PASS", so a
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
    // The DETERMINISTIC half of critique: six scanners, each finding a defect the
    // model does not self-discover reliably, each forced into the rewrite and each
    // overriding a CLEAN triage. They live as rows in CRITIQUE_PROBES
    // (critique-probes.ts) so the override and the merge below are DERIVED from
    // the table rather than retyped — a probe used to be listed by hand in three
    // places, and forgetting the override term shipped the very defect it was
    // added to catch.
    //
    // The contract registry is read here rather than inside the table because the
    // critique PROMPT needs it too (run-8 F3): threading the design's pinned
    // interface facts into the rewrite lets it RECONCILE a synthesized wiring
    // specific against the facts it must reproduce — the generation-side
    // complement of the verify-side boundary check.
    const registryRaw = await readContracts(deps.cwd).catch(() => '')
    const contractsBlock = buildContractsVerifyBlock(registryRaw)
    const probes = collectCritiqueDefects(
        {
            spec,
            refined,
            ...(research === undefined ? {} : {research}),
            cwd: deps.cwd,
            registryRaw,
            ...(planContext === undefined ? {} : {planContext})
        },
        deps.logDebug
    )
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
                CRITIQUE_TRIAGE_PROMPT(spec, refined, qa, contractsBlock)
            )
        } catch {
            verdict = null
        }
        deps.recordSubStep?.('triage', Date.now() - tTriage)
        if (verdict !== null) {
            // ANY deterministic finding overrides a CLEAN triage: the draft must be
            // rewritten to resolve it even if the model judged the rest clean (the
            // model does not self-discover any of them reliably). Derived from the
            // table, so a new probe joins this rule by existing.
            if (isCritiqueClean(verdict)) {
                if (!probes.forced && (extraDefects ?? null) === null) {
                    return spec
                }
            } else {
                triageDefects = verdict.trim()
            }
        }
    }
    // Merge every deterministic defect with any triage defects for the rewrite
    // (all are forced FOCUS items).
    const rewriteDefects =
        [...probes.blocks, extraDefects ?? null, triageDefects].filter(Boolean).join('\n\n') || null

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
                // Detector-backed closure: a rewrite HANDED a defect and shipping
                // it anyway is a failed rewrite. Only probes that actually fired
                // are re-checked — a defect the draft never had is not the
                // rewrite's to resolve. One emphasis retry with a targeted hint;
                // a second miss falls back to the draft in critiqueWithFallback.
                const unresolved = probes.unresolvedIn(stripped)
                if (unresolved !== null) {
                    return {ok: false, problem: unresolved}
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

/**
 * REFINE — restate the raw prompt as a bounded 4-section spec, then subtractively
 * strike any phantom runtime specifier (`bun:sql`) it carried up verbatim from the
 * spec doc, BEFORE it flows to research/grill/compose. An appended correction alone
 * loses: the affirmative survives into the composed GOAL and on to the implementer
 * (proven: compose re-leaks it 4/4). Rewriting the source so compose has nothing to
 * contradict is the fix. Silent + no-op when nothing is wrong or the runtime's types
 * aren't installed.
 */
export async function refinePhase(d: PhaseDeps, p: PhaseContext): Promise<string> {
    const refined = await phaseRefine(d, p.rawPrompt, p.planContext)
    const phantoms = await findPhantomImports(refined, d.cwd)
    if (phantoms.length === 0) return refined
    d.logDebug?.(`phantom specifiers rewritten in refined: ${phantoms.map(x => x.spec).join(', ')}`)
    return rewritePhantomSpecifiers(refined, phantoms)
}

/**
 * RESEARCH — the four workers, then the TOOLING verification pass, then a
 * deterministic check of every runtime builtin specifier the refined task names
 * (`bun:sql`, `node:…`) against the installed types. A doc can confidently name a
 * module that does not exist; left unchecked it rides through every phase and the
 * implementer fabricates a `declare module` shim to compile it. The corrections are
 * APPENDED so compose folds them into CONSTRAINTS. No LLM cost, silent when clean.
 */
export async function researchPhase(d: PhaseDeps, p: PhaseContext): Promise<string> {
    const tResearch = Date.now()
    const rawResearch = await phaseResearch(d, p.refined)
    d.recordSubStep?.('workers', Date.now() - tResearch)
    const tVerify = Date.now()
    const out = await phaseVerifyTooling(d, rawResearch)
    d.recordSubStep?.('verify-tooling', Date.now() - tVerify)
    const corrections = formatApiCorrections(await findPhantomImports(p.refined, d.cwd))
    if (corrections) {
        d.logDebug?.(`phantom imports flagged:\n${corrections}`)
        return `${out}\n\n${corrections}`
    }
    return out
}

/** GRILL — the adaptive question loop, and the only phase that talks to the user. */
export function grillPhase(d: PhaseDeps, p: PhaseContext): Promise<string> {
    return phaseGrill(d, p.ctx, p.widgetState, p.refined, p.research)
}

/**
 * COMPOSE — compose the spec from the refined task, the research and the Q&A.
 *
 * The refutation drop that must happen first is compose's declared `carry`
 * (`composeCarry`), not a line at the top of this function. It settles `p.refined`,
 * which is not compose's own `field`, so the orchestrator has to replay it on the
 * resume path too — and a `run` body cannot be replayed.
 */
export async function composePhase(d: PhaseDeps, p: PhaseContext): Promise<string> {
    return await phaseCompose(d, p.refined, p.research, p.qa)
}

/**
 * CRITIQUE — the last spec-producing step, and the two host-side corrections that
 * must run after it in THIS ORDER.
 *
 * BRACES (mx5 run 16): append any owned design obligation the spec still omits as a
 * CONSTRAINTS bullet. The belt block upstream is obeyed ~25% (measured); a host-side
 * append is obeyed by construction. Idempotent — quotes the spec already carries
 * (belt-obeying reps) are skipped.
 *
 * Then DETACH: an owned obligation whose only file this spec also FREEZES is
 * unsatisfiable here, so it moves to the pending task that writes that file rather
 * than shipping a requirement no one can meet. It MUST run after the append, because
 * the append is what writes the stamp the detach reads — a critique-time probe
 * measured 0/40 because the stamp did not exist yet.
 */
export async function critiquePhase(d: PhaseDeps, p: PhaseContext): Promise<string> {
    const spec = await critiqueWithFallback(d, p)
    const owned = await ownedForThisTask(d)
    if (owned.length === 0) return spec
    const out = appendOwnedConstraints(spec, owned)
    if (out !== spec) {
        d.logDebug?.(
            'owned-requirements braces: appended omitted design obligation(s) to CONSTRAINTS'
        )
    }
    return await resolveOwnedFreezeForThisTask(d, out)
}

/**
 * The pipeline, as a table with no bodies.
 *
 * Every row's `run` is a named exported function, so the COMPOSITION inside a
 * step — which is where this codebase's recorded phase defects have lived, not in
 * the parts — is drivable directly instead of only through a whole TaskRunner run.
 * The parts stay exported and separately covered; what changed is that the ORDER
 * they run in is now asserted by driving the row rather than retyped in a test.
 */
export const PHASES: PhaseConfig[] = [
    {
        name: 'refine',
        section: 'refined prompt',
        field: 'refined',
        run: refinePhase,
        postCommit: refinePostCommit
    },
    {name: 'research', section: 'research', field: 'research', run: researchPhase},
    {name: 'grill', section: 'grill Q&A', field: 'qa', run: grillPhase},
    {name: 'compose', section: 'spec', field: 'spec', carry: composeCarry, run: composePhase},
    {name: 'critique', section: 'spec', field: 'spec', run: critiquePhase}
]

/**
 * Run one phase row the way the orchestrator does: carry, then run.
 *
 * The row is the interface, so this is the surface a row-driving test crosses —
 * calling `row.run` alone tests past it and would not have caught a carry that the
 * resume path drops. The orchestrator adds only persistence, timings and the
 * checkpoint around this.
 */
export async function runPhaseRow(
    row: PhaseConfig,
    deps: PhaseDeps,
    pc: PhaseContext
): Promise<string> {
    if (row.carry) await recordPhaseTrail(deps, row.name, await row.carry(deps, pc))
    return await row.run(deps, pc)
}

/**
 * Re-apply one phase row's carry on the RESUME path, where `run` is skipped.
 *
 * The trail is discarded: the live run that produced this phase's output already
 * recorded it on `## gates`, and a replay must not append a second copy.
 */
export async function replayPhaseCarry(
    row: PhaseConfig,
    deps: PhaseDeps,
    pc: PhaseContext
): Promise<void> {
    await row.carry?.(deps, pc)
}

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

/** Dispatch a row's declared post-commit effect. Rows with none do nothing. */
export async function postCommitPhase(
    phase: PhaseConfig,
    deps: PhaseDeps,
    pc: PhaseContext,
    out: string
): Promise<void> {
    await phase.postCommit?.(deps, pc, out)
}

/**
 * REFINE's post-commit: derive the task title from the refined prompt, then a short
 * display label. Runs after the section write, so a fault here cannot lose the
 * output it reads.
 */
export async function refinePostCommit(
    deps: PhaseDeps,
    pc: PhaseContext,
    out: string
): Promise<void> {
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
