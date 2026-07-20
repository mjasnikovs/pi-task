import {expect, test} from 'bun:test'
import {
    applyDemotions,
    isNonProgress,
    normalizeFailureDetail,
    rankedFirstFailure,
    unobservedDebtReason
} from './final-gate-progress.js'

const sig = (s: string): string => normalizeFailureDetail(s)

test('normalizeFailureDetail: erases ports, timings, pids, tmp paths and timestamps', () => {
    const a =
        'boot check: `bun run dev` (pid 4127) never opened a listening socket on 127.0.0.1:3000 '
        + 'after 12000ms — /tmp/pi-boot-a91f/out.log (2026-07-19T13:17:27Z)'
    const b =
        'boot check: `bun run dev` (pid 5510) never opened a listening socket on 127.0.0.1:5173 '
        + 'after 12500ms — /tmp/pi-boot-77c2/out.log (2026-07-19T16:39:06Z)'
    expect(sig(a)).toBe(sig(b))
})

test('normalizeFailureDetail: real progress stays visible — counts are NOT collapsed', () => {
    expect(sig('`bun run test` exited 1 — 7 failing')).not.toBe(
        sig('`bun run test` exited 1 — 2 failing')
    )
    expect(sig('boot check: no listener')).not.toBe(sig('static checks: `make lint` exited 2'))
})

// A failure detail embeds the failing command's output tail verbatim, and those
// tails are mostly file:line. Collapsing the line number made "fixed the error at
// :41, uncovered a different one at :83" — real progress — compare equal, demoting
// a fixable check to UNOBSERVED debt.
test('normalizeFailureDetail: a moved source location is progress, not a repeat', () => {
    expect(sig('`bun run typecheck` exited 2 — src/db.ts:41 error')).not.toBe(
        sig('`bun run typecheck` exited 2 — src/db.ts:83 error')
    )
    expect(sig('TypeError at components/Cart.tsx:88')).not.toBe(
        sig('TypeError at components/Cart.tsx:212')
    )
    expect(sig('error at lib/api.js:120:5')).not.toBe(sig('error at lib/api.js:120:9'))
})

test('normalizeFailureDetail: bare and host-attached ports still collapse', () => {
    expect(sig('boot check: no listener on :3000')).toBe(sig('boot check: no listener on :5173'))
    expect(sig('no socket on 127.0.0.1:3000')).toBe(sig('no socket on 127.0.0.1:5173'))
    expect(sig('listening check failed on :8080 after 5000ms (pid 91)')).toBe(
        sig('listening check failed on :4000 after 6100ms (pid 77)')
    )
})

test('rankedFirstFailure: prefers the ranked list, degrades to the single reason', () => {
    expect(rankedFirstFailure({reason: 'a | b', failures: ['a', 'b']})).toBe('a')
    expect(rankedFirstFailure({reason: 'only'})).toBe('only')
    expect(rankedFirstFailure({reason: '   '})).toBeNull()
    expect(rankedFirstFailure({})).toBeNull()
})

test('isNonProgress: fires only on a repeated failure from an attempt that edited', () => {
    const prev = sig('boot check: no listener on :3000')
    const cur = 'boot check: no listener on :5173'
    expect(isNonProgress({previousSignature: prev, currentDetail: cur, edited: true})).toBe(true)
    // No edits ⇒ the attempt says nothing about falsifiability.
    expect(isNonProgress({previousSignature: prev, currentDetail: cur, edited: false})).toBe(false)
    // No previous attempt ⇒ never on the first repeat.
    expect(isNonProgress({previousSignature: null, currentDetail: cur, edited: true})).toBe(false)
    // A different failure is progress.
    expect(
        isNonProgress({
            previousSignature: prev,
            currentDetail: '`bun run test` exited 1',
            edited: true
        })
    ).toBe(false)
})

test('applyDemotions: drops only the demoted signatures, volatile bits ignored', () => {
    const demoted = new Set([sig('boot check: no listener on :3000')])
    expect(
        applyDemotions(['boot check: no listener on :5173', '`bun run test` exited 1'], demoted)
    ).toEqual(['`bun run test` exited 1'])
    expect(applyDemotions(['boot check: no listener on :9999'], demoted)).toEqual([])
    expect(applyDemotions(['a', 'b'], new Set())).toEqual(['a', 'b'])
})

test('unobservedDebtReason: names the check and says it was never proven passing', () => {
    const r = unobservedDebtReason('boot check: never opened a listening socket')
    expect(r).toContain('boot check: never opened a listening socket')
    expect(r).toMatch(/UNOBSERVED/)
    expect(r).toMatch(/unfalsifiable/)
})
