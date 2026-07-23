/** STAGE 3 STEP 0 — dump flagged clauses + retrieved context for HAND LABELING. No model time. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {readTypeOnlyLog} from '../src/workers/typeonly-log.js'

const ROOT = path.resolve(process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'apis-contract-ab'))
const FIXTURE = process.argv[2] ?? 'task27-hono'
const MODE = process.argv[3] ?? 'flagged' // flagged | all

interface Rec {
    fixture: string
    rep: number
    entryName: string
    sig: string
    clause: string
    codeDistinctive: string[]
    codeRetrieved: string[]
    codePromptOnly: string[]
    codeNowhere: string[]
}

const recs = (JSON.parse(fs.readFileSync(path.join(ROOT, 'step0-clauses.json'), 'utf8')) as Rec[]).filter(
    r => r.fixture === FIXTURE
)

// Cache retrieved package-docs text per rep so ungrounded tokens can be judged in context.
const pkgDocsOf = (rep: number): string => {
    const p = path.join(ROOT, 'treatment', FIXTURE, `trial-${rep}`, 'answers.jsonl')
    if (!fs.existsSync(p)) return ''
    return readTypeOnlyLog(fs.readFileSync(p, 'utf8'))
        .filter(a => a.module !== '.')
        .map(a => `  Q[${a.module}]: ${a.query.replace(/\s+/g, ' ')}\n  A: ${(a.answer || '').replace(/\s+/g, ' ').slice(0, 400)}`)
        .join('\n')
}

const flagged = recs.filter(r => r.codeNowhere.length + r.codePromptOnly.length > 0)
console.log(`${FIXTURE}: ${recs.length} clauses, ${flagged.length} flagged (>=1 code token ungrounded vs retrieved)\n`)

const show = MODE === 'all' ? recs : flagged
for (const r of show) {
    console.log(`── rep${r.rep}  ${r.entryName}`)
    console.log(`   CLAUSE: ${r.clause.slice(0, 300)}`)
    if (r.codeNowhere.length) console.log(`   NOWHERE: ${r.codeNowhere.join(', ')}`)
    if (r.codePromptOnly.length) console.log(`   PROMPT-ONLY: ${r.codePromptOnly.join(', ')}`)
    console.log('')
}

if (process.argv[4] === 'ctx') {
    const reps = [...new Set(show.map(r => r.rep))].sort((a, b) => a - b)
    for (const rep of reps) {
        console.log(`\n========= rep${rep} retrieved package docs =========`)
        console.log(pkgDocsOf(rep))
    }
}
