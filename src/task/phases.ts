/**
 * Phase pipeline — the five phase functions (refine, research, grill, compose,
 * critique) plus the config table that drives the orchestrator loop.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {docsFocused} from '../workers/docs-core.js'
import {fetchFocused} from '../workers/fetch-core.js'
import {formatNpmVersionSection} from '../workers/npm-version.js'
import {runWorker} from '../workers/pi-worker-core.js'
import {search as defaultSearch} from '../workers/search-core.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'
import {extractEnrichTargets} from './enrichment.js'
import {getFileInventory} from './file-inventory.js'
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
import {setTaskSection, updateTaskFrontMatter} from './task-io.js'
import {type PhaseName} from './task-types.js'
import {renderInlineMarkdown, stripInlineMarkdown} from './inline-markdown.js'
import {type WidgetState} from './widget.js'
import {
    parseGrillQuestions,
    parseAutoAnswer,
    autoAnswerHasTag,
    parseVerifyToolingOutput,
    deriveTitle,
    type AutoAnswer
} from './parsers.js'
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

export const phaseRefine = (deps: PhaseDeps, raw: string) =>
    runPhaseWithLoopGuard(deps, 'refine', 'read', hint =>
        prependHint(hint, appendNoThink(REFINE_PROMPT(raw)))
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
            prompt: appendNoThink(promptHeader + RESEARCH_FILES_PROMPT(refined))
        },
        {
            section: 'APIS',
            label: 'worker:apis',
            prompt: appendNoThink(promptHeader + RESEARCH_APIS_PROMPT(refined)),
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
            prompt: appendNoThink(promptHeader + RESEARCH_TOOLING_PROMPT(refined))
        }
    ]

    const workerResults: Array<Awaited<ReturnType<typeof runWorker>>> = []
    for (const spec of workerSpecs) {
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
        workerResults.push(r)
    }

    // Validate + assemble by mapping spec.section over the results, so adding or
    // reordering a worker is a single edit to workerSpecs (the result order
    // mirrors workerSpecs order — the loop above pushes in sequence).
    const sections = workerSpecs.map((spec, i) => ({name: spec.section, result: workerResults[i]}))
    for (const {name, result} of sections) {
        // Loop/timeout exhaustion is checked before the generic exit-code branch:
        // a loop-kill arrives as a SIGTERM (exit 143) AND sometimes as a clean
        // exit 0 with partial text, so keying off exitCode alone would either give
        // a useless "exit 143" message or silently accept truncated output. The
        // worker already burned its MAX_LOOP_RESTARTS restarts before setting these.
        if (result.loopHit) {
            const argsStr = JSON.stringify(result.loopHit.call.args)
            throw new Error(
                `Research ${name} worker stuck in a loop — called `
                    + `${result.loopHit.call.name}(${argsStr}) ×${result.loopHit.count} in the last `
                    + `${result.loopHit.windowSize} calls and still looped after restarts`
            )
        }
        if (result.timedOut) {
            throw new Error(`Research ${name} worker timed out after restarts`)
        }
        if (result.exitCode !== 0) {
            throw new Error(
                `Research ${name} worker failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`
            )
        }
        if (result.text.trim().length === 0) {
            throw new Error(`Research ${name} worker produced no output`)
        }
        if (result.leakedToolCall) {
            throw new Error(
                `Research ${name} worker wrote a tool call as text instead of invoking it `
                    + `(${result.leakedToolCall.trim()}) — it never ran`
            )
        }
    }

    return sections.map(({name, result}) => `${name}\n${result.text}`).join('\n\n')
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
    // Open-ended: keep asking until the model emits NONE or the user dismisses.
    for (let n = 0; ; n++) {
        const tGenStart = Date.now()
        const raw = await runPhaseWithLoopGuard(deps, 'grill-gen', 'read', hint =>
            prependHint(hint, GRILL_GEN_PROMPT(refined, research, qa.join('\n')))
        )
        deps.recordSubStep?.('gen', Date.now() - tGenStart)
        const questions = parseGrillQuestions(raw)
        if (questions.length === 0) break // NONE / nothing left to ask
        const q = questions[0]

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
        run: (d, p) => phaseRefine(d, p.rawPrompt)
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
    pc: PhaseContext,
    out: string
): Promise<void> {
    if (phase.name !== 'refine') return
    const title = deriveTitle(out)
    pc.widgetState.title = title
    await updateTaskFrontMatter(pc.cwd, pc.id, {title})
}
