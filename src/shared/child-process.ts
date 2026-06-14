import {spawn as defaultSpawn} from 'node:child_process'
import type {EventEmitter} from 'node:events'

/** Grace period between SIGTERM and SIGKILL (ms). */
export const KILL_GRACE_MS = 5000

/** Base flags shared by all child pi invocations. */
export const CHILD_BASE_ARGS = [
    '--print',
    '--no-skills',
    '--no-extensions',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-session'
] as const

// ─── Spawn interface ─────────────────────────────────────────────────────────

export interface ProcLike extends EventEmitter {
    stdout: EventEmitter | null
    stderr: EventEmitter | null
    killed: boolean
    kill(signal: string): boolean | void
}

export type SpawnFn = (
    command: string,
    args: ReadonlyArray<string>,
    options: {cwd: string; shell: boolean; stdio: ['ignore', 'pipe', 'pipe']}
) => ProcLike

// ─── Result types ────────────────────────────────────────────────────────────

export interface ChildResult {
    stdout: string
    stderr: string
    exitCode: number
    aborted: boolean
    /** Extracted assistant text (only populated in json-events mode). */
    text?: string
}

// ─── JSON event-stream types (for mode: 'json-events') ──────────────────────

export interface ToolCall {
    name: string
    args: unknown
}

export interface LoopHit {
    call: ToolCall
    count: number
    windowSize: number
}

export interface ContextSnapshot {
    tokens: number
    contextWindow: number
    percent: number
}

// ─── Options for unified runChild ────────────────────────────────────────────

export interface RunChildTextOptions {
    mode: 'text'
    /**
     * Drop stdout chunks instead of buffering them into the result. Use for
     * pipe-through tools (npm install, build commands) where we only need the
     * exit code and stderr — verbose stdout can exceed V8's max string length.
     */
    discardStdout?: boolean
    /**
     * Fires exactly once on the first stdout data chunk. Lets callers split
     * total elapsed into wait-for-first-byte vs generation time — useful when
     * concurrent children may queue on an upstream slot (e.g. model API
     * concurrency caps) before producing output.
     */
    onFirstByte?: () => void
}

export interface RunChildJsonEventsOptions {
    mode: 'json-events'
    onLine?: (line: string) => void
    onContextUsage?: (snapshot: ContextSnapshot) => void
    onToolCall?: (call: ToolCall) => LoopHit | null
    onFirstByte?: () => void
}

export type RunChildOptions = RunChildTextOptions | RunChildJsonEventsOptions

// ─── JSON event-stream sink ──────────────────────────────────────────────────

/**
 * Parses a child's `--mode json` event stream into assistant text plus side
 * effects (caller callbacks, loop-kill). It holds the cross-chunk line buffer
 * and the text-assembly state, so event interpretation is independent of the
 * spawn/kill machinery in runChild — and therefore unit-testable without a real
 * child: construct one, `feed()` raw lines, assert on `text` / the callbacks /
 * the onLoopKill signal.
 */
export class JsonEventSink {
    /** Final assistant text from the agent_end event, if one arrived. */
    finalText = ''
    private textDeltaAccum = ''
    // json-events lines can split across data chunks; this holds the trailing
    // partial line between feeds so events spanning a boundary still parse. We
    // deliberately do NOT accumulate the full raw stream: a long-running child
    // emits hundreds of MB of events and buffering it would overflow V8's max
    // string length (≈512MB). We keep only the parsed text.
    private buf = ''

    constructor(
        private readonly opts: RunChildJsonEventsOptions,
        /** Invoked when onToolCall reports a loop hit — runChild kills the child. */
        private readonly onLoopKill: () => void
    ) {}

    /** Feed a raw stdout chunk: parse every complete line, buffer the partial tail. */
    feed(chunk: string): void {
        this.buf += chunk
        let nl: number
        while ((nl = this.buf.indexOf('\n')) !== -1) {
            const line = this.buf.slice(0, nl).trim()
            this.buf = this.buf.slice(nl + 1)
            if (line.length === 0) continue
            try {
                const evt = JSON.parse(line) as Record<string, unknown>
                if (evt && typeof evt === 'object') this.handleEvent(evt)
            } catch {
                // Non-JSON line (startup banner, etc.) — ignore.
            }
        }
    }

    /** Flush a trailing event that wasn't newline-terminated (call on close). */
    flush(): void {
        if (this.buf.trim().length > 0) this.feed('\n')
        this.buf = ''
    }

    /** Extracted assistant text: the agent_end text if present, else the deltas. */
    get text(): string {
        return (this.finalText || this.textDeltaAccum).trim()
    }

