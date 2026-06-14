import type {Static, TSchema} from '@sinclair/typebox'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import type {ExtensionAPI, ExtensionContext, Theme} from '@earendil-works/pi-coding-agent'
import type {Text} from '@earendil-works/pi-tui'

/** Build a plain-text AgentToolResult. */
export function textResult<T>(text: string, details: T): AgentToolResult<T> {
    return {content: [{type: 'text', text}], details}
}

/**
 * The slice of a child-process result a worker needs to decide failure.
 * `exitCode` is normalised here — `fetch-core` exposes it as `childExitCode`,
 * the others as `exitCode`; callers map to this single name.
 */
export interface ChildOutcome {
    aborted: boolean
    exitCode: number
    stderr: string
}

/**
 * The one place worker child-failure is turned into a user-facing message.
 * Returns `null` when the child succeeded (caller proceeds to format output),
 * otherwise the standard abort/exit message. Concentrating this here keeps the
 * stderr-tail rule identical across every worker — it had already drifted
 * (`pi-worker` skipped the `.trim()` the others applied).
 */
export function formatChildFailure(child: ChildOutcome, abortedMessage: string): string | null {
    if (child.aborted) return abortedMessage
    if (child.exitCode !== 0) {
        const tail = child.stderr.trim().slice(-500) || '(no stderr)'
        return `Worker exited ${child.exitCode}.\n${tail}`
    }
    return null
}

/**
 * What a worker tool is, minus the registration ritual: a name/label/schema,
 * a `run` that produces the focused text + structured details, and a `renderCall`
 * for the TUI. `makeWorkerTool` owns `registerTool`, the parallel execution mode,
 * and wrapping the result in `textResult`.
 */
export interface WorkerToolSpec<TParams extends TSchema, TDetails> {
    name: string
    label: string
    description: string
    parameters: TParams
    run(
        params: Static<TParams>,
        signal: AbortSignal | undefined,
        ctx: ExtensionContext
    ): Promise<{text: string; details: TDetails}>
    renderCall(args: Static<TParams>, theme: Theme): Text
}

/** Register a worker tool from its spec, supplying the shared registration ritual. */
export function makeWorkerTool<TParams extends TSchema, TDetails>(
    pi: ExtensionAPI,
    spec: WorkerToolSpec<TParams, TDetails>
): void {
    pi.registerTool<TParams, TDetails>({
        name: spec.name,
        label: spec.label,
        description: spec.description,
        parameters: spec.parameters,
        executionMode: 'parallel',
        async execute(_toolCallId, params, signal, _onUpdate, ctx) {
            const {text, details} = await spec.run(params, signal, ctx)
            return textResult(text, details)
        },
        renderCall: (args, theme) => spec.renderCall(args, theme)
    })
}
