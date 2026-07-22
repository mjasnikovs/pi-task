/**
 * PROMPT 1 — the combined verdict across every live rep, computed rather than eyeballed.
 *
 * WHY A SEPARATE SCRIPT. PROMPT 1's evidence is spread over four live runs (two baseline,
 * two treatment) because the first A/B was underpowered and had to be extended. Reading a
 * verdict off four logs by hand is exactly how a marginal result gets rounded up. So the
 * arithmetic lives here, with the raw per-run numbers as inputs, and the significance test
 * is Fisher's exact rather than a glance at "0 vs 4".
 *
 * THE POWER PROBLEM THIS EXISTS TO ANSWER. nexxtasks' own PASS criterion — "baseline emits
 * the claim in >= 1 rep AND treatment drives it to 0", 8 reps — is satisfied by a lever
 * that does NOTHING with probability 0.75^8 = 10% at the originally-assumed rate. Measured,
 * the baseline rate is lower still (~17%), so a 0/16 treatment gives p = 0.116. Not
 * evidence. Hence the extended arms.
 *
 * THE SILENT-WORKER CORRECTION. Some reps emit ZERO CONTEXT bullets — worker:context
 * produced nothing. Such a rep CANNOT exhibit the laundering shape, so counting it as a
 * treatment success is a free pass that flatters the lever. Both arms are therefore also
 * scored over PRODUCTIVE reps only (bullets > 0). If the two scorings disagree, the
 * conservative one governs.
 *
 * Run: bun run scripts/prompt1-combined-verdict.ts
 */

/** One live run's tally, transcribed from its log. */
interface Run {
    label: string
    arm: 'baseline' | 'treatment'
    reps: number
    silent: number
    hits: number
}

function lnFact(n: number): number {
    let s = 0
    for (let i = 2; i <= n; i++) s += Math.log(i)
    return s
}
function lnC(n: number, k: number): number {
    if (k < 0 || k > n) return -Infinity
    return lnFact(n) - lnFact(k) - lnFact(n - k)
}
/** One-tailed Fisher: P(baseline hits >= observed | margins fixed) — treatment no better by chance. */
export function fisherOneTail(a: number, b: number, c: number, d: number): number {
    const r1 = a + b
    const r2 = c + d
    const n = r1 + r2
    const k = a + c
    let p = 0
    for (let x = a; x <= Math.min(r1, k); x++) {
        p += Math.exp(lnC(r1, x) + lnC(r2, k - x) - lnC(n, k))
    }
    return p
}

export function summarise(runs: Run[]): {
    baseHits: number
    baseReps: number
    baseProd: number
    treatHits: number
    treatReps: number
    treatProd: number
    pAll: number
    pProductive: number
} {
    const b = runs.filter(r => r.arm === 'baseline')
    const t = runs.filter(r => r.arm === 'treatment')
    const sum = (xs: Run[], f: (r: Run) => number): number => xs.reduce((a, r) => a + f(r), 0)
    const baseHits = sum(b, r => r.hits)
    const baseReps = sum(b, r => r.reps)
    const baseProd = baseReps - sum(b, r => r.silent)
    const treatHits = sum(t, r => r.hits)
    const treatReps = sum(t, r => r.reps)
    const treatProd = treatReps - sum(t, r => r.silent)
    return {
        baseHits,
        baseReps,
        baseProd,
        treatHits,
        treatReps,
        treatProd,
        pAll: fisherOneTail(baseHits, baseReps - baseHits, treatHits, treatReps - treatHits),
        pProductive: fisherOneTail(
            baseHits,
            baseProd - baseHits,
            treatHits,
            treatProd - treatHits
        )
    }
}

// ─── the live runs (transcribe from the logs; keep RUNS the single source of truth) ──────
export const RUNS: Run[] = [
    // pre-change code (no belt, no braces)
    {label: 'live-context-attribution-probe (recorded)', arm: 'baseline', reps: 8, silent: 1, hits: 2},
    {label: 'live-context-attribution-baseline-extra', arm: 'baseline', reps: 16, silent: 1, hits: 2},
    // shipped code (belt + braces)
    {label: 'live-context-attribution-ab (16)', arm: 'treatment', reps: 16, silent: 2, hits: 0},
    {label: 'live-context-attribution-ab (24, extension)', arm: 'treatment', reps: 24, silent: 3, hits: 0}
]

if (import.meta.main) {
    const s = summarise(RUNS)
    console.log('PROMPT 1 — combined live verdict\n')
    for (const r of RUNS) {
        console.log(
            `  ${r.arm.padEnd(9)} ${r.label.padEnd(46)} `
                + `reps=${String(r.reps).padStart(2)} silent=${r.silent} hits=${r.hits}`
        )
    }
    const pctA = ((100 * s.baseHits) / Math.max(1, s.baseReps)).toFixed(1)
    const pctP = ((100 * s.baseHits) / Math.max(1, s.baseProd)).toFixed(1)
    console.log(
        `\n  BASELINE  ${s.baseHits}/${s.baseReps} (${pctA}%)   productive-only `
            + `${s.baseHits}/${s.baseProd} (${pctP}%)`
    )
    console.log(`  TREATMENT ${s.treatHits}/${s.treatReps}   productive-only ${s.treatHits}/${s.treatProd}`)
    console.log(`\n  Fisher one-tailed, all reps        p = ${s.pAll.toFixed(4)}`)
    console.log(`  Fisher one-tailed, productive only p = ${s.pProductive.toFixed(4)}`)
    const worst = Math.max(s.pAll, s.pProductive)
    console.log(
        `\n  VERDICT: ${
            worst < 0.05 ?
                `SIGNIFICANT at p<0.05 (worst-case p=${worst.toFixed(4)}) — the reduction is real`
            :   `NOT SIGNIFICANT (worst-case p=${worst.toFixed(4)}) — more reps needed; do NOT claim a fix`
        }`
    )
    console.log(
        '\n  Scope: END-TO-END lever (prompt rule + post-check) vs pre-change code.\n'
            + '  The post-check IS exercised live: across 40 treatment reps the gate demoted 2\n'
            + '  bullets (both in the 24-rep extension), and the same-process arms recorded\n'
            + '  ungated 2/24 -> gated 0/24. One demoted bullet is the run-15 fatal claim itself:\n'
            + '  "the EXTERNAL CONTEXT block for Hono RPC shows hc<AppType>(\x27/api\x27) with a\n'
            + '  relative path works for same-origin calls". Belt suppresses most; braces catch\n'
            + '  the rest.'
    )
}
