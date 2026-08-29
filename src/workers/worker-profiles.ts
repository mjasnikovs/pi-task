/**
 * The GUARD POLICY each kind of worker child runs under, keyed on the ways it
 * can die.
 *
 * WHY IT EXISTS. `RunWorkerInput` carried ten guard knobs in four different
 * shapes — two bare millisecond numbers, three `{...} | false` unions, an
 * optional object, a boolean and two counts — and three production callers each
 * hand-picked a different subset of them:
 *
 *   gate-child.ts      timeoutMs 0, a per-command watchdog, a stream watchdog,
 *                      and the path rule disabled. Everything else default.
 *   research-worker.ts a progress deadline and two off-by-default A/B levers.
 *                      NO command watchdog, NO stream watchdog. Everything else
 *                      default.
 *   pi-worker.ts       nothing at all — every default, silently.
 *
 * So "a gate child runs unbounded but with a per-command watchdog; a research
 * worker is the reverse" existed only as three option literals in three files,
 * and the reasoning was attached to whichever line happened to need defending.
 * `gate-child.ts` explained why it disables the path rule and said nothing about
 * why it takes no progress deadline. Nothing anywhere said that the ad-hoc
 * `pi-worker` tool is the strictest-clocked of the three. That was not a
 * decision; it was the residue of never having had a place to write one down.
 *
 * WHY IT IS KEYED ON `WorkerKillId`. A guard exists to prevent a specific way a
 * child can die, so the roster of deaths (`worker-kill.ts`) is the correct key —
 * the same argument that roster makes for kill CAUSES, one level up. The mapped
 * type means a tenth cause cannot be added to `WORKER_KILLS` without every
 * profile deciding what to do about it, and it means the three causes with no
 * dial say so in the table (`null`) instead of being absent from it.
 *
 * The key does NOT partition the knobs one-per-row, and pretending otherwise
 * would be the lie:
 *
 *   `worker-timeout` holds THREE — the cap, the progress ceiling that turns the
 *   cap from "time allowed" into "time allowed without progress", and the
 *   fan-out extension. All three move the same deadline; splitting them across
 *   rows would let a profile set a ceiling for a cap it disabled.
 *
 *   `loop` holds TWO detectors. `StallDetector`'s hit IS a `LoopHit` with
 *   `.stall` set (child-process.ts: "so a stall rides the kill/restart plumbing
 *   the loop hit already has"), and the restart ladder has ONE rule for both.
 *   One cause, one row.
 *
 * WHAT IS DELIBERATELY NOT UNIFIED.
 *
 *   `carryForward` is not a row. It is one switch over the whole run, and WHICH
 *   causes honour it is already decided by `CARRY_FORWARD_IDS`, derived from the
 *   roster. A per-cause row here would be a second copy of that set, free to
 *   disagree with it.
 *
 *   The reasoning group is not the profile. `pi-worker.ts` runs `adhoc` guards
 *   but `groupThinkingArgs('research')`, on purpose. Guards answer "how may this
 *   child die"; `thinking` answers "how hard may it think". Folding them would
 *   silently re-level a gate child, which is the exact mistake
 *   `RunWorkerInput.thinking`'s comment already records.
 *
 *   `projectDocsBudget()` (the CAP arm, research-fanout-budget.ts) stays out. It
 *   bounds what a worker ASKS FOR, via its prompt and its tool, not how it dies.
 *
 *   `RESTART_ORDER` and `FAILURE_ORDER` are untouched. This is a third view of
 *   the same key, not a merge of the two orderings.
 */

import {LOOP_THRESHOLD, LOOP_WINDOW, MAX_LOOP_RESTARTS} from '../task/child-runner.js'
import {CONTEXT_CHURN_FACTOR, NO_PROGRESS_LIMIT} from '../task/stall-detector.js'
import {
    fanoutTimeoutPolicy,
    workerCarryForward,
    workerProgressCeilingMs
} from '../task/research-fanout-budget.js'
import type {WorkerKillId} from './worker-kill.js'

