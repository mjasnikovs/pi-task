/**
 * Score a finished live docs run: were the docs answers sufficient to build with?
 *
 * Reads what the run itself wrote — never re-runs a lookup. A rescore that
 * re-retrieves is not a rescore; the same question has already shipped different
 * chunks on two machines, and the second measurement was mistaken for the first.
 *
 *   bun scripts/docs-live-audit.ts <run-root>
 *   bun scripts/docs-live-audit.ts <run-root> --check-truth   # verify the table only
 *
 * `bun run test` globs `scripts/`, so nothing here runs on import.
 */

import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {readTypeOnlyLog, type TypeOnlyLogRecord} from '../src/workers/typeonly-log.js'
import {PROJECTS, TRUTH, STALE, type ProjectSpec, type TruthEntry} from './docs-live-truth.js'

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_']{2,}/g
const CODE_SPAN_RE = /`([^`]+)`/g
const SENTENCE_SPLIT_RE = /(?<=[.;])\s+/
const DENIAL_RE = /\b(not|no|neither|nor|never|cannot|absent|missing|unconfirmed|contradicts)\b|n't/i

/**
 * Words the LANGUAGE provides, not the package. A literal or a stdlib global says
 * nothing about the package's API, so it cannot be a fabrication of one. Kept to
 * one union of the three ecosystems: a name here that a package also exports is
 * in that package's corpus anyway, so the union costs nothing.
 */
const LANGUAGE_WORDS = new Set([
    'true', 'false', 'null', 'undefined', 'void', 'await', 'async', 'return', 'const', 'let',
    'JSON', 'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Map', 'Set',
    'Math', 'console', 'RegExp', 'Symbol', 'BigInt', 'Error', 'TypeError',
    'Ok', 'Err', 'Some', 'None', 'Vec', 'Option', 'Result', 'bool', 'str', 'u16', 'u32', 'i32',
    'usize', 'pub', 'struct', 'impl', 'enum', 'trait', 'derive',
    'Just', 'Nothing', 'Maybe', 'Either', 'Left', 'Right', 'Int', 'Bool', 'True', 'False',
])

/** Node's own module namespace. `node:fs/promises` is a claim about Node, not about zod. */
const STDLIB_PATH_RE = /^node:/

/**
 * Members reached through a language global: the `stringify` of `JSON.stringify`.
 * The claim is about the language, and the package's corpus has no reason to carry it.
 */
function memberOfLanguageGlobal(span: string): Set<string> {
    const out = new Set<string>()
    for (const m of span.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|::)\s*([A-Za-z_][A-Za-z0-9_]*)/g))
        if (LANGUAGE_WORDS.has(m[1])) out.add(m[2])
    return out
}

/** `admin_email` and `adminEmail` are the same symbol under `#[serde(rename_all)]`. */
function caseFold(token: string): string {
    return token.replace(/[_-]/g, '').toLowerCase()
}

/**
 * A hyphenated identifier run, which `IDENTIFIER_RE` splits in two.
 *
 * The cargo facade fix files a supplement's chunks under the crate's PUBLISHED
 * name — `axum-core-0.5.6/src/…` — while Rust code writes `axum_core`, and
 * `eco-cargo.ts` treats the two as one crate. Without this the corpus offers
 * `axum` and `core`, never `axumcore`, and the scorer calls the code spelling an
 * invention.
 */
const HYPHENATED_RE = /[A-Za-z_$][\w$]*(?:-[A-Za-z_$][\w$]*)+/g

/**
 * Identifiers the answer ASSERTS as code that occur nowhere in what the tool
 * retrieved.
 *
 * Only backticked spans count. Scanning the prose measures English instead —
 * "Use", "calling" and "which" are absent from every corpus and none of them is
 * a fabricated API. A hallucinated symbol is one written as code, which is the
 * only form a reader would copy.
 *
 * A denying sentence asserts nothing, so its symbols are skipped. These runs ask
 * about symbols that do not exist, which makes "neither `eitherDecodeFile` nor a
 * `prettyShow` type appears" the best answer available — and it scored as three
 * fabrications. All 17 flags in the 2026-09-05 re-run were false, 16 of them this.
 *
 * Scoping to the sentence, rather than excusing every symbol the QUESTION supplied,
 * is deliberate: these questions name the fabrication, so trusting the query would
 * clear `Use ``decodeFile`` to read a file` as well, and that answer is the defect.
 */
