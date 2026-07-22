/**
 * PROMPT 3's MISSING BASELINE — the one nexxtasks flags as "ITS REQUIRED BASELINE WAS NEVER
 * RUN". This harness produces it and NOTHING ELSE: no lever, no src/ change, no A/B.
 *
 * ── WHY THE STATIC 10/30 IS NOT A BASELINE ────────────────────────────────────────────────
 *
 * PROMPT 3 rests on "4 of fetch's 10 failures threw away an answer that was on screen". Those
 * ten are ONE observation per (url, query) pair, taken from run 15's research cache. Two
 * independently measured facts say that is not a baseline:
 *   - `excerptVerified` flips on 43% of questions (90/210) between IDENTICAL reps, so the four
 *     unverified-excerpt cases in that ten may be noise wearing a finding's clothes;
 *   - `unclear` is by contrast near-deterministic (8/210 churn), so the false-"unclear" half of
 *     PROMPT 3 is the half a replay can actually pin down.
 * Which of the ten are STABLE failures is exactly what this run measures, and it is what any
 * future A/B has to be scored against.
 *
 * ── OFFLINE AND DETERMINISTIC BY CONSTRUCTION ─────────────────────────────────────────────
 *
 * The page content comes from scripts/fixtures/run15-fetch-pages/ — 14 URLs snapshotted as
 * CLEANED markdown, keyed by URL INCLUDING #fragment — and is injected through fetch-core's
 * own documented `fetchAndClean` hook. Nothing else about the tool is replaced: the prompt, the
 * 30k truncation, the child summariser and the excerpt verifier are the shipped ones, because
 * those four ARE what PROMPT 3 proposes to change. A live re-fetch would let page drift
 * masquerade as a lever effect later, which is the whole reason the snapshots exist.
 *
 * A missing snapshot is a HARD ERROR, not a skip: silently dropping a pair would shrink the
 * denominator of every rate below without saying so.
 *
 * ── WHAT IT REPORTS ───────────────────────────────────────────────────────────────────────
 *
 * Per arm-of-one, over N reps of both fixture sets:
 *   FAILURES  (10 pairs) how often each pair reproduces "unclear from this page" and how often
 *             its excerpt fails verification — per pair, so stability is visible per case and
 *             not just in aggregate. A pair that fires in 8/8 reps is a usable regression
 *             target; one that fires 3/8 is not, and must not be pinned as a fixture.
 *   REGRESSION (20 pairs) the currently-VALID results, which any future change must not break.
 *             This is the set PROMPT 3's PASS criterion protects.
 *   FRAGMENT  the F-3(d) case (a #fragment deep link) is called out by name, because the
 *             shipped path has no fragment handling at all and the snapshot key preserves it.
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/live-fetch-abstention-baseline.ts [REPS]
 * Re-score a completed run offline, no model time:
 *   FETCHBASE_DIR=~/tmp/fetch-abstention-baseline bun run scripts/live-fetch-abstention-baseline.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {fetchFocused} from '../src/workers/fetch-core.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'

const REPS = Number(process.argv[2] ?? '8')
const ROOT = path.resolve(
    process.env.FETCHBASE_DIR || path.join(os.homedir(), 'tmp', 'fetch-abstention-baseline')
)
const HERE = path.dirname(new URL(import.meta.url).pathname)
const PAGES_DIR = path.join(HERE, 'fixtures', 'run15-fetch-pages')

interface Pair {
    url: string
    query: string
    recorded: {unclear: boolean; hallucWarn: boolean; caveated: boolean}
}
interface Page {
    url: string
    finalUrl: string
    title: string
    markdown: string
}

const loadPairs = (file: string): Pair[] =>
    JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', file), 'utf8')) as Pair[]

/** Snapshots keyed by URL INCLUDING #fragment — the F-3(d) case depends on that. */
function loadPages(): Map<string, Page> {
    const out = new Map<string, Page>()
    for (const f of fs.readdirSync(PAGES_DIR).sort()) {
        if (!f.endsWith('.json')) continue
        const p = JSON.parse(fs.readFileSync(path.join(PAGES_DIR, f), 'utf8')) as Page
        out.set(p.url, p)
    }
    return out
}

interface Obs {
    set: 'failures' | 'regression'
    idx: number
    rep: number
    url: string
    query: string
    unclear: boolean
    excerptVerified?: boolean
    exit: number
    seconds: number
    answer: string
}

const UNCLEAR = /unclear from this page/i

