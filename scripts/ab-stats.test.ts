/**
 * Every expected value here was computed independently as an exact BigInt
 * rational over hypergeometric coefficients — never by a second floating-point
 * implementation, which would only prove the two agree with each other. The
 * fraction is given beside each so the arithmetic can be re-derived by hand.
 *
 * The A/B harnesses live in scripts/ and are never shipped in dist, but this
 * arithmetic decides SHIPPED vs REFUTED — the same reason ab-verdict.ts is tested.
 */
import {describe, expect, test} from 'bun:test'
import {
    fisherOneSided,
    fisherTwoSided,
    logChoose,
    mean,
    minAttainableP,
    pairByStimulus,
    pairedPermutationP,
    pct,
    permutationP,
    wilson
} from './ab-stats.js'

describe('fisherOneSided — P(X >= a), margins fixed at the observed table', () => {
    const REFERENCE: Array<[number, number, number, number, number, string]> = [
        [3, 1, 1, 3, 0.24285714285714285, '17/70'],
        [4, 0, 0, 4, 0.014285714285714285, '1/70'],
        [1, 3, 3, 1, 0.9857142857142858, '69/70'],
        [0, 4, 4, 0, 1, '70/70'],
        [2, 2, 2, 2, 0.7571428571428571, '53/70'],
        [15, 5, 8, 12, 0.026775496297187066, '2375853480/88732378800'],
        [12, 8, 10, 10, 0.3755931537282797, '42584850100/113380261800'],
        [5, 15, 15, 5, 0.9998200163166068, '137821718694/137846528820'],
        [20, 0, 10, 10, 0.00021795989537925023, '184756/847660528'],
        [18, 2, 10, 10, 0.006907073925983826, '38588810/5586853480'],
        [20, 0, 0, 20, 7.254444551924844e-12, '1/137846528820']
    ]

    for (const [a, b, c, d, expected, fraction] of REFERENCE) {
        test(`[[${a},${b}],[${c},${d}]] = ${fraction}`, () => {
            expect(fisherOneSided(a, b, c, d)).toBeCloseTo(expected, 12)
        })
    }

    test('a single-term tail — the case the broken copy also got right', () => {
        // At a = min(row1, col1) the sum has exactly one term. The implementation
        // this module replaced was correct there and wrong everywhere else, so a
        // net built only from boundary tables re-admits the same class of bug.
        expect(fisherOneSided(4, 0, 0, 4)).toBeCloseTo(1 / 70, 15)
    })

    test('the tail falls as the treatment cell rises', () => {
        const ps = [10, 12, 14, 16, 18, 20].map(a => fisherOneSided(a, 20 - a, 10, 10))
        for (let i = 1; i < ps.length; i++) expect(ps[i]).toBeLessThan(ps[i - 1])
    })

    test('transposing the table leaves the tail unchanged', () => {
        // Fisher conditions on BOTH margins, so row1 and col1 are interchangeable.
        for (const [a, b, c, d] of [
            [3, 1, 1, 3],
            [15, 5, 8, 12],
            [12, 8, 10, 10],
            [1, 9, 8, 2]
        ]) {
            expect(fisherOneSided(a, c, b, d)).toBeCloseTo(fisherOneSided(a, b, c, d), 12)
        }
    })

    test('every tail is a probability', () => {
        for (let a = 0; a <= 20; a++) {
            for (const base of [0, 5, 10, 15, 20]) {
                const p = fisherOneSided(a, 20 - a, base, 20 - base)
                expect(p).toBeGreaterThan(0)
                expect(p).toBeLessThanOrEqual(1)
            }
        }
    })

    test('an empty table proves nothing', () => {
        expect(fisherOneSided(0, 0, 0, 0)).toBe(1)
    })

    describe('the tables where the copy this replaced crossed alpha', () => {
        // owned-freeze-delivered-ab.ts carried a private Fisher that let the margins
        // move with the summation index. Both of these sat on the wrong side of
        // 0.05 under it, so a real lever would have been recorded as noise. The
        // error was conservative, so a false SHIPPED was never reachable that way —
        // unlike the rounding hazard pinned under minAttainableP below.
        test('15/20 vs 8/20 — that copy said 0.0759, the truth is 0.0268', () => {
            const p = fisherOneSided(15, 5, 8, 12)
            expect(p).toBeCloseTo(0.026775496297187066, 12)
            expect(p).toBeLessThan(0.05)
        })

        test('16/20 vs 9/20 — that copy said 0.0661, the truth is 0.0242', () => {
            const p = fisherOneSided(16, 4, 9, 11)
            expect(p).toBeCloseTo(0.02418603252863542, 12)
            expect(p).toBeLessThan(0.05)
        })
    })
})

