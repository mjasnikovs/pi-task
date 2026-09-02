/**
 * gate-child — running ONE gate child pi, and the table of what each kind of gate
 * child is allowed to do.
 *
 * Five children run under the gates: `verify`, `recommend`, `lint-fix`,
 * `final-fix` and `enforce`. All five share one ritual — reset the widget state,
 * stamp the start, open a per-gate debug log, write a start marker, raise a
 * status loader, call `runWorker` on the `gate` profile (no wall clock; the
 * path-revisit loop rule disabled, leaving the exact-match rule), warn on a
 * surviving loop, classify the failure, write an end marker, throw on failure,
 * and stop the loader — `ChildStatus.track` does that last one in a `finally`,
 * so a throwing child never leaves the widget up.
 *
 * Only THREE of the differences between the kinds are row data below: the
 * git-state guard, tool-result logging, and the end marker (plus the loader's
 * step label). Tree-change capture is deliberately NOT a row — it is decided at
 * the bottom of this file by a test on the child's TOOLS, so a future
 * write-capable kind gets it without anyone remembering to set a flag.
 *
 * The module exists so this is reachable from a test at all. It would otherwise
 * live inside `buildGateDeps`'s closure, and the git-state-guard wiring in
 * particular — snapshot, restore-in-`finally`, `verdictTainted` — is what
 * discards a verify verdict computed on a tree the child itself mutated. Here
 * `runWorker` and the git helpers are injected, so the ordering, the trail lines
 * and the throwing-child path are directly assertable.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {RunWorkerInput, RunWorkerResult} from '../workers/pi-worker-core.js'
import type {GitStateSnapshot, ReconcileResult} from './git-state-guard.js'
import type {ChildStatus} from './child-status.js'
import {formatLoopHint} from './loop-detector.js'
import {classifyEnforceChildFailure} from './enforce-guidelines.js'

/** Which gate child this is. */
export type GateChildKind = 'verify' | 'recommend' | 'lint-fix' | 'final-fix' | 'enforce'

export interface GateChildRow {
    /**
     * Snapshot the tree before and restore after. `verify` and `recommend` are
     * read-only BY CONTRACT, but that contract is only prompt-level — nothing
     * stops the child mutating the tree, so the restore is what makes it hold.
     * `lint-fix` and `final-fix` are excluded because editing is their job and
     * they carry their own revert guards; `enforce` because it edits too.
     */
    guarded: boolean
    /**
     * Log tool OUTPUTS, not just the calls. Without the result, a claim like
     * "verify ran curl and it passed" cannot be checked against what the command
     * actually printed. Off for `enforce`, whose log is a per-pass verdict trail.
     */
    logToolResults: boolean
    /** The loader's step label. */
    step: string
    /** The end-marker written on success. */
    okMarker: string
}

/**
 * What each kind may do. Adding a child is a row; it cannot be added without
 * deciding all four questions, which is the point.
 */
export const GATE_CHILD_KINDS: Record<GateChildKind, GateChildRow> = {
    verify: {guarded: true, logToolResults: true, step: 'verify', okMarker: 'ok'},
    recommend: {guarded: true, logToolResults: true, step: 'recommend', okMarker: 'ok'},
    // Editing is lint-fix's job, so the guard would revert its work.
    'lint-fix': {guarded: false, logToolResults: true, step: 'lint-fix', okMarker: 'ok'},
    'final-fix': {guarded: false, logToolResults: true, step: 'final-fix', okMarker: 'ok'},
    enforce: {
        guarded: false,
        logToolResults: false,
        step: 'guidelines',
        okMarker: 'verdict captured'
    }
}

