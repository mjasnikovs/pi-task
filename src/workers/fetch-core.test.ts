import {describe, expect, test} from 'bun:test'
import {fetchRaw, fetchFocused} from './fetch-core.js'
import {FetchAndCleanError} from './html-clean.js'
import {fakeSpawnByPrompt} from '../test-utils/fake-spawn.js'

describe('fetchRaw', () => {
    test('returns markdown/finalUrl/title from injected fetchAndClean', async () => {
        const r = await fetchRaw({
            url: 'https://example.com/',
            fetchAndClean: async () => ({
                markdown: '# Hi\n\nbody',
                finalUrl: 'https://example.com/',
                title: 'Hi'
            })
        })
        expect(r.markdown).toContain('body')
        expect(r.title).toBe('Hi')
        expect(r.finalUrl).toBe('https://example.com/')
    })

    test('propagates FetchAndCleanError', async () => {
        await expect(
            fetchRaw({
                url: 'https://example.com/',
                fetchAndClean: async () => {
                    throw new FetchAndCleanError('too big', 'too-large')
                }
            })
        ).rejects.toBeInstanceOf(FetchAndCleanError)
    })
})

describe('fetchFocused', () => {
    test('returns parsed answer + excerpt on success', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: '# title\n\nThe key fact.',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>The key fact.</answer>\n<excerpt>The key fact.</excerpt>'
            }))
        })
        expect(r.answer).toBe('The key fact.')
        expect(r.excerpt).toBe('The key fact.')
        expect(r.excerptVerified).toBe(true)
    })

    test('flags excerptVerified false when excerpt is fabricated', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'unrelated',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({
                stdout: '<answer>x</answer>\n<excerpt>fabricated</excerpt>'
            }))
        })
        expect(r.excerptVerified).toBe(false)
    })

    test('surfaces non-zero exitCode when child fails', async () => {
        const r = await fetchFocused({
            url: 'https://example.com/',
            query: 'q',
            cwd: '/tmp',
            fetchAndClean: async () => ({
                markdown: 'x',
                finalUrl: 'https://example.com/',
                title: 't'
            }),
            spawn: fakeSpawnByPrompt(() => ({stdout: '', exitCode: 1, stderr: 'oops'}))
        })
        expect(r.childExitCode).toBe(1)
        expect(r.answer).toBe('')
    })
})
