/**
 * Re-score the research-fanout A/B's invariants with the three instrument
 * defects corrected, and print the pre-registered result beside each one.
 *
 * Every defect here was recorded in VALIDATION-DEBT.md BEFORE the verdict ran,
 * except the prose defect (recorded immediately after, once the symbols were
 * inspected). None of them is a threshold re-tuned to taste; each is a case
 * where the metric provably does not measure what its name says:
 *
 *   D1 WITNESSED GATE      `witnessed` gates metric 1 only. A fixture that never
 *                          fanned out still scores metrics 2 and 3 — TASK_0022's
 *                          baseline made ONE project lookup and still set the
 *                          wall-clock and quality bar for the treatment.
 *   D2 ABSOLUTE vs RATE    Quality compares absolute ungrounded COUNTS. A
 *                          baseline that degraded to 6 symbols is then nearly
 *                          unbeatable: TASK_0021 improves 16.7% → 5.5% by rate
 *                          and still "regresses" 1.0 → 3.5 by count.
 *   D3 PROSE AS SYMBOLS    The entry parser reads the model's preamble as an
 *                          entry ("Now I have all the information needed. Here
 *                          is the APIS section:") and scores Now/information/
 *                          needed/Here/APIS as ungrounded API symbols. Present
 *                          in BOTH arms. See rescore-ungrounded.ts.
 *
 * THIS CANNOT SHIP THE LEVER. A metric corrected after seeing the verdict it
 * would change is not a verdict — it is a reason to fix the instrument and RUN
 * THE ARM AGAIN. Output is labelled accordingly and the recorded FAIL stands.
 *
 *   bun run scripts/rescore-invariants.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    groundEntries,
    parseApisEntries,
    parseTrajectory,
    readTouchedFiles,
    type GroundingCorpus
} from './apis-trajectory.js'
import {readTypeOnlyLog} from '../src/workers/typeonly-log.js'
import {isProseLine} from './rescore-ungrounded.js'

const ROOT = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'research-fanout-ab')
)
const HIGH_FANOUT = ['TASK_0017', 'TASK_0019', 'TASK_0020', 'TASK_0021', 'TASK_0022']
const LOW_FANOUT = ['TASK_0001', 'TASK_0003', 'TASK_0004']
/** Same threshold the harness uses for metric 1. */
const WITNESS_LOOKUPS = 10

interface Recorded {
    apisSection: string
    ungroundedSymbols: number
    symbols: number
    entries: number
    withSignature: number
    apisWallMs: number
    projectLookups: number
    workerTimeouts: number
    attempts: number
}

const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
const sd = (xs: number[]): number => {
    if (xs.length < 2) return 0
    const m = mean(xs)
    return Math.sqrt(mean(xs.map(x => (x - m) ** 2)))
}

interface Row extends Recorded {
    arm: string
    taskId: string
    trial: number
    /** D3-corrected ungrounded count, prose entries removed. */
    adjUngrounded: number
    adjSymbols: number
    /** D1: did this trial actually pose the problem the lever addresses? */
    witnessed: boolean
}

function load(arm: string, taskId: string, trial: number): Row | null {
    const file = path.join(ROOT, 'results', arm, `${taskId}-${trial}.json`)
    if (!fs.existsSync(file)) return null
    const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Recorded
    const dir = path.join(ROOT, arm, taskId, `trial-${trial}`)
    const answers = readTypeOnlyLog(read(path.join(dir, 'answers.jsonl')))
    const steps = parseTrajectory(read(path.join(dir, 'trial.log')))
    const join = (rs: typeof answers): string =>
        rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    const corpus: GroundingCorpus = {
        prompt: read(path.join(dir, '.pi-tasks', `${taskId}.md`)),
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: readTouchedFiles(dir, steps)
    }
    const grounded = groundEntries(
        parseApisEntries(rec.apisSection).filter(e => !isProseLine(e)),
        corpus
    )
    return {
        ...rec,
        arm,
        taskId,
        trial,
        adjUngrounded: grounded.reduce((n, g) => n + g.ungrounded.length, 0),
        adjSymbols: grounded.reduce((n, g) => n + g.entry.symbols.length, 0),
        witnessed: rec.projectLookups >= WITNESS_LOOKUPS
    }
}

const all: Row[] = []
for (const arm of ['baseline', 'rescue']) {
    for (const id of [...HIGH_FANOUT, ...LOW_FANOUT]) {
        for (const t of [0, 1]) {
            const r = load(arm, id, t)
            if (r) all.push(r)
        }
    }
}
const of = (arm: string, id: string): Row[] => all.filter(r => r.arm === arm && r.taskId === id)

// ── D1: which fixtures actually posed the problem, in BOTH arms ──────────────
console.log('=== D1 — witnessed status per fixture (>=10 project lookups) ===')
console.log('  fixture      baseline lookups   rescue lookups   both-armed?')
const bothWitnessed: string[] = []
for (const id of HIGH_FANOUT) {
    const b = of('baseline', id)
    const t = of('rescue', id)
    const bw = b.some(r => r.witnessed)
    const tw = t.some(r => r.witnessed)
    if (bw && tw) bothWitnessed.push(id)
    console.log(
        `  ${id.padEnd(12)} ${b.map(r => r.projectLookups).join('/').padEnd(18)}`
            + ` ${t.map(r => r.projectLookups).join('/').padEnd(16)} ${bw && tw ? 'YES' : 'NO'}`
    )
}
console.log(
    `  → scored under D1: ${bothWitnessed.join(', ')}`
        + `\n  → EXCLUDED (never posed the problem in one or both arms): `
        + `${HIGH_FANOUT.filter(id => !bothWitnessed.includes(id)).join(', ') || 'none'}`
)

