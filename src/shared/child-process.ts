import {spawn as defaultSpawn, spawnSync as spawnSyncDefault} from 'node:child_process'
import type {EventEmitter} from 'node:events'
import {realStreamTimerDeps, StreamWatchdog} from './stream-watchdog.js'

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

/** The subset of a child's stdin we use: write the prompt, then close it. */
export interface WritableLike {
    write(chunk: string): boolean
    end(): void
}

export interface ProcLike extends EventEmitter {
    /** Present only when the child was spawned with stdin 'pipe' (prompt delivery). */
    stdin: WritableLike | null
    stdout: EventEmitter | null
    stderr: EventEmitter | null
    killed: boolean
    /** OS pid; used to signal the child's whole process GROUP (orphan reaping). May
     *  be undefined for a mock spawn or a spawn that failed. */
    pid?: number
    kill(signal: string): boolean | void
}

export type SpawnFn = (
    command: string,
    args: ReadonlyArray<string>,
    options: {
        cwd: string
        shell: boolean
        stdio: ['ignore' | 'pipe', 'pipe', 'pipe']
        /** Set only when the invocation needs env overrides (e.g. GIT_INDEX_FILE);
         *  absent → the child inherits this process's environment as before. */
        env?: NodeJS.ProcessEnv
        /** true → give the child its own process group (POSIX `detached`), so any
         *  server it backgrounds (`bun run dev &`) can be reaped as a group when the
         *  child exits instead of leaking as an orphan holding a port (mx5 run 9
         *  item 3). Set only for model children (json-events); plumbing stays put. */
        detached?: boolean
    }
) => ProcLike

// ─── Result types ────────────────────────────────────────────────────────────

export interface ChildResult {
    stdout: string
    stderr: string
    exitCode: number
    aborted: boolean
    /** Extracted assistant text (only populated in json-events mode). */
    text?: string
    /**
     * The model-failure cause, when the child's final turn carried
     * stopReason "error" (provider/connection failure after pi exhausted its
     * own retries). pi emits this as an agent_end whose assistant message has
     * empty text, so without it the phase would mis-report "produced no output".
     * Only populated in json-events mode.
     */
    modelError?: string
    /**
     * true when the stall guard killed the child: no output for the stall
     * window AND the model endpoint probe found the backend unreachable.
     * Callers must check this BEFORE `aborted` — the kill sets aborted too,
     * and without the flag it would mislabel as a user cancel.
     */
    stalled?: boolean
    /**
     * true when the STREAM watchdog killed the child: no output at all for the
     * configured inactivity window, regardless of whether the backend answers a
     * probe. Distinct from `stalled`, which requires an UNREACHABLE endpoint —
     * the run-14 hangs had a perfectly healthy server and a dead stream, so the
     * probe path could never fire. Callers must check this BEFORE `aborted`
     * (the kill sets aborted too) and route it into the connection-error retry.
     */
    streamStalled?: {idleMs: number}
}

// ─── JSON event-stream types (for mode: 'json-events') ──────────────────────

