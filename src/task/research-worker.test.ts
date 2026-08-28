/**
 * The three research retry gates, driven through the interface instead of past it.
 *
 * Before this module existed, reaching them meant a temp dir, a real task file,
 * and a fake spawn routed on prose lifted out of `prompts.ts` — plus, to tell
 * attempt 1 from attempt 2, a second sentence lifted out of a module-private
 * preamble constant. In a codebase whose workflow is re-wording prompts and
 * measuring what changed, that means a reworded preamble silently stops these
 * tests from testing the gates.
 *
 * Here a test scripts `runWorker` by ATTEMPT and states the `RunWorkerResult`
 * fields each gate reads. Nothing below matches a sentence.
 */
import {describe, expect, test} from 'bun:test'
import {
    runResearchWorker,
    type ResearchWorkerRun,
    type ResearchWorkerSpec
} from './research-worker.js'
import type {RunWorkerResult} from '../workers/pi-worker-core.js'

/** A finished worker result: clean, with only the fields a gate reads set. */
function result(over: Partial<RunWorkerResult> = {}): RunWorkerResult {
    return {
        text: '- a real finding',
        exitCode: 0,
        stderr: '',
        aborted: false,
        sawOutput: true,
        waitMs: 1,
        workMs: 1,
        attempts: 1,
        totalWallMs: 2,
        restarts: [],
        salvagedFromDiscardedAttempt: false,
        groundingRetrievalCount: 3,
        ...over
    }
}

interface Harness {
    run: ResearchWorkerRun
    /** The preamble prepended to each attempt, in order ('' for the first). */
    preambles: string[]
    persisted: Array<{heading: string; text: string}>
    done: number
}

/** `attempts` is consumed in order; the last one repeats. */
function harness(attempts: RunWorkerResult[], opts: {cached?: string} = {}): Harness {
    const preambles: string[] = []
    const persisted: Array<{heading: string; text: string}> = []
    let i = 0
    const h: Harness = {
        preambles,
        persisted,
        done: 0,
        run: {
            runWorker: (_label, input) => {
                // The prompt is `${preamble}\n\n${base}`; BASE is the last line.
                const idx = input.prompt.lastIndexOf('\n\nBASE')
                preambles.push(idx === -1 ? '' : input.prompt.slice(0, idx))
                return Promise.resolve(attempts[Math.min(i++, attempts.length - 1)]!)
            },
            cwd: '/nowhere',
            taskId: 'TASK_0001',
            signal: new AbortController().signal,
            thinkingFor: () => [],
            record: (_label, p) => p,
            onDone: () => {
                h.done += 1
            },
            readCached: () => Promise.resolve(opts.cached ?? ''),
            persistSection: (heading, text) => {
                persisted.push({heading, text})
                return Promise.resolve()
            },
            carryForward: false,
            fanoutTimeout: null,
            progressCeilingMs: null
        }
    }
    return h
}

const SPEC: ResearchWorkerSpec = {section: 'CONTEXT', label: 'worker:context', prompt: 'BASE'}

describe('the cache skip', () => {
    test('a worker whose output is already on disk is not run at all', async () => {
        const h = harness([result()], {cached: '- from a previous run'})

        const out = await runResearchWorker(SPEC, h.run)

        expect(h.preambles).toEqual([])
        expect(out).toEqual({name: 'CONTEXT', text: '- from a previous run'})
        // Still counted done — the progress line is about workers settled, not
        // about children spawned.
        expect(h.done).toBe(1)
        expect(h.persisted).toEqual([])
    })
})

describe('the EMPTY-SECTION gate', () => {
    test('an empty answer is retried once, and a real retry replaces it', async () => {
        const h = harness([result({text: ''}), result({text: '- found on the retry'})])

        const out = await runResearchWorker(SPEC, h.run)

        expect(h.preambles).toHaveLength(2)
        expect(h.preambles[0]).toBe('')
        expect(h.preambles[1]!.length).toBeGreaterThan(0)
        expect(out.text).toBe('- found on the retry')
    })

    test('two empty answers are recorded as an empty section, not a failure', async () => {
        // issue #10: on a task that touches nothing, silence is the CORRECT
        // answer and used to kill the whole run.
        const h = harness([result({text: ''}), result({text: ''})])

        const out = await runResearchWorker(SPEC, h.run)

        expect(out.text).toContain('CONTEXT worker ran and reported no entries')
        expect(h.persisted).toEqual([{heading: 'research worker CONTEXT', text: out.text}])
    })

    test('it is the ONE gate that can fail the phase', async () => {
        // An empty answer whose retry did not run cleanly is fatal — a provider
        // error behind silence is not the same as "nothing to report".
        const h = harness([result({text: ''}), result({text: '', exitCode: 1})])

        await expect(runResearchWorker(SPEC, h.run)).rejects.toThrow()
    })
})

