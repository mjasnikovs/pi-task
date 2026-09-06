import {test, expect} from 'bun:test'
import {comparePaired} from '../../scripts/docs-replay.js'

// A budget or limit A/B runs production's arm in two TREES, so both ledgers say
// `treatment` and only the pairing key separates them. Scored on abstention.
const ROW = {
    source: 'r.jsonl',
    module: 'zod',
    query: 'q1',
    arm: 'treatment' as const,
    trial: 1,
    ok: true,
    answer: 'a',
    excerptVerified: true,
    wasUnclear: false,
    from: 'live' as const,
    chunks: 10,
    bytes: 20000
}

test('a pair where only B answers counts as only-B', () => {
    const out = comparePaired([{...ROW, unclear: true}], [{...ROW, unclear: false, bytes: 40000}])
    expect(out).toContain('only-A 0   only-B 1')
    expect(out).toContain('answered  A 0/1   B 1/1')
    expect(out).toContain('mean bytes shown  A 20000   B 40000')
})

test('rows that do not pair are dropped, not counted as a difference', () => {
    const out = comparePaired(
        [{...ROW, unclear: false}],
        [{...ROW, query: 'q2', unclear: true}]
    )
    expect(out).toContain('no paired rows')
})

test('the same trial number is part of the key, so trials pair with trials', () => {
    const out = comparePaired(
        [
            {...ROW, trial: 1, unclear: false},
            {...ROW, trial: 2, unclear: true}
        ],
        [
            {...ROW, trial: 1, unclear: false},
            {...ROW, trial: 2, unclear: false}
        ]
    )
    expect(out).toContain('pairs 2   both 1   only-A 0   only-B 1')
})