/** Everything the runner needs that is not a property of the KIND. */
export interface GateChildDeps {
    ctx: ExtensionCommandContext
    cwd: string
    taskTitle: string
    kind: GateChildKind
    /** Absolute path of the debug log for this gate. */
    logPath: string
    /**
     * `false` when the CALLER already renders a loader spanning this child (the
     * verify gate does). Two loaders on one widget key only fight each other.
     */
    loader?: boolean
    /** Per-command ceiling. pi's bash tool has none of its own: its schema
     *  describes `timeout` as "optional, no default timeout", and
     *  `resolveTimeoutMs(undefined)` returns undefined. */
    commandTimeoutMs: number
    /** Hung-stream bound; the probe-based stall guard cannot supply it. */
    streamInactivityMs: number
    /**
     * The resolved argv fragment for the `gate` group — its model and its
     * thinking level — or `[]` to inherit both.
     *
     * REQUIRED, like its two neighbours above: gate-child takes resolved config
     * values and gate-deps supplies them. Optional-with-a-default would let a new
     * gate wiring silently run on a model nobody chose, which is the failure the
     * whole profile feature exists to end.
     */
    groupArgs: readonly string[]
    /**
     * The context window of the model THESE children run on, for the churn rule.
     *
     * Not `status.parentContextWindow`, which is a per-RUN value and a run spans
     * several groups. The direction matters: a window smaller than the child's
     * real one makes churn fire early and kill a healthy child, so this follows
     * the `gate` group's model and falls back to the host's.
     *
     * REQUIRED, like its neighbours: gate-child takes resolved config values.
     */
    contextWindow: number
    /**
     * The live widget state this child feeds and its loader reads. SHARED with
     * the caller — the verify gate's own loader reads the same status while this
     * child runs with `loader: false` — so it is the caller's object, not a copy.
     * It also owns the loader ritual and the context-usage resolution.
     */
    status: ChildStatus

    // ── seams ────────────────────────────────────────────────────────────────
    runWorker: (input: RunWorkerInput) => Promise<RunWorkerResult>
    makeDebugAppender: (path: string) => (line: string, level?: 'event' | 'stream') => void
    captureGitState: (cwd: string, signal?: AbortSignal) => Promise<GitStateSnapshot>
    reconcileGitState: (
        cwd: string,
        snapshot: GitStateSnapshot,
        signal?: AbortSignal
    ) => Promise<ReconcileResult>
    /** Tree changes for a WRITE-capable child, already formatted. */
    describeTreeChanges: (cwd: string, signal?: AbortSignal) => Promise<string>
    truncateToolResult: (text: string) => string
    /** Set to the last reconcile so the caller can discard a tainted verdict. */
    onReconcile?: (rec: ReconcileResult) => void
}

/**
 * Build the `runChild` closure the gate steps expect.
 *
 * The `finally` ordering is load-bearing: the git-state restore runs BEFORE any
 * verdict or failure is acted on, and it runs even when the child THREW — a
 * crashed child must not skip the restore.
 */