describe('fisherTwoSided — every table no more likely than the observed one', () => {
    const REFERENCE: Array<[number, number, number, number, number, string]> = [
        [3, 1, 1, 3, 0.4857142857142857, '34/70'],
        [2, 2, 2, 2, 1, '70/70'],
        [15, 5, 8, 12, 0.05355099259437413, '4751706960/88732378800'],
        [12, 8, 10, 10, 0.7511863074565595, '85169700200/113380261800'],
        [5, 15, 15, 5, 0.0038475273083775283, '530368284/137846528820'],
        [1, 9, 8, 2, 0.005477494641581329, '920/167960']
    ]

    for (const [a, b, c, d, expected, fraction] of REFERENCE) {
        test(`[[${a},${b}],[${c},${d}]] = ${fraction}`, () => {
            expect(fisherTwoSided(a, b, c, d)).toBeCloseTo(expected, 12)
        })
    }

    test('it is symmetric in direction, where the one-sided test is not', () => {
        // The pair that shows why choosing a tail after seeing the data is not a
        // pre-registration: reversing the effect leaves the two-sided p alone and
        // takes the one-sided p from 0.0038-ish to almost 1.
        expect(fisherTwoSided(5, 15, 15, 5)).toBeCloseTo(fisherTwoSided(15, 5, 5, 15), 12)
        expect(fisherOneSided(5, 15, 15, 5)).toBeGreaterThan(0.99)
        expect(fisherOneSided(15, 5, 5, 15)).toBeLessThan(0.01)
    })

    test('it never reports less than the one-sided tail pointing the observed way', () => {
        // NOT "never less than the one-sided p" — that is false, and the failing
        // version of this test said so. At a = 0 the greater-tail p is ~1 while the
        // two-sided p is tiny. The true relation is against whichever tail the
        // observed table actually sits in.
        for (let a = 0; a <= 20; a += 2) {
            const two = fisherTwoSided(a, 20 - a, 10, 10)
            const greater = fisherOneSided(a, 20 - a, 10, 10)
            const lesser = fisherOneSided(10, 10, a, 20 - a)
            expect(two).toBeGreaterThanOrEqual(Math.min(greater, lesser) - 1e-12)
        }
    })
})

describe('minAttainableP — could this run have reached significance at all?', () => {
    test('3 per arm cannot reach 0.05, and 4 can', () => {
        // This is the fact live-research-fanout-budget-ab.test.ts states by hand as
        // the reason MIN_CONTROL_N is 4. The floor at 3v3 is EXACTLY 1/20, so a
        // `p < 0.05` gate can never be met however perfect the separation.
        expect(minAttainableP(3, 3)).toBe(0.05)
        expect(minAttainableP(4, 4)).toBeCloseTo(1 / 70, 12)
        expect(minAttainableP(4, 4) < 0.05).toBe(true)
    })

    test('the 3v3 floor does not slip under 0.05 by a rounding error', () => {
        // The regression this pins is a FALSE SHIPPED, the direction that matters.
        // Summed in log space the exact 1/20 comes back as 0.049999999999999961 and
        // a `p < 0.05` gate passes at the smallest n anyone would run — with no real
        // effect behind it. The exact rational path makes it the same double as the
        // literal, so the comparison answers the question that was actually asked.
        expect(minAttainableP(3, 3) < 0.05).toBe(false)
        expect(fisherOneSided(3, 0, 0, 3)).toBe(0.05)
    })

    test('it is the p of the most extreme table those sizes allow', () => {
        expect(minAttainableP(20, 20)).toBeCloseTo(fisherOneSided(20, 0, 0, 20), 15)
    })

    test('it falls as the arms grow', () => {
        const floors = [4, 6, 8, 12, 20].map(n => minAttainableP(n, n))
        for (let i = 1; i < floors.length; i++) expect(floors[i]).toBeLessThan(floors[i - 1])
    })

    test('an empty arm can attain nothing', () => {
        expect(minAttainableP(0, 20)).toBe(1)
        expect(minAttainableP(20, 0)).toBe(1)
    })
})

