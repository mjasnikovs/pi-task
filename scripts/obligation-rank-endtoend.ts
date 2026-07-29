/**
 * TASK 1, end-to-end score of the OBLIGATION-RANKING candidate (nexttask "what to
 * try next"): promote OBLIGATION_RE from a measurement proxy to a ranking key
 * inside sectionFairFill's IN-BUCKET order, so section fairness is untouched but
 * obligating sentences are preferred WITHIN a section.
 *
 * PASS CONDITION (from nexttask, unchanged): critical obligations reaching the
 * shipped 40 must rise on BOTH pools with ZERO per-run losses, AND tail-section
 * coverage must not regress.
 *
 * No model calls — replays the two recorded 30-run pools.
 *
 * WHY A TRANSCRIPTION, AND WHY IT IS SAFE. The candidate changes the in-bucket
 * comparator inside sectionFairFill, which production does not expose, and the
 * candidate is NOT shipped — so putting an A/B seam in production for it would be
 * shipping unvalidated code to score it. Instead the cap is transcribed here with
 * the comparator as a parameter, and `--verify` PROVES the transcription: with the
 * comparator in its neutral setting it must return byte-identical output to the
 * real capRequirements on all 60 recorded runs. A drifted copy fails that check
 * before any number is printed. This is a stronger guarantee than "no copy
 * exists"; it is checked on every run of this script.
 *
 * TWO PRE-REGISTERED VARIANTS (`--variant full|modal`):
 *   full  — OBLIGATION_RE verbatim, the key nexttask named.
 *   modal — the same regex WITHOUT its bare non-modal alternatives (no, not,
 *           only, always, every, each, at least/most, max, min). Registered
 *           because the mx5 diagnosis (obligation-rank-diagnose.ts) showed 6 of
 *           16 critical obligations fired ONLY on those words — `no-explicit-any`
 *           matching `\bno\b` inside the lint rule's own NAME, `password_hash text
 *           not null` matching `not`. A key that works on lexical accidents of one
 *           spec's phrasing is not a key.
 *
 * Run: bun run scripts/obligation-rank-endtoend.ts [--variant full|modal]
 *        [--spec <path>] [--critical <json>] [--pools a.json,b.json]
 */
import {readFileSync} from 'node:fs'
import {
    capRequirements,
    enumerateObligationPassages,
    isLowValueQuote,
    type RequirementEntry
} from '../src/task/requirements.js'
import {normalise} from '../src/task/contracts.js'

