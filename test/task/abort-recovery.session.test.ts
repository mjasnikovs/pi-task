import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import * as path from 'node:path'
import {
    createAgentSession,
    DefaultResourceLoader,
    ModelRuntime,
    SessionManager,
    SettingsManager,
    type AgentSession,
    type ExtensionAPI
} from '@earendil-works/pi-coding-agent'
import {
    fauxAssistantMessage,
    fauxProvider,
    fauxText,
    fauxToolCall,
    type FauxResponseStep,
    type RegisterFauxProviderOptions
} from '@earendil-works/pi-ai/providers/faux'
import {Type} from 'typebox'
import {getConfig} from '../../src/config/config.js'
import {WATCHDOG_CANCEL_MARKER} from '../../src/shared/command-watchdog.js'
import {
    inRecoveryTurn,
    recoveryTurnPending,
    registerRecoveryTurns
} from '../../src/task/recovery-turn.js'
import {registerCommandWatchdog} from '../../src/task/command-watchdog.js'
import {registerStreamWatchdog} from '../../src/task/stream-watchdog.js'
import {implWidgetArmed, setupImplWidget} from '../../src/task/impl-widget.js'
import {
    consumeGuardTermination,
    implementationGuardArmed,
    registerImplementationGuards
} from '../../src/task/implementation-guards.js'
import {enterImplementationTurn} from '../../src/task/implementation-scope.js'
import {registerTaskDirCustody, taskDirCustodyHeld} from '../../src/task/task-dir-custody.js'
import {
    registerRunAbortTracker,
    superviseImplementation,
    type SteerCtx
} from '../../src/task/implementation-turn.js'
import {tmpDir} from '../test-utils/tmp-dir.js'

/**
 * An abort's recorded stopReason depends on WHERE in pi's loop it lands. Mid-stream
 * it is "aborted". During a tool or a pre-request compaction the next request's
 * setup fails on the aborted signal and pi-ai records "error" ("This operation was
 * aborted"). These run the real pi session with the faux provider, so a pi upgrade
 * that moves either behaviour fails here rather than in a user's run.
 */

/** The command watchdog's ceiling: the hang below never ends on its own. */
const COMMAND_CEILING_MS = 1
/** The stream watchdog's window. The faux provider emits a whole response within one
 *  tick, so live output never goes this quiet; only the stall below does. */
const STREAM_SILENCE_MS = 50

function untilAborted(signal: AbortSignal | undefined): Promise<void> {
    return new Promise(resolve => {
        if (!signal || signal.aborted) return resolve()
        signal.addEventListener('abort', () => resolve(), {once: true})
    })
}

/** Holds the model request open, emitting nothing, until the run is aborted. */
const stalledResponse: FauxResponseStep = async (_ctx, options) => {
    await untilAborted(options?.signal)
    return fauxAssistantMessage('late')
}

const sessions: AgentSession[] = []

interface Harness {
    dir: string
    /** How many times the hanging tool actually ran. */
    executions: () => number
    session: AgentSession
    asks: () => number
    supervise: () => ReturnType<typeof superviseImplementation>
    transcript: () => string[]
}