export function makeGateChild(
    deps: GateChildDeps
): (tools: string, prompt: string, sig?: AbortSignal) => Promise<string> {
    const row = GATE_CHILD_KINDS[deps.kind]
    return async (tools, prompt, sig) => {
        // Reset FIRST — before the start marker and the guard snapshot, not just
        // inside `track` — so a previous child's trailer never shows under this
        // one while the git snapshot is still being taken (the verify gate's own
        // loader is already reading this status by then).
        deps.status.reset()
        const startedAt = Date.now()
        // Every marker below (start/end, the guard's restore, the loop warning, a
        // write-capable child's tree changes) goes through `log` with no kind, so
        // it defaults to 'event'. The shipped default level is 'events', where
        // shouldLogDebug keeps 'event' and drops 'stream' — so the audit trail
        // survives while the child's own stdout and its tool results, the only
        // things passed as 'stream', do not.
        const log = deps.makeDebugAppender(deps.logPath)
        log(`=== ${deps.kind} start: ${deps.taskTitle} ===`)
        const guardSnapshot = row.guarded ? await deps.captureGitState(deps.cwd, sig) : null
        const frame =
            deps.loader === false ?
                null
            :   () => ({
                    title: deps.taskTitle,
                    kind: deps.kind,
                    step: row.step,
                    stepNum: 1,
                    stepTotal: 1,
                    startedAt
                })
        return deps.status.track(deps.ctx, frame, async () => {
            let r: RunWorkerResult
            try {
                r = await deps.runWorker({
                    prompt,
                    cwd: deps.cwd,
                    ...(sig ? {signal: sig} : {}),
                    tools,
                    // The four guard literals — run to completion, a per-command
                    // watchdog, a stream watchdog, and the path-revisit rule
                    // disabled — are the `gate` row of WORKER_PROFILES
                    // (workers/worker-profiles.ts), whose resolve() sets
                    // worker-timeout to {timeoutMs: 0} and pathThreshold to
                    // Infinity. The two ceilings stay inputs because they are user
                    // config, not policy.
                    profile: 'gate',
                    policyInputs: {
                        commandTimeoutMs: deps.commandTimeoutMs,
                        streamInactivityMs: deps.streamInactivityMs
                    },
                    groupArgs: deps.groupArgs,
                    // A discarded attempt is otherwise invisible: the returned
                    // exitCode/text describe the FINAL attempt, so a child that
                    // burned two attempts reads exactly like one that ran clean.
                    onRestart: rs =>
                        log(
                            `=== ${deps.kind} RESTART (attempt ${rs.attempt} discarded)`
                                + ` reason=${rs.reason} wall=${rs.wallMs}ms`
                                + ` discarded=${rs.partialChars}ch`
                                + (rs.detail ? ` — ${rs.detail}` : '')
                                + ' ==='
                        ),
                    onLine: line => {
                        // The status feeds the LIVE widget and is not logging — it
                        // stays outside the gate, or a quiet trail would also blank
                        // the progress display.
                        deps.status.onLine(line)
                        log(line, 'stream')
                    },
                    ...(row.logToolResults ?
                        {
                            onToolResult: ({name, isError, text}) =>
                                log(
                                    `↳ ${name} [${isError ? 'ERR' : 'ok'}]: `
                                        + deps.truncateToolResult(text),
                                    'stream'
                                )
                        }
                    :   {}),
                    onContextUsage: snapshot => deps.status.onContextUsage(snapshot),
                    // The gate child has to be TOLD its window. pi's session event
                    // stream — what `--mode json` emits — carries token counts but
                    // no context window; `contextWindow` appears nowhere in
                    // agent-session.d.ts.
                    contextWindow: deps.contextWindow
                })
            } finally {
                // Restore whatever the child moved BEFORE any verdict or failure is
                // acted on — a crashed child must not skip the restore either.
                if (guardSnapshot) {
                    const rec = await deps.reconcileGitState(deps.cwd, guardSnapshot, sig)
                    deps.onReconcile?.(rec)
                    if (rec.mutated) {
                        // Distinguish the two outcomes in the trail: a tainting
                        // mutation (graded work altered → verdict discarded) vs
                        // benign cleanup (test-runner output the child left behind
                        // → verdict stands).
                        const label =
                            rec.verdictTainted ?
                                'child mutated graded state (verdict discarded)'
                            :   'cleaned child test-runner artifacts (verdict kept)'
                        log(
                            `=== ${deps.kind} GIT-STATE GUARD — ${label}; `
                                + `restored: ${rec.actions.join('; ')} ===`
                        )
                        if (rec.verdictTainted) {
                            deps.ctx.ui.notify(
                                `${deps.taskTitle}: ${deps.kind} child mutated repo state — `
                                    + `restored (${rec.actions.join('; ').slice(0, 140)}).`,
                                'warning'
                            )
                        }
                    }
                }
            }
            // A loop that survived the restart-with-hint nudges is a WARNING, not a
            // failure: log it and tell the user, but let the verdict gate be the
            // only thing that can block.
            if (r.loopHit) {
                log(`=== ${deps.kind} LOOP WARNING — ${formatLoopHint(r.loopHit)} ===`)
                deps.ctx.ui.notify(
                    `${deps.taskTitle}: ${deps.kind} worker looped past the nudges — `
                        + 'continuing (not blocked).',
                    'warning'
                )
            }
            const failure = classifyEnforceChildFailure(r)
            log(
                failure ?
                    `=== ${deps.kind} end: FAIL — ${failure} ===`
                :   `=== ${deps.kind} end: ${row.okMarker} ===`
            )
            if (failure) throw new Error(failure)
            // CAPABILITY-LEVEL diff capture: any WRITE-capable child — decided by
            // its TOOLS, not by which phase spawned it or by a row in the table
            // above — gets its tree changes logged, so a future write-capable kind
            // cannot run invisibly.
            if (/\b(?:edit|bash|write)\b/.test(tools)) {
                log(
                    `=== ${deps.kind} tree changes: `
                        + `${await deps.describeTreeChanges(deps.cwd, sig)} ===`
                )
            }
            return r.text
        })
    }
}
