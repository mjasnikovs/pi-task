import {describe, expect, test} from 'bun:test'
import {
    classifyTurnEnd,
    turnErrorMessage,
    watchdogReminderDelivered,
    resumeAcrossCompactions,
    steerUntilDone,
    superviseWith,
    turnDepsFor,
    CONTINUE_AFTER_COMPACTION,
    MAX_COMPACTION_RESUMES,
    GUARD_TERMINATED,
    type ImplementationTurnDeps,
    type SessionEntryLike,
    type SteerCtx,
    type TurnEnd
} from '../../src/task/implementation-turn.js'
import {
    consumeWatchdogAbort,
    noteWatchdogAbort,
    reminderMessage
} from '../../src/task/command-watchdog.js'
import {makeFakeCtx, assistantEntry, compactionEntry, userEntry} from '../test-utils/fake-ctx.js'

const e = (x: unknown): SessionEntryLike => x as SessionEntryLike

describe('classifyTurnEnd', () => {
    // Each outcome on its own.
    const single: Array<[string, unknown[], TurnEnd]> = [
        ['no entries at all', [], 'stop'],
        ['a clean assistant stop', [assistantEntry('stop')], 'stop'],
        ['a user/watchdog abort', [assistantEntry('aborted')], 'aborted'],
        ['a provider error', [assistantEntry('error', 'boom')], 'error'],
        [
            'a compaction after the last assistant message',
            [assistantEntry('stop'), compactionEntry()],
            'compaction'
        ],
        ['a compaction with no assistant message at all', [compactionEntry()], 'compaction'],
        // lastCompaction < lastAssistant, so the boundary is behind the turn.
        [
            'a compaction before the last assistant message',
            [compactionEntry(), assistantEntry('stop')],
            'stop'
        ],
        // tailPositions keeps only the LAST assistant index, so an earlier abort
        // answered by a later clean turn cannot decide the outcome.
        [
            'an earlier abort answered by a clean turn',
            [assistantEntry('aborted'), userEntry('go on'), assistantEntry('stop')],
            'stop'
        ],
        // Only a `compaction` entry moves lastCompaction; any other trailing entry
        // leaves both positions where they were.
        ['a trailing user message', [assistantEntry('stop'), userEntry('hi')], 'stop']
    ]
    for (const [name, entries, want] of single) {
        test(`${name} → ${want}`, () => {
            expect(classifyTurnEnd(entries.map(e))).toBe(want)
        })
    }

    // Precedence when several signals are present at once. classifyTurnEnd tests
    // them in this order: aborted > compaction > error > stop.
    const combined: Array<[string, unknown[], TurnEnd]> = [
        [
            'aborted + trailing compaction → aborted (ESC beats the boundary)',
            [assistantEntry('aborted'), compactionEntry()],
            'aborted'
        ],
        [
            'error + trailing compaction → compaction (resume first, read the error after)',
            [assistantEntry('error', 'x'), compactionEntry()],
            'compaction'
        ],
        [
            'aborted + error history → aborted (only the last message counts)',
            [assistantEntry('error', 'x'), assistantEntry('aborted')],
            'aborted'
        ],
        [
            'error after an earlier compaction → error',
            [compactionEntry(), assistantEntry('error', 'x')],
            'error'
        ]
    ]
    for (const [name, entries, want] of combined) {
        test(name, () => {
            expect(classifyTurnEnd(entries.map(e))).toBe(want)
        })
    }
})

describe('turnErrorMessage', () => {
    test('quotes the provider message for an error turn', () => {
        expect(turnErrorMessage([e(assistantEntry('error', '400 exceeds context'))])).toBe(
            '400 exceeds context'
        )
    })
    test('degrades to "model error" when the provider gave no message', () => {
        expect(turnErrorMessage([e(assistantEntry('error'))])).toBe('model error')
    })
    test('is undefined for stop / aborted / no assistant', () => {
        expect(turnErrorMessage([e(assistantEntry('stop'))])).toBeUndefined()
        expect(turnErrorMessage([e(assistantEntry('aborted'))])).toBeUndefined()
        expect(turnErrorMessage([])).toBeUndefined()
    })
    test('reads the last assistant message even under a trailing compaction', () => {
        // superviseWith reads the error with turnErrorMessage after the resume loop,
        // and that reads the last assistant message whatever follows it.
        expect(turnErrorMessage([e(assistantEntry('error', 'x')), e(compactionEntry())])).toBe('x')
    })
})

