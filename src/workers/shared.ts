import type {Static, TSchema} from '@sinclair/typebox'
import type {AgentToolResult} from '@earendil-works/pi-agent-core'
import type {ExtensionAPI, ExtensionContext, Theme} from '@earendil-works/pi-coding-agent'
import type {Text} from '@earendil-works/pi-tui'
import {researchRunId, lookupResearch, storeResearch} from './research-cache.js'
import type {EcosystemId} from './docs-ecosystems.js'
import {
    classifyWorkerFailure,
    describeWorkerFailure,
    type WorkerFailureInput
} from './worker-failure.js'

/** Which package, in which registry, a cached answer is about. */
export interface CachePackage {
    pkg: string
    ecosystem?: EcosystemId
}

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
 * Returns `null` when the child succeeded (caller proceeds to format output).
 *
 * It ASKS THE LADDER (`classifyWorkerFailure` -> `describeWorkerFailure`) rather
 * than re-deriving the answer from two fields. Every kill path also sets
 * `aborted`, so an `if (aborted) return abortedMessage` would give a wall-clock
 * kill, a hung command, a dead backend, a loop kill and a user ESC the same four
 * words. Through the ladder each gets its own diagnosis.
 *
 * A caller with only a `ChildOutcome` is unaffected: it carries no kill flags, so
 * the ladder falls through to `aborted`/`exit` — null on a clean exit, the abort
 * message when aborted, and `Worker exited N` plus the stderr tail otherwise.
 * `shared.test.ts` pins those three.
 */
export function formatChildFailure(
    child: ChildOutcome | (WorkerFailureInput & {stderr?: string}),
    abortedMessage: string
): string | null {
    const failure = classifyWorkerFailure(child)
    return failure === undefined ? null : (
            describeWorkerFailure(failure, abortedMessage, child.stderr ?? '')
        )
}

/**
 * What a worker tool PRODUCED — an answer, or a statement that it has none.
 *
 * As a bare `{text, details}` bag, "did it succeed" gets re-derived downstream
 * from `details.childExitCode === 0`. That derivation is wrong in the one case it
 * most needs to be right: node reports a signal kill as `close` with
 * `code === null`, which child-process.ts settles as `code ?? 0` — so an ABORTED
 * lookup arrives carrying exit code 0, the cache rules say yes, and
 * `"Docs lookup aborted."` is memoised for the whole run and re-served to every
 * later sibling.
 *
 * Stating the outcome makes that unrepresentable: `makeWorkerTool` stores only an
 * `answer`, so no cache rule has to know anything about process health, and the
 * `cacheable` predicates shrink to what they are actually about — answer quality.
 */
export type WorkerOutcome<TDetails> =
    | {kind: 'answer'; text: string; details: TDetails}
    | {
          kind: 'unavailable'
          text: string
          details: TDetails
          /**
           * Why there is no answer, for the debug trail. A `WorkerFailureKind`
           * where a child died (classifyWorkerFailure owns that precedence), or a
           * short tag for the lookups that never got as far as a child.
           */
          reason: string
      }

/** This call produced an answer. Cacheable, subject to the tool's own rule. */
export function workerAnswer<T>(text: string, details: T): WorkerOutcome<T> {
    return {kind: 'answer', text, details}
}

/**
 * The `reason` tag for a child that died, read off the ONE ladder that owns the
 * precedence (`classifyWorkerFailure`). `'no-answer'` when nothing killed it and
 * the caller still has no answer to give.
 */
export function childFailureReason(child: WorkerFailureInput): string {
    return classifyWorkerFailure(child)?.kind ?? 'no-answer'
}

/** This call has no answer. NEVER cached, whatever the tool's rule says. */
export function workerUnavailable<T>(text: string, details: T, reason: string): WorkerOutcome<T> {
    return {kind: 'unavailable', text, details, reason}
}