/**
 * Retrieval recall, scored only where the run actually put the question.
 *
 * The gate is the SYMBOL, not the package. Re-run 3 reported `scotty:ActionM`
 * missed: it is indexed, a query naming it retrieves it, and no scotty query in
 * that run named it. Scoring it made the tool answer for a question nobody asked.
 *
 * An answer that carries the symbol still counts as a hit however the query was
 * phrased — the tool volunteering the right name is the behaviour this measures,
 * and gating that away would be the opposite error.
 *
 * Re-scored over all four recorded runs this moves exactly one cell, hs re-run 3
 * from 3/4 to 3/3, and leaves the other eleven untouched.
 */
export function scoreRecall(
    truth: readonly TruthEntry[],
    pins: Readonly<Record<string, string>>,
    byPkg: ReadonlyMap<string, readonly TypeOnlyLogRecord[]>
): {hit: number; of: number; missed: string[]} {
    const out = {hit: 0, of: 0, missed: [] as string[]}
    for (const t of truth) {
        if (!(t.pkg in pins)) continue
        const asked = byPkg.get(t.pkg) ?? []
        if (asked.length === 0) continue
        const hit = asked.some(r => (r.toolText ?? r.answer).includes(t.symbol))
        if (!hit && !asked.some(r => r.query.includes(t.symbol))) continue
        out.of++
        if (hit) out.hit++
        else out.missed.push(`${t.pkg}:${t.symbol}`)
    }
    return out
}

export function inventedSymbols(answer: string, corpus: string): string[] {
    const known = new Set(corpus.match(IDENTIFIER_RE) ?? [])
    const folded = new Set([...known].map(caseFold))
    for (const run of corpus.match(HYPHENATED_RE) ?? []) folded.add(caseFold(run))
    const out = new Set<string>()
    for (const sentence of answer.split(SENTENCE_SPLIT_RE)) {
        if (DENIAL_RE.test(sentence)) continue
        for (const span of sentence.matchAll(CODE_SPAN_RE)) {
            if (STDLIB_PATH_RE.test(span[1].trim())) continue
            const languageMembers = memberOfLanguageGlobal(span[1])
            // Both directions: the answer may write the hyphenated spelling where
            // the corpus holds the underscored one. `IDENTIFIER_RE` splits
            // `tokio-util` into two words the corpus knows separately as neither.
            const excused = new Set<string>()
            for (const run of span[1].match(HYPHENATED_RE) ?? []) {
                if (folded.has(caseFold(run))) for (const part of run.split('-')) excused.add(part)
            }
            for (const token of span[1].match(IDENTIFIER_RE) ?? []) {
                if (excused.has(token)) continue
                // IDENTIFIER_RE admits a trailing `'` so Haskell primes survive whole,
                // and it swallows the closing quote of a string literal too: `'POST'`
                // arrives as `POST'`. A prime over a stem the corpus knows is that.
                if (known.has(token)) continue
                if (token.endsWith("'") && known.has(token.slice(0, -1))) continue
                if (LANGUAGE_WORDS.has(token)) continue
                if (languageMembers.has(token)) continue
                // Covers two shapes at once: `let router = Router::new()`, a binding named
                // after its own real type, and `adminEmail` for `admin_email`.
                if (folded.has(caseFold(token))) continue
                out.add(token)
            }
        }
    }
    return [...out]
}

/** One docs call as the trail recorded it: which phase asked, and about what. */
interface TrailCall {
    phase: string
    module: string
}

const TRAIL_RE = /^\S+\s+(\S+):\s+pi-worker-(docs|search|fetch):\s+(\S+)/