describe('watchdogReminderDelivered', () => {
    const REMINDER = reminderMessage('bash', 15 * 60_000)
    test('true when the reminder follows the last assistant message', () => {
        expect(
            watchdogReminderDelivered([e(assistantEntry('aborted')), e(userEntry(REMINDER))])
        ).toBe(true)
    })
    test('an earlier fire’s reminder, already answered, does not count', () => {
        expect(
            watchdogReminderDelivered([
                e(assistantEntry('aborted')),
                e(userEntry(REMINDER)),
                e(assistantEntry('aborted'))
            ])
        ).toBe(false)
    })
    test('reads block-array content too', () => {
        expect(
            watchdogReminderDelivered([
                e(assistantEntry('aborted')),
                e({
                    type: 'message',
                    message: {role: 'user', content: [{type: 'text', text: REMINDER}]}
                })
            ])
        ).toBe(true)
    })
})

// ─── Fake deps: a scripted session, one entries snapshot per settled turn ────

interface Script {
    /** Snapshot after the first idle, then after each subsequent waitForIdle. */
    turns: unknown[][]
    /** Answers to successive steer prompts. */
    answers?: Array<string | undefined>
    consume?: () => boolean
    /** The runaway guard ended this turn. */
    guardTerminated?: () => boolean
}

function fakeDeps(script: Script) {
    let idles = 0
    const sent: string[] = []
    let asks = 0
    const answers = script.answers ?? []
    const deps: ImplementationTurnDeps = {
        entries: () => {
            const i = Math.min(idles, script.turns.length - 1)
            return script.turns[i].map(e)
        },
        send: text => {
            sent.push(text)
            return Promise.resolve()
        },
        waitForIdle: () => {
            idles++
            return Promise.resolve()
        },
        ask: () => {
            asks++
            return Promise.resolve(answers.shift())
        },
        watchdog: {consume: script.consume ?? (() => false), graceMs: 50, pollMs: 5},
        consumeGuardTermination: script.guardTerminated ?? (() => false)
    }
    return {deps, sent, idles: () => idles, asks: () => asks}
}

describe('resumeAcrossCompactions', () => {
    test('drives continues until the turn ends on an assistant message', async () => {
        const f = fakeDeps({
            turns: [
                [compactionEntry()], // parked at a compaction boundary
                [compactionEntry()], // resumed → crossed threshold again
                [assistantEntry('stop')] // resumed → genuinely finished
            ]
        })
        expect(await resumeAcrossCompactions(f.deps)).toBe(2)
        expect(f.sent).toEqual([CONTINUE_AFTER_COMPACTION, CONTINUE_AFTER_COMPACTION])
        expect(f.idles()).toBe(2)
    })

    test('a clean turn resumes zero times', async () => {
        const f = fakeDeps({turns: [[assistantEntry('stop')]]})
        expect(await resumeAcrossCompactions(f.deps)).toBe(0)
        expect(f.sent).toEqual([])
    })

    test('an aborted turn at a compaction tail is NOT resumed (ESC wins)', async () => {
        const f = fakeDeps({turns: [[assistantEntry('aborted'), compactionEntry()]]})
        expect(await resumeAcrossCompactions(f.deps)).toBe(0)
    })

    test('the safety cap bounds a pathological loop', async () => {
        const f = fakeDeps({turns: [[compactionEntry()]]})
        expect(await resumeAcrossCompactions(f.deps)).toBe(MAX_COMPACTION_RESUMES)
        expect(f.sent).toHaveLength(MAX_COMPACTION_RESUMES)
    })

    // turnDepsFor is the binding production uses: superviseImplementation is
    // superviseWith(turnDepsFor(ctx)). Driven here over the shared fake ctx.
    test('turnDepsFor binds a live ctx (sendUserMessage as followUp + waitForIdle + entries)', async () => {
        const {ctx, captured, setIdleEntries} = makeFakeCtx('/tmp/x')
        setIdleEntries([[compactionEntry()], [compactionEntry()], [assistantEntry('stop')]])
        // Mirror runSingleTask, which awaits waitForIdle before supervising.
        await ctx.waitForIdle()
        const resumes = await resumeAcrossCompactions(turnDepsFor(ctx as SteerCtx))
        expect(resumes).toBe(2)
        const continues = captured.sentMessages.filter(m => m.spec === CONTINUE_AFTER_COMPACTION)
        expect(continues).toHaveLength(2)
        for (const m of continues) {
            expect((m.opts as {deliverAs?: string}).deliverAs).toBe('followUp')
        }
    })
})

