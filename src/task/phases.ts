/**
 * Phase pipeline — the five phase functions (refine, research, grill, compose,
 * critique) plus the config table that drives the orchestrator loop.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import {docsRaw, docsFocused} from '../workers/docs-core.js'
import {fetchRaw, fetchFocused} from '../workers/fetch-core.js'
import {formatNpmVersionSection} from '../workers/npm-version.js'
import {runWorker} from '../workers/pi-worker-core.js'
import {search as defaultSearch} from '../workers/search-core.js'
import type {SearchCoreInput, SearchCoreResult} from '../workers/search-core.js'
import {extractEnrichTargets} from './enrichment.js'
import {getFileInventory} from './file-inventory.js'
import {formatServiceBlock, formatFreshnessSkippedBlock} from './service-blocks.js'
import {
    REFINE_PROMPT,
    RESEARCH_FILES_PROMPT,
    RESEARCH_APIS_PROMPT,
    RESEARCH_CONTEXT_PROMPT,
    RESEARCH_TOOLING_PROMPT,
    GRILL_GEN_PROMPT,
    GRILL_AUTO_ANSWER_PROMPT,
    COMPOSE_PROMPT,
    CRITIQUE_PROMPT,
    CRITIQUE_TRIAGE_PROMPT,
    VERIFY_TOOLING_PROMPT
} from './prompts.js'
import {setTaskSection, updateTaskFrontMatter, type PhaseName} from './task-file.js'
import {type WidgetState} from './widget.js'
import {
    parseVerifyBlock,
    parseGrillQuestions,
    parseAutoAnswer,
    parseVerifyToolingOutput,
    validateSpecShape,
    deriveTitle,
    isCritiqueClean,
    type AutoAnswer
} from './parsers.js'
import {
    runPhaseChild,
    runPhaseWithLoopGuard,
    runWithEmphasisRetry,
    prependHint,
    USER_CANCELLED,
    type PhaseDeps
} from './child-runner.js'

// ─── Re-export constants from their home modules ────────────────────────────

export {MAX_GRILL_QUESTIONS} from './prompts.js'

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
    runPhaseWithLoopGuard(deps, 'refine', 'read', hint => prependHint(hint, REFINE_PROMPT(raw)))

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

export interface PhaseResearchDeps {
    docsRaw?: typeof docsRaw
    fetchRaw?: typeof fetchRaw
    getFileInventory?: (cwd: string, signal?: AbortSignal) => Promise<string>
    searchFn?: (input: SearchCoreInput) => Promise<SearchCoreResult>
}

export async function phaseResearch(
    deps: PhaseDeps,
    refined: string,
    researchDeps: PhaseResearchDeps = {}
): Promise<string> {
    const docsRawFn = researchDeps.docsRaw ?? docsRaw
    const fetchRawFn = researchDeps.fetchRaw ?? fetchRaw
    const fileInventoryFn = researchDeps.getFileInventory ?? getFileInventory
    const searchFn = researchDeps.searchFn ?? defaultSearch
    const enrichTargets = extractEnrichTargets(refined)
    const enrichSections: string[] = []

    if (
        enrichTargets.packages.length > 0
        || enrichTargets.urls.length > 0
        || enrichTargets.services.length > 0
    ) {
        const tEnrichStart = Date.now()
        const [docsResults, fetchResults, serviceResults] = await Promise.all([
            Promise.all(
                enrichTargets.packages.map(pkg =>
                    docsRawFn({
                        pkg,
                        query: refined.split('\n').find(l => l.trim()) ?? refined,
                        cwd: deps.cwd,
                        signal: deps.signal
                    }).catch(() => null)
                )
            ),
            Promise.all(
                enrichTargets.urls.map(url =>
                    fetchRawFn({url, signal: deps.signal}).catch(() => null)
                )
            ),
            Promise.all(
                enrichTargets.services.map(s =>
                    searchFn({
                        query: `${s.name} ${s.query}`,
                        count: 3,
                        signal: deps.signal
                    }).catch(() => null)
                )
            )
        ])

        // npm version blocks come from docsRaw's bundled lookup and lead the
        // section so the model anchors on live version data before reading
        // the docs body.
        for (let i = 0; i < enrichTargets.packages.length; i++) {
            const v = docsResults[i]?.npmVersion
            if (v) enrichSections.push(formatNpmVersionSection(v))
        }

        for (let i = 0; i < enrichTargets.packages.length; i++) {
            const r = docsResults[i]
            if (r?.kind === 'ok' && r.chunks.length > 0) {
                const body = r.chunks
                    .map(c => c.content)
                    .join('\n\n')
                    .slice(0, 4000)
                enrichSections.push(`### docs: ${enrichTargets.packages[i]}\n${body}`)
            }
        }

        for (let i = 0; i < enrichTargets.urls.length; i++) {
            const r = fetchResults[i]
            if (r) {
                enrichSections.push(
                    `### url: ${enrichTargets.urls[i]}\n${r.markdown.slice(0, 4000)}`
                )
            }
        }

        const skipped: string[] = []
        for (let i = 0; i < enrichTargets.services.length; i++) {
            const s = enrichTargets.services[i]
            const r = serviceResults[i]
            if (r === null) continue
            if (r.kind === 'no_key') {
                skipped.push(s.name)
                continue
            }
            if (r.kind === 'error') continue
            // kind === 'ok'
            enrichSections.push(formatServiceBlock(s.name, `${s.name} ${s.query}`, r.results))
        }

        if (skipped.length > 0) {
            enrichSections.push(formatFreshnessSkippedBlock(skipped))
        }

        deps.recordSubStep?.('enrichment', Date.now() - tEnrichStart)
    }

    const externalContext =
        enrichSections.length > 0 ? `EXTERNAL CONTEXT\n${enrichSections.join('\n\n')}\n\n` : ''

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
        if (deps.onChildOutput) deps.onChildOutput(`research (${doneCount}/4 workers done)`)
    }

    // Per-worker timing split into wait (spawn → first byte) and work (first
    // byte → exit). When workers fan out concurrently and the upstream model
    // API caps concurrency, the queued workers spend most of their elapsed
    // time waiting for a slot — the wait/work split makes that visible
    // instead of the previous Promise.all-relative wall-clock that conflated
    // the two.
    const recordWorker = <T extends {waitMs: number; workMs: number}>(
        label: string,
        p: Promise<T>
    ): Promise<T> =>
        p.then(r => {
            deps.recordSubStep?.(`${label} wait`, r.waitMs)
            deps.recordSubStep?.(`${label} work`, r.workMs)
            return r
        })

    const [files, apis, context, tooling] = await Promise.all([
        recordWorker(
            'worker:files',
            runWorker({
                prompt: promptHeader + RESEARCH_FILES_PROMPT(refined),
                cwd: deps.cwd,
                signal: deps.signal,
                spawn: deps.spawn
            }).then(r => {
                updateProgress()
                return r
            })
        ),
        recordWorker(
            'worker:apis',
            runWorker({
                prompt: promptHeader + RESEARCH_APIS_PROMPT(refined),
                cwd: deps.cwd,
                signal: deps.signal,
                spawn: deps.spawn
            }).then(r => {
                updateProgress()
                return r
            })
        ),
        recordWorker(
            'worker:context',
            runWorker({
                prompt: promptHeader + RESEARCH_CONTEXT_PROMPT(refined),
                cwd: deps.cwd,
                signal: deps.signal,
                spawn: deps.spawn,
                // Context owns architectural understanding, not path discovery
                // — FILES handles that. Dropping `find`/`ls` keeps the worker
                // from spawning long enumeration loops whose output then
                // inflates prefill on every subsequent round.
                tools: 'read,grep'
            }).then(r => {
                updateProgress()
                return r
            })
        ),
        recordWorker(
            'worker:tooling',
            runWorker({
                prompt: promptHeader + RESEARCH_TOOLING_PROMPT(refined),
                cwd: deps.cwd,
                signal: deps.signal,
                spawn: deps.spawn
            }).then(r => {
                updateProgress()
                return r
            })
        )
    ])

    const sections = [
        {name: 'FILES', result: files},
        {name: 'APIS', result: apis},
        {name: 'CONTEXT', result: context},
        {name: 'TOOLING', result: tooling}
    ]
    for (const {name, result} of sections) {
        if (result.exitCode !== 0) {
            throw new Error(
                `Research ${name} worker failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`
            )
        }
        if (result.text.trim().length === 0) {
            throw new Error(`Research ${name} worker produced no output`)
        }
    }

    return `FILES\n${files.text}\n\nAPIS\n${apis.text}\n\nCONTEXT\n${context.text}\n\nTOOLING\n${tooling.text}`
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

        const text = await runPhaseChild(
            deps,
            'grill-auto',
            'read',
            externalContext + GRILL_AUTO_ANSWER_PROMPT(refined, research, question)
        )
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
    const tGenStart = Date.now()
    const raw = await runPhaseWithLoopGuard(deps, 'grill-gen', 'read', hint =>
        prependHint(hint, GRILL_GEN_PROMPT(refined, research))
    )
    deps.recordSubStep?.('gen', Date.now() - tGenStart)
    const questions = parseGrillQuestions(raw)
    if (questions.length === 0) return '(no questions produced)'

    // Auto-answers are independent — generate them concurrently before the UI
    // loop. The user-input loop below still runs sequentially (the user can
    // only answer one prompt at a time), but the LLM-spawning work no longer
    // blocks each iteration. For N questions this turns ~N × cold-start time
    // into ~1 × cold-start time.
    const tAutoStart = Date.now()
    let doneCount = 0
    widgetState.lastLine = `auto-answering 0/${questions.length} done…`
    const autos = await Promise.all(
        questions.map((q, i) =>
            phaseAutoAnswer(deps, refined, research, q).then(r => {
                doneCount++
                widgetState.lastLine = `auto-answering ${doneCount}/${questions.length} done (Q${i + 1})`
                return r
            })
        )
    )
    deps.recordSubStep?.('auto-answers', Date.now() - tAutoStart)

    const theme = ctx.ui.theme
    const tInputStart = Date.now()
    const out: string[] = []
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i]
        const auto = autos[i]
        out.push(`Q${i + 1}: ${q}`)
        const rawTrim = auto.raw.trim()
        out.push(
            `  (auto-worker raw: ${rawTrim.length === 0 ? '(empty)' : rawTrim.replace(/\n/g, ' ⏎ ')})`
        )
        if (auto.kind === 'answered') {
            out.push(`A${i + 1}: ${auto.text} (auto)`)
            continue
        }
        const title =
            auto.suggested ?
                `${q}\n${theme.fg('muted', 'Recommended:')}\n\n${theme.fg('text', auto.suggested)}\n\n${theme.fg('muted', 'press Enter to accept')}`
            :   `${q}\n${theme.fg('muted', '(no recommendation — please answer)')}`
        widgetState.lastLine = `awaiting Q${i + 1}`
        const a = await ctx.ui.input(title, auto.suggested)
        if (a === undefined) throw new Error(USER_CANCELLED)
        const typed = a.trim()
        if (typed.length === 0 && auto.suggested) {
            out.push(`A${i + 1}: ${auto.suggested} (accepted recommendation)`)
        } else if (typed.length === 0) {
            out.push(`A${i + 1}: (skipped)`)
        } else {
            out.push(`A${i + 1}: ${typed}`)
        }
    }
    deps.recordSubStep?.('user input', Date.now() - tInputStart)
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
            const problem = validateSpecShape(text)
            return problem ? {ok: false, problem} : {ok: true, value: text}
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
                CRITIQUE_TRIAGE_PROMPT(spec, refined, qa)
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
            text =>
                parseVerifyBlock(text) ?
                    {ok: true, value: text}
                :   {ok: false, problem: 'no_verify_block'},
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
            'Critique couldn\'t produce a VERIFY block — using compose draft. Edit the spec manually if needed.',
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
