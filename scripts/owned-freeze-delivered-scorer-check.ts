/**
 * Metric FP suite for A/B-2's pre-registered scorer (`scoreStaticObservation`),
 * run BEFORE any model time is spent.
 *
 * A/B-2 PASSes only if the treatment arm hits >= 14/20 on this scorer. A scorer
 * that fires on ordinary specs would manufacture that number out of nothing, and
 * one that cannot fire at all would guarantee a FAIL. Both directions are
 * checked here against ground truth that already exists on disk:
 *
 *   every recorded composed spec in the corpus (60). Expected hits: ZERO.
 *   Not one recorded spec observes static asset serving — that is the defect
 *   run 19's final gate reported ("the rendered body is EMPTY"). A hit here is
 *   a false positive and the metric is wrong.
 *
 * This arm stays a hand-run script because it needs an evidence tree under
 * `~/hub` that a CI machine does not have. The two arms that need no corpus —
 * hand-built negatives and positives — moved to
 * `scripts/owned-freeze-delivered-scorer.test.ts` and now run on every
 * `bun test`. A net that only runs when somebody remembers it is a net nobody
 * reads.
 *
 * Run: bun run scripts/owned-freeze-delivered-scorer-check.ts
 *   PASS 0 · FAIL 1 · ABSTAIN 2 (corpus unavailable)
 */
import {existsSync, readFileSync, readdirSync} from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {scoreStaticObservation} from './owned-freeze-delivered-ab.js'
import {readSection} from './ab-corpus.js'

const HUB = path.join(os.homedir(), 'hub')
let failures = 0

/**
 * The one section grammar (`ab-corpus.ts`), with this harness's existing
 * missing-section contract made explicit at the call site instead of hidden in a
 * private regex. Seventeen copies of this function disagreed on case-sensitivity
 * and on whether a missing section returned '' or threw.
 */
const section = (doc: string, name: string): string => readSection(doc, name) ?? ''

// ── arm 1: the real corpus ──────────────────────────────────────────────────
const hits: string[] = []
let scanned = 0
for (const pool of existsSync(HUB) ? readdirSync(HUB) : []) {
    const dir = path.join(HUB, pool, '.pi-tasks')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir).filter(x => /^TASK_\d+\.md$/.test(x)).sort()) {
        const spec = section(readFileSync(path.join(dir, f), 'utf8'), 'spec')
        if (spec.length === 0) continue
        scanned++
        const r = scoreStaticObservation(spec)
        if (r.hit) hits.push(`${pool}/${f.replace(/\.md$/, '')}: ${r.line?.slice(0, 110)}`)
    }
}
console.log(`${scanned} real specs: ${hits.length} hit(s) — ${hits.length === 0 ? 'OK' : 'FALSE POSITIVES'}`)
for (const h of hits) console.log(`  - ${h}`)
if (hits.length > 0) failures++

// Zero specs scanned is the ABSENCE of a measurement, not a clean sweep. Reporting
// "0 hits — OK" off an evidence tree that is not on this machine is the same false
// pass ab-verdict.ts exists to stop, so it exits 2 and says which corpus it wanted.
if (scanned === 0) {
    console.log(
        `\n*** ABSTAIN — THIS RUN PROVED NOTHING ***\n`
            + `No composed spec was found under ${HUB}/*/.pi-tasks, so the scorer was never\n`
            + `exercised against a real spec. Zero hits here is the absence of evidence, not\n`
            + `evidence of zero false positives. The hand-built arms still ran: see\n`
            + `scripts/owned-freeze-delivered-scorer.test.ts (bun test).`
    )
    process.exit(2)
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)

