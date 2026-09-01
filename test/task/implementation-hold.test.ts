/**
 * The implementation turn's hold-and-restore.
 *
 * `implementation` is the only group not delivered as a child's argv, so it is
 * the only one that can leak. pi's `setThinkingLevel` writes
 * `defaultThinkingLevel` and its `setModel` writes `defaultModel`, both into the
 * user's GLOBAL settings file — and children resolve those same defaults, so a
 * missing restore re-points every future child in every project. Every case
 * below is a way that could happen.
 */
import {describe, expect, test} from 'bun:test'
import type {ThinkingLevel} from '@earendil-works/pi-agent-core'
import type {GroupSetting} from '../../src/config/reasoning.js'
import {
    holdImplementation,
    restoreHeldModel,
    type ModelControl,
    type ThinkingControl
} from '../../src/task/implementation-hold.js'
import type {HoldStash, StashRecord} from '../../src/task/model-hold-stash.js'

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

// ─── the combined hold ───────────────────────────────────────────────────────

/** A stash that lives in a variable. Nothing here touches a real home dir. */
function fakeStash(): HoldStash & {record?: StashRecord; log: string[]} {
    const s = {
        record: undefined as StashRecord | undefined,
        log: [] as string[],
        read: () => s.record,
        write: (r: StashRecord) => {
            s.log.push(`write:${r.before}->${r.applied}`)
            s.record = r
        },
        clear: () => {
            s.log.push('clear')
            s.record = undefined
        }
    }
    return s
}

/**
 * A model control over plain strings, sharing ONE call log with a thinking
 * control so acquire and release ORDER is assertable. End state cannot show
 * order, and order is the whole reason these two live in one function.
 */
function rig(
    startModel: string | undefined,
    startLevel: ThinkingLevel,
    opts: {
        known?: string[]
        apply?: 'ok' | 'false' | 'throw'
        /** Levels this model clamps to, applied by `apply` like pi's re-clamp. */
        clampOnSwitch?: ThinkingLevel
    } = {}
): {
    controls: {thinking: ThinkingControl; model: ModelControl<string>}
    log: string[]
    level: () => ThinkingLevel
    model: () => string | undefined
} {
    const log: string[] = []
    let level = startLevel
    let current = startModel
    const known = new Set(opts.known ?? [startModel, 'acme/big', 'acme/small'].filter(Boolean))
    const thinking: ThinkingControl = {
        get: () => level,
        set: l => {
            log.push(`thinking:${l}`)
            level = l
        }
    }
    const model: ModelControl<string> = {
        current: () => (current === undefined ? undefined : {spec: current, handle: current}),
        resolve: spec => (known.has(spec) ? spec : undefined),
        apply: async handle => {
            log.push(`model:${handle}`)
            if (opts.apply === 'throw') throw new Error('No API key')
            if (opts.apply === 'false') return false
            current = handle
            // pi re-clamps thinking as part of the switch.
            if (opts.clampOnSwitch !== undefined) level = opts.clampOnSwitch
            return true
        }
    }
    return {controls: {thinking, model}, log, level: () => level, model: () => current}
}

/**
 * The thinking half, driven through the ONE hold there is.
 *
 * There is no thinking-only entry point: `holdImplementation` with an `inherit`
 * model cell IS that path, and a second function for it would be a second thing
 * to keep in step with the ordering rules below.
 */
describe('the thinking half, with the model cell on inherit', () => {
    const noModel = {
        current: () => undefined,
        resolve: () => undefined,
        apply: async () => false
    }
    const hold = async (c: ThinkingControl, setting: GroupSetting) =>
        holdImplementation({thinking: c, model: noModel}, setting, 'inherit', fakeStash())

    test('inherit makes NO write at all', async () => {
        // `inherit` never reads or writes the control, so the user's level is
        // not even observed, let alone set.
        const c = control('medium')
        const release = await hold(c, 'inherit')
        expect(c.writes).toEqual([])
        await release()
        expect(c.writes).toEqual([])
    })

    test('sets the level and puts the old one back', async () => {
        const c = control('high')
        const release = await hold(c, 'off')
        expect(c.level).toBe('off')
        await release()
        expect(c.level).toBe('high')
    })

    test('restores the CLAMPED value it read, never the one it asked for', async () => {
        // A model that cannot do `medium` leaves the session at `off`. The hold
        // re-reads the level after setting it, so the restore compares against
        // what the clamp produced rather than what was asked for.
        const c = control('high', () => 'off')
        const release = await hold(c, 'medium')
        expect(c.level).toBe('off')
        await release()
        expect(c.writes).toEqual(['medium', 'high'])
        expect(c.level).toBe('off') // the clamp still applies to the restore
    })

    test('a clamp that lands back on the starting level makes no restore', async () => {
        // Nothing changed, so there is nothing to put back — and a restore here
        // would be a settings.json write for no reason.
        const c = control('off', () => 'off')
        const release = await hold(c, 'medium')
        await release()
        expect(c.writes).toEqual(['medium'])
    })

    test('a user change mid-turn is not clobbered', async () => {
        // `shift+tab` is pi's default binding for `app.thinking.cycle`, so the user
        // can move the level mid-turn. The release only restores when the live level
        // still equals what it applied, so a newer choice survives.
        const c = control('high')
        const release = await hold(c, 'off')
        c.set('low') // the user, mid-turn
        await release()
        expect(c.level).toBe('low')
        expect(c.writes).toEqual(['off', 'low'])
    })

    test('release is idempotent', async () => {
        // Only the first call restores. A second would write the pre-hold level on
        // top of whatever the level has become since.
        const c = control('high')
        const release = await hold(c, 'off')
        await release()
        await release()
        await release()
        expect(c.writes).toEqual(['off', 'high'])
    })
})

