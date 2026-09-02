/**
 * Hold the host session on the `implementation` group's model AND thinking level
 * for one implementation turn, then put both back.
 *
 * WHY THIS GROUP IS NOT LIKE THE OTHERS
 * -------------------------------------
 * Every other group runs in a child process, so its settings are two argv flags
 * (`groupChildArgs` in config/group-args.ts) that die with the child. The
 * implementation turn runs in the USER'S OWN session (orchestrator.ts `sendSpec`
 * -> `sendUserMessage` -> `superviseImplementation`), so the only levers are
 * `pi.setThinkingLevel` and `pi.setModel`, and both are session-global.
 *
 * WHAT pi DOES that this has to survive:
 *
 *  1. BOTH PERSIST. `setThinkingLevel` writes `defaultThinkingLevel` and
 *     `setModel` writes `defaultProvider`/`defaultModel`, into pi's global
 *     `~/.pi/agent/settings.json`. Without the restore, running one task would
 *     silently rewrite the user's global defaults — and since children carry no
 *     `-m` and resolve exactly those defaults, it would re-point every future
 *     child in every project. That makes `release()` load-bearing, not tidy-up.
 *  2. THEY CLAMP. A model with no reasoning support offers only `off`, so asking
 *     for `medium` yields `off`. The restore writes back what was READ after
 *     setting, never what was asked for, or a clamp would ratchet the stored
 *     default further every run.
 *  3. `setModel` RE-CLAMPS THINKING as part of switching. So the level must be
 *     read before any model move, and written after the model is back.
 *  4. THE USER CAN CHANGE EITHER MID-TURN — `shift+tab` cycles thinking. We
 *     detect it by comparing the live value at release against what we applied:
 *     if it has moved, somebody else moved it, and we leave it alone.
 *
 * We compare rather than subscribe because the extension API's `on(...)` returns
 * `void` — there is no unsubscribe handle — so a per-turn listener could only
 * ever be added, never removed.
 *
 * WHAT THIS COSTS, so nobody has to rediscover it
 * -----------------------------------------------
 * A model switch re-bills the whole prompt. pi counts that deliberately —
 * `core/cache-stats.js` says "Model switches are NOT exempt: they re-bill the
 * full prompt and should be counted" — and prints `Cache miss after model
 * switch: N tokens re-billed` once the miss clears 20k tokens or $0.10, which an
 * implementation prompt does. It happens twice: once acquiring, once releasing.
 * On a local server that is a full prompt reprocess, not a bill. This is why the
 * cell ships `inherit`, and why the target-equals-current degrade below is the
 * main guard rather than an optimisation.
 */
import type {ThinkingLevel} from '@earendil-works/pi-agent-core'
import {getConfig} from '../config/config.js'
import {MODEL_INHERIT} from '../config/group-models.js'
import {resolveReasoning, type GroupSetting} from '../config/reasoning.js'
import {resolveModel, type ModelContext, type PiModel} from '../shared/model-resolve.js'
import {readHoldStash, writeHoldStash, clearHoldStash, type HoldStash} from './model-hold-stash.js'

/**
 * The slice of the extension API this needs, named so tests can drive the
 * hold-and-restore with a fake object instead of a live pi session.
 */
export interface ThinkingControl {
    get(): ThinkingLevel
    set(level: ThinkingLevel): void
}

/**
 * The model half, generic in the HANDLE so tests can use a literal.
 *
 * `current()` returns the spec AND the handle: the comparison is on a plain
 * string, and the restore uses the handle captured at acquire rather than
 * re-resolving against a registry that may have moved underneath us.
 *
 * `apply` may return `false` OR REJECT. pi's `setModel` returns false only when
 * `hasConfiguredAuth` — a cached snapshot Set — is false; it then calls the
 * session's own `setModel`, which awaits a live `checkAuth` and throws when the
 * two disagree, as they do for an expired OAuth token. Callers here treat a
 * throw and a `false` identically, because nothing useful differs between them.
 */
export interface ModelControl<H = unknown> {
    current(): {spec: string; handle: H} | undefined
    resolve(spec: string): H | undefined
    apply(handle: H): Promise<boolean>
}

