/**
 * The implementation turn's hold-and-restore.
 *
 * `implementation` is the only reasoning group not delivered as a child's argv,
 * so it is the only one that can leak. pi's `setThinkingLevel` calls
 * `settingsManager.setDefaultThinkingLevel` whenever the effective level changes,
 * and that writes pi's global settings file — so a missing restore rewrites the
 * USER'S GLOBAL DEFAULT. Every case below is a way that could happen.
 */
import {describe, expect, test} from 'bun:test'
import type {ThinkingLevel} from '@earendil-works/pi-agent-core'
import {
    holdImplementationThinking,
    type ThinkingControl
} from '../../src/task/implementation-thinking.js'

/**
 * A control that records every write, and can be told to CLAMP. pi's
 * `setThinkingLevel` clamps to `getAvailableThinkingLevels()`, so asking for a
 * level the model does not declare stores a different one.
 */
function control(
    start: ThinkingLevel,
    clamp: (level: ThinkingLevel) => ThinkingLevel = l => l
): ThinkingControl & {level: ThinkingLevel; writes: ThinkingLevel[]} {
    const c = {
        level: start,
        writes: [] as ThinkingLevel[],
        get: () => c.level,
        set: (level: ThinkingLevel) => {
            c.writes.push(level)
            c.level = clamp(level)
        }
    }
    return c
}

describe('holdImplementationThinking', () => {
    test('inherit makes NO write at all', () => {
        // `inherit` returns a no-op closure before it ever reads or writes the
        // control, so the user's level is not even observed, let alone set.
        const c = control('medium')
        const release = holdImplementationThinking(c, 'inherit')
        expect(c.writes).toEqual([])
        release()
        expect(c.writes).toEqual([])
    })

    test('sets the level and puts the old one back', () => {
        const c = control('high')
        const release = holdImplementationThinking(c, 'off')
        expect(c.level).toBe('off')
        release()
        expect(c.level).toBe('high')
    })

    test('restores the CLAMPED value it read, never the one it asked for', () => {
        // A model that cannot do `medium` leaves the session at `off`. The hold
        // re-reads the level after setting it, so the restore compares against
        // what the clamp produced rather than what was asked for.
        const c = control('high', () => 'off')
        const release = holdImplementationThinking(c, 'medium')
        expect(c.level).toBe('off')
        release()
        expect(c.writes).toEqual(['medium', 'high'])
        expect(c.level).toBe('off') // the clamp still applies to the restore
    })

    test('a clamp that lands back on the starting level makes no restore', () => {
        // Nothing changed, so there is nothing to put back — and a restore here
        // would be a settings.json write for no reason.
        const c = control('off', () => 'off')
        const release = holdImplementationThinking(c, 'medium')
        release()
        expect(c.writes).toEqual(['medium'])
    })

    test('a user change mid-turn is not clobbered', () => {
        // `shift+tab` is pi's default binding for `app.thinking.cycle`, so the user
        // can move the level mid-turn. The release only restores when the live level
        // still equals what it applied, so a newer choice survives.
        const c = control('high')
        const release = holdImplementationThinking(c, 'off')
        c.set('low') // the user, mid-turn
        release()
        expect(c.level).toBe('low')
        expect(c.writes).toEqual(['off', 'low'])
    })

    test('release is idempotent', () => {
        // Only the first call restores. A second would write the pre-hold level on
        // top of whatever the level has become since.
        const c = control('high')
        const release = holdImplementationThinking(c, 'off')
        release()
        release()
        release()
        expect(c.writes).toEqual(['off', 'high'])
    })
})
