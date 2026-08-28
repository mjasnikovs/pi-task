/**
 * ONE research worker, cache-skip to persist.
 *
 * WHY IT IS A MODULE. This was a 228-line closure inside `phaseResearch` over
 * eleven locals, and inside it live the three RETRY GATES and their precedence:
 * the EMPTY-SECTION gate (the only one that can fail the phase), the
 * ZERO-RETRIEVAL gate and the SILENT gate (both of which discard a failed retry
 * and ship the original). Getting that order wrong is how a run either dies on a
 * legitimately empty section or ships one written from memory.
 *
 * The cost was in the TESTS. Reaching the gates meant a temp dir, a real task
 * file, and a fake spawn routed on prose lifted out of `prompts.ts` — plus, for
 * attempt-1-vs-attempt-2, a second sentence lifted out of a module-private
 * preamble constant. In a codebase whose whole workflow is re-wording prompts and
 * measuring what changed, that means a reworded preamble silently stops the gate
 * tests from testing the gate. Behind this interface a test scripts
 * `runWorker(label, attempt)` and states the `RunWorkerResult` fields a gate
 * reads.
 *
 * THE INVARIANT, stated once: the empty gate runs FIRST and is the only one that
 * can throw; the other two keep the original when their retry does not improve a
 * named measure; and `confirmedEmpty` suppresses the silent gate, because that
 * retry already asked "you wrote nothing" and got the same answer.
 */

import type {RunWorkerInput, RunWorkerResult} from '../workers/pi-worker-core.js'
import {classifyWorkerFailure} from '../workers/worker-failure.js'
import {classifyContextSilence, countBullets} from './context-silence.js'
import type {SpawnFn} from '../shared/child-process.js'
import type {DebugLine} from './debug-log.js'

/**
 * One research worker's row. `section` is the heading its output is assembled
 * and cached under; `label` is its child NAME — what the loader, the debug trail
 * and the A/B ledgers print, and the key into `REASONING_GROUP_BY_CHILD`.
 */
export interface ResearchWorkerSpec {
    section: string
    label: string
    /** Static, or built from the sections completed so far (serial mode hands
     *  APIS the finished FILES map; parallel mode hands it nothing). */
    prompt: string | ((prior: ReadonlyArray<{name: string; text: string}>) => string)
    tools?: string
    extensions?: string[]
    /** Deterministic gate over the worker's own output, run BEFORE the section is
     *  persisted, so nothing it rejects survives into the cache or into compose. */
    postProcess?: (text: string) => string
    /** When set, a non-empty section produced with ZERO grounding-retrieval calls is
     *  re-run ONCE with this preamble prepended, forcing a retrieval-first pass. The
     *  retry replaces the original only if it actually retrieved. */
    zeroRetrievalRetry?: string
    /** When set, a section that comes out SILENT — zero parseable bullets from a
     *  loop-degrade banner or a hallucinated non-bullet fragment — is re-run ONCE
     *  with this preamble. A legitimately-empty section is NOT retried. */
    retryIfSilent?: string
    /** This worker can issue project-source docs lookups, so the 5B fan-out bounds
     *  apply to it (see task/research-fanout-budget.ts). */
    fanoutBounded?: true
}

/**
 * The small record the driver needs: one way to run a worker, and where to put
 * what comes back.
 *
 * Everything here is a fact about THIS RUN, not about the worker — which is what
 * lets the four rows be plain data and the driver be a function of two arguments.
 */
export interface ResearchWorkerRun {
    runWorker: (label: string, input: RunWorkerInput) => Promise<RunWorkerResult>
    cwd: string
    taskId: string
    signal: AbortSignal
    spawn?: SpawnFn
    /** The `--thinking` fragment for a named child. */
    thinkingFor: (label: string) => string[]
    logDebug?: (msg: string, kind?: DebugLine) => void
    onChildOutput?: (line: string) => void
    /** Record one finished worker's timing splits. */
    record: (label: string, p: Promise<RunWorkerResult>) => Promise<RunWorkerResult>
    /** Called once per worker that reaches an outcome, cached ones included. */
    onDone: () => void
    /**
     * Read one worker's cached output back, or '' when there is none.
     *
     * A SEAM, and the symmetric half of `persistSection`. The cache skip is one
     * of the four outcomes this driver has, and reaching it used to require a
     * real task file on disk — which is most of why the gate tests needed a temp
     * dir at all.
     */
    readCached: (heading: string) => Promise<string>
    /** Write one validated section to the task file. Serialised by the caller. */
    persistSection: (heading: string, text: string) => Promise<void>
    /** 5B RESCUE / SCALE knobs, resolved once for the phase. */
    carryForward: boolean
    fanoutTimeout: {perLookupMs: number; ceilingMs: number} | null
    progressCeilingMs: number | null
}

