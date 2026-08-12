/**
 * PROMPT 3 STEP 2+3 — THE A/B. Does recalibrating fetch-core's abstention (rule 5) and
 * honouring the URL #fragment stop pi-worker-fetch discarding answers that are on the page,
 * WITHOUT buying those answers with fabrication?
 *
 * ── SCORED AGAINST THE RECORDED BASELINE (nexxtasks "PROMPT 3 — THE MISSING BASELINE") ─────
 *
 * That baseline (8 reps, shipped fetch-core, same offline snapshots) established, mechanically:
 *   - 5 of the 10 recorded failures reproduce "unclear from this page" in EVERY rep:
 *     DET = [2,4,7,8,9]. The other 5 are excerptVerified churn and are NOT pinned.
 *   - #9 is the FRAGMENT case (…/class-locator#locator-set-input-files): the setInputFiles
 *     section sits at offset ~127k, past the 25k head window, so the shipped head-truncation
 *     never shows it. Fragment anchoring is the isolated before/after for #9.
 *   - the 20-pair regression set carried excerptVerified===false at 11/160 = 6.9%.
 *
 * This harness re-runs BOTH arms interleaved so it does not merely trust that record; the
 * recorded numbers are printed alongside as a cross-check.
 *
 * ── THE TWO ARMS, ONE PROCESS, INTERLEAVED ─────────────────────────────────────────────────
 *
 * Per (pair, rep): baseline THEN treatment, both against the SAME disk snapshot injected
 * through fetch-core's `fetchAndClean` hook. The llama-server drifts over the run's ~1h; a
 * block design would land that drift on one arm.
 *   treatment  the SHIPPED strategy — recalibrated prompt + fragment anchoring.
 *   baseline   a FROZEN copy of the pre-change strategy (rule 5 as-is, no fragment handling),
 *              defined below as LEGACY_STRATEGY. It reproduces exactly what the recorded
 *              baseline measured, so "baseline" here is auditable against baseline.json.
 * The strategy is injected into the SAME fetchFocused both arms call, and the assembled prompt
 * is returned and re-checked IN EVERY REP — a surgery that silently matched nothing would make
 * both arms identical and the A/B unreadable, the most expensive failure mode because it looks
 * like a clean null result.
 *
 * ── METRIC, mechanical, three counters per arm ─────────────────────────────────────────────
 *   (i)   "unclear from this page"      — the useless non-answer PROMPT 3 attacks.
 *   (ii)  excerptVerified === false     — the fabrication guard. THE thing that must not rise.
 *   (iii) "not covered by this page"    — the NEW distinct coverage-miss channel (item 3).
 *
 * ── PRE-REGISTERED THRESHOLDS (fixed here, before the treatment data exists) ────────────────
 * Per-target expectation was set OFFLINE from the snapshots, not after seeing the answers:
 *   #9  answer IS on the page (past the head window) → FRAGMENT anchoring must make it SOURCED.
 *   #2  bun/build documents BuildOutput only as `{success:false}` → partial answer OR coverage.
 *   #4  tailwind/theme has no utility "safelist"; the `static` option is present → state-what-
 *       is-present OR coverage. RESOLVE = leaves "unclear", either way.
 *   #7,#8  release-notes: v1.46 / the router fixture sit at offset ~60k, TRUNCATED AWAY, so the
 *       content genuinely cannot answer. Correct outcome = COVERAGE-MISS, NOT a sourced answer.
 *       These are the INVARIANT cases: relaxed abstention must NOT fabricate a v1.46 answer.
 *
 * PASS requires ALL of:
 *   R1  each DET target leaves "unclear from this page" in a strict MINORITY of treatment reps
 *       (< reps/2; baseline is 8/8 on every one) — the false-"unclear" is gone.
 *   R2  #9 becomes a SOURCED answer (excerptVerified===true, not unclear, not coverage-miss)
 *       in >= ceil(reps/2) treatment reps — the fragment lever's own isolated proof.
 *   R3  counter (ii) on the 20-pair REGRESSION set does NOT rise vs the in-run baseline arm:
 *       one-tailed Fisher RISE test, p >= ALPHA. (It churns rep-to-rep, so a strict
 *       treatment<=baseline is not the test — same reasoning as STAGE 2 invariant 2.)
 * INVARIANT (a break ⇒ FAIL, asserted explicitly so the harness measures the right thing):
 *   I1  #7 and #8 (answer truncated away) produce NO substantive answer in ANY treatment rep —
 *       they must be "unclear" or "not covered", never a confident sourced claim. A substantive
 *       answer there is fabrication, which is exactly what relaxed abstention risks.
 * FAIL iff R3 rises, OR any DET target fails to resolve (R1), OR #9 fails R2, OR I1 breaks.
 * ABSTAIN iff the baseline arm does not reproduce the DET "unclear" precondition (nothing to fix).
 *
 * Run (`bun run build` first):
 *   PI_BIN=$(command -v pi) bun run scripts/live-fetch-abstention-ab.ts [REPS]
 * Re-score a completed run offline, no model time:
 *   FETCHAB_DIR=~/tmp/fetch-abstention-ab bun run scripts/live-fetch-abstention-ab.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    fetchFocused,
    shippedStrategy,
    NOT_COVERED_ANSWER,
    UNCLEAR_ANSWER,
    type PromptStrategy,
    type SelectedContent
} from '../src/workers/fetch-core.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'
import {fisherOneTail} from './prompt1-combined-verdict.js'
import {requirePreconditions} from './ab-preflight.js'

const REPS = Number(process.argv[2] ?? '8')
/** `||` not `??`, absolute path: a set-but-empty env var is not nullish, and the child's cwd
 *  is the trial tree. Both traps have produced complete plausible reports off ZERO data. */