describe('the ZERO-RETRIEVAL gate', () => {
    const spec: ResearchWorkerSpec = {...SPEC, zeroRetrievalRetry: 'RETRIEVE FIRST'}

    test('a section written from memory is re-run, and a grounded retry replaces it', async () => {
        const h = harness([
            result({text: '- from memory', groundingRetrievalCount: 0}),
            result({text: '- actually retrieved', groundingRetrievalCount: 4})
        ])

        const out = await runResearchWorker(spec, h.run)

        expect(h.preambles[1]).toBe('RETRIEVE FIRST')
        expect(out.text).toBe('- actually retrieved')
    })

    test('a retry that STILL retrieved nothing is discarded — no regression', async () => {
        const h = harness([
            result({text: '- from memory', groundingRetrievalCount: 0}),
            result({text: '- also from memory', groundingRetrievalCount: 0})
        ])

        const out = await runResearchWorker(spec, h.run)

        expect(out.text).toBe('- from memory')
    })

    test('it never fires on an empty section — there is nothing ungrounded there', async () => {
        const h = harness([result({text: '', groundingRetrievalCount: 0})])

        await runResearchWorker(spec, h.run)

        // Attempt 2 is the EMPTY gate's retry, not this one.
        expect(h.preambles[1]).not.toBe('RETRIEVE FIRST')
    })
})

describe('the SILENT gate', () => {
    const spec: ResearchWorkerSpec = {...SPEC, retryIfSilent: 'EMIT BULLETS'}

    test('a section with zero bullets is re-run, and bullets replace it', async () => {
        const h = harness([
            result({text: 'I looked at the repository and formed an impression.'}),
            result({text: '- src/index.ts is the entry point'})
        ])

        const out = await runResearchWorker(spec, h.run)

        expect(h.preambles[1]).toBe('EMIT BULLETS')
        expect(out.text).toBe('- src/index.ts is the entry point')
    })

    test('a retry that is still bulletless is discarded', async () => {
        const h = harness([
            result({text: 'Some prose about the repository.'}),
            result({text: 'More prose, still no bullets.'})
        ])

        const out = await runResearchWorker(spec, h.run)

        expect(out.text).toBe('Some prose about the repository.')
    })

    test('a confirmed-empty section costs exactly two children, never a third', async () => {
        // The EMPTY gate already spent a retry on exactly this — "you wrote
        // nothing" — and the worker answered "nothing applies" a second time.
        // `confirmedEmpty` guards this gate against burning a third child for the
        // same answer.
        //
        // The guard is BELT-AND-BRACES, and this test says so rather than
        // pretending otherwise: removing `!confirmedEmpty` from the condition
        // leaves this green, because an empty body is silent-but-not-a-loss and
        // the gate declines it anyway. What is pinned here is the observable
        // cost, which is what the comment on that branch actually claims.
        const h = harness([result({text: ''}), result({text: ''})])

        const out = await runResearchWorker(spec, h.run)

        expect(h.preambles).toHaveLength(2)
        expect(out.text).toContain('reported no entries')
    })
})

describe('the outcome', () => {
    test('a runaway degrades to its partial output instead of failing the phase', async () => {
        const h = harness([
            result({text: '- half an answer', timedOut: true, exitCode: 143, aborted: true})
        ])

        const out = await runResearchWorker(SPEC, h.run)

        expect(out.text).toContain('degraded')
        expect(out.text).toContain('- half an answer')
    })

    test('a fatal failure throws, and nothing untrustworthy is cached', async () => {
        const h = harness([result({text: '- something', exitCode: 2})])

        await expect(runResearchWorker(SPEC, h.run)).rejects.toThrow()
        expect(h.persisted).toEqual([])
    })

    test('postProcess runs BEFORE the section is persisted', async () => {
        // The cache a resume reads back must already be gated: a post-check that
        // ran after persist would leave the rejected text on disk.
        const h = harness([result({text: '- raw'})])

        const out = await runResearchWorker({...SPEC, postProcess: t => `${t} [checked]`}, h.run)

        expect(out.text).toBe('- raw [checked]')
        expect(h.persisted[0]!.text).toBe('- raw [checked]')
    })

    test('a bare "(none)" is recorded the same way as an empty answer', async () => {
        const h = harness([result({text: '(none)'})])

        const out = await runResearchWorker(SPEC, h.run)

        expect(out.text).toContain('reported no entries')
    })
})
