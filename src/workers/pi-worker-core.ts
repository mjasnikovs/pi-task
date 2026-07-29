import {getPiInvocation} from '../shared/pi-invocation.js'
import {
    runChildDefault,
    type ContextSnapshot,
    type SpawnFn,
    type ToolCall
} from '../shared/child-process.js'
import {CommandWatchdog, commandTimeoutHint, realTimerDeps} from '../shared/command-watchdog.js'
import {childBaseArgs} from '../shared/child-extensions.js'
import {LoopDetector, type LoopHit} from '../task/loop-detector.js'
import {
    LOOP_WINDOW,
    LOOP_THRESHOLD,
    MAX_LOOP_RESTARTS,
    formatLoopHint
} from '../task/child-runner.js'
import {
    detectLeakedToolCall,
    leakedToolCallHint,
    MAX_LEAK_RETRIES
} from '../shared/leaked-tool-call.js'
import {discoverModelEndpoints, probeModelEndpoints} from '../shared/model-endpoint.js'
import {streamStallHint} from '../shared/stream-watchdog.js'

// `--mode json` makes pi emit structured events as they happen instead of
// buffering the assistant text and flushing on exit. That matters for the
// wait/work timing split: in text mode the first stdout chunk only arrives at
// the very end, so onFirstByte fires moments before close and workMs is
// effectively zero. With JSON events the first byte lands as soon as the
// model starts producing — making waitMs the real queue/cold-start cost and
// workMs the real generation+tool-call cost.
const DEFAULT_TOOLS = 'read,grep,find,ls'

/**
 * Tool calls that can GROUND an APIS claim — i.e. return content a signature or
 * command could be cited from. `pi-worker-docs` (the primary), `read` and `grep`
 * (project source), and the web escalations `pi-worker-search`/`pi-worker-fetch`.
 *
 * `ls` and `find` are deliberately EXCLUDED: they return file/directory NAMES,
 * and APIS owns symbols by name only, never paths (RESEARCH_APIS_PROMPT). Bare
 * enumeration cannot verify a signature, so a worker that fabricates its section
 * from memory does not launder itself grounded by calling `ls` once. That
 * exclusion is the anti-gaming property of any gate built on this count: "one
 * trivial `ls` then fabricate the rest" leaves groundingRetrievalCount at 0.
 */
const GROUNDING_RETRIEVAL_TOOLS = new Set([
    'pi-worker-docs',
    'read',
    'grep',
    'pi-worker-search',
    'pi-worker-fetch'
])

/** True when a tool call retrieves content an APIS entry could be grounded in. */
export function isGroundingRetrieval(toolName: string): boolean {
    return GROUNDING_RETRIEVAL_TOOLS.has(toolName)
}

/**
 * Hard wall-clock bound on a single research worker run (one spawn). The
 * exact-match LoopDetector only catches *identical* repeated tool calls; a model
 * that thrashes with slightly-varied calls (different grep patterns each time)
 * slips past it and would otherwise run unbounded. This is the backstop for that
 * case: after this long with no clean exit, abort and restart with a hint. Sized
 * well above a healthy worker's observed runtime (~25-130s on the local backend)
 * so it never trips a legitimately slow run.
 */
const RESEARCH_WORKER_TIMEOUT_MS = 240_000

/**
 * Output-stall window before the dead-backend probe fires (mx5 run 7: model
 * server died mid-gate-child, the child hung MUTE for 64 minutes). This is NOT
 * a wall-clock cap — output progress resets it, and even a fully stalled child
 * is only killed when the model endpoint is actually unreachable. Sized so a
 * long local prompt-processing pass (minutes of legitimate silence, server
 * alive) just gets probed and waits on.
 */
const STALL_AFTER_MS = 180_000

/**
 * Restart hint after a WHOLE-WORKER wall-clock timeout — distinct from both the
 * loop hint and the per-command hint. This one diagnoses over-exploration, which
 * is what the whole-worker cap actually catches. A single hung COMMAND is a
 * different fault with a different fix, and gets commandTimeoutHint instead.
 */
