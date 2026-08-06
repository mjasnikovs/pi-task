/**
 * STEP 3 for nexttask 13 — the held-out A/B for a runtime-wiring vocabulary in
 * `src/task/unknown-routing.ts`.
 *
 * VERDICT: REFUTED. Nothing here is wired. The candidate classifier lives in this
 * script — not in `src/` — for the same reason `scripts/answer-narrowing.ts` does:
 * the measurement killed the lever, so the shipped classifier is left untouched.
 *
 *     bun run scripts/unknown-routing-classifier-ab.ts            held-out A/B
 *     bun run scripts/unknown-routing-classifier-ab.ts --fit      in-sample diagnostic
 *     bun run scripts/unknown-routing-classifier-ab.ts --control  STEP 5 control arm
 *
 * exit 0 PASS · 1 FAIL · 2 ABSTAIN
 *
 * PASS requires all four of nexttask 13's bounds:
 *   1. treatment true on ≥ 90% of holdout `is_wiring_truth` questions
 *   2. true on both named mx5 forms
 *   3. true on ≤ 10% of holdout preference questions
 *   4. true on every question the shipped classifier already returns true for
 *
 * WHY IT FAILS — two independent measured reasons, both from
 * `scripts/unknown-routing-coverage-baserate.ts`:
 *
 * (1) The task says to extend Factor A only and never touch Factor B, and
 *     `isIntegrationUnknown` is `A && B`. Factor B matches 5 of the 40 hand-labelled
 *     wiring questions — a 12.5% CEILING on any Factor-A-only edit, against a 90%
 *     bar. Both named mx5 forms are among the 35 Factor B misses, so bound 2 is
 *     unreachable by construction. nexttask13.md's premise that "Factor B already
 *     matches row 1 (should it default … or accept a configurable)" is wrong:
 *     `configur(?:e|ed|es|ing|ation)` does not match `configurable`.
 *
 * (2) The ceiling is not what blocks it. Dropping the Factor-B conjunction
 *     entirely and tuning FREELY on the fit half — including terms the task's own
 *     NEVER list forbids — tops out at 88% recall / 17% false positives IN SAMPLE.
 *     Three of the 17 fit-half wiring questions carry no coupling vocabulary at
 *     all ("Multiple files per request — still open", "Auth check mechanism for
 *     member guard", "What exact model string should be sent in the request
 *     body …"). A word list cannot reach a class that is not lexical.
 *
 * Both arms are therefore reported every run: the task-faithful one (`A' && B`)
 * and the unconstrained one (`A'` alone), so a reader can see that relaxing the
 * one-variable rule does not rescue the lever.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import {isIntegrationUnknown} from '../src/task/unknown-routing.js'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const FIXTURES = path.join(HERE, 'fixtures')
const FIT = process.argv.includes('--fit')
const CONTROL = process.argv.includes('--control')

interface Row {
    name: string | null
    question: string
    is_wiring_truth: boolean
    shipped: boolean
    factor_b: boolean
    instances: number
}

// ─── the candidate ───────────────────────────────────────────────────────────
// Factor A extended with nexttask 13's candidate list, verbatim. No library,
// framework, tool or project name appears in it.
const FACTOR_A_SHIPPED =
    'plugins?|bundlers?|loaders?|middlewares?|adapters?|toolchains?|transpilers?|compilers?'
    + '|build\\s+(?:pipeline|step|process|chain|config|tool|system)|import\\s+structure'
    + '|entry[\\s-]*points?|dev[\\s-]*servers?|module\\s+resolution|build\\s+wiring|wiring'

/** The runtime-wiring additions, widest last — the removal ladder pops from the end. */
const RUNTIME_TERMS: string[] = [
    'base\\s*urls?',
    'route\\s+prefix',
    'url\\s+prefix',
    'api\\s+(?:client|prefix|base|path)',
    'mount\\s+points?',
    'request\\s+paths?',
    'server\\s+urls?',
    'proxy',
    'cors',
    'origins?',
    'endpoints?',
    'ports?',
    'hosts?',
    'routes?'
]