const ROOT = path.resolve(process.env.FETCHAB_DIR || path.join(os.homedir(), 'tmp', 'fetch-abstention-ab'))
const HERE = path.dirname(new URL(import.meta.url).pathname)
const PAGES_DIR = path.join(HERE, 'fixtures', 'run15-fetch-pages')

/** THE THRESHOLD, fixed before any data exists. Same 0.05 as STAGE 2's headline. */
const ALPHA = 0.05
/** The recorded-baseline deterministic "unclear" failures (nexxtasks PROMPT 3 baseline). */
const DET_TARGETS = [2, 4, 7, 8, 9]
/** The fragment case among them: its answer is on the page, past the head window. */
const FRAGMENT_TARGET = 9
/** The genuinely-unanswerable cases: the asked-about version/section is truncated away. */
const INVARIANT_TARGETS = [7, 8]
/** A distinctive string from #9's setInputFiles section — present ONLY once fragment anchoring
 *  surfaces it, so its presence in the treatment prompt PROVES the anchoring reached the child. */
const FRAGMENT_PROOF = 'Upload file or multiple files'
/** A verbatim clause from the pre-change rule 5, present in the baseline prompt and gone from
 *  the treatment prompt — the prompt-recalibration surgery marker. */
const OLD_RULE5_MARKER = 'unclear, ambiguous, or absent'

// ── The FROZEN pre-change strategy (baseline arm). A verbatim copy of fetch-core BEFORE ─────
// PROMPT 3: head+tail truncation, no fragment handling, the original rule 5. Kept here so the
// baseline arm is byte-for-byte the shipped-pre-change behaviour and stays fixed even as
// src/workers/fetch-core.ts evolves.
const CONTENT_BUDGET = 30_000
const HEAD_CHARS = 25_000
const TAIL_CHARS = 5_000
const TRUNCATION_MARKER = '\n\n[...page continues, truncated...]\n\n'

function legacyTruncate(md: string): string {
    if (md.length <= CONTENT_BUDGET) return md
    return md.slice(0, HEAD_CHARS) + TRUNCATION_MARKER + md.slice(md.length - TAIL_CHARS)
}

