/**
 * Hold the host session at the `implementation` group's thinking level for the
 * duration of one implementation turn, then put it back.
 *
 * WHY THIS GROUP IS NOT LIKE THE OTHERS
 * -------------------------------------
 * Every other reasoning group runs in a child process, so its level is one argv
 * flag (`--thinking <level>`, built in reasoning-args.ts) and it dies with the
 * child. The implementation turn runs in the USER'S OWN session
 * (orchestrator.ts `sendSpec` -> `sendUserMessage` -> `superviseImplementation`),
 * so the only lever is `pi.setThinkingLevel`, which is session-global.
 *
 * THREE THINGS pi DOES that this has to survive:
 *
 *  1. IT PERSISTS. pi-coding-agent's agent-session `setThinkingLevel` calls
 *     `settingsManager.setDefaultThinkingLevel(...)` whenever the effective
 *     level actually changes, and that writes pi's global settings file
 *     (`~/.pi/agent/settings.json`). Without the restore, running one task would
 *     silently rewrite the user's global default. That makes `release()`
 *     load-bearing, not tidy-up.
 *  2. IT CLAMPS, to the levels the model declares. A model with no reasoning
 *     support offers only `off`, so asking for `medium` yields `off`. The
 *     restore therefore writes back what was READ after setting, never what was
 *     asked for — otherwise a clamp would ratchet the stored default a little
 *     further every run.
 *  3. IT IS OBSERVABLE, and the user can change it mid-turn: `shift+tab` is the
 *     default binding for `app.thinking.cycle`, and a change invalidates the
 *     footer. Restoring blindly would clobber a choice they just made. We detect
 *     it by comparing the live level at release against what we applied: if it
 *     has moved, somebody else moved it, and we leave it alone.
 *
 * We compare rather than subscribe because the extension API's `on(...)` returns
 * `void` — there is no unsubscribe handle — so a per-turn listener could only
 * ever be added, never removed. The comparison answers the same question with no
 * accumulating state.
 */
import type {ThinkingLevel} from '@earendil-works/pi-agent-core'
import {getConfig} from '../config/config.js'
import {resolveReasoning, type GroupSetting} from '../config/reasoning.js'

/**
 * The slice of the extension API this needs, named so tests can drive the
 * hold-and-restore with a fake object instead of a live pi session.
 */
export interface ThinkingControl {
    get(): ThinkingLevel
    set(level: ThinkingLevel): void
}

/**
 * Put the session at the implementation group's level and return the function
 * that puts it back. Always call the returned function — `finally`, not the
 * happy path.
 *
 * `inherit` makes NO call at all, not even a redundant set-to-current. It means
 * the same thing here as in `thinkingArgs`, which emits no `--thinking` flag for
 * it: leave the level wherever it already is.
 */
export function holdImplementationThinking(
    control: ThinkingControl,
    setting: GroupSetting = resolveReasoning('implementation', getConfig())
): () => void {
    if (setting === 'inherit') return () => {}
    const before = control.get()
    control.set(setting)
    // Post-clamp, so a model that cannot do `medium` does not leave us believing
    // it is at `medium` and treating the user's later change as our own.
    const applied = control.get()
    if (applied === before) return () => {}
    let released = false
    return () => {
        // Idempotent by contract: only the first call restores. A later call
        // would write `before` on top of whatever the level is by then.
        if (released) return
        released = true
        if (control.get() === applied) control.set(before)
    }
}
