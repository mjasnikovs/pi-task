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

    test('anchors verification to the project as-shipped, run unaided', () => {
        // Regression guard for the validated work-around-to-pass class: the child has
        // `bash` and can make almost anything go green by preparing the run (export an
        // env var, source a file, run a different command, rebuild in a scratch dir).
        // The prompt must forbid that and treat any such intervention as the defect.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        // run the project's OWN command, unaided / as shipped
        expect(p).toContain("project's own")
        expect(p).toMatch(/as shipped|unaided|fresh\s*\n?\s*checkout/)
        // must NOT prepare/repair/reconfigure the run — name the concrete workarounds
        expect(p).toMatch(/do not prepare, repair, reconfigure/)
        expect(p).toContain('export an')
        expect(p).toContain('environment variable')
        expect(p).toMatch(/scratch dir/)
        // the intervention IS the defect
        expect(p).toMatch(/is the\s*\n?\s*defect/)
        // source-text presence is not verification
        expect(p).toContain('is not verification')
        // still distinguishes a genuine external-service gap from a code defect
        expect(p).toContain('environment gap')
        expect(p).toContain('external')
    })

    test('forbids grep-theater: static-only checks are not a PASS when execution was possible', () => {
        // Regression guard for the mx5 grep-theater class: a schema.sql with INVALID
        // SQL was "verified" by grepping for its own (broken) text while a live
        // Postgres sat reachable in the same container. The prompt must (a) say a
        // grep-only VERIFY block does not cap the obligation to execute/apply the
        // artifact, and (b) require PROBING a declared external service before
        // invoking the absent-service exception — reachable ⇒ must run against it.
        const p = buildVerifyPrompt('GOAL\nx').toLowerCase()
        // the VERIFY block does not cap the obligation
        expect(p).toMatch(/verify block does not cap/)
        expect(p).toMatch(/executed or applied/)
        expect(p).toMatch(/grep-only checks passing[\s\S]*?not a pass/)
        // probe before relying on the external-service exception
        expect(p).toContain('probe')
        expect(p).toMatch(/is reachable, the exception\s*\n?\s*does not apply/)
        expect(p).toMatch(/genuinely absent/)
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

    test('repoHealth FAIL short-circuits to blocked — model child never runs', async () => {
        let childRan = false
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            repoHealth: async () => ({ok: false, reason: '`bun run lint` exited 1'}),
            runChild: async () => {
                childRan = true
                return 'WORK-VERIFIED: PASS'
            }
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('repo health')
        expect(out.reason).toContain('bun run lint')
        // The deterministic fail is authoritative; do not spend a model turn.
        expect(childRan).toBe(false)
    })

    test('repoHealth PASS falls through to the model verdict', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: 'GOAL\nx',
            repoHealth: async () => ({ok: true, reason: 'static checks passed'}),
            runChild: async () => 'WORK-VERIFIED: FAIL behavior wrong'
        })
        expect(out).toEqual({ok: false, reason: 'work did not verify: behavior wrong'})
    })

    test('repoHealth FAIL blocks even a spec-less task (no VERIFY block to lean on)', async () => {
        const out = await runWorkVerification({
            cwd: '/x',
            spec: null,
            repoHealth: async () => ({ok: false, reason: '`bun run lint` exited 1'}),
            runChild: async () => 'WORK-VERIFIED: PASS'
        })
        expect(out.ok).toBe(false)
        expect(out.reason).toContain('repo health')
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
