/**
 * ChildStatus — the live line + context gauge a running child feeds and a
 * loader reads, plus the loader ritual around one child.
 *
 * Three sites construct one and no others do: auto-orchestrator.ts:1491,
 * gate-deps.ts:694 and plan-orchestrator.ts:101. Because the state has ONE
 * owner, the window-fallback order and the reset semantics can be asserted
 * directly here — held as a widget field or a closure `let` at each site
 * instead, they would only be reachable by driving that whole site.
 */

import {test, expect, describe, mock} from 'bun:test'
import type {ExtensionCommandContext} from '@earendil-works/pi-coding-agent'
import type {AutoLoaderState} from '../../src/task/widget.js'
import * as realChildRunner from '../../src/task/child-runner.js'
import type {PhaseDeps} from '../../src/task/child-runner.js'

const childCalls: Array<{deps: PhaseDeps; name: string; tools: string; prompt: string}> = []
const childReply = 'REPLY'
let childThrows: Error | null = null
/** What the fake child does while "running" — how the stream callbacks are driven. */
let childBody: (deps: PhaseDeps) => void = () => {}

void mock.module('../../src/task/child-runner.js', () => ({
    ...realChildRunner,
    runPhaseChild: async (deps: PhaseDeps, name: string, tools: string, prompt: string) => {
        childCalls.push({deps, name, tools, prompt})
        childBody(deps)
        if (childThrows) throw childThrows
        return childReply
    }
}))

const {ChildStatus, runPlanningChild, statusCallbacks} =
    (await import('../../src/task/child-status.js')) as typeof import('../../src/task/child-status.js')

const ctx = {} as ExtensionCommandContext

/** A status whose loader is a fake that records start/stop and exposes the frame getter. */
function harness(parentContextWindow = 200_000) {
    const events: string[] = []
    let getState: (() => AutoLoaderState | null) | null = null
    const status = new ChildStatus({
        parentContextWindow,
        startLoader: (_ctx, g) => {
            events.push('start')
            getState = g
            return () => events.push('stop')
        }
    })
    return {
        status,
        events,
        frame: () => (getState ? getState() : null)
    }
}

describe('the live fields', () => {
    test('onLine is the latest line; reset forgets it', () => {
        const {status} = harness()
        status.onLine('reading a.ts')
        status.onLine('reading b.ts')
        expect(status.snapshot().lastLine).toBe('reading b.ts')
        status.reset()
        expect(status.snapshot()).toEqual({lastLine: undefined, contextUsage: undefined})
    })

    test('onContextUsage prefers the child window, then the last known, then the parent', () => {
        const {status} = harness(200_000)
        status.onContextUsage({tokens: 2_000, contextWindow: 0, percent: 0})
        expect(status.snapshot().contextUsage).toEqual({
            tokens: 2_000,
            contextWindow: 200_000,
            percent: 1
        })
        status.onContextUsage({tokens: 5_000, contextWindow: 10_000, percent: 0})
        expect(status.snapshot().contextUsage).toEqual({
            tokens: 5_000,
            contextWindow: 10_000,
            percent: 50
        })
        // Window omitted again: the last known 10k wins over the parent's 200k.
        status.onContextUsage({tokens: 8_000, contextWindow: 0, percent: 0})
        expect(status.snapshot().contextUsage).toEqual({
            tokens: 8_000,
            contextWindow: 10_000,
            percent: 80
        })
    })

    test('reset also forgets the window, so the next child falls back to the parent', () => {
        const {status} = harness(200_000)
        status.onContextUsage({tokens: 5_000, contextWindow: 10_000, percent: 0})
        status.reset()
        status.onContextUsage({tokens: 2_000, contextWindow: 0, percent: 0})
        expect(status.snapshot().contextUsage?.contextWindow).toBe(200_000)
    })

    test('statusCallbacks binds both PhaseDeps callbacks to the status', () => {
        const {status} = harness()
        const cbs = statusCallbacks(status)
        cbs.onChildOutput?.('a line')
        cbs.onContextUsage?.({tokens: 1_000, contextWindow: 4_000, percent: 0})
        expect(status.snapshot()).toEqual({
            lastLine: 'a line',
            contextUsage: {tokens: 1_000, contextWindow: 4_000, percent: 25}
        })
    })
})

