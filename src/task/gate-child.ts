/**
 * gate-child — running ONE gate child pi, and the table of what each kind of gate
 * child is allowed to do.
 *
 * Five children run under the gates: `verify`, `recommend`, `lint-fix`,
 * `final-fix` and `enforce`. All five share one ritual — reset the widget state,
 * stamp the start, open a per-gate debug log, write a start marker, raise a
 * status loader, call `runWorker` unguarded (no wall clock, exact-match loop
 * guard only), warn on a surviving loop, classify the failure, write an end
 * marker, throw on failure, and stop the loader in a `finally`. That was ~85
 * lines, and it was written TWICE: once as `makeGateChild` and once as an inline
 * closure for `enforce`, whose comments repeated the originals verbatim.
 *
 * The enforce copy differed in exactly four things — no git-state guard, no
 * tool-result logging, no tree-change capture, and a different end marker — which
 * is why they are row data here rather than a forked body. Apply the deletion
 * test to that copy and it passes: routing enforce through this concentrates the
 * differences into a table instead of moving them.
 *
 * The second reason for the module is that all of it used to live inside
 * `buildGateDeps`'s closure, so nothing about it was reachable from a test:
 * `buildGateDeps` is ~700 lines and is never called by the suite. The
 * git-state-guard wiring in particular — snapshot, restore-in-`finally`,
 * `verdictTainted` — is the mechanism that discards a verify verdict computed on
 * a tree the child mutated (mx5 run 6, where the verify child `git stash`ed the
 * task's uncommitted work and never popped it), and it could only be checked
 * indirectly through a fake `mutationCheck` one layer up. Here `runWorker` and
 * the git helpers are injected, so the ordering, the trail lines and the
 * throwing-child path are all directly assertable.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {RunWorkerInput, RunWorkerResult} from '../workers/pi-worker-core.js'
import type {GitStateSnapshot, ReconcileResult} from './git-state-guard.js'
import type {ChildStatus} from './child-status.js'
import {formatLoopHint} from './child-runner.js'
import {classifyEnforceChildFailure} from './enforce-guidelines.js'

/** Which gate child this is. */
export type GateChildKind = 'verify' | 'recommend' | 'lint-fix' | 'final-fix' | 'enforce'

export interface GateChildRow {
    /**
     * Snapshot the tree before and restore after. These children are read-only BY
     * CONTRACT, but the contract is prompt-level and the live model breaks it.
     * `lint-fix` and `final-fix` are excluded because editing is their job (they
     * carry their own revert guards), and `enforce` because it edits too.
     */
    guarded: boolean
    /**
     * Log tool OUTPUTS, not just the calls (mx5 run 10 item 6): without the result,
     * "verify claimed curl PASS on a server that cannot serve" is undecidable from
     * the log. Off for `enforce`, whose log is a per-pass verdict trail.
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
    /** Per-command ceiling; pi's bash tool has no default timeout. */
    commandTimeoutMs: number
    /** Hung-stream bound; the probe-based stall guard cannot supply it. */
    streamInactivityMs: number
    /**
     * The resolved `['--thinking', level]` fragment for the `gate` reasoning
     * group, or `[]` to inherit the session default.
     *
     * REQUIRED, like its two neighbours above: gate-child takes resolved config
     * values and gate-deps supplies them. Optional-with-a-default would let a new
     * gate wiring silently run at a level nobody chose, which is the failure the
     * whole profile feature exists to end.
     */
    thinking: readonly string[]
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
        // write-capable child's tree changes) is a guard record that survives at
        // the default level. Only the child's own stdout and its tool results
        // pass 'stream'.
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
                    // The four guard literals that used to sit here — run to
                    // completion, a per-command watchdog, a stream watchdog, and
                    // the path rule disabled — are the `gate` row of
                    // WORKER_PROFILES (workers/worker-profiles.ts), which carries
                    // the reasoning for each. The two ceilings stay inputs
                    // because they are user config, not policy.
                    profile: 'gate',
                    policyInputs: {
                        commandTimeoutMs: deps.commandTimeoutMs,
                        streamInactivityMs: deps.streamInactivityMs
                    },
                    thinking: deps.thinking,
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
                    // The gate child has to be TOLD its window: nothing in pi's
                    // event stream reports one (issue #16).
                    contextWindow: deps.status.parentContextWindow
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
            // CAPABILITY-LEVEL diff capture (mx5 run 11): any WRITE-capable child —
            // decided by its TOOLS, not by which phase spawned it — gets its tree
            // changes logged, so a future write-capable kind cannot run invisibly
            // the way the final-fix child's `rm` did.
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
