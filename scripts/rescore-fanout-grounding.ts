/**
 * Re-score a recorded fan-out A/B corpus with the PROJECT-SOURCE channel added,
 * without spending any model time.
 *
 * `ungroundedSymbols` is computed at TRIAL time and frozen into the result JSON,
 * so adding a grounding channel changes nothing about trials already on disk.
 * This walks each trial's preserved artifacts, recomputes grounding with and
 * without `projectTree`, prints both, and (with a target dir) writes a rescored
 * copy of the corpus that `score` can then run over unchanged.
 *
 *   bun run scripts/rescore-fanout-grounding.ts [--write <dir>]
 *   AB_DIR=<dir> bun run scripts/live-research-fanout-budget-ab.ts score progress
 *
 * ONE THING IT CANNOT REPRODUCE, and it matters in the honest direction. The
 * live harness grounds against the ASSEMBLED worker prompt, captured off the
 * child's stdin (capturingSpawn); that capture is in-memory and is not persisted,
 * so a re-score can only offer the seeded task file. Every count here is
 * therefore an OVER-estimate of what the live scorer would have produced — a
 * symbol the worker got from orientation and never re-read still reads as
 * ungrounded unless the project source carries it. Read the numbers as an upper
 * bound on fabrication, not as what the harness would print live.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    groundEntriesStrict,
    parseApisEntries,
    parseTrajectory,
    readTouchedFiles,
    type GroundingCorpus
} from './apis-trajectory.js'
import {checkpointSourceText} from './run15-fixture-tree.js'
import {readTypeOnlyLog} from '../src/workers/typeonly-log.js'
import type {TrialResult} from './live-research-fanout-budget-ab.js'

const ROOT = path.resolve(process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'research-fanout-ab'))
const writeArg = process.argv.indexOf('--write')
const WRITE = writeArg > 0 ? path.resolve(process.argv[writeArg + 1] ?? '') : ''

const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

function corpusFor(dir: string, taskId: string, commit: string, withTree: boolean): GroundingCorpus {
    const answers = readTypeOnlyLog(read(path.join(dir, 'answers.jsonl')))
    const steps = parseTrajectory(read(path.join(dir, 'trial.log')))
    const join = (rs: typeof answers): string =>
        rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt: read(path.join(dir, '.pi-tasks', `${taskId}.md`)),
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: readTouchedFiles(dir, steps),
        ...(withTree ? {projectTree: checkpointSourceText(commit)} : {})
    }
}

interface Rescored {
    rec: TrialResult
    /** Recomputed without the project-source channel — the re-score's own control. */
    traceOnly: number
    /** Recomputed with it. */
    withTree: number
    symbols: number
    residue: string[]
}

function rescore(arm: string, file: string): Rescored | null {
    const rec = JSON.parse(read(path.join(ROOT, 'results', arm, file))) as TrialResult
    const dir = path.join(ROOT, arm, rec.taskId, `trial-${rec.trial}`)
    if (!fs.existsSync(dir)) return null
    const entries = parseApisEntries(rec.apisSection)
    const before = groundEntriesStrict(entries, corpusFor(dir, rec.taskId, rec.commit, false))
    const after = groundEntriesStrict(entries, corpusFor(dir, rec.taskId, rec.commit, true))
    return {
        rec,
        traceOnly: before.reduce((n, g) => n + g.ungrounded.length, 0),
        withTree: after.reduce((n, g) => n + g.ungrounded.length, 0),
        symbols: after.reduce((n, g) => n + g.entry.symbols.length, 0),
        residue: [...new Set(after.flatMap(g => g.ungrounded))]
    }
}

const arms = fs
    .readdirSync(path.join(ROOT, 'results'))
    .filter(a => fs.statSync(path.join(ROOT, 'results', a)).isDirectory())

console.log(`=== ${ROOT}`)
console.log('  arm        fixture      n   recorded   trace-only   +projectTree   symbols')
const all: Rescored[] = []
for (const arm of arms) {
    const files = fs
        .readdirSync(path.join(ROOT, 'results', arm))
        .filter(f => f.endsWith('.json'))
        .sort()
    const rows = files.map(f => rescore(arm, f)).filter((r): r is Rescored => r !== null)
    all.push(...rows)
    for (const id of [...new Set(rows.map(r => r.rec.taskId))].sort()) {
        const rs = rows.filter(r => r.rec.taskId === id)
        console.log(
            `  ${arm.padEnd(10)} ${id.padEnd(11)} ${String(rs.length).padStart(2)}`
                + `   ${mean(rs.map(r => r.rec.ungroundedSymbols))
                    .toFixed(1)
                    .padStart(7)}`
                + `   ${mean(rs.map(r => r.traceOnly))
                    .toFixed(1)
                    .padStart(10)}`
                + `   ${mean(rs.map(r => r.withTree))
                    .toFixed(1)
                    .padStart(12)}`
                + `   ${mean(rs.map(r => r.symbols))
                    .toFixed(1)
                    .padStart(7)}`
        )
    }
}

console.log('\n=== residue after the project-source channel (symbols still ungrounded)')
for (const arm of arms) {
    const rows = all.filter(r => r.rec.arm === arm)
    const residue = [...new Set(rows.flatMap(r => r.residue))]
    console.log(`  ${arm.padEnd(10)} ${residue.length === 0 ? '(none)' : residue.join(' ')}`)
}

if (WRITE.length > 0) {
    for (const r of all) {
        const dir = path.join(WRITE, 'results', r.rec.arm)
        fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(
            path.join(dir, `${r.rec.taskId}-${r.rec.trial}.json`),
            JSON.stringify({...r.rec, ungroundedSymbols: r.withTree, symbols: r.symbols}, null, 2)
        )
    }
    console.log(
        `\nwrote ${all.length} rescored trial(s) to ${WRITE}/results.`
            + `\nNOTE: rescored, NOT re-run — the prompt channel is missing (see the header),`
            + `\nso these counts bound fabrication from ABOVE. The pre-registered corpus at`
            + `\n${ROOT} is untouched.`
    )
}
