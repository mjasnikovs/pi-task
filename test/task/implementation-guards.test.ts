import {afterEach, describe, expect, test} from 'bun:test'
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'
import {
    armImplementationGuard,
    disarmImplementationGuard,
    implementationGuardArmed,
    registerImplementationGuards
} from '../../src/task/implementation-guards.js'
import {LOOP_THRESHOLD, MAX_LOOP_RESTARTS} from '../../src/task/loop-detector.js'

interface Block {
    block?: boolean
    terminate?: boolean
    reason?: string
}

function fakePi(): {
    pi: ExtensionAPI
    emit: (name: string, event?: unknown) => Block | undefined
    names: () => string[]
} {
    const handlers = new Map<string, (e: unknown) => unknown>()
    const pi = {
        on: (name: string, fn: (e: unknown) => unknown) => {
            handlers.set(name, fn)
        }
    } as unknown as ExtensionAPI
    return {
        pi,
        emit: (name, event = {}) => handlers.get(name)?.(event) as Block | undefined,
        names: () => [...handlers.keys()].sort()
    }
}

/** Calls as pi delivers them — `{toolName, input}`, verified against its types. */
const bash = (command: string): unknown => ({toolName: 'bash', input: {command}})
const edit = (file_path: string, oldText: string): unknown => ({
    toolName: 'edit',
    input: {file_path, oldText, newText: `${oldText}!`}
})
const write = (file_path: string, content: string): unknown => ({
    toolName: 'write',
    input: {file_path, content}
})

const armed = (oneShot = true): ReturnType<typeof fakePi> => {
    const f = fakePi()
    registerImplementationGuards(f.pi)
    armImplementationGuard({oneShot})
    return f
}

/** Emit `call` until it is blocked, returning every verdict served. */
function verdictsFor(f: ReturnType<typeof fakePi>, call: unknown, times: number): Block[] {
    const out: Block[] = []
    for (let i = 0; i < times; i++) {
        const r = f.emit('tool_call', call)
        if (r?.block) out.push(r)
    }
    return out
}

afterEach(() => disarmImplementationGuard())

describe('registerImplementationGuards', () => {
    test('subscribes to exactly the events it acts on', () => {
        const f = fakePi()
        registerImplementationGuards(f.pi)
        expect(f.names()).toEqual(['agent_settled', 'session_shutdown', 'tool_call'])
    })

    test('is inert until armed — an unarmed session is untouched', () => {
        const f = fakePi()
        registerImplementationGuards(f.pi)
        const cmd = bash('bun test')
        for (let i = 0; i < LOOP_THRESHOLD * 3; i++) {
            expect(f.emit('tool_call', cmd)).toBeUndefined()
        }
    })
})

describe('the measured runaway', () => {
    // The recorded incident: two byte-identical bash commands, 3,300 each, output
    // frozen. The exact-repeat rule is what catches that shape; bash args carry no
    // path key, so the path rule could never have fired on it.
    test('blocks a byte-identical repeat at the threshold, not before', () => {
        const f = armed()
        const cmd = bash('AGENT=1 bun test')
        for (let i = 0; i < LOOP_THRESHOLD - 1; i++) {
            expect(f.emit('tool_call', cmd)).toBeUndefined()
        }
        const hit = f.emit('tool_call', cmd)!
        expect(hit.block).toBe(true)
        expect(hit.reason).toContain('bash')
    })

    test('the incident shape — two alternating commands and no edits — is caught', () => {
        const f = armed()
        for (let i = 0; i < LOOP_THRESHOLD - 1; i++) {
            expect(f.emit('tool_call', bash('bun test'))).toBeUndefined()
            expect(f.emit('tool_call', bash('git diff'))).toBeUndefined()
        }
        expect(f.emit('tool_call', bash('bun test'))?.block).toBe(true)
    })

    test("a DIFFERENT call is never blocked by another call's window", () => {
        const f = armed()
        for (let i = 0; i < LOOP_THRESHOLD - 1; i++) f.emit('tool_call', bash('bun test'))
        expect(f.emit('tool_call', bash('bun run build'))).toBeUndefined()
        // And the repeat it was interleaved with still trips on schedule.
        expect(f.emit('tool_call', bash('bun test'))?.block).toBe(true)
    })

    test('argument key order does not defeat it', () => {
        const f = armed()
        const a = {toolName: 'read', input: {path: '/a', offset: 1}}
        const b = {toolName: 'read', input: {offset: 1, path: '/a'}}
        for (let i = 0; i < LOOP_THRESHOLD - 1; i++) f.emit('tool_call', i % 2 ? a : b)
        expect(f.emit('tool_call', a)?.block).toBe(true)
    })
})

