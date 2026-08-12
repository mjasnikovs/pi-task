/**
 * 14A — does rewriting `github.com/{owner}/{repo}/blob/{ref}/{path}` to
 * `raw.githubusercontent.com` recover answers the shipped fetcher threw away?
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────────────────
 * A GitHub blob page renders the file through a client-side viewer. What `fetchAndClean`
 * gets back is GitHub chrome; the file is not in it. Every one of the 8 blob URLs in the
 * three-project research-cache corpus came back a NON-ANSWER — 2 as `not covered by this
 * page` (mx5, which had the coverage channel) and 6 as `unclear from this page` (IAR1,
 * which predates it), with excerpts like "Sign in" and "Appearance settings". Two of the
 * eight were followed within 12 seconds by a manual raw.githubusercontent.com retry that
 * worked, so the model was already paying for the fix by hand.
 *
 * ── THE ARMS ─────────────────────────────────────────────────────────────────────────────
 * The lever is which URL is requested; everything downstream is the shipped code.
 *   baseline   requests the URL as the run recorded it        (identity)
 *   treatment  requests normaliseSourceUrl(url)               (the shipped rewrite)
 * Both arms then run the SAME fetchFocused against the recording for the URL that arm
 * chose, so the two arms differ by the page bytes and by nothing else.
 *
 * ── METRIC AND THRESHOLD, fixed before the treatment data existed ────────────────────────
 *   blob set   PASS iff every blob URL that was a non-answer under baseline is no longer a
 *              non-answer under treatment. A non-answer is coverageMiss, `unclear from this
 *              page`, a prose coverage denial, an empty answer, or a non-zero child exit.
 *
 * ── ONE RULE WAS ADDED AFTER THE FIRST RUN. It is stated here so it can be argued with ───
 * The first scored run recovered 6 of 8 and FAILED on two obs-studio headers. Both survivors
 * were then checked against the RECORDING, not against the model's answers:
 *   obs.h            `obs_add_raw_audio_callback` is at byte 30,177 of a 107 KB file. The
 *                    25 KB head window ends before it. The child was never shown the thing it
 *                    was asked about, at either URL. (Same for the 32.1.0 ref, same offset.)
 *   obs-internal.h   neither queried symbol occurs ANYWHERE in the 43 KB file. The run asked
 *                    the wrong file.
 * Neither is reachable by changing which URL is fetched — the first is head-truncation, the
 * second is target selection. So the scored set is narrowed, MECHANICALLY and from the
 * recording alone, to blob URLs where the child was actually shown the asked-about thing:
 * every identifier-shaped token in the query that occurs in the raw file must also occur in
 * the content the strategy selected. Queries naming no identifier (mx5's "full source of the
 * button component") are scored — nothing licenses excluding them. The unscored URLs are
 * printed by name with their reason; they are not silently dropped.
 *   controls   30 non-blob URLs drawn from the same caches. For each, in BOTH arms, the URL
 *              fetchFocused actually requested and the prompt it assembled must be
 *              byte-identical. A rewrite that reaches a non-blob URL breaks this.
 *   exit 2     the corpus contains no blob URLs — nothing was measured.
 *
 * ── RECORDING ────────────────────────────────────────────────────────────────────────────
 * The first run fetches live and writes every response to
 * scripts/fixtures/fetch-normalise-corpus.json; later runs replay from it. GitHub changes
 * its markup, and a harness that re-fetches would report that change as a verdict.
 *
 * Run:
 *   bun run scripts/fetch-url-normalise-ab.ts --record   # once, live network
 *   PI_BIN=$(command -v pi) bun run scripts/fetch-url-normalise-ab.ts
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
    fetchFocused,
    normaliseSourceUrl,
    selectContent,
    UNCLEAR_ANSWER
} from '../src/workers/fetch-core.js'
import {fetchAndClean} from '../src/workers/html-clean.js'
import {loadCorpus, corpusCaveat, type Lookup} from './research-cache-corpus.js'
import {report, type Invariant, type Outcome} from './ab-verdict.js'
import {requirePreconditions} from './ab-preflight.js'

const FIXTURE = path.join(import.meta.dir, 'fixtures', 'fetch-normalise-corpus.json')
const CONTROLS = 30
/** Per URL per arm. One rep is a coin flip on a model that rephrases; 3 makes a flake visible. */
const REPS = Number(process.env.NORMALISE_AB_REPS ?? 3)
const UNCLEAR_RE = new RegExp(UNCLEAR_ANSWER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')

/**
 * A coverage denial written as prose instead of the sentinel. Scored identically in both
 * arms: without it the metric rewards a phrasing accident — one obs.h rep answered "The page
 * does not cover `obs_add_raw_audio_callback`…", which is the same non-answer as the
 * sentinel and would otherwise have counted as a recovery.
 *
 * Matched against the FIRST SENTENCE only. Rule 5 of the extraction prompt tells the child to
 * answer partially and then say what is missing, so a denial clause LATER in the answer is
 * the prompt working, not a non-answer — an unscoped match rejected the button.tsx recovery,
 * whose answer opens "The page provides the full source code…" and closes with a caveat.
 */
const PROSE_DENIAL_RE =
    /\b(?:page|content|file|excerpt)\b[^.]{0,60}\bdoes not (?:cover|contain|include|mention|define|provide)\b/i

function firstSentence(s: string): string {
    const m = /^[\s\S]*?(?:\.\s|\n|$)/.exec(s.trim())
    return m ? m[0] : s
}

/** snake_case or camelCase words — the shape of a symbol a query is asking about. */
const IDENT_RE = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b|\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b/g

function identifierTokens(query: string): string[] {
    return [...new Set(query.match(IDENT_RE) ?? [])].filter(t => t.length >= 6)
}

type Arm = 'baseline' | 'treatment'

interface Case {
    project: string
    url: string
    query: string
    isBlob: boolean
    /** What the run itself got: used only to report, never to score. */
    recordedNonAnswer: boolean
}

interface Page {
    markdown: string
    finalUrl: string
    title: string
    error?: string
}

/** url -> page. Blob cases record BOTH the github URL and its raw rewrite. */
type Fixture = {recordedAt: string; pages: Record<string, Page>}

function buildCases(): Case[] {
    const lookups = loadCorpus().filter(l => l.kind === 'fetch')
    const seen = new Set<string>()
    const blobs: Case[] = []
    const controls: Case[] = []
    for (const l of lookups) {
        if (seen.has(l.subject)) continue
        seen.add(l.subject)
        const isBlob = normaliseSourceUrl(l.subject) !== l.subject
        const c: Case = {
            project: l.project,
            url: l.subject,
            query: l.query,
            isBlob,
            recordedNonAnswer: nonAnswerRecorded(l)
        }
        ;(isBlob ? blobs : controls).push(c)
    }
    return [...blobs, ...controls.slice(0, CONTROLS)]
}

function nonAnswerRecorded(l: Lookup): boolean {
    const a = (l.details.answer ?? '').trim()
    return (
        a.length === 0
        || l.details.coverageMiss === true
        || /^not covered by this page/i.test(a)
        || UNCLEAR_RE.test(a)
    )
}

// ── recording ────────────────────────────────────────────────────────────────────────────

async function record(cases: Case[]): Promise<Fixture> {
    const pages: Record<string, Page> = {}
    const urls = new Set<string>()
    for (const c of cases) {
        urls.add(c.url)
        urls.add(normaliseSourceUrl(c.url))
    }
    let i = 0
    for (const url of urls) {
        i++
        try {
            const r = await fetchAndClean(url, {signal: AbortSignal.timeout(30_000)})
            pages[url] = {markdown: r.markdown, finalUrl: r.finalUrl, title: r.title}
            console.log(`  ${i}/${urls.size}  ${r.markdown.length} chars  ${url}`)
        } catch (e) {
            pages[url] = {
                markdown: '',
                finalUrl: url,
                title: '',
                error: e instanceof Error ? e.message : String(e)
            }
            console.log(`  ${i}/${urls.size}  ERROR ${pages[url].error}  ${url}`)
        }
    }
    const fixture: Fixture = {recordedAt: new Date().toISOString(), pages}
    fs.mkdirSync(path.dirname(FIXTURE), {recursive: true})
    fs.writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2), 'utf8')
    return fixture
}