// ── D2 + D3: quality on corrected counts AND rates, witnessed fixtures only ──
console.log('\n=== D2+D3 — quality, corrected (witnessed fixtures only) ===')
console.log('  fixture      arm       ungrounded(pre)  (prose-corr)   rate%     sig')
const qualityBreaks: string[] = []
for (const id of bothWitnessed) {
    const stat = (arm: string): {pre: number; adj: number; rate: number; sig: number} => {
        const rs = of(arm, id)
        const adj = rs.reduce((n, r) => n + r.adjUngrounded, 0)
        const sym = rs.reduce((n, r) => n + r.adjSymbols, 0)
        return {
            pre: mean(rs.map(r => r.ungroundedSymbols)),
            adj: mean(rs.map(r => r.adjUngrounded)),
            rate: sym === 0 ? 0 : (adj / sym) * 100,
            sig: mean(rs.map(r => r.withSignature))
        }
    }
    const b = stat('baseline')
    const t = stat('rescue')
    for (const [arm, s] of [
        ['baseline', b],
        ['rescue', t]
    ] as const) {
        console.log(
            `  ${id.padEnd(12)} ${arm.padEnd(9)} ${s.pre.toFixed(1).padStart(13)}`
                + ` ${s.adj.toFixed(1).padStart(13)} ${s.rate.toFixed(1).padStart(8)}`
                + ` ${s.sig.toFixed(1).padStart(7)}`
        )
    }
    // D2: compare RATES, with the absolute count as a secondary tripwire only
    // when the rate also worsens.
    if (t.rate > b.rate && t.adj > b.adj) {
        qualityBreaks.push(`${id} ungrounded rate ${b.rate.toFixed(1)}%→${t.rate.toFixed(1)}%`)
    }
    if (t.sig < b.sig) qualityBreaks.push(`${id} signatures ${b.sig.toFixed(1)}→${t.sig.toFixed(1)}`)
}

// ── metric 1 and 2 on the same witnessed set ────────────────────────────────
const bTimeouts = bothWitnessed.flatMap(id => of('baseline', id)).filter(r => r.workerTimeouts > 0)
const tTimeouts = bothWitnessed.flatMap(id => of('rescue', id)).filter(r => r.workerTimeouts > 0)
const bWall = mean(bothWitnessed.flatMap(id => of('baseline', id).map(r => r.apisWallMs)))
const tWall = mean(bothWitnessed.flatMap(id => of('rescue', id).map(r => r.apisWallMs)))

console.log('\n=== corrected invariants (witnessed fixtures only) ===')
console.log(
    `  metric 1 timeouts   baseline ${bTimeouts.length}/${bothWitnessed.flatMap(id => of('baseline', id)).length}`
        + ` → rescue ${tTimeouts.length}/${bothWitnessed.flatMap(id => of('rescue', id)).length}`
)
console.log(
    `  metric 2 wall       ${(bWall / 1000).toFixed(0)}s → ${(tWall / 1000).toFixed(0)}s`
        + `  ${tWall < bWall ? 'HOLDS' : 'BROKEN'}`
)
console.log(
    qualityBreaks.length === 0 ?
        '  metric 3 quality    HOLDS — no witnessed fixture regresses on rate or signatures'
    :   `  metric 3 quality    BROKEN — ${qualityBreaks.join('; ')}`
)

// ── variance, the reason n=2 cannot settle metric 3 ─────────────────────────
console.log('\n=== trial-to-trial variance within the SAME arm (rescue, n=2) ===')
console.log('  fixture      entries      wall(s)      lookups')
for (const id of HIGH_FANOUT) {
    const rs = of('rescue', id)
    if (rs.length < 2) continue
    const e = rs.map(r => r.entries)
    const w = rs.map(r => Math.round(r.apisWallMs / 1000))
    console.log(
        `  ${id.padEnd(12)} ${e.join(' vs ').padEnd(12)} ${w.join(' vs ').padEnd(12)}`
            + ` ${rs.map(r => r.projectLookups).join(' vs ')}`
    )
}
const entrySds = HIGH_FANOUT.map(id => of('rescue', id))
    .filter(rs => rs.length >= 2)
    .map(rs => sd(rs.map(r => r.entries)) / Math.max(1, mean(rs.map(r => r.entries))))
console.log(
    `  mean within-fixture CV for entries: ${(mean(entrySds) * 100).toFixed(0)}%`
        + ` — a between-arm difference smaller than this is not resolvable at n=2`
)

console.log(
    '\nSTATUS: the recorded verdict remains FAIL (exit 1). This re-score is'
        + '\nevidence the instrument was at fault, and therefore grounds to fix it and'
        + '\nRE-RUN the arm — it is not a PASS and must never be recorded as one.'
)
