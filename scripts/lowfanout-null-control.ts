/**
 * NEGATIVE CONTROL for `inv-low-fanout-untouched`.
 *
 * The n=6 verdict (VALIDATION-DEBT.md, "ROUND 3") FAILed on this invariant:
 * TASK_0001 entries 6.0→1.8 and TASK_0003 6.8→5.0 between the baseline and the
 * progress arm. But the lever cannot reach a control fixture — across all 18
 * control trials in both arms `budgetRefusals=0`, `attempts=1`, and every wall
 * clock sat under a 240s cap that never fired, while the arm's single env var
 * only pushes an abort deadline OUTWARD. The two arms ran an identical code path
 * on every one of those trials, so the invariant broke on a lever that did
 * nothing.
 *
 * The tempting response — relax `ENTRY_FLOOR` — is moving a threshold after
 * seeing the number it would change, which this project has ruled out twice.
 *
 * So instead: measure the invariant's FALSE-BREAK RATE on data that contains no
 * treatment at all. Run the baseline arm 12x over the three control fixtures,
 * then score every 6-vs-6 split of that pure-baseline corpus through the SAME
 * `scoreLowFanout`. Both halves are the same arm, so every break is a false one
 * by construction, and the rate is the invariant's false-positive rate at n=6.
 * No treatment data is involved, so nothing here can be tuned to the verdict.
 *
 * PRE-REGISTERED, before any data existed:
 *   - splits are ALL C(12,6) = 924 of them — 462 distinct 6/6 partitions, each
 *     scored in both orientations because the invariant is directional and an
 *     arm label is arbitrary. Exhaustive, so there is no seed to choose and no
 *     split to pick after the fact;
 *   - the statistic is the share of splits in which `scoreLowFanout` reports at
 *     least one break;
 *   - reading: >=5% false-break rate means the invariant as written cannot
 *     support a FAIL at n=6 and the round-3 result is uninformative about the
 *     lever. <5% means the break was real and the lever has a case to answer
 *     that this script does not settle.
 *
 * Deterministic and offline: it re-scores trial JSONs already on disk.
 *
 *   AB_DIR=~/tmp/research-fanout-ab-nullctl bun run scripts/lowfanout-null-control.ts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {scoreLowFanout, type TrialResult} from './live-research-fanout-budget-ab.js'

const ROOT = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'research-fanout-ab-nullctl')
)
const HALF = 6

/** Same exclusion the real scorer applies: a thrown trial measures nothing. */
const usable = (r: TrialResult): boolean => r.error === undefined

function loadBaseline(): TrialResult[] {
    const dir = path.join(ROOT, 'results', 'baseline')
    if (!fs.existsSync(dir)) {
        console.error(`no corpus at ${dir} — run the baseline arm first`)
        process.exit(2)
    }
    return fs
        .readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TrialResult)
        .filter(usable)
}

/** All C(n,k) index combinations. */
function combinations(n: number, k: number): number[][] {
    const out: number[][] = []
    const rec = (start: number, chosen: number[]): void => {
        if (chosen.length === k) {
            out.push([...chosen])
            return
        }
        for (let i = start; i < n; i++) rec(i + 1, [...chosen, i])
    }
    rec(0, [])
    return out
}

function main(): void {
    const all = loadBaseline()
    const fixtures = [...new Set(all.map(r => r.taskId))].sort()
    console.log(`=== inv-low-fanout-untouched — NEGATIVE CONTROL (baseline vs baseline)`)
    console.log(`  corpus ${ROOT}`)
    console.log(`  ${all.length} usable trial(s) over ${fixtures.length} fixture(s): ${fixtures.join(' ')}`)

    // Every fixture must carry exactly 2*HALF trials, or the split is not a
    // like-for-like partition and the rate would be measuring the imbalance.
    const short = fixtures.filter(id => all.filter(r => r.taskId === id).length !== HALF * 2)
    if (short.length > 0) {
        for (const id of short) {
            console.error(
                `  ${id}: ${all.filter(r => r.taskId === id).length} trial(s), need ${HALF * 2}`
            )
        }
        console.error('INCOMPLETE — cannot render a false-break rate on a partial corpus')
        process.exit(2)
    }

    const splits = combinations(HALF * 2, HALF)
    // Each partition appears twice (A|B and B|A). The invariant is directional —
    // it only fires when the SECOND half is lower — so both orientations are
    // scored, which is exactly what an arbitrary arm labelling would produce.
    let broke = 0
    const tally = new Map<string, number>()
    for (const idx of splits) {
        const a: TrialResult[] = []
        const b: TrialResult[] = []
        for (const id of fixtures) {
            const rows = all
                .filter(r => r.taskId === id)
                .sort((x, y) => x.trial - y.trial)
            rows.forEach((r, i) => (idx.includes(i) ? a : b).push(r))
        }
        const {lowBreaks} = scoreLowFanout(a, b)
        if (lowBreaks.length > 0) {
            broke++
            for (const br of lowBreaks) {
                const key = br.replace(/[\d.]+→[\d.]+/, '…').replace(/\d+×/, 'N×')
                tally.set(key, (tally.get(key) ?? 0) + 1)
            }
        }
    }

    const rate = (broke / splits.length) * 100
    console.log(`\n  ${splits.length} pure-baseline 6-vs-6 splits scored`)
    console.log(`  splits with >=1 break: ${broke}/${splits.length} = ${rate.toFixed(1)}%`)
    console.log(`\n  break shapes (every one is a FALSE break — same arm on both sides):`)
    for (const [k, v] of [...tally].sort((x, y) => y[1] - x[1])) {
        console.log(`    ${String(v).padStart(4)}x  ${k}`)
    }

    console.log(
        `\n  VERDICT: ${
            rate >= 5 ?
                `inv-low-fanout-untouched breaks on ${rate.toFixed(1)}% of splits of a corpus`
                + ` with NO treatment in it. At n=6 it cannot support a FAIL, and the`
                + ` round-3 break is uninformative about the lever.`
            :   `inv-low-fanout-untouched breaks on only ${rate.toFixed(1)}% of null splits.`
                + ` The round-3 break is not explained by variance and the lever has a`
                + ` case to answer.`
        }`
    )
    // 0 = invariant is sound at n=6, 1 = invariant is a noise detector. Neither
    // is a verdict on the lever; this scores the INSTRUMENT.
    process.exit(rate >= 5 ? 1 : 0)
}

main()