describe('real work is not blocked', () => {
    /**
     * THE regression. A TDD cycle repeats one byte-identical test command forever
     * while the edits differ, so an exact-repeat rule with no notion of progress
     * blocks it on the fifth test run and terminates the turn on the seventh.
     */
    test('a TDD cycle runs indefinitely — an edit resets the window', () => {
        const f = armed()
        for (let i = 0; i < 40; i++) {
            expect(f.emit('tool_call', edit('/src/a.ts', `v${i}`))).toBeUndefined()
            expect(f.emit('tool_call', bash('bun test'))).toBeUndefined()
        }
    })

    test('a write resets the window too', () => {
        const f = armed()
        for (let i = 0; i < 40; i++) {
            expect(f.emit('tool_call', write('/src/a.ts', `v${i}`))).toBeUndefined()
            expect(f.emit('tool_call', bash('bun test'))).toBeUndefined()
        }
    })

    /**
     * Both detectors must run with path-revisit OFF. At the default threshold an
     * edit names a file_path and no limit, so the first one claims the whole file
     * and the sixth DISTINCT edit to it scores as a revisit and trips.
     */
    test('many distinct edits to ONE file are not a loop', () => {
        const f = armed()
        for (let i = 0; i < 40; i++) {
            expect(f.emit('tool_call', edit('/src/a.ts', `v${i}`))).toBeUndefined()
        }
    })

    test('interleaved reads between edits do not accumulate', () => {
        const f = armed()
        for (let i = 0; i < 20; i++) {
            f.emit('tool_call', edit('/src/a.ts', `v${i}`))
            for (const p of ['/b.ts', '/c.ts', '/d.ts', '/e.ts']) {
                expect(f.emit('tool_call', {toolName: 'read', input: {path: p}})).toBeUndefined()
            }
            expect(f.emit('tool_call', bash('bun test'))).toBeUndefined()
        }
    })
})

describe('the reset is not a hole', () => {
    // A model retrying an edit whose old text no longer matches repeats it verbatim.
    // Were the reset unconditional, that call would clear the window it belongs in
    // and buy the turn unlimited immunity.
    test('a byte-identical edit repeated is itself a loop', () => {
        const f = armed()
        const same = edit('/src/a.ts', 'x')
        for (let i = 0; i < LOOP_THRESHOLD - 1; i++) {
            expect(f.emit('tool_call', same)).toBeUndefined()
        }
        expect(f.emit('tool_call', same)?.block).toBe(true)
    })

    test('a repeated edit escalates to terminate like any other call', () => {
        const f = armed()
        const same = edit('/src/a.ts', 'x')
        const verdicts = verdictsFor(f, same, LOOP_THRESHOLD + MAX_LOOP_RESTARTS + 2)
        expect(verdicts[MAX_LOOP_RESTARTS]?.terminate).toBe(true)
    })
})

describe('termination', () => {
    /**
     * Blocking alone does not stop a determined model — nothing prevents the next
     * identical call. Without this the guard reports forever and the turn still
     * never ends.
     */
    test('escalates to terminate once the block budget is spent', () => {
        const f = armed()
        const verdicts = verdictsFor(f, bash('bun test'), LOOP_THRESHOLD + MAX_LOOP_RESTARTS + 2)
        expect(verdicts.length).toBeGreaterThan(MAX_LOOP_RESTARTS)
        expect(verdicts.slice(0, MAX_LOOP_RESTARTS).every(v => v.terminate === undefined)).toBe(
            true
        )
        expect(verdicts[MAX_LOOP_RESTARTS]?.terminate).toBe(true)
    })

    /**
     * pi terminates only when EVERY finalized result in the batch carries the flag,
     * so a verdict that exempted innocent calls could never end the turn.
     */
    test('once terminating, an unrelated first-time call is blocked and flagged', () => {
        const f = armed()
        verdictsFor(f, bash('bun test'), LOOP_THRESHOLD + MAX_LOOP_RESTARTS + 2)
        const collateral = f.emit('tool_call', bash('echo never-run-before'))!
        expect(collateral.block).toBe(true)
        expect(collateral.terminate).toBe(true)
    })

    test('two unrelated loops do not pool their strikes into a termination', () => {
        const f = armed()
        // Spend exactly the budget on A without exceeding it.
        const a = verdictsFor(f, bash('loop A'), LOOP_THRESHOLD - 1 + MAX_LOOP_RESTARTS)
        expect(a.length).toBe(MAX_LOOP_RESTARTS)
        expect(a.every(v => v.terminate === undefined)).toBe(true)
        const b = verdictsFor(f, bash('loop B'), LOOP_THRESHOLD)
        expect(b.length).toBe(1)
        expect(b[0]?.terminate).toBeUndefined()
    })
})

