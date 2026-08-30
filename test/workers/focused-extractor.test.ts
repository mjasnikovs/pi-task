import {describe, expect, test} from 'bun:test'
import {focusedChildArgs, runFocusedExtraction} from '../../src/workers/focused-extractor.js'
import {fakeSpawnByPrompt, fakeSpawnSimple, makeProc} from '../test-utils/fake-spawn.js'
import type {ProcLike, SpawnFn} from '../../src/shared/child-process.js'

const CWD = process.cwd()

/** The child's whole reply, in the tag dialect every focused prompt asks for. */
function reply(answer: string, excerpt?: string): string {
    return (
        `<answer>${answer}</answer>`
        + (excerpt === undefined ? '' : `\n<excerpt>${excerpt}</excerpt>`)
    )
}

describe('runFocusedExtraction — the answer path', () => {
    test('parses <answer>/<excerpt> and verifies the citation against verifyAgainst', async () => {
        const r = await runFocusedExtraction({
            prompt: 'ignored by the fake',
            verifyAgainst: 'the greet() helper returns "hi"',
            cwd: CWD,
            spawn: fakeSpawnSimple(reply('greet returns hi', 'greet() helper')),
            abortedMessage: 'nope'
        })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.answer).toBe('greet returns hi')
        expect(r.excerpt).toBe('greet() helper')
        expect(r.excerptVerified).toBe(true)
        expect(r.exitCode).toBe(0)
        expect(r.aborted).toBe(false)
    })

    test('an untagged reply becomes the whole answer, with no citation', async () => {
        const r = await runFocusedExtraction({
            prompt: 'p',
            verifyAgainst: 'content',
            cwd: CWD,
            spawn: fakeSpawnSimple('  bare prose, no tags  '),
            abortedMessage: 'nope'
        })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.answer).toBe('bare prose, no tags')
        expect(r.excerpt).toBeUndefined()
        // No citation ⇒ nothing was checked. `false` would be a fabrication verdict on a
        // child that never claimed anything.
        expect(r.excerptVerified).toBeUndefined()
        expect(r.excerptCheck).toBeUndefined()
    })

    test('returns the RICH verification struct, not just a verdict', async () => {
        const r = await runFocusedExtraction({
            prompt: 'p',
            verifyAgainst: 'nothing like it here',
            cwd: CWD,
            spawn: fakeSpawnSimple(reply('a', 'invented   quote')),
            abortedMessage: 'nope'
        })
        expect(r.ok).toBe(true)
        if (!r.ok) return
        expect(r.excerptVerified).toBe(false)
        // The evidence that makes a false verdict diagnosable without re-running the
        // lookup: what was searched for, and a fingerprint of where. typeonly-log.ts
        // carries the same `excerptCheck` through to its record.
        expect(r.excerptCheck?.normalisedExcerpt).toBe('invented quote')
        expect(r.excerptCheck?.contentSha256).toMatch(/^[0-9a-f]{64}$/)
        expect(r.excerptCheck?.contentLength).toBe('nothing like it here'.length)
        expect(r.excerptCheck?.verified).toBe(r.excerptVerified)
    })
})

describe('runFocusedExtraction — verifyAgainst is a named knob, not the prompt', () => {
    // Why verifyAgainst is a parameter and not the prompt: fetch prompts with an
    // anchored #fragment slice but verifies against the FULL page, while both docs
    // paths verify against exactly what they prompted with.
    test('an excerpt absent from the prompt but present in the verify target VERIFIES', async () => {
        const r = await runFocusedExtraction({
            prompt: 'PROMPT CONTENT: only the anchored section',
            verifyAgainst: 'the whole page, including a paragraph further down',
            cwd: CWD,
            spawn: fakeSpawnSimple(reply('a', 'a paragraph further down')),
            abortedMessage: 'nope'
        })
        expect(r.ok && r.excerptVerified).toBe(true)
    })

    test('an excerpt present in the prompt but absent from the verify target FAILS', async () => {
        const r = await runFocusedExtraction({
            prompt: 'PROMPT CONTENT: the rules and the question mention widgets',
            verifyAgainst: 'the page says nothing of the sort',
            cwd: CWD,
            spawn: fakeSpawnSimple(reply('a', 'the rules and the question')),
            abortedMessage: 'nope'
        })
        expect(r.ok && r.excerptVerified).toBe(false)
    })
})