/**
 * Hard wall-clock bound on a single worker run (one spawn). The exact-match
 * LoopDetector only catches *identical* repeated tool calls; a model that
 * thrashes with slightly-varied calls (different grep patterns each time) slips
 * past it and would otherwise run unbounded. This is the backstop for that case:
 * after this long with no clean exit, abort and restart with a hint. Sized well
 * above a healthy worker's observed runtime (~25-130s on the local backend) so
 * it never trips a legitimately slow run.
 */
export const RESEARCH_WORKER_TIMEOUT_MS = 240_000

/**
 * Output-stall window before the dead-backend probe fires (model
 * server died mid-gate-child, the child hung MUTE for 64 minutes). This is NOT
 * a wall-clock cap — output progress resets it, and even a fully stalled child
 * is only killed when the model endpoint is actually unreachable. Sized so a
 * long local prompt-processing pass (minutes of legitimate silence, server
 * alive) just gets probed and waits on.
 */
export const STALL_AFTER_MS = 180_000

/**
 * The dead-backend probe. No output for `afterMs` -> probe the model endpoints
 * pi is configured with -> unreachable -> kill and set `stalled: true`. Output
 * progress resets it, and a reachable endpoint is treated as proof of life, so
 * this alone will not end a child that is merely quiet.
 */
export interface StalledGuard {
    afterMs: number
    /**
     * `null` means the built-in endpoint probe, and a PROFILE always writes
     * `null`. Kept as data rather than a closure so a resolved policy is plain
     * comparable data — which is what makes the no-behaviour-change proof in
     * `worker-profiles.test.ts` an equality assertion rather than a hand-written
     * comparer that skips the one field most likely to be wrong. Tests and
     * harnesses inject a real probe through the override.
     */
    probe: (() => Promise<boolean>) | null
}

/**
 * The whole-worker deadline. All three fields move the SAME timer, which is why
 * they share a row: `timeoutMs` is the cap (0 = unbounded), `progressCeilingMs`
 * turns that cap from "total time allowed" into "time allowed WITHOUT PROGRESS"
 * up to this absolute bound, and `fanout` pushes the deadline out per
 * project-source lookup.
 *
 * The progress ceiling is the difference between "took too long" and "stopped
 * working". The first is a property of the machine — a slower local model, a
 * bigger file — and must not cost the user their answer; the second is a real
 * fault, and one the dead-backend probe already catches on its own terms.
 *
 * `fanout` is the SCALE arm of  and is OFF unless both its env vars
 * are set — see task/research-fanout-budget.ts for why it was not the fix.
 */
export interface WorkerTimeoutGuard {
    /** 0 disables the wall clock entirely: the child runs until it exits. */
    timeoutMs: number
    /**
     * A tool call or a line of output re-arms the deadline to `now + timeoutMs`,
     * never past this many ms from the attempt's start. `null` leaves the fixed
     * cap and makes the re-arm inert.
     */
    progressCeilingMs: number | null
    /**
     * Each project-source `pi-worker-docs` call pushes this attempt's deadline
     * out by `perLookupMs`, never past `ceilingMs` from the attempt's start.
     */
    fanout: {perLookupMs: number; ceilingMs: number} | null
}

/**
 * The two runaway detectors. ONE row because they are one cause: both return a
 * `LoopHit` and both are handled by the single `loop` restart rule.
 *
 * `detector` judges ARGUMENTS over a 20-call window, so a child that rotates
 * through MORE DISTINCT CALLS THAN THE WINDOW HOLDS is invisible to it — every
 * key occurs once per window and the count never reaches the threshold.
 * That is not hypothetical: a worker can make hundreds of calls over exactly as
 * many distinct files as the window holds, reading each of them dozens of times,
 * without either the exact rule or the path rule ever tripping. It then dies on
 * the absolute progress ceiling, having done seconds of useful work.
 *
 * `progress` judges RESULTS, which a rotating reader cannot vary. It was written
 * for exactly that class and was wired only into phase children until
 * `runWorker` grew an option for it.
 *
 * Either can be `false` independently — a pass that legitimately revisits one
 * file raises `pathThreshold`; a harness isolating one rule turns the other off.
 */
export interface LoopGuard {
    detector: {window: number; threshold: number; pathThreshold: number} | false
    progress: {limit: number; churnFactor: number} | false
}