describe('the strike budget follows the window', () => {
    /**
     * A mutating call resets the loop window because it proves progress; the strike
     * budget goes with it, or an earlier part-spent episode makes a LATER one
     * terminate on its first hit with no warning at all.
     *
     * MEASURED over 494 real turns (14,113 calls) before changing it: no catch is
     * lost. The recorded incident still terminates at call 173 of 6,760 — it makes
     * ZERO edits, so nothing resets — and both live-model loops still terminate.
     * One termination is dropped, of a turn that was editing between episodes.
     */
    test('a later episode still gets its warnings', () => {
        const f = armed()
        let v: Block | undefined
        // Episode A spends two strikes.
        for (let i = 0; i < LOOP_THRESHOLD + 1; i++) v = f.emit('tool_call', bash('bun test'))
        expect(v?.block).toBe(true)
        expect(v?.terminate).toBeUndefined()
        // Then unambiguous progress.
        for (let k = 0; k < 30; k++) {
            f.emit('tool_call', edit(`/src/f${k}.ts`, `a${k}`))
            f.emit('tool_call', {toolName: 'read', input: {path: `/src/r${k}.ts`}})
        }
        // Episode B warns rather than ending the turn outright.
        for (let i = 0; i < LOOP_THRESHOLD; i++) v = f.emit('tool_call', bash('bun test'))
        expect(v?.block).toBe(true)
        expect(v?.terminate).toBeUndefined()
    })

    test('a turn that never edits is still terminated — the runaway shape', () => {
        const f = armed()
        let v: Block | undefined
        for (let i = 0; i < LOOP_THRESHOLD + MAX_LOOP_RESTARTS + 1; i++) {
            v = f.emit('tool_call', bash('bun test'))
        }
        expect(v?.terminate).toBe(true)
    })
})

describe('what the block says', () => {
    // The hook fires BEFORE the tool runs, so the guard has never seen a result and
    // must not claim one is unchanged. And "change the call" is an escape, not
    // advice: one altered byte is a new key and a clean slate on both counters.
    test('claims nothing about results and offers no one-byte escape', () => {
        const f = armed()
        const verdicts = verdictsFor(f, bash('bun test'), LOOP_THRESHOLD)
        const reason = verdicts[0]!.reason!
        expect(reason).not.toContain('result')
        expect(reason).not.toContain('change the call')
    })
})

describe('lifecycle', () => {
    /**
     * `agent_end` also fires for every auto-retry and every threshold compaction —
     * pi drives those with agent.continue(), each a fresh agent loop. The measured
     * runaway compacted 18 times inside its turn, so disarming there would have
     * retired the guard after the first ~375 of its 6,760 calls.
     */
    test('agent_end is not the boundary — only agent_settled disarms', () => {
        const f = armed()
        expect(f.emit('agent_end')).toBeUndefined()
        expect(implementationGuardArmed()).toBe(true)
    })

    test('a one-shot turn disarms itself once the run settles', () => {
        const f = armed()
        expect(implementationGuardArmed()).toBe(true)
        f.emit('agent_settled')
        expect(implementationGuardArmed()).toBe(false)
    })

    test('an awaited run stays armed across turns but starts each one clean', () => {
        const f = armed(false)
        const cmd = bash('bun test')
        for (let i = 0; i < LOOP_THRESHOLD - 1; i++) f.emit('tool_call', cmd)
        f.emit('agent_settled')
        expect(implementationGuardArmed()).toBe(true)
        // The previous turn's strikes must not carry: this is call 1 of a new turn.
        expect(f.emit('tool_call', cmd)).toBeUndefined()
    })

    test('an awaited run clears a spent termination when it settles', () => {
        const f = armed(false)
        verdictsFor(f, bash('bun test'), LOOP_THRESHOLD + MAX_LOOP_RESTARTS + 2)
        f.emit('agent_settled')
        expect(f.emit('tool_call', bash('anything at all'))).toBeUndefined()
    })

    test('session_shutdown disarms', () => {
        const f = armed()
        f.emit('session_shutdown')
        expect(implementationGuardArmed()).toBe(false)
    })
})

describe('a broken guard costs nothing', () => {
    // pi does not wrap this hook, so a throw would block a legitimate call.
    test('a malformed event is passed through, not blocked', () => {
        const f = armed()
        expect(f.emit('tool_call', {toolName: 'bash'})).toBeUndefined()
        const circular: {self?: unknown} = {}
        circular.self = circular
        expect(f.emit('tool_call', {toolName: 'bash', input: circular})).toBeUndefined()
    })
})
