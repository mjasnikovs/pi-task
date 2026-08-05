/**
 * Offline re-scoring of an A/B-2 raw file, with the material for the hand-read.
 *
 * Two scorings of the SAME specs, applied identically to both arms:
 *
 *   CLAUSE-LEVEL (primary, what the harness reports)
 *       a spec requires a refuted dependency if any clause names it without a
 *       prohibition or negation-of-need cue.
 *
 *   SPEC-LEVEL (sensitivity check)
 *       …unless the spec ALSO prohibits that same token somewhere in its
 *       obligation span. Motivated by a real treatment spec that read
 *
 *         "the refined task leaves open whether `argon2` … should be used.
 *          This step does NOT add password hashing dependencies … Do not add
 *          `argon2` at this step."
 *
 *       — a neutral first clause inside a spec that prohibits the dependency
 *       outright. Reported ALONGSIDE the primary, never instead of it: a metric
 *       relaxed after seeing which arm it penalises is a metric fitted to the
 *       answer, and both numbers are printed so the difference is visible.
 *
 * THE HAND-READ (n=20/arm, compose→critique, 2026-08-05). All 10 hits read; the
 * clause-level headline is inflated in BOTH arms and must not be quoted alone:
 *
 *   clause-level    baseline 9/20   treatment 1/20   p=0.0084
 *   spec-level      baseline 3/20   treatment 0/20   p=0.2308
 *   hand-read       baseline 2/20   treatment 0/20   p=0.4872
 *
 * Genuine baseline defects — the spec actually tells the implementer to add the
 * refuted dependency:
 *   rep 1   "Add only the new … dependencies pinned in DESIGN/PROJECT.md (e.g.,
 *            `hono`, …, `argon2` or `@node-rs/argon2`, …)"
 *   rep 2   the same, plus an ACCEPTANCE list naming `argon2` and a VERIFY that
 *           throws when `p.dependencies['argon2']` is absent — the shipped shape
 *   rep 18  BORDERLINE, counted by the spec-level rule and NOT by hand: it says
 *           "preserve `argon2` IF it exists as an existing devDependency", which
 *           never adds anything.
 *
 * The other six baseline hits (6, 7, 8, 12, 13, 19) are scorer artifacts on
 * specs that PROHIBIT both tokens — an ACCEPTANCE line "No `argon2`, `bun-sql` …
 * are present" and VERIFY assertions like `if (p.dependencies?.argon2) throw`
 * carry no negation cue a clause splitter can see. The single treatment hit
 * (rep 3) is the same artifact.
 *
 * So: the direction is consistent — across 60 live treatment specs (20 here + 40
 * compose-only) not one genuinely requires a refuted dependency — but at a
 * baseline base rate of 2/20 the experiment is UNDER-POWERED, and the
 * pre-registered "baseline >= 8/20" bar is only met by the contaminated metric.
 * n≈60/arm would be needed for the clean rate. Recorded in VALIDATION-DEBT.md.
 *
 * Run: bun run scripts/refuted-constraint-rescore.ts [~/tmp/refuted-constraint-ab/ab-chain.jsonl]
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
    forbidsMandatedApi,
    obligationSpan,
    requiresUnneededDep,
    fisherExact
} from './refuted-constraint-delivered-ab.js'

const FILE =
    process.argv[2] ?? path.join(os.homedir(), 'tmp', 'refuted-constraint-ab', 'ab-chain.jsonl')

type Row = {rep: number; arm: string; valid: boolean; spec: string; draft?: string}

/** Does the spec explicitly prohibit this token anywhere in its obligations? */
function prohibitsToken(spec: string, token: string): boolean {
    const re = new RegExp(
        `(?:do\\s+not|don't|never|must\\s+not|avoid|no\\s+need\\s+to)\\s+[^.;\\n]{0,80}\`?${token}\`?`,
        'i'
    )
    return re.test(obligationSpan(spec))
}

function specLevelRequires(spec: string): string[] {
    return requiresUnneededDep(spec).filter(t => !prohibitsToken(spec, t))
}

function main(): void {
    if (!fs.existsSync(FILE)) {
        console.error(`no raw file at ${FILE}`)
        process.exit(2)
    }
    const rows: Row[] = fs
        .readFileSync(FILE, 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l) as Row)
        .filter(r => r.valid)

    console.log(`${FILE}\n${rows.length} valid specs\n`)
    const tally = (arm: string, scorer: (s: string) => string[]) => {
        const a = rows.filter(r => r.arm === arm)
        const hits = a.filter(r => scorer(r.spec).length > 0 || forbidsMandatedApi(r.spec).length > 0)
        return {n: a.length, h: hits.length, hits}
    }

    for (const [label, scorer] of [
        ['CLAUSE-LEVEL (primary)', requiresUnneededDep],
        ['SPEC-LEVEL  (sensitivity)', specLevelRequires]
    ] as const) {
        const b = tally('baseline', scorer)
        const t = tally('treatment', scorer)
        const p = fisherExact(b.h, b.n - b.h, t.h, t.n - t.h)
        console.log(`${label}   baseline ${b.h}/${b.n}   treatment ${t.h}/${t.n}   p=${p.toExponential(2)}`)
    }

    console.log(`\n─── every TREATMENT hit, for the hand-read ───`)
    for (const r of rows.filter(x => x.arm === 'treatment')) {
        const dep = requiresUnneededDep(r.spec)
        const api = forbidsMandatedApi(r.spec)
        if (dep.length === 0 && api.length === 0) continue
        console.log(`\n### rep ${r.rep}  dep=[${dep}] api=[${api}]  prohibited-elsewhere=${dep.filter(t => prohibitsToken(r.spec, t))}`)
        for (const line of obligationSpan(r.spec).split('\n')) {
            if (/argon2|bun-sql|Bun\.password|Bun\.sql/i.test(line)) console.log(`   ${line.trim()}`)
        }
    }

    console.log(`\n─── every BASELINE hit, for the hand-read ───`)
    for (const r of rows.filter(x => x.arm === 'baseline')) {
        const dep = requiresUnneededDep(r.spec)
        const api = forbidsMandatedApi(r.spec)
        if (dep.length === 0 && api.length === 0) continue
        console.log(`\n### rep ${r.rep}  dep=[${dep}] api=[${api}]  prohibited-elsewhere=${dep.filter(t => prohibitsToken(r.spec, t))}`)
        for (const line of obligationSpan(r.spec).split('\n')) {
            if (/argon2|bun-sql|Bun\.password|Bun\.sql/i.test(line)) console.log(`   ${line.trim()}`)
        }
    }
}

main()