/**
 * The knob (if any) that governs each way a worker can die.
 *
 * The three `null` rows are not filler. They are the statement that those causes
 * have no dial: a leaked tool call is bounded by the fixed `MAX_LEAK_RETRIES`,
 * `aborted` is the caller's own signal, and `exit` is the child deciding to
 * stop. No profile may tune them, and now no profile can pretend to.
 */
interface WorkerGuardShapes {
    stalled: StalledGuard | false
    /**
     * PER-TOOL-CALL ceiling, ms. 0 = off. The child-side half of the command
     * watchdog (shared/command-watchdog.ts): arms on each `tool_execution_start`,
     * disarms on the matching end, and on overrun kills the child and — within
     * the shared restart budget — re-spawns it with `commandTimeoutHint`.
     *
     * WHY IT IS NOT THE WALL CLOCK: that one bounds the whole worker and is
     * deliberately 0 for gate children, which must run to completion. Neither it
     * nor the dead-backend probe can catch a hung COMMAND — the probe treats a
     * reachable model endpoint as proof of life, which it is, even while a `bun
     * run dev` the model forgot to bound blocks the child forever.
     *
     * This is the ceiling for the FIRST attempt; each HANG-caused restart halves
     * it (`commandCeilingForAttempt` — loop-caused restarts don't count), so a
     * model that ignores the hint cannot spend the full ceiling again every retry.
     */
    'command-timeout': number
    /**
     * Stream-inactivity ceiling, ms (shared/stream-watchdog.ts). 0 = off.
     *
     * The dead-backend probe cannot catch a HUNG stream on a HEALTHY backend —
     * it reads a reachable endpoint as proof of life, which is exactly what run
     * 14's three hangs looked like. This one asks nothing of the backend: no
     * output for this long, tool executions excluded, means kill and restart the
     * attempt with `streamStallHint`, inside the same shared restart budget.
     */
    'stream-stall': number
    'worker-timeout': WorkerTimeoutGuard
    /**
     * Connection-error restart budget. The SHARED restart counter is what
     * actually binds — a worker that already spent the budget looping does not
     * get extra lives here. 0 turns the retry off, which is how
     * a measuring harness gets a baseline arm out of a build that
     * already ships the retry.
     */
    'connection-error': number
    loop: LoopGuard
    'leaked-tool-call': null
    aborted: null
    exit: null
}

/**
 * One row per `WorkerKillId`. Indexing the shapes BY the roster's union is the
 * compile-time bite: drop a row and `WorkerGuardShapes[K]` stops resolving.
 */
export type WorkerGuards = {[K in WorkerKillId]: WorkerGuardShapes[K]}

export interface WorkerGuardPolicy {
    guards: WorkerGuards
    /**
     * Carry a killed attempt's findings into the re-spawn, and never return less
     * than the best attempt produced. Which CAUSES honour it is not settable —
     * `CARRY_FORWARD_IDS` derives that from the roster. Cross-cutting, so
     * deliberately NOT a row; see the header.
     */
    carryForward: boolean
}

/** A partial policy. Whole rows only: no deep-partial nobody can read. */
export type WorkerGuardOverride = {[K in WorkerKillId]?: WorkerGuardShapes[K]} & {
    carryForward?: boolean
}

/** The shipped `detector` half of the `loop` row: the read-only research/impl guard. */
export const DEFAULT_LOOP_DETECTOR = {
    window: LOOP_WINDOW,
    threshold: LOOP_THRESHOLD,
    pathThreshold: LOOP_THRESHOLD
} as const

/**
 * The shipped `progress` half of the `loop` row.
 *
 * Exported for the tests that isolate ONE of the two runaway rules. The row is
 * whole-row-overridable on purpose, so turning the argument detector off means
 * restating the result detector; naming the default here keeps that honest
 * instead of tempting a deep-partial that would let a test silently disable both.
 */
export const DEFAULT_LOOP_PROGRESS = {
    limit: NO_PROGRESS_LIMIT,
    churnFactor: CONTEXT_CHURN_FACTOR
} as const

export type WorkerProfileId = 'research' | 'gate' | 'adhoc'