async function runAll(): Promise<Obs[]> {
    try {
        await fetch('http://127.0.0.1:8080/health', {signal: AbortSignal.timeout(3000)})
    } catch {
        console.error('FATAL: llama-server @ 127.0.0.1:8080 not reachable. Start ~/hub/qwen/run-Q3.6-27B.sh.')
        process.exit(1)
    }
    fs.mkdirSync(ROOT, {recursive: true})
    const pages = loadPages()
    const sets: Array<['failures' | 'regression', Pair[]]> = [
        ['failures', loadPairs('run15-fetch-failures.json')],
        ['regression', loadPairs('run15-fetch-regression.json')]
    ]
    // Assert BEFORE spending model time: a missing snapshot must not silently shrink a rate.
    for (const [name, pairs] of sets) {
        for (const p of pairs) {
            if (!pages.has(p.url)) {
                throw new Error(
                    `no snapshot for ${name} pair ${p.url} — run scripts/snapshot-run15-fetch-pages.ts. `
                        + 'Skipping it would drop a row from every denominator below without saying so.'
                )
            }
        }
    }
    const stub = (url: string): Promise<{markdown: string; finalUrl: string; title: string}> => {
        const p = pages.get(url)
        if (!p) return Promise.reject(new Error(`no snapshot for ${url}`))
        return Promise.resolve({markdown: p.markdown, finalUrl: p.finalUrl, title: p.title})
    }

    console.log(
        `live-fetch-abstention-baseline — PROMPT 3's missing baseline, arm of ONE (shipped fetch-core)\n`
            + `model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, offline snapshots, cache not involved\n`
            + `${REPS} reps x (${sets[0][1].length} failing + ${sets[1][1].length} regression) pairs `
            + `= ${REPS * (sets[0][1].length + sets[1][1].length)} lookups`
    )

    const obs: Obs[] = []
    for (let rep = 1; rep <= REPS; rep++) {
        for (const [name, pairs] of sets) {
            for (const [idx, pair] of pairs.entries()) {
                const started = Date.now()
                const r = await fetchFocused({
                    url: pair.url,
                    query: pair.query,
                    cwd: ROOT,
                    fetchAndClean: stub as never
                })
                obs.push({
                    set: name,
                    idx,
                    rep,
                    url: pair.url,
                    query: pair.query,
                    unclear: UNCLEAR.test(r.answer),
                    excerptVerified: r.excerptVerified,
                    exit: r.childExitCode,
                    seconds: (Date.now() - started) / 1000,
                    answer: r.answer
                })
                fs.writeFileSync(path.join(ROOT, 'baseline.json'), JSON.stringify(obs), 'utf8')
            }
        }
        const mine = obs.filter(o => o.rep === rep)
        console.log(
            `  rep ${rep}/${REPS}: unclear ${mine.filter(o => o.unclear).length}/${mine.length}`
                + `  excerptVerified===false ${mine.filter(o => o.excerptVerified === false).length}`
                + `  errors ${mine.filter(o => o.exit !== 0).length}`
                + `  [${(mine.reduce((a, o) => a + o.seconds, 0) / 60).toFixed(1)}m]`
        )
    }
    return obs
}

function loadObs(): Obs[] {
    const saved = path.join(ROOT, 'baseline.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: FETCHBASE_DIR set but ${saved} does not exist.`)
        process.exit(1)
    }
    console.log(`live-fetch-abstention-baseline — RE-SCORING ${saved} (no model time)`)
    return JSON.parse(fs.readFileSync(saved, 'utf8')) as Obs[]
}

