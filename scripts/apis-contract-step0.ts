/**
 * STAGE 3 STEP 0 — DISCRIMINATION, OFFLINE, ZERO MODEL TIME.
 *
 * Re-scores the STAGE 2 treatment corpus (~/tmp/apis-contract-ab) to answer ONE question before
 * any src/ change: can a deterministic rule separate the FABRICATED semantics clauses from the
 * GROUNDED ones, on the 40 reps already recorded, without an unacceptable false-demote rate?
 *
 * It reconstructs each rep's GroundingCorpus from the preserved trial tree exactly as the A/B's
 * corpusOf did — docs-answer toolText+answer, files the worker read — and, CRUCIALLY, keeps the
 * RETRIEVED-only corpus (docs + reads, NOT the assembled prompt) apart from the full union. The
 * braces must ground against retrieved-only: the prompt is where the model's memory-adjacent
 * priming sits, so a fabricated clause that echoes a prompt word would score "grounded" against
 * the union and fool the gate. Retrieved-only is STRICTER and flags MORE — the safe direction.
 *
 * Output: one JSON record per emitted SEMANTICS clause, with its symbols split by where they
 * ground (retrieved / prompt-only / nowhere), so a rule can be built and its 2x2 scored against
 * hand labels. No model time; re-run freely.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {readTypeOnlyLog} from '../src/workers/typeonly-log.js'
import {
    channelsFor,
    extractSection,
    extractSymbols,
    parseTrajectory,
    readTouchedFiles,
    type GroundingCorpus,
    type Step
} from './apis-trajectory.js'

const ROOT = path.resolve(process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'apis-contract-ab'))

interface RepRow {
    fixture: string
    arm: string
    rep: number
    apisSection: string
}

/** The clause text after `SEMANTICS:` on a line, and the signature part before it. */
const SEM = /\bSEMANTICS\s*:/i

interface ClauseRecord {
    fixture: string
    rep: number
    entryName: string
    /** The signature/rest between the name and `SEMANTICS:` — symbols here are already looked up. */
    sig: string
    clause: string
    isUnverified: boolean
    /** All identifier-shaped tokens in the clause. */
    clauseSymbols: string[]
    /** Clause symbols NOT already present in the entry name+signature — the new claims. */
    distinctive: string[]
    /** Distinctive symbols grounded in RETRIEVED channels (docs + reads), not the prompt. */
    distinctiveRetrieved: string[]
    /** Distinctive symbols grounded ONLY in the assembled prompt (priming, not retrieval). */
    distinctivePromptOnly: string[]
    /** Distinctive symbols in NO channel at all — pure memory. */
    distinctiveNowhere: string[]
    /** CODE tokens: identifiers the model wrapped in backticks — its own marking of a factual
     *  claim, minus the ones already in the name+signature. Prose words excluded. */
    codeDistinctive: string[]
    codeRetrieved: string[]
    codePromptOnly: string[]
    codeNowhere: string[]
}