const WORKER_TIMEOUT_HINT =
    '[SYSTEM NOTE: Your previous attempt ran out of time before answering — you '
    + 'were exploring too long. Be decisive: do the minimum reads/greps needed, '
    + 'then write your answer now. Do not re-explore ground you have already covered.]'

export interface RunWorkerInput {
    prompt: string
    cwd: string
    signal?: AbortSignal
    spawn?: SpawnFn
    /** Comma-separated tool whitelist passed to `pi --tools`. Defaults to read,grep,find,ls. */
    tools?: string
    /** Internal extension entry-point paths to load via `-e <path>` (see childBaseArgs). */
    extensions?: string[]
    /** Called for each tool execution start and text-writing event inside the worker. */
    onLine?: (line: string) => void
    /** Called when a tool call FINISHES, with its (truncatable) result — lets a caller
     *  log tool OUTPUTS, not just the command (mx5 run 10 item 6). */
    onToolResult?: (result: {
        name: string
        isError: boolean
        text: string
        toolCallId?: string
    }) => void
    /**
     * Called for each context_usage snapshot the child emits (same `--mode json`
     * stream the phase children parse). Lets a caller's status widget show the
     * tokens/window progress bar for the worker exactly like the phase widget,
     * instead of omitting it.
     */
    onContextUsage?: (snapshot: ContextSnapshot) => void
    /**
     * Per-worker wall-clock timeout in ms. Defaults to RESEARCH_WORKER_TIMEOUT_MS.
     * Pass 0 to disable the timeout entirely (run until the child exits on its
     * own) — for a pass that must be allowed to finish however long it takes.
     */
    timeoutMs?: number
    /**
     * PER-TOOL-CALL wall-clock ceiling in ms — the child-side half of the command
     * watchdog (see shared/command-watchdog.ts). Arms on each tool_execution_start
     * and disarms on the matching end; on overrun the child is killed and, within
     * the shared restart budget, re-spawned with commandTimeoutHint.
     *
     * WHY SEPARATE FROM `timeoutMs`: that one bounds the whole worker and is
     * deliberately 0 (unbounded) for gate children, which must run to completion.
     * Neither it nor the stall guard can catch a hung command — the stall guard
     * treats a reachable model endpoint as proof of life, which it is, even while
     * a `bun run dev` the model forgot to bound blocks the child forever.
     *
     * This is the ceiling for the FIRST attempt; each HANG-caused restart halves
     * it (see commandCeilingForAttempt — loop-caused restarts don't count), so a
     * model that ignores the hint cannot spend the full ceiling again on every
     * retry.
     *
     * 0 / omitted = off, so every existing caller is unchanged.
     */
    commandTimeoutMs?: number
    /**
     * Per-worker loop-detector tuning. Defaults to the read-only research/impl
     * guard (LOOP_WINDOW / LOOP_THRESHOLD, path threshold = exact threshold). An
     * edit/fix pass legitimately revisits one file, so it can raise (or disable
     * via Infinity) `pathThreshold`. Pass `false` to turn the detector OFF
     * entirely — no tool-call pattern will ever kill the worker.
     */
    loop?: {window?: number; threshold?: number; pathThreshold?: number} | false
    /**
     * Dead-backend stall guard override. Default ON: no output for
     * STALL_AFTER_MS → probe the model endpoints pi is configured with →
     * unreachable → kill + `stalled: true`. Pass `false` to disable, or
     * override the window/probe (tests, harnesses).
     */
    stall?: {afterMs?: number; probe?: () => Promise<boolean>} | false
    /**
     * Stream-inactivity ceiling in ms (shared/stream-watchdog.ts). The stall guard
     * above cannot catch a HUNG stream on a HEALTHY backend — it reads a reachable
     * endpoint as proof of life, which is exactly what run 14's three hangs looked
     * like. This one asks nothing of the backend: no output for this long (with
     * tool executions excluded) ⇒ kill and restart the attempt with
     * {@link streamStallHint}, inside the same shared restart budget.
     * 0 / omitted = off.
     */
    streamInactivityMs?: number
}

/**
 * Combine an external abort signal with an internal wall-clock timeout into one
 * signal, while keeping the two causes distinguishable: `timedOut()` is true
 * only when the timer fired (not when the external signal aborted), so the caller
 * can restart on a timeout but not on a user cancel.
 */