/**
 * What a worker tool is, minus the registration ritual: a name/label/schema,
 * a `run` that produces the outcome, and a `renderCall` for the TUI.
 * `makeWorkerTool` owns `registerTool`, the parallel execution mode, and wrapping
 * the result in `textResult`.
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
    ): Promise<WorkerOutcome<TDetails>>
    renderCall(args: Static<TParams>, theme: Theme): Text
    /**
     * Per-run research-cache policy. Return a stable cache key for this call —
     * a result keyed on it is a deterministic function of the inputs that does not
     * change within a run, so a later sibling task can reuse it instead of re-running
     * the network fetch + child summariser. Return `null` to opt a particular call
     * OUT of caching (e.g. a project-source `.` lookup, whose answer the working tree
     * mutates within a run). Omit entirely and the tool is never cached. The stored
     * key is namespaced by tool name — joined with a NUL, a byte no tool name or key
     * can contain, so no pair of them can collide by concatenation.
     */
    cacheKey?(params: Static<TParams>): string | null
    /**
     * The package this call's answer is ABOUT, and the registry it came from, for a
     * package-scoped tool (docs). Recorded as structured provenance on the cache entry
     * so a resume can drop just the entries whose package moved version, instead of
     * the whole run's cache. A greenfield run adds packages every few tasks, so a
     * whole-file gate never holds. The registry is part of it because `text` on npm
     * and `text` on another registry are different packages that move separately.
     * Omit — or return undefined — and the entry survives every resume of its run.
     *
     * `details` is the finished call's own record, so the registry recorded here is
     * the one the lookup RESOLVED to — not one the caller happened to name.
     */
    cachePkg?(params: Static<TParams>, details: TDetails): CachePackage | undefined
    /**
     * Whether an ANSWER is safe to cache — a question about the answer's QUALITY
     * (type-only, an abstention, an unverified excerpt), never about process
     * health. An `unavailable` outcome never reaches this: `makeWorkerTool` has
     * already refused it. Defaults to always-cacheable when omitted.
     *
     * It sees `details` only. Handed the rendered tool text as well, a rule reaches
     * for it and reads a string that leads with provenance and excerpt notes — and an
     * anchored abstention matcher then scores every abstention as an answer.
     */
    cacheable?(details: TDetails): boolean
}

/**
 * The per-run research cache, as a call wrapper.
 *
 * Extracted from `makeWorkerTool` because the host fans out to the SAME workers
 * outside any tool call: `gatherExternalContext` (task/external-context.ts) looks
 * up docs, pages and live versions for every task's research phase, in-process,
 * and paid the network for all of it again on every task of the run. The cache was
 * never about tool registration; it is about (tool, subject, question) -> answer.
 *
 * A null `rawKey`, or no run id stamped, means the call is not cached at all.
 */
export async function cachedWorkerCall<TDetails>(
    cwd: string,
    tool: string,
    rawKey: string | null,
    run: () => Promise<WorkerOutcome<TDetails>>,
    rules: {
        cacheable?: (details: TDetails) => boolean
        pkg?: (details: TDetails) => CachePackage | undefined
    } = {}
): Promise<{text: string; details: TDetails}> {
    // The stored key is namespaced by tool name, joined with a NUL — a byte no tool
    // name or key can contain, so no pair of them can collide by concatenation.
    const runId = researchRunId()
    const cacheKey = runId !== undefined && rawKey !== null ? `${tool}\u0000${rawKey}` : null

    if (runId !== undefined && cacheKey !== null) {
        const hit = await lookupResearch(cwd, runId, cacheKey)
        if (hit !== undefined) return {text: hit.text, details: hit.details as TDetails}
    }

    const outcome = await run()
    const {text, details} = outcome

    // A non-answer is never stored, whatever the caller's own rule says. The rule
    // decides answer QUALITY; this decides whether there is an answer.
    if (
        outcome.kind === 'answer'
        && runId !== undefined
        && cacheKey !== null
        && (rules.cacheable ? rules.cacheable(details) : true)
    ) {
        const provenance = rules.pkg?.(details)
        await storeResearch(
            cwd,
            runId,
            cacheKey,
            text,
            details,
            provenance?.pkg,
            provenance?.ecosystem
        )
    }
    return {text, details}
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
            const {text, details} = await cachedWorkerCall<TDetails>(
                ctx.cwd,
                spec.name,
                spec.cacheKey ? spec.cacheKey(params) : null,
                () => spec.run(params, signal, ctx),
                {
                    ...(spec.cacheable ? {cacheable: d => spec.cacheable!(d)} : {}),
                    ...(spec.cachePkg ? {pkg: d => spec.cachePkg!(params, d)} : {})
                }
            )
            return textResult(text, details)
        },
        renderCall: (args, theme) => spec.renderCall(args, theme)
    })
}
