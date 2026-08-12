import {test, expect, describe} from 'bun:test'
import {
    TERMINAL_OUTCOMES,
    formatAt,
    formatWhy,
    type TerminalOutcomeKind
} from './terminal-outcome.js'

const KINDS: readonly TerminalOutcomeKind[] = [
    'done',
    'paused',
    'session-cancelled',
    'interrupted',
    'failed'
]

const ctx = (over: Partial<Parameters<(typeof TERMINAL_OUTCOMES)['done']['message']>[0]> = {}) => ({
    tag: 'AUTO_0002',
    at: '',
    why: '',
    resumeCmd: '/task-auto-resume',
    ...over
})

test('every gate outcome has a row — a sixth kind is a compile error, not a fallthrough', () => {
    for (const kind of KINDS) {
        expect(TERMINAL_OUTCOMES[kind]).toBeDefined()
    }
    expect(Object.keys(TERMINAL_OUTCOMES).sort()).toEqual([...KINDS].sort())
})

describe('persistence — the two questions each outcome answers', () => {
    // These used to be answered twice, 600 lines apart, in two switches with
    // line-for-line correspondence. Now they are one table test.
    const expected: Record<TerminalOutcomeKind, {markResumable: boolean; failParent: boolean}> = {
        done: {markResumable: false, failParent: false},
        paused: {markResumable: true, failParent: true},
        // Nothing ran, so there is nothing to demote.
        'session-cancelled': {markResumable: false, failParent: false},
        // The USER stopped it — the parent run stays in_progress so a resume
        // picks up where it left off.
        interrupted: {markResumable: true, failParent: false},
        failed: {markResumable: true, failParent: true}
    }
    for (const kind of KINDS) {
        test(`${kind}`, () => {
            expect(TERMINAL_OUTCOMES[kind].markResumable).toBe(expected[kind].markResumable)
            expect(TERMINAL_OUTCOMES[kind].failParent).toBe(expected[kind].failParent)
        })
    }
})

test('only a real failure is announced in red', () => {
    expect(TERMINAL_OUTCOMES.failed.level).toBe('error')
    expect(TERMINAL_OUTCOMES.done.level).toBe('info')
    for (const kind of ['paused', 'session-cancelled', 'interrupted'] as const) {
        // A pause is not an error: the tree is fine and the user simply has not
        // decided. Announcing it in red is how a user-requested stop reads as a
        // crash.
        expect(TERMINAL_OUTCOMES[kind].level).toBe('warning')
    }
})

describe('messages carry the calling command own resume verb', () => {
    for (const kind of KINDS) {
        test(`${kind} names the resume command it was given`, () => {
            const auto = TERMINAL_OUTCOMES[kind].message(ctx())
            const single = TERMINAL_OUTCOMES[kind].message(
                ctx({tag: 'TASK_0001', resumeCmd: '/task-resume'})
            )
            if (kind === 'done') {
                // The one outcome with nothing to resume.
                expect(auto).not.toContain('resume')
                return
            }
            expect(auto).toContain('/task-auto-resume')
            expect(single).toContain('/task-resume')
            expect(single).not.toContain('/task-auto-resume')
        })
    }
})

test('the step is named only when the command has one', () => {
    // /task runs a single task and has no step to name; /task-auto does.
    expect(formatAt()).toBe('')
    expect(formatAt('Add auth routes')).toBe(' at "Add auth routes"')
    expect(TERMINAL_OUTCOMES.interrupted.message(ctx({at: formatAt('Add auth routes')}))).toBe(
        'AUTO_0002 paused at "Add auth routes" — resume with /task-auto-resume.'
    )
    expect(
        TERMINAL_OUTCOMES.interrupted.message(
            ctx({tag: 'TASK_0001', at: formatAt(), resumeCmd: '/task-resume'})
        )
    ).toBe('TASK_0001 paused — resume with /task-resume.')
})

describe('formatWhy', () => {
    test('no reason produces nothing, not an empty dash', () => {
        expect(formatWhy()).toBe('')
        expect(formatWhy('')).toBe('')
    })

    test('a reason is truncated to one line worth', () => {
        expect(formatWhy('context overflow')).toBe(' — context overflow')
        const long = formatWhy('x'.repeat(400))
        expect(long.length).toBe(163)
    })
})

test('a failed outcome reads the same from both commands apart from step and verb', () => {
    expect(
        TERMINAL_OUTCOMES.failed.message(
            ctx({at: formatAt('Add auth routes'), why: formatWhy('exit 1')})
        )
    ).toBe('AUTO_0002 stopped at "Add auth routes" — exit 1 — fix and run /task-auto-resume.')
    expect(
        TERMINAL_OUTCOMES.failed.message(
            ctx({tag: 'TASK_0001', why: formatWhy('exit 1'), resumeCmd: '/task-resume'})
        )
    ).toBe('TASK_0001 stopped — exit 1 — fix and run /task-resume.')
})