async function harness(opts: {
    responses: FauxResponseStep[]
    contextWindow?: number
    compaction?: {enabled: boolean; reserveTokens?: number; keepRecentTokens?: number}
    /** Size of the tool's result when it returns without hanging. */
    toolResultChars?: number
    /** Registered first, so its handlers run before pi-task's. */
    before?: (pi: ExtensionAPI) => void
    /** Wire the one-shot `/task` scope: widget, runaway guard, task-dir custody. */
    scope?: boolean
    /** Pace the faux stream instead of emitting each response at once. */
    stream?: Pick<RegisterFauxProviderOptions, 'tokensPerSecond' | 'tokenSize'>
    retry?: {baseDelayMs: number}
}): Promise<Harness> {
    const dir = tmpDir('pi-task-abort-')
    const faux = fauxProvider({
        ...opts.stream,
        models: [{id: 'faux-1', contextWindow: opts.contextWindow ?? 100_000, maxTokens: 1000}]
    })
    faux.setResponses(opts.responses)
    const modelRuntime = await ModelRuntime.create({
        authPath: path.join(dir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false
    })
    modelRuntime.registerNativeProvider(faux.provider)
    const settingsManager = SettingsManager.inMemory({
        compaction: opts.compaction ?? {enabled: false},
        retry: opts.retry ? {enabled: true, maxRetries: 1, ...opts.retry} : {enabled: false}
    })
    let executions = 0
    const extension = (pi: ExtensionAPI): void => {
        registerCommandWatchdog(pi)
        registerStreamWatchdog(pi)
        registerRunAbortTracker(pi)
        registerRecoveryTurns(pi)
        if (opts.scope) {
            setupImplWidget(pi)
            registerImplementationGuards(pi)
            registerTaskDirCustody(pi)
        }
        pi.registerTool({
            name: 'probe',
            label: 'probe',
            description: 'A command that returns at once.',
            parameters: Type.Object({}),
            execute: () => Promise.resolve({content: [{type: 'text', text: 'ok'}], details: {}})
        })
        pi.registerTool({
            name: 'hang',
            label: 'hang',
            description: 'A command that never returns on its own.',
            parameters: Type.Object({}),
            async execute(_id, _params, signal) {
                executions++
                if (opts.toolResultChars === undefined) {
                    await untilAborted(signal)
                    throw new Error('Command aborted')
                }
                return {
                    content: [{type: 'text', text: 'x'.repeat(opts.toolResultChars)}],
                    details: {}
                }
            }
        })
    }
    const resourceLoader = new DefaultResourceLoader({
        cwd: dir,
        agentDir: dir,
        settingsManager,
        extensionFactories: opts.before ? [opts.before, extension] : [extension]
    })
    await resourceLoader.reload()
    const {session} = await createAgentSession({
        cwd: dir,
        agentDir: dir,
        model: faux.getModel(),
        thinkingLevel: 'off',
        modelRuntime,
        resourceLoader,
        sessionManager: SessionManager.inMemory(dir),
        settingsManager
    })
    sessions.push(session)
    await session.bindExtensions({mode: 'json'})
    session.setActiveToolsByName(['hang', 'probe'])
    let asks = 0
    return {
        dir,
        executions: () => executions,
        session,
        asks: () => asks,
        supervise: () =>
            superviseImplementation(session as unknown as SteerCtx, {
                promptSteer: () => {
                    asks++
                    return Promise.resolve(undefined)
                }
            }),
        transcript: () =>
            session.sessionManager.getEntries().flatMap(entry => {
                if (entry.type !== 'message') return []
                const m = entry.message
                if (m.role === 'system') return []
                if (m.role === 'assistant') return [`assistant:${m.stopReason}`]
                if (m.role === 'user') {
                    const text = JSON.stringify(m.content)
                    return [text.includes(WATCHDOG_CANCEL_MARKER) ? 'user:reminder' : 'user']
                }
                return [m.role]
            })
    }
}

/** Resolves when the `nth` tool call of the session starts. */
function toolStart(session: AgentSession, nth = 1): Promise<void> {
    let seen = 0
    return new Promise(resolve => {
        const off = session.subscribe(event => {
            if (event.type === 'tool_execution_start' && ++seen === nth) {
                off()
                resolve()
            }
        })
    })
}

describe('an abort is recovered wherever in the loop it lands', () => {
    let savedRequest: number
    let savedStream: number
    const savedOffline = process.env.PI_OFFLINE

    beforeEach(() => {
        savedRequest = getConfig().requestTimeoutMs
        savedStream = getConfig().streamInactivityMs
        getConfig().requestTimeoutMs = 0
        getConfig().streamInactivityMs = 0
        process.env.PI_OFFLINE = '1'
    })
    afterEach(() => {
        for (const session of sessions.splice(0)) session.dispose()
        consumeGuardTermination()
        getConfig().requestTimeoutMs = savedRequest
        getConfig().streamInactivityMs = savedStream
        if (savedOffline === undefined) delete process.env.PI_OFFLINE
        else process.env.PI_OFFLINE = savedOffline
    })

    test('command watchdog killing a hung tool: the reminder turn runs and the task continues', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        const h = await harness({
            responses: [
                fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'}),
                fauxAssistantMessage('re-ran it with a timeout')
            ]
        })
        await h.session.prompt('implement')
        await h.session.waitForIdle()
        const outcome = await h.supervise()

        expect(outcome).toEqual({interrupted: false, error: undefined, resumes: 0})
        expect(h.asks()).toBe(0)
        expect(h.transcript()).toEqual([
            'user',
            'assistant:toolUse',
            'toolResult',
            'assistant:error',
            'user:reminder',
            'assistant:stop'
        ])
        expect(recoveryTurnPending()).toBe(false)
    })

    test('a human ESC while a tool runs asks to steer instead of failing the task', async () => {
        const h = await harness({
            responses: [fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'})]
        })
        const toolStarted = new Promise<void>(resolve => {
            const off = h.session.subscribe(event => {
                if (event.type === 'tool_execution_start') {
                    off()
                    resolve()
                }
            })
        })
        const run = h.session.prompt('implement')
        await toolStarted
        await h.session.abort()
        await run
        const outcome = await h.supervise()

        expect(outcome).toEqual({interrupted: true, error: undefined, resumes: 0})
        expect(h.asks()).toBe(1)
    })

    test('stream watchdog on a silent model: the reminder turn runs without asking a human', async () => {
        getConfig().streamInactivityMs = STREAM_SILENCE_MS
        const h = await harness({responses: [stalledResponse, fauxAssistantMessage('continued')]})
        await h.session.prompt('implement')
        await h.session.waitForIdle()
        const outcome = await h.supervise()

        expect(outcome).toEqual({interrupted: false, error: undefined, resumes: 0})
        expect(h.asks()).toBe(0)
        expect(h.transcript()).toEqual([
            'user',
            'assistant:aborted',
            'user:reminder',
            'assistant:stop'
        ])
        expect(recoveryTurnPending()).toBe(false)
    })

    test('stream watchdog during a pre-request compaction: recovered, not failed', async () => {
        getConfig().streamInactivityMs = STREAM_SILENCE_MS
        const h = await harness({
            contextWindow: 20_000,
            compaction: {enabled: true, reserveTokens: 19_000, keepRecentTokens: 50},
            toolResultChars: 8000,
            responses: [
                fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'}),
                stalledResponse, // the compaction's summary request
                // The reminder turn may compact again first; either way these answer it.
                fauxAssistantMessage('summary'),
                fauxAssistantMessage('continued'),
                fauxAssistantMessage('continued')
            ]
        })
        await h.session.prompt('implement ' + 'y'.repeat(4000))
        await h.session.waitForIdle()
        const outcome = await h.supervise()

        expect(outcome.error).toBeUndefined()
        expect(outcome.interrupted).toBe(false)
        expect(h.asks()).toBe(0)
        expect(h.transcript()).toContain('user:reminder')
        expect(recoveryTurnPending()).toBe(false)
    })

    test('a one-shot /task keeps its guard and task-dir custody through the recovery turn', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        let duringRecovery: Record<string, boolean> | undefined
        const h = await harness({
            scope: true,
            responses: [
                fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'}),
                () => {
                    duringRecovery = {
                        guard: implementationGuardArmed(),
                        custody: taskDirCustodyHeld(),
                        widget: implWidgetArmed()
                    }
                    return fauxAssistantMessage('re-ran it with a timeout')
                }
            ]
        })
        await enterImplementationTurn(
            {taskId: 'TASK_0001', title: 't'},
            {oneShot: true, cwd: h.dir}
        )
        await h.session.prompt('implement')
        await h.session.waitForIdle()

        expect(duringRecovery).toEqual({guard: true, custody: true, widget: true})
        expect([implementationGuardArmed(), taskDirCustodyHeld(), implWidgetArmed()]).toEqual([
            false,
            false,
            false
        ])
    })

    test('an ESC during the recovery turn asks at once, with no watchdog wait left over', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        const h = await harness({
            responses: [
                fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'}),
                () => {
                    getConfig().requestTimeoutMs = 0 // this hang is the human's to end
                    return fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'})
                }
            ]
        })
        const secondTool = toolStart(h.session, 2)
        const run = h.session.prompt('implement')
        await secondTool
        await h.session.abort()
        await run
        await h.session.waitForIdle()
        expect(await h.supervise()).toEqual({interrupted: true, error: undefined, resumes: 0})
        expect(h.asks()).toBe(1)
    })

    test('an ESC during a tool is still an abort when another extension rewrote the message', async () => {
        const h = await harness({
            before: pi => {
                pi.on('message_end', event =>
                    event.message.role === 'assistant' ? {message: {...event.message}} : undefined
                )
            },
            responses: [fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'})]
        })
        const started = toolStart(h.session)
        const run = h.session.prompt('implement')
        await started
        await h.session.abort()
        await run

        expect(await h.supervise()).toEqual({interrupted: true, error: undefined, resumes: 0})
    })

    test('a model that re-runs the killed command gets one recovery turn, then a human', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        const sameHangingCall = Array.from({length: 5}, () =>
            fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'})
        )
        const h = await harness({responses: sameHangingCall})
        await h.session.prompt('implement')
        await h.session.waitForIdle()

        expect(await h.supervise()).toEqual({interrupted: true, error: undefined, resumes: 0})
        expect(h.executions()).toBe(2)
        expect(h.transcript().filter(t => t === 'user:reminder')).toHaveLength(1)
    })

    test('the runaway guard keeps its counts across recovery turns that each make progress', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        const probeThenHang = Array.from({length: 40}, (_, i) =>
            fauxAssistantMessage([fauxToolCall(i % 2 === 0 ? 'probe' : 'hang', {})], {
                stopReason: 'toolUse'
            })
        )
        const h = await harness({scope: true, responses: probeThenHang})
        const leave = await enterImplementationTurn(
            {taskId: 'TASK_0001', title: 't'},
            {oneShot: false, cwd: h.dir}
        )
        try {
            await h.session.prompt('implement')
            await h.session.waitForIdle()
            await h.supervise()

            expect(h.executions()).toBeLessThan(probeThenHang.length / 2)
        } finally {
            await leave()
        }
    })

    test('a turn the runaway guard ended gets no recovery turn', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        const probe = (): FauxResponseStep =>
            fauxAssistantMessage([fauxToolCall('probe', {})], {stopReason: 'toolUse'})
        // The last probe is the one past every warning. The hang in its batch
        // was prepared first, so it runs, and the command watchdog kills it.
        const h = await harness({
            scope: true,
            responses: [
                ...Array.from({length: 6}, probe),
                fauxAssistantMessage([fauxToolCall('hang', {}), fauxToolCall('probe', {})], {
                    stopReason: 'toolUse'
                }),
                probe(),
                fauxAssistantMessage('done')
            ]
        })
        const leave = await enterImplementationTurn(
            {taskId: 'TASK_0001', title: 't'},
            {oneShot: false, cwd: h.dir}
        )
        try {
            await h.session.prompt('implement')
            await h.session.waitForIdle()

            expect(h.executions()).toBe(1)
            expect(h.transcript()).not.toContain('user:reminder')
        } finally {
            await leave()
        }
    })

    test('a recovery turn that never starts holds nothing into the next prompt', async () => {
        getConfig().requestTimeoutMs = COMMAND_CEILING_MS
        let duringNext: Record<string, boolean> | undefined
        const h = await harness({
            scope: true,
            before: pi => {
                pi.on('input', event =>
                    event.text.includes(WATCHDOG_CANCEL_MARKER) ? {action: 'handled'} : undefined
                )
            },
            responses: [
                fauxAssistantMessage([fauxToolCall('hang', {})], {stopReason: 'toolUse'}),
                () => {
                    duringNext = {
                        guard: implementationGuardArmed(),
                        custody: taskDirCustodyHeld(),
                        widget: implWidgetArmed(),
                        recovering: inRecoveryTurn()
                    }
                    return fauxAssistantMessage('answered')
                }
            ]
        })
        await enterImplementationTurn(
            {taskId: 'TASK_0001', title: 't'},
            {oneShot: true, cwd: h.dir}
        )
        await h.session.prompt('implement')
        await h.session.waitForIdle()
        await h.session.prompt('an unrelated question')

        expect(duringNext).toEqual({guard: false, custody: false, widget: false, recovering: false})
        expect(recoveryTurnPending()).toBe(false)
    })

    test('a human ESC during a retry backoff asks to steer instead of failing the task', async () => {
        const h = await harness({
            // Longer than the test may run: only the ESC ends this backoff.
            retry: {baseDelayMs: 60_000},
            responses: [
                fauxAssistantMessage('', {
                    stopReason: 'error',
                    errorMessage: '503 service unavailable'
                })
            ]
        })
        const backoff = new Promise<void>(resolve => {
            const off = h.session.subscribe(event => {
                if (event.type === 'auto_retry_start') {
                    off()
                    resolve()
                }
            })
        })
        const run = h.session.prompt('implement')
        await backoff
        await h.session.abort()
        await run

        expect(await h.supervise()).toEqual({interrupted: true, error: undefined, resumes: 0})
    })

    test('a model server that says one word and stalls gets one recovery turn, then a human', async () => {
        getConfig().streamInactivityMs = STREAM_SILENCE_MS
        // At 1000 tokens a second a token takes 1 ms. The one-word delta lands at
        // once, the next chunk five silence windows later.
        const chunkTokens = STREAM_SILENCE_MS * 5
        const oneWordThenSilence = Array.from({length: 5}, () =>
            fauxAssistantMessage([fauxText('a'), fauxText('x'.repeat(chunkTokens * 4))])
        )
        const h = await harness({
            stream: {tokensPerSecond: 1000, tokenSize: {min: chunkTokens, max: chunkTokens}},
            responses: oneWordThenSilence
        })
        await h.session.prompt('implement')
        await h.session.waitForIdle()

        expect(await h.supervise()).toEqual({interrupted: true, error: undefined, resumes: 0})
        expect(h.transcript().filter(t => t === 'user:reminder')).toHaveLength(1)
    })

    test('a model server that stays silent gets one recovery turn, then a human', async () => {
        getConfig().streamInactivityMs = STREAM_SILENCE_MS
        const alwaysSilent = Array.from({length: 30}, () => stalledResponse)
        const h = await harness({responses: alwaysSilent})
        await h.session.prompt('implement')
        await h.session.waitForIdle()
        const outcome = await h.supervise()

        expect(outcome).toEqual({interrupted: true, error: undefined, resumes: 0})
        expect(h.asks()).toBe(1)
        expect(h.transcript().filter(t => t === 'user:reminder')).toHaveLength(1)
    })
})