export interface ImplementationControls<H = unknown> {
    thinking: ThinkingControl
    model: ModelControl<H>
}

/**
 * The live session's model as a {@link ModelControl}, for both the turn's hold
 * and the crash restore at session_start.
 *
 * `current()` reads `ctx.model`, which is a live GETTER on the extension
 * context (pi's `core/extensions/runner.js`), so a read after a set is the new
 * value. `apply` is the caller's because the setter lives on `ExtensionAPI`,
 * which the two callers hold differently.
 */
export function liveModelControl(
    ctx: ModelContext,
    apply: (handle: PiModel) => Promise<boolean>
): ModelControl<PiModel> {
    return {
        current: () => {
            const m = resolveModel(ctx, MODEL_INHERIT)
            return m && {spec: m.spec, handle: m.handle}
        },
        resolve: spec => resolveModel(ctx, spec)?.handle,
        apply
    }
}

/** What acquire wrote, so release knows what it is allowed to undo. */
interface ThinkingHold {
    before: ThinkingLevel
    applied: ThinkingLevel
}

interface ModelHold<H> {
    before: H
    beforeSpec: string
    appliedSpec: string
}

/**
 * `before` is the level read BEFORE any model move; `applied` is what is really
 * in force after both moves.
 *
 * `inherit` writes nothing but still RECORDS, because the model switch may have
 * moved the level on its own. `applied === before` means nothing moved, and then
 * there is nothing to restore — a write there would be a settings.json write for
 * no reason.
 */
function acquireThinking(
    control: ThinkingControl,
    setting: GroupSetting,
    before: ThinkingLevel
): ThinkingHold | undefined {
    if (setting !== 'inherit') control.set(setting)
    // Post-clamp, so a model that cannot do `medium` does not leave us believing
    // it is at `medium` and treating the user's later change as our own.
    const applied = control.get()
    return applied === before ? undefined : {before, applied}
}

const userMovedThinking = (control: ThinkingControl, hold: ThinkingHold): boolean =>
    control.get() !== hold.applied

/**
 * The whole hold: model, then thinking. Returns the release, which is async and
 * idempotent. Always call it from a `finally`, never the happy path.
 *
 * ONE function rather than two composable holds, because two independent holds
 * acquired in the wrong order fail SILENTLY — `setModel` re-clamps thinking, so
 * a thinking hold taken first is erased and a thinking restore taken last is
 * clamped by the wrong model's ladder. A composition that can only be assembled
 * one way belongs in one function.
 */
export async function holdImplementation<H>(
    controls: ImplementationControls<H>,
    setting: GroupSetting = resolveReasoning('implementation', getConfig()),
    spec: string = getConfig().groupModels.implementation,
    stash: HoldStash = {read: readHoldStash, write: writeHoldStash, clear: clearHoldStash}
): Promise<() => Promise<void>> {
    const {thinking, model} = controls
    // BEFORE any model move: `setModel` re-clamps, so this is the only moment
    // the pre-hold level is readable.
    const beforeThinking = thinking.get()

    const modelHold = await acquireModel(model, spec, stash)
    // A model move that was ASKED FOR and failed no-ops the whole hold. Running
    // the implementation turn on the wrong model at the right level is worse
    // than running it exactly as it ran last week.
    if (modelHold === 'failed') return async () => {}

    // A MODEL move alone moves the level, even with the thinking cell on
    // `inherit`: pi's `setModel` re-clamps to the target's ladder and PERSISTS
    // the result. So the thinking hold is taken whenever either half moved
    // something, not only when a level was asked for — otherwise a session at
    // `high` switched onto an off/medium model is left globally at `medium`
    // with nothing to put it back, which is the one thing release() exists for.
    const thinkingHold =
        setting === 'inherit' && modelHold === undefined ?
            undefined
        :   acquireThinking(thinking, setting, beforeThinking)

    let released = false
    return async () => {
        if (released) return
        released = true
        // Read the thinking comparison BEFORE restoring the model. A read taken
        // after it is post-clamp, and the mid-turn-change detector then answers
        // wrongly in both directions.
        const moved = thinkingHold !== undefined && userMovedThinking(thinking, thinkingHold)

        if (modelHold !== undefined) {
            try {
                await model.apply(modelHold.before)
            } catch {
                // A failed model restore is still followed by the thinking
                // restore. Restoring what we can beats restoring nothing.
            }
            stash.clear()
        }

        // LAST. Writing `before` while still on the target model has pi clamp it
        // to the TARGET's ladder, and the model restore then re-clamps from that
        // already-wrong value.
        if (thinkingHold !== undefined && !moved) thinking.set(thinkingHold.before)
    }
}

