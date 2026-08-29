/**
 * ChildStatus — the live status of the child pi currently running under a
 * status loader: its latest output line and its context usage.
 *
 * Without it each spawn site keeps this state by hand — `let lastLine; let contextUsage;`
 * plus two callbacks (`onChildOutput` writes the line, `onContextUsage` folds a
 * snapshot through `resolveContextUsage` with the parent window), a reset before
 * every child, and a loader whose every tick reads both.
 *
 * Three sites share that ritual and are now this class: `/task-auto`'s planning
 * `runChild`, `buildGateDeps`, and `/task-plan` — one `new ChildStatus` each, and
 * no others. The single-task `TaskRunner` deliberately stays where it is: its
 * state is the whole-run `WidgetState`, shared by reference with `PhaseContext`
 * and written by the phases themselves (see `orchestrator.ts`).
 *
 * `track` is the loader ritual: reset, raise the loader reading this status on
 * every tick, run, always stop. The status OUTLIVES a track — `buildGateDeps`
 * shares one across every gate child, and the verify gate raises its own
 * gate-wide loader over a child that renders none (`frame: null`, reached when
 * `deps.loader === false` in gate-child), so both must see the same object.
 */

import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {ContextSnapshot} from '../shared/child-process.js'
import {runPhaseChild, type PhaseDeps} from './child-runner.js'
import {resolveContextUsage} from './context-usage.js'
import {startAutoLoader, type AutoLoaderState} from './widget.js'

export interface ChildStatusDeps {
    /** The parent session's window — the last fallback for the context gauge. */
    parentContextWindow: number
    /** Raise a loader. Defaults to the real `startAutoLoader`; a test injects a fake. */
    startLoader?: (
        ctx: ExtensionCommandContext,
        getState: () => AutoLoaderState | null
    ) => () => void
}

export class ChildStatus {
    private _lastLine: string | undefined
    private _contextUsage: ContextSnapshot | undefined
    private readonly _parentContextWindow: number
    private readonly _startLoader: NonNullable<ChildStatusDeps['startLoader']>

    constructor(deps: ChildStatusDeps) {
        this._parentContextWindow = deps.parentContextWindow
        this._startLoader = deps.startLoader ?? startAutoLoader
    }

    /**
     * The parent session's window — the value handed DOWN to each child so its
     * own readout carries one, and the last fallback when a child reports none.
     */
    get parentContextWindow(): number {
        return this._parentContextWindow
    }

    /** The child's latest stream line. Bind as `onChildOutput` / `onLine`. */
    onLine(line: string): void {
        this._lastLine = line
    }

    /**
     * Fold a raw context snapshot into the gauge: the child's own window,
     * else the last known one, else the parent's (`resolveContextUsage`).
     */
    onContextUsage(snapshot: ContextSnapshot): void {
        this._contextUsage = resolveContextUsage(
            snapshot,
            this._contextUsage,
            this._parentContextWindow
        )
    }

    /** Forget the previous child, so its trailer never sits under the next one's block. */
    reset(): void {
        this._lastLine = undefined
        this._contextUsage = undefined
    }

    /** The two live fields, as a loader frame reads them. */
    snapshot(): {lastLine?: string; contextUsage?: ContextSnapshot} {
        return {lastLine: this._lastLine, contextUsage: this._contextUsage}
    }

    /**
     * Run `run` under the loader: reset, raise a loader whose every tick is
     * `frame()` spread OVER the live line and gauge, and stop it in a `finally`.
     * All four behaviours were run against a fake loader:
     *   - the reset lands first, so the previous child's line never reaches the
     *     new loader's first tick;
     *   - `frame` wins on a clash, because it is spread last — which is how the
     *     verify gate shows its deterministic-stage label until the child has a
     *     line of its own;
     *   - `frame: null` raises NO loader at all (the caller already has one
     *     reading this status) but still resets;
     *   - a child that THROWS still stops the loader, so a failure never leaves
     *     the widget up.
     */
    async track<T>(
        ctx: ExtensionCommandContext,
        frame: (() => AutoLoaderState) | null,
        run: () => Promise<T>
    ): Promise<T> {
        this.reset()
        const stop =
            frame === null ?
                () => {}
            :   this._startLoader(ctx, () => ({...this.snapshot(), ...frame()}))
        try {
            return await run()
        } finally {
            stop()
        }
    }
}

/** What a planning child's loader shows: the head-line command, the title, the step. */
export interface PlanningChildLoader {
    /** Head-line command. Omit for the loader's default (`/task-auto`). */
    command?: string
    title: string
    /**
     * The step for THIS child. Read on every tick, because /task-plan renames the
     * step while a child runs (`setStatus`), and /task-auto numbers its steps.
     */
    step: (name: string) => {step: string; stepNum: number; stepTotal: number}
}

/**
 * Run one planning child — a phase child (`runPhaseChild`, with its Error-triage
 * ladder) whose only UI is the shared status loader. Both `/task-auto`'s
 * planning `runChild` and `/task-plan`'s `child` are adapters over this: what
 * they disagree on is the phase deps (task id, read-once extension, debug log),
 * the tool set, and the loader's labelling — all parameters here. What
 * `/task-plan` adds around it (the read-only tree diff) stays its own.
 */
export async function runPlanningChild(opts: {
    ctx: ExtensionCommandContext
    status: ChildStatus
    phaseDeps: PhaseDeps
    name: string
    tools: string
    prompt: string
    loader: PlanningChildLoader
}): Promise<string> {
    const {ctx, status, phaseDeps, name, tools, prompt, loader} = opts
    const startedAt = Date.now()
    return status.track(
        ctx,
        () => ({
            ...(loader.command === undefined ? {} : {command: loader.command}),
            title: loader.title,
            ...loader.step(name),
            startedAt
        }),
        () => runPhaseChild(phaseDeps, name, tools, prompt)
    )
}

/**
 * Wire a `ChildStatus` as a phase child's stream callbacks — plus the window the
 * child must be TOLD, since pi's `--mode json` stream reports token counts but no
 * context window.
 */
export function statusCallbacks(
    status: ChildStatus
): Pick<PhaseDeps, 'onChildOutput' | 'onContextUsage' | 'contextWindow'> {
    return {
        onChildOutput: line => status.onLine(line),
        onContextUsage: snapshot => status.onContextUsage(snapshot),
        contextWindow: status.parentContextWindow
    }
}
