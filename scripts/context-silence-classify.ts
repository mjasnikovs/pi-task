/**
 * STEP 0 (re-scorable) for the worker:context ZERO-BULLETS thread — the GATE that decides
 * whether a silent worker:context is a genuine LOSS worth a lever, or a legitimate empty
 * answer. It applies the shipped classifier (src/task/context-silence.ts) to every recorded
 * live rep across the three prior runs and reports the split with hand-verifiable evidence
 * plus a Wilson CI on the silent and genuine-loss rates.
 *
 * WHY THIS IS THE MEASUREMENT, NOT A FRESH LIVE RUN. The classification is the real work,
 * and the recorded artifacts already hold everything it needs: the per-rep bullet count
 * (each run's results.json), the emitted CONTEXT text (each trial's result.json), and the
 * loop-degrade banner (each trial's trial.log). 48 reps is a stable base rate, not a 2/24
 * point estimate, and every silent rep's cause is decidable mechanically from what was
 * saved. Re-run it any time the recorded trees are on disk:
 *
 *   bun run scripts/context-silence-classify.ts
 *
 * It reads from ~/tmp/context-attribution-{probe,ab,baseline-extra}. A run whose trees have
 * been cleaned is skipped with a notice, not an error — the numbers below were recorded
 * 2026-07-22 and are reproduced from those trees.
 *
 * RIVAL CHECKED: input-empty. All reps share ONE fixture (mx5 pre-TASK_0027 tree); non-silent
 * reps emit 11–21 bullets from it. So a silent rep did not lack input — it dropped input that
 * was there. The harness asserts this by reporting the productive-rep bullet range alongside.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {classifyContextSilence, wilsonInterval} from '../src/task/context-silence.js'

interface RunSpec {
    /** ~/tmp dir the probe/ab harness wrote its trees into. */
    dir: string
    /** pre-change (belt/braces stripped) vs post-change (shipped lever). */
    arm: 'pre-change' | 'post-change'
}

const RUNS: RunSpec[] = [
    {dir: 'context-attribution-probe', arm: 'pre-change'},
    {dir: 'context-attribution-baseline-extra', arm: 'pre-change'},
    {dir: 'context-attribution-ab', arm: 'post-change'}
]

interface Row {
    run: string
    arm: string
    rep: number
    bullets: number
    cause: string
    genuineLoss: boolean
    evidence: string
}

/** The CONTEXT text a trial emitted — result.json when present, else the empty string. */
function contextOf(trialDir: string): string {
    const rj = path.join(trialDir, 'result.json')
    if (fs.existsSync(rj)) {
        try {
            const d = JSON.parse(fs.readFileSync(rj, 'utf8')) as {context?: string}
            if (typeof d.context === 'string') return d.context
        } catch {
            /* fall through to log-only */
        }
    }
    return ''
}

function logOf(trialDir: string): string {
    const lp = path.join(trialDir, 'trial.log')
    return fs.existsSync(lp) ? fs.readFileSync(lp, 'utf8') : ''
}

function main(): void {
    const rows: Row[] = []
    let skipped = 0

    for (const {dir, arm} of RUNS) {
        const root = path.join(os.homedir(), 'tmp', dir)
        const resultsPath = path.join(root, 'results.json')
        if (!fs.existsSync(resultsPath)) {
            console.log(`  (skipped ${dir}: no results.json on disk)`)
            skipped++
            continue
        }
        const recorded = JSON.parse(fs.readFileSync(resultsPath, 'utf8')) as Array<{
            trial?: number
            rep?: number
            bullets: number
        }>
        for (const r of recorded) {
            const rep = r.trial ?? r.rep ?? 0
            const trialDir = path.join(root, `trial-${rep}`)
            const ctx = contextOf(trialDir)
            // Trust the recorded bullet count (computed at capture from the live section);
            // the classifier re-derives cause from the saved text + log.
            const v = classifyContextSilence(ctx, logOf(trialDir))
            const bullets = r.bullets
            const silent = bullets === 0
            const cause = silent ? v.cause : 'productive'
            rows.push({
                run: dir,
                arm,
                rep,
                bullets,
                cause,
                genuineLoss: silent && v.genuineLoss,
                evidence: silent ? v.evidence : ''
            })
        }
    }

    const productive = rows.filter(r => r.bullets > 0)
    const silent = rows.filter(r => r.bullets === 0)
    const genuine = silent.filter(r => r.genuineLoss)
    const legit = silent.filter(r => !r.genuineLoss)
    const n = rows.length
    const bulletVals = productive.map(r => r.bullets)

    console.log(`\n=== worker:context silent-rep classification (STEP 0 gate) ===`)
    console.log(`reps scored: ${n}  (${skipped} run(s) skipped, trees not on disk)`)
    console.log(
        `productive: ${productive.length}  bullets/rep min=${Math.min(...bulletVals)} `
            + `max=${Math.max(...bulletVals)} — the input the silent reps dropped`
    )

    const sRate = silent.length / n
    const sCI = wilsonInterval(silent.length, n)
    console.log(
        `\nSILENT: ${silent.length}/${n} = ${(sRate * 100).toFixed(1)}% `
            + `[Wilson95 ${(sCI.lo * 100).toFixed(1)}%, ${(sCI.hi * 100).toFixed(1)}%]`
    )

    const gRate = genuine.length / n
    const gCI = wilsonInterval(genuine.length, n)
    console.log(
        `GENUINE-LOSS (the real base rate): ${genuine.length}/${n} = ${(gRate * 100).toFixed(1)}% `
            + `[Wilson95 ${(gCI.lo * 100).toFixed(1)}%, ${(gCI.hi * 100).toFixed(1)}%]`
    )
    console.log(`LEGITIMATELY-EMPTY: ${legit.length}/${n}`)

    const byCause: Record<string, number> = {}
    for (const r of silent) byCause[r.cause] = (byCause[r.cause] ?? 0) + 1
    console.log(`\nsilent causes: ${JSON.stringify(byCause)}`)

    console.log(`\n--- every silent rep, with the substring the verdict keyed on ---`)
    for (const r of silent) {
        console.log(
            `  ${r.run}/trial-${r.rep} [${r.arm}]  ${r.cause}  loss=${r.genuineLoss}`
                + `\n      ${JSON.stringify(r.evidence).slice(0, 200)}`
        )
    }

    const outPath = path.join(os.homedir(), 'tmp', 'context-silence-classification.json')
    fs.writeFileSync(
        outPath,
        JSON.stringify(
            {
                n,
                silent: silent.length,
                genuineLoss: genuine.length,
                legitimatelyEmpty: legit.length,
                silentRate: sRate,
                silentCI: sCI,
                genuineLossRate: gRate,
                genuineLossCI: gCI,
                byCause,
                rows
            },
            null,
            1
        ),
        'utf8'
    )
    console.log(`\nwrote ${outPath}`)

    console.log(
        `\nVERDICT: ${
            genuine.length === silent.length && silent.length > 0
                ? 'SIGNAL — every silent rep is genuine loss; silence == dropped content'
                : legit.length > 0
                  ? `MIXED — ${legit.length} legitimately-empty; genuine-loss rate is the gate`
                  : 'NO silent reps scored'
        }`
    )
}

main()
