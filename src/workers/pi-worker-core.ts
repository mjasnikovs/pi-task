import {getPiInvocation} from '../shared/pi-invocation.js'
import {CHILD_BASE_ARGS, runChildDefault, type SpawnFn} from '../shared/child-process.js'
import {LoopDetector} from '../task/loop-detector.js'
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
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
    const tools = input.tools ?? DEFAULT_TOOLS
    const extensionArgs = (input.extensions ?? []).flatMap(e => ['-e', e])
    const baseArgs = [...extensionArgs, ...CHILD_BASE_ARGS, '--mode', 'json', '--tools', tools]
    let hint: string | null = null
    for (let attempt = 0; ; attempt++) {
        const prompt = hint === null ? input.prompt : `${hint}\n\n${input.prompt}`
        const invocation = getPiInvocation([...baseArgs, prompt])
        const tStart = Date.now()
        let tFirstByte: number | null = null
        const loopDetector = new LoopDetector(20, 5)
        const result = await runChildDefault(
            invocation,
            input.cwd,
            input.signal,
            {
                mode: 'json-events',
                onFirstByte: () => (tFirstByte = Date.now()),
                onToolCall: call => loopDetector.record(call),
                onLine: input.onLine
            },
            input.spawn
        )
        const tEnd = Date.now()
        const waitMs = tFirstByte === null ? tEnd - tStart : tFirstByte - tStart
        const workMs = tFirstByte === null ? 0 : tEnd - tFirstByte
        const text = result.text ?? ''
        // Only treat output as a leak on a clean, complete run — a non-zero exit
        // or abort yields partial text the caller already handles, and detecting
        // there would just mislabel the real failure.
        const leaked = result.exitCode === 0 && !result.aborted ? detectLeakedToolCall(text) : null
        if (leaked && attempt < MAX_LEAK_RETRIES) {
            hint = leakedToolCallHint(leaked)
            continue
        }
        return {
            text,
            exitCode: result.exitCode,
            stderr: result.stderr.trim(),
            aborted: result.aborted,
            waitMs,
            workMs,
            ...(leaked ? {leakedToolCall: leaked} : {})
        }
    }
}