describe('holdImplementation', () => {
    test('an `inherit` model cell makes ZERO model calls', async () => {
        const r = rig('acme/big', 'off')
        const release = await holdImplementation(r.controls, 'medium', 'inherit', fakeStash())
        await release()
        expect(r.log.filter(l => l.startsWith('model:'))).toEqual([])
    })

    test('target === current makes NO setModel call at all', async () => {
        // Not an optimisation. pi writes the global default unconditionally, so a
        // redundant call rewrites settings and re-bills the prompt for nothing.
        const r = rig('acme/big', 'off')
        const stash = fakeStash()
        const release = await holdImplementation(r.controls, 'medium', 'acme/big', stash)
        await release()
        expect(r.log.filter(l => l.startsWith('model:'))).toEqual([])
        expect(stash.log).toEqual([])
    })

    test('a model that will not resolve leaves the thinking hold intact', async () => {
        const r = rig('acme/big', 'off', {known: ['acme/big']})
        const release = await holdImplementation(r.controls, 'medium', 'acme/gone', fakeStash())
        expect(r.level()).toBe('medium')
        await release()
        expect(r.level()).toBe('off')
    })

    test('acquire order is model, THEN thinking', async () => {
        const r = rig('acme/big', 'off')
        await holdImplementation(r.controls, 'medium', 'acme/small', fakeStash())
        expect(r.log).toEqual(['model:acme/small', 'thinking:medium'])
    })

    test('release order is model, THEN thinking', async () => {
        // Writing the level back while still on the target has pi clamp it to
        // the TARGET's ladder, and the model restore re-clamps from that.
        const r = rig('acme/big', 'off')
        const release = await holdImplementation(r.controls, 'medium', 'acme/small', fakeStash())
        r.log.length = 0
        await release()
        expect(r.log).toEqual(['model:acme/big', 'thinking:off'])
    })

    test('the PRE-SWITCH level is what gets restored', async () => {
        // The fake re-clamps on every switch, exactly as pi does. A `before`
        // read after the model move would restore the clamped value instead.
        const r = rig('acme/big', 'high', {clampOnSwitch: 'off'})
        const release = await holdImplementation(r.controls, 'medium', 'acme/small', fakeStash())
        await release()
        expect(r.level()).toBe('high')
    })

    for (const mode of ['false', 'throw'] as const) {
        test(`apply returning ${mode} applies NOTHING and releases clean`, async () => {
            // Half-applying runs the turn on the wrong model at the right level,
            // which is worse than running it exactly as it ran last week.
            const r = rig('acme/big', 'off', {apply: mode})
            const stash = fakeStash()
            const release = await holdImplementation(r.controls, 'medium', 'acme/small', stash)
            expect(r.level()).toBe('off')
            expect(r.model()).toBe('acme/big')
            await release()
            expect(r.level()).toBe('off')
            expect(stash.record).toBeUndefined()
        })
    }

    test('the stash is written BEFORE the apply, and cleared on release', async () => {
        const r = rig('acme/big', 'off')
        const stash = fakeStash()
        const release = await holdImplementation(r.controls, 'medium', 'acme/small', stash)
        expect(stash.log[0]).toBe('write:acme/big->acme/small')
        expect(stash.record).toEqual({before: 'acme/big', applied: 'acme/small'})
        await release()
        expect(stash.record).toBeUndefined()
    })

    test('a user thinking change mid-turn is not clobbered, but the model is still put back', async () => {
        const r = rig('acme/big', 'off')
        const release = await holdImplementation(r.controls, 'medium', 'acme/small', fakeStash())
        r.controls.thinking.set('high')
        await release()
        expect(r.level()).toBe('high')
        expect(r.model()).toBe('acme/big')
    })

    test('a failed model restore is STILL followed by the thinking restore', async () => {
        const r = rig('acme/big', 'off')
        const release = await holdImplementation(r.controls, 'medium', 'acme/small', fakeStash())
        r.controls.model.apply = async () => {
            throw new Error('gone')
        }
        await release()
        // Restoring what we can beats restoring nothing.
        expect(r.level()).toBe('off')
    })

    test('release twice restores once', async () => {
        const r = rig('acme/big', 'off')
        const release = await holdImplementation(r.controls, 'medium', 'acme/small', fakeStash())
        await release()
        r.log.length = 0
        await release()
        expect(r.log).toEqual([])
    })
})