const FACTOR_B =
    /\b(?:wir(?:e|ed|ing)|integrat(?:e|ed|es|ing|ion)|hook(?:ed|s|ing)?\s+(?:it\s+|them\s+)?(?:up|in|into)|plug(?:ged|s|ging)?\s+(?:it\s+|them\s+)?(?:in|into)|configur(?:e|ed|es|ing|ation)|set[\s-]*up|register(?:ed|s|ing)?|mount(?:ed|s|ing)?|how\s+(?:to|do|does|should|is|are)|where\s+(?:to|should|does|is))\b/i

function factorA(terms: string[]): RegExp {
    return new RegExp(`\\b(?:${FACTOR_A_SHIPPED}|${terms.join('|')})\\b`, 'i')
}

/** Task-faithful: Factor A extended, Factor B untouched, still ANDed. */
function candidate(terms: string[], q: string): boolean {
    if (!q) return false
    return factorA(terms).test(q) && FACTOR_B.test(q)
}

/** Unconstrained diagnostic: the vocabulary alone, Factor B dropped. */
function candidateNoB(terms: string[], q: string): boolean {
    if (!q) return false
    return factorA(terms).test(q)
}

// ─── STEP 5 control arm ──────────────────────────────────────────────────────
// Twelve hand-labelled preference questions drawn from the corpus, including
// nexttask13.md's row 3. Exit 0 iff at most 1 of 12 is newly routed to the user.
const CONTROL_QUESTIONS: string[] = [
    'Should the hooks use useSWR, tanstack-query, or vanilla useState/useEffect?',
    'Title max length — not defined anywhere in spec or mockups',
    'Minimum password length for auth — not answered yet',
    'Should the phone input show a placeholder like +37120000000 (E.164 example) or leave it blank?',
    'Should the Toolbar use text labels only (e.g., "Pencil", "Eraser", "Fill", "Picker") or include'
        + ' visual icons alongside or instead of text labels?',
    'Empty states: SVG icons vs text-only?',
    'What heading level should be used for "Hello World" (e.g., <h1>, <h2>, etc.)?',
    'Should the ban endpoint (POST /api/admin/users/:id/ban) return the updated user object in its'
        + ' response body, or just { ok: true }?',
    'Should migrate.ts support rollback/down migrations, or only forward-only apply?',
    'Should the search input trigger results immediately on typing (with debouncing, e.g., 300ms) or'
        + ' only on Enter key / explicit Search button click?',
    'What filename should the exported PNG use (e.g., "pixel-art.png" as stated in the goal, or'
        + ' something else like a document-name-based default)?',
    'Should the invite token be a UUID string from crypto.randomUUID(), or a base64url-encoded'
        + ' random buffer?'
]

if (CONTROL) {
    const newlyRouted = CONTROL_QUESTIONS.filter(
        q => !isIntegrationUnknown(q) && candidate(RUNTIME_TERMS, q)
    )
    console.log('=== STEP 5 control arm — 12 hand-labelled preference questions')
    console.log(`  newly routed to the user   ${newlyRouted.length}/12   (bound: ≤ 1)`)
    for (const q of newlyRouted) console.log(`    ${q.slice(0, 100)}`)
    const ok = newlyRouted.length <= 1
    console.log(ok ? '\nCONTROL PASS' : '\nCONTROL FAIL')
    process.exit(ok ? 0 : 1)
}

// ─── the A/B ─────────────────────────────────────────────────────────────────

const file = FIT ? 'unknown-routing-corpus-fit.json' : 'unknown-routing-corpus-holdout.json'
const fixture = path.join(FIXTURES, file)
if (!fs.existsSync(fixture)) {
    console.error(
        `FATAL: ${file} is missing. Run:\n`
            + '  bun run scripts/unknown-routing-coverage-baserate.ts --split'
    )
    process.exit(2)
}
const rows: Row[] = JSON.parse(fs.readFileSync(fixture, 'utf8'))
const wiring = rows.filter(r => r.is_wiring_truth)
const pref = rows.filter(r => !r.is_wiring_truth)

if (!FIT && wiring.length < 5) {
    console.log(`ABSTAIN — the holdout carries only ${wiring.length} wiring questions (< 5).`)
    console.log('Re-split 70/30 and re-run STEP 2.')
    process.exit(2)
}