describe('runFocusedExtraction — child failure is handled in ONE place', () => {
    test('a non-zero exit is a failure whose stdout is NEVER read as an answer', async () => {
        // A caller that ran parseChildOutput(stdout) regardless of exit code would
        // hand this error dump up as the package's documentation. The failure shape
        // below has no `answer` at all, so that is unrepresentable.
        const r = await runFocusedExtraction({
            prompt: 'p',
            verifyAgainst: 'c',
            cwd: CWD,
            spawn: fakeSpawnSimple('model unreachable, giving up', 2, 'connect ECONNREFUSED'),
            abortedMessage: 'Docs lookup aborted.'
        })
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.failure).toContain('Worker exited 2')
        expect(r.failure).toContain('connect ECONNREFUSED')
        expect(r.exitCode).toBe(2)
        expect(r.aborted).toBe(false)
        // The raw evidence is still available for diagnosis — it is just not an answer.
        expect(r.stdout).toContain('model unreachable')
        expect('answer' in r).toBe(false)
    })

    test('a non-zero exit with empty stderr still names the exit code', async () => {
        const r = await runFocusedExtraction({
            prompt: 'p',
            verifyAgainst: 'c',
            cwd: CWD,
            spawn: fakeSpawnSimple('', 1),
            abortedMessage: 'nope'
        })
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.failure).toBe('Worker exited 1.\n(no stderr)')
    })

    test('an aborted child reports the caller-supplied abort message', async () => {
        const r = await runFocusedExtraction({
            prompt: 'p',
            verifyAgainst: 'c',
            cwd: CWD,
            spawn: fakeSpawnSimple(reply('an answer that must not be used', 'c')),
            signal: AbortSignal.abort(),
            abortedMessage: 'Project docs lookup aborted.'
        })
        expect(r.ok).toBe(false)
        if (r.ok) return
        expect(r.failure).toBe('Project docs lookup aborted.')
        expect(r.aborted).toBe(true)
    })
})

describe('runFocusedExtraction — the invariant part of the four copies', () => {
    test('runs the child with --no-tools and delivers the prompt on stdin', async () => {
        let seenArgs: ReadonlyArray<string> = []
        let seenStdin = ''
        const spawn = fakeSpawnByPrompt(args => {
            seenArgs = args.slice(0, -1)
            seenStdin = args[args.length - 1]
            return {stdout: reply('a')}
        })
        await runFocusedExtraction({
            prompt: 'THE ASSEMBLED PROMPT',
            verifyAgainst: 'c',
            cwd: CWD,
            spawn,
            abortedMessage: 'nope'
        })
        expect(seenArgs).toContain('--no-tools')
        expect(seenStdin).toBe('THE ASSEMBLED PROMPT')
        // The prompt must NOT ride on argv — a page-sized prompt blows the OS limit.
        expect(seenArgs.join(' ')).not.toContain('THE ASSEMBLED PROMPT')
    })

    test('focusedChildArgs is the shared child base plus --no-tools', () => {
        const args = focusedChildArgs()
        expect(args).toContain('--no-tools')
        expect(args).toContain('--print')
        expect(args).toContain('--no-session')
        expect(args).toContain('--no-extensions')
    })

    test('never retries — a failed extraction spawns exactly one child', async () => {
        let spawns = 0
        const spawn = ((): ProcLike => {
            spawns++
            const p = makeProc()
            queueMicrotask(() => p.emit('close', 1))
            return p
        }) as unknown as SpawnFn
        const r = await runFocusedExtraction({
            prompt: 'p',
            verifyAgainst: 'c',
            cwd: CWD,
            spawn,
            abortedMessage: 'nope'
        })
        expect(r.ok).toBe(false)
        expect(spawns).toBe(1)
    })
})
