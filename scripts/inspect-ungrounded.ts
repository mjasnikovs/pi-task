/**
 * Name the symbols an A/B trial failed to ground, and say WHY each one failed.
 *
 * `inv-quality-not-worse` reports a COUNT — "TASK_0019 ungrounded 0.0→2.5" — which
 * is enough to fail an arm and not nearly enough to fix one. A count cannot tell
 * a fabricated signature (the failure the guard exists to catch) from a real
 * symbol the grounding corpus simply never saw (a measurement artifact). Those
 * two want opposite responses, so this prints the symbols themselves alongside
 * which corpus slice each was and wasn't found in.
 *
 * Reads only what the trial already wrote to disk — no model time.
 *
 *   bun run scripts/inspect-ungrounded.ts <arm> <TASK_ID> [trial]
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

const ROOT = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'research-fanout-ab')
)

const [arm, taskId, trialArg] = process.argv.slice(2)
if (!arm || !taskId) {
    console.error('usage: bun run scripts/inspect-ungrounded.ts <arm> <TASK_ID> [trial]')
    process.exit(2)
}
const trial = Number(trialArg ?? '0')

const resultFile = path.join(ROOT, 'results', arm, `${taskId}-${trial}.json`)
const dir = path.join(ROOT, arm, taskId, `trial-${trial}`)
if (!fs.existsSync(resultFile)) {
    console.error(`no recorded trial at ${resultFile}`)
    process.exit(2)
}

interface Recorded {
    apisSection: string
    ungroundedSymbols: number
    symbols: number
    projectLookups: number
    attempts: number
}
const rec = JSON.parse(fs.readFileSync(resultFile, 'utf8')) as Recorded

const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const log = read(path.join(dir, 'trial.log'))
const answers = readTypeOnlyLog(read(path.join(dir, 'answers.jsonl')))
const steps = parseTrajectory(log)

// Same corpus the harness scores against, rebuilt from the trial's own artifacts
// (must match corpusOf in live-research-fanout-budget-ab.ts exactly, or this
// would explain a break the scorer never saw).
const join = (rs: typeof answers): string =>
    rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
const corpus: GroundingCorpus = {
    prompt: read(path.join(dir, '.pi-tasks', `${taskId}.md`)),
    docsProject: join(answers.filter(a => a.module === '.')),
    docsPackage: join(answers.filter(a => a.module !== '.')),
    reads: readTouchedFiles(dir, steps)
}

const entries = parseApisEntries(rec.apisSection)
const grounded = groundEntries(entries, corpus)

console.log(
    `${arm}/${taskId} trial ${trial} — attempts=${rec.attempts} lookups=${rec.projectLookups}`
)
console.log(`recorded: ${rec.ungroundedSymbols} ungrounded of ${rec.symbols} symbols\n`)

const where = (sym: string): string => {
    const hits = (['prompt', 'docsProject', 'docsPackage', 'reads'] as const).filter(k =>
        corpus[k].includes(sym)
    )
    return hits.length === 0 ? 'NOWHERE in corpus' : `found in: ${hits.join(', ')}`
}

for (const g of grounded) {
    if (g.ungrounded.length === 0) continue
    console.log(`  entry: ${g.entry.name}`)
    for (const sym of g.ungrounded) console.log(`    ✗ ${sym}  — ${where(sym)}`)
    console.log(`    rest: ${g.entry.rest.slice(0, 200)}`)
    console.log()
}

console.log(
    `corpus sizes: docsProject=${corpus.docsProject.length}B`
        + ` docsPackage=${corpus.docsPackage.length}B reads=${corpus.reads.length}B`
        + ` prompt=${corpus.prompt.length}B`
)
