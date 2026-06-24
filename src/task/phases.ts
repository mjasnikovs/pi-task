/**
 * Phase pipeline — the five phase functions (refine, research, grill, compose,
 * critique) plus the config table that drives the orchestrator loop.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {docsFocused} from '../workers/docs-core.js'
import {fetchFocused} from '../workers/fetch-core.js'
import {formatNpmVersionSection} from '../workers/npm-version.js'
import {runWorker, type RunWorkerResult} from '../workers/pi-worker-core.js'
import {findPhantomImports, formatApiCorrections} from '../workers/phantom-imports.js'
import {search as defaultSearch} from '../workers/search-core.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'
import {extractEnrichTargets} from './enrichment.js'
import {getFileInventory} from './file-inventory.js'
import {buildOrientation} from './orientation.js'
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
import {readSection, removeTaskSection, setTaskSection, updateTaskFrontMatter} from './task-io.js'
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
import {
    runPhaseChild,
    runPhaseWithLoopGuard,
    runWithEmphasisRetry,
    prependHint,
    USER_CANCELLED,
    type PhaseDeps
} from './child-runner.js'
import {SessionUI} from '../remote/bridge.js'

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

export const phaseRefine = (deps: PhaseDeps, raw: string, planContext?: string) =>
    runPhaseWithLoopGuard(deps, 'refine', 'read', hint =>
        prependHint(hint, appendNoThink(REFINE_PROMPT(raw, planContext)))
    )

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

const DOCS_EXTENSION_PATH = new URL('../workers/docs-extension.js', import.meta.url).pathname

/**
 * In-process guards loaded into the TOOLING worker only: block a re-read of any
 * file already read, and block any byte-identical grep/find/ls repeat, feeding
 * the model "you already have this, answer now" instead of letting it re-run.
 * TOOLING reads each file once and never needs an identical search twice in any
 * healthy recorded run, so neither rule has a legitimate false positive here.
 * See single-read-guard.ts.
 */
const SINGLE_READ_EXTENSION_PATH = new URL('../workers/single-read-extension.js', import.meta.url)
    .pathname

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
 *   - 'fatal' (non-zero exit that isn't a loop-kill, empty output, or a leaked
 *     never-executed tool call): the output is untrustworthy in a way partial text
 *     can't paper over (broken env, model disconnect, wrong tool-call dialect).
 *     These still throw — degrading them would launder a real breakage into a
 *     plausible-looking section. Returns null when the result is trustworthy.
 */