function main(obs: Obs[]): void {
    const reps = new Set(obs.map(o => o.rep)).size
    const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`)

    for (const set of ['failures', 'regression'] as const) {
        const rows = obs.filter(o => o.set === set)
        console.log(
            `\n=== ${set.toUpperCase()} SET — ${rows.length} observations over ${reps} reps ===\n`
                + `  unclear ${rows.filter(o => o.unclear).length}/${rows.length} = ${pct(rows.filter(o => o.unclear).length, rows.length)}`
                + `   excerptVerified===false ${rows.filter(o => o.excerptVerified === false).length}/${rows.length}`
                + ` = ${pct(rows.filter(o => o.excerptVerified === false).length, rows.length)}`
        )
        console.log(
            `  ${'#'.padStart(3)} ${'unclear'.padStart(8)} ${'unverif'.padStart(8)} ${'static'.padStart(14)}  url + query`
        )
        const byPair = new Map<number, Obs[]>()
        for (const r of rows) byPair.set(r.idx, [...(byPair.get(r.idx) ?? []), r])
        for (const [idx, rs] of [...byPair.entries()].sort((a, b) => a[0] - b[0])) {
            const u = rs.filter(r => r.unclear).length
            const v = rs.filter(r => r.excerptVerified === false).length
            // Stable = fires in every rep or in none; anything between is churn and must not
            // be pinned as a regression fixture.
            const stable = (n: number): string => (n === 0 || n === rs.length ? ' ' : '~')
            console.log(
                `  ${String(idx).padStart(3)} ${`${u}/${rs.length}${stable(u)}`.padStart(8)}`
                    + ` ${`${v}/${rs.length}${stable(v)}`.padStart(8)}`
                    + ` ${`${rs[0].url.includes('#') ? 'FRAGMENT ' : ''}`.padStart(14)}`
                    + `  ${rs[0].url.replace('https://', '')}`
            )
            console.log(`      q: ${rs[0].query.replace(/\s+/g, ' ').slice(0, 150)}`)
        }
    }

    // THE ONE THING THE STATIC RECORD CANNOT SAY: which recorded failures REPRODUCE.
    const failures = obs.filter(o => o.set === 'failures')
    const idxs = [...new Set(failures.map(o => o.idx))].sort((a, b) => a - b)
    const deterministic = idxs.filter(i => {
        const rs = failures.filter(o => o.idx === i)
        return rs.every(r => r.unclear) || rs.every(r => r.excerptVerified === false)
    })
    const never = idxs.filter(i => {
        const rs = failures.filter(o => o.idx === i)
        return rs.every(r => !r.unclear && r.excerptVerified !== false)
    })
    console.log(
        `\n=== WHICH OF THE 10 RECORDED FAILURES ARE REAL? ===\n`
            + `  reproduce in EVERY rep (usable as a pinned fixture)  ${deterministic.length}/${idxs.length}  [${deterministic.join(', ')}]\n`
            + `  never reproduce at all (the static record was noise) ${never.length}/${idxs.length}  [${never.join(', ')}]\n`
            + `  intermittent (must NOT be pinned as a regression target) `
            + `${idxs.length - deterministic.length - never.length}/${idxs.length}`
    )
    console.log(`\n  raw data: ${path.join(ROOT, 'baseline.json')} (every answer verbatim, re-scorable offline)`)

    const invariants: Invariant[] = [
        {
            label: 'reps >= 8 — the floor nexxtasks sets for any model-variable seam',
            ok: reps >= 8,
            detail: `${reps} reps`
        },
        {
            label: 'every pair was observed in every rep (no snapshot silently missing)',
            ok: [...new Set(obs.map(o => `${o.set}:${o.idx}`))].every(
                k => obs.filter(o => `${o.set}:${o.idx}` === k).length === reps
            ),
            detail: `${new Set(obs.map(o => `${o.set}:${o.idx}`)).size} distinct pairs`
        },
        {
            label: 'no child errored out',
            ok: obs.every(o => o.exit === 0),
            detail: `${obs.filter(o => o.exit !== 0).length} non-zero exits`
        }
    ]
    const broken = invariants.filter(i => !i.ok)
    const lines = [
        '',
        '=== RESULT: live-fetch-abstention-baseline (PROMPT 3 baseline, arm of one) ===',
        '  This is a BASELINE, not a lever test. There is no treatment arm and no PASS to win;',
        '  the deliverable is the recorded arm any future PROMPT 3 A/B is scored against.',
        ...invariants.map(i => `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`)
    ]
    let outcome: Outcome
    if (broken.length > 0) {
        outcome = 'ABSTAIN'
        lines.push('', `*** ABSTAIN — the baseline is not usable: ${broken.map(i => i.label).join('; ')} ***`)
    } else {
        outcome = 'PASS'
        lines.push('', 'RECORDED — the arm above is PROMPT 3’s baseline. Do not implement PROMPT 3 off the static 10/30.')
    }
    report({outcome, lines})
}

if (process.env.FETCHBASE_DIR) {
    main(loadObs())
} else {
    if (!process.env.PI_BIN || process.env.PI_BIN.trim().length === 0) {
        console.error('REFUSING TO RUN: PI_BIN is unset (an unset PI_BIN forks the harness into itself).')
        process.exit(1)
    }
    runAll()
        .then(main)
        .catch(e => {
            console.error(e)
            process.exit(1)
        })
}
