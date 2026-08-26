/**
 * Hold the host session at the `implementation` group's thinking level for the
 * duration of one implementation turn, then put it back.
 *
 * WHY THIS IS NOT LIKE THE OTHER SIX GROUPS
 * -----------------------------------------
 * Every other group is a child process, so its level is one argv flag and it
 * dies with the child. The implementation turn runs in the USER'S OWN session
 * (orchestrator.ts `sendSpec` → sendUserMessage → superviseImplementation), so
 * the only lever is `pi.setThinkingLevel`, which is session-global and visible.
 *
 * THREE THINGS pi DOES that this has to survive. All three read from
 * pi-coding-agent's agent-session `setThinkingLevel`:
 *
 *  1. IT PERSISTS. On a real change it calls
 *     `settingsManager.setDefaultThinkingLevel(...)`, writing
 *     `~/.pi/agent/settings.json`. This is not a session-local toggle — without
 *     the restore, running one task would silently rewrite the user's global
 *     default. That makes `release()` load-bearing, not tidy-up.
 *  2. IT CLAMPS, to what the model declares it supports. We may ask for `medium`
 *     and be given `off`. So the restore writes back what was READ after
 *     setting, never what was asked for — otherwise a clamp would ratchet the
 *     stored default a little further every run.
 *  3. IT IS OBSERVABLE, and the user can change it mid-turn (shift+tab cycles
 *     the level). Restoring blindly would clobber a choice they just made. We
 *     detect it by comparing the live level at release against what we applied:
 *     if it has moved, somebody else moved it, and we leave it alone.
 *
 * We compare rather than subscribe because `pi.on` returns no unsubscribe
 * handle, so a per-turn listener could only ever be added, never removed. The
 * comparison answers the same question with no accumulating state.
 */
import type {ThinkingLevel} from '@earendil-works/pi-agent-core'
import {getConfig} from '../config/config.js'
import {resolveReasoning, type GroupSetting} from '../config/reasoning.js'

/**
 * The slice of the extension API this needs, named so tests can drive it without
 * a live pi session. Every other dependency in `RunSingleTaskOptions` is
 * injectable; this one has to be too, or the restore logic is only exercisable
 * by running a real task.
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
 * `inherit` makes NO call at all, not even a redundant set-to-current: a set
 * that happens to be a no-op still goes through pi's change detection, and the
 * shipped default must not touch the user's settings file.
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
        // Idempotent: the caller's `finally` may run alongside an outer one on an
        // abort path, and a second restore would fight a user change made in
        // between.
        if (released) return
        released = true
        if (control.get() === applied) control.set(before)
    }
}