function workerTimeout(
    external: AbortSignal | undefined,
    ms: number
): {signal: AbortSignal; timedOut: () => boolean; cleanup: () => void} {
    const ctrl = new AbortController()
    let timedOut = false
    // ms <= 0 (or non-finite) disables the wall-clock timeout: no timer is armed,
    // so only the external signal can abort and timedOut() stays false forever.
    const timer =
        ms > 0 && Number.isFinite(ms) ?
            setTimeout(() => {
                timedOut = true
                ctrl.abort()
            }, ms)
        :   undefined
    const onExternal = (): void => ctrl.abort()
    if (external) {
        if (external.aborted) ctrl.abort()
        else external.addEventListener('abort', onExternal, {once: true})
    }
    return {
        signal: ctrl.signal,
        timedOut: () => timedOut,
        cleanup: () => {
            clearTimeout(timer)
            external?.removeEventListener('abort', onExternal)
        }
    }
}

export interface RunWorkerResult {
    text: string
    exitCode: number
    stderr: string
    aborted: boolean
    /**
     * The provider-reported cause when the model turn itself failed (disconnect,
     * fetch failed, 5xx after pi's own retries): pi delivers it as an assistant
     * message with stopReason "error" and EMPTY text, exit code 0. Phase children
     * have always surfaced this (child-runner.ts) — research workers did not, so a
     * swallowed provider error reached the caller as an indistinguishable empty
     * answer and was reported as the useless "produced no output" (issue #10).
     * Only meaningful when `text` is empty: a turn that produced text after pi
     * recovered is a success, and the first-error capture must not relabel it.
     */
    modelError?: string
    /**
     * Whether the child ever produced a single byte of stdout. Under `--mode json`
     * a live pi child streams protocol events long before any assistant text, so
     * this separates the two ways a worker can come back with nothing:
     *   sawOutput true  — the child ran and the MODEL chose to write nothing
     *                     (a legitimately empty section on a trivial task)
     *   sawOutput false — the child never spoke at all: it died at startup
     *                     (unresolvable provider, missing key, bad argv). That is
     *                     a FAILURE and must never be recorded as "no entries".
     * Derived from the same first-byte timestamp `waitMs`/`workMs` use, so it
     * cannot disagree with them.
     */
    sawOutput: boolean
    /**
     * Milliseconds between spawn and the child's first stdout chunk. When
     * multiple workers run concurrently and the upstream model API queues at
     * some concurrency cap, this is the queue-wait portion of the run.
     */
    waitMs: number
    /**
     * Milliseconds between first stdout chunk and process exit — the
     * generation/tool-call portion, independent of queue wait. Equals total
     * elapsed when the child never produced output.
     */
    workMs: number
    /**
     * How many GROUNDING retrieval tool calls the FINAL attempt made — the calls
     * that returned content an APIS entry could be cited from (see
     * isGroundingRetrieval; `ls`/`find` excluded on purpose). Counted over the
     * attempt that produced `text`, not summed across restarts (a restarted
     * attempt discards its predecessor's calls along with its text). Zero here on
     * a non-empty section means every symbol in it came from parametric memory.
     */
    groundingRetrievalCount: number
    /**
     * Set when the worker exhausted its re-prompts still leaking a tool call as
     * text (wrong dialect, never executed). The caller must treat this as a
     * failure rather than trusting the returned text.
     */
    leakedToolCall?: string
    /**
     * Set when the worker was killed for looping (the same tool call repeated
     * past threshold) and still looped after exhausting MAX_LOOP_RESTARTS
     * restarts. The returned text is truncated mid-stream — the caller must treat
     * this as a failure, not trust it.
     */
    loopHit?: LoopHit
    /**
     * Set when the worker's final attempt hit the per-worker wall-clock timeout
     * after exhausting its restart budget. Like loopHit, the text is partial and
     * the caller must treat it as a failure.
     */
    timedOut?: boolean
    /**
     * Set when the stall guard killed the worker: no output progress AND the
     * model endpoint unreachable. Check BEFORE `aborted` — the kill sets
     * aborted too, and mislabeling this as a user cancel hides a dead backend.
     */
    stalled?: boolean
    /**
     * Set when the command watchdog killed the worker's FINAL attempt: one tool
     * call outran `commandTimeoutMs` (a command the model never bounded). Like
     * loopHit/timedOut the text is partial — treat as a failure. Names the tool
     * so the caller's trail says which call hung rather than just "aborted".
     *
     * Check BEFORE `aborted`, same reasoning as `stalled`: the kill aborts too.
     */
    commandTimedOut?: {toolName: string; timeoutMs: number}
    /**
     * Set when the stream watchdog killed the worker's FINAL attempt: the model
     * stream produced nothing for the configured window while no tool was running.
     * Like loopHit/timedOut the text is partial — treat as a failure, and check it
     * BEFORE `aborted` (the kill aborts too), or a hung backend is mislabeled a
     * user cancel.
     */
    streamStalled?: {idleMs: number}
}

