/**
 * PACKAGE-GAP — is a `node_modules` grounding channel justified, or would it
 * ground the fabrications the guard exists to catch?
 *
 * `VALIDATION-DEBT.md` records the gap and refuses to close it on argument: the
 * residue after the `projectTree` channel is symbols like `setInputFiles` and
 * `$patch` that live in a DEPENDENCY, and admitting `node_modules` would ground
 * essentially any identifier — the same failure mode as admitting
 * `.playwright-cache`, which would have grounded the only fabrication this
 * experiment ever observed. The stated blocker is evidential, not technical:
 * there was no observed fabrication living in a dependency to test a filter
 * against.
 *
 * That is now checkable. This walks every recorded trial in a corpus,
 * recomputes grounding, and classifies each ungrounded symbol against the
 * fixture's own `node_modules` at its checkpoint:
 *
 *   IN-DEPS      the symbol appears in an installed package's own source or
 *                types — a real dependency API the worker did not re-retrieve.
 *                A node_modules channel would ground it CORRECTLY.
 *   NOT-IN-DEPS  it appears nowhere in the project tree, the retrieval log, or
 *                any dependency. This is the fabrication class, and it is what
 *                a node_modules channel must NOT be able to reach.
 *
 * The decision the counts force:
 *   - any NOT-IN-DEPS symbol that a node_modules scan WOULD have matched (via a
 *     loose substring, the way a naive channel works) refutes the channel
 *     outright — it grounds fabrications;
 *   - if every NOT-IN-DEPS symbol is invisible to node_modules while the
 *     IN-DEPS ones are found, the channel is justified AND has a test corpus.
 *
 * Read-only, offline, no model time.
 *
 *   AB_DIR=~/tmp/research-fanout-ab-v3 bun run scripts/package-gap-classify.ts
 *
 * NOTE, in the honest direction: like `rescore-fanout-grounding.ts`, this cannot
 * reproduce the live scorer's assembled-prompt channel (in-memory, not
 * persisted), so its ungrounded set is a SUPERSET of what the harness counted.
 * That is what you want for classification — it errs toward examining more
 * symbols, not fewer.
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
const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')

function corpusFor(dir: string, taskId: string, commit: string): GroundingCorpus {
    const answers = readTypeOnlyLog(read(path.join(dir, 'answers.jsonl')))
    const steps = parseTrajectory(read(path.join(dir, 'trial.log')))
    const join = (rs: typeof answers): string =>
        rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt: read(path.join(dir, '.pi-tasks', `${taskId}.md`)),
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: readTouchedFiles(dir, steps),
        projectTree: checkpointSourceText(commit)
    }
}

/**
 * Which of `symbols` a naive `node_modules` channel would find, by EXHAUSTIVE
 * search of the installed packages' sources and type declarations.
 *
 * Deliberately NAIVE about matching — the point is to measure what the
 * permissive version grounds, because a channel that only works when carefully
 * filtered is a channel whose filter is the actual claim.
 *
 * But exhaustive about coverage. The first cut of this read node_modules into a
 * string under a 60MB budget and silently truncated: `$patch` came back
 * NOT-IN-DEPS while sitting in `hono/dist/types/client/types.d.ts`, i.e. the
 * budget invented the very answer the debt file was waiting for. A partial scan
 * reports absence it never established — the same defect this whole file exists
 * to stamp out, one level down. grep walks the tree completely.
 */
function matchedInDeps(dir: string, symbols: string[]): Set<string> {
    const nm = path.join(dir, 'node_modules')
    const hit = new Set<string>()
    if (!fs.existsSync(nm) || symbols.length === 0) return hit
    const patterns = path.join(dir, '.package-gap-patterns')
    fs.writeFileSync(patterns, symbols.join('\n'))
    try {
        // -o prints each MATCH, so the output names exactly which patterns were
        // found; -h drops filenames so they cannot be mistaken for matches.
        const out = Bun.spawnSync(
            [
                'grep',
                '-rhoF',
                '-f',
                patterns,
                '--include=*.ts',
                '--include=*.mts',
                '--include=*.cts',
                '--include=*.js',
                '--include=*.mjs',
                '--include=*.cjs',
                nm
            ],
            {stdout: 'pipe', stderr: 'ignore', maxBuffer: 512 * 1024 * 1024}
        )
        for (const line of new TextDecoder().decode(out.stdout).split('\n')) {
            if (line.length > 0) hit.add(line)
        }
    } finally {
        fs.rmSync(patterns, {force: true})
    }
    return hit
}

