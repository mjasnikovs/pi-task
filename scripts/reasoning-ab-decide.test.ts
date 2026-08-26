import {describe, expect, test} from 'bun:test'
import {REASONING_ON_LEVEL} from '../src/config/reasoning.js'
import {type ArmStats, decide} from './reasoning-ab-decide.js'

/**
 * An arm with a flat timing profile, so only the counts under test vary.
 *
 * Deliberately supplies NO `stimuliOfUsable`, so these cases exercise the
 * unpaired clock path. {@link pairedArm} covers the paired one.
 */
const arm = (n: number, usable: number, dead: number, ms: number): ArmStats => ({
    n,
    nonTerminating: dead,
    usable,
    msOfUsable: Array.from({length: usable}, () => ms)
})

/**
 * An arm that names its stimuli, so the ladder pairs.
 *
 * `usable` is `n` minus `dead`, which keeps the quality axis off its ceiling
 * whenever `dead > 0` — the saturation guard would otherwise bar rung 2 and
 * these cases would test nothing.
 */
const pairedArm = (ms: readonly number[], dead = 0): ArmStats => ({
    n: ms.length + dead,
    nonTerminating: dead,
    usable: ms.length,
    msOfUsable: [...ms],
    stimuliOfUsable: ms.map((_, i) => `S${i}`)
})

describe('the verdict is always one of the two levels measured', () => {
    // The rule this file exists to hold: `inherit` is not on the ballot. A tie
    // used to return it, which made "we did not find out" indistinguishable
    // from "we did not measure", and left the table unable to say which.
    const cases: ArmStats[][] = [
        [arm(20, 18, 2, 100), arm(20, 19, 1, 100)],
        [arm(20, 20, 0, 100), arm(20, 2, 18, 100)],
        [arm(20, 2, 18, 100), arm(20, 20, 0, 100)],
        [arm(20, 20, 0, 10), arm(20, 20, 0, 400)],
        [arm(20, 0, 20, 0), arm(20, 0, 20, 0)]
    ]
    for (const [off, on] of cases) {
        test(`off ${off!.usable}/${off!.n} vs on ${on!.usable}/${on!.n}`, () => {
            const {winner, rung} = decide(off!, on!)
            expect(['off', REASONING_ON_LEVEL]).toContain(winner)
            expect([1, 2, 3]).toContain(rung)
        })
    }
})

describe('rung 1 — a significant quality difference decides, either way', () => {
    test('off answering far less often loses', () => {
        const {winner, rung} = decide(arm(20, 2, 18, 100), arm(20, 20, 0, 100))
        expect(winner).toBe(REASONING_ON_LEVEL)
        expect(rung).toBe(1)
    })

    test('the on arm answering far less often loses too', () => {
        // Symmetry is the property, not a nicety: a ladder that can only ever
        // demote `off` would report `off` losses it measured and hide the wins.
        const {winner, rung} = decide(arm(20, 20, 0, 100), arm(20, 2, 18, 100))
        expect(winner).toBe('off')
        expect(rung).toBe(1)
    })

    test('quality outranks the clock', () => {
        // off is 40x faster AND significantly worse. Speed must not buy it the
        // cell — a gate that returns nothing quickly has not gated anything.
        const {winner, rung} = decide(arm(20, 2, 18, 10), arm(20, 20, 0, 400))
        expect(winner).toBe(REASONING_ON_LEVEL)
        expect(rung).toBe(1)
    })
})

describe('rung 2 — with quality level, the clock decides', () => {
    test('the faster arm wins when it is off', () => {
        const {winner, rung} = decide(arm(20, 19, 1, 10), arm(20, 19, 1, 400))
        expect(winner).toBe('off')
        expect(rung).toBe(2)
    })

    test('the faster arm wins when it is the on arm', () => {
        const {winner, rung} = decide(arm(20, 19, 1, 400), arm(20, 19, 1, 10))
        expect(winner).toBe(REASONING_ON_LEVEL)
        expect(rung).toBe(2)
    })
})