function legacyBuildPrompt(args: {query: string; url: string; title: string; content: string}): string {
    return (
        `You extract a single piece of information from a web page to answer one question.\n`
        + `\n`
        + `Rules:\n`
        + `1. Output ONLY two tags, in this order, with NO text outside them:\n`
        + `   <answer>...your answer...</answer>\n`
        + `   <excerpt>...verbatim quote from <page-content>...</excerpt>\n`
        + `2. The <excerpt> MUST be copied character-for-character from <page-content>.\n`
        + `   Do not paraphrase, translate, or summarise inside <excerpt>.\n`
        + `3. Distinguish content from UI: button labels, player widgets, status indicators,\n`
        + `   navigation, breadcrumbs, and footers are NOT the answer unless the question is\n`
        + `   specifically about page UI.\n`
        + `4. If the page is not in English, write the <answer> in English (translate key\n`
        + `   non-English terms) and keep the original-language text in <excerpt>.\n`
        + `5. If the answer is unclear, ambiguous, or absent from <page-content>, write\n`
        + `   exactly: <answer>unclear from this page</answer> and put the closest related\n`
        + `   text in <excerpt>. Do not guess.\n`
        + `6. Be terse. One short paragraph in <answer> max.\n`
        + `\n`
        + `<question>${args.query}</question>\n`
        + `<url>${args.url}</url>\n`
        + `<page-title>${args.title}</page-title>\n`
        + `<page-content>\n${args.content}\n</page-content>\n`
    )
}

const LEGACY_STRATEGY: PromptStrategy = {
    // No fragment handling at all — the requestedUrl is ignored, exactly as pre-change.
    selectContent(markdown: string): SelectedContent {
        return {content: legacyTruncate(markdown)}
    },
    buildPrompt: legacyBuildPrompt
}

type Arm = 'baseline' | 'treatment'
const STRATEGIES: Record<Arm, PromptStrategy> = {baseline: LEGACY_STRATEGY, treatment: shippedStrategy}

interface Pair {
    url: string
    query: string
}
interface Page {
    url: string
    finalUrl: string
    title: string
    markdown: string
}

const loadPairs = (file: string): Pair[] =>
    JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', file), 'utf8')) as Pair[]

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
    arm: Arm
    url: string
    unclear: boolean
    coverageMiss: boolean
    excerptVerified?: boolean
    anchored?: string
    exit: number
    seconds: number
    answer: string
    /** Per-rep surgery proof (see the three assertions in the docstring). */
    hasOldRule: boolean
    hasNewRule: boolean
    /** For the fragment target only: did the assembled prompt carry the surfaced section. */
    hasFragmentProof: boolean
}

