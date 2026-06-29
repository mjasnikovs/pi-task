import {describe, expect, test} from 'bun:test'
import {
    buildVerifyPrompt,
    extractSpecForVerification,
    parseVerifyVerdict,
    runWorkVerification,
    VERIFY_TOOLS
} from './verify-work.js'
import {USER_CANCELLED} from './child-runner.js'

describe('VERIFY_TOOLS', () => {
    test('grants bash (to run) and read, but never edit/write', () => {
        const tools = VERIFY_TOOLS.split(',')
        expect(tools).toContain('bash')
        expect(tools).toContain('read')
        expect(tools).not.toContain('edit')
        expect(tools).not.toContain('write')
    })
})

describe('extractSpecForVerification', () => {
    const body = [
        '## raw prompt',
        'do the thing',
        '',
        '## spec',
        '',
        'GOAL',
        'make it work',
        '',
        'VERIFY:',
        '```sh',
        'bun run build',
        '```',
        '',
        '## phase timings',
        'refine 1s'
    ].join('\n')

    test('slices the spec section out of the task body', () => {
        const spec = extractSpecForVerification(body)
        expect(spec).toContain('GOAL')
        expect(spec).toContain('bun run build')
        expect(spec).not.toContain('## phase timings')
        expect(spec).not.toContain('do the thing')
    })

    test('returns null when there is no spec section', () => {
        expect(extractSpecForVerification('## raw prompt\nhi\n')).toBeNull()
    })

    test('returns null for an empty spec section', () => {
        expect(extractSpecForVerification('## spec\n\n## phase timings\n')).toBeNull()
    })
})

describe('buildVerifyPrompt', () => {
    test('hands over the spec and forbids editing', () => {
        const p = buildVerifyPrompt('GOAL\nbuild it')
        expect(p).toContain('GOAL\nbuild it')
        expect(p).toContain('`bash`')
        expect(p).toContain('CANNOT edit')
        expect(p).toContain('WORK-VERIFIED: PASS')
        expect(p).toContain('WORK-VERIFIED: FAIL')
    })

    test("anchors verification to the project's own build and shipped artifact", () => {
        // Regression guard for the validated false-pass class: the spec's VERIFY
        // block is authored by the weak model and often grades a stand-in (scratch
        // rebuild / source grep). The prompt must push the child past that.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        // run the project's OWN build, not a reconstruction
        expect(p).toContain("project's own")
        expect(p).toMatch(/never substitute your own build|do not.*substitute/)
        // a scratch/temp reconstruction or source-only grep is not enough
        expect(p).toMatch(/temp\/scratch dir|scratch dir|reconstructs the output/)
        // source-text presence is not verification
        expect(p).toContain('source')
        expect(p).toContain('is not verification')
        // self-added missing config IS the defect
        expect(p).toMatch(/that missing piece is the defect|is the defect/)
    })
})

describe('parseVerifyVerdict', () => {
    test('PASS verdict', () => {
        expect(parseVerifyVerdict('ran build ok\nWORK-VERIFIED: PASS')).toEqual({
            pass: true,
            detail: ''
        })
    })

    test('FAIL verdict carries the reason', () => {
        expect(parseVerifyVerdict('WORK-VERIFIED: FAIL build error in Auth.tsx')).toEqual({
            pass: false,
            detail: 'build error in Auth.tsx'
        })
    })

    test('last verdict wins when the model discusses before concluding', () => {
        const text = 'first I thought WORK-VERIFIED: FAIL maybe\n...\nWORK-VERIFIED: PASS'
        expect(parseVerifyVerdict(text).pass).toBe(true)
    })

    test('no marker is not a pass', () => {
        expect(parseVerifyVerdict('looks fine to me').pass).toBe(false)
    })

    test('echoed spec "VERIFY:" header does not false-trigger', () => {
        // The spec text itself contains "VERIFY:"; only the distinct
        // WORK-VERIFIED token counts.
        expect(parseVerifyVerdict('VERIFY:\n```sh\nbun test\n```').pass).toBe(false)
    })
})

describe('runWorkVerification', () => {
    test('no spec → pass no-op, child never runs', async () => {
        let called = false
        const out = await runWorkVerification({
            cwd: '/x',
            spec: null,
            runChild: async () => {
                called = true
                return ''
            }
        })
        expect(out).toEqual({ok: true, reason: 'no spec to verify'})
        expect(called).toBe(false)
    })

    test('PASS verdict → ok', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(out.ok).toBe(true)
    })

    test('FAIL verdict → blocked with reason', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => 'WORK-VERIFIED: FAIL the build is broken'
        })
        expect(out).toEqual({ok: false, reason: 'work did not verify: the build is broken'})
    })

    test('passes VERIFY_TOOLS through to the child', async () => {
        let seenTools = ''
        await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async tools => {
                seenTools = tools
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(seenTools).toBe(VERIFY_TOOLS)
    })

    test('child crash → blocked, never throws', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            runChild: async () => {
                throw new Error('child exited 1')
            }
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('could not run')
    })

    test('user cancel propagates (not swallowed as a fail)', async () => {
        await expect(
            runWorkVerification({
                cwd: '/x',
                spec: 'GOAL\nx',
                runChild: async () => {
                    throw new Error(USER_CANCELLED)
                }
            })
        ).rejects.toThrow(USER_CANCELLED)
    })
})
