/**
 * STAGE 3 STEP 0 — SCORE the candidate braces rule's 2x2 against HAND LABELS, held-out split.
 * No model time; reads step0-clauses.json (run apis-contract-step0.ts first).
 *
 * THE FROZEN RULE, defined on task27 (training), applied unchanged to task28 (held-out):
 *   DEMOTE a semantics clause iff it carries >= 1 DISTINCTIVE BACKTICK CODE TOKEN — an identifier
 *   the model quoted in backticks, minus any already present in the entry's name+signature — that
 *   is ungrounded against the RETRIEVED channels (docs answers + files read), i.e. codeNowhere or
 *   codePromptOnly is non-empty. Retrieved-only, per the brief: the prompt is where memory-adjacent
 *   priming sits, so grounding there must not save a clause.
 *
 * This narrowing (backtick code tokens, not all symbols) is the CHARITABLE operationalisation of
 * "distinctive symbols": grounding every >=3-char word demotes 76% of all clauses (prose paraphrase
 * noise). If even the charitable rule cannot discriminate, no rule in this family can.
 *
 * HAND LABELS: every flagged clause was read against its rep's retrieved docs (apis-contract-step0-
 * dump.ts <fixture> flagged ctx). FAB = the clause asserts a behavioural claim absent from / beyond
 * what retrieval returned (memory-sourced). OK = the claim is correct AND either retrieval-backed or
 * correct standard-platform knowledge; the ungrounded token is an example placeholder, an example
 * literal, standard browser/React knowledge, or (for `app`) a project-source entry not in scope.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const ROOT = path.resolve(process.env.AB_DIR || path.join(os.homedir(), 'tmp', 'apis-contract-ab'))

interface Rec {
    fixture: string
    rep: number
    entryName: string
    codeNowhere: string[]
    codePromptOnly: string[]
}

/** FAB clauses (genuine fabrication). Key = `fixture|rep|entryName`. Everything else flagged = OK. */
const FAB = new Set<string>([
    // task27 rep7 hc<AppType>: "$url() requires an absolute URL or it throws" is not in retrieval,
    // and the origin-vs-relative concatenation question returned "unclear" — memory-sourced claim.
    'task27-hono|7|hc<AppType>'
])

/** Flagged clauses judged FALSE DEMOTE, with the reason, for the record. */
const FALSE_DEMOTE_REASON: Record<string, string> = {
    'task27-hono|4|ClientResponse.json()': 'correct; `xxx`,`$method` are example placeholders',
    'task27-hono|4|InferRequestType<T>': 'correct; `BodyType` is an example placeholder type',
    'task27-hono|9|app': 'project-source entry (AppType=typeof app); `group` from prompt/project — out of the third-party scope the gate is supposed to have',
    'task28-wouter|1|Route': '`listing` is project-domain from the prompt example /listing/:id',
    'task28-wouter|1|Link': 'CORRECT: wouter Link does call history.pushState — standard-platform knowledge, absent from wouter docs retrieval',
    'task28-wouter|1|createRoot': 'correct; `ReactDOM` naming the deprecated API it replaces',
    'task28-wouter|2|useRoute': '`false` is a return-value literal; claim correct',
    'task28-wouter|2|createRoot': 'correct; `DocumentFragment`/`Element` are standard React DOM types',
    'task28-wouter|3|createRoot': '`reactNode` is an example param name',
    'task28-wouter|4|useLocation': '`abc123` is an example URL value',
    'task28-wouter|4|createRoot': 'correct; `ReactDOM` names the deprecated API',
    'task28-wouter|4|useState': '`prev` is an example callback param name',
    'task28-wouter|6|Link': '`className` is a correct standard prop',
    'task28-wouter|7|useState': '`false` is an example initial value',
    'task28-wouter|8|Route': '`paramName` is a placeholder in {[paramName]: string}',
    'task28-wouter|8|createRoot': 'correct; `ReactDOM` names the deprecated API',
    'task28-wouter|9|createRoot': '`reactNode` is an example param name',
    'task28-wouter|10|Route': '`listing` is project-domain from the prompt',
    'task28-wouter|10|createRoot': '`document`/`getElementById` are correct standard DOM'
}

const key = (r: {fixture: string; rep: number; entryName: string}): string => `${r.fixture}|${r.rep}|${r.entryName}`
const flags = (r: Rec): boolean => r.codeNowhere.length + r.codePromptOnly.length > 0

function main(): void {
    const recs = JSON.parse(fs.readFileSync(path.join(ROOT, 'step0-clauses.json'), 'utf8')) as Rec[]
    for (const fixture of ['task27-hono', 'task28-wouter']) {
        const fx = recs.filter(r => r.fixture === fixture)
        const flagged = fx.filter(flags)
        const trueDemote = flagged.filter(r => FAB.has(key(r)))
        const falseDemote = flagged.filter(r => !FAB.has(key(r)))
        const split = fixture === 'task27-hono' ? 'TRAINING (rule defined here)' : 'HELD-OUT (frozen rule applied)'
        console.log(`\n=== ${fixture} — ${split} ===`)
        console.log(`  clauses ${fx.length}   flagged (demoted) ${flagged.length}`)
        console.log(`  TRUE DEMOTE  (fabricated -> demoted)  ${trueDemote.length}`)
        console.log(`  FALSE DEMOTE (correct    -> demoted)  ${falseDemote.length}`)
        console.log(
            `  precision on flags ${flagged.length ? ((100 * trueDemote.length) / flagged.length).toFixed(0) : 'n/a'}%`
                + `   FALSE-DEMOTE RATE over clauses ${((100 * falseDemote.length) / fx.length).toFixed(1)}%`
        )
        for (const r of falseDemote) console.log(`    FALSE  r${r.rep} ${r.entryName} — ${FALSE_DEMOTE_REASON[key(r)] ?? '?'}`)
        for (const r of trueDemote) console.log(`    TRUE   r${r.rep} ${r.entryName}`)

        // LAXER VARIANT: demote only on pure-memory (codeNowhere), sparing prompt-grounded tokens.
        const laxFlagged = fx.filter(r => r.codeNowhere.length > 0)
        const laxTrue = laxFlagged.filter(r => FAB.has(key(r))).length
        console.log(
            `  [laxer nowhere-only variant] flagged ${laxFlagged.length}  true ${laxTrue}  false ${laxFlagged.length - laxTrue}`
                + `  precision ${laxFlagged.length ? ((100 * laxTrue) / laxFlagged.length).toFixed(0) : 'n/a'}%`
        )
    }

    // RECALL of the canonical fabrication class, independent of the rule: the run-15-style claim
    // that hc's baseUrl / $url has a specific join/throw behaviour retrieval never confirmed.
    const recs2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'step0-clauses.json'), 'utf8')) as Array<
        Rec & {clause: string}
    >
    const urlClaim = recs2.filter(
        r => r.fixture === 'task27-hono' && /^hc/.test(r.entryName) && /\$url\(\).{0,40}(throw|absolute|TypeError)/i.test(r.clause)
    )
    const caught = urlClaim.filter(flags)
    console.log(
        `\n=== RECALL, canonical fabrication ("$url() requires absolute / throws", retrieval said "unclear") ===`
            + `\n  clauses making the unverified claim: ${urlClaim.length} (reps ${urlClaim.map(r => r.rep).join(',')})`
            + `\n  flagged by the rule: ${caught.length} (reps ${caught.map(r => r.rep).join(',') || '—'})`
            + `\n  the one catch (rep7) is via the placeholder \`MyApp\`, not the fabricated prose claim.`
    )
}

main()
