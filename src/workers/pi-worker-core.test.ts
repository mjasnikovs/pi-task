import {describe, expect, test} from 'bun:test'
import {runWorker} from './pi-worker-core.js'
import {agentEndResponse, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

describe('runWorker', () => {
    test('returns text, exitCode, stderr', async () => {
        // Pure shape test — does not actually spawn pi.
        // Cancel immediately via aborted signal so this exits fast.
        const ctrl = new AbortController()
        ctrl.abort()
        const result = await runWorker({
            prompt: 'unused',
            cwd: process.cwd(),
            signal: ctrl.signal
        })
        expect(typeof result.text).toBe('string')
        expect(typeof result.exitCode).toBe('number')
        expect(typeof result.stderr).toBe('string')
        expect(typeof result.aborted).toBe('boolean')
    })

    test('invokes pi with CHILD_BASE_ARGS + --mode json + --tools read,grep,find,ls and prompt last', async () => {
        let receivedArgs: ReadonlyArray<string> = []
        const spawn = fakeSpawnByPrompt(args => {
            receivedArgs = args
            return agentEndResponse('ok')
        })
        const r = await runWorker({prompt: 'hello', cwd: process.cwd(), spawn})
        expect(r.text).toBe('ok')
        expect(receivedArgs).toContain('--print')
        expect(receivedArgs).toContain('--no-skills')
        expect(receivedArgs).toContain('--mode')
        expect(receivedArgs[receivedArgs.indexOf('--mode') + 1]).toBe('json')
        expect(receivedArgs).toContain('--tools')
        expect(receivedArgs[receivedArgs.indexOf('--tools') + 1]).toBe('read,grep,find,ls')
        expect(receivedArgs[receivedArgs.length - 1]).toBe('hello')
    })

    test('trims surrounding whitespace from the extracted assistant text', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('   spaced   '))
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.text).toBe('spaced')
    })

    test('returns non-negative waitMs and workMs that sum to total elapsed', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('ok'))
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.waitMs).toBeGreaterThanOrEqual(0)
        expect(r.workMs).toBeGreaterThanOrEqual(0)
    })

    test('workMs is zero when the child never produces stdout', async () => {
        // A child that exits without emitting stdout — onFirstByte never fires,
        // so all elapsed time is bucketed as wait, not work. This is the shape
        // we want when surfacing queue-vs-generation splits later.
        const spawn = fakeSpawnByPrompt(() => ({stdout: '', stderr: 'silent', exitCode: 1}))
        const r = await runWorker({prompt: 'x', cwd: process.cwd(), spawn})
        expect(r.workMs).toBe(0)
        expect(r.waitMs).toBeGreaterThanOrEqual(0)
    })

    test('input.tools overrides the default tool set', async () => {
        let receivedArgs: ReadonlyArray<string> = []
        const spawn = fakeSpawnByPrompt(args => {
            receivedArgs = args
            return agentEndResponse('ok')
        })
        await runWorker({
            prompt: 'hello',
            cwd: process.cwd(),
            spawn,
            tools: 'read,grep'
        })
        expect(receivedArgs[receivedArgs.indexOf('--tools') + 1]).toBe('read,grep')
    })
})