function classifyResearchWorker(
    name: string,
    result: RunWorkerResult
): {kind: 'runaway'; reason: string} | {kind: 'fatal'; error: Error} | null {
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
        return {kind: 'fatal', error: new Error(`Research ${name} worker produced no output`)}
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

    let doneCount = 0
    const updateProgress = (): void => {
        doneCount++
        if (deps.onChildOutput) {
            deps.onChildOutput(`research (${doneCount}/${workerSpecs.length} workers done)`)
        }
    }

    // Per-worker timing split into wait (spawn → first byte) and work (first
    // byte → exit). The workers run sequentially below, so each split is a clean
    // per-worker measurement — waitMs the worker's own cold-start, workMs its
    // generation+tool-call cost — not a Promise.all-relative wall-clock that
    // conflates the two.
    const recordWorker = <T extends {waitMs: number; workMs: number}>(
        label: string,
        p: Promise<T>
    ): Promise<T> =>
        p.then(r => {
            deps.recordSubStep?.(`${label} wait`, r.waitMs)
            deps.recordSubStep?.(`${label} work`, r.workMs)
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
    // Do NOT switch this back to Promise.all without re-running that A/B.
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
        prompt: string
        tools?: string
        extensions?: string[]
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
            // Read-heavy: gets the orientation core (see note above).
            prompt: appendNoThink(orientation.block + promptHeader + RESEARCH_APIS_PROMPT(refined)),
            tools: 'read,grep,find,ls,pi-worker-docs',
            extensions: [DOCS_EXTENSION_PATH]
        },
        {
            section: 'CONTEXT',
            label: 'worker:context',
            prompt: appendNoThink(promptHeader + RESEARCH_CONTEXT_PROMPT(refined)),
            // Context owns architectural understanding, not path discovery —
            // FILES handles that. Dropping `find`/`ls` keeps the worker from
            // spawning long enumeration loops whose output then inflates
            // prefill on every subsequent round.
            tools: 'read,grep'
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

    // Run workers one at a time, persisting each worker's validated output the
    // moment it succeeds. On a resume, a worker whose cached output is already on
    // disk is skipped — so when one worker fails and the phase is re-run, the
    // others don't burn minutes regenerating work that was already good. Each
    // worker is validated inline (not in a second pass) so a failure throws
    // before later workers run, and only trustworthy text is ever cached.
    const sections: Array<{name: string; text: string}> = []
    for (const spec of workerSpecs) {
        const cacheHeading = researchWorkerCacheHeading(spec.section)
        const cached = (await readSection(deps.cwd, deps.taskId, cacheHeading)) ?? ''
        if (cached.trim().length > 0) {
            deps.logDebug?.(`${spec.label}: cached — skipping re-run`)
            updateProgress()
            sections.push({name: spec.section, text: cached.trim()})
            continue
        }

        deps.logDebug?.(`${spec.label}: start`)
        const r = await recordWorker(
            spec.label,
            runWorker({
                prompt: spec.prompt,
                cwd: deps.cwd,
                signal: deps.signal,
                spawn: deps.spawn,
                ...(spec.tools ? {tools: spec.tools} : {}),
                ...(spec.extensions ? {extensions: spec.extensions} : {}),
                onLine: line => {
                    deps.logDebug?.(`${spec.label}: ${line}`)
                    deps.onChildOutput?.(`${spec.label}: ${line}`)
                }
            })
        )
        deps.logDebug?.(
            `${spec.label}: done exit=${r.exitCode} wait=${r.waitMs}ms work=${r.workMs}ms`
                + (r.stderr ? ` stderr=${r.stderr.slice(0, 300)}` : '')
                + (r.leakedToolCall ? ` leaked=${r.leakedToolCall.trim().slice(0, 80)}` : '')
        )
        updateProgress()

        // A fatal failure (crash/empty/leak) still throws — the already-cached
        // workers survive for the resume. A runaway (loop/timeout) degrades to its
        // partial output instead, so one weak worker can't abort a whole auto-run;
        // the degraded section is cached too, so a resume doesn't re-loop it.
        const failure = classifyResearchWorker(spec.section, r)
        if (failure?.kind === 'fatal') throw failure.error
        const sectionText =
            failure?.kind === 'runaway' ?
                degradedSectionBody(spec.section, failure.reason, r.text)
            :   r.text.trim()
        if (failure?.kind === 'runaway') {
            deps.logDebug?.(`${spec.label}: degraded — ${failure.reason}`)
        }
        await setTaskSection(deps.cwd, deps.taskId, cacheHeading, sectionText)
        sections.push({name: spec.section, text: sectionText})
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
        return parseAutoAnswer(text)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {kind: 'unknown', raw: `(threw: ${msg})`}
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
            // A binary fork (suggested + alt) becomes a select() picker locally —
            // each option on its own line, labelled A/B. A single recommendation
            // rides along under the question as the input default; an open
            // question shows the bare prompt.
            const twoOption = plainSuggested !== undefined && plainAlt !== undefined
            const localTitle =
                !twoOption && plainSuggested ?
                    `${shownQ}\n${renderInlineMarkdown(auto.suggested!, theme)}`
                :   shownQ
            widgetState.lastLine = `awaiting Q${n + 1}`
            const a = await ui.ask({
                localTitle,
                question: plainQ,
                recommended: plainSuggested,
                recommended2: plainAlt,
                allowSkip: plainSuggested === undefined && plainAlt === undefined,
                ...(twoOption && {
                    options: [
                        {
                            label: `A: ${renderInlineMarkdown(auto.suggested!, theme)}`,
                            value: plainSuggested!
                        },
                        {label: `B: ${renderInlineMarkdown(auto.alt!, theme)}`, value: plainAlt!}
                    ]
                })
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

export async function phaseCompose(
    deps: PhaseDeps,
    refined: string,
    research: string,
    qa: string
): Promise<string> {
    return runWithEmphasisRetry(
        deps,
        'compose',
        'read',
        problem => COMPOSE_PROMPT(refined, research, qa, problem),
        text => {
            // Trim any "here's the spec:" preamble before validating, so a
            // strippable lead-in doesn't burn a full retry — and the stored
            // value starts at GOAL.
            const stripped = stripSpecPreamble(text)
            const problem = validateSpecShape(stripped)
            return problem ? {ok: false, problem} : {ok: true, value: stripped}
        },
        problem => new Error(`compose_invalid: ${problem}`)
    )
}

export async function phaseCritique(
    deps: PhaseDeps,
    spec: string,
    refined: string,
    qa: string
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
                appendNoThink(CRITIQUE_TRIAGE_PROMPT(spec, refined, qa))
            )
        } catch {
            verdict = null
        }
        deps.recordSubStep?.('triage', Date.now() - tTriage)
        if (verdict !== null) {
            if (isCritiqueClean(verdict)) return spec
            triageDefects = verdict.trim()
        }
    }

    const tRewrite = Date.now()
    try {
        return await runWithEmphasisRetry(
            deps,
            'critique',
            'read',
            problem => CRITIQUE_PROMPT(spec, refined, qa, problem !== null, triageDefects),
            text => {
                // The rewrite (thinking on) sometimes prepends narration before
                // GOAL; the prompt forbids it but this validator only checks for
                // a VERIFY block. Strip it so the delivered spec starts at GOAL.
                const stripped = stripSpecPreamble(text)
                return parseVerifyBlock(stripped) ?
                        {ok: true, value: stripped}
                    :   {ok: false, problem: 'no_verify_block'}
            },
            () => new Error('no_verify_block')
        )
    } finally {
        deps.recordSubStep?.('rewrite', Date.now() - tRewrite)
    }
}

// ─── Critique with fallback ──────────────────────────────────────────────────

export async function critiqueWithFallback(d: PhaseDeps, p: PhaseContext): Promise<string> {
    try {
        return await phaseCritique(d, p.spec, p.refined, p.qa)
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg !== 'no_verify_block') throw err
        p.ctx.ui.notify(
            "Critique couldn't produce a VERIFY block — using compose draft. Edit the spec manually if needed.",
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
        run: (d, p) => phaseRefine(d, p.rawPrompt, p.planContext)
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
        run: (d, p) => phaseCompose(d, p.refined, p.research, p.qa)
    },
    {name: 'critique', section: 'spec', field: 'spec', run: critiqueWithFallback}
]

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