/**
 * Task-file heading under which a research worker's validated output is cached.
 * A resumed research phase reads these to skip workers that already succeeded,
 * instead of re-running all four from scratch when one of them fails — the
 * expensive case (e.g. 3 healthy workers thrown away because the 4th looped).
 */
export function researchWorkerCacheHeading(section: string): string {
    return `research worker ${section}`
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
export function classifyResearchWorker(
    name: string,
    result: RunWorkerResult
): {kind: 'runaway'; reason: string} | {kind: 'fatal'; error: Error} | {kind: 'empty'} | null {
    // What KILLED the child, if anything — classified once, in the ladder that
    // owns the precedence (workers/worker-failure.ts), because every kill path
    // also sets `aborted` and a non-zero exit. This switch says only what each
    // cause means to RESEARCH; being exhaustive, a new cause is a compile error
    // here instead of falling through to the generic "exit N".
    const failure = classifyWorkerFailure(result)
    if (failure) {
        switch (failure.kind) {
            case 'loop': {
                const argsStr = JSON.stringify(failure.hit.call.args)
                return {
                    kind: 'runaway',
                    reason:
                        `stuck in a loop — called ${failure.hit.call.name}(${argsStr}) `
                        + `×${failure.hit.count} in the last ${failure.hit.windowSize} calls `
                        + `and still looped after restarts`
                }
            }
            case 'worker-timeout':
                return {kind: 'runaway', reason: 'timed out after restarts'}
            case 'command-timeout':
                return {
                    kind: 'runaway',
                    reason:
                        `ran a \`${failure.toolName}\` command that never returned and was killed `
                        + 'after restarts'
                }
            case 'stream-stall':
                return {
                    kind: 'runaway',
                    reason: `model stream went silent for ${failure.idleMs}ms after restarts`
                }
            case 'stalled':
                return {
                    kind: 'fatal',
                    error: new Error(
                        `Research ${name} worker: model server unreachable — the child produced no `
                            + 'output and the model endpoint did not respond'
                    )
                }
            case 'leaked-tool-call':
                return {
                    kind: 'fatal',
                    error: new Error(
                        `Research ${name} worker wrote a tool call as text instead of invoking it `
                            + `(${failure.text.trim()}) — it never ran`
                    )
                }
            case 'aborted':
            case 'exit':
                return {
                    kind: 'fatal',
                    error: new Error(
                        `Research ${name} worker failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`
                    )
                }
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
export async function runResearchWorker(
    spec: ResearchWorkerSpec,
    run: ResearchWorkerRun,
    prior: ReadonlyArray<{name: string; text: string}> = []
): Promise<{name: string; text: string}> {
    const cacheHeading = researchWorkerCacheHeading(spec.section)
    const cached = await run.readCached(cacheHeading)
    if (cached.trim().length > 0) {
        run.logDebug?.(`${spec.label}: cached — skipping re-run`)
        run.onDone()
        return {name: spec.section, text: cached.trim()}
    }

    run.logDebug?.(`${spec.label}: start`)
    const basePrompt = typeof spec.prompt === 'function' ? spec.prompt(prior) : spec.prompt
    const runOnce = (extraPreamble?: string): Promise<RunWorkerResult> =>
        run.record(
            spec.label,
            run.runWorker(spec.label, {
                prompt: extraPreamble ? `${extraPreamble}\n\n${basePrompt}` : basePrompt,
                cwd: run.cwd,
                signal: run.signal,
                spawn: run.spawn,
                // ONE CELL PER WORKER since 2026-08-28. They used to share
                // the `research` cell on the grounds that they are the same
                // job over four questions; the run logs disagree. All 40.7
                // wasted research minutes in mx5-n were restarts in
                // `tooling` and `context`, and `files`/`apis` never
                // restarted — so the level that pays for one pair is being
                // paid for the other. THE FOUR CELLS DO NOT SHIP IDENTICAL:
                // `research:files` is `off` on a measured tie while the
                // other three are `medium`, so this line changes what the
                // FILES worker runs at for every default-mode user. The
                // evidence is on each cell in reasoning.ts.
                thinking: run.thinkingFor(spec.label),
                ...(spec.tools ? {tools: spec.tools} : {}),
                ...(spec.extensions ? {extensions: spec.extensions} : {}),
                // 5B SCALE arm — null unless both env vars are set. Only the
                // docs-capable worker can fan out, so only it can be scaled.
                ...(spec.fanoutBounded && run.fanoutTimeout ?
                    {fanoutTimeout: run.fanoutTimeout}
                :   {}),
                // 5B RESCUE. Applies to EVERY research worker, not just the
                // docs-capable one: any worker that gets killed loses its work
                // the same way. carry-forward stays OFF unless asked for
                // (measured harmful on its own); the progress deadline SHIPPED
                // ON in nexttask 9 and is null only when explicitly disabled.
                ...(run.carryForward ? {carryForward: true} : {}),
                ...(run.progressCeilingMs !== null ?
                    {progressTimeoutCeilingMs: run.progressCeilingMs}
                :   {}),
                // One line per DISCARDED attempt. The `done` line below reports
                // the final attempt only, so a worker that timed out twice at
                // 240s and then answered used to log exactly like a clean one —
                // 8 minutes of burned compute recoverable only by subtracting
                // its own wait+work from the start/done timestamps.
                onCarryForward: ci => {
                    run.logDebug?.(
                        `${spec.label}: CARRY-FORWARD injected into attempt ${ci.attempt}`
                            + ` (${ci.chars} chars onto a ${ci.promptCharsBefore}-char prompt)`
                    )
                },
                onRestart: rs => {
                    run.logDebug?.(
                        `${spec.label}: RESTART (attempt ${rs.attempt} discarded)`
                            + ` reason=${rs.reason} wall=${rs.wallMs}ms`
                            + ` wait=${rs.waitMs}ms work=${rs.workMs}ms`
                            + (rs.detail ? ` — ${rs.detail}` : '')
                    )
                    run.onChildOutput?.(`${spec.label}: restart (${rs.reason})`)
                },
                onLine: line => {
                    // The one 'stream' site in this file: raw research-worker
                    // output. Every other logDebug here records a decision.
                    // onChildOutput drives the widget and is not gated.
                    run.logDebug?.(`${spec.label}: ${line}`, 'stream')
                    run.onChildOutput?.(`${spec.label}: ${line}`)
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
        run.logDebug?.(
            `${spec.label}: EMPTY answer on a clean exit — retrying once before`
                + ' accepting the section as having no entries'
        )
        run.onChildOutput?.(`${spec.label}: empty — retrying`)
        const retry = await runOnce(EMPTY_SECTION_PREAMBLE)
        if (retry.text.trim().length > 0) {
            run.logDebug?.(
                `${spec.label}: retry answered (len=${retry.text.trim().length})`
                    + ' — replacing the empty section'
            )
            r = retry
        } else {
            confirmedEmpty = classifyResearchWorker(spec.section, retry)?.kind === 'empty'
            run.logDebug?.(
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
    if (spec.zeroRetrievalRetry && r.groundingRetrievalCount === 0 && r.text.trim().length > 0) {
        run.logDebug?.(
            `${spec.label}: ZERO grounding-retrieval on a non-empty section`
                + ' — every symbol is unverified memory; re-running once with a forced'
                + ' retrieval-first pass'
        )
        run.onChildOutput?.(`${spec.label}: zero-retrieval — retrying with forced retrieval`)
        const retry = await runOnce(spec.zeroRetrievalRetry)
        if (retry.groundingRetrievalCount > 0 && retry.text.trim().length > 0) {
            run.logDebug?.(
                `${spec.label}: retry grounded (${retry.groundingRetrievalCount} retrieval`
                    + ' calls) — replacing the memory-written section'
            )
            r = retry
        } else {
            run.logDebug?.(
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
            run.logDebug?.(
                `${spec.label}: silent-retry first-silent cause=${verdict.cause}`
                    + ` — zero bullets, re-running once with a forced-emit preamble`
            )
            run.onChildOutput?.(`${spec.label}: silent — retrying`)
            const retry = await runOnce(spec.retryIfSilent)
            const retryBody = silentBodyOf(retry)
            const retryBullets = retryBody === null ? 0 : countBullets(retryBody)
            if (retryBullets > 0) {
                run.logDebug?.(
                    `${spec.label}: silent-retry recovered bullets=${retryBullets}`
                        + ' — replacing the silent section'
                )
                r = retry
            } else {
                run.logDebug?.(
                    `${spec.label}: silent-retry still-silent`
                        + ` (bullets=${retryBullets}) — keeping the original`
                )
            }
        }
    }
    run.logDebug?.(
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
    run.onDone()

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
        run.logDebug?.(`${spec.label}: degraded — ${failure.reason}`)
    }
    if (!confirmedEmpty && isBareNoneAnswer(r.text)) {
        run.logDebug?.(
            `${spec.label}: answered "${r.text.trim().slice(0, 40)}" — recording it as`
                + ' an empty section (the worker ran and found nothing)'
        )
    }
    // Post-check the worker's own output before it is persisted, so the cache a
    // resume reads back is already gated. A degraded partial goes through it too —
    // a truncated section can still carry a laundered claim.
    const sectionText = spec.postProcess ? spec.postProcess(rawText) : rawText
    await run.persistSection(cacheHeading, sectionText)
    return {name: spec.section, text: sectionText}
}