/**
 * `undefined` = no move was needed or possible, and today's behaviour stands.
 * `'failed'` = a move was asked for and did not happen, which voids the hold.
 */
async function acquireModel<H>(
    model: ModelControl<H>,
    spec: string,
    stash: HoldStash
): Promise<ModelHold<H> | undefined | 'failed'> {
    if (spec === MODEL_INHERIT) return undefined
    const cur = model.current()
    if (!cur) return undefined
    // Not an optimisation. `setDefaultModelAndProvider` runs unconditionally
    // inside pi's `setModel`, so a redundant call rewrites the user's global
    // default, appends a model change to their session and re-bills the whole
    // prompt as a cache miss — all to arrive where we already were.
    if (cur.spec === spec) return undefined
    const handle = model.resolve(spec)
    // Model gone, or its provider unauthed. The session hint names it; the turn
    // runs where it already was.
    if (handle === undefined) return undefined

    // Written BEFORE the apply, so a crash between the two costs an unnecessary
    // restore attempt rather than a missed one.
    stash.write({before: cur.spec, applied: spec})
    try {
        if (await model.apply(handle))
            return {before: cur.handle, beforeSpec: cur.spec, appliedSpec: spec}
    } catch {
        // Identical to `false`: see ModelControl.apply.
    }
    stash.clear()
    return 'failed'
}

/**
 * Put back a model a crashed session left applied. Runs at `session_start`.
 *
 * THE GUARDS are the whole design, because this runs in a session that knows
 * nothing about the one that crashed. Four cases, and only the last writes:
 *
 *  1. pi's saved default is still the note's `before` — the file is already
 *     right. Either a live hold has written its note but not yet switched, or a
 *     crash landed in that same gap. Decline, and KEEP the note: clearing here
 *     is what would let an unrelated session start delete a live hold's only
 *     crash record, in the millisecond before it applies.
 *  2. the saved default is neither value — somebody moved on. Clear, decline.
 *  3. the saved default matches, but THIS session is on a different model — it
 *     was launched with an explicit `--model`, or resumed onto one. Restoring
 *     would silently override a choice made on the command line. Decline, and
 *     keep the note so a later ordinary start still repairs the file.
 *  4. everything agrees. Restore, and clear.
 *
 * The note is also cleared on a failed restore: one that cannot happen must not
 * re-fire on every subsequent startup.
 *
 * Thinking is deliberately NOT restored here. `setModel` re-clamps it to the
 * model we are restoring TO, which is the level that model was running at
 * before the crashed session touched anything.
 */
export async function restoreHeldModel<H>(
    model: ModelControl<H>,
    savedDefaultSpec: () => string | undefined,
    stash: HoldStash = {read: readHoldStash, write: writeHoldStash, clear: clearHoldStash}
): Promise<'restored' | 'declined' | 'nothing'> {
    const note = stash.read()
    if (!note) return 'nothing'
    const saved = savedDefaultSpec()
    if (saved === note.before) return 'declined'
    if (saved !== note.applied) {
        stash.clear()
        return 'declined'
    }
    if (model.current()?.spec !== note.applied) return 'declined'
    const handle = model.resolve(note.before)
    if (handle === undefined) {
        stash.clear()
        return 'declined'
    }
    try {
        return (await model.apply(handle)) ? 'restored' : 'declined'
    } catch {
        return 'declined'
    } finally {
        stash.clear()
    }
}
