import {getPiInvocation} from '../shared/pi-invocation.js'
import {CHILD_BASE_ARGS, runChildDefault, type SpawnFn} from '../shared/child-process.js'
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

// `--mode json` makes pi emit structured events as they happen instead of
// buffering the assistant text and flushing on exit. That matters for the
// wait/work timing split: in text mode the first stdout chunk only arrives at
// the very end, so onFirstByte fires moments before close and workMs is
// effectively zero. With JSON events the first byte lands as soon as the
// model starts producing — making waitMs the real queue/cold-start cost and
// workMs the real generation+tool-call cost.
const DEFAULT_TOOLS = 'read,grep,find,ls'

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

/** Restart hint after a wall-clock timeout — distinct from the loop hint. */
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
    /** Extension entry-point paths to load via `-e <path>` before CHILD_BASE_ARGS. */
    extensions?: string[]
    /** Called for each tool execution start and text-writing event inside the worker. */
    onLine?: (line: string) => void
    /** Per-worker wall-clock timeout in ms. Defaults to RESEARCH_WORKER_TIMEOUT_MS. */
    timeoutMs?: number
    /**
     * Per-worker loop-detector tuning. Defaults to the read-only research/impl
     * guard (LOOP_WINDOW / LOOP_THRESHOLD, path threshold = exact threshold). An
     * edit/fix pass legitimately revisits one file, so it can raise (or disable
     * via Infinity) `pathThreshold` to keep only the exact-match guard.
     */
    loop?: {window?: number; threshold?: number; pathThreshold?: number}
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
    const timer = setTimeout(() => {
        timedOut = true
        ctrl.abort()
    }, ms)
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
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
    const tools = input.tools ?? DEFAULT_TOOLS
    const extensionArgs = (input.extensions ?? []).flatMap(e => ['-e', e])
    const baseArgs = [...extensionArgs, ...CHILD_BASE_ARGS, '--mode', 'json', '--tools', tools]
    const timeoutMs = input.timeoutMs ?? RESEARCH_WORKER_TIMEOUT_MS
    let hint: string | null = null
    // Loop-kill and timeout share one restart budget, mirroring
    // runPhaseWithLoopGuard: a runaway worker gets re-spawned with a corrective
    // hint up to MAX_LOOP_RESTARTS times before we give up. Leaked tool calls
    // keep their own MAX_LEAK_RETRIES budget below — a different failure mode.
    let restarts = 0
    let leakRetries = 0
    for (;;) {
        const prompt = hint === null ? input.prompt : `${hint}\n\n${input.prompt}`
        const invocation = getPiInvocation([...baseArgs, prompt])
        const tStart = Date.now()
        let tFirstByte: number | null = null
        const loopWindow = input.loop?.window ?? LOOP_WINDOW
        const loopThreshold = input.loop?.threshold ?? LOOP_THRESHOLD
        const loopDetector = new LoopDetector(
            loopWindow,
            loopThreshold,
            input.loop?.pathThreshold ?? loopThreshold
        )
        // Capture the hit the detector reports (it also returns it to the unified
        // runner, which kills the child on a hit). Without capturing it here the
        // SIGTERM that kill produces would surface as a bare non-zero exit the
        // caller couldn't distinguish from a crash.
        let loopHit: LoopHit | undefined
        const timeout = workerTimeout(input.signal, timeoutMs)
        let result
        try {
            result = await runChildDefault(
                invocation,
                input.cwd,
                timeout.signal,
                {
                    mode: 'json-events',
                    onFirstByte: () => (tFirstByte = Date.now()),
                    onToolCall: call => {
                        const hit = loopDetector.record(call)
                        if (hit && !loopHit) loopHit = hit
                        return hit
                    },
                    onLine: input.onLine
                },
                input.spawn
            )
        } finally {
            timeout.cleanup()
        }
        const tEnd = Date.now()
        const waitMs = tFirstByte === null ? tEnd - tStart : tFirstByte - tStart
        const workMs = tFirstByte === null ? 0 : tEnd - tFirstByte
        const text = result.text ?? ''
        const timedOut = timeout.timedOut()

        // A loop-kill gets the same restart-with-hint treatment every other phase
        // already gets (runPhaseWithLoopGuard) — name the offending call so the
        // re-spawn avoids it. Bounded by the shared restart budget.
        if (loopHit && restarts < MAX_LOOP_RESTARTS) {
            hint = formatLoopHint(loopHit)
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
            ...(leaked ? {leakedToolCall: leaked} : {}),
            ...(loopHit ? {loopHit} : {}),
            ...(timedOut ? {timedOut: true} : {})
        }
    }
}