describe('wilson', () => {
    test('n = 0 is not a proportion of anything', () => {
        expect(wilson(0, 0)).toEqual([0, 0])
    })

    test('the interval brackets the observed rate and stays inside [0,1]', () => {
        for (const [k, n] of [
            [0, 20],
            [1, 20],
            [10, 20],
            [19, 20],
            [20, 20]
        ]) {
            const [lo, hi] = wilson(k, n)
            expect(lo).toBeGreaterThanOrEqual(0)
            expect(hi).toBeLessThanOrEqual(1)
            expect(lo).toBeLessThanOrEqual(k / n)
            expect(hi).toBeGreaterThanOrEqual(k / n)
        }
    })

    test('it does not collapse to a point at the extremes, unlike the normal approximation', () => {
        // 20/20 has a normal-approximation interval of exactly [1,1], which claims
        // certainty from 20 trials. Wilson keeps a lower bound below 1.
        const [lo, hi] = wilson(20, 20)
        expect(hi).toBe(1)
        expect(lo).toBeLessThan(1)
        expect(lo).toBeGreaterThan(0.8)
    })

    test('the interval narrows as n grows at a fixed rate', () => {
        const widths = [10, 40, 160].map(n => {
            const [lo, hi] = wilson(n / 2, n)
            return hi - lo
        })
        for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThan(widths[i - 1])
    })
})

describe('permutationP', () => {
    test('identical arms cannot be separated', () => {
        expect(permutationP([1, 2, 3], [1, 2, 3])).toBe(1)
    })

    test('an empty arm has nothing to permute', () => {
        expect(permutationP([], [1, 2, 3])).toBe(1)
        expect(permutationP([1, 2, 3], [])).toBe(1)
    })

    test('exact and symmetric', () => {
        const p = permutationP([1, 2, 3], [7, 8, 9])
        expect(p).toBeCloseTo(permutationP([7, 8, 9], [1, 2, 3]), 12)
        // C(6,3) = 20 arrangements; only the observed split and its mirror reach
        // the observed separation.
        expect(p).toBeCloseTo(2 / 20, 12)
    })

    test('n=3 per arm can never reach 0.05 — this is why MIN_CONTROL_N is 4', () => {
        expect(permutationP([1, 2, 3], [100, 200, 300])).toBeGreaterThan(0.05)
    })

    test('a clean separation at n=4 does reach it', () => {
        expect(permutationP([1, 2, 3, 4], [100, 200, 300, 400])).toBeLessThan(0.05)
    })

    test('sampled arms are reproducible — a re-scored verdict is the same verdict', () => {
        const a = Array.from({length: 14}, (_, i) => i)
        const b = Array.from({length: 14}, (_, i) => i + 3)
        expect(permutationP(a, b)).toBe(permutationP(a, b))
    })
})

