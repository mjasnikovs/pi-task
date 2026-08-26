/**
 * The implementation turn's hold-and-restore.
 *
 * This is the only reasoning group whose setting is not a child's argv, so it is
 * the only one that can leak: `pi.setThinkingLevel` writes
 * `~/.pi/agent/settings.json`, so a missing restore rewrites the USER'S GLOBAL
 * DEFAULT every time a task runs. Every case below is a way that could happen.
 */
import {describe, expect, test} from 'bun:test'
import type {ThinkingLevel} from '@earendil-works/pi-agent-core'
import {holdImplementationThinking, type ThinkingControl} from './implementation-thinking.js'

/**
 * A control that records every write, and can be told to CLAMP — which is what
 * pi does when a model does not support the level asked for.
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
        // Not even a redundant set-to-current: a no-op set still goes through
        // pi's change detection, and the shipped default must never touch the
        // user's settings file.
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
        // A model that cannot do `medium` leaves the session at `off`. Restoring
        // to the requested level would write a level the model never accepted,
        // and on the next run it would clamp again from there — a ratchet.
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
        // shift+tab cycles the level while the implementation turn runs. Their
        // choice is newer than ours and must survive the release.
        const c = control('high')
        const release = holdImplementationThinking(c, 'off')
        c.set('low') // the user, mid-turn
        release()
        expect(c.level).toBe('low')
        expect(c.writes).toEqual(['off', 'low'])
    })

    test('release is idempotent', () => {
        // An abort path can run an outer finally alongside the inner one, and a
        // second restore would fight a change made in between.
        const c = control('high')
        const release = holdImplementationThinking(c, 'off')
        release()
        release()
        release()
        expect(c.writes).toEqual(['off', 'high'])
    })
})
