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
        // A compaction FOLLOWED by a fresh assistant turn was already continued.
        [
            'a compaction before the last assistant message',
            [compactionEntry(), assistantEntry('stop')],
            'stop'
        ],
        // Only the LAST assistant message counts: an earlier abort answered by a
        // later clean turn is history.
        [
            'an earlier abort answered by a clean turn',
            [assistantEntry('aborted'), userEntry('go on'), assistantEntry('stop')],
            'stop'
        ],
        // Non-assistant messages after the last assistant one do not change it.
        ['a trailing user message', [assistantEntry('stop'), userEntry('hi')], 'stop']
    ]
    for (const [name, entries, want] of single) {
        test(`${name} → ${want}`, () => {
            expect(classifyTurnEnd(entries.map(e))).toBe(want)
        })
    }

    // Precedence when several signals are present at once — the order the
    // supervision sequence has always applied: aborted > compaction > error > stop.
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
        // Mirrors runSingleTask: after the resume cap is hit, the error is still
        // read off the last assistant message regardless of the boundary.
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
        watchdog: {consume: script.consume ?? (() => false), graceMs: 50, pollMs: 5}
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

    // The ctx binding used by production, over the shared fake ctx.
    test('turnDepsFor binds a live ctx (sendUserMessage as followUp + waitForIdle + entries)', async () => {
        const {ctx, captured, setIdleEntries} = makeFakeCtx('/tmp/x')
        setIdleEntries([[compactionEntry()], [compactionEntry()], [assistantEntry('stop')]])
        // Mirror runSingleTask: the first idle has already happened.
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
        expect(await steerUntilDone(f.deps)).toBe(false) // implementation completed, no pause
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