/** Identifier tokens that appear inside a backtick span. The model's own claim marking. */
function backtickCodeTokens(text: string): string[] {
    const out: string[] = []
    for (const m of text.matchAll(/`([^`]+)`/g)) out.push(...extractSymbols(m[1]))
    return [...new Set(out)]
}

function retrievedCorpus(trialDir: string, steps: Step[], answersText: string): GroundingCorpus {
    const answers = readTypeOnlyLog(answersText)
    const join = (rs: typeof answers): string => rs.map(a => `${a.toolText ?? ''}\n${a.answer}`).join('\n')
    return {
        prompt: '', // RETRIEVED-ONLY: the prompt is deliberately excluded.
        docsProject: join(answers.filter(a => a.module === '.')),
        docsPackage: join(answers.filter(a => a.module !== '.')),
        reads: fs.existsSync(trialDir) ? readTouchedFiles(trialDir, steps) : ''
    }
}

function clausesOf(section: string): Array<{entryName: string; sig: string; clause: string}> {
    const out: Array<{entryName: string; sig: string; clause: string}> = []
    for (const raw of section.split('\n')) {
        const line = raw.trim()
        const m = SEM.exec(line)
        if (!m) continue
        const before = line.slice(0, m.index)
        const clause = line.slice(m.index + m[0].length).trim()
        // Head field: name up to the first double-space / dash / colon separator.
        const head = /\s{2,}|\s+[-–—]\s+|:\s+/.exec(before)
        const entryName = (head ? before.slice(0, head.index) : before).trim()
        const sig = head ? before.slice(head.index).trim() : ''
        out.push({entryName, sig, clause})
    }
    return out
}

function main(): void {
    const rows = (JSON.parse(fs.readFileSync(path.join(ROOT, 'ab.json'), 'utf8')) as RepRow[]).filter(
        r => r.arm === 'treatment'
    )
    const records: ClauseRecord[] = []
    for (const r of rows) {
        const dir = path.join(ROOT, 'treatment', r.fixture, `trial-${r.rep}`)
        const read = (p: string): string => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
        const steps = parseTrajectory(read(path.join(dir, 'trial.log')))
        const promptDump = read(path.join(dir, 'prompts.txt'))
        const apisPrompt = promptDump.split('===== ').find(s => s.startsWith('worker:apis')) ?? ''
        const retr = retrievedCorpus(dir, steps, read(path.join(dir, 'answers.jsonl')))
        const full: GroundingCorpus = {...retr, prompt: apisPrompt}
        const section = r.apisSection || extractSection('', 'APIS')
        for (const c of clausesOf(section)) {
            const isUnverified = /^UNVERIFIED\s*:/i.test(c.clause)
            const clauseSymbols = extractSymbols(c.clause)
            const headSyms = new Set([...extractSymbols(c.entryName), ...extractSymbols(c.sig)])
            const distinctive = clauseSymbols.filter(s => !headSyms.has(s))
            const distinctiveRetrieved = distinctive.filter(s => channelsFor(s, retr).length > 0)
            const distinctivePromptOnly = distinctive.filter(
                s => channelsFor(s, retr).length === 0 && channelsFor(s, full).length > 0
            )
            const distinctiveNowhere = distinctive.filter(s => channelsFor(s, full).length === 0)
            const codeDistinctive = backtickCodeTokens(c.clause).filter(s => !headSyms.has(s))
            const codeRetrieved = codeDistinctive.filter(s => channelsFor(s, retr).length > 0)
            const codePromptOnly = codeDistinctive.filter(
                s => channelsFor(s, retr).length === 0 && channelsFor(s, full).length > 0
            )
            const codeNowhere = codeDistinctive.filter(s => channelsFor(s, full).length === 0)
            records.push({
                fixture: r.fixture,
                rep: r.rep,
                entryName: c.entryName,
                sig: c.sig,
                clause: c.clause,
                isUnverified,
                clauseSymbols,
                distinctive,
                distinctiveRetrieved,
                distinctivePromptOnly,
                distinctiveNowhere,
                codeDistinctive,
                codeRetrieved,
                codePromptOnly,
                codeNowhere
            })
        }
    }
    const outPath = path.join(ROOT, 'step0-clauses.json')
    fs.writeFileSync(outPath, JSON.stringify(records, null, 2), 'utf8')

    // Summary landscape.
    const nClauses = records.length
    const withNowhere = records.filter(r => r.distinctiveNowhere.length > 0).length
    const withPromptOnly = records.filter(r => r.distinctivePromptOnly.length > 0).length
    const totalDistinct = records.reduce((a, r) => a + r.distinctive.length, 0)
    const totalNowhere = records.reduce((a, r) => a + r.distinctiveNowhere.length, 0)
    const totalPromptOnly = records.reduce((a, r) => a + r.distinctivePromptOnly.length, 0)
    console.log(`STEP 0 landscape — ${nClauses} treatment semantics clauses over ${rows.length} reps`)
    console.log(`  wrote ${outPath}`)
    console.log(`  distinctive symbols total ${totalDistinct}`)
    console.log(`    grounded in RETRIEVED  ${totalDistinct - totalNowhere - totalPromptOnly}`)
    console.log(`    prompt-only            ${totalPromptOnly}  (union grounds these, retrieved-only does not)`)
    console.log(`    nowhere (pure memory)  ${totalNowhere}`)
    console.log(`  clauses with >=1 nowhere symbol      ${withNowhere}/${nClauses} = ${((100 * withNowhere) / nClauses).toFixed(1)}%`)
    console.log(`  clauses with >=1 prompt-only symbol  ${withPromptOnly}/${nClauses} = ${((100 * withPromptOnly) / nClauses).toFixed(1)}%`)
    const unv = records.filter(r => r.isUnverified).length
    console.log(`  already-UNVERIFIED clauses           ${unv}/${nClauses}`)

    // The backtick-code-token view: narrow the grounding target to the model's own claim marks.
    const codeTot = records.reduce((a, r) => a + r.codeDistinctive.length, 0)
    const codeNw = records.reduce((a, r) => a + r.codeNowhere.length, 0)
    const codePo = records.reduce((a, r) => a + r.codePromptOnly.length, 0)
    const clWithCode = records.filter(r => r.codeDistinctive.length > 0).length
    const clCodeNowhere = records.filter(r => r.codeNowhere.length > 0).length
    const clCodeRetrOnlyGap = records.filter(r => r.codeNowhere.length + r.codePromptOnly.length > 0).length
    console.log(`\n  === BACKTICK CODE-TOKEN view (distinctive = code the model quoted, minus name+sig) ===`)
    console.log(`  clauses carrying >=1 distinctive code token   ${clWithCode}/${nClauses}`)
    console.log(`  distinctive code tokens total ${codeTot}`)
    console.log(`    retrieved ${codeTot - codeNw - codePo}   prompt-only ${codePo}   nowhere ${codeNw}`)
    console.log(`  clauses with >=1 NOWHERE code token           ${clCodeNowhere}/${nClauses} = ${((100 * clCodeNowhere) / nClauses).toFixed(1)}%`)
    console.log(`  clauses with >=1 code token ungrounded vs RETRIEVED ${clCodeRetrOnlyGap}/${nClauses} = ${((100 * clCodeRetrOnlyGap) / nClauses).toFixed(1)}%`)
}

main()