describe('track', () => {
    test('resets, raises the loader, runs, stops — and returns the result', async () => {
        const {status, events, frame} = harness()
        status.onLine('stale')
        const out = await status.track(
            ctx,
            () => ({title: 't', step: 's', stepNum: 1, stepTotal: 1, startedAt: 0}),
            async () => {
                expect(events).toEqual(['start'])
                expect(frame()?.lastLine).toBeUndefined()
                status.onLine('live')
                expect(frame()?.lastLine).toBe('live')
                return 42
            }
        )
        expect(out).toBe(42)
        expect(events).toEqual(['start', 'stop'])
    })

    test('a throwing run still stops the loader', async () => {
        const {status, events} = harness()
        await expect(
            status.track(
                ctx,
                () => ({title: 't', step: 's', stepNum: 1, stepTotal: 1, startedAt: 0}),
                () => Promise.reject(new Error('boom'))
            )
        ).rejects.toThrow('boom')
        expect(events).toEqual(['start', 'stop'])
    })

    test('every tick merges the frame over the live status; the frame wins a clash', async () => {
        const {status, frame} = harness()
        let stage: string | undefined = 'repo health'
        await status.track(
            ctx,
            () => ({
                title: 't',
                kind: 'verify',
                step: 'verify',
                stepNum: 1,
                stepTotal: 1,
                startedAt: 0,
                lastLine: status.snapshot().lastLine ?? stage
            }),
            async () => {
                expect(frame()?.lastLine).toBe('repo health')
                stage = 'probes'
                expect(frame()?.lastLine).toBe('probes')
                status.onLine('child line')
                expect(frame()?.lastLine).toBe('child line')
                status.onContextUsage({tokens: 1_000, contextWindow: 4_000, percent: 0})
                expect(frame()?.contextUsage?.percent).toBe(25)
            }
        )
        expect(frame()?.kind).toBe('verify')
    })

    test('a null frame renders no loader but still resets', async () => {
        const {status, events} = harness()
        status.onLine('stale')
        await status.track(ctx, null, async () => {
            expect(status.snapshot().lastLine).toBeUndefined()
        })
        expect(events).toEqual([])
    })
})

describe('runPlanningChild', () => {
    const phaseDeps = (status: InstanceType<typeof ChildStatus>): PhaseDeps => ({
        cwd: '/repo',
        taskId: '',
        signal: new AbortController().signal,
        ...statusCallbacks(status)
    })

    test('runs the phase child with the given name, tools and prompt under the loader', async () => {
        childCalls.length = 0
        const {status, events, frame} = harness()
        const out = await runPlanningChild({
            ctx,
            status,
            phaseDeps: phaseDeps(status),
            name: 'auto-clarify',
            tools: 'read,grep',
            prompt: 'clarify this',
            loader: {title: 'Feature', step: () => ({step: 'clarify', stepNum: 1, stepTotal: 2})}
        })
        expect(out).toBe('REPLY')
        expect(childCalls).toHaveLength(1)
        expect(childCalls[0]).toMatchObject({
            name: 'auto-clarify',
            tools: 'read,grep',
            prompt: 'clarify this'
        })
        expect(events).toEqual(['start', 'stop'])
        expect(frame()).toMatchObject({title: 'Feature', step: 'clarify', stepNum: 1, stepTotal: 2})
        // No command given → none in the frame, so the loader's default head shows.
        expect(frame()).not.toHaveProperty('command')
    })

    test('the child stream feeds the frame; the step is re-read on every tick', async () => {
        const {status, frame} = harness()
        let label = 'question'
        childBody = deps => {
            deps.onChildOutput?.('thinking')
            deps.onContextUsage?.({tokens: 2_000, contextWindow: 0, percent: 0})
            expect(frame()).toMatchObject({
                command: '/task-plan',
                step: 'question',
                lastLine: 'thinking'
            })
            expect(frame()?.contextUsage).toEqual({
                tokens: 2_000,
                contextWindow: 200_000,
                percent: 1
            })
            label = 'answering you'
            expect(frame()?.step).toBe('answering you')
        }
        try {
            await runPlanningChild({
                ctx,
                status,
                phaseDeps: phaseDeps(status),
                name: 'plan-question',
                tools: 'read',
                prompt: 'q',
                loader: {
                    command: '/task-plan',
                    title: 'Plan',
                    step: () => ({step: label, stepNum: 1, stepTotal: 1})
                }
            })
        } finally {
            childBody = () => {}
        }
    })

    test('a failing child still tears the loader down and rethrows', async () => {
        const {status, events} = harness()
        childThrows = new Error('socket hang up')
        try {
            await expect(
                runPlanningChild({
                    ctx,
                    status,
                    phaseDeps: phaseDeps(status),
                    name: 'x',
                    tools: 'read',
                    prompt: 'p',
                    loader: {title: 't', step: () => ({step: 'x', stepNum: 1, stepTotal: 1})}
                })
            ).rejects.toThrow('socket hang up')
        } finally {
            childThrows = null
        }
        expect(events).toEqual(['start', 'stop'])
    })
})