describe('steerUntilDone', () => {
    const REMINDER = reminderMessage('bash', 15 * 60_000)

    test('a natural completion never prompts', async () => {
        const f = fakeDeps({turns: [[assistantEntry('stop')]]})
        expect(await steerUntilDone(f.deps)).toBe(false)
        expect(f.asks()).toBe(0)
    })

    test('ESC then steering text continues the same task until a turn finishes', async () => {
        const f = fakeDeps({
            turns: [[assistantEntry('aborted')], [assistantEntry('stop')]],
            answers: ['use the other API']
        })
        expect(await steerUntilDone(f.deps)).toBe(false)
        expect(f.asks()).toBe(1)
        expect(f.sent).toEqual(['use the other API'])
    })

    test('ESC then an empty steer answer pauses', async () => {
        const f = fakeDeps({turns: [[assistantEntry('aborted')]], answers: ['   ']})
        expect(await steerUntilDone(f.deps)).toBe(true)
        expect(f.sent).toEqual([])
    })

    test('watchdog abort with a delivered reminder never prompts the user', async () => {
        // Turn 1: aborted by the watchdog, its follow-up already queued.
        // Turn 2 (after the follow-up runs): a clean stop.
        const f = fakeDeps({
            turns: [
                [assistantEntry('aborted'), userEntry(REMINDER)],
                [assistantEntry('aborted'), userEntry(REMINDER), assistantEntry('stop')]
            ],
            consume: () => true
        })
        expect(await steerUntilDone(f.deps)).toBe(false)
        expect(f.asks()).toBe(0)
    })

    test('human ESC (no watchdog flag) still prompts to steer', async () => {
        const f = fakeDeps({
            turns: [[assistantEntry('aborted')]],
            answers: [''],
            consume: () => false
        })
        expect(await steerUntilDone(f.deps)).toBe(true)
        expect(f.asks()).toBe(1)
    })

    test('stale watchdog flag falls back to the prompt after the grace expires', async () => {
        // Aborted, but no reminder ever lands — the flag was left over.
        let consumed = 0
        const f = fakeDeps({
            turns: [[assistantEntry('aborted')]],
            answers: [''],
            consume: () => {
                consumed++
                return consumed === 1 // one-shot, like the real flag
            }
        })
        expect(await steerUntilDone(f.deps)).toBe(true)
        expect(f.asks()).toBe(1)
    })

    test('watchdog abort flag is one-shot', () => {
        consumeWatchdogAbort() // clear any residue from other tests
        expect(consumeWatchdogAbort()).toBe(false)
        noteWatchdogAbort()
        expect(consumeWatchdogAbort()).toBe(true)
        expect(consumeWatchdogAbort()).toBe(false)
    })
})

describe('superviseWith — the whole sequence', () => {
    test('compaction, then ESC, then steer, then a clean end: resumes 1, not interrupted, no error', async () => {
        const f = fakeDeps({
            turns: [
                [compactionEntry()], // first idle: parked
                [assistantEntry('aborted')], // resumed → user ESC
                [assistantEntry('stop')] // steered → done
            ],
            answers: ['keep going']
        })
        const out = await superviseWith(f.deps)
        expect(out).toEqual({interrupted: false, error: undefined, resumes: 1})
        expect(f.sent).toEqual([CONTINUE_AFTER_COMPACTION, 'keep going'])
    })

    test('a turn that dies with a provider error is reported as the error, not as interrupted', async () => {
        const f = fakeDeps({
            turns: [[assistantEntry('error', '400 exceeds the available context size')]]
        })
        const out = await superviseWith(f.deps)
        expect(out.interrupted).toBe(false)
        expect(out.error).toContain('exceeds the available context size')
    })

    test('a declined steer pauses and never reads an error', async () => {
        const f = fakeDeps({turns: [[assistantEntry('aborted')]], answers: [undefined]})
        const out = await superviseWith(f.deps)
        expect(out).toEqual({interrupted: true, error: undefined, resumes: 0})
    })

    test('a clean turn is the quiet path', async () => {
        const f = fakeDeps({turns: [[assistantEntry('stop')]]})
        expect(await superviseWith(f.deps)).toEqual({
            interrupted: false,
            error: undefined,
            resumes: 0
        })
        expect(f.sent).toEqual([])
        expect(f.asks()).toBe(0)
    })
})

describe('a turn the runaway guard stopped', () => {
    /**
     * `terminate` lets the agent loop finish NORMALLY — the last assistant message
     * keeps `stopReason: "toolUse"` (captured from a real guard-terminated run), so
     * classifyTurnEnd reads `'stop'` and nothing else in the session says the work
     * was cut off. Without this the caller verifies a half-done implementation and
     * re-delivers to a model that deterministically re-thrashes.
     */
    test('is reported as an error, not a clean finish', async () => {
        const f = fakeDeps({turns: [[assistantEntry('stop')]], guardTerminated: () => true})
        const out = await superviseWith(f.deps)
        expect(out.error).toBe(GUARD_TERMINATED)
    })

    test('a turn it did not stop still reports nothing', async () => {
        const f = fakeDeps({turns: [[assistantEntry('stop')]], guardTerminated: () => false})
        expect((await superviseWith(f.deps)).error).toBeUndefined()
    })
})