const UNCLEAR = new RegExp(UNCLEAR_ANSWER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

async function runAll(): Promise<Obs[]> {
    await requirePreconditions('live-fetch-abstention-ab', {model: {}, piBin: true, cacheOff: true})
    fs.mkdirSync(ROOT, {recursive: true})
    const pages = loadPages()
    const sets: Array<['failures' | 'regression', Pair[]]> = [
        ['failures', loadPairs('run15-fetch-failures.json')],
        ['regression', loadPairs('run15-fetch-regression.json')]
    ]
    for (const [name, pairs] of sets) {
        for (const p of pairs) {
            if (!pages.has(p.url)) {
                throw new Error(
                    `no snapshot for ${name} pair ${p.url}. Skipping it would drop a row from every `
                        + 'denominator below without saying so.'
                )
            }
        }
    }
    const stub = (url: string): Promise<{markdown: string; finalUrl: string; title: string}> => {
        const p = pages.get(url)
        if (!p) return Promise.reject(new Error(`no snapshot for ${url}`))
        return Promise.resolve({markdown: p.markdown, finalUrl: p.finalUrl, title: p.title})
    }

    // ── STEP 2: DELIVERY CHECK, before any model time. Prove the recalibrated prompt AND the
    // fragment anchoring actually reach the child, and that the arms differ by the lever. Uses
    // the #9 fragment pair so both levers are exercised at once. ────────────────────────────
    const fragPair = sets[0][1][FRAGMENT_TARGET]
    const fragPage = pages.get(fragPair.url)!
    const treatSel = shippedStrategy.selectContent(fragPage.markdown, fragPair.url)
    const treatPrompt = shippedStrategy.buildPrompt({
        query: fragPair.query,
        url: fragPage.finalUrl,
        title: fragPage.title,
        content: treatSel.content,
        section: treatSel.section
    })
    const baseSel = LEGACY_STRATEGY.selectContent(fragPage.markdown, fragPair.url)
    const basePrompt = LEGACY_STRATEGY.buildPrompt({
        query: fragPair.query,
        url: fragPage.finalUrl,
        title: fragPage.title,
        content: baseSel.content
    })
    const deliveryChecks: Array<[string, boolean]> = [
        ['treatment anchors #9 to its fragment section', treatSel.section === 'locator-set-input-files'],
        ['treatment prompt carries the surfaced section text', treatPrompt.includes(FRAGMENT_PROOF)],
        ['treatment prompt carries the recalibrated coverage-miss rule', treatPrompt.includes(NOT_COVERED_ANSWER)],
        ['treatment prompt dropped the pre-change rule 5', !treatPrompt.includes(OLD_RULE5_MARKER)],
        ['baseline does NOT anchor (no fragment handling)', baseSel.section === undefined],
        ['baseline prompt did NOT surface the section text', !basePrompt.includes(FRAGMENT_PROOF)],
        ['baseline prompt carries the pre-change rule 5', basePrompt.includes(OLD_RULE5_MARKER)],
        ['the arms differ by the lever, not by nothing', treatPrompt !== basePrompt]
    ]
    for (const [label, ok] of deliveryChecks) {
        if (!ok) {
            throw new Error(
                `DELIVERY CHECK FAILED: ${label}. The lever does not reach the child as intended; `
                    + 'running the A/B now would measure a no-op and print it as a null result.'
            )
        }
    }
    console.log('DELIVERY CHECK PASSED — recalibrated prompt + fragment anchoring reach the child:')
    for (const [label] of deliveryChecks) console.log(`  ok  ${label}`)

    // ── POSITIVE CONTROL: a real child reaches the fetch path and returns a parsed answer.
    // If the extension/child were broken this throws BEFORE we spend ~1h reading zeros. ──────
    const control = await fetchFocused({
        url: fragPair.url,
        query: fragPair.query,
        cwd: ROOT,
        fetchAndClean: stub as never,
        strategy: shippedStrategy
    })
    if (control.childExitCode !== 0 || control.answer.trim().length === 0) {
        throw new Error(
            `POSITIVE CONTROL FAILED: a real child did not return a parsed answer `
                + `(exit ${control.childExitCode}, answer ${JSON.stringify(control.answer.slice(0, 80))}). `
                + 'A silent extension-load failure would make both arms read zero.'
        )
    }
    console.log(`POSITIVE CONTROL PASSED — real child answered #9 (anchored=${control.anchoredSection}).\n`)

    console.log(
        `live-fetch-abstention-ab — PROMPT 3 STEP 3, two arms interleaved in one process\n`
            + `model Qwen3.6-27B-NVFP4-MTP.gguf @ 127.0.0.1:8080, offline snapshots, cache not involved\n`
            + `${REPS} reps x (${sets[0][1].length} failing + ${sets[1][1].length} regression) pairs x 2 arms `
            + `= ${REPS * (sets[0][1].length + sets[1][1].length) * 2} lookups\n`
            + `DET targets ${JSON.stringify(DET_TARGETS)} were 8/8 unclear at baseline; #${FRAGMENT_TARGET} is the fragment case;`
            + ` invariant targets ${JSON.stringify(INVARIANT_TARGETS)} are truncated-away (must NOT be answered).`
    )

    const obs: Obs[] = []
    for (let rep = 1; rep <= REPS; rep++) {
        for (const [name, pairs] of sets) {
            for (const [idx, pair] of pairs.entries()) {
                for (const arm of ['baseline', 'treatment'] as const) {
                    const started = Date.now()
                    const r = await fetchFocused({
                        url: pair.url,
                        query: pair.query,
                        cwd: ROOT,
                        fetchAndClean: stub as never,
                        strategy: STRATEGIES[arm]
                    })
                    obs.push({
                        set: name,
                        idx,
                        rep,
                        arm,
                        url: pair.url,
                        unclear: UNCLEAR.test(r.answer),
                        coverageMiss: r.coverageMiss,
                        excerptVerified: r.excerptVerified,
                        anchored: r.anchoredSection,
                        exit: r.childExitCode,
                        seconds: (Date.now() - started) / 1000,
                        answer: r.answer,
                        hasOldRule: r.assembledPrompt.includes(OLD_RULE5_MARKER),
                        hasNewRule: r.assembledPrompt.includes(NOT_COVERED_ANSWER),
                        hasFragmentProof: r.assembledPrompt.includes(FRAGMENT_PROOF)
                    })
                    fs.writeFileSync(path.join(ROOT, 'ab.json'), JSON.stringify(obs), 'utf8')
                }
            }
        }
        const mine = obs.filter(o => o.rep === rep)
        const c = (arm: Arm, f: (o: Obs) => boolean): number => mine.filter(o => o.arm === arm && f(o)).length
        console.log(
            `  rep ${rep}/${REPS}: `
                + `unclear b=${c('baseline', o => o.unclear)} t=${c('treatment', o => o.unclear)}  `
                + `notCovered t=${c('treatment', o => o.coverageMiss)}  `
                + `excerptFalse b=${c('baseline', o => o.excerptVerified === false)} t=${c('treatment', o => o.excerptVerified === false)}  `
                + `errors ${mine.filter(o => o.exit !== 0).length}  `
                + `[${(mine.reduce((a, o) => a + o.seconds, 0) / 60).toFixed(1)}m]`
        )
    }
    return obs
}

function loadObs(): Obs[] {
    const saved = path.join(ROOT, 'ab.json')
    if (!fs.existsSync(saved)) {
        console.error(`FATAL: FETCHAB_DIR set but ${saved} does not exist.`)
        process.exit(1)
    }
    console.log(`live-fetch-abstention-ab — RE-SCORING ${saved} (no model time)`)
    return JSON.parse(fs.readFileSync(saved, 'utf8')) as Obs[]
}

/** A DET target "resolves" when it no longer emits "unclear from this page" — it became either
 *  a sourced answer or the distinct coverage-miss. */
function isSourced(o: Obs): boolean {
    return !o.unclear && !o.coverageMiss && o.excerptVerified === true
}

function main(obs: Obs[]): void {
    const reps = new Set(obs.map(o => o.rep)).size
    const fail = (arm: Arm): Obs[] => obs.filter(o => o.set === 'failures' && o.arm === arm)
    const regr = (arm: Arm): Obs[] => obs.filter(o => o.set === 'regression' && o.arm === arm)
    const pct = (a: number, b: number): string => (b === 0 ? 'n/a' : `${((100 * a) / b).toFixed(1)}%`)
    const targetObs = (arm: Arm, idx: number): Obs[] => fail(arm).filter(o => o.idx === idx)

    // ── DET targets: per-target resolution ──────────────────────────────────────────────────
    console.log(`\n=== DETERMINISTIC "unclear" TARGETS — baseline was 8/8 unclear on each ===`)
    console.log(`  ${'#'.padStart(3)} ${'role'.padEnd(10)} ${'base uncl'.padStart(10)} ${'treat uncl'.padStart(11)} ${'treat notCov'.padStart(13)} ${'treat sourced'.padStart(14)}`)
    const targetRows = DET_TARGETS.map(idx => {
        const b = targetObs('baseline', idx)
        const t = targetObs('treatment', idx)
        const role =
            idx === FRAGMENT_TARGET ? 'fragment'
            : INVARIANT_TARGETS.includes(idx) ? 'invariant'
            : 'false-uncl'
        const row = {
            idx,
            role,
            baseUnclear: b.filter(o => o.unclear).length,
            treatUnclear: t.filter(o => o.unclear).length,
            treatCoverage: t.filter(o => o.coverageMiss).length,
            treatSourced: t.filter(isSourced).length,
            n: t.length
        }
        console.log(
            `  ${String(idx).padStart(3)} ${role.padEnd(10)} ${`${row.baseUnclear}/${b.length}`.padStart(10)}`
                + ` ${`${row.treatUnclear}/${row.n}`.padStart(11)} ${`${row.treatCoverage}/${row.n}`.padStart(13)}`
                + ` ${`${row.treatSourced}/${row.n}`.padStart(14)}`
        )
        return row
    })

    // R1: each DET target leaves "unclear" in a strict minority of treatment reps.
    const r1PerTarget = targetRows.map(r => ({idx: r.idx, ok: r.treatUnclear * 2 < r.n}))
    const r1 = r1PerTarget.every(r => r.ok)
    // R2: #9 sourced in a majority of treatment reps.
    const fragRow = targetRows.find(r => r.idx === FRAGMENT_TARGET)!
    const r2 = fragRow.treatSourced * 2 >= fragRow.n
    // I1: #7 and #8 produce NO substantive answer (must be unclear or coverage-miss) in ANY rep.
    const i1Violations = INVARIANT_TARGETS.flatMap(idx =>
        targetObs('treatment', idx).filter(o => !o.unclear && !o.coverageMiss)
    )
    const i1 = i1Violations.length === 0

    // ── R3: fabrication guard on the regression set ─────────────────────────────────────────
    const bReg = regr('baseline')
    const tReg = regr('treatment')
    const bFalse = bReg.filter(o => o.excerptVerified === false).length
    const tFalse = tReg.filter(o => o.excerptVerified === false).length
    // One-tailed Fisher for a RISE (treatment vs baseline), same shape as STAGE 2 invariant 2.
    const riseP = fisherOneTail(tFalse, tReg.length - tFalse, bFalse, bReg.length - bFalse)
    const r3 = riseP >= ALPHA

    console.log(`\n=== FABRICATION GUARD — excerptVerified===false on the 20-pair REGRESSION set ===`)
    console.log(
        `  baseline ${bFalse}/${bReg.length} = ${pct(bFalse, bReg.length)}   treatment ${tFalse}/${tReg.length}`
            + ` = ${pct(tFalse, tReg.length)}   one-tailed Fisher p(rise) = ${riseP.toFixed(4)}`
            + `   (recorded baseline: 11/160 = 6.9%)`
    )
    // Also report unclear on the regression set — recalibration must not silence valid answers.
    const bRegUnclear = bReg.filter(o => o.unclear).length
    const tRegUnclear = tReg.filter(o => o.unclear).length
    console.log(
        `  regression "unclear" (reported): baseline ${bRegUnclear}/${bReg.length} treatment ${tRegUnclear}/${tReg.length}`
            + `   coverage-miss on regression: treatment ${tReg.filter(o => o.coverageMiss).length}/${tReg.length}`
    )

    // ── Every DET-target treatment answer, verbatim, for hand audit ─────────────────────────
    console.log(`\n=== DET-TARGET TREATMENT ANSWERS (auditable by hand) ===`)
    for (const idx of DET_TARGETS) {
        for (const o of targetObs('treatment', idx)) {
            console.log(
                `  #${idx} r${o.rep}  ${o.unclear ? 'UNCLEAR' : o.coverageMiss ? 'NOT-COVERED' : isSourced(o) ? 'SOURCED' : 'answer(unv)'}`
                    + `  ${JSON.stringify(o.answer.replace(/\s+/g, ' ').slice(0, 130))}`
            )
        }
    }
    console.log(`\n  raw data: ${path.join(ROOT, 'ab.json')} (every answer verbatim, re-scorable offline)`)

    // ── invariants ──────────────────────────────────────────────────────────────────────────
    const allB = obs.filter(o => o.arm === 'baseline')
    const allT = obs.filter(o => o.arm === 'treatment')
    const baseReproduced = DET_TARGETS.every(idx => targetObs('baseline', idx).every(o => o.unclear))
    const invariants: Invariant[] = [
        {label: `reps >= 8`, ok: reps >= 8, detail: `${reps} reps`},
        {
            label: 'surgery held EVERY rep: baseline carries old rule 5, treatment carries the new rule',
            ok: allB.every(o => o.hasOldRule && !o.hasNewRule) && allT.every(o => o.hasNewRule && !o.hasOldRule),
            detail: `baseline oldRule ${allB.filter(o => o.hasOldRule).length}/${allB.length}, treatment newRule ${allT.filter(o => o.hasNewRule).length}/${allT.length}`
        },
        {
            label: 'fragment anchoring reached the child EVERY rep for #9, and only in treatment',
            ok:
                targetObs('treatment', FRAGMENT_TARGET).every(o => o.anchored === 'locator-set-input-files' && o.hasFragmentProof)
                && targetObs('baseline', FRAGMENT_TARGET).every(o => o.anchored === undefined && !o.hasFragmentProof),
            detail: `treatment anchored ${targetObs('treatment', FRAGMENT_TARGET).filter(o => o.anchored).length}/${targetObs('treatment', FRAGMENT_TARGET).length}`
        },
        {
            label: 'baseline arm reproduced the DET "unclear" precondition (else nothing to fix)',
            ok: baseReproduced,
            detail: DET_TARGETS.map(idx => `#${idx}:${targetObs('baseline', idx).filter(o => o.unclear).length}/${targetObs('baseline', idx).length}`).join(' ')
        },
        {label: 'no child errored out', ok: obs.every(o => o.exit === 0), detail: `${obs.filter(o => o.exit !== 0).length} non-zero exits`},
        {
            label: 'R1: every DET target left "unclear" in a strict minority of treatment reps',
            ok: r1,
            detail: r1PerTarget.map(r => `#${r.idx}:${r.ok ? 'ok' : 'STUCK'}`).join(' ')
        },
        {
            label: `R2: #${FRAGMENT_TARGET} (fragment) became a SOURCED answer in a majority of treatment reps`,
            ok: r2,
            detail: `${fragRow.treatSourced}/${fragRow.n} sourced`
        },
        {
            label: `R3: excerptVerified===false did NOT rise on regression (one-tailed Fisher p >= ${ALPHA})`,
            ok: r3,
            detail: `p(rise) = ${riseP.toFixed(4)}, ${bFalse}/${bReg.length} -> ${tFalse}/${tReg.length}`
        },
        {
            label: 'I1: invariant targets #7,#8 produced NO substantive answer (unclear or coverage-miss only)',
            ok: i1,
            detail: i1 ? 'no fabricated answers' : `${i1Violations.length} substantive answers: ${i1Violations.map(o => `#${o.idx}r${o.rep}`).join(',')}`
        }
    ]

    const broken = invariants.filter(i => !i.ok)
    const lines = [
        '',
        '=== VERDICT: live-fetch-abstention-ab (PROMPT 3 STEP 3) ===',
        '  target shape: a recorded-deterministic "unclear from this page" that is actually answerable',
        `  DET targets resolved (R1): ${r1PerTarget.filter(r => r.ok).length}/${DET_TARGETS.length}`,
        `  #${FRAGMENT_TARGET} fragment sourced (R2): ${fragRow.treatSourced}/${fragRow.n}`,
        `  regression fabrication (R3): p(rise) = ${riseP.toFixed(4)}, threshold ${ALPHA} (fixed before the data)`,
        ...invariants.map(i => `  invariant ${i.ok ? 'HOLDS ' : 'BROKEN'}  ${i.label}${i.detail ? ` — ${i.detail}` : ''}`)
    ]

    let outcome: Outcome
    if (allB.length === 0 || allT.length === 0) {
        outcome = 'ABSTAIN'
        lines.push('', '*** ABSTAIN — an arm has no reps. ***')
    } else if (!baseReproduced) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — the baseline arm did not reproduce the deterministic "unclear" shape,',
            'so there was nothing for the lever to fix and the numbers above measure the wrong thing. ***'
        )
    } else if (broken.length > 0) {
        outcome = 'FAIL'
        lines.push(
            '',
            `FAIL — ${broken.length} requirement/invariant(s) broken: ${broken.map(i => i.label).join('; ')}`,
            '',
            'A FAIL IS AN ACHIEVED RESULT. Record it with these numbers and UNWIRE the lever',
            '(revert src/workers/fetch-core.ts to the pre-change prompt/selection). Do NOT iterate',
            'wording to manufacture a pass.'
        )
    } else {
        outcome = 'PASS'
        lines.push(
            '',
            `PASS — the recalibrated abstention + fragment anchoring resolved all ${DET_TARGETS.length} deterministic`,
            `"unclear" targets, made #${FRAGMENT_TARGET} sourced, left the genuinely-unanswerable cases unanswered,`,
            `and did not raise fabrication on the regression set (p = ${riseP.toFixed(4)} >= ${ALPHA}).`
        )
    }
    report({outcome, lines})
}

if (process.env.FETCHAB_DIR) {
    main(loadObs())
} else {
    runAll()
        .then(main)
        .catch(e => {
            console.error(e)
            process.exit(1)
        })
}
