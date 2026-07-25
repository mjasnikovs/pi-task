/**
 * Offline scorer for the requirement-cap selection rule (mx5 run 16) — no model
 * time. Reads the per-rep GROUNDED quote lists retained by
 * scripts/extraction-recall-step0.ts (quotes.jsonl) and scores, per rep:
 *
 *   OLD rule  capRequirements(entries, passages)            given-order fill
 *   NEW rule  capRequirements(entries, passages, design)    section-fair fill
 *
 * on (a) survival of the pre-registered probe clauses — probe #0 is the clause
 * whose loss shipped run 16's blank app — and (b) how many doc sections keep at
 * least one quote. Integrity assert: the OLD-rule recompute must equal the
 * recorded `kept` list byte-for-byte (the recorded reps ran the shipped cap), so
 * a drifted scorer can never masquerade as a measurement.
 *
 * Usage: bun run scripts/extraction-recall-caprule-score.ts
 * Env:   STEP0_DIR (default ~/tmp/extraction-recall-step0), MX5_DIR.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {normalise} from '../src/task/contracts.js'
import {
    capRequirements,
    enumerateObligationPassages,
    type RequirementEntry
} from '../src/task/requirements.js'

const DIR = process.env.STEP0_DIR ?? path.join(os.homedir(), 'tmp', 'extraction-recall-step0')
const MX5 = process.env.MX5_DIR ?? path.join(os.homedir(), 'hub', 'mx5')

const PROBES: Array<{id: string; text: string}> = [
    {id: 'serve-static', text: 'serves `/api` + static `dist/`'},
    {id: 'compose-dev', text: 'docker-compose Postgres + concurrent watch (tailwind, bun build, server)'},
    {id: 'client-css', text: 'bunx @tailwindcss/cli -i src/client/index.css -o dist/app.css'},
    {id: 'spa-fallback', text: 'non-`/api` GETs serve the built `index.html`'}
]

function covers(quote: string, clause: string): boolean {
    const q = normalise(quote)
    const c = normalise(clause)
    return c.includes(q) || q.includes(c)
}

function sectionOf(design: string, quote: string): string {
    let section = '(intro)'
    const q = normalise(quote)
    let acc: string[] = []
    for (const line of design.replace(/\r\n?/g, '\n').split('\n')) {
        const h = /^#{1,6}\s+(.+)$/.exec(line)
        if (h) {
            if (normalise(acc.join('\n')).includes(q)) return section
            section = h[1].trim()
            acc = []
            continue
        }
        acc.push(line)
    }
    return normalise(acc.join('\n')).includes(q) ? section : '(unlocated)'
}

const design = fs.readFileSync(path.join(MX5, 'DESIGN', 'PROJECT.md'), 'utf8')
const passages = enumerateObligationPassages(design)
const lines = fs
    .readFileSync(path.join(DIR, 'quotes.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l) as {rep: number; grounded: RequirementEntry[]; kept: RequirementEntry[]})

let integrityFailures = 0
const tally = {old: new Map<string, number>(), new: new Map<string, number>()}
const sectionCounts = {old: [] as number[], new: [] as number[]}
for (const {rep, grounded, kept} of lines) {
    const oldKept = capRequirements(grounded, passages)
    const newKept = capRequirements(grounded, passages, design)
    const sameAsRecorded =
        oldKept.length === kept.length && oldKept.every((e, i) => e.quote === kept[i].quote)
    if (!sameAsRecorded) integrityFailures += 1
    const score = (rule: 'old' | 'new', keptList: RequirementEntry[]): void => {
        for (const p of PROBES) {
            if (keptList.some(e => covers(e.quote, p.text))) {
                tally[rule].set(p.id, (tally[rule].get(p.id) ?? 0) + 1)
            }
        }
        sectionCounts[rule].push(new Set(keptList.map(e => sectionOf(design, e.quote))).size)
    }
    score('old', oldKept)
    score('new', newKept)
    console.log(
        `rep ${rep}: grounded ${grounded.length} — sections kept old=${sectionCounts.old.at(-1)} new=${sectionCounts.new.at(-1)}`
    )
}
if (integrityFailures > 0) {
    console.error(
        `INTEGRITY FAIL: OLD-rule recompute differs from the recorded kept list in `
            + `${integrityFailures}/${lines.length} rep(s) — scorer or code drifted; result void.`
    )
    process.exit(2)
}
console.log(`\nintegrity: OLD-rule recompute == recorded kept in ${lines.length}/${lines.length} reps`)
console.log(`probe survival over ${lines.length} reps (old → new):`)
for (const p of PROBES) {
    console.log(
        `  ${p.id}: ${tally.old.get(p.id) ?? 0}/${lines.length} → ${tally.new.get(p.id) ?? 0}/${lines.length}`
    )
}
const mean = (a: number[]) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1)
console.log(`sections represented, mean: old ${mean(sectionCounts.old)} → new ${mean(sectionCounts.new)}`)
