import {getPiInvocation} from '../shared/pi-invocation.js'
import {CHILD_BASE_ARGS, runChildDefault, type SpawnFn} from '../shared/child-process.js'
import {LoopDetector} from '../task/loop-detector.js'

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
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
    const tools = input.tools ?? DEFAULT_TOOLS
    const childArgs = [...CHILD_BASE_ARGS, '--mode', 'json', '--tools', tools]
    const invocation = getPiInvocation([...childArgs, input.prompt])
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
            onToolCall: call => loopDetector.record(call)
        },
        input.spawn
    )
    const tEnd = Date.now()
    const waitMs = tFirstByte === null ? tEnd - tStart : tFirstByte - tStart
    const workMs = tFirstByte === null ? 0 : tEnd - tFirstByte
    return {
        text: result.text ?? '',
        exitCode: result.exitCode,
        stderr: result.stderr.trim(),
        aborted: result.aborted,
        waitMs,
        workMs
    }
}