function readTrail(root: string): {docs: TrailCall[]; web: TrailCall[]} {
    const dir = path.join(root, '.pi-tasks')
    const docs: TrailCall[] = []
    const web: TrailCall[] = []
    if (!fs.existsSync(dir)) return {docs, web}
    for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log')) continue
        const text = fs.readFileSync(path.join(dir, f), 'utf8')
        for (const line of text.split('\n')) {
            const m = TRAIL_RE.exec(line)
            if (!m) continue
            const call = {phase: m[1], module: m[3]}
            if (m[2] === 'docs') docs.push(call)
            else web.push(call)
        }
    }
    return {docs, web}
}

/** Source files the run produced, for the stale-API sweep. */
function sourceFiles(root: string): string[] {
    const out: string[] = []
    const skip = new Set([
        'node_modules',
        '.git',
        'target',
        'dist',
        'dist-newstyle',
        '.pi-tasks'
    ])
    const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
            if (skip.has(e.name)) continue
            const full = path.join(dir, e.name)
            if (e.isDirectory()) walk(full)
            else if (/\.(ts|tsx|js|mjs|rs|hs)$/.test(e.name)) out.push(full)
        }
    }
    walk(root)
    return out
}

/** The version each pin actually resolved to, read from the manifest the run left. */
function resolvedPins(root: string, spec: ProjectSpec): Record<string, string | null> {
    const out: Record<string, string | null> = {}
    for (const pkg of Object.keys(spec.pins)) out[pkg] = null
    if (spec.ecosystem === 'npm') {
        const pj = path.join(root, 'package.json')
        if (fs.existsSync(pj)) {
            const parsed = JSON.parse(fs.readFileSync(pj, 'utf8')) as {
                dependencies?: Record<string, string>
            }
            const deps = parsed.dependencies ?? {}
            for (const pkg of Object.keys(out)) out[pkg] = deps[pkg] ?? null
        }
    } else if (spec.ecosystem === 'cargo') {
        const lock = path.join(root, 'Cargo.lock')
        if (fs.existsSync(lock)) {
            const text = fs.readFileSync(lock, 'utf8')
            for (const pkg of Object.keys(out)) {
                const m = new RegExp(
                    `name = "${pkg}"\\s*\\nversion = "([^"]+)"`,
                    'm'
                ).exec(text)
                out[pkg] = m?.[1] ?? null
            }
        }
    } else {
        // Parsed, not pattern-matched. plan.json keys the version as a separate
        // `pkg-version` field, so a regex looking for `"<name>-<version>"` finds
        // nothing and reports every pin as missing — a false HARD FAIL, which is
        // worse than no check at all.
        const plan = path.join(root, 'dist-newstyle', 'cache', 'plan.json')
        if (fs.existsSync(plan)) {
            const parsed = JSON.parse(fs.readFileSync(plan, 'utf8')) as {
                'install-plan'?: Array<{'pkg-name'?: string; 'pkg-version'?: string}>
            }
            for (const e of parsed['install-plan'] ?? []) {
                const name = e['pkg-name']
                if (name && name in out) out[name] = e['pkg-version'] ?? null
            }
        }
    }
    return out
}

interface ProjectReport {
    id: string
    ecosystem: string
    ran: boolean
    docsCalls: number
    docsAnswers: number
    refusalsInResearch: number
    abstentions: number
    recall: {hit: number; of: number; missed: string[]}
    fidelity: {clean: number; of: number; invented: string[]}
    webAfterDocs: string[]
    pins: Record<string, {want: string; got: string | null; ok: boolean}>
    stale: {pkg: string; file: string; instead: string}[]
    build: {ok: boolean; output: string} | null
    verdict: 'PASS' | 'HARD FAIL' | 'NOT RUN'
    reasons: string[]
}