/**
 * The facts a profile needs that are NOT policy: user config, and which of the
 * four research workers is the docs-capable one.
 */
export interface WorkerPolicyInputs {
    /** gate: `config.requestTimeoutMs`. */
    commandTimeoutMs?: number
    /** gate: `config.streamInactivityMs`. */
    streamInactivityMs?: number
    /** research: only `worker:apis` fans out, so only it can be scaled. */
    fanoutBounded?: boolean
    /** research: the A/B levers' env reader. Injectable for tests. */
    env?: (key: string) => string | undefined
}

export interface WorkerProfile {
    id: WorkerProfileId
    /** Why THIS child's guards differ. The prose no call site was carrying. */
    why: string
    resolve: (inputs: WorkerPolicyInputs) => WorkerGuardPolicy
}

/**
 * Every guard at its default. `adhoc` IS this; the other two are this plus a
 * named departure, so a diff between two profiles is a short list rather than a
 * re-reading of two literals.
 */
function baseGuards(): WorkerGuards {
    return {
        stalled: {afterMs: STALL_AFTER_MS, probe: null},
        'command-timeout': 0,
        'stream-stall': 0,
        'worker-timeout': {
            timeoutMs: RESEARCH_WORKER_TIMEOUT_MS,
            progressCeilingMs: null,
            fanout: null
        },
        'connection-error': MAX_LOOP_RESTARTS,
        loop: {detector: {...DEFAULT_LOOP_DETECTOR}, progress: {...DEFAULT_LOOP_PROGRESS}},
        'leaked-tool-call': null,
        aborted: null,
        exit: null
    }
}