interface Row {
    arm: string
    taskId: string
    trial: number
    symbol: string
    inDeps: boolean
}

function main(): void {
    const pending: {arm: string; taskId: string; trial: number; dir: string; ungrounded: string[]}[] =
        []
    let trials = 0
    let noTree = 0

    for (const arm of fs.readdirSync(path.join(ROOT, 'results'))) {
        const resDir = path.join(ROOT, 'results', arm)
        if (!fs.statSync(resDir).isDirectory()) continue
        for (const f of fs.readdirSync(resDir).filter(x => x.endsWith('.json'))) {
            const rec = JSON.parse(read(path.join(resDir, f))) as TrialResult
            if (rec.error) continue
            const dir = path.join(ROOT, arm, rec.taskId, `trial-${rec.trial}`)
            if (!fs.existsSync(dir)) {
                noTree++
                continue
            }
            trials++
            const corpus = corpusFor(dir, rec.taskId, rec.commit)
            const entries = parseApisEntries(rec.apisSection)
            const ungrounded = groundEntriesStrict(entries, corpus).flatMap(g => g.ungrounded)
            if (ungrounded.length === 0) continue
            pending.push({arm, taskId: rec.taskId, trial: rec.trial, dir, ungrounded})
        }
    }

    // One exhaustive grep per trial dir, over that trial's distinct symbols.
    const rows: Row[] = []
    for (const p of pending) {
        const distinct = [...new Set(p.ungrounded)]
        const hit = matchedInDeps(p.dir, distinct)
        for (const symbol of p.ungrounded) {
            rows.push({
                arm: p.arm,
                taskId: p.taskId,
                trial: p.trial,
                symbol,
                inDeps: hit.has(symbol)
            })
        }
    }

    console.log(`=== PACKAGE-GAP classification — ${ROOT}`)
    console.log(`  ${trials} trial(s) walked${noTree > 0 ? `, ${noTree} with no preserved tree` : ''}`)
    console.log(`  ${rows.length} ungrounded symbol occurrence(s)\n`)

    const bySymbol = new Map<string, Row[]>()
    for (const r of rows) bySymbol.set(r.symbol, [...(bySymbol.get(r.symbol) ?? []), r])
    // Permissive on purpose: a symbol counts as reachable if ANY trial's
    // dependencies carry it, because that is what a channel would ground.
    const inDeps = [...bySymbol].filter(([, rs]) => rs.some(r => r.inDeps))
    const notInDeps = [...bySymbol].filter(([, rs]) => !rs.some(r => r.inDeps))

    const show = (label: string, xs: [string, Row[]][]): void => {
        console.log(`  ${label} — ${xs.length} distinct symbol(s), ${xs.reduce((n, [, rs]) => n + rs.length, 0)} occurrence(s)`)
        for (const [sym, rs] of xs.sort((a, b) => b[1].length - a[1].length)) {
            const where = [...new Set(rs.map(r => `${r.arm}/${r.taskId}`))].join(' ')
            console.log(`    ${sym.padEnd(28)} x${String(rs.length).padStart(2)}  ${where}`)
        }
        console.log('')
    }
    show('IN-DEPS (a node_modules channel would ground these)', inDeps)
    show('NOT-IN-DEPS (invisible to node_modules — the fabrication class)', notInDeps)

    console.log('  READING:')
    console.log(
        `    A node_modules channel would ground ${inDeps.length} of ${bySymbol.size} distinct`
            + ` ungrounded symbols and leave ${notInDeps.length} still flagged.`
    )
    console.log(
        '    It is REFUTED if any symbol in the second list is a genuine fabrication that'
            + '\n    the first list shows node_modules can reach — inspect them by hand; a count'
            + '\n    alone cannot tell a real dependency API from an invented one.'
    )
}

main()