describe('the clock test matches the design', () => {
    // THE CASE THAT MOTIVATED THE PAIRED TEST. Each stimulus is run once per
    // arm and off is faster on every one of them, but the stimuli span two
    // orders of magnitude. Pooled, that spread swamps the arm effect and the
    // unpaired test cannot see a difference that is present in all ten pairs.
    const slow = [1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, 512_000]
    const fast = slow.map(x => x * 0.6)

    test('unpaired, the stimulus spread hides an effect present in every pair', () => {
        const {rung} = decide(
            {...pairedArm(fast, 1), stimuliOfUsable: undefined},
            {...pairedArm(slow, 1), stimuliOfUsable: undefined}
        )
        expect(rung).toBe(3)
    })

    test('paired, the same numbers reach rung 2', () => {
        const {winner, rung, lines} = decide(pairedArm(fast, 1), pairedArm(slow, 1))
        expect(winner).toBe('off')
        expect(rung).toBe(2)
        expect(lines.join(' ')).toContain('paired, 10 matched stimuli')
    })

    test('a stimulus repeated within an arm is not pairable, so it falls back', () => {
        // `planning` runs one fixture ten times. Pairing the k-th replicate
        // with the k-th is arbitrary, and an arbitrary pairing is a made-up
        // measurement — the ladder must say so rather than invent one.
        const rep = (ms: readonly number[]): ArmStats => ({
            ...pairedArm(ms, 1),
            stimuliOfUsable: ms.map(() => 'one-fixture')
        })
        const {lines} = decide(rep(fast), rep(slow))
        expect(lines.join(' ')).toContain('unpaired, arms pooled')
    })

    test('the direction comes from the pairs, not from the means', () => {
        // off wins nine pairs and loses one catastrophically, so its ARITHMETIC
        // mean is the worse of the two. A verdict read off the means would name
        // the wrong arm while quoting a p-value that came from the pairs.
        const offMs = [10, 10, 10, 10, 10, 10, 10, 10, 10, 100_000]
        const onMs = [40, 40, 40, 40, 40, 40, 40, 40, 40, 50_000]
        // Arithmetic means: off 10009ms, medium 5036ms — the means name medium.
        expect(offMs.reduce((a, b) => a + b) > onMs.reduce((a, b) => a + b)).toBe(true)
        const {winner, rung} = decide(pairedArm(offMs, 1), pairedArm(onMs, 1))
        expect(winner).toBe('off')
        expect(rung).toBe(2)
    })
})

describe('a saturated quality axis bars the clock from deciding', () => {
    // BLOCKER 3, encoded. Both arms at the scorer's ceiling means the axis had
    // no headroom to separate them with, so "quality is level" is an absence of
    // measurement, not a null result. Promoting the clock there ships the
    // cheaper arm on a question nobody asked.
    test('both arms perfect cannot reach rung 2 however large the gap', () => {
        const {rung, saturated, lines} = decide(arm(20, 20, 0, 10), arm(20, 20, 0, 4000))
        expect(saturated).toBe(true)
        expect(rung).toBe(3)
        expect(lines.join(' ')).toContain('SATURATED')
        expect(lines.join(' ')).toContain('DO NOT WRITE A CELL FROM THIS')
    })

    test('both arms at zero is saturated too — a floor measures as little', () => {
        const {rung, saturated} = decide(arm(20, 0, 20, 0), arm(20, 0, 20, 0))
        expect(saturated).toBe(true)
        expect(rung).toBe(3)
    })

    test('one failure in each arm is enough headroom to decide on', () => {
        const {rung, saturated} = decide(arm(20, 19, 1, 10), arm(20, 19, 1, 4000))
        expect(saturated).toBe(false)
        expect(rung).toBe(2)
    })
})

describe('rung 3 — a stated prior, and it says so out loud', () => {
    test('nothing separating the arms falls to off', () => {
        const {winner, rung, lines} = decide(arm(20, 18, 2, 100), arm(20, 19, 1, 100))
        expect(winner).toBe('off')
        expect(rung).toBe(3)
        // A reader who cannot tell rung 3 from rung 1 will read a decision as a
        // finding, so the disclaimer is part of the output, not decoration.
        expect(lines.join(' ')).toContain('PRIOR NOT EVIDENCE')
    })

    test('rungs 1 and 2 never carry that disclaimer', () => {
        for (const [off, on] of [
            [arm(20, 2, 18, 100), arm(20, 20, 0, 100)],
            [arm(20, 19, 1, 10), arm(20, 19, 1, 400)]
        ]) {
            expect(decide(off!, on!).lines.join(' ')).not.toContain('PRIOR NOT EVIDENCE')
        }
    })
})