function auditProject(runRoot: string, spec: ProjectSpec, build: boolean): ProjectReport {
    const root = path.join(runRoot, spec.id)
    const jsonl = path.join(runRoot, `${spec.id}.jsonl`)
    const rep: ProjectReport = {
        id: spec.id,
        ecosystem: spec.ecosystem,
        ran: fs.existsSync(path.join(root, '.pi-tasks')),
        docsCalls: 0,
        docsAnswers: 0,
        refusalsInResearch: 0,
        abstentions: 0,
        recall: {hit: 0, of: 0, missed: []},
        fidelity: {clean: 0, of: 0, invented: []},
        webAfterDocs: [],
        pins: {},
        stale: [],
        build: null,
        verdict: 'NOT RUN',
        reasons: []
    }
    if (!fs.existsSync(root)) return rep

    const records: TypeOnlyLogRecord[] = fs.existsSync(jsonl)
        ? readTypeOnlyLog(fs.readFileSync(jsonl, 'utf8'))
        : []
    const trail = readTrail(root)
    rep.docsCalls = trail.docs.length
    rep.docsAnswers = records.length
    rep.abstentions = records.filter(r => r.unclear).length

    // A trail call with no answer record is a refusal or a crash. Sound only in
    // the research phases, where trail coverage of worker calls is proven — the
    // implementation turn runs in the host and does not write these lines.
    const researchCalls = trail.docs.filter(c => c.phase.startsWith('worker:')).length
    rep.refusalsInResearch = Math.max(0, researchCalls - records.length)

    // Recall and fidelity, per truth entry that this run actually asked about.
    const byPkg = new Map<string, TypeOnlyLogRecord[]>()
    for (const r of records) {
        const key = r.module.replace(/^@?([^/]+).*$/, '$1')
        byPkg.set(key, [...(byPkg.get(key) ?? []), r])
    }
    rep.recall = scoreRecall(TRUTH, spec.pins, byPkg)
    for (const r of records) {
        // The RETRIEVED chunks, never `toolText`. The tool return embeds the child's
        // own prose, so scoring the answer against it asks whether the answer contains
        // itself — and it always does: 13/13, 12/12, 10/10 across the pre-fix run and
        // 13/13, 4/4, 2/2 across the re-run, 54 answers with not one miss, while one of
        // them shipped `decodeFile`, which aeson 2 does not have. A record written
        // before `retrievedText` existed cannot be scored for this at all, and saying so
        // is the only honest thing to print.
        const corpus = r.retrievedText ?? ''
        if (corpus.length === 0) continue
        // An abstention makes no claim, so it can neither invent a symbol nor be
        // scored for not inventing one. Counting it clean inflates the rate with
        // answers that never risked anything.
        if (r.unclear) continue
        rep.fidelity.of++
        const inv = inventedSymbols(r.answer, corpus)
        if (inv.length === 0) rep.fidelity.clean++
        else rep.fidelity.invented.push(`${r.module}: ${inv.slice(0, 5).join(' ')}`)
    }

    // Soft signal: the model asked docs about a package, then went to the web.
    const askedDocs = new Set(trail.docs.map(c => c.module))
    for (const w of trail.web) if (askedDocs.has(w.module)) rep.webAfterDocs.push(w.module)

    // Pins.
    const got = resolvedPins(root, spec)
    for (const [pkg, want] of Object.entries(spec.pins)) {
        const g = got[pkg]
        rep.pins[pkg] = {want, got: g, ok: g !== null && g.replace(/^[^\d]*/, '') === want}
    }

    // Stale-major sweep.
    const files = sourceFiles(root)
    for (const marker of STALE) {
        if (!(marker.pkg in spec.pins)) continue
        for (const f of files) {
            if (marker.pattern.test(fs.readFileSync(f, 'utf8'))) {
                rep.stale.push({
                    pkg: marker.pkg,
                    file: path.relative(root, f),
                    instead: marker.instead
                })
            }
        }
    }

    // READ, never re-run. The toolchains live in the container the runs happened
    // in; a build here would be a different machine's answer. `docs-live-build.ts`
    // records the verdict next to the run, and this scores what it recorded — the
    // same discipline as the answer log.
    const buildFile = path.join(runRoot, `${spec.id}.build.json`)
    if (build && fs.existsSync(buildFile)) {
        const b = JSON.parse(fs.readFileSync(buildFile, 'utf8')) as {
            ok: boolean
            output: string
        }
        rep.build = {ok: b.ok, output: b.output.slice(-800)}
    }

    // Verdict.
    if (!rep.ran) {
        rep.verdict = 'NOT RUN'
        return rep
    }
    if (rep.build && !rep.build.ok) rep.reasons.push(`\`${spec.testCommand}\` failed`)
    for (const s of rep.stale) rep.reasons.push(`stale API in ${s.file}: ${s.instead}`)
    for (const [pkg, p] of Object.entries(rep.pins)) {
        if (!p.ok) rep.reasons.push(`pin moved: ${pkg} ${p.want} -> ${p.got ?? 'absent'}`)
    }
    rep.verdict = rep.reasons.length === 0 ? 'PASS' : 'HARD FAIL'
    return rep
}

