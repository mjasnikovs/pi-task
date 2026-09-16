import {describe, expect, test} from 'bun:test'
import {formatFixBanner, type FixContext} from '../../src/task/fix-context.js'
import type {Disposition} from '../../src/task/gate-resolution.js'

const AUTOFIX: Disposition = {
    rule: 'autofix',
    action: 'autofix',
    debtOrigin: null,
    reason: 'autofix recommended, unattended 2/3'
}

const ctx = (over: Partial<FixContext> = {}): FixContext => ({
    outcome: {
        ok: false,
        failClass: 'repo-health',
        reason: 'repo health: `bun run lint` exited 1'
    },
    disposition: AUTOFIX,
    probes: {},
    attempt: 2,
    ...over
})

describe('formatFixBanner', () => {
    test('keeps the RE-ATTEMPT opening', () => {
        expect(formatFixBanner(ctx()).startsWith('RE-ATTEMPT —')).toBe(true)
    })

    test('names the fail class and the attempt', () => {
        const banner = formatFixBanner(ctx())
        expect(banner).toContain('ATTEMPT 2')
        expect(banner).toContain('FAILURE CLASS: repo-health')
        expect(banner).toContain('repo health:')
    })

    test('the class comes with the one instruction 0034 needed', () => {
        expect(formatFixBanner(ctx())).toContain('suppressing, disabling, deleting or')
    })

    test('probe findings ride along, labelled', () => {
        const banner = formatFixBanner(
            ctx({
                probes: {
                    suppressionWidening: [
                        'src/client/api.ts — 16 net-new `@ts-expect-error` lines'
                    ],
                    prohibition: []
                }
            })
        )
        expect(banner).toContain('WHAT THE DETERMINISTIC PROBES ALREADY FOUND:')
        expect(banner).toContain('suppressions this task added')
        expect(banner).toContain('16 net-new `@ts-expect-error` lines')
        // An empty channel is not a heading with nothing under it.
        expect(banner).not.toContain('spec-forbidden paths')
    })

    test('no probe findings → no probe block', () => {
        expect(formatFixBanner(ctx())).not.toContain('DETERMINISTIC PROBES')
    })

    test('a contradiction tells the re-run not to edit the frozen path', () => {
        const banner = formatFixBanner(
            ctx({contradiction: {criterion: 'eslint . exits 0', frozenPath: 'eslint.config.js'}})
        )
        expect(banner).toContain('SPEC CONTRADICTION: `eslint.config.js`')
        expect(banner).toContain('eslint . exits 0')
        expect(banner).toContain('Do NOT edit the frozen path')
    })

    test('the diagnosis and the user guidance both survive', () => {
        const banner = formatFixBanner(
            ctx({diagnosis: 'the JOIN aliases the table as u', guidance: 'start from the router'})
        )
        expect(banner).toContain('DIAGNOSIS')
        expect(banner).toContain('the JOIN aliases the table as u')
        expect(banner).toContain('User guidance: start from the router')
    })
})
