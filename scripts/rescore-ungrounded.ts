/**
 * Re-score the research-fanout A/B's ungrounded metric with its known defects
 * removed — and print the PRE-REGISTERED number next to it, always.
 *
 * `inv-quality-not-worse` failed the RESCUE arm on ungrounded symbols. Inspecting
 * the symbols themselves (scripts/inspect-ungrounded.ts) shows almost none are
 * fabricated signatures. Three things are being counted instead:
 *
 *  1. PROSE. The model writes a preamble — "Now I have all the information
 *     needed. Here is the APIS section:" — and the line parser treats it as an
 *     entry, yielding "symbols" Now/information/needed/Here/APIS. This is the
 *     bulk of it, and it lands in BOTH arms (baseline TASK_0017 and TASK_0020
 *     carry the identical artifact; baseline TASK_0021's single ungrounded
 *     symbol is the word `degraded` from its own degrade marker).
 *
 *     apis-trajectory.ts declines to stop-list prose on the stated grounds that
 *     "a prose word in an entry name matches the prompt text and therefore
 *     always scores GROUNDED". That holds when `corpus.prompt` is what its own
 *     doc comment describes — the ASSEMBLED worker:apis prompt. This harness can
 *     only supply the 1.9KB seeded task file, so the assumption does not hold
 *     here and prose falls through as ungrounded.
 *
 *  2. PLATFORM BUILTINS. `URL.createObjectURL`, `URL.revokeObjectURL`,
 *     playwright's `PageAssertions`. Real APIs that no project-source or package
 *     docs channel will ever contain.
 *
 *  3. SYMBOLS THE TASK ASKS THE WORKER TO CREATE. TASK_0022's `AdminRoutes`,
 *     `AdminUsersGet`, `AdminBanPost` are the types the task exists to add;
 *     their absence from a corpus of EXISTING code is correctness, not drift.
 *
 * Only (1) is corrected here, because only (1) is decidable without a judgement
 * call about what counts as a platform API. (2) and (3) are reported as residue.
 *
 * This does NOT replace the recorded verdict. The pre-registered scorer stands;
 * this is the correction reported beside it.
 *
 *   bun run scripts/rescore-ungrounded.ts
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
    groundEntries,
    parseApisEntries,
    parseTrajectory,
    readTouchedFiles,
    type ApisEntry,
    type GroundingCorpus
} from './apis-trajectory.js'
import {readTypeOnlyLog} from '../src/workers/typeonly-log.js'

const ROOT = path.resolve(
    process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'research-fanout-ab')
)
const HIGH_FANOUT = ['TASK_0017', 'TASK_0019', 'TASK_0020', 'TASK_0021', 'TASK_0022']

/**
 * Is this parsed "entry" actually a sentence the model wrote around its section?
 *
 * Deliberately conservative — it must never drop a real entry, so every test is
 * a property no API-symbol line has: a name that ends in sentence punctuation,
 * or reads as running English. A real entry name is a symbol or a dotted path,
 * optionally backticked; it does not end in `.` or `:` and does not contain a
 * first-person pronoun.
 */
export function isProseLine(entry: ApisEntry): boolean {
    const n = entry.name.trim()
    if (/[.:]$/.test(n) && !/`/.test(n)) return true
    if (/\b(?:I|we|let|now|here|good|okay)\b/i.test(n) && n.split(/\s+/).length >= 4) return true
    // The degrade marker, which is not an entry either.
    if (/^\(?degraded/i.test(n)) return true
    return false
}

interface Recorded {
    apisSection: string
    ungroundedSymbols: number
    symbols: number
    taskId: string
    trial: number
}

const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

function rescore(
    arm: string,
    taskId: string,
    trial: number
): {pre: number; adj: number; symbols: number; residue: string[]} | null {
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
    const entries = parseApisEntries(rec.apisSection).filter(e => !isProseLine(e))
    const grounded = groundEntries(entries, corpus)
    const residue = grounded.flatMap(g => g.ungrounded)
    return {
        pre: rec.ungroundedSymbols,
        adj: residue.length,
        symbols: grounded.reduce((n, g) => n + g.entry.symbols.length, 0),
        residue
    }
}

const mean = (xs: number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length

console.log('=== ungrounded, pre-registered vs prose-corrected (both arms) ===')
console.log('  fixture     arm       n   pre-reg   corrected   symbols   residue')
const summary: Record<string, Record<string, number>> = {}
for (const id of HIGH_FANOUT) {
    for (const arm of ['baseline', 'rescue']) {
        const rows = [0, 1].map(t => rescore(arm, id, t)).filter(r => r !== null)
        if (rows.length === 0) continue
        const pre = mean(rows.map(r => r!.pre))
        const adj = mean(rows.map(r => r!.adj))
        summary[id] ??= {}
        summary[id][arm] = adj
        const residue = [...new Set(rows.flatMap(r => r!.residue))].join(' ')
        console.log(
            `  ${id.padEnd(11)} ${arm.padEnd(9)} ${rows.length}`
                + `  ${pre.toFixed(1).padStart(7)}   ${adj.toFixed(1).padStart(9)}`
                + `  ${mean(rows.map(r => r!.symbols))
                    .toFixed(1)
                    .padStart(7)}   ${residue}`
        )
    }
}

console.log('\n=== inv-quality-not-worse, recomputed on corrected counts ===')
const breaks = Object.entries(summary)
    .filter(([, arms]) => arms.rescue !== undefined && arms.baseline !== undefined)
    .filter(([, arms]) => arms.rescue! > arms.baseline!)
for (const [id, arms] of breaks) {
    console.log(`  BREAK ${id} ungrounded ${arms.baseline!.toFixed(1)}→${arms.rescue!.toFixed(1)}`)
}
console.log(
    breaks.length === 0 ?
        '  no fixture regresses on prose-corrected ungrounded counts'
    :   `  ${breaks.length} fixture(s) still regress`
)
console.log(
    '\nNOTE: this does NOT replace the recorded verdict (FAIL, exit 1). It is the'
        + '\ncorrection reported beside it. inv-low-fanout-untouched is untouched here.'
)