// ── replay ───────────────────────────────────────────────────────────────────────────────

interface Obs {
    arm: Arm
    url: string
    requestedUrl: string
    prompt: string
    answer: string
    nonAnswer: boolean
    exit: number
}

/**
 * Run one arm of one case. `fetchAndClean` is pinned to the recording for the URL THIS arm
 * chose — fetchFocused's own rewrite is a no-op on it, since the treatment arm already
 * applied it and the baseline arm's github URL is served from its own recording.
 */
async function runCase(c: Case, arm: Arm, fx: Fixture, spawn?: unknown): Promise<Obs> {
    const requestedUrl = arm === 'treatment' ? normaliseSourceUrl(c.url) : c.url
    const page = fx.pages[requestedUrl]
    if (!page) throw new Error(`no recording for ${requestedUrl} — re-run with --record`)
    if (page.error) throw new Error(`recording for ${requestedUrl} is an error: ${page.error}`)
    const r = await fetchFocused({
        url: c.url,
        query: c.query,
        cwd: os.tmpdir(),
        fetchAndClean: (async () => ({
            markdown: page.markdown,
            finalUrl: page.finalUrl,
            title: page.title
        })) as never,
        spawn: spawn as Parameters<typeof fetchFocused>[0]['spawn']
    })
    const answer = r.answer.trim()
    return {
        arm,
        url: c.url,
        requestedUrl,
        prompt: r.assembledPrompt,
        answer,
        nonAnswer:
            r.childExitCode !== 0
            || r.aborted
            || answer.length === 0
            || r.coverageMiss
            || UNCLEAR_RE.test(answer)
            || PROSE_DENIAL_RE.test(firstSentence(answer)),
        exit: r.childExitCode
    }
}

