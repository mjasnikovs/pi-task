import {describe, expect, test} from 'bun:test'
import {
    ACCEPT_LABEL,
    ACCEPT_VALUE,
    AUTOFIX_LABEL,
    AUTOFIX_VALUE,
    buildResolutionPrompt,
    classifyResolutionAnswer,
    parseResolutionVerdict,
    researchResolution,
    resolutionOptions,
    RESOLUTION_TOOLS
} from '../../src/task/verify-resolution.js'
import {USER_CANCELLED} from '../../src/task/child-runner.js'

describe('RESOLUTION_TOOLS', () => {
    test('grants read + bash, never edit/write (research observes, never fixes)', () => {
        const tools = RESOLUTION_TOOLS.split(',')
        expect(tools).toContain('read')
        expect(tools).toContain('bash')
        expect(tools).not.toContain('edit')
        expect(tools).not.toContain('write')
    })
})

describe('buildResolutionPrompt', () => {
    test('hands over both the spec and the failure reason, and forbids editing', () => {
        const p = buildResolutionPrompt('GOAL\nbuild it', 'the build is broken at Auth.tsx:12')
        expect(p).toContain('GOAL\nbuild it')
        expect(p).toContain('the build is broken at Auth.tsx:12')
        expect(p).toContain('CANNOT edit')
        expect(p).toContain('VERIFY-RESOLUTION: AUTOFIX')
        expect(p).toContain('VERIFY-RESOLUTION: ACCEPT')
    })

    test('biases the unsure case toward AUTOFIX (never bless broken work)', () => {
        const p = buildResolutionPrompt('GOAL', 'reason')
        expect(p).toContain('cannot positively confirm')
        expect(p).toContain('safe default')
    })

    test('tells the reviewer to judge by FUNCTION, not literal text-matching', () => {
        const p = buildResolutionPrompt('GOAL', 'reason')
        expect(p).toContain('judge by FUNCTION')
        expect(p).toContain('OVER-LITERAL')
    })
})

describe('parseResolutionVerdict', () => {
    test('ACCEPT verdict carries the rationale', () => {
        expect(
            parseResolutionVerdict('VERIFY-RESOLUTION: ACCEPT the TOML is valid as written')
        ).toEqual({recommend: 'accept', rationale: 'the TOML is valid as written'})
    })

    test('AUTOFIX verdict carries the rationale', () => {
        expect(
            parseResolutionVerdict('VERIFY-RESOLUTION: AUTOFIX schema.sql is missing the table')
        ).toEqual({recommend: 'autofix', rationale: 'schema.sql is missing the table'})
    })

    test('last verdict wins when the model reasons before concluding', () => {
        const text =
            'at first VERIFY-RESOLUTION: AUTOFIX maybe\n...then I confirmed\nVERIFY-RESOLUTION: ACCEPT it is fine'
        expect(parseResolutionVerdict(text).recommend).toBe('accept')
    })

    test('no marker → defaults to AUTOFIX (conservative)', () => {
        const out = parseResolutionVerdict('I am not sure what to do here')
        expect(out.recommend).toBe('autofix')
        expect(out.rationale).toContain('inconclusive')
    })

    test('verdict with no trailing text still gets a rationale', () => {
        expect(
            parseResolutionVerdict('VERIFY-RESOLUTION: ACCEPT').rationale.length
        ).toBeGreaterThan(0)
    })
})

describe('resolutionOptions', () => {
    test('recommended card is placed FIRST so the boxed picker tints it green', () => {
        expect(resolutionOptions('accept')[0]).toEqual({
            label: ACCEPT_LABEL,
            value: ACCEPT_VALUE,
            recommended: true
        })
        expect(resolutionOptions('autofix')[0]).toEqual({
            label: AUTOFIX_LABEL,
            value: AUTOFIX_VALUE,
            recommended: true
        })
    })

    test('both cards are always offered, exactly one recommended', () => {
        for (const rec of ['accept', 'autofix'] as const) {
            const opts = resolutionOptions(rec)
            expect(opts.map(o => o.value).sort()).toEqual([ACCEPT_VALUE, AUTOFIX_VALUE])
            expect(opts.filter(o => o.recommended)).toHaveLength(1)
        }
    })
})

describe('classifyResolutionAnswer', () => {
    test('card value tokens', () => {
        expect(classifyResolutionAnswer(ACCEPT_VALUE).action).toBe('accept')
        expect(classifyResolutionAnswer(AUTOFIX_VALUE).action).toBe('autofix')
    })

    test('remote button labels', () => {
        expect(classifyResolutionAnswer(ACCEPT_LABEL).action).toBe('accept')
        expect(classifyResolutionAnswer(AUTOFIX_LABEL).action).toBe('autofix')
    })

    test('undefined / empty → cancel (pause, resumable)', () => {
        expect(classifyResolutionAnswer(undefined).action).toBe('cancel')
        expect(classifyResolutionAnswer('   ').action).toBe('cancel')
    })

    test('free-text override → autofix carrying the typed guidance', () => {
        const c = classifyResolutionAnswer('actually just drop the pg_trgm index')
        expect(c.action).toBe('autofix')
        expect(c.guidance).toBe('actually just drop the pg_trgm index')
    })
})

describe('researchResolution', () => {
    test('passes RESOLUTION_TOOLS through to the child', async () => {
        let seenTools = ''
        await researchResolution({
            cwd: '/x',
            spec: 'GOAL',
            failReason: 'broken',
            runChild: async tools => {
                seenTools = tools
                return 'VERIFY-RESOLUTION: ACCEPT fine'
            }
        })
        expect(seenTools).toBe(RESOLUTION_TOOLS)
    })

    test('ACCEPT recommendation flows through', async () => {
        const out = await researchResolution({
            cwd: '/x',
            spec: 'GOAL',
            failReason: 'broken',
            runChild: async () => 'VERIFY-RESOLUTION: ACCEPT the artifact is valid'
        })
        expect(out).toEqual({recommend: 'accept', rationale: 'the artifact is valid'})
    })

    test('child crash → defaults to AUTOFIX, never throws', async () => {
        const out = await researchResolution({
            cwd: '/x',
            spec: 'GOAL',
            failReason: 'broken',
            runChild: async () => {
                throw new Error('child exited 1')
            }
        })
        expect(out.recommend).toBe('autofix')
        expect(out.rationale).toContain('could not run')
    })

    test('user cancel propagates (not swallowed as a default)', async () => {
        await expect(
            researchResolution({
                cwd: '/x',
                spec: 'GOAL',
                failReason: 'broken',
                runChild: async () => {
                    throw new Error(USER_CANCELLED)
                }
            })
        ).rejects.toThrow(USER_CANCELLED)
    })
})