/**
 * The per-command ceiling for attempt N, halving each time a hang recurs.
 *
 * The first attempt gets the full configured ceiling — a genuinely slow build or
 * test suite deserves it. But every hang-caused restart carries
 * commandTimeoutHint, which tells the model in as many words to bound its
 * command; a SECOND hang means it ignored an explicit instruction, and a third
 * means it ignored it twice. Giving a non-complying child the full ceiling again
 * would put the worst case at 3 × 15 min = 45 minutes of dead time, resting
 * entirely on the model obeying prose. Halving bounds it at ~26 min while
 * costing a complying child nothing.
 *
 * `priorHangs` counts watchdog kills specifically, NOT total restarts — the
 * restart budget is shared with loop kills, and a child restarted for LOOPING
 * never received the bound-your-command hint, so its first hang still deserves
 * the full ceiling. Only a hang after a hang is defiance.
 *
 * Floored at 30s so repeated halving cannot shrink the ceiling to something no
 * real command could finish inside — but never ABOVE the configured ceiling
 * itself, or a caller asking for 10s would silently get 30.
 */
export function commandCeilingForAttempt(baseMs: number, priorHangs: number): number {
    if (!(baseMs > 0)) return 0
    const floor = Math.min(baseMs, 30_000)
    return Math.max(floor, Math.round(baseMs / 2 ** priorHangs))
}

/** What the command watchdog recorded when it killed an attempt. */
interface CommandKill {
    toolName: string
    timeoutMs: number
    /** The command line itself, when the tool carried one — quoted into the hint
     *  so the fresh child knows which call it must not repeat unbounded. */
    detail?: string
}

/**
 * Build the child-side command watchdog for ONE attempt: a per-tool-call timer
 * machine (shared with the main session) whose `onFire` aborts `signal`, which
 * runChild turns into a process-GROUP kill — reaping the hung command itself,
 * not just the pi child holding it.
 *
 * LIMIT: the group kill only reaches processes still IN the group. A hung
 * command that detached a daemon (setsid/nohup dev server) leaves it running —
 * the fresh attempt can then hit a port the dead attempt's escapee still holds
 * (the run-9 orphan-dev-server → false-EADDRINUSE shape). No cheap fix from
 * here; the restart hint's "check current state" line is the mitigation.
 *
 * Returns null when the watchdog is off, so the caller keeps the plain timeout
 * signal and no per-call bookkeeping happens at all.
 */
