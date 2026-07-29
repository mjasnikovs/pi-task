/**
 * WHY did obligation-ranking gain? The end-to-end score passes its pre-registered
 * condition on both pools, but a metric can be gamed by an accident: OBLIGATION_RE
 * contains bare `no`, `not`, `only`, `every`, `each`, `min`, `max`, and the mx5
 * spec's obligations include LINT RULE NAMES like `no-explicit-any` — where the
 * regex fires on a rule name, not on a modal. A key that works because the target
 * strings happen to contain its alternatives will not transfer to another spec.
 *
 * This prints, for every quote in both pools that carries a CRITICAL obligation:
 * whether the key fires, and WHICH alternative matched. It also shows what the
 * ranking DISPLACES, since zero critical losses says nothing about obligations
 * outside the hand-picked list of 16.
 *
 * No model calls.
 *
 * Run: bun run scripts/obligation-rank-diagnose.ts
 *        [--pools a.json,b.json] [--critical <json>]
 */
import {readFileSync} from 'node:fs'
import {isLowValueQuote} from '../src/task/requirements.js'

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const POOLS = arg('pools', '.measure/extraction-pool.json,.measure/extraction-pool-confirm.json')
    .split(',')
    .filter(p => p.length > 0)

/** The key's alternatives, split out so the MATCHED one can be named. Same source
 *  and same order as the single regex in extraction-precision-step0.ts. */
const ALTERNATIVES = [
    'must', 'shall', 'should', 'required?', 'requires', 'needs? to', 'has to', 'have to',
    'never', 'not', 'no', 'only', 'always', 'every', 'each', 'at least', 'at most',
    'max', 'min', 'cannot', "can'?t", "don'?t", 'do not', 'ensure', 'enforce',
    'validate', 'reject', 'forbid', 'prohibit'
]

/** Alternatives that are genuine OBLIGATION language — a quote matching only the
 *  others fired on a word that carries no modal force in isolation. */
const MODAL = new Set([
    'must', 'shall', 'should', 'required?', 'requires', 'needs? to', 'has to', 'have to',
    'never', 'cannot', "can'?t", "don'?t", 'do not', 'ensure', 'enforce', 'validate',
    'reject', 'forbid', 'prohibit'
])

const CRITICAL: string[] = (() => {
    const p = arg('critical', '')
    if (p.length > 0) return (JSON.parse(readFileSync(p, 'utf8')) as {critical: string[]}).critical
    return [
        'one strict `tsconfig.json`', 'printWidth 120', 'no-explicit-any', 'tsc --noEmit',
        'serve the built', 'a test lands', 'spec.tsx', 'photo upload limit',
        'Consume is atomic', 'Zod-validate every input', 'never ship phone',
        'Ownership/role checks server-side', 'rate-limit on login', 'Argon2id',
        'parameterized queries', 'banned'
    ]
})()

function matchedAlternatives(q: string): string[] {
    return ALTERNATIVES.filter(a => new RegExp(`\\b(?:${a})\\b`, 'i').test(q))
}

function main() {
    const byCritical = new Map<string, {fires: number; total: number; via: Set<string>; sample: string[]}>()
    for (const c of CRITICAL) byCritical.set(c, {fires: 0, total: 0, via: new Set(), sample: []})

    const distinct = new Set<string>()
    for (const p of POOLS) {
        const pool = JSON.parse(readFileSync(p, 'utf8')) as {runs: string[][]}
        for (const q of pool.runs.flat()) distinct.add(q)
    }

    for (const q of distinct) {
        for (const c of CRITICAL) {
            if (!q.toLowerCase().includes(c.toLowerCase())) continue
            const rec = byCritical.get(c)!
            rec.total++
            const hits = matchedAlternatives(q)
            if (hits.length > 0) {
                rec.fires++
                for (const h of hits) rec.via.add(h)
                if (rec.sample.length < 2) rec.sample.push(q.replace(/\s+/g, ' ').slice(0, 120))
            }
        }
    }

    console.log('\n=== per CRITICAL obligation: do its carriers fire, and on WHAT? ===')
    console.log('    (both pools pooled; "via" lists every alternative that matched some carrier)\n')
    let modalOnly = 0
    let accidentalOnly = 0
    for (const c of CRITICAL) {
        const r = byCritical.get(c)!
        const via = [...r.via]
        const hasModal = via.some(v => MODAL.has(v))
        const hasAccidental = via.some(v => !MODAL.has(v))
        const verdict =
            r.fires === 0 ? 'NEVER FIRES'
            : hasModal && !hasAccidental ? 'modal'
            : !hasModal && hasAccidental ? 'ACCIDENTAL ONLY'
            : 'mixed'
        if (verdict === 'modal') modalOnly++
        if (verdict === 'ACCIDENTAL ONLY') accidentalOnly++
        console.log(
            `  ${c.padEnd(36)} carriers ${String(r.fires).padStart(3)}/${String(r.total).padEnd(3)}`
                + `  ${verdict.padEnd(16)} via [${via.join(', ')}]`
        )
        for (const s of r.sample) console.log(`      · ${s}`)
    }
    console.log(`\n  modal-grounded ${modalOnly} / accidental-only ${accidentalOnly} / of ${CRITICAL.length}`)

    // What the ranking DISPLACES. Firing-vs-not is circular by construction, so the
    // question asked here is whether the demoted quotes are junk-shaped: if they
    // are, the displacement is buying real slots; if they are clean prose, the
    // ranking may be trading unlisted obligations for listed ones.
    const quiet = [...distinct].filter(q => matchedAlternatives(q).length === 0)
    const quietLowValue = quiet.filter(q => isLowValueQuote(q)).length
    console.log(
        `\n  quotes the key DEMOTES (no alternative matches): ${quiet.length}`
            + `  — of these ${quietLowValue} (${((100 * quietLowValue) / quiet.length).toFixed(0)}%) are already low-value-shaped`
    )
    console.log('  a sample of the CLEAN demoted ones (these are what the change risks losing):')
    for (const clean of quiet.filter(q => !isLowValueQuote(q)).slice(0, 15)) {
        console.log(`    · ${clean.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
    console.log('')
}

main()