export interface ToolCall {
    name: string
    args: unknown
    /**
     * pi's id for this tool call, carried on both `tool_execution_start` and
     * `tool_execution_end` so a caller can pair them (the command watchdog arms
     * on start and disarms on the matching end). Optional because the loop
     * detector — the other consumer — keys on name+args and never needs it.
     */
    toolCallId?: string
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
    /**
     * Fires when a tool call finishes, carrying its RESULT (mx5 run 10 item 6: the
     * verify debug log recorded the `bash:` command but never its output, so "verify
     * claimed curl PASS on a server that cannot serve" was undecidable from the log).
     * Text is the tool's combined output; `isError` distinguishes a failed call.
     */
    onToolResult?: (result: {
        name: string
        isError: boolean
        text: string
        toolCallId?: string
    }) => void
    onFirstByte?: () => void
    /**
     * Dead-backend stall guard (mx5 run 7: model server died mid-child, the
     * child hung MUTE for 64 minutes). Liveness is OUTPUT PROGRESS, not wall
     * time: any stdout/stderr chunk resets the window, so honest long work is
     * never killed. Only when nothing arrived for `afterMs` is `probe` asked
     * whether the model backend is reachable — reachable → keep waiting
     * (prompt processing legitimately emits nothing for minutes); unreachable
     * → the child is killed and the result carries `stalled: true` so callers
     * report the real cause instead of hanging or mislabeling a user cancel.
     */
    stall?: {afterMs: number; probe: () => Promise<boolean>}
    /**
     * Stream-inactivity ceiling in ms (shared/stream-watchdog.ts). Unlike `stall`
     * this asks NOTHING of the backend: a stream that has produced no bytes for
     * this long is dead whether or not the server answers a health probe, which
     * is exactly the run-14 shape (server Up(healthy), stream silent for hours).
     * Any stdout/stderr chunk resets it, so a slow model emitting one token every
     * 30s is never killed. 0 / omitted = off.
     */
    streamInactivityMs?: number
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
    /**
     * Set when the final assistant turn carried stopReason "error" — i.e. the
     * model/provider failed (disconnect, fetch failed, socket hang up, 5xx)
     * after pi exhausted its internal retries. Holds the provider's errorMessage
     * so callers can report the real cause instead of an empty completion.
     *
     * CLEARED when a LATER agent_end delivers assistant text: pi retries a failed
     * turn itself (`auto_retry_start`) and each attempt emits its own agent_end,
     * so a recovered blip arrives as agent_end(stopReason "error", empty) followed
     * by agent_end(text). Measured live against a proxy that drops the first
     * connection: pi makes up to 4 attempts over ~15s, and on attempts 1–3 the
     * child returns the real answer WITH the dead first attempt's errorMessage
     * still in the stream. Latching that would report a failure for a run that
     * succeeded. An error AFTER the last text-bearing turn still latches — that
     * one really did lose the tail of the work.
     */
    modelError: string | undefined = undefined
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
            // Errors latched by THIS batch describe a turn that failed AFTER the
            // text found below it (the scan runs backwards), so they survive; only
            // an error from an earlier agent_end is cleared by a later answer.
            let latchedHere = false
            for (let i = evt.messages.length - 1; i >= 0; i--) {
                const m = evt.messages[i] as Record<string, unknown> | undefined
                if (!m || m.role !== 'assistant') continue
                // A model failure (disconnect, fetch failed, socket hang up, 5xx
                // after pi's own retries) arrives as an assistant message with
                // stopReason "error" and the real cause in errorMessage — but
                // EMPTY text content. Capture it so the phase reports the actual
                // failure instead of the useless "produced no output".
                if (
                    m.stopReason === 'error'
                    && typeof m.errorMessage === 'string'
                    && m.errorMessage.length > 0
                    && this.modelError === undefined
                ) {
                    this.modelError = m.errorMessage
                    latchedHere = true
                }
                if (Array.isArray(m.content)) {
                    const texts: string[] = []
                    for (const c of m.content as Array<Record<string, unknown>>) {
                        if (c?.type === 'text' && typeof c.text === 'string') {
                            texts.push(c.text)
                        }
                    }
                    if (texts.length > 0) {
                        this.finalText = texts.join('')
                        // This turn answered, so an error latched by an EARLIER
                        // agent_end was a blip pi retried past — drop it.
                        if (!latchedHere) this.modelError = undefined
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
            const id = typeof evt.toolCallId === 'string' ? evt.toolCallId : undefined
            if (opts.onLine) {
                const detail = summarizeToolArgs(tn, evt.args)
                opts.onLine(detail ? `${tn}: ${detail}` : tn)
            }
            if (opts.onToolCall) {
                const hit = opts.onToolCall({name: tn, args: evt.args, toolCallId: id})
                if (hit) this.onLoopKill()
            }
            return
        }

        if (t === 'tool_execution_end' && opts.onToolResult) {
            const tn = typeof evt.toolName === 'string' ? evt.toolName : 'tool'
            const id = typeof evt.toolCallId === 'string' ? evt.toolCallId : undefined
            const res = evt.result as Record<string, unknown> | undefined
            const text = toolResultText(res?.content)
            opts.onToolResult({name: tn, isError: evt.isError === true, text, toolCallId: id})
        }
    }
}

/** Flatten a tool result's `content` array (pi's `{type,text}[]`) into one string. */
function toolResultText(content: unknown): string {
    if (!Array.isArray(content)) return ''
    const parts: string[] = []
    for (const c of content as Array<Record<string, unknown>>) {
        if (c?.type === 'text' && typeof c.text === 'string') parts.push(c.text)
    }
    return parts.join('')
}

// ─── Unified runChild ────────────────────────────────────────────────────────

export function runChild(
    spawn: SpawnFn,
    invocation: {
        command: string
        args: ReadonlyArray<string>
        stdin?: string
        env?: NodeJS.ProcessEnv
    },
    cwd: string,
    signal: AbortSignal | undefined,
    opts?: RunChildOptions
): Promise<ChildResult> {
    return new Promise(resolve => {
        let stdout = ''
        let stderr = ''
        let aborted = false
        const discardStdout = opts?.mode === 'text' && opts.discardStdout === true

        // Deliver the prompt on stdin, not argv: a large prompt (e.g. an inlined
        // design doc) blows past the OS command-line limit — Windows CreateProcessW
        // caps it at 32767 chars and Node throws `spawn ENAMETOOLONG`. When a
        // prompt is present we open stdin as a pipe; otherwise keep it 'ignore'
        // (git and other arg-only spawns are unaffected). See GitHub issue #1.
        const usesStdin = invocation.stdin !== undefined
        // Model children (json-events) run arbitrary bash — they can `bun run dev &`
        // a server that outlives the child and holds a port, wrecking the final gate
        // with a self-inflicted EADDRINUSE (mx5 run 9 item 3). Spawn them in their
        // OWN process group so every such grandchild can be reaped as a unit on exit.
        // Plumbing (git, mode:'text') never backgrounds anything and stays in-group.
        const ownGroup = opts?.mode === 'json-events'
        const proc = spawn(invocation.command, invocation.args, {
            cwd,
            shell: false,
            stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
            ...(ownGroup ? {detached: true} : {}),
            ...(invocation.env ? {env: invocation.env} : {})
        })

        if (usesStdin) {
            // pi reads the prompt from stdin and waits for EOF, so write then end.
            proc.stdin?.write(invocation.stdin as string)
            proc.stdin?.end()
        }

        // Reap the child's whole process group — the child itself AND anything it
        // backgrounded. No-op unless the child owns a group (ownGroup) and we have a
        // pid; ESRCH (group already gone) is swallowed. POSIX: negative-pid signals
        // the group; Windows has no groups, so taskkill /T tears down the tree.
        const reapGroup = (sig: NodeJS.Signals): void => {
            if (!ownGroup || !proc.pid) return
            try {
                if (process.platform === 'win32') {
                    spawnSyncDefault('taskkill', ['/pid', String(proc.pid), '/T', '/F'])
                } else {
                    process.kill(-proc.pid, sig)
                }
            } catch {
                // group already gone
            }
        }

        // One kill path, shared by user-abort and loop-kill: SIGTERM, then SIGKILL
        // after a grace period if the child ignored the term. For a group-owning
        // (model) child, ALSO sweep the group so anything it backgrounded dies with
        // it — proc.kill hits only the leader, reapGroup the grandchildren.
        const killProc = (): void => {
            aborted = true
            proc.kill('SIGTERM')
            if (ownGroup) reapGroup('SIGTERM')
            setTimeout(() => {
                if (!proc.killed) proc.kill('SIGKILL')
                if (ownGroup) reapGroup('SIGKILL')
            }, KILL_GRACE_MS)
        }

        // Stream watchdog (json-events children only): a silent stream is killed
        // even when the backend is healthy — the case the probe-based stall guard
        // below structurally cannot catch. Suspended for the duration of a tool
        // call: a 12-minute build legitimately emits nothing, and that window is
        // the COMMAND watchdog's to police, not this one's.
        let streamStalledIdleMs: number | undefined
        const streamWatch =
            opts?.mode === 'json-events' && (opts.streamInactivityMs ?? 0) > 0 ?
                new StreamWatchdog({
                    getTimeoutMs: () => opts.streamInactivityMs!,
                    ...realStreamTimerDeps,
                    onFire: idleMs => {
                        streamStalledIdleMs = idleMs
                        killProc()
                    }
                })
            :   null
        streamWatch?.start()

        // The sink sees the child's parsed events; tool start/end are what tell
        // the watchdog to pause and resume. Wrapping the caller's handlers keeps
        // that wiring invisible to callers — and onToolResult must be present for
        // the sink to emit tool_execution_end at all, so it is always supplied
        // when the watchdog is on.
        const sinkOpts: RunChildJsonEventsOptions | null =
            opts?.mode !== 'json-events' ? null
            : streamWatch ?
                {
                    ...opts,
                    onToolCall: call => {
                        // Keyed: a child's tool batch runs in parallel too, so the
                        // first result must not un-pause a still-running sibling.
                        streamWatch.suspend(call.toolCallId)
                        return opts.onToolCall ? opts.onToolCall(call) : null
                    },
                    onToolResult: r => {
                        streamWatch.resume(r.toolCallId)
                        opts.onToolResult?.(r)
                    }
                }
            :   opts
        const sink = sinkOpts ? new JsonEventSink(sinkOpts, killProc) : null

        // Dead-backend stall guard (json-events children only; see the option
        // docs). Any output resets the window; a reachable probe also resets it
        // so the next probe is a full window away, not every tick.
        const stall = opts?.mode === 'json-events' ? opts.stall : undefined
        let lastActivity = Date.now()
        let stalled = false
        let probing = false
        const stallTimer =
            stall ?
                setInterval(
                    () => {
                        if (probing || Date.now() - lastActivity < stall.afterMs) return
                        probing = true
                        stall
                            .probe()
                            .then(reachable => {
                                probing = false
                                if (reachable || stalled) {
                                    lastActivity = Date.now()
                                    return
                                }
                                stalled = true
                                killProc()
                            })
                            .catch(() => {
                                // A probe that itself crashed proves nothing —
                                // benefit of the doubt, keep waiting.
                                probing = false
                                lastActivity = Date.now()
                            })
                    },
                    Math.max(50, Math.min(stall.afterMs / 2, 15_000))
                )
            :   undefined

        let firstByteFired = false
        proc.stdout?.on('data', (d: Buffer) => {
            lastActivity = Date.now()
            streamWatch?.note()
            if (!firstByteFired) {
                firstByteFired = true
                opts?.onFirstByte?.()
            }
            if (discardStdout) return
            const chunk = d.toString()
            if (sink) sink.feed(chunk)
            else stdout += chunk
        })
        // This accumulation is deliberately unbounded, unlike `discardStdout`
        // above. The asymmetry was investigated on 2026-07-28 and the "stderr can
        // overflow V8's max string length" hypothesis is REFUTED at ~5 orders of
        // magnitude — do not re-open it without new volume evidence.
        //
        // Measured ceiling (binary search on `'a'.repeat`, not cited from memory):
        // node v26.2.0 536,870,888 chars (512 MiB, 2^29-24), bun 1.3.14
        // 2,147,483,647 (2 GiB). Both throw RangeError, not OOM — node's default
        // heap is 4192 MiB, well clear of its own string ceiling. If it were ever
        // reached the severity would be high: a throw in this handler escapes as
        // an uncaughtException and the enclosing promise never settles (measured),
        // so it would kill the host, not fail the child.
        //
        // Measured volume, real runs not synthetic: the largest single tool output
        // in a full mx5 run is 5,043 bytes and that whole run's verify-debug.log is
        // 112,216 bytes. The heaviest commands in the system are far under —
        // pi-task's own 2,452-test suite emits 162 bytes of stderr, mx5's
        // prettier+eslint+tsc lint 90, a cached `bun install` 0. Observed max is
        // ~106,000x below the node ceiling; reaching it inside the 15-min command
        // bound would need ~596 KB/s sustained on stderr for the full window.
        //
        // The structural reason is the population of children that reach here:
        // `pi` model children (stderr near-empty), `git`, and one
        // `npm install --loglevel=error`. Genuinely verbose work — test runners,
        // builds, boot probes — does not use runChild; final-gate.ts spawns its own
        // and already caps at 8000 chars. So `discardStdout`'s single caller
        // (docs-core.ts) is not an oversight to mirror: it discards the verbose
        // stream and KEEPS stderr precisely because stderr is that call's payload.
        //
        // A symmetric `discardStderr` would therefore have no caller, and a naive
        // cap here would be actively unsafe: consumers disagree about which end
        // carries the cause — phases.ts:474 takes the tail (-500), phases.ts:936
        // takes the head (0, 300), and child-runner.ts:172 feeds the whole string
        // into failure classification.
        proc.stderr?.on('data', (d: Buffer) => {
            lastActivity = Date.now()
            streamWatch?.note()
            stderr += d.toString()
        })
        // One idempotent settle path for close/error/abort. Detaching the abort
        // listener here is the point: `{once: true}` only fires-and-removes on an
        // ACTUAL abort, so a child that finishes normally used to leave its
        // listener on the signal forever. A TaskRunner shares ONE AbortController
        // across every child of a run, so those listeners accumulated linearly and
        // each one retained, via `killProc`'s closure, the finished child process,
        // this invocation (including its full prompt), and `opts` — together with
        // everything the caller's callbacks close over. See GitHub issue #9.
        let settled = false
        const cleanup = (): void => {
            if (stallTimer) clearInterval(stallTimer)
            streamWatch?.stop()
            signal?.removeEventListener('abort', killProc)
        }
        const settle = (result: ChildResult): void => {
            cleanup()
            if (settled) return
            settled = true
            resolve(result)
        }

        proc.once('close', (code: number | null) => {
            // The child has exited, but anything it backgrounded (a dev server) may
            // still hold its process group and a port — reap the group so the next
            // gate's boot check does not collide with our own orphan. Best-effort:
            // SIGTERM now, SIGKILL shortly after for anything that ignored it.
            if (ownGroup) {
                reapGroup('SIGTERM')
                setTimeout(() => reapGroup('SIGKILL'), 1_000).unref()
            }
            if (sink) sink.flush()
            const text = sink ? sink.text : undefined
            settle({
                stdout,
                stderr,
                exitCode: code ?? 0,
                aborted,
                text,
                modelError: sink?.modelError,
                ...(stalled ? {stalled: true} : {}),
                ...(streamStalledIdleMs !== undefined ?
                    {streamStalled: {idleMs: streamStalledIdleMs}}
                :   {})
            })
        })
        proc.once('error', () => {
            settle({stdout, stderr, exitCode: 1, aborted})
        })

        if (signal) {
            if (signal.aborted) killProc()
            else signal.addEventListener('abort', killProc, {once: true})
        }
    })
}

// ─── Convenience: spawn with default node child_process ──────────────────────

export function runChildDefault(
    invocation: {command: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv},
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
    const clip = (s: string): string => {
        const one = s.replace(/\s+/g, ' ').trim()
        return one.length > 60 ? one.slice(0, 59) + '…' : one
    }
    if (toolName === 'bash' && typeof a.command === 'string') {
        return a.command.replace(/\s+/g, ' ').trim()
    }
    if (
        toolName === 'pi-worker-docs'
        && typeof a.module === 'string'
        && typeof a.query === 'string'
    ) {
        return `${a.module} "${clip(a.query)}"`
    }
    // Search/fetch workers: without these the debug log shows a bare tool name
    // and a run audit cannot tell WHAT was searched or fetched.
    if (toolName === 'pi-worker-search' && typeof a.query === 'string') {
        return `"${clip(a.query)}"`
    }
    if (toolName === 'pi-worker-fetch' && typeof a.url === 'string') {
        return clip(a.url)
    }
    if (typeof a.file_path === 'string') return a.file_path
    if (typeof a.path === 'string') return a.path
    if (typeof a.filePath === 'string') return a.filePath
    if (typeof a.pattern === 'string') return a.pattern
    return ''
}