// The named mx5 forms live in whichever half the hash put them in; bound 2 asks
// about them regardless, so they are read from the full corpus.
const all: Row[] = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'unknown-routing-corpus.json'), 'utf8')
)
const mx5 = all.filter(r => r.name !== null)

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`)

interface Round {
    label: string
    terms: string[]
    dropped: string | null
}

// The prescribed ladder: on an FP-bound failure, remove the widest term and
// re-run, at most three times. `routes?` and `hosts?` are the task's named
// culprits; `ports?` measured third-widest on the fit half.
const ROUNDS: Round[] = [
    {label: 'round 0 — full candidate list', terms: RUNTIME_TERMS, dropped: null},
    {label: 'round 1 — minus routes?', terms: RUNTIME_TERMS.slice(0, -1), dropped: 'routes?'},
    {label: 'round 2 — minus hosts?', terms: RUNTIME_TERMS.slice(0, -2), dropped: 'hosts?'},
    {label: 'round 3 — minus ports?', terms: RUNTIME_TERMS.slice(0, -3), dropped: 'ports?'}
]

console.log(`=== fixture   ${file}`)
console.log(`    ${rows.length} rows — ${wiring.length} wiring, ${pref.length} preference`)
console.log('')

let pass = false
for (const round of ROUNDS) {
    const hit = (q: string) => candidate(round.terms, q)
    const hitNoB = (q: string) => candidateNoB(round.terms, q)

    const recallN = wiring.filter(r => hit(r.question)).length
    const fpN = pref.filter(r => hit(r.question)).length
    const mx5N = mx5.filter(r => hit(r.question)).length
    const regressions = rows.filter(r => r.shipped && !hit(r.question))

    const recallNoB = wiring.filter(r => hitNoB(r.question)).length
    const fpNoB = pref.filter(r => hitNoB(r.question)).length

    const b1 = wiring.length > 0 && recallN / wiring.length >= 0.9
    const b2 = mx5N === mx5.length
    const b3 = pref.length === 0 || fpN / pref.length <= 0.1
    const b4 = regressions.length === 0

    console.log(`--- ${round.label}${round.dropped ? `  (dropped ${round.dropped})` : ''}`)
    console.log(
        `    A'&&B   recall ${recallN}/${wiring.length} ${pct(recallN, wiring.length)}`
            + `   fp ${fpN}/${pref.length} ${pct(fpN, pref.length)}`
            + `   mx5 ${mx5N}/${mx5.length}   un-caught ${regressions.length}`
    )
    console.log(
        `    A' only recall ${recallNoB}/${wiring.length} ${pct(recallNoB, wiring.length)}`
            + `   fp ${fpNoB}/${pref.length} ${pct(fpNoB, pref.length)}`
            + `   (diagnostic — drops Factor B, which nexttask 13 forbids)`
    )
    console.log(
        `    bounds  recall≥90% ${b1 ? 'PASS' : 'FAIL'} · both mx5 ${b2 ? 'PASS' : 'FAIL'}`
            + ` · fp≤10% ${b3 ? 'PASS' : 'FAIL'} · no un-catch ${b4 ? 'PASS' : 'FAIL'}`
    )
    if (b1 && b2 && b3 && b4) {
        pass = true
        break
    }
}

console.log('')
if (pass) {
    console.log('PASS')
    process.exit(0)
}

console.log('FAIL — REFUTED. Terms tried, in removal order:')
console.log(`  ${RUNTIME_TERMS.join(', ')}`)
console.log('  removed across the ladder: routes?, hosts?, ports?')
console.log('')
console.log('The recall bound, not the false-positive bound, is what fails. Factor B — which')
console.log('nexttask 13 forbids changing — matches 5 of 40 hand-labelled wiring questions, so')
console.log('a Factor-A-only edit is capped at 12.5% recall against a 90% bar, and both named')
console.log('mx5 forms are Factor B misses. Dropping Factor B does not rescue it either: freely')
console.log('tuned on the fit half the vocabulary tops out at 88% recall / 17% false positives.')
process.exit(1)