function render(reps: ProjectReport[]): string {
    const L: string[] = ['# Live docs run — audit', '']
    for (const r of reps) {
        L.push(`## ${r.id} (${r.ecosystem}) — **${r.verdict}**`, '')
        if (!r.ran) {
            L.push('No `.pi-tasks/` — this project never ran.', '')
            continue
        }
        for (const why of r.reasons) L.push(`- ${why}`)
        if (r.reasons.length) L.push('')
        L.push('| | |', '|---|---|')
        L.push(`| docs calls (trail) | ${r.docsCalls} |`)
        L.push(`| docs answers (jsonl) | ${r.docsAnswers} |`)
        L.push(`| refusals, research phases | ${r.refusalsInResearch} |`)
        L.push(`| abstentions ("unclear") | ${r.abstentions} |`)
        L.push(`| retrieval recall | ${r.recall.hit}/${r.recall.of} |`)
        L.push(
            `| answers with 0 invented symbols | ${
                r.fidelity.of === 0 ?
                    'not scoreable — log has no `retrievedText`'
                :   `${r.fidelity.clean}/${r.fidelity.of}`
            } |`
        )
        L.push(`| web lookup after a docs call | ${r.webAfterDocs.length} |`)
        L.push(
            `| pins intact | ${Object.values(r.pins).filter(p => p.ok).length}/${Object.keys(r.pins).length} |`
        )
        if (r.build) L.push(`| build/test | ${r.build.ok ? 'green' : 'RED'} |`)
        L.push('')
        if (r.recall.missed.length) L.push(`Recall misses: ${r.recall.missed.join(', ')}`, '')
        if (r.fidelity.invented.length) {
            L.push('Invented symbols:', '')
            for (const i of r.fidelity.invented.slice(0, 10)) L.push(`- ${i}`)
            L.push('')
        }
        if (r.webAfterDocs.length) {
            L.push(`Went to the web after asking docs: ${[...new Set(r.webAfterDocs)].join(', ')}`, '')
        }
        if (r.build && !r.build.ok) {
            L.push('```', r.build.output.trim(), '```', '')
        }
    }
    return L.join('\n')
}

/**
 * Every truth symbol must exist in the package it names, or a recall miss is the
 * scorer's fault rather than the tool's. A loose scorer is as fatal as a strict one.
 */
function checkTruth(runRoot: string): void {
    for (const spec of PROJECTS) {
        for (const t of TRUTH) {
            if (!(t.pkg in spec.pins)) continue
            const root = path.join(runRoot, spec.id)
            let found: boolean
            try {
                execFileSync(
                    'grep',
                    ['-rqF', '--', t.symbol, root],
                    {stdio: 'ignore', timeout: 60_000}
                )
                found = true
            } catch {
                found = false
            }
            console.log(`${found ? 'ok  ' : 'MISS'} ${spec.id} ${t.pkg} :: ${t.symbol}`)
        }
    }
}

if (import.meta.main) {
    const runRoot = process.argv[2]
    if (!runRoot) {
        console.error('usage: bun scripts/docs-live-audit.ts <run-root> [--check-truth] [--build]')
        process.exit(1)
    }
    if (process.argv.includes('--check-truth')) {
        checkTruth(runRoot)
    } else {
        const build = process.argv.includes('--build')
        const reps = PROJECTS.map(s => auditProject(runRoot, s, build))
        const md = render(reps)
        console.log(md)
        fs.writeFileSync(path.join(runRoot, 'AUDIT.md'), `${md}\n`, 'utf8')
    }
}
