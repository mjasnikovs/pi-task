import {describe, expect, test} from 'bun:test'
import {compressTitle, sanitizeLabel} from '../../src/task/title-label.js'
import {LABEL_MAX, truncateLabel} from '../../src/task/parsers.js'
import type {PhaseDeps} from '../../src/task/child-runner.js'
import type {SpawnFn} from '../../src/shared/child-process.js'
import {agentEndResponse, agentErrorResponse, fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

// A title comfortably past LABEL_MAX, so compressTitle takes the model path.
const LONG_TITLE =
    'Create the database schema and bun:sql setup for ROADSTER — an invite-only '
    + 'used parts marketplace for Mazda MX-5 enthusiasts in Latvia, with five tables '
    + 'and trigram indexes | spec: @DESIGN/mx5-marketplace-design.md'

function deps(spawn: SpawnFn): PhaseDeps {
    return {cwd: '/tmp', taskId: 'TASK_0001', signal: new AbortController().signal, spawn}
}

describe('sanitizeLabel', () => {
    test('takes the first non-empty line', () => {
        expect(sanitizeLabel('\n\nDB schema setup\nextra commentary')).toBe('DB schema setup')
    })

    test('strips surrounding quotes and backticks', () => {
        expect(sanitizeLabel('"DB schema setup"')).toBe('DB schema setup')
        expect(sanitizeLabel('`DB schema setup`')).toBe('DB schema setup')
    })

    test('strips a leading "label:" echo and collapses whitespace', () => {
        expect(sanitizeLabel('Label:  DB   schema  setup')).toBe('DB schema setup')
    })

    test('returns empty string for blank input', () => {
        expect(sanitizeLabel('   \n  ')).toBe('')
    })
})

describe('compressTitle', () => {
    test('returns the sanitised model label for a long title', async () => {
        const spawn = fakeSpawnByPrompt(() =>
            agentEndResponse('"DB schema + bun:sql query modules"')
        )
        const label = await compressTitle(deps(spawn), LONG_TITLE)
        expect(label).toBe('DB schema + bun:sql query modules')
    })

    test('skips the model call for an already-short title', async () => {
        let called = false
        const spawn = fakeSpawnByPrompt(() => {
            called = true
            return agentEndResponse('should not be used')
        }) as SpawnFn
        const short = 'Fix the login bug'
        const label = await compressTitle(deps(spawn), short)
        expect(called).toBe(false)
        expect(label).toBe(short)
    })

    test('falls back to a truncation when the model errors', async () => {
        const spawn = fakeSpawnByPrompt(() => agentErrorResponse('local model disconnected'))
        const label = await compressTitle(deps(spawn), LONG_TITLE)
        expect(label).toBe(truncateLabel(LONG_TITLE))
    })

    test('falls back to a truncation when the model returns nothing', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse(''))
        const label = await compressTitle(deps(spawn), LONG_TITLE)
        expect(label).toBe(truncateLabel(LONG_TITLE))
    })

    test('clamps an over-long model answer to LABEL_MAX', async () => {
        const spawn = fakeSpawnByPrompt(() => agentEndResponse('word '.repeat(40)))
        const label = await compressTitle(deps(spawn), LONG_TITLE)
        expect(label.length).toBeLessThanOrEqual(LABEL_MAX)
    })
})