function arg(name: string, fallback: string): string {
    const i = process.argv.indexOf(`--${name}`)
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const SPEC = readFileSync(arg('spec', '/home/edgars/hub/mx5/DESIGN/PROJECT.md'), 'utf8')
const POOLS = arg('pools', '.measure/extraction-pool.json,.measure/extraction-pool-confirm.json')
    .split(',')
    .filter(p => p.length > 0)
const VARIANT = arg('variant', 'full')

/** Mirrors MAX_REQUIREMENTS in src/task/requirements.ts (not exported). */
const CAP = 40

/** VERBATIM from extraction-precision-step0.ts — the candidate ranking key. */
const OBLIGATION_RE =
    /\b(?:must|shall|should|required?|requires|needs? to|has to|have to|never|not|no|only|always|every|each|at least|at most|max|min|cannot|can'?t|don'?t|do not|ensure|enforce|validate|reject|forbid|prohibit)\b/i
/** The same key with the bare non-modal alternatives struck out. */
const MODAL_ONLY_RE =
    /\b(?:must|shall|should|required?|requires|needs? to|has to|have to|never|cannot|can'?t|don'?t|do not|ensure|enforce|validate|reject|forbid|prohibit)\b/i
const KEY = VARIANT === 'modal' ? MODAL_ONLY_RE : OBLIGATION_RE

/** Default: VERBATIM from extraction-filter-endtoend.ts — the metric, unchanged,
 *  so the candidate is scored against exactly the number the shipped filter was.
 *  `--critical <json>` swaps in another spec's PRE-REGISTERED list. */
const CRITICAL: string[] = (() => {
    const p = arg('critical', '')
    if (p.length === 0) {
        return [
            'one strict `tsconfig.json`',
            'printWidth 120',
            'no-explicit-any',
            'tsc --noEmit',
            'serve the built',
            'a test lands',
            'spec.tsx',
            'photo upload limit',
            'Consume is atomic',
            'Zod-validate every input',
            'never ship phone',
            'Ownership/role checks server-side',
            'rate-limit on login',
            'Argon2id',
            'parameterized queries',
            'banned'
        ]
    }
    return (JSON.parse(readFileSync(p, 'utf8')) as {critical: string[]}).critical
})()

// ── transcription of the shipped cap, with the in-bucket comparator as a knob ──

function normalisedSections(doc: string): string[] {
    const out: string[] = []
    let current: string[] = []
    for (const line of doc.replace(/\r\n?/g, '\n').split('\n')) {
        if (/^#{1,6}\s+\S/.test(line)) {
            if (current.length > 0) out.push(normalise(current.join('\n')))
            current = [line]
            continue
        }
        current.push(line)
    }
    if (current.length > 0) out.push(normalise(current.join('\n')))
    return out.filter(s => s.length > 0)
}

function budgetedByObligation(
    entries: RequirementEntry[],
    budget: number,
    sourceDoc?: string
): RequirementEntry[] {
    const keep = entries.filter(e => !isLowValueQuote(e.quote))
    if (keep.length >= budget) return keep
    const at = (e: RequirementEntry): number => {
        if (!sourceDoc) return Number.MAX_SAFE_INTEGER
        const i = sourceDoc.indexOf(e.quote.trim())
        return i < 0 ? Number.MAX_SAFE_INTEGER : i
    }
    const restored = entries
        .filter(e => isLowValueQuote(e.quote))
        .map((e, given) => ({e, at: at(e), given}))
        .sort((x, y) => x.at - y.at || x.given - y.given)
        .slice(0, budget - keep.length)
        .map(x => x.e)
    return [...keep, ...restored]
}

function sectionFairFill(
    entries: RequirementEntry[],
    budget: number,
    sourceDoc: string | undefined,
    /** THE CANDIDATE. false ⇒ the shipped in-bucket order (position in section). */
    rankByObligation: boolean
): RequirementEntry[] {
    if (budget <= 0) return []
    if (!sourceDoc) return entries.slice(0, budget)
    const sections = normalisedSections(sourceDoc)
    const buckets = new Map<number, Array<{e: RequirementEntry; at: number}>>()
    entries.forEach((e, given) => {
        const q = normalise(e.quote)
        let b = sections.findIndex(s => s.includes(q))
        let at: number
        if (b < 0) {
            b = sections.length
            at = given
        } else {
            at = sections[b].indexOf(q)
        }
        const list = buckets.get(b) ?? []
        list.push({e, at})
        buckets.set(b, list)
    })
    const ordered = [...buckets.keys()].sort((a, b) => a - b)
    // The ONLY difference from production: obligation-bearing entries sort ahead
    // inside their own bucket, position in section staying the tie-break. Section
    // fairness (the round-robin below) is untouched by construction.
    const obligates = (e: RequirementEntry): number => (KEY.test(e.quote) ? 0 : 1)
    for (const k of ordered) {
        buckets
            .get(k)!
            .sort((a, b) =>
                rankByObligation ?
                    obligates(a.e) - obligates(b.e) || a.at - b.at
                :   a.at - b.at
            )
    }
    const out: RequirementEntry[] = []
    for (let round = 0; out.length < budget; round++) {
        let took = false
        for (const k of ordered) {
            const list = buckets.get(k)!
            if (round >= list.length) continue
            out.push(list[round].e)
            took = true
            if (out.length >= budget) break
        }
        if (!took) break
    }
    return out
}

function capWithRank(
    entries: RequirementEntry[],
    passages: string[],
    sourceDoc: string | undefined,
    rankByObligation: boolean
): RequirementEntry[] {
    if (entries.length <= CAP) return entries
    const norms = passages.map(normalise)
    const covers = (e: RequirementEntry): boolean => {
        const q = normalise(e.quote)
        return norms.some(p => p.includes(q))
    }
    const marked = entries.filter(covers)
    const rest = entries.filter(e => !covers(e))
    const budget = CAP - Math.min(marked.length, CAP)
    const pool = budgetedByObligation(rest, budget, sourceDoc)
    return [...marked.slice(0, CAP), ...sectionFairFill(pool, budget, sourceDoc, rankByObligation)]
}

// ── metrics (verbatim from extraction-filter-endtoend.ts) ────────────────────

function criticalHits(quotes: string[]): string[] {
    return CRITICAL.filter(n => quotes.some(q => q.toLowerCase().includes(n.toLowerCase())))
}

const SECTION_STARTS = (() => {
    const out: {name: string; at: number}[] = []
    for (const m of SPEC.matchAll(/^#{1,6}\s+(\S.*)$/gm)) out.push({name: m[1].trim(), at: m.index ?? 0})
    return out
})()
const TAIL_SECTIONS = SECTION_STARTS.slice(Math.ceil((SECTION_STARTS.length * 2) / 3))

function tailSectionsHit(quotes: string[]): number {
    const positions = quotes.map(q => SPEC.indexOf(q.trim())).filter(i => i >= 0)
    return TAIL_SECTIONS.filter((s, i) => {
        const end = i + 1 < TAIL_SECTIONS.length ? TAIL_SECTIONS[i + 1].at : SPEC.length
        return positions.some(p => p >= s.at && p < end)
    }).length
}

/** Two-sided exact sign test over the discordant runs. */
function signP(g: number, l: number): string {
    const m = g + l
    if (m === 0) return 'n/a (no discordant runs)'
    const c = (a: number, b: number): number => {
        let r = 1
        for (let k = 0; k < b; k++) r = (r * (a - k)) / (k + 1)
        return r
    }
    let tail = 0
    for (let k = 0; k <= Math.min(g, l); k++) tail += c(m, k)
    return `p=${Math.min(1, (2 * tail) / 2 ** m).toFixed(4)}`
}

function main() {
    const passages = enumerateObligationPassages(SPEC)
    const asEntries = (qs: string[]): RequirementEntry[] =>
        qs.map(q => ({quote: q, anchor: 'prose'}) as RequirementEntry)

    // ── TRANSCRIPTION PROOF, before any number is reported ──
    let checked = 0
    for (const path of POOLS) {
        const pool = JSON.parse(readFileSync(path, 'utf8')) as {runs: string[][]}
        for (let i = 0; i < pool.runs.length; i++) {
            const e = asEntries(pool.runs[i])
            const real = capRequirements(e, passages, SPEC).map(x => x.quote)
            const copy = capWithRank(e, passages, SPEC, false).map(x => x.quote)
            if (JSON.stringify(real) !== JSON.stringify(copy)) {
                console.error(
                    `TRANSCRIPTION DRIFT at ${path} run ${i + 1}: the neutral copy no longer`
                        + ` reproduces capRequirements. Fix the copy before reading any score.`
                )
                process.exitCode = 2
                return
            }
            checked++
        }
    }
    console.log(
        `transcription verified against production capRequirements on ${checked} runs`
            + `  |  variant=${VARIANT}, ${CRITICAL.length} critical obligations\n`
    )

    for (const path of POOLS) {
        const pool = JSON.parse(readFileSync(path, 'utf8')) as {runs: string[][]}
        const n = pool.runs.length
        // CAP ENGAGEMENT. Below 40 entries capRequirements returns the list
        // untouched, so a pool that rarely exceeds the cap cannot measure a
        // SELECTION rule at all — the honest verdict there is ABSTAIN, not "no
        // difference".
        const overCap = pool.runs.filter(r => r.length > CAP).length
        if (overCap < n / 2) {
            console.log(
                `=== ${path} — ABSTAIN: the cap engages in only ${overCap}/${n} runs, so most runs`
                    + ` ship every extracted quote and no selection rule can move anything.\n`
            )
            continue
        }
        let baseTotal = 0
        let rankTotal = 0
        let gain = 0
        let loss = 0
        let baseTail = 0
        let rankTail = 0
        let tailRegress = 0
        const detail: string[] = []

        for (let i = 0; i < n; i++) {
            const e = asEntries(pool.runs[i])
            const baseKept = capRequirements(e, passages, SPEC).map(x => x.quote)
            const rankKept = capWithRank(e, passages, SPEC, true).map(x => x.quote)
            const b = criticalHits(baseKept)
            const r = criticalHits(rankKept)
            baseTotal += b.length
            rankTotal += r.length
            const bt = tailSectionsHit(baseKept)
            const rt = tailSectionsHit(rankKept)
            baseTail += bt
            rankTail += rt
            if (rt < bt) tailRegress++
            if (r.length > b.length) gain++
            if (r.length < b.length) loss++
            const gained = r.filter(h => !b.includes(h))
            const lost = b.filter(h => !r.includes(h))
            if (gained.length > 0 || lost.length > 0 || rt !== bt) {
                detail.push(
                    `  run ${String(i + 1).padStart(2)}: yield ${String(pool.runs[i].length).padStart(3)}`
                        + ` | critical ${b.length} → ${r.length}`
                        + `${gained.length > 0 ? `  +[${gained.join(', ')}]` : ''}`
                        + `${lost.length > 0 ? `  LOST[${lost.join(', ')}]` : ''}`
                        + `${rt !== bt ? `  tail ${bt}→${rt}` : ''}`
                )
            }
        }

        console.log(`=== ${path} — ${n} runs ===`)
        for (const l of detail) console.log(l)
        console.log(`  critical obligations shipped (of ${CRITICAL.length}), mean per run:`)
        console.log(`    shipped rule        ${(baseTotal / n).toFixed(2)}`)
        console.log(
            `    + obligation rank   ${(rankTotal / n).toFixed(2)}  (${(rankTotal - baseTotal) / n >= 0 ? '+' : ''}${((rankTotal - baseTotal) / n).toFixed(2)})`
        )
        console.log(`  sign test  ${gain} better / ${loss} worse / ${n - gain - loss} tied   ${signP(gain, loss)}`)
        console.log(
            `  tail-section coverage (of ${TAIL_SECTIONS.length}):  ${(baseTail / n).toFixed(2)} → ${(rankTail / n).toFixed(2)}`
                + `   regressed in ${tailRegress}/${n} run(s)\n`
        )
    }
}

main()