describe('restoreHeldModel — the crash path', () => {
    test('nothing stashed, nothing done', async () => {
        const r = rig('acme/small', 'off')
        expect(await restoreHeldModel(r.controls.model, () => 'acme/small', fakeStash())).toBe(
            'nothing'
        )
    })

    test('puts the model back when the saved default is still what we applied', async () => {
        const r = rig('acme/small', 'off')
        const stash = fakeStash()
        stash.record = {before: 'acme/big', applied: 'acme/small'}
        expect(await restoreHeldModel(r.controls.model, () => 'acme/small', stash)).toBe('restored')
        expect(r.model()).toBe('acme/big')
        expect(stash.record).toBeUndefined()
    })

    test('DECLINES when the saved default has moved on — the concurrent-session guard', async () => {
        // A second session picked its own model. A crashed session must not
        // stomp it, so the note is dropped and nothing is written.
        const r = rig('acme/third', 'off')
        const stash = fakeStash()
        stash.record = {before: 'acme/big', applied: 'acme/small'}
        expect(await restoreHeldModel(r.controls.model, () => 'acme/third', stash)).toBe('declined')
        expect(r.model()).toBe('acme/third')
        expect(stash.record).toBeUndefined()
    })

    test('DECLINES when THIS session was launched on another model, and KEEPS the note', async () => {
        // `pi --model X` never writes settings.json, so the file still names the
        // crashed session's model and the first guard passes. Restoring would
        // silently override a choice made on the command line. The note stays,
        // so an ordinary start later still repairs the file.
        const r = rig('acme/cli-choice', 'off', {known: ['acme/big', 'acme/cli-choice']})
        const stash = fakeStash()
        stash.record = {before: 'acme/big', applied: 'acme/small'}
        expect(await restoreHeldModel(r.controls.model, () => 'acme/small', stash)).toBe('declined')
        expect(r.model()).toBe('acme/cli-choice')
        expect(stash.record).toEqual({before: 'acme/big', applied: 'acme/small'})
    })

    test('a note whose `before` is still the saved default is LEFT ALONE', async () => {
        // The write-then-apply window: a hold writes its note before switching,
        // so an unrelated session starting right then sees settings still on
        // `before`. Clearing here would delete a live hold's only crash record.
        const r = rig('acme/big', 'off')
        const stash = fakeStash()
        stash.record = {before: 'acme/big', applied: 'acme/small'}
        expect(await restoreHeldModel(r.controls.model, () => 'acme/big', stash)).toBe('declined')
        expect(stash.record).toEqual({before: 'acme/big', applied: 'acme/small'})
    })

    test('a restore that cannot happen still drops the note', async () => {
        // Otherwise it re-fires on every startup, forever.
        const r = rig('acme/small', 'off', {known: ['acme/small'], apply: 'throw'})
        const stash = fakeStash()
        stash.record = {before: 'acme/gone', applied: 'acme/small'}
        expect(await restoreHeldModel(r.controls.model, () => 'acme/small', stash)).toBe('declined')
        expect(stash.record).toBeUndefined()
    })
})

describe('a model-only hold still restores the thinking level', () => {
    test('an `inherit` thinking cell does NOT excuse the level pi moved', async () => {
        // pi's setModel re-clamps to the target's ladder and PERSISTS the
        // result, so a model switch moves the global default even when nothing
        // asked for a level. Releasing the model without releasing the level
        // leaves the user permanently downgraded — the exact leak release()
        // exists to stop.
        const r = rig('acme/big', 'high', {clampOnSwitch: 'medium'})
        const release = await holdImplementation(r.controls, 'inherit', 'acme/small', fakeStash())
        expect(r.level()).toBe('medium')
        await release()
        expect(r.level()).toBe('high')
    })

    test('both cells inherit ⇒ still not a single write', async () => {
        const r = rig('acme/big', 'high', {clampOnSwitch: 'medium'})
        const release = await holdImplementation(r.controls, 'inherit', 'inherit', fakeStash())
        await release()
        expect(r.log).toEqual([])
    })

    test('a model switch that does NOT move the level restores nothing', async () => {
        const r = rig('acme/big', 'high')
        const release = await holdImplementation(r.controls, 'inherit', 'acme/small', fakeStash())
        r.log.length = 0
        await release()
        // The model goes back; the level was never touched, so it is not written.
        expect(r.log).toEqual(['model:acme/big'])
    })
})