describe('pct and mean — one convention', () => {
    test('a zero denominator is "n/a", never "0.0%"', () => {
        // Four renderings of 0/0 used to be in circulation. A reader comparing two
        // reports could not tell "nothing happened" from "nothing was measured".
        expect(pct(0, 0)).toBe('n/a')
        expect(pct(5, 0)).toBe('n/a')
    })

    test('ordinary proportions', () => {
        expect(pct(1, 2)).toBe('50.0%')
        expect(pct(0, 20)).toBe('0.0%')
        expect(pct(20, 20)).toBe('100.0%')
        expect(pct(1, 3, 2)).toBe('33.33%')
    })

    test('mean of nothing is 0, not NaN', () => {
        expect(mean([])).toBe(0)
        expect(mean([1, 2, 3])).toBe(2)
    })
})

describe('logChoose', () => {
    test('matches exact binomial coefficients', () => {
        expect(Math.exp(logChoose(8, 4))).toBeCloseTo(70, 9)
        expect(Math.exp(logChoose(20, 10))).toBeCloseTo(184756, 4)
    })

    test('out of range is impossible, not an error', () => {
        expect(logChoose(4, 5)).toBe(-Infinity)
        expect(logChoose(4, -1)).toBe(-Infinity)
    })
})

describe('pairedPermutationP', () => {
    test('matches the exact sign-flip distribution at small n', () => {
        // n=3 with every pair in the same direction: only the all-negative and
        // all-positive arrangements reach |sum|, so p = 2/8 exactly.
        expect(pairedPermutationP([10, 10, 10], [20, 20, 20])).toBeCloseTo(0.25, 12)
        // n=4, same shape: 2/16.
        expect(pairedPermutationP([10, 10, 10, 10], [20, 20, 20, 20])).toBeCloseTo(0.125, 12)
    })

    test('identical arms cannot be separated', () => {
        expect(pairedPermutationP([1, 2, 3], [1, 2, 3])).toBe(1)
    })

    test('empty is 1, not NaN', () => {
        expect(pairedPermutationP([], [])).toBe(1)
    })

    test('misaligned arms are a caller bug, not a silent truncation', () => {
        expect(() => pairedPermutationP([1, 2], [1])).toThrow()
    })

    test('a zero duration is clamped, not dropped — n must not move silently', () => {
        // Dropping the pair would change n and so change every p-value the run
        // reports, for a clock-resolution artefact.
        expect(pairedPermutationP([0, 10, 10], [20, 20, 20])).toBeCloseTo(0.25, 12)
    })

    test('it sees the effect the unpaired test loses to the stimulus spread', () => {
        // The gate design: stimuli spanning three orders of magnitude, off
        // uniformly 0.6x on every one of them.
        const on = [1000, 4000, 16_000, 64_000, 256_000, 512_000]
        const off = on.map(x => x * 0.6)
        expect(pairedPermutationP(off, on)).toBeLessThan(0.05)
        expect(permutationP(off, on)).toBeGreaterThan(0.05)
    })
})

describe('pairByStimulus', () => {
    test('aligns on the shared ids, in the first arm\'s order', () => {
        const got = pairByStimulus(['b', 'a'], [2, 1], ['a', 'b'], [10, 20])
        expect(got).toEqual({a: [2, 1], b: [20, 10]})
    })

    test('drops a stimulus only one arm has', () => {
        const got = pairByStimulus(['a', 'b'], [1, 2], ['a'], [10])
        expect(got).toEqual({a: [1], b: [10]})
    })

    test('refuses when an arm repeats an id', () => {
        // Pairing the k-th replicate with the k-th is arbitrary. An arbitrary
        // pairing is a measurement nobody made.
        expect(pairByStimulus(['a', 'a'], [1, 2], ['a', 'a'], [3, 4])).toBeNull()
    })

    test('refuses a ragged arm rather than pairing by position', () => {
        expect(pairByStimulus(['a', 'b'], [1], ['a', 'b'], [1, 2])).toBeNull()
    })

    test('no overlap is null, not an empty pairing', () => {
        expect(pairByStimulus(['a'], [1], ['b'], [2])).toBeNull()
    })
})