function commandWatch(timeoutMs: number): {
    onStart: (call: ToolCall) => void
    onEnd: (toolCallId: string | undefined) => void
    killed: () => CommandKill | undefined
    signal: AbortSignal
    clear: () => void
} | null {
    if (!(timeoutMs > 0)) return null
    const ctrl = new AbortController()
    // pi's toolCallId pairs start↔end. When it is absent (a fake stream in a
    // test, an older pi), fall back to one shared slot: tool executions in a
    // child are sequential, so a single slot is still correctly paired.
    const key = (id: string | undefined): string => id ?? 'anon'
    const details = new Map<string, string>()
    let killed: CommandKill | undefined

    const watchdog = new CommandWatchdog({
        getTimeoutMs: () => timeoutMs,
        ...realTimerDeps,
        onFire: (toolCallId, toolName, ms) => {
            killed = {
                toolName,
                timeoutMs: ms,
                ...(details.has(toolCallId) ? {detail: details.get(toolCallId)!} : {})
            }
            ctrl.abort()
        }
    })

    return {
        onStart: call => {
            const id = key(call.toolCallId)
            const args = call.args as {command?: unknown} | undefined
            if (typeof args?.command === 'string') {
                details.set(id, args.command.slice(0, 120))
            }
            watchdog.onStart(id, call.name)
        },
        onEnd: id => watchdog.onEnd(key(id)),
        killed: () => killed,
        signal: ctrl.signal,
        clear: () => watchdog.clearAll()
    }
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
    const tools = input.tools ?? DEFAULT_TOOLS
    const baseArgs = [...childBaseArgs(input.extensions ?? []), '--mode', 'json', '--tools', tools]
    const timeoutMs = input.timeoutMs ?? RESEARCH_WORKER_TIMEOUT_MS
    let hint: string | null = null
    // Loop-kill and timeout share one restart budget, mirroring
    // runPhaseWithLoopGuard: a runaway worker gets re-spawned with a corrective
    // hint up to MAX_LOOP_RESTARTS times before we give up. Leaked tool calls
    // keep their own MAX_LEAK_RETRIES budget below — a different failure mode.
    let restarts = 0
    // Watchdog kills specifically — drives the ceiling halving. Kept apart from
    // `restarts` (the shared budget) so a loop-caused restart doesn't shorten
    // the rope of a child that has never hung (see commandCeilingForAttempt).
    let hangKills = 0
    let leakRetries = 0
    for (;;) {
        const prompt = hint === null ? input.prompt : `${hint}\n\n${input.prompt}`
        const invocation = getPiInvocation([...baseArgs], prompt)
        const tStart = Date.now()
        let tFirstByte: number | null = null
        // loop === false turns the guard off entirely (detector is null and no
        // tool call is ever flagged); otherwise build a detector from the override
        // or the default research/impl thresholds.
        const loopDetector =
            input.loop === false ?
                null
            :   (() => {
                    const window = input.loop?.window ?? LOOP_WINDOW
                    const threshold = input.loop?.threshold ?? LOOP_THRESHOLD
                    return new LoopDetector(
                        window,
                        threshold,
                        input.loop?.pathThreshold ?? threshold
                    )
                })()
        // Capture the hit the detector reports (it also returns it to the unified
        // runner, which kills the child on a hit). Without capturing it here the
        // SIGTERM that kill produces would surface as a bare non-zero exit the
        // caller couldn't distinguish from a crash.
        let loopHit: LoopHit | undefined
        // Reset EACH attempt: on a restart the previous attempt's calls are
        // discarded with its text, so the count must describe only the attempt
        // whose text this call returns.
        let groundingRetrievalCount = 0
        const timeout = workerTimeout(input.signal, timeoutMs)
        // Per-tool-call watchdog for this attempt (null when off). Its abort is
        // OR'd with the worker timeout / external cancel into the child's signal.
        const cmdWatch = commandWatch(
            commandCeilingForAttempt(input.commandTimeoutMs ?? 0, hangKills)
        )
        const childSignal =
            cmdWatch ? AbortSignal.any([timeout.signal, cmdWatch.signal]) : timeout.signal
        let result
        try {
            result = await runChildDefault(
                invocation,
                input.cwd,
                childSignal,
                {
                    mode: 'json-events',
                    ...(input.stall === false ?
                        {}
                    :   {
                            stall: {
                                afterMs: input.stall?.afterMs ?? STALL_AFTER_MS,
                                probe:
                                    input.stall?.probe
                                    ?? (() => probeModelEndpoints(discoverModelEndpoints()))
                            }
                        }),
                    ...(input.streamInactivityMs ?
                        {streamInactivityMs: input.streamInactivityMs}
                    :   {}),
                    onFirstByte: () => (tFirstByte = Date.now()),
                    onToolCall: call => {
                        cmdWatch?.onStart(call)
                        if (isGroundingRetrieval(call.name)) groundingRetrievalCount++
                        if (!loopDetector) return null
                        const hit = loopDetector.record(call)
                        if (hit && !loopHit) loopHit = hit
                        return hit
                    },
                    onLine: input.onLine,
                    // Always wired when the watchdog is on — the sink only emits
                    // tool_execution_end if a handler exists, and without it every
                    // timer would stay armed and fire on a finished command.
                    onToolResult:
                        cmdWatch ?
                            r => {
                                cmdWatch.onEnd(r.toolCallId)
                                input.onToolResult?.(r)
                            }
                        :   input.onToolResult,
                    onContextUsage: input.onContextUsage
                },
                input.spawn
            )
        } finally {
            timeout.cleanup()
            cmdWatch?.clear()
        }
        const tEnd = Date.now()
        const waitMs = tFirstByte === null ? tEnd - tStart : tFirstByte - tStart
        const workMs = tFirstByte === null ? 0 : tEnd - tFirstByte
        const text = result.text ?? ''
        const timedOut = timeout.timedOut()
        const commandKill = cmdWatch?.killed()
        const streamStalled = result.streamStalled

        // A loop-kill gets the same restart-with-hint treatment every other phase
        // already gets (runPhaseWithLoopGuard) — name the offending call so the
        // re-spawn avoids it. Bounded by the shared restart budget.
        if (loopHit && restarts < MAX_LOOP_RESTARTS) {
            hint = formatLoopHint(loopHit)
            restarts++
            continue
        }
        // A hung COMMAND is restartable too, on the same budget, but checked
        // before the whole-worker timeout because its hint is the specific one:
        // bound the command. (The two can't be confused — a watchdog kill leaves
        // timeout.timedOut() false, since that flag tracks only its own timer.)
        if (commandKill && !loopHit && restarts < MAX_LOOP_RESTARTS) {
            hint = commandTimeoutHint(commandKill.toolName, commandKill.timeoutMs, {
                commandDetail: commandKill.detail,
                // Nothing reverts the tree between attempts, so a child that can
                // mutate it (edit/write, or bash side effects) must not be told
                // its previous attempt left no trace. Same capability test the
                // gate logger uses — decided by tools, not by phase.
                editsMayPersist: /\b(?:edit|bash|write)\b/.test(tools)
            })
            restarts++
            hangKills++
            continue
        }
        // A hung model stream is restartable on the same budget. Checked before
        // the wall-clock timeout because it is the more specific diagnosis (and
        // its hint does not blame the model: nothing it did caused the hang).
        if (streamStalled && !loopHit && restarts < MAX_LOOP_RESTARTS) {
            hint = streamStallHint(streamStalled.idleMs)
            restarts++
            continue
        }
        // A wall-clock timeout (the backstop for varied thrash the exact-match
        // detector misses) is also restartable, sharing the same budget. Skip when
        // a loop also tripped — the loop hint above is more specific.
        if (timedOut && !loopHit && restarts < MAX_LOOP_RESTARTS) {
            hint = WORKER_TIMEOUT_HINT
            restarts++
            continue
        }
        // Only treat output as a leak on a clean, complete run — a non-zero exit
        // or abort yields partial text the caller already handles, and detecting
        // there would just mislabel the real failure.
        const leaked = result.exitCode === 0 && !result.aborted ? detectLeakedToolCall(text) : null
        if (leaked && leakRetries < MAX_LEAK_RETRIES) {
            hint = leakedToolCallHint(leaked)
            leakRetries++
            continue
        }
        return {
            text,
            exitCode: result.exitCode,
            stderr: result.stderr.trim(),
            aborted: result.aborted,
            waitMs,
            workMs,
            sawOutput: tFirstByte !== null,
            groundingRetrievalCount,
            ...(result.modelError ? {modelError: result.modelError} : {}),
            ...(leaked ? {leakedToolCall: leaked} : {}),
            ...(loopHit ? {loopHit} : {}),
            ...(timedOut ? {timedOut: true} : {}),
            ...(result.stalled ? {stalled: true} : {}),
            ...(streamStalled ? {streamStalled} : {}),
            ...(commandKill ?
                {
                    commandTimedOut: {
                        toolName: commandKill.toolName,
                        timeoutMs: commandKill.timeoutMs
                    }
                }
            :   {})
        }
    }
}