    private handleEvent(evt: Record<string, unknown>): void {
        const opts = this.opts
        const t = typeof evt.type === 'string' ? evt.type : ''

        if (t === 'context_usage' && opts.onContextUsage) {
            const tokens = Number(evt.tokens ?? 0)
            const contextWindow = Number(evt.contextWindow ?? 0)
            const percent = Number(evt.percent ?? 0)
            if (tokens > 0 || contextWindow > 0) {
                opts.onContextUsage({tokens, contextWindow, percent})
            }
            return
        }

        if (t === 'message_end' && opts.onContextUsage) {
            const msg = evt.message as Record<string, unknown> | undefined
            if (msg?.role === 'assistant') {
                const usage = msg.usage as Record<string, unknown> | undefined
                if (usage) {
                    const tokens =
                        Number(usage.input ?? 0)
                        + Number(usage.cacheRead ?? 0)
                        + Number(usage.cacheWrite ?? 0)
                        + Number(usage.output ?? 0)
                    if (tokens > 0) {
                        opts.onContextUsage({tokens, contextWindow: 0, percent: 0})
                    }
                }
            }
            return
        }

        if (t === 'agent_end' && Array.isArray(evt.messages)) {
            for (let i = evt.messages.length - 1; i >= 0; i--) {
                const m = evt.messages[i] as Record<string, unknown> | undefined
                if (m && m.role === 'assistant' && Array.isArray(m.content)) {
                    const texts: string[] = []
                    for (const c of m.content as Array<Record<string, unknown>>) {
                        if (c?.type === 'text' && typeof c.text === 'string') {
                            texts.push(c.text)
                        }
                    }
                    if (texts.length > 0) {
                        this.finalText = texts.join('')
                        break
                    }
                }
            }
            return
        }

        if (t === 'message_update') {
            const ame = evt.assistantMessageEvent as Record<string, unknown> | undefined
            const ameType = ame && typeof ame.type === 'string' ? ame.type : ''
            if (ameType === 'text_start') {
                this.textDeltaAccum = ''
                if (opts.onLine) opts.onLine('writing answer…')
            } else if (ameType === 'text_delta' && typeof ame!.delta === 'string') {
                this.textDeltaAccum += ame!.delta as string
            } else if (ameType === 'thinking_start' && opts.onLine) {
                opts.onLine('thinking…')
            }
            return
        }

        if (t === 'tool_execution_start') {
            const tn = typeof evt.toolName === 'string' ? evt.toolName : 'tool'
            if (opts.onLine) {
                const detail = summarizeToolArgs(tn, evt.args)
                opts.onLine(detail ? `${tn}: ${detail}` : tn)
            }
            if (opts.onToolCall) {
                const hit = opts.onToolCall({name: tn, args: evt.args})
                if (hit) this.onLoopKill()
            }
        }
    }
}

// ─── Unified runChild ────────────────────────────────────────────────────────

export function runChild(
    spawn: SpawnFn,
    invocation: {command: string; args: ReadonlyArray<string>},
    cwd: string,
    signal: AbortSignal | undefined,
    opts?: RunChildOptions
): Promise<ChildResult> {
    return new Promise(resolve => {
        let stdout = ''
        let stderr = ''
        let aborted = false
        const discardStdout = opts?.mode === 'text' && opts.discardStdout === true

        const proc = spawn(invocation.command, invocation.args, {
            cwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe']
        })

        // One kill path, shared by user-abort and loop-kill: SIGTERM, then
        // SIGKILL after a grace period if the child ignored the term.
        const killProc = (): void => {
            aborted = true
            proc.kill('SIGTERM')
            setTimeout(() => {
                if (!proc.killed) proc.kill('SIGKILL')
            }, KILL_GRACE_MS)
        }

        const sink = opts?.mode === 'json-events' ? new JsonEventSink(opts, killProc) : null

        let firstByteFired = false
        proc.stdout?.on('data', (d: Buffer) => {
            if (!firstByteFired) {
                firstByteFired = true
                opts?.onFirstByte?.()
            }
            if (discardStdout) return
            const chunk = d.toString()
            if (sink) sink.feed(chunk)
            else stdout += chunk
        })
        proc.stderr?.on('data', (d: Buffer) => {
            stderr += d.toString()
        })
        proc.on('close', (code: number | null) => {
            if (sink) sink.flush()
            const text = sink ? sink.text : undefined
            resolve({stdout, stderr, exitCode: code ?? 0, aborted, text})
        })
        proc.on('error', () => {
            resolve({stdout, stderr, exitCode: 1, aborted})
        })

        if (signal) {
            if (signal.aborted) killProc()
            else signal.addEventListener('abort', killProc, {once: true})
        }
    })
}

// ─── Convenience: spawn with default node child_process ──────────────────────

export function runChildDefault(
    invocation: {command: string; args: ReadonlyArray<string>},
    cwd: string,
    signal: AbortSignal | undefined,
    opts?: RunChildOptions,
    spawnFn?: SpawnFn
): Promise<ChildResult> {
    return runChild(spawnFn ?? (defaultSpawn as unknown as SpawnFn), invocation, cwd, signal, opts)
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

export function summarizeToolArgs(toolName: string, args: unknown): string {
    if (!args || typeof args !== 'object') return ''
    const a = args as Record<string, unknown>
    if (toolName === 'bash' && typeof a.command === 'string') {
        return a.command.replace(/\s+/g, ' ').trim()
    }
    if (
        toolName === 'pi-worker-docs'
        && typeof a.module === 'string'
        && typeof a.query === 'string'
    ) {
        const q = a.query.replace(/\s+/g, ' ').trim()
        const truncated = q.length > 60 ? q.slice(0, 59) + '…' : q
        return `${a.module} "${truncated}"`
    }
    if (typeof a.file_path === 'string') return a.file_path
    if (typeof a.path === 'string') return a.path
    if (typeof a.filePath === 'string') return a.filePath
    if (typeof a.pattern === 'string') return a.pattern
    return ''
}
