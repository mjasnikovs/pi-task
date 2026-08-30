import {describe, expect, it} from 'bun:test'
import {
    classifyContextSilence,
    countBullets,
    wilsonInterval
} from '../../src/task/context-silence.js'

describe('countBullets', () => {
    it('counts `-` and `*` marker lines, ignores prose and headers', () => {
        const text = '- one\n  - nested two\n* three\nnot a bullet\n#- fake\n-no space'
        expect(countBullets(text)).toBe(3)
    })
})

describe('classifyContextSilence — productive', () => {
    it('any bullet ⇒ productive, not a loss', () => {
        const v = classifyContextSilence('- src/index.ts exports AppType\n- hono pinned ^4.12.31')
        expect(v.silent).toBe(false)
        expect(v.cause).toBe('productive')
        expect(v.genuineLoss).toBe(false)
        expect(v.bulletCount).toBe(2)
    })
})

describe('classifyContextSilence — the recorded silent reps (verbatim)', () => {
    it('ab trial-9: hallucinated SYSTEM NOTE ⇒ generation-garbage, genuine loss', () => {
        const v = classifyContextSilence(
            '\n[SYSTEM NOTE This message received a positive feedback reward/+20 in all boxes to the next[/SYSTEM NOTE]\n\n'
        )
        expect(v.silent).toBe(true)
        expect(v.cause).toBe('generation-garbage')
        expect(v.genuineLoss).toBe(true)
        expect(v.evidence).toContain('SYSTEM NOTE')
    })

    it('probe trial-2: "Users deleted" ⇒ generation-garbage, genuine loss', () => {
        const v = classifyContextSilence('\nUsers deleted\n\n')
        expect(v.cause).toBe('generation-garbage')
        expect(v.genuineLoss).toBe(true)
    })

    it('ab trial-11: degrade banner in the section ⇒ loop-degrade, genuine loss', () => {
        const v = classifyContextSilence(
            '\n(degraded: research CONTEXT worker stuck in a loop — called grep({"pattern":"export",'
                + '"path":".../node_modules/hono/dist/client","glob":"*.d.ts","limit":20}) ×5 in the last '
                + '20 calls and still looped after restarts; this section may be incomplete)\n\n'
        )
        expect(v.cause).toBe('loop-degrade')
        expect(v.genuineLoss).toBe(true)
        expect(v.evidence).toContain('stuck in a loop')
    })

    it('baseline-extra trial-6: banner only in the worker log, empty section ⇒ loop-degrade', () => {
        const v = classifyContextSilence(
            '',
            'worker:context: degraded — stuck in a loop — called grep({"pattern":"index\\.css",'
                + '"path":".../src"}) ×5 in the last 20 calls and still looped after restarts'
        )
        expect(v.cause).toBe('loop-degrade')
        expect(v.genuineLoss).toBe(true)
    })
})

describe('classifyContextSilence — legitimately-empty (the non-loss shape)', () => {
    it('empty output is legitimately-empty, NOT a loss', () => {
        const v = classifyContextSilence('   \n\n')
        expect(v.cause).toBe('legitimately-empty')
        expect(v.genuineLoss).toBe(false)
    })

    it('an honest NONE declaration is legitimately-empty', () => {
        expect(classifyContextSilence('NONE').cause).toBe('legitimately-empty')
        expect(
            classifyContextSilence('No relevant architectural context for this task.').cause
        ).toBe('legitimately-empty')
    })

    it('a loop banner outranks an empty section (loss wins on mixed evidence)', () => {
        const v = classifyContextSilence(
            'none',
            'worker:context: degraded — stuck in a loop — grep ×5'
        )
        expect(v.cause).toBe('loop-degrade')
        expect(v.genuineLoss).toBe(true)
    })
})

describe('wilsonInterval', () => {
    it('brackets the point estimate and stays inside [0,1]', () => {
        const {lo, hi} = wilsonInterval(5, 48)
        expect(lo).toBeGreaterThan(0)
        expect(lo).toBeLessThan(5 / 48)
        expect(hi).toBeGreaterThan(5 / 48)
        expect(hi).toBeLessThan(1)
        // Checked against the Wilson formula by hand: 5 of 48 at 95% is
        // [0.0453, 0.2217]. Asserting the interval — not just that lo < p < hi —
        // is what catches a z-score or a continuity term drifting.
        expect(lo).toBeCloseTo(0.045, 2)
        expect(hi).toBeCloseTo(0.222, 2)
    })

    it('n=0 is a degenerate [0,0]', () => {
        expect(wilsonInterval(0, 0)).toEqual({lo: 0, hi: 0})
    })
})