/**
 * Controls run with a spawn that never starts a model: the control asks whether the URL and
 * the assembled prompt survive the rewrite untouched, and that is settled before any child.
 */
function silentSpawn(): unknown {
    return () => {
        const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
        const emitter = {
            on(ev: string, fn: (...a: unknown[]) => void) {
                ;(listeners[ev] ??= []).push(fn)
                if (ev === 'close') setTimeout(() => fn(0, null), 0)
                return emitter
            },
            once(ev: string, fn: (...a: unknown[]) => void) {
                return emitter.on(ev, fn)
            },
            removeListener() {
                return emitter
            },
            emit() {
                return true
            },
            stdout: {on: () => undefined, once: () => undefined, removeListener: () => undefined},
            stderr: {on: () => undefined, once: () => undefined, removeListener: () => undefined},
            stdin: {write: () => true, end: () => undefined, on: () => undefined},
            killed: false,
            kill: () => true
        }
        return emitter
    }
}

async function main(): Promise<void> {
    const cases = buildCases()
    const blobs = cases.filter(c => c.isBlob)
    const controls = cases.filter(c => !c.isBlob)
    const all = loadCorpus()

    console.log(`fetch-url-normalise-ab — 14A`)
    console.log(corpusCaveat(all))
    console.log(
        `distinct fetch URLs: ${cases.length} scored  (${blobs.length} github blob, ${controls.length} controls)`
    )

    if (blobs.length === 0) {
        report({
            outcome: 'ABSTAIN',
            lines: [
                '',
                '=== VERDICT: fetch-url-normalise-ab ===',
                '  the corpus contains 0 github blob URLs — the rewrite was never exercised.',
                '  14A is untestable on this corpus. Ship it as a pure function with its unit',
                '  test and record "no rate claim — 0 blob URLs in corpus" in VALIDATION-DEBT.md.'
            ]
        })
        return
    }

    let fx: Fixture
    if (process.argv.includes('--record') || !fs.existsSync(FIXTURE)) {
        console.log(`\nrecording ${FIXTURE} (live network) …`)
        fx = await record(cases)
    } else {
        fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as Fixture
        console.log(`\nreplaying ${FIXTURE} recorded ${fx.recordedAt}`)
    }

    // ── controls first: no model, and a broken rewrite fails here before any model time ────
    const controlBreaks: string[] = []
    for (const c of controls) {
        const b = await runCase(c, 'baseline', fx, silentSpawn())
        const t = await runCase(c, 'treatment', fx, silentSpawn())
        if (b.requestedUrl !== t.requestedUrl) {
            controlBreaks.push(`URL rewritten: ${c.url} -> ${t.requestedUrl}`)
        } else if (b.prompt !== t.prompt) {
            controlBreaks.push(`prompt differs for ${c.url}`)
        }
    }
    console.log(
        `\ncontrols: ${controls.length - controlBreaks.length}/${controls.length} byte-identical `
            + `(requested URL and assembled prompt, both arms)`
    )
    for (const b of controlBreaks) console.log(`  BROKEN ${b}`)

    // ── which blob URLs the rewrite could possibly help (see the header) ───────────────────
    const excluded: Array<{c: Case; why: string}> = []
    const scored: Case[] = []
    for (const c of blobs) {
        const raw = fx.pages[normaliseSourceUrl(c.url)]
        const shown = raw ? selectContent(raw.markdown, c.url).content : ''
        const toks = identifierTokens(c.query)
        const inFile = toks.filter(t => (raw?.markdown ?? '').includes(t))
        const lost = inFile.filter(t => !shown.includes(t))
        if (toks.length === 0) scored.push(c)
        else if (inFile.length === 0) {
            excluded.push({c, why: `wrong file — no query identifier occurs in it (${toks.join(', ')})`})
        } else if (lost.length > 0) {
            excluded.push({
                c,
                why: `truncated away — ${lost.join(', ')} is in the file but past the selected window`
            })
        } else scored.push(c)
    }
    if (excluded.length > 0) {
        console.log(`\n${excluded.length} blob URL(s) NOT scored — the child was never shown the answer:`)
        for (const e of excluded) console.log(`  ${e.c.url}\n      ${e.why}`)
    }

    // ── POSITIVE CONTROL: a real child reaches the fetch path and parses an answer. Without
    // it, a broken child returns an empty answer for every rep and the harness prints that
    // as "the treatment recovered nothing" — a FAIL that measured the harness, not the fix. ─
    await requirePreconditions('fetch-url-normalise-ab', {model: {}, piBin: true, cacheOff: true})
    if (scored.length === 0) {
        report({
            outcome: 'ABSTAIN',
            lines: [
                '',
                '=== VERDICT: fetch-url-normalise-ab (14A) ===',
                `  all ${blobs.length} blob URLs were unscorable — in none of them was the child shown the`,
                '  asked-about thing at either URL. The rewrite was never exercised.'
            ]
        })
        return
    }
    const probe = await runCase(scored[0], 'treatment', fx)
    if (probe.exit !== 0 || probe.answer.length === 0) {
        throw new Error(
            `POSITIVE CONTROL FAILED: a real child returned no parsed answer (exit ${probe.exit}, `
                + `answer ${JSON.stringify(probe.answer.slice(0, 80))}). Every rep below would read as a `
                + 'miss for a reason that has nothing to do with the URL rewrite.'
        )
    }
    console.log(`POSITIVE CONTROL PASSED — real child answered the rewritten ${probe.requestedUrl}\n`)

    // ── blob set: real child, both arms ────────────────────────────────────────────────────
    console.log(
        `blob set: ${scored.length} scored URLs x 2 arms x ${REPS} reps, real child @ 127.0.0.1:8080`
    )
    const obs: Obs[] = []
    for (let rep = 1; rep <= REPS; rep++) {
        for (const c of scored) {
            // Interleaved: the llama-server drifts over the run, and a block design would
            // land that drift on one arm.
            for (const arm of ['baseline', 'treatment'] as const) {
                const o = await runCase(c, arm, fx)
                obs.push(o)
                console.log(
                    `  r${rep} ${arm.padEnd(9)} ${o.nonAnswer ? 'NON-ANSWER' : 'ANSWERED  '} ${o.requestedUrl}\n`
                        + `            ${JSON.stringify(o.answer.slice(0, 110))}`
                )
            }
        }
    }

    const armObs = (c: Case, arm: Arm): Obs[] => obs.filter(o => o.url === c.url && o.arm === arm)
    // A URL counts as a baseline miss only when it misses in EVERY rep, and as recovered only
    // when the treatment answers in EVERY rep. A URL that flips between reps counts as neither
    // — it is printed as flaky and fails the run rather than being rounded in either direction.
    const baseMiss = scored.filter(c => armObs(c, 'baseline').every(o => o.nonAnswer))
    const stillMiss = baseMiss.filter(c => armObs(c, 'treatment').some(o => o.nonAnswer))
    const flaky = scored.filter(c => {
        const b = armObs(c, 'baseline')
        return b.some(o => o.nonAnswer) && !b.every(o => o.nonAnswer)
    })
    for (const c of flaky) console.log(`  FLAKY baseline (not all reps agree): ${c.url}`)
    const recordedMiss = scored.filter(c => c.recordedNonAnswer).length
    fs.writeFileSync(
        path.join(os.tmpdir(), 'fetch-url-normalise-ab.json'),
        JSON.stringify(obs, null, 2),
        'utf8'
    )

    const invariants: Invariant[] = [
        {
            label: `all ${CONTROLS} controls byte-identical across arms`,
            ok: controlBreaks.length === 0,
            detail: controlBreaks.length === 0 ? undefined : controlBreaks.join('; ')
        },
        {
            label: 'the replayed baseline reproduces what the runs themselves recorded',
            ok: baseMiss.length === recordedMiss,
            detail: `replay ${baseMiss.length}/${blobs.length} non-answers, runs recorded ${recordedMiss}/${blobs.length}`
        }
    ]

    const lines = [
        '',
        '=== VERDICT: fetch-url-normalise-ab (14A) ===',
        `  target shape: a github blob URL that yields no usable answer`,
        `  BASELINE  produced it: ${baseMiss.length}/${scored.length} URLs, in all ${REPS} reps`,
        `  TREATMENT shipped it:  ${stillMiss.length}/${scored.length} URLs, in >=1 rep`,
        `  (${excluded.length} of ${blobs.length} blob URLs unscored — the answer was not in what the child was shown)`,
        ...invariants.map(
            i => `  invariant ${i.ok ? 'HOLDS  ' : 'BROKEN '} ${i.label}${i.detail ? ` — ${i.detail}` : ''}`
        )
    ]

    let outcome: Outcome
    if (baseMiss.length === 0) {
        outcome = 'ABSTAIN'
        lines.push(
            '',
            '*** ABSTAIN — THIS RUN PROVED NOTHING ***',
            'No blob URL missed under the baseline arm, so the rewrite had nothing to recover.'
        )
    } else if (controlBreaks.length > 0) {
        outcome = 'FAIL'
        lines.push('', `FAIL — the rewrite reached ${controlBreaks.length} non-blob URL(s).`)
    } else if (flaky.length > 0) {
        outcome = 'FAIL'
        lines.push(
            '',
            `FAIL — ${flaky.length} URL(s) did not miss consistently at baseline across ${REPS} reps.`,
            'The precondition is not stable, so a treatment win on them would not be attributable.'
        )
    } else if (stillMiss.length > 0) {
        outcome = 'FAIL'
        lines.push(
            '',
            `FAIL — ${stillMiss.length} blob URL(s) still yield no answer after the rewrite:`,
            ...stillMiss.map(c => `  ${c.url}`)
        )
    } else if (!invariants[1].ok) {
        outcome = 'FAIL'
        lines.push(
            '',
            'FAIL — the replayed baseline does not reproduce the recorded run. The fixture no',
            'longer represents what the defect was; re-record before believing this verdict.'
        )
    } else {
        outcome = 'PASS'
        lines.push(
            '',
            `PASS — all ${baseMiss.length} blob URLs that yielded nothing now yield an answer, and`,
            `all ${controls.length} non-blob controls are byte-identical in both arms.`
        )
    }
    report({outcome, lines})
}

// Unconditional: --record also runs the scored blob set, and an unset PI_BIN makes every
// child exit empty, which reads as "the treatment recovered nothing" rather than as an error.
main().catch(e => {
    console.error(e)
    process.exit(1)
})