export const WORKER_PROFILES = {
    research: {
        id: 'research',
        why:
            'The four read-only survey workers. Their fault is over-EXPLORATION, not '
            + 'a hung command: they get no bash, so no tool call can block forever, '
            + 'and the command and stream watchdogs stay off. What they do hit is the '
            + 'clock — mx5 run 18 measured r(project lookups, wall clock) = 0.909, '
            + 'with every worker past 46 lookups burning all three attempts. Hence the '
            + 'progress deadline (nexttask 9, 42 trials/arm: worker-timeout restarts '
            + '22/24 -> 0/24): the 240s cap now means 240s WITHOUT PROGRESS, up to a '
            + '20-minute backstop. The fan-out extension and carry-forward remain OFF '
            + 'unless their env var is set — see research-fanout-budget.ts.',
        resolve: inputs => {
            const guards = baseGuards()
            guards['worker-timeout'] = {
                timeoutMs: RESEARCH_WORKER_TIMEOUT_MS,
                progressCeilingMs: workerProgressCeilingMs(inputs.env),
                fanout: inputs.fanoutBounded === true ? fanoutTimeoutPolicy(inputs.env) : null
            }
            return {guards, carryForward: workerCarryForward(inputs.env)}
        }
    },
    gate: {
        id: 'gate',
        why:
            'The post-implementation verify/enforce/critique children. They WRITE, '
            + 'and they legitimately read and edit the same file many times, so the '
            + 'research guards mislabel the job as a runaway and kill good work (mx5 '
            + 'TASK_0002). Two departures follow from that. The wall clock is OFF — '
            + 'these passes must be allowed to finish however long they take. And the '
            + 'path-revisit rule is disabled (pathThreshold Infinity), leaving only '
            + 'the exact-match rule, so revisiting one file never trips but a '
            + 'literally-identical call repeated past threshold still does. What '
            + 'replaces the wall clock is the pair the research workers do not need: '
            + 'a per-command watchdog, because a gate child HAS bash and a `bun run '
            + 'dev` it forgot to bound blocks it forever while the stall probe reads '
            + 'the live model endpoint as proof of life; and a stream watchdog, for '
            + "run 14's three hangs on a HEALTHY backend. Both take their ceilings "
            + 'from user config, so they are inputs, not policy.',
        resolve: inputs => {
            const guards = baseGuards()
            guards['command-timeout'] = inputs.commandTimeoutMs ?? 0
            guards['stream-stall'] = inputs.streamInactivityMs ?? 0
            guards['worker-timeout'] = {timeoutMs: 0, progressCeilingMs: null, fanout: null}
            guards.loop = {
                ...guards.loop,
                detector: {...DEFAULT_LOOP_DETECTOR, pathThreshold: Number.POSITIVE_INFINITY}
            }
            return {guards, carryForward: false}
        }
    },
    adhoc: {
        id: 'adhoc',
        why:
            'The model-dispatched `pi-worker` tool: a read-only child with '
            + '`read,grep,find,ls` and nothing else, asked a question the MODEL wrote. '
            + 'It has NO WALL CLOCK, and that is a decision with evidence behind it. '
            + 'It used to run a FIXED 240s cap — total elapsed, not idle — inherited by '
            + 'naming no guards at all. A fixed wall clock on a read-only worker makes '
            + "answer quality a function of the user's hardware: the same prompt on a "
            + 'slower local model loses its work and degrades, which is the argument '
            + 'research-fanout-budget.ts already records against every wall-clock lever '
            + '("no constant fixes that"). THAT ARGUMENT IS WHAT DECIDES THIS, and it '
            + 'needs no measurement. The constant was also already stale: it was sized '
            + 'against "~25-130s on the local backend" — its only stated basis, with no '
            + 'entry in magicknumbers.md — and replaying 28 real recorded prompts after '
            + 'nothing but a MODEL swap on the SAME machine gave median 56s, p90 160s, '
            + 'max 280s, with 5/28 above the 130s it was calibrated to. A bound that '
            + 'must be re-measured whenever the model changes is the wrong bound. '
            + "What replaces it is `stream-stall`, armed from the user's own "
            + '`stuck reply retry` setting: it kills on SILENCE, never on slowness — '
            + '"one token every 30s is a working local model and must never be killed; '
            + 'zero events for the whole window is a hang" — so it needs no calibration '
            + 'and no new setting. Real thrash is still caught by the two runaway '
            + 'detectors and the dead-backend probe, all of which stay on.',
        resolve: inputs => {
            const guards = baseGuards()
            // No wall clock. See `why`: a fixed elapsed-time cap on a read-only
            // worker is a hardware test, not a work test.
            guards['worker-timeout'] = {timeoutMs: 0, progressCeilingMs: null, fanout: null}
            // The silence bound that replaces it — the user's own setting, not a
            // new one. 0 when the caller hands none, which is off, exactly as
            // before: a harness must not silently acquire a guard.
            guards['stream-stall'] = inputs.streamInactivityMs ?? 0
            return {guards, carryForward: false}
        }
        // `as const satisfies`, not an annotation — the same reason RESTART_ORDER
        // gives: an annotation widens each row back to `WorkerProfile`, and the
        // `why` strings and literal ids stop being visible to a reader or a test.
    }
} as const satisfies Record<WorkerProfileId, WorkerProfile>

/** Resolve one profile. The only way a caller should obtain a policy. */
export function workerPolicy(
    id: WorkerProfileId,
    inputs: WorkerPolicyInputs = {}
): WorkerGuardPolicy {
    return WORKER_PROFILES[id].resolve(inputs)
}

/**
 * Lay whole rows over a resolved policy.
 *
 * For tests and A/B harnesses ONLY. Production code names a profile: an override
 * at a production call site is the exact "hand-pick a subset" this module exists
 * to stop, and `worker-profiles.test.ts` fails the build if one appears.
 */
export function applyOverride(
    policy: WorkerGuardPolicy,
    override: WorkerGuardOverride | undefined
): WorkerGuardPolicy {
    if (override === undefined) return policy
    const {carryForward, ...rows} = override
    // Present-but-`undefined` is DROPPED, not laid down. A conditional row is
    // the natural way to write a swept arm — `{'command-timeout': on ? ms :
    // undefined}` — and a plain spread would put `undefined` into the policy,
    // which either disarms the guard silently or throws on `clock.timeoutMs`.
    // The repo has no `exactOptionalPropertyTypes`, so the compiler allows it.
    const set = Object.fromEntries(Object.entries(rows).filter(([, v]) => v !== undefined))
    return {
        guards: {...policy.guards, ...set},
        carryForward: carryForward ?? policy.carryForward
    }
}
